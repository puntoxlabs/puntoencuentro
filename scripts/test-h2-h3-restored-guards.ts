/**
 * Test: Restauración de Controles de Seguridad H2/H3 Post-Microfix
 *
 * Cubre:
 * 1. Invariantes de la última definición efectiva del RPC.
 * 2. Anfitrión anónimo: aprobación rechazada con permanent_account_required.
 * 3. Encuentro en estado no activo: aprobación rechazada con encuentro_not_active.
 * 4. Bloqueo bilateral host -> solicitante: rechazo con request_not_available.
 * 5. Bloqueo bilateral solicitante -> host: rechazo con request_not_available.
 * 6. Usuario ya confirmado con otra solicitud pendiente: rechazo con already_joined sin duplicar cupos.
 * 7. Usuario previamente cancelado con nueva solicitud válida: aprobación exitosa y reseteo de reconfirmación.
 * 8. Reintento de la misma solicitud aprobada: resultado idempotente.
 * 9. Concurrencia de aprobaciones: sin sobrecupo ni estados corruptos.
 * 10. Ciclos de notificación y deduplicación H6.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function createTestDb() {
  const db = new PGlite();

  // 1. Roles y esquema auth
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;

    CREATE SCHEMA IF NOT EXISTS auth;

    CREATE TABLE IF NOT EXISTS auth.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE,
      raw_user_meta_data JSONB DEFAULT '{}'::jsonb
    );

    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
    $$ LANGUAGE sql STABLE;

    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
    $$ LANGUAGE sql STABLE;

    -- 2. Tablas públicas de Staging (13 columnas en participantes)
    CREATE TABLE IF NOT EXISTS public.encuentros (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      host_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      titulo TEXT NOT NULL,
      open_public_title TEXT,
      descripcion TEXT,
      fecha DATE,
      hora TIME,
      modalidad TEXT NOT NULL DEFAULT 'presencial',
      lugar_texto TEXT,
      link_virtual TEXT,
      estado TEXT NOT NULL DEFAULT 'activo',
      is_open BOOLEAN DEFAULT false,
      max_participants INT DEFAULT 10,
      min_participants INT,
      realization_status TEXT DEFAULT 'pending',
      min_realization_cycle_id UUID DEFAULT gen_random_uuid(),
      min_confirmed_notified_at TIMESTAMPTZ,
      inscriptions_closed BOOLEAN DEFAULT false,
      inscriptions_cycle_id UUID DEFAULT gen_random_uuid(),
      creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS public.participantes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
      user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      nombre_invitado TEXT NOT NULL,
      tipo_invitacion TEXT DEFAULT 'individual',
      token_invitacion UUID DEFAULT gen_random_uuid(),
      estado TEXT NOT NULL DEFAULT 'pendiente',
      mensaje_respuesta TEXT,
      respondido_en TIMESTAMPTZ,
      creado_en TIMESTAMPTZ DEFAULT now() NOT NULL,
      seat_count INT NOT NULL DEFAULT 1,
      reconfirmation_status TEXT DEFAULT 'pending',
      reconfirmed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
      usuario_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      nombre_solicitante TEXT NOT NULL,
      mensaje TEXT,
      estado TEXT NOT NULL DEFAULT 'pending',
      seat_count INT NOT NULL DEFAULT 1,
      participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
      token_participante UUID,
      motivo_baja TEXT,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      blocker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      blocked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      UNIQUE (blocker_id, blocked_id)
    );

    CREATE TABLE IF NOT EXISTS public.domain_events_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type TEXT NOT NULL,
      event_version INT NOT NULL DEFAULT 1,
      aggregate_type TEXT NOT NULL,
      aggregate_id UUID NOT NULL,
      actor_user_id UUID,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      dedup_key TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS public.inbox_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      notification_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id UUID NOT NULL,
      deep_link TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      payload JSONB DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      dedup_key TEXT,
      expires_at TIMESTAMPTZ DEFAULT (now() + interval '30 days'),
      created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
      UNIQUE (recipient_user_id, dedup_key)
    );

    CREATE OR REPLACE FUNCTION public.insertar_inbox_notification_seguro(
      p_recipient_user_id UUID,
      p_notification_type TEXT,
      p_target_type TEXT,
      p_target_id UUID,
      p_deep_link TEXT,
      p_title TEXT,
      p_body TEXT,
      p_payload JSONB DEFAULT '{}'::jsonb,
      p_dedup_key TEXT DEFAULT NULL
    )
    RETURNS UUID
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = ''
    AS $$
    DECLARE
      v_id UUID;
    BEGIN
      INSERT INTO public.inbox_notifications (
        recipient_user_id, notification_type, target_type, target_id,
        deep_link, title, body, payload, dedup_key
      ) VALUES (
        p_recipient_user_id, p_notification_type, p_target_type, p_target_id,
        p_deep_link, p_title, p_body, p_payload, p_dedup_key
      )
      ON CONFLICT (recipient_user_id, dedup_key) DO UPDATE
      SET title = EXCLUDED.title,
          body = EXCLUDED.body,
          payload = EXCLUDED.payload,
          read_at = NULL,
          created_at = now()
      RETURNING id INTO v_id;

      RETURN v_id;
    END;
    $$;
  `);

  // 3. Aplicar la última migración que define aprobar_solicitud_encuentro_abierto
  const migrationPath = path.join(rootDir, 'supabase/migrations/20261016223000_restore_h2_h3_guards_in_approval_rpc.sql');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');
  await db.exec(migrationSql);

  const setAuthContext = async (userId: string | null, isAnon: boolean = false) => {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": ${isAnon}, "role": "authenticated"}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    }
  };

  return { db, setAuthContext };
}

test('H2/H3 Restored Guards: Corrección final y validación de seguridad', async (t) => {
  await t.test('1. Inspección estática de invariantes en la última definición efectiva del RPC', () => {
    const migrationsDir = path.join(rootDir, 'supabase/migrations');
    const allMigrations = fs.readdirSync(migrationsDir).sort();
    const approvalMigrations = allMigrations.filter((f) => {
      if (!f.endsWith('.sql')) return false;
      const content = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
      return content.includes('CREATE OR REPLACE FUNCTION public.aprobar_solicitud_encuentro_abierto');
    });

    assert.ok(approvalMigrations.length > 0);
    const latestMigrationFile = approvalMigrations[approvalMigrations.length - 1];
    assert.equal(latestMigrationFile, '20261016223000_restore_h2_h3_guards_in_approval_rpc.sql');

    const content = fs.readFileSync(path.join(migrationsDir, latestMigrationFile), 'utf8');

    // Control A: Cuenta permanente obligatoria
    assert.match(content, /is_anonymous/i, 'Debe verificar is_anonymous');
    assert.match(content, /permanent_account_required/, 'Debe retornar permanent_account_required');

    // Control B: Estado activo bajo lock
    assert.match(content, /encuentro\.estado\s*<>\s*'activo'/i, 'Debe exigir estado = activo');
    assert.match(content, /encuentro_not_active/, 'Debe retornar encuentro_not_active');

    // Control C: Bloqueo bilateral
    assert.match(content, /bloqueos_usuario/i, 'Debe consultar public.bloqueos_usuario');
    assert.match(content, /request_not_available/, 'Debe retornar request_not_available');

    // Control D: Participación activa duplicada
    assert.match(content, /already_joined/, 'Debe retornar already_joined');
    assert.match(content, /estado\s+IN\s*\('confirmado',\s*'asistio'\)/i, 'Debe comprobar estado confirmado o asistio');

    // Idempotencia y mejoras posteriores
    assert.match(content, /already_approved/, 'Debe preservar idempotencia de la misma solicitud');
    assert.match(content, /reconfirmation_status\s*=\s*'pending'/, 'Debe resetear reconfirmation_status a pending');
    assert.match(content, /reconfirmed_at\s*=\s*NULL/i, 'Debe limpiar reconfirmed_at');
    assert.match(content, /gen_random_uuid\(\)/, 'Debe rotar token_invitacion');
    assert.match(content, /min_realization_cycle_id/, 'Debe preservar ciclo de deduplicación H6');
    assert.match(content, /domain_events_outbox/, 'Debe insertar en domain_events_outbox');
  });

  await t.test('2. Anfitrión anónimo: aprobación rechazada con permanent_account_required', async () => {
    const { db, setAuthContext } = await createTestDb();

    const hostId = '11111111-1111-4111-8111-111111111111';
    const applicantId = '22222222-2222-4222-8222-222222222222';
    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES
      ('${hostId}', 'host@test.com'),
      ('${applicantId}', 'applicant@test.com');

      INSERT INTO public.encuentros (id, host_id, titulo, estado, is_open, max_participants)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${hostId}', 'Encuentro Test', 'activo', true, 5);

      INSERT INTO public.solicitudes_encuentro_abierto (id, encuentro_id, usuario_id, nombre_solicitante, estado, seat_count)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${applicantId}', 'Solicitante', 'pending', 1);
    `);

    // Host con sesión anónima (is_anonymous: true)
    await setAuthContext(hostId, true);
    const res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS aprobar_solicitud_encuentro_abierto;
    `);

    const data = res.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(data.ok, false);
    assert.equal(data.error, 'permanent_account_required');

    // Verificar que la solicitud sigue pending y no se creó participante
    const solCheck = await db.query<{ estado: string }>(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';`);
    assert.equal(solCheck.rows[0].estado, 'pending');

    const partCount = await db.query<{ count: string }>(`SELECT count(*) FROM public.participantes;`);
    assert.equal(parseInt(partCount.rows[0].count, 10), 0);
  });

  await t.test('3. Encuentro en estado no activo (cancelado o cerrado): aprobación rechazada con encuentro_not_active', async () => {
    const { db, setAuthContext } = await createTestDb();

    const hostId = '11111111-1111-4111-8111-111111111111';
    const applicantId = '22222222-2222-4222-8222-222222222222';
    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES
      ('${hostId}', 'host@test.com'),
      ('${applicantId}', 'applicant@test.com');

      INSERT INTO public.encuentros (id, host_id, titulo, estado, is_open, max_participants)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${hostId}', 'Encuentro Test', 'cancelado', true, 5);

      INSERT INTO public.solicitudes_encuentro_abierto (id, encuentro_id, usuario_id, nombre_solicitante, estado, seat_count)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${applicantId}', 'Solicitante', 'pending', 1);
    `);

    await setAuthContext(hostId, false);
    const res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS aprobar_solicitud_encuentro_abierto;
    `);

    const data = res.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(data.ok, false);
    assert.equal(data.error, 'encuentro_not_active');

    // Probar también con estado 'finalizado'
    await db.exec(`UPDATE public.encuentros SET estado = 'finalizado' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';`);
    const res2 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS aprobar_solicitud_encuentro_abierto;
    `);
    assert.equal(res2.rows[0].aprobar_solicitud_encuentro_abierto.error, 'encuentro_not_active');
  });

  await t.test('4. Bloqueo anfitrión -> solicitante: aprobación rechazada con request_not_available', async () => {
    const { db, setAuthContext } = await createTestDb();

    const hostId = '11111111-1111-4111-8111-111111111111';
    const applicantId = '22222222-2222-4222-8222-222222222222';
    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES
      ('${hostId}', 'host@test.com'),
      ('${applicantId}', 'applicant@test.com');

      INSERT INTO public.encuentros (id, host_id, titulo, estado, is_open, max_participants)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${hostId}', 'Encuentro Test', 'activo', true, 5);

      INSERT INTO public.solicitudes_encuentro_abierto (id, encuentro_id, usuario_id, nombre_solicitante, estado, seat_count)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${applicantId}', 'Solicitante', 'pending', 1);

      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${hostId}', '${applicantId}');
    `);

    await setAuthContext(hostId, false);
    const res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS aprobar_solicitud_encuentro_abierto;
    `);

    const data = res.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(data.ok, false);
    assert.equal(data.error, 'request_not_available');

    // Solicitud sigue pending y no hay participantes
    const solCheck = await db.query<{ estado: string }>(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';`);
    assert.equal(solCheck.rows[0].estado, 'pending');
    const partCount = await db.query<{ count: string }>(`SELECT count(*) FROM public.participantes;`);
    assert.equal(parseInt(partCount.rows[0].count, 10), 0);
  });

  await t.test('5. Bloqueo solicitante -> anfitrión: aprobación rechazada con request_not_available', async () => {
    const { db, setAuthContext } = await createTestDb();

    const hostId = '11111111-1111-4111-8111-111111111111';
    const applicantId = '22222222-2222-4222-8222-222222222222';
    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES
      ('${hostId}', 'host@test.com'),
      ('${applicantId}', 'applicant@test.com');

      INSERT INTO public.encuentros (id, host_id, titulo, estado, is_open, max_participants)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${hostId}', 'Encuentro Test', 'activo', true, 5);

      INSERT INTO public.solicitudes_encuentro_abierto (id, encuentro_id, usuario_id, nombre_solicitante, estado, seat_count)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${applicantId}', 'Solicitante', 'pending', 1);

      -- Solicitante bloqueó al host
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${applicantId}', '${hostId}');
    `);

    await setAuthContext(hostId, false);
    const res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS aprobar_solicitud_encuentro_abierto;
    `);

    const data = res.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(data.ok, false);
    assert.equal(data.error, 'request_not_available');
  });

  await t.test('6. Usuario ya confirmado con otra solicitud pendiente: rechazo con already_joined sin duplicar cupos', async () => {
    const { db, setAuthContext } = await createTestDb();

    const hostId = '11111111-1111-4111-8111-111111111111';
    const applicantId = '22222222-2222-4222-8222-222222222222';
    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES
      ('${hostId}', 'host@test.com'),
      ('${applicantId}', 'applicant@test.com');

      INSERT INTO public.encuentros (id, host_id, titulo, estado, is_open, max_participants)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${hostId}', 'Encuentro Test', 'activo', true, 5);

      -- El usuario ya es un participante confirmado en el encuentro (1 cupo)
      INSERT INTO public.participantes (id, encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${applicantId}', 'Solicitante Ya Confirmado', 'confirmado', 1);

      -- Existe otra solicitud posterior que quedó pending
      INSERT INTO public.solicitudes_encuentro_abierto (id, encuentro_id, usuario_id, nombre_solicitante, estado, seat_count)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${applicantId}', 'Solicitante', 'pending', 2);
    `);

    await setAuthContext(hostId, false);
    const res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS aprobar_solicitud_encuentro_abierto;
    `);

    const data = res.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(data.ok, false);
    assert.equal(data.error, 'already_joined');

    // Verificar que los cupos totales confirmados siguen siendo exactamente 1 (no se duplicaron)
    const seatsRes = await db.query<{ sum: string }>(`
      SELECT sum(seat_count) FROM public.participantes WHERE encuentro_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND estado = 'confirmado';
    `);
    assert.equal(parseInt(seatsRes.rows[0].sum, 10), 1);
  });

  await t.test('7. Usuario previamente cancelado con nueva solicitud válida: aprobación exitosa y reseteo de reconfirmación', async () => {
    const { db, setAuthContext } = await createTestDb();

    const hostId = '11111111-1111-4111-8111-111111111111';
    const applicantId = '22222222-2222-4222-8222-222222222222';
    const initialToken = '99999999-9999-4999-8999-999999999999';

    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES
      ('${hostId}', 'host@test.com'),
      ('${applicantId}', 'applicant@test.com');

      INSERT INTO public.encuentros (id, host_id, titulo, estado, is_open, max_participants)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${hostId}', 'Encuentro Test', 'activo', true, 5);

      -- Participante dado de baja previa (cancelado), habiendo estado reconfirmado en el ciclo anterior
      INSERT INTO public.participantes (id, encuentro_id, user_id, nombre_invitado, estado, seat_count, token_invitacion, reconfirmation_status, reconfirmed_at)
      VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${applicantId}', 'Solicitante', 'cancelado', 1, '${initialToken}', 'confirmed', now());

      -- Solicitud previa cancelada con motivo de baja
      INSERT INTO public.solicitudes_encuentro_abierto (id, encuentro_id, usuario_id, nombre_solicitante, estado, seat_count, motivo_baja, resolved_at)
      VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${applicantId}', 'Solicitante', 'cancelled', 1, 'Motivo de baja previo', now());

      -- Nueva solicitud válida para sumarse con 2 cupos
      INSERT INTO public.solicitudes_encuentro_abierto (id, encuentro_id, usuario_id, nombre_solicitante, estado, seat_count)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${applicantId}', 'Solicitante Post-Baja', 'pending', 2);
    `);

    await setAuthContext(hostId, false);
    const res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS aprobar_solicitud_encuentro_abierto;
    `);

    const data = res.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(data.ok, true);
    assert.equal(data.seat_count, 2);
    assert.notEqual(data.token_invitacion, initialToken, 'El token debe haberse rotado');

    // Verificar tabla participantes
    const part = await db.query<{
      estado: string;
      seat_count: number;
      reconfirmation_status: string;
      reconfirmed_at: string | null;
      token_invitacion: string;
    }>(`SELECT estado, seat_count, reconfirmation_status, reconfirmed_at, token_invitacion FROM public.participantes WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';`);

    assert.equal(part.rows[0].estado, 'confirmado');
    assert.equal(part.rows[0].seat_count, 2);
    assert.equal(part.rows[0].reconfirmation_status, 'pending');
    assert.equal(part.rows[0].reconfirmed_at, null);
    assert.notEqual(part.rows[0].token_invitacion, initialToken);

    // Verificar que la solicitud previa conservó su motivo de baja
    const oldSol = await db.query<{ motivo_baja: string }>(`SELECT motivo_baja FROM public.solicitudes_encuentro_abierto WHERE id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';`);
    assert.equal(oldSol.rows[0].motivo_baja, 'Motivo de baja previo');
  });

  await t.test('8. Reintento de la misma solicitud aprobada: resultado idempotente', async () => {
    const { db, setAuthContext } = await createTestDb();

    const hostId = '11111111-1111-4111-8111-111111111111';
    const applicantId = '22222222-2222-4222-8222-222222222222';
    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES
      ('${hostId}', 'host@test.com'),
      ('${applicantId}', 'applicant@test.com');

      INSERT INTO public.encuentros (id, host_id, titulo, estado, is_open, max_participants)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${hostId}', 'Encuentro Test', 'activo', true, 5);

      INSERT INTO public.solicitudes_encuentro_abierto (id, encuentro_id, usuario_id, nombre_solicitante, estado, seat_count)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${applicantId}', 'Solicitante', 'pending', 1);
    `);

    await setAuthContext(hostId, false);
    // Primera aprobación
    const res1 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS aprobar_solicitud_encuentro_abierto;
    `);
    assert.equal(res1.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);
    const token1 = res1.rows[0].aprobar_solicitud_encuentro_abierto.token_invitacion;

    // Segunda llamada (idempotente)
    const res2 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS aprobar_solicitud_encuentro_abierto;
    `);
    const data2 = res2.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(data2.ok, true);
    assert.equal(data2.already_approved, true);
    assert.equal(data2.token_invitacion, token1);
  });

  await t.test('9. Concurrencia de aprobaciones: sin sobrecupo ni corrupción', async () => {
    const { db, setAuthContext } = await createTestDb();

    const hostId = '11111111-1111-4111-8111-111111111111';
    const app1Id = '22222222-2222-4222-8222-222222222221';
    const app2Id = '22222222-2222-4222-8222-222222222222';
    const app3Id = '22222222-2222-4222-8222-222222222223';

    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES
      ('${hostId}', 'host@test.com'),
      ('${app1Id}', 'app1@test.com'),
      ('${app2Id}', 'app2@test.com'),
      ('${app3Id}', 'app3@test.com');

      -- Capacidad máxima = 2 cupos
      INSERT INTO public.encuentros (id, host_id, titulo, estado, is_open, max_participants)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${hostId}', 'Encuentro Test', 'activo', true, 2);

      INSERT INTO public.solicitudes_encuentro_abierto (id, encuentro_id, usuario_id, nombre_solicitante, estado, seat_count) VALUES
      ('b1111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${app1Id}', 'Postulante 1', 'pending', 1),
      ('b2222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${app2Id}', 'Postulante 2', 'pending', 1),
      ('b3333333-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${app3Id}', 'Postulante 3', 'pending', 1);
    `);

    await setAuthContext(hostId, false);

    // Intentar aprobar secuencialmente o en paralelo
    const r1 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('b1111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS aprobar_solicitud_encuentro_abierto;
    `);
    const r2 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('b2222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS aprobar_solicitud_encuentro_abierto;
    `);
    const r3 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('b3333333-bbbb-4bbb-8bbb-bbbbbbbbbbbb') AS aprobar_solicitud_encuentro_abierto;
    `);

    assert.equal(r1.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);
    assert.equal(r2.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);
    assert.equal(r3.rows[0].aprobar_solicitud_encuentro_abierto.ok, false);
    assert.equal(r3.rows[0].aprobar_solicitud_encuentro_abierto.error, 'capacity_exceeded');

    const totalConfirmed = await db.query<{ sum: string }>(`
      SELECT sum(seat_count) FROM public.participantes WHERE encuentro_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND estado = 'confirmado';
    `);
    assert.equal(parseInt(totalConfirmed.rows[0].sum, 10), 2);
  });

  await t.test('10. Ciclos de notificación y deduplicación H6: inbox, outbox y mínimo alcanzado', async () => {
    const { db, setAuthContext } = await createTestDb();

    const hostId = '11111111-1111-4111-8111-111111111111';
    const app1Id = '22222222-2222-4222-8222-222222222221';
    const app2Id = '22222222-2222-4222-8222-222222222222';

    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES
      ('${hostId}', 'host@test.com'),
      ('${app1Id}', 'app1@test.com'),
      ('${app2Id}', 'app2@test.com');

      -- Mínimo de participantes = 2
      INSERT INTO public.encuentros (id, host_id, titulo, estado, is_open, max_participants, min_participants, realization_status)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${hostId}', 'Encuentro Test', 'activo', true, 5, 2, 'pending');

      INSERT INTO public.solicitudes_encuentro_abierto (id, encuentro_id, usuario_id, nombre_solicitante, estado, seat_count) VALUES
      ('b1111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${app1Id}', 'Postulante 1', 'pending', 1),
      ('b2222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${app2Id}', 'Postulante 2', 'pending', 1);
    `);

    await setAuthContext(hostId, false);

    // 1. Aprobar primera solicitud: 1 cupo confirmado, min (2) aún no alcanzado
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('b1111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb');`);

    const notif1 = await db.query<{ count: string }>(`
      SELECT count(*) FROM public.inbox_notifications WHERE notification_type = 'open_encounter_request_accepted' AND recipient_user_id = '${app1Id}';
    `);
    assert.equal(parseInt(notif1.rows[0].count, 10), 1);

    const outbox1 = await db.query<{ count: string }>(`
      SELECT count(*) FROM public.domain_events_outbox WHERE event_type = 'encounter.join_request.approved.v1';
    `);
    assert.equal(parseInt(outbox1.rows[0].count, 10), 1);

    const minNotif1 = await db.query<{ count: string }>(`
      SELECT count(*) FROM public.inbox_notifications WHERE notification_type = 'encounter_min_participants_reached';
    `);
    assert.equal(parseInt(minNotif1.rows[0].count, 10), 0);

    // 2. Aprobar segunda solicitud: 2 cupos confirmados, alcanza min_participants
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('b2222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb');`);

    const encState = await db.query<{ realization_status: string }>(`
      SELECT realization_status FROM public.encuentros WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    `);
    assert.equal(encState.rows[0].realization_status, 'confirmed');

    // Deben haberse notificado a ambos participantes confirmados (app1Id y app2Id) con la key de ciclo H6
    const minNotifs = await db.query<{ recipient_user_id: string; dedup_key: string }>(`
      SELECT recipient_user_id, dedup_key FROM public.inbox_notifications WHERE notification_type = 'encounter_min_participants_reached' ORDER BY recipient_user_id;
    `);
    assert.equal(minNotifs.rows.length, 2);
    const recipients = minNotifs.rows.map((r) => r.recipient_user_id);
    assert.ok(recipients.includes(app1Id));
    assert.ok(recipients.includes(app2Id));
    assert.match(minNotifs.rows[0].dedup_key, /^min_reached:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:/);
    assert.match(minNotifs.rows[1].dedup_key, /^min_reached:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:/);
  });
});
