import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-C1 (T2-B2-P): Aprobación de solicitud abierta con asignación de user_id', () => {
  let db;
  const hostUser = '11111111-1111-1111-1111-111111111111';
  const applicantUser = '22222222-2222-2222-2222-222222222222';
  const otherUser = '33333333-3333-3333-3333-333333333333';

  let encounterId;
  let solicitudId;

  before(async () => {
    db = new PGlite();

    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT,
        created_at TIMESTAMPTZ DEFAULT '2026-05-15 10:00:00Z'
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
      $$ LANGUAGE SQL STABLE;

      INSERT INTO auth.users (id, email) VALUES
        ('${hostUser}', 'host@test.com'),
        ('${applicantUser}', 'applicant@test.com'),
        ('${otherUser}', 'other@test.com');

      CREATE TABLE IF NOT EXISTS public.localidades (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        ciudad TEXT NOT NULL,
        zona TEXT NOT NULL,
        pais TEXT NOT NULL DEFAULT 'AR',
        orden INT NOT NULL DEFAULT 1,
        activo BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      INSERT INTO public.localidades (id, nombre, ciudad, zona) VALUES
        ('caba_palermo', 'Palermo', 'CABA', 'CABA Norte')
        ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL,
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha DATE,
        hora TIME,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        lugar_texto TEXT,
        link_virtual TEXT,
        public_token UUID NOT NULL DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'activo',
        is_open BOOLEAN NOT NULL DEFAULT false,
        open_description TEXT,
        open_public_zone TEXT,
        max_participants INT,
        duration_minutes INT,
        post_event_active_minutes INT NOT NULL DEFAULT 45,
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        locality_id TEXT REFERENCES public.localidades(id),
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        token_invitacion UUID DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'pendiente',
        user_id UUID,
        mensaje_respuesta TEXT,
        respondido_en TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL,
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        estado TEXT NOT NULL DEFAULT 'pending',
        participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
        token_participante UUID,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        resolved_at TIMESTAMPTZ
      );
    `);

    // Aplicar la nueva migración aditiva
    const migPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20260930150000_fix_fase_20c1_trust_approved_participant_user_id.sql'
    );
    await db.exec(fs.readFileSync(migPath, 'utf-8'));
  });

  test('A, B, C, D: Aprobar solicitud abierta crea participante con user_id del solicitante, token individual y relación correcta', async () => {
    // 1. Crear encuentro abierto con cupo para 3 (host + 2 participantes)
    const resEnc = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, max_participants, locality_id, fecha, hora)
      VALUES ('${hostUser}', 'Encuentro Prueba Cupo', true, now(), 3, 'caba_palermo', CURRENT_DATE + interval '3 days', '20:00')
      RETURNING id;
    `);
    encounterId = resEnc.rows[0].id;

    // 2. Crear solicitud pendiente de applicantUser
    const resSol = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, mensaje, estado)
      VALUES ('${encounterId}', '${applicantUser}', 'Ana Solicitante', 'Hola, me encantaría sumarme', 'pending')
      RETURNING id;
    `);
    solicitudId = resSol.rows[0].id;

    // 3. Host aprueba la solicitud
    await db.exec(`SET request.jwt.claim.sub = '${hostUser}';`);
    await db.exec(`SET request.jwt.claims = '{"sub": "${hostUser}", "is_anonymous": false}';`);

    const resRpc = await db.query(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${solicitudId}'::uuid, '${hostUser}'::uuid) as result;
    `);
    const result = resRpc.rows[0].result;
    assert.equal(result.ok, true);
    assert.ok(result.participante_id);
    assert.ok(result.token_invitacion);

    // A. Verificar participante con user_id del solicitante
    const resPart = await db.query(`
      SELECT * FROM public.participantes WHERE id = '${result.participante_id}';
    `);
    assert.equal(resPart.rows.length, 1);
    const part = resPart.rows[0];
    assert.equal(part.user_id, applicantUser, 'A. participante.user_id debe ser igual a solicitud.usuario_id');
    assert.notEqual(part.user_id, hostUser, 'D. No debe asignarse el host como participante');
    assert.notEqual(part.user_id, otherUser, 'D. No debe asignarse otro usuario');

    // B. Participante conserva token individual
    assert.equal(part.token_invitacion, result.token_invitacion, 'B. Token individual debe coincidir');
    assert.equal(part.estado, 'confirmado');
    assert.equal(part.nombre_invitado, 'Ana Solicitante');

    // C. Solicitud queda approved y vinculada al participante correcto
    const resSolCheck = await db.query(`
      SELECT * FROM public.solicitudes_encuentro_abierto WHERE id = '${solicitudId}';
    `);
    const sol = resSolCheck.rows[0];
    assert.equal(sol.estado, 'approved', 'C. Solicitud debe estar approved');
    assert.equal(sol.participante_id, part.id, 'C. Solicitud vinculada al participante_id');
    assert.equal(sol.token_participante, part.token_invitacion, 'C. Token guardado en solicitud');
    assert.ok(sol.resolved_at);
  });

  test('E, F, G: Backfill seguro de registros históricos', async () => {
    // Escenario 1: Registro aprobado histórico donde participante_id existe pero user_id está en NULL (debe completarse)
    const resPartHistoricalNull = await db.query(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, estado, user_id)
      VALUES ('${encounterId}', 'Usuario Histórico', 'individual', 'confirmado', NULL)
      RETURNING id;
    `);
    const partHistoricalNullId = resPartHistoricalNull.rows[0].id;

    const resSolHist1 = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, participante_id)
      VALUES ('${encounterId}', '${otherUser}', 'Usuario Histórico', 'approved', '${partHistoricalNullId}')
      RETURNING id;
    `);

    // Escenario 2: Participante ya vinculado con user_id previamente (no debe modificarse erróneamente)
    const resPartExistingUser = await db.query(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, estado, user_id)
      VALUES ('${encounterId}', 'Usuario Con User', 'individual', 'confirmado', '${otherUser}')
      RETURNING id;
    `);
    const partExistingUserId = resPartExistingUser.rows[0].id;

    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, participante_id)
      VALUES ('${encounterId}', '${applicantUser}', 'Usuario Con User', 'approved', '${partExistingUserId}');
    `);

    // Escenario 3: Relación no inequívoca (solicitud no aprobada o participante_id nulo)
    const resPartUnlinked = await db.query(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, estado, user_id)
      VALUES ('${encounterId}', 'Unlinked Guest', 'individual', 'confirmado', NULL)
      RETURNING id;
    `);
    const partUnlinkedId = resPartUnlinked.rows[0].id;

    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, participante_id)
      VALUES ('${encounterId}', '${applicantUser}', 'Solicitud Rechazada', 'rejected', '${partUnlinkedId}');
    `);

    // Ejecutar la sentencia de backfill
    await db.exec(`
      UPDATE public.participantes p
      SET user_id = s.usuario_id
      FROM public.solicitudes_encuentro_abierto s
      WHERE s.participante_id = p.id
        AND s.estado = 'approved'
        AND s.usuario_id IS NOT NULL
        AND p.user_id IS NULL;
    `);

    // E. Verificar que partHistoricalNull fue actualizado con otherUser
    const check1 = await db.query(`SELECT user_id FROM public.participantes WHERE id = '${partHistoricalNullId}';`);
    assert.equal(check1.rows[0].user_id, otherUser, 'E. Backfill debe actualizar user_id del participante null');

    // F. Verificar que partExistingUser NO fue sobreescrito con applicantUser
    const check2 = await db.query(`SELECT user_id FROM public.participantes WHERE id = '${partExistingUserId}';`);
    assert.equal(check2.rows[0].user_id, otherUser, 'F. Participante con user_id preexistente no se modifica');

    // G. Verificar que partUnlinked NO fue modificado (la solicitud estaba rejected)
    const check3 = await db.query(`SELECT user_id FROM public.participantes WHERE id = '${partUnlinkedId}';`);
    assert.equal(check3.rows[0].user_id, null, 'G. Participante no inequívoco permanece en NULL');
  });

  test('H: Flujo existente de cupo sigue funcionando y rechaza cuando no hay lugares', async () => {
    // Encuentro ya tiene:
    // host (1) + Ana Solicitante (1) + Usuario Histórico (1) = 3 confirmados.
    // max_participants es 3, por ende no hay cupo.
    const resSolFull = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encounterId}', '${otherUser}', 'Tercer Solicitante', 'pending')
      RETURNING id;
    `);
    const solFullId = resSolFull.rows[0].id;

    await db.exec(`SET request.jwt.claim.sub = '${hostUser}';`);
    await db.exec(`SET request.jwt.claims = '{"sub": "${hostUser}", "is_anonymous": false}';`);

    const resRpc = await db.query(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${solFullId}'::uuid, '${hostUser}'::uuid) as result;
    `);
    assert.equal(resRpc.rows[0].result.ok, false);
    assert.equal(resRpc.rows[0].result.error, 'quota_exceeded', 'H. Debe rechazar con quota_exceeded');
  });
});
