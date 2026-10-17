/**
 * Test: Microfix Post-Integración H1–H10
 * 1. Reconfirmación y rotación de token en re-aprobación post-baja voluntaria.
 * 2. Endurecimiento de rate limiting (fail-closed, aislamiento de identidad auth.uid, delegación atómica).
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

  // 1. Extensiones y esquema base
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

    -- Tablas del dominio con columnas exactas de Staging
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
          read_at = NULL
      RETURNING id INTO v_id;
      RETURN v_id;
    END;
    $$;

    -- Tablas de Rate Limiting
    CREATE TABLE IF NOT EXISTS public.rate_limit_policies (
      action TEXT PRIMARY KEY,
      max_requests INTEGER NOT NULL CHECK (max_requests > 0),
      window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
      enabled BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
      action TEXT NOT NULL REFERENCES public.rate_limit_policies(action) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      scope_key TEXT NOT NULL DEFAULT '',
      window_start TIMESTAMPTZ NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (action, user_id, scope_key, window_start)
    );

    -- check_rate_limit_internal
    CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(
      p_action TEXT,
      p_scope_key TEXT DEFAULT ''
    )
    RETURNS JSONB
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = ''
    AS $$
    DECLARE
      v_user_id UUID := auth.uid();
      v_scope_key TEXT := COALESCE(p_scope_key, '');
      v_policy RECORD;
      v_window_start TIMESTAMPTZ;
      v_current_count INTEGER;
    BEGIN
      IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'authentication_required');
      END IF;

      IF p_action IS NULL OR pg_catalog.char_length(trim(p_action)) = 0 OR pg_catalog.char_length(v_scope_key) > 128 THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'invalid_parameters');
      END IF;

      SELECT max_requests, window_seconds, enabled
      INTO v_policy
      FROM public.rate_limit_policies
      WHERE action = p_action;

      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'rate_limit_policy_not_found');
      END IF;

      IF v_policy.enabled = false THEN
        RETURN pg_catalog.jsonb_build_object('allowed', true, 'disabled', true);
      END IF;

      v_window_start := pg_catalog.to_timestamp(
        pg_catalog.floor(extract(epoch from pg_catalog.now()) / v_policy.window_seconds) * v_policy.window_seconds
      );

      INSERT INTO public.rate_limit_buckets (
        action, user_id, scope_key, window_start, request_count, updated_at
      ) VALUES (
        p_action, v_user_id, v_scope_key, v_window_start, 1, pg_catalog.now()
      )
      ON CONFLICT (action, user_id, scope_key, window_start)
      DO UPDATE
      SET request_count = public.rate_limit_buckets.request_count + 1,
          updated_at = pg_catalog.now()
      WHERE public.rate_limit_buckets.request_count < v_policy.max_requests
      RETURNING request_count INTO v_current_count;

      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'rate_limit_exceeded');
      END IF;

      RETURN pg_catalog.jsonb_build_object('allowed', true);
    EXCEPTION WHEN OTHERS THEN
      RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'rate_limit_error');
    END;
    $$;

    -- Semilla inicial de políticas
    INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
    VALUES
      ('join_open_encounter', 12, 3600, true),
      ('qa_push_test', 10, 60, true)
    ON CONFLICT (action) DO NOTHING;
  `);

  // 2. Cargar funciones de desistir y solicitar desde migraciones
  const migH9H10 = fs.readFileSync(
    path.join(rootDir, 'supabase/migrations/20261016180000_open_encounter_withdrawal_and_sync_h9_h10.sql'),
    'utf8'
  );
  await db.exec(migH9H10);

  // 3. Aplicar la nueva migración aditiva y correctiva
  const newMigration = fs.readFileSync(
    path.join(rootDir, 'supabase/migrations/20261016220000_fix_reconfirmation_and_hardened_rate_limiting.sql'),
    'utf8'
  );
  await db.exec(newMigration);

  return db;
}

// Helper para setear contexto de usuario
async function setSession(db: PGlite, userId: string | null) {
  if (userId) {
    await db.exec(`
      SELECT set_config('request.jwt.claim.sub', '${userId}', false);
      SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "role": "authenticated"}', false);
    `);
  } else {
    await db.exec(`
      SELECT set_config('request.jwt.claim.sub', '', false);
      SELECT set_config('request.jwt.claims', '{}', false);
    `);
  }
}

test('Microfix Post-Integración: Reconfirmación y Rate Limiting Endurecido', async (t) => {
  const db = await createTestDb();

  // Crear usuarios de prueba
  const hostId = '11111111-1111-1111-1111-111111111111';
  const participantId = '22222222-2222-2222-2222-222222222222';
  const strangerId = '33333333-3333-3333-3333-333333333333';

  await db.exec(`
    INSERT INTO auth.users (id, email) VALUES
      ('${hostId}', 'host@test.com'),
      ('${participantId}', 'participant@test.com'),
      ('${strangerId}', 'stranger@test.com');
  `);

  // ============================================================================
  // PROBLEMA 1: CICLO COMPLETO DE RECONFIRMACIÓN POST-BAJA
  // ============================================================================
  await t.test('Problema 1: Ciclo completo de solicitud -> aprobación -> reconfirmación -> baja -> re-solicitud -> segunda aprobación', async () => {
    // 1. Crear encuentro abierto
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, open_public_title, estado, is_open, max_participants, min_participants)
      VALUES ('${hostId}', 'Encuentro Ciclo Reconf', 'Encuentro Ciclo Reconf', 'activo', true, 5, 2)
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // 2. Paso 1: Solicitud inicial (participant solicita 2 cupos)
    await setSession(db, participantId);
    const solRes1 = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado)
      VALUES ('${encId}', '${participantId}', 'Juan Perez', 2, 'pending')
      RETURNING id;
    `);
    const req1Id = solRes1.rows[0].id;

    // 3. Paso 2: Primera aprobación por el anfitrión
    await setSession(db, hostId);
    const app1Res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${req1Id}') AS aprobar_solicitud_encuentro_abierto;
    `);
    const app1Data = app1Res.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(app1Data.ok, true, 'Primera aprobación exitosa');
    const firstToken = app1Data.token_invitacion;
    const partRowId = app1Data.participante_id;
    assert.ok(firstToken, 'Debe emitir un token');

    // 4. Paso 3: Reconfirmación del participante ('confirm')
    await setSession(db, participantId);
    const reconfRes = await db.query<{ reconfirmar_asistencia_seguro: any }>(`
      SELECT public.reconfirmar_asistencia_seguro('${encId}', 'confirm', NULL) AS reconfirmar_asistencia_seguro;
    `);
    assert.equal(reconfRes.rows[0].reconfirmar_asistencia_seguro.ok, true);
    assert.equal(reconfRes.rows[0].reconfirmar_asistencia_seguro.reconfirmation_status, 'confirmed');

    // Verificar en BD que el participante quedó confirmed con timestamp
    const partCheck1 = await db.query<{ reconfirmation_status: string; reconfirmed_at: string; estado: string }>(`
      SELECT reconfirmation_status, reconfirmed_at, estado FROM public.participantes WHERE id = '${partRowId}';
    `);
    assert.equal(partCheck1.rows[0].reconfirmation_status, 'confirmed');
    assert.ok(partCheck1.rows[0].reconfirmed_at !== null, 'reconfirmed_at debe tener timestamp');

    // 5. Paso 4: Baja voluntaria con motivo privado ('decline')
    const declineRes = await db.query<{ desistir_encuentro_abierto_seguro: any }>(`
      SELECT public.desistir_encuentro_abierto_seguro('${encId}', 'Surgió un viaje imprevisto') AS desistir_encuentro_abierto_seguro;
    `);
    assert.equal(declineRes.rows[0].desistir_encuentro_abierto_seguro.ok, true);
    assert.equal(declineRes.rows[0].desistir_encuentro_abierto_seguro.reconfirmation_status, 'declined');

    // Verificar que en public.participantes quedó 'cancelado' y 'declined'
    const partCheckDecline = await db.query<{ reconfirmation_status: string; estado: string }>(`
      SELECT reconfirmation_status, estado FROM public.participantes WHERE id = '${partRowId}';
    `);
    assert.equal(partCheckDecline.rows[0].estado, 'cancelado');
    assert.equal(partCheckDecline.rows[0].reconfirmation_status, 'declined');

    // Verificar que la solicitud 1 guardó motivo_baja y estado 'cancelled'
    const req1Check = await db.query<{ estado: string; motivo_baja: string }>(`
      SELECT estado, motivo_baja FROM public.solicitudes_encuentro_abierto WHERE id = '${req1Id}';
    `);
    assert.equal(req1Check.rows[0].estado, 'cancelled');
    assert.equal(req1Check.rows[0].motivo_baja, 'Surgió un viaje imprevisto');

    // 6. Paso 5: Nueva solicitud (re-postulación con 3 cupos)
    const solRes2 = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado)
      VALUES ('${encId}', '${participantId}', 'Juan Perez Re', 3, 'pending')
      RETURNING id;
    `);
    const req2Id = solRes2.rows[0].id;

    // 7. Paso 6: Segunda aprobación por el anfitrión
    await setSession(db, hostId);
    const app2Res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${req2Id}') AS aprobar_solicitud_encuentro_abierto;
    `);
    const app2Data = app2Res.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(app2Data.ok, true, 'Segunda aprobación exitosa');
    const secondToken = app2Data.token_invitacion;

    // 8. Paso 7 & 8: Verificación estricta de reconfirmation_status = 'pending' y reconfirmed_at IS NULL
    const partCheck2 = await db.query<{
      estado: string;
      reconfirmation_status: string;
      reconfirmed_at: string | null;
      seat_count: number;
      token_invitacion: string;
    }>(`
      SELECT estado, reconfirmation_status, reconfirmed_at, seat_count, token_invitacion
      FROM public.participantes
      WHERE id = '${partRowId}';
    `);

    assert.equal(partCheck2.rows[0].estado, 'confirmado', 'Estado debe ser confirmado');
    assert.equal(partCheck2.rows[0].reconfirmation_status, 'pending', 'reconfirmation_status DEBE reiniciarse a pending');
    assert.equal(partCheck2.rows[0].reconfirmed_at, null, 'reconfirmed_at DEBE ser NULL');
    assert.equal(partCheck2.rows[0].seat_count, 3, 'seat_count sincronizado con nueva solicitud (3 cupos)');

    // 9. Paso 9: Verificación de token rotado
    assert.notEqual(secondToken, firstToken, 'El token de participación DEBE haberse rotado para invalidar el ciclo anterior');
    assert.equal(partCheck2.rows[0].token_invitacion, secondToken, 'El token en tabla participantes debe coincidir con el nuevo token');

    // 10. Paso 10: Verificación de historial de solicitud anterior intacto
    const req1CheckAfter = await db.query<{ estado: string; motivo_baja: string }>(`
      SELECT estado, motivo_baja FROM public.solicitudes_encuentro_abierto WHERE id = '${req1Id}';
    `);
    assert.equal(req1CheckAfter.rows[0].estado, 'cancelled', 'Historial anterior no debe alterarse');
    assert.equal(req1CheckAfter.rows[0].motivo_baja, 'Surgió un viaje imprevisto', 'Motivo de baja del ciclo previo debe preservarse intacto');

    // 11. Idempotencia de la segunda aprobación: volver a aprobar req2 devuelve éxito y NO regenera token ni altera reconfirmation_status
    const app2Idemp = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${req2Id}') AS aprobar_solicitud_encuentro_abierto;
    `);
    assert.equal(app2Idemp.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);
    assert.equal(app2Idemp.rows[0].aprobar_solicitud_encuentro_abierto.already_approved, true);
    assert.equal(app2Idemp.rows[0].aprobar_solicitud_encuentro_abierto.token_invitacion, secondToken);
  });

  // ============================================================================
  // PROBLEMA 2: ENDURECIMIENTO DE RATE LIMITING
  // ============================================================================
  await t.test('Problema 2: Rate Limiting fail-closed, aislamiento de identidad y delegación atómica', async () => {
    // 1. Usuario válido dentro del límite: consume normalmente
    await setSession(db, participantId);
    const rlSuccess = await db.query<{ verificar_y_consumir_rate_limit: any }>(`
      SELECT public.verificar_y_consumir_rate_limit('${participantId}', 'join_request', 12, interval '1 hour')
      AS verificar_y_consumir_rate_limit;
    `);
    assert.equal(rlSuccess.rows[0].verificar_y_consumir_rate_limit.allowed, true);

    // 2. Usuario no autenticado (auth.uid() IS NULL) -> Fail-closed
    await setSession(db, null);
    const rlNoAuth = await db.query<{ verificar_y_consumir_rate_limit: any }>(`
      SELECT public.verificar_y_consumir_rate_limit('${participantId}', 'join_request')
      AS verificar_y_consumir_rate_limit;
    `);
    assert.equal(rlNoAuth.rows[0].verificar_y_consumir_rate_limit.allowed, false);
    assert.equal(rlNoAuth.rows[0].verificar_y_consumir_rate_limit.error, 'authentication_required');

    // 3. Suplantación de identidad (p_user_id distinto de auth.uid()) -> Fail-closed
    await setSession(db, participantId); // autenticado como participantId
    const rlMismatch = await db.query<{ verificar_y_consumir_rate_limit: any }>(`
      SELECT public.verificar_y_consumir_rate_limit('${strangerId}', 'join_request')
      AS verificar_y_consumir_rate_limit;
    `);
    assert.equal(rlMismatch.rows[0].verificar_y_consumir_rate_limit.allowed, false);
    assert.equal(rlMismatch.rows[0].verificar_y_consumir_rate_limit.error, 'user_identity_mismatch');

    // 4. Política inexistente -> Fail-closed (NUNCA allowed: true)
    const rlNotFound = await db.query<{ verificar_y_consumir_rate_limit: any }>(`
      SELECT public.verificar_y_consumir_rate_limit('${participantId}', 'accion_inexistente_total')
      AS verificar_y_consumir_rate_limit;
    `);
    assert.equal(rlNotFound.rows[0].verificar_y_consumir_rate_limit.allowed, false);
    assert.equal(rlNotFound.rows[0].verificar_y_consumir_rate_limit.error, 'rate_limit_policy_not_found');

    // 5. Parámetros inválidos (p_max <= 0 o p_window <= 0) -> Fail-closed
    const rlInvalidMax = await db.query<{ verificar_y_consumir_rate_limit: any }>(`
      SELECT public.verificar_y_consumir_rate_limit('${participantId}', 'join_request', -1, interval '1 hour')
      AS verificar_y_consumir_rate_limit;
    `);
    assert.equal(rlInvalidMax.rows[0].verificar_y_consumir_rate_limit.allowed, false);
    assert.equal(rlInvalidMax.rows[0].verificar_y_consumir_rate_limit.error, 'invalid_parameters');

    // 6. Política duradera de join_open_encounter (12 por hora): consumir hasta agotar
    // Ya consumió 1 vez en el paso 1. Consumimos 11 veces más:
    for (let i = 2; i <= 12; i++) {
      const res = await db.query<{ verificar_y_consumir_rate_limit: any }>(`
        SELECT public.verificar_y_consumir_rate_limit('${participantId}', 'join_open_encounter')
        AS verificar_y_consumir_rate_limit;
      `);
      assert.equal(res.rows[0].verificar_y_consumir_rate_limit.allowed, true, `Petición ${i} debe estar permitida`);
    }

    // Petición número 13 debe ser rechazada con rate_limit_exceeded:
    const rlExceeded = await db.query<{ verificar_y_consumir_rate_limit: any }>(`
      SELECT public.verificar_y_consumir_rate_limit('${participantId}', 'join_open_encounter')
      AS verificar_y_consumir_rate_limit;
    `);
    assert.equal(rlExceeded.rows[0].verificar_y_consumir_rate_limit.allowed, false);
    assert.equal(rlExceeded.rows[0].verificar_y_consumir_rate_limit.error, 'rate_limit_exceeded');

    // 7. Otro usuario (strangerId) tiene su propio bucket independiente y puede consumir
    await setSession(db, strangerId);
    const rlStranger = await db.query<{ verificar_y_consumir_rate_limit: any }>(`
      SELECT public.verificar_y_consumir_rate_limit('${strangerId}', 'join_open_encounter')
      AS verificar_y_consumir_rate_limit;
    `);
    assert.equal(rlStranger.rows[0].verificar_y_consumir_rate_limit.allowed, true, 'Otro usuario no se ve afectado por el bucket agotado');
  });
});
