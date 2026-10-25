import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Regresión P2: get_encuentro_participante_autorizado para Anfitrión, Participantes y Deep Links', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const partConfirmedUser = '22222222-2222-2222-2222-222222222222';
  const partPendingUser = '33333333-3333-3333-3333-333333333333';
  const partWithdrawnUser = '44444444-4444-4444-4444-444444444444';
  const strangerUser = '55555555-5555-5555-5555-555555555555';
  const blockedUser = '66666666-6666-6666-6666-666666666666';

  let openPresencialEncounterId: string;
  let openVirtualEncounterId: string;
  let privateEncounterId: string;
  let cycleId = '77777777-7777-7777-7777-777777777777';

  const setAuth = async (userId: string | null) => {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${userId}"}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.role', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    }
  };

  before(async () => {
    db = new PGlite();

    // 1. Esquema base y Roles
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres; END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
      $$ LANGUAGE SQL STABLE;

      INSERT INTO auth.users (id, email) VALUES
        ('${hostUser}', 'host@test.com'),
        ('${partConfirmedUser}', 'part_conf@test.com'),
        ('${partPendingUser}', 'part_pend@test.com'),
        ('${partWithdrawnUser}', 'part_with@test.com'),
        ('${strangerUser}', 'stranger@test.com'),
        ('${blockedUser}', 'blocked@test.com')
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.localidades (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        ciudad TEXT,
        zona TEXT,
        activo BOOLEAN NOT NULL DEFAULT true
      );

      INSERT INTO public.localidades (id, nombre, ciudad, zona, activo) VALUES
        ('guemes', 'Güemes', 'Mar del Plata', 'Zona Güemes', true)
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        blocker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        blocked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
        PRIMARY KEY (blocker_id, blocked_id)
      );

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL,
        open_public_title TEXT,
        descripcion TEXT,
        open_description TEXT,
        fecha DATE NOT NULL,
        hora TIME WITHOUT TIME ZONE NOT NULL,
        modalidad TEXT NOT NULL CHECK (modalidad IN ('presencial', 'virtual')),
        locality_id TEXT REFERENCES public.localidades(id),
        open_public_zone TEXT,
        lugar_texto TEXT,
        link_virtual TEXT,
        max_participants INT,
        min_participants INT DEFAULT 2,
        is_open BOOLEAN NOT NULL DEFAULT false,
        opened_at TIMESTAMPTZ,
        estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'cancelado')),
        inscriptions_closed BOOLEAN NOT NULL DEFAULT false,
        inscriptions_cycle_id UUID,
        realization_status TEXT DEFAULT 'pending' CHECK (realization_status IN ('pending', 'confirmed', 'forced')),
        cancellation_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        nombre_invitado TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'confirmado' CHECK (estado IN ('pendiente', 'confirmado', 'rechazado', 'cancelado', 'asistio')),
        token_invitacion UUID DEFAULT gen_random_uuid(),
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        admission_source TEXT DEFAULT 'direct',
        reconfirmation_status TEXT DEFAULT 'pending' CHECK (reconfirmation_status IN ('pending', 'confirmed', 'declined')),
        reconfirmed_cycle_id UUID,
        seat_count INT NOT NULL DEFAULT 1 CHECK (seat_count >= 1),
        creado_en TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        estado TEXT NOT NULL DEFAULT 'pending',
        participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
        token_participante UUID,
        seat_count INT NOT NULL DEFAULT 1 CHECK (seat_count >= 1),
        created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
      );
    `);

    // 2. Cargar la nueva migración aditiva que corrige el RPC
    const migrationPath = path.resolve(__dirname, '../supabase/migrations/20261025170000_fix_get_encuentro_participante_autorizado_host_record_v1.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(sql);

    // 3. Crear fixtures de encuentros
    // Encuentro abierto presencial
    const resEnc1 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, descripcion, open_description,
        fecha, hora, modalidad, open_public_zone, lugar_texto,
        is_open, opened_at, estado, inscriptions_closed, inscriptions_cycle_id, realization_status
      ) VALUES (
        '${hostUser}', 'Asado Privado Titulo', 'Asado Comunitario Público',
        'Descripcion privada secreta', 'Descripcion publica abierta',
        '2026-11-20', '21:00:00', 'presencial', 'Zona Güemes', 'Calle Olavarría 1234',
        true, now(), 'activo', true, '${cycleId}', 'confirmed'
      ) RETURNING id;
    `);
    openPresencialEncounterId = resEnc1.rows[0].id;

    // Encuentro abierto virtual
    const resEnc2 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, descripcion, open_description,
        fecha, hora, modalidad, open_public_zone, link_virtual,
        is_open, opened_at, estado, inscriptions_closed, inscriptions_cycle_id, realization_status
      ) VALUES (
        '${hostUser}', 'Charla Tech Privada', 'Charla Tech Pública',
        'Desc privada', 'Desc publica',
        '2026-11-22', '19:00:00', 'virtual', 'Online', 'https://meet.google.com/punto-tech',
        true, now(), 'activo', true, '${cycleId}', 'confirmed'
      ) RETURNING id;
    `);
    openVirtualEncounterId = resEnc2.rows[0].id;

    // Encuentro privado individual
    const resEnc3 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, is_open, estado
      ) VALUES (
        '${hostUser}', 'Cumpleaños Íntimo', 'Solo amigos cercanos',
        '2026-11-25', '20:30:00', 'presencial', 'Casa de Juan 555', false, 'activo'
      ) RETURNING id;
    `);
    privateEncounterId = resEnc3.rows[0].id;

    // 4. Participantes en openPresencialEncounterId
    // Part Confirmed (aprobado + reconfirmado con 2 lugares)
    const resPartConf = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion,
        reconfirmation_status, reconfirmed_cycle_id, seat_count
      ) VALUES (
        '${openPresencialEncounterId}', '${partConfirmedUser}', 'Pedro Confirmado', 'confirmado', 'generico',
        'confirmed', '${cycleId}', 2
      ) RETURNING id;
    `);
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (
        encuentro_id, usuario_id, nombre_solicitante, estado, participante_id, seat_count
      ) VALUES (
        '${openPresencialEncounterId}', '${partConfirmedUser}', 'Pedro Confirmado', 'approved', '${resPartConf.rows[0].id}', 2
      );
    `);

    // Part Withdrawn (retirado voluntariamente / cancelado)
    const resPartWith = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion,
        reconfirmation_status, seat_count
      ) VALUES (
        '${openPresencialEncounterId}', '${partWithdrawnUser}', 'Carlos Retirado', 'cancelado', 'generico',
        'declined', 1
      ) RETURNING id;
    `);

    // Blocked user
    await db.query(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${hostUser}', '${blockedUser}');
    `);
    await db.query(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion, seat_count
      ) VALUES (
        '${openPresencialEncounterId}', '${blockedUser}', 'Usuario Bloqueado', 'confirmado', 'generico', 1
      );
    `);
  });

  test('1. Host: resolución exitosa sin error de "v_part is not assigned yet"', async () => {
    await setAuth(hostUser);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${openPresencialEncounterId}'::uuid);
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(data.ok, true, 'Debe devolver ok: true');
    assert.equal(data.is_host, true, 'Debe marcar is_host: true');
    assert.equal(data.lugar_texto, 'Calle Olavarría 1234', 'Host debe acceder a la dirección privada');
    assert.equal(data.seat_count, null, 'Host no tiene seat_count personal');
    assert.equal(data.reconfirmation_status, null, 'Host no tiene reconfirmation_status de participante');
    assert.equal(data.open_public_title, 'Asado Comunitario Público', 'Host ve el título del encuentro');
    assert.equal(data.open_description, 'Descripcion publica abierta', 'Host ve la descripción');
  });

  test('2. Host en encuentro virtual: accede al link_virtual y datos completos', async () => {
    await setAuth(hostUser);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${openVirtualEncounterId}'::uuid);
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(data.ok, true);
    assert.equal(data.is_host, true);
    assert.equal(data.modalidad, 'virtual');
    assert.equal(data.link_virtual, 'https://meet.google.com/punto-tech');
    assert.equal(data.lugar_texto, null);
    assert.equal(data.seat_count, null);
  });

  test('3. Deep link del anfitrión: emula resolución de getEncuentroParticipanteAutorizado en openEncountersService', async () => {
    await setAuth(hostUser);
    // Simula lo que hace openEncountersService.getOpenEncounterSummary cuando falla el lookup de Discovery
    // y cae al fallback getEncuentroParticipanteAutorizado
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${openPresencialEncounterId}'::uuid);
    `);
    const authRes = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(authRes.ok, true);
    assert.equal(authRes.id, openPresencialEncounterId);

    // Mapeo exacto de openEncountersService.ts líneas 175-199
    const timePart = authRes.hora ? authRes.hora.substring(0, 5) : '';
    const dateLabel = authRes.fecha ? `${authRes.fecha}${timePart ? ` · ${timePart}` : ''}` : '';
    const zone = authRes.open_public_zone || (authRes.modalidad === 'virtual' ? 'Online' : 'Ubicación confirmada');
    const summary = {
      id: authRes.id,
      title: authRes.open_public_title || 'Encuentro',
      startsAt: `${authRes.fecha || ''}T${authRes.hora || '00:00:00'}`,
      dateLabel,
      approximateZone: zone,
      isHost: authRes.is_host,
      hostId: authRes.is_host ? 'current-user' : '',
      minParticipants: authRes.min_participants,
      realizationStatus: authRes.realization_status,
      inscriptionsClosed: authRes.inscriptions_closed,
    };

    assert.equal(summary.id, openPresencialEncounterId);
    assert.equal(summary.isHost, true);
    assert.equal(summary.hostId, 'current-user');
    assert.equal(summary.title, 'Asado Comunitario Público');
    assert.equal(summary.realizationStatus, 'confirmed');
  });

  test('4. Participante confirmado: accede a la logística privada y sus propios cupos', async () => {
    await setAuth(partConfirmedUser);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${openPresencialEncounterId}'::uuid);
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(data.ok, true);
    assert.equal(data.is_host, false);
    assert.equal(data.lugar_texto, 'Calle Olavarría 1234');
    assert.equal(data.seat_count, 2, 'Debe preservar seat_count = 2 del participante');
    assert.equal(data.reconfirmation_status, 'confirmed', 'Debe reflejar estado reconfirmado');
  });

  test('5. Participante retirado / cancelado: pierde acceso inmediato a la logística', async () => {
    await setAuth(partWithdrawnUser);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${openPresencialEncounterId}'::uuid);
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(data.ok, true);
    assert.equal(data.is_host, false);
    assert.equal(data.lugar_texto, null, 'Participante cancelado NO debe ver lugar_texto');
    assert.equal(data.seat_count, 1);
    assert.equal(data.reconfirmation_status, 'declined');
  });

  test('6. Solicitante pendiente: no registrado en participantes recibe forbidden', async () => {
    await setAuth(partPendingUser);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${openPresencialEncounterId}'::uuid);
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(data.ok, false);
    assert.equal(data.error, 'forbidden');
    assert.equal(data.lugar_texto, undefined);
  });

  test('7. Tercero no invitado / ajeno: recibe forbidden y 0 datos logísticos', async () => {
    await setAuth(strangerUser);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${openPresencialEncounterId}'::uuid);
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(data.ok, false);
    assert.equal(data.error, 'forbidden');
  });

  test('8. Usuario bloqueado bilateralmente: recibe blocked_user', async () => {
    await setAuth(blockedUser);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${openPresencialEncounterId}'::uuid);
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(data.ok, false);
    assert.equal(data.error, 'blocked_user');
  });

  test('9. Usuario anónimo / sin sesión: rechazado con unauthorized', async () => {
    await setAuth(null);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${openPresencialEncounterId}'::uuid);
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(data.ok, false);
    assert.equal(data.error, 'unauthorized');
  });

  test('10. Encuentro no existente: not_found', async () => {
    await setAuth(hostUser);
    const nonExistentId = '00000000-0000-0000-0000-000000000000';
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${nonExistentId}'::uuid);
    `);
    const data = res.rows[0].get_encuentro_participante_autorizado;

    assert.equal(data.ok, false);
    assert.equal(data.error, 'not_found');
  });
});
