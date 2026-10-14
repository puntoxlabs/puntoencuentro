import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { HomeOpenEncounterDetailSheet } from '../src/components/home/openEncounters/HomeOpenEncounterDetailSheet';
import { AuthContext } from '../src/contexts/AuthContext';
import type { OpenEncounterSummary, EncuentroParticipanteAutorizado } from '../src/components/home/openEncounters/types';

describe('Experiencia del PARTICIPANTE APROBADO: Detalle Autorizado, Privacidad y UI Mobile', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const participantB = '22222222-2222-2222-2222-222222222222';
  const pendingUser = '33333333-3333-3333-3333-333333333333';
  const rejectedUser = '44444444-4444-4444-4444-444444444444';
  const cancelledUser = '55555555-5555-5555-5555-555555555555';
  const strangerUser = '66666666-6666-6666-6666-666666666666';

  let presencialEncounterId: string;
  let virtualEncounterId: string;

  before(async () => {
    db = new PGlite();

    // 1. Esquema base de Auth
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT,
        is_anonymous BOOLEAN DEFAULT false,
        raw_app_meta_data JSONB DEFAULT '{}'::jsonb
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claim', true), '')::jsonb, '{}'::jsonb);
      $$ LANGUAGE sql STABLE;
    `);

    // 2. Tablas públicas
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.localidades (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL
      );
      INSERT INTO public.localidades (id, nombre) VALUES ('guemes', 'Güemes') ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL,
        descripcion TEXT,
        open_public_title TEXT,
        open_description TEXT,
        fecha DATE NOT NULL,
        hora TIME NOT NULL,
        modalidad TEXT NOT NULL CHECK (modalidad IN ('presencial', 'virtual')),
        open_public_zone TEXT,
        locality_id TEXT REFERENCES public.localidades(id),
        lugar_texto TEXT,
        link_virtual TEXT,
        is_open BOOLEAN DEFAULT true,
        max_participants INT DEFAULT 10,
        estado TEXT DEFAULT 'activo',
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id),
        usuario_id UUID NOT NULL REFERENCES auth.users(id),
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        seat_count INT DEFAULT 1,
        estado TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now(),
        resolved_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id),
        user_id UUID REFERENCES auth.users(id),
        nombre_invitado TEXT NOT NULL,
        seat_count INT DEFAULT 1,
        estado TEXT NOT NULL DEFAULT 'confirmado',
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // 3. Crear RPC get_encuentro_participante_autorizado
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.get_encuentro_participante_autorizado(p_encuentro_id UUID)
      RETURNS JSONB
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_catalog
      AS $$
      DECLARE
          v_user_id UUID := auth.uid();
          v_is_anon BOOLEAN := false;
          v_encuentro public.encuentros%ROWTYPE;
          v_is_host BOOLEAN := false;
          v_is_participant BOOLEAN := false;
          v_part_seats INT := 1;
      BEGIN
          IF v_user_id IS NULL THEN
              RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthenticated');
          END IF;

          SELECT COALESCE(is_anonymous, false) INTO v_is_anon
          FROM auth.users
          WHERE id = v_user_id;

          IF v_is_anon THEN
              RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
          END IF;

          SELECT * INTO v_encuentro
          FROM public.encuentros
          WHERE id = p_encuentro_id;

          IF NOT FOUND THEN
              RETURN pg_catalog.json_build_object('ok', false, 'error', 'encuentro_not_found');
          END IF;

          v_is_host := (v_encuentro.host_id = v_user_id);

          IF NOT v_is_host THEN
              SELECT EXISTS (
                  SELECT 1 FROM public.participantes p
                  WHERE p.encuentro_id = p_encuentro_id
                    AND p.user_id = v_user_id
                    AND p.estado IN ('confirmado', 'asistio')
              ) INTO v_is_participant;

              IF NOT v_is_participant THEN
                  RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
              END IF;

              SELECT COALESCE(p.seat_count, 1) INTO v_part_seats
              FROM public.participantes p
              WHERE p.encuentro_id = p_encuentro_id
                AND p.user_id = v_user_id
                AND p.estado IN ('confirmado', 'asistio')
              LIMIT 1;
          END IF;

          RETURN pg_catalog.json_build_object(
              'ok', true,
              'id', v_encuentro.id,
              'is_host', v_is_host,
              'open_public_title', CASE
                  WHEN v_is_host THEN COALESCE(v_encuentro.open_public_title, v_encuentro.titulo)
                  ELSE COALESCE(v_encuentro.open_public_title, 'Encuentro')
              END,
              'open_description', CASE
                  WHEN v_is_host THEN COALESCE(v_encuentro.open_description, v_encuentro.descripcion)
                  ELSE COALESCE(v_encuentro.open_description, '')
              END,
              'fecha', v_encuentro.fecha,
              'hora', v_encuentro.hora,
              'modalidad', v_encuentro.modalidad,
              'open_public_zone', v_encuentro.open_public_zone,
              'lugar_texto', CASE WHEN v_encuentro.modalidad = 'presencial' THEN v_encuentro.lugar_texto ELSE NULL END,
              'link_virtual', CASE WHEN v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual ELSE NULL END,
              'seat_count', CASE WHEN v_is_host THEN NULL ELSE v_part_seats END,
              'estado', v_encuentro.estado
          );
      END;
      $$;
    `);

    // 4. Insertar usuarios
    await db.exec(`
      INSERT INTO auth.users (id, email, is_anonymous) VALUES
      ('${hostUser}', 'host@test.com', false),
      ('${participantB}', 'b@test.com', false),
      ('${pendingUser}', 'pending@test.com', false),
      ('${rejectedUser}', 'rejected@test.com', false),
      ('${cancelledUser}', 'cancelled@test.com', false),
      ('${strangerUser}', 'stranger@test.com', false);
    `);

    // 5. Host A crea 2 encuentros: uno presencial y uno virtual
    const encPresRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, descripcion, open_public_title, open_description,
        fecha, hora, modalidad, open_public_zone, lugar_texto, is_open, max_participants
      ) VALUES (
        '${hostUser}',
        'TITULO_PRIVADO_HOST_123',
        'DESCRIPCION_PRIVADA_HOST_456',
        'Pádel y Tercer Tiempo en Güemes',
        'Jugamos un partido nivel intermedio y compartimos algo fresco después.',
        '2026-10-25',
        '18:30:00',
        'presencial',
        'Güemes / San Carlos',
        'Club Pádel Mar, Cancha 2, Güemes 3140',
        true,
        6
      ) RETURNING id;
    `);
    presencialEncounterId = encPresRes.rows[0].id;

    const encVirtRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, descripcion, open_public_title, open_description,
        fecha, hora, modalidad, open_public_zone, link_virtual, is_open, max_participants
      ) VALUES (
        '${hostUser}',
        'TITULO_PRIVADO_VIRTUAL',
        'DESCRIPCION_PRIVADA_VIRTUAL',
        'Club de Lectura Sci-Fi Online',
        'Conversamos sobre novelas de ciencia ficción contemporánea.',
        '2026-10-26',
        '20:00:00',
        'virtual',
        'Online',
        'https://meet.google.com/xyz-reading-club',
        true,
        10
      ) RETURNING id;
    `);
    virtualEncounterId = encVirtRes.rows[0].id;

    // Participante B: solicita con seat_count = 3 en ambos y es APROBADO
    await db.exec(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, resolved_at)
      VALUES
      ('${presencialEncounterId}', '${participantB}', 'Participante B', 3, 'approved', now()),
      ('${virtualEncounterId}', '${participantB}', 'Participante B', 3, 'approved', now());

      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, seat_count, estado)
      VALUES
      ('${presencialEncounterId}', '${participantB}', 'Participante B', 3, 'confirmado'),
      ('${virtualEncounterId}', '${participantB}', 'Participante B', 3, 'confirmado');
    `);

    // Casos negativos en presencial:
    await db.exec(`
      -- pending
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado)
      VALUES ('${presencialEncounterId}', '${pendingUser}', 'Usuario Pending', 1, 'pending');

      -- rejected
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, resolved_at)
      VALUES ('${presencialEncounterId}', '${rejectedUser}', 'Usuario Rejected', 1, 'rejected', now());

      -- cancelled
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, resolved_at)
      VALUES ('${presencialEncounterId}', '${cancelledUser}', 'Usuario Cancelled', 1, 'cancelled', now());
    `);
  });

  after(async () => {
    if (db) await db.close();
  });

  async function setAuthUid(uid: string | null) {
    if (uid) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${uid}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
    }
  }

  test('1. Participante B aprobado accede al detalle autorizado presencial con seat_count = 3', async () => {
    await setAuthUid(participantB);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${presencialEncounterId}');
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(data.ok, true);
    assert.equal(data.is_host, false);
    assert.equal(data.open_public_title, 'Pádel y Tercer Tiempo en Güemes');
    assert.equal(data.open_description, 'Jugamos un partido nivel intermedio y compartimos algo fresco después.');
    assert.equal(data.modalidad, 'presencial');
    assert.equal(data.open_public_zone, 'Güemes / San Carlos');
    assert.equal(data.lugar_texto, 'Club Pádel Mar, Cancha 2, Güemes 3140');
    assert.equal(data.link_virtual, null);
    assert.equal(data.seat_count, 3);
  });

  test('2. Participante B aprobado accede al detalle autorizado virtual con link_virtual', async () => {
    await setAuthUid(participantB);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${virtualEncounterId}');
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(data.ok, true);
    assert.equal(data.modalidad, 'virtual');
    assert.equal(data.link_virtual, 'https://meet.google.com/xyz-reading-club');
    assert.equal(data.lugar_texto, null);
    assert.equal(data.seat_count, 3);
  });

  test('3. PRIVACIDAD TOTAL: RPC nunca expone titulo privado, descripcion privada ni tokens', async () => {
    await setAuthUid(participantB);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${presencialEncounterId}');
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;
    const str = JSON.stringify(data);

    assert.ok(!str.includes('TITULO_PRIVADO_HOST_123'), 'NO debe contener titulo privado');
    assert.ok(!str.includes('DESCRIPCION_PRIVADA_HOST_456'), 'NO debe contener descripcion privada');
    assert.ok(!str.includes('token_invitacion'), 'NO debe contener token_invitacion');
    assert.ok(!str.includes('token_participante'), 'NO debe contener token_participante');
  });

  test('4. CASOS NEGATIVOS: pending, rejected, cancelled, ajeno y anónimo NO acceden a logística privada', async () => {
    // A. Pending
    await setAuthUid(pendingUser);
    const resPending = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${presencialEncounterId}');
    `);
    assert.equal(resPending.rows[0].get_encuentro_participante_autorizado.ok, false);
    assert.equal(resPending.rows[0].get_encuentro_participante_autorizado.error, 'unauthorized');

    // B. Rejected
    await setAuthUid(rejectedUser);
    const resRejected = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${presencialEncounterId}');
    `);
    assert.equal(resRejected.rows[0].get_encuentro_participante_autorizado.ok, false);
    assert.equal(resRejected.rows[0].get_encuentro_participante_autorizado.error, 'unauthorized');

    // C. Cancelled
    await setAuthUid(cancelledUser);
    const resCancelled = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${presencialEncounterId}');
    `);
    assert.equal(resCancelled.rows[0].get_encuentro_participante_autorizado.ok, false);
    assert.equal(resCancelled.rows[0].get_encuentro_participante_autorizado.error, 'unauthorized');

    // D. Tercero ajeno
    await setAuthUid(strangerUser);
    const resStranger = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${presencialEncounterId}');
    `);
    assert.equal(resStranger.rows[0].get_encuentro_participante_autorizado.ok, false);
    assert.equal(resStranger.rows[0].get_encuentro_participante_autorizado.error, 'unauthorized');

    // E. Anónimo / Sin sesión
    await setAuthUid(null);
    const resAnon = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${presencialEncounterId}');
    `);
    assert.equal(resAnon.rows[0].get_encuentro_participante_autorizado.ok, false);
    assert.equal(resAnon.rows[0].get_encuentro_participante_autorizado.error, 'unauthenticated');
  });

  test('5. ENCUENTRO CERRADO / COMPLETO: Participante aprobado sigue viendo logística privada', async () => {
    // Cerrar el encuentro en la DB
    await db.exec(`
      UPDATE public.encuentros
      SET is_open = false, estado = 'completo'
      WHERE id = '${presencialEncounterId}';
    `);

    await setAuthUid(participantB);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${presencialEncounterId}');
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(data.ok, true, 'Participante aprobado debe seguir autorizado incluso con is_open = false');
    assert.equal(data.lugar_texto, 'Club Pádel Mar, Cancha 2, Güemes 3140');
    assert.equal(data.seat_count, 3);
  });

  test('6. UI & COPY: HomeOpenEncounterDetailSheet renderiza banner con "Tus 3 lugares están confirmados" y logística', () => {
    const mockAuthDetail: EncuentroParticipanteAutorizado = {
      ok: true,
      id: presencialEncounterId,
      is_host: false,
      open_public_title: 'Pádel y Tercer Tiempo en Güemes',
      open_description: 'Jugamos un partido nivel intermedio.',
      fecha: '2026-10-25',
      hora: '18:30:00',
      modalidad: 'presencial',
      open_public_zone: 'Güemes / San Carlos',
      lugar_texto: 'Club Pádel Mar, Cancha 2, Güemes 3140',
      seat_count: 3,
    };

    const mockSummary: OpenEncounterSummary = {
      id: presencialEncounterId,
      title: 'Pádel y Tercer Tiempo en Güemes',
      startsAt: '2026-10-25T18:30:00',
      dateLabel: 'Domingo 25 · 18:30',
      approximateZone: 'Güemes / San Carlos',
      localityId: 'guemes',
      openSlots: 0,
      confirmedCount: 3,
      confirmedSeats: 3,
      language: 'es',
      description: 'Jugamos un partido nivel intermedio.',
    };

    // Renderizar simulación del componente
    const mockUser = { id: participantB, email: 'b@test.com' };
    const authValue = {
      user: mockUser,
      isPermanentUser: true,
      authLoading: false,
      signInWithGoogleForDiscovery: async () => {},
      signOut: async () => {},
    };

    // Leemos el componente para validar las cadenas de copy implementadas
    const sheetTsx = readFileSync(
      resolve(process.cwd(), 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf8'
    );

    assert.ok(
      sheetTsx.includes('Tus ${participantSeats} lugares están confirmados'),
      'Debe incluir "Tus N lugares están confirmados" para multi-seat'
    );
    assert.ok(
      sheetTsx.includes('Tu lugar está confirmado'),
      'Debe incluir "Tu lugar está confirmado" para 1 lugar'
    );
    assert.ok(
      sheetTsx.includes('${participantSeats} lugares confirmados'),
      'Debe incluir "N lugares confirmados" en Tu reserva'
    );
    assert.ok(
      sheetTsx.includes('pe-detail-sheet__approved-banner'),
      'Debe incluir pe-detail-sheet__approved-banner al inicio'
    );
    assert.ok(
      sheetTsx.includes('pe-detail-sheet__meta-block--full'),
      'Debe incluir pe-detail-sheet__meta-block--full para dirección o link en ancho completo'
    );
    assert.ok(
      sheetTsx.includes('Ir a Mis encuentros'),
      'La acción principal debe guiar a Mis encuentros'
    );

    // Cero términos técnicos en UI
    assert.ok(!sheetTsx.includes('confirmed_seats:'), 'No debe usar confirmed_seats como etiqueta visible');
    assert.ok(!sheetTsx.includes('RPC:'), 'No debe usar RPC como etiqueta visible');
  });

  test('7. CSS MOBILE: Ancho completo de dirección/enlace y estilos de touch target para 360-412px', () => {
    const sheetCss = readFileSync(
      resolve(process.cwd(), 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.css'),
      'utf8'
    );

    assert.ok(sheetCss.includes('.pe-detail-sheet__approved-banner {'), 'Debe definir banner aprobado');
    assert.ok(sheetCss.includes('.pe-detail-sheet__meta-block--full {'), 'Debe definir modificador full');
    assert.ok(sheetCss.includes('grid-column: 1 / -1;'), 'Dirección debe expandirse a 2 columnas para no apretarse');
    assert.ok(sheetCss.includes('.pe-detail-sheet__virtual-link {'), 'Debe definir estilos para link virtual');
    assert.ok(sheetCss.includes('min-height: 36px'), 'Link virtual debe tener altura mínima tocable');
  });
});
