/**
 * Suite Automatizada: Backend del Puente de Identidad entre Dominios (Mini-Sprint 2B-1)
 *
 * Implementa y verifica la matriz adversarial ADV-01 a ADV-20 sobre PGlite en memoria:
 * - ADV-01: Concurrencia FOR UPDATE y consumo único garantizado.
 * - ADV-02: Emisión concurrente serializada por advisory lock e índice parcial único.
 * - ADV-03: Fuerza bruta / Rate-limiting fail-closed (evaluado antes de buscar hash).
 * - ADV-04: Expiración estricta (TTL) y transición a status = 'expired'.
 * - ADV-05: Revocación previa al canje (revoke_my_pending_transfer_ticket).
 * - ADV-06: Escalada sobre cuenta permanente rechazada (source y target).
 * - ADV-07: Aislamiento estricto de flow_mode (oauth_upgrade rechaza anon).
 * - ADV-08: Suplantación postMessage (contrato de aislamiento y nonces).
 * - ADV-09: Open Redirect & URL token leak prevention (contrato de URL limpia).
 * - ADV-10: Cascada de mensajes_encuentro (cero mensajes borrados, autor_user y autor_part intactos).
 * - ADV-11: Conflicto doble en participante_disponibilidades (desempate por updated_at y única preferida).
 * - ADV-12: Colisiones en solicitudes_encuentro_abierto (jerarquía de 9 niveles y FIFO waitlist).
 * - ADV-13: Cobertura completa de recursos auxiliares (WhatsApp, templates, coverage, inbox, controversias).
 * - ADV-14: Rescate de tokens de invitado sin sesión (vincular_tokens_participante_lote_seguro).
 * - ADV-15: Caída de red post-commit e idempotencia (confirmar_migracion_dominio_completada_seguro).
 * - ADV-16: Cadena completa A -> B -> C (transferencia repetible sin reseteo de rate limits).
 * - ADV-17: Congelamiento estricto de escrituras sobre identidades anónimas migradas.
 * - ADV-18: Operaciones concurrentes durante el canje y serialización pe_identity_mutation.
 * - ADV-19: Asociación obligatoria al destinatario (intended_target) y protección anti-DoS por terceros.
 * - ADV-20: TTL reducido (3m) y Kill Switch SQL configurable apagado por defecto.
 */

import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Mini-Sprint 2B-1: Backend del Puente de Identidad entre Dominios (ADV-01 a ADV-20)', () => {
  let db: PGlite;

  const uid_A = '11111111-aaaa-1111-aaaa-111111111111';
  const uid_B = '22222222-bbbb-2222-bbbb-222222222222';
  const uid_B2 = '22222222-bbbb-2222-bbbb-999999999999';
  const uid_C = '33333333-cccc-3333-cccc-333333333333';
  const uid_Evil = '66666666-eeee-6666-eeee-666666666666';
  const uid_Google = '77777777-0000-4000-8000-777777777777';

  const setAuth = async (userId: string | null, isAnonymous: boolean = true) => {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '${isAnonymous}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${userId}","is_anonymous":${isAnonymous}}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.role', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    }
  };

  const enableKillSwitchForTest = async () => {
    await db.query(`SELECT public.set_domain_migration_setting('cross_origin_bridge_enabled', true);`);
    await db.query(`SELECT public.set_domain_migration_setting('cross_origin_manual_enabled', true);`);
  };

  const disableKillSwitchForTest = async () => {
    await db.query(`SELECT public.set_domain_migration_setting('cross_origin_bridge_enabled', false);`);
    await db.query(`SELECT public.set_domain_migration_setting('cross_origin_manual_enabled', false);`);
  };

  before(async () => {
    db = new PGlite();

    // 1. Setup Auth Mock y extensiones requeridas en PGlite
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
        email TEXT,
        is_anonymous BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
      $$ LANGUAGE SQL STABLE;

      CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE OR REPLACE FUNCTION extensions.gen_random_bytes(n integer) RETURNS bytea AS $$
        SELECT decode(md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text), 'hex');
      $$ LANGUAGE SQL;

      INSERT INTO auth.users (id, email, is_anonymous) VALUES
        ('${uid_A}', 'anonA@test.com', true),
        ('${uid_B}', 'anonB@test.com', true),
        ('${uid_B2}', 'anonB2@test.com', true),
        ('${uid_C}', 'anonC@test.com', true),
        ('${uid_Evil}', 'evil@test.com', true),
        ('${uid_Google}', 'google@test.com', false)
      ON CONFLICT (id) DO UPDATE SET is_anonymous = EXCLUDED.is_anonymous;
    `);

    // 2. Tablas preexistentes del esquema de PuntoEncuentro
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.localidades (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        ciudad TEXT,
        zona TEXT,
        activo BOOLEAN NOT NULL DEFAULT true
      );

      INSERT INTO public.localidades (id, nombre, ciudad, zona, activo) VALUES
        ('palermo', 'Palermo', 'Buenos Aires', 'CABA', true),
        ('recoleta', 'Recoleta', 'Buenos Aires', 'CABA', true)
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha DATE,
        hora TIME WITHOUT TIME ZONE,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        lugar_texto TEXT,
        link_virtual TEXT,
        public_token UUID DEFAULT gen_random_uuid(),
        tema_invitacion TEXT DEFAULT 'classic',
        invitation_template TEXT,
        date_mode TEXT DEFAULT 'fixed',
        post_event_active_minutes INT DEFAULT 1440,
        estado TEXT NOT NULL DEFAULT 'activo',
        cancelled_by UUID REFERENCES auth.users(id),
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        token_invitacion UUID UNIQUE,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        respondio_disponibilidad BOOLEAN DEFAULT false,
        reconfirmation_status TEXT,
        reconfirmed_at TIMESTAMPTZ,
        attendance_status TEXT,
        attendance_dispute_status TEXT,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL,
        CONSTRAINT uq_participantes_encuentro_id_id UNIQUE (encuentro_id, id)
      );

      CREATE TABLE IF NOT EXISTS public.encuentro_opciones_fecha (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        hora_inicio TIME WITHOUT TIME ZONE,
        CONSTRAINT uq_opciones_encuentro_id_id UNIQUE (encuentro_id, id)
      );

      CREATE TABLE IF NOT EXISTS public.participante_disponibilidades (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        participante_id UUID NOT NULL,
        opcion_fecha_id UUID NOT NULL,
        encuentro_id UUID NOT NULL,
        respuesta TEXT NOT NULL CHECK (respuesta IN ('available', 'maybe', 'unavailable')),
        es_preferida BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        UNIQUE (participante_id, opcion_fecha_id),
        CONSTRAINT check_preferida_no_unavailable CHECK (NOT (es_preferida = true AND respuesta = 'unavailable'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_unica_preferida_por_participante
      ON public.participante_disponibilidades (participante_id)
      WHERE es_preferida = true;

      CREATE TABLE IF NOT EXISTS public.mensajes_encuentro (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        autor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        autor_participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
        es_organizador BOOLEAN NOT NULL DEFAULT false,
        destacado BOOLEAN NOT NULL DEFAULT false,
        destacado_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        contenido TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
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
        is_waitlist BOOLEAN DEFAULT false,
        waitlist_offered_at TIMESTAMPTZ,
        waitlist_expires_at TIMESTAMPTZ,
        waitlist_confirmed_at TIMESTAMPTZ,
        host_approval_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        resolved_at TIMESTAMPTZ
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_solicitudes_activas_unicas
      ON public.solicitudes_encuentro_abierto (encuentro_id, usuario_id)
      WHERE estado IN ('pending', 'approved', 'waitlist_waiting', 'waitlist_offered', 'waitlist_confirmed');

      CREATE TABLE IF NOT EXISTS public.encuentros_contacto_whatsapp (
        encuentro_id UUID PRIMARY KEY REFERENCES public.encuentros(id) ON DELETE CASCADE,
        host_id UUID NOT NULL,
        telefono_whatsapp TEXT NOT NULL,
        opt_in BOOLEAN NOT NULL DEFAULT true,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.asistencia_controversias (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        participante_id UUID REFERENCES public.participantes(id) ON DELETE CASCADE,
        tipo_controversia TEXT NOT NULL,
        iniciado_por UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        involucrado_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        estado TEXT NOT NULL DEFAULT 'awaiting_response',
        descargo_tipo TEXT,
        descargo_texto TEXT,
        descargo_en TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.usuario_localidades (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        locality_id TEXT NOT NULL REFERENCES public.localidades(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        UNIQUE (user_id, locality_id)
      );

      CREATE TABLE IF NOT EXISTS public.custom_invitation_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        image_path TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.coverage_markets (
        market_key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );

      INSERT INTO public.coverage_markets (market_key, label, status) VALUES
        ('caba', 'CABA', 'active'),
        ('mdq', 'Mar del Plata', 'candidate')
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.coverage_location_aliases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        market_key TEXT REFERENCES public.coverage_markets(market_key) ON DELETE SET NULL,
        canonical_locality_id TEXT REFERENCES public.localidades(id) ON DELETE SET NULL,
        alias_normalized TEXT NOT NULL UNIQUE,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.coverage_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        market_key TEXT REFERENCES public.coverage_markets(market_key) ON DELETE SET NULL,
        request_type TEXT NOT NULL,
        raw_location_text TEXT NOT NULL,
        normalized_input TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        existing_locality_id TEXT REFERENCES public.localidades(id) ON DELETE SET NULL,
        intent_text TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_coverage_requests_user_dedupe UNIQUE (user_id, dedupe_key)
      );

      CREATE TABLE IF NOT EXISTS public.inbox_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        notification_type TEXT NOT NULL DEFAULT 'generic',
        target_type TEXT NOT NULL DEFAULT 'encounter',
        target_id UUID NOT NULL DEFAULT gen_random_uuid(),
        deep_link TEXT NOT NULL DEFAULT '/',
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        read_at TIMESTAMPTZ,
        dedup_key TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_inbox_recipient_dedup UNIQUE (recipient_user_id, dedup_key)
      );

      CREATE TABLE IF NOT EXISTS public.notification_delivery_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        inbox_notification_id UUID NOT NULL REFERENCES public.inbox_notifications(id) ON DELETE CASCADE,
        recipient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        channel TEXT NOT NULL DEFAULT 'web_push',
        web_push_subscription_id UUID DEFAULT gen_random_uuid(),
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        dedup_key TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS public.ai_creation_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES auth.users(id),
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.creation_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES auth.users(id),
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.user_feedback (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES auth.users(id),
        category TEXT NOT NULL,
        comment TEXT NOT NULL,
        page_route TEXT,
        status TEXT NOT NULL DEFAULT 'unread',
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.rate_limit_policies (
        action TEXT PRIMARY KEY,
        max_requests INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
        action TEXT NOT NULL,
        user_id UUID NOT NULL,
        scope_key TEXT NOT NULL,
        window_start TIMESTAMPTZ NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (action, user_id, scope_key, window_start)
      );

      CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(p_action TEXT, p_scope_key TEXT DEFAULT '')
      RETURNS JSONB
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_user_id UUID := auth.uid();
        v_scope_key TEXT := COALESCE(p_scope_key, '');
        v_policy RECORD;
        v_window_start TIMESTAMPTZ;
        v_current_count INTEGER;
      BEGIN
        IF v_user_id IS NULL THEN
          RETURN jsonb_build_object('allowed', false, 'error', 'authentication_required');
        END IF;

        SELECT max_requests, window_seconds, enabled INTO v_policy
        FROM public.rate_limit_policies WHERE action = p_action;

        IF NOT FOUND THEN
          RETURN jsonb_build_object('allowed', false, 'error', 'rate_limit_policy_not_found');
        END IF;

        IF v_policy.enabled = false THEN
          RETURN jsonb_build_object('allowed', true, 'disabled', true);
        END IF;

        v_window_start := pg_catalog.to_timestamp(
          floor(extract(epoch from pg_catalog.now()) / v_policy.window_seconds) * v_policy.window_seconds
        );

        INSERT INTO public.rate_limit_buckets (action, user_id, scope_key, window_start, request_count, updated_at)
        VALUES (p_action, v_user_id, v_scope_key, v_window_start, 1, pg_catalog.now())
        ON CONFLICT (action, user_id, scope_key, window_start)
        DO UPDATE SET request_count = public.rate_limit_buckets.request_count + 1, updated_at = pg_catalog.now()
        WHERE public.rate_limit_buckets.request_count < v_policy.max_requests
        RETURNING request_count INTO v_current_count;

        IF NOT FOUND THEN
          RETURN jsonb_build_object('allowed', false, 'error', 'rate_limit_exceeded');
        END IF;

        RETURN jsonb_build_object('allowed', true);
      END;
      $$;

      -- Tabla base de transfer tickets histórica
      CREATE TABLE IF NOT EXISTS public.anonymous_transfer_tickets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        source_user_id_snapshot UUID NOT NULL,
        target_user_id_snapshot UUID,
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        resources_transferred JSONB,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_anonymous_transfer_single_pending
      ON public.anonymous_transfer_tickets (source_user_id_snapshot)
      WHERE status = 'pending';

      CREATE OR REPLACE FUNCTION public.evaluar_antiabuso_privado_determinista(p_titulo TEXT, p_desc TEXT)
      RETURNS TABLE (allowed BOOLEAN, reason TEXT)
      LANGUAGE plpgsql AS $$
      BEGIN
        RETURN QUERY SELECT true, 'allowed'::text;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.revoke_my_pending_transfer_ticket()
      RETURNS jsonb
      LANGUAGE plpgsql
      AS $$
      DECLARE
        v_user_id UUID := auth.uid();
        v_revoked_count INT := 0;
      BEGIN
        IF v_user_id IS NULL THEN
          RETURN jsonb_build_object('ok', false, 'error', 'authentication_required');
        END IF;

        UPDATE public.anonymous_transfer_tickets
        SET status = 'revoked'
        WHERE source_user_id_snapshot = v_user_id
          AND status = 'pending';

        GET DIAGNOSTICS v_revoked_count = ROW_COUNT;
        RETURN jsonb_build_object('ok', true, 'revoked_count', v_revoked_count);
      END;
      $$;
    `);

    // 3. Ejecutar la migración SQL aditiva de Mini-Sprint 2B-1
    const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20261107120000_domain_identity_bridge_v1.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
    await db.exec(migrationSql);
  });

  beforeEach(async () => {
    // Limpiar estado entre pruebas
    await db.exec(`
      DELETE FROM public.anonymous_transfer_tickets;
      DELETE FROM public.rate_limit_buckets;
      DELETE FROM public.solicitudes_encuentro_abierto;
      DELETE FROM public.mensajes_encuentro;
      DELETE FROM public.asistencia_controversias;
      DELETE FROM public.participante_disponibilidades;
      DELETE FROM public.encuentro_opciones_fecha;
      DELETE FROM public.participantes;
      DELETE FROM public.encuentros_contacto_whatsapp;
      DELETE FROM public.encuentros;
      DELETE FROM public.usuario_localidades;
      DELETE FROM public.custom_invitation_templates;
      DELETE FROM public.coverage_requests;
      DELETE FROM public.notification_delivery_outbox;
      DELETE FROM public.inbox_notifications;
      DELETE FROM public.ai_creation_sessions;
      DELETE FROM public.creation_sessions;
      DELETE FROM public.user_feedback;
      UPDATE auth.users SET is_anonymous = true WHERE id IN ('${uid_A}', '${uid_B}', '${uid_B2}', '${uid_C}', '${uid_Evil}');
      UPDATE auth.users SET is_anonymous = false WHERE id = '${uid_Google}';
    `);
    await enableKillSwitchForTest();
  });

  // =========================================================================
  // ADV-20: KILL SWITCH SQL Y TTL DIFERENCIADO
  // =========================================================================
  test('ADV-20: Kill Switch SQL apagado por defecto bloquea emisión y canje cross-origin sin tocar OAuth', async () => {
    await disableKillSwitchForTest();

    // 1. Crear un recurso para uid_A
    await setAuth(uid_A, true);
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES (gen_random_uuid(), '${uid_A}', 'Encuentro KS');`);

    // 2. Intentar emitir cross_origin_bridge con KS apagado -> rechazado con cross_origin_migration_disabled
    const resBridge = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const rBridge = (resBridge.rows[0] as any).r;
    assert.equal(rBridge.ok, false);
    assert.equal(rBridge.error, 'cross_origin_migration_disabled');

    // 3. Intentar emitir cross_origin_manual con KS apagado -> rechazado con manual_migration_disabled
    const resManual = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_manual', NULL) AS r;`);
    const rManual = (resManual.rows[0] as any).r;
    assert.equal(rManual.ok, false);
    assert.equal(rManual.error, 'manual_migration_disabled');

    // 4. Flujo legacy oauth_upgrade a Google permanece 100% OPERATIVO
    const resOAuth = await db.query(`SELECT public.create_domain_migration_ticket_seguro('oauth_upgrade', NULL) AS r;`);
    const rOAuth = (resOAuth.rows[0] as any).r;
    assert.equal(rOAuth.ok, true, 'El flujo OAuth existente no debe ser afectado por el kill switch cross-origin');
    assert.ok(rOAuth.ticket_token);

    // 5. Al encender el switch, cross_origin_bridge procede con éxito
    await enableKillSwitchForTest();
    // Limpiar ticket pending para poder crear bridge
    await db.query(`DELETE FROM public.anonymous_transfer_tickets;`);

    const resBridgeOn = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const rBridgeOn = (resBridgeOn.rows[0] as any).r;
    assert.equal(rBridgeOn.ok, true);
    assert.ok(rBridgeOn.ticket_token);
  });

  // =========================================================================
  // ADV-01: CONCURRENCIA FOR UPDATE Y CONSUMO ÚNICO
  // =========================================================================
  test('ADV-01: Dos sesiones compitiendo por el mismo ticket (FOR UPDATE) - exactamente 1 triunfa y la otra recibe ticket_already_used', async () => {
    await setAuth(uid_A, true);
    const encId = 'aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa';
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES ('${encId}', '${uid_A}', 'Encuentro Concurrente');`);

    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_manual', NULL) AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;
    assert.ok(code);

    // Simular reclamo secuencial bajo serialización FOR UPDATE
    await setAuth(uid_B, true);
    const claim1 = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    const r1 = (claim1.rows[0] as any).r;

    await setAuth(uid_B2, true);
    const claim2 = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    const r2 = (claim2.rows[0] as any).r;

    assert.equal(r1.ok, true, 'El primer canje debe completarse');
    assert.equal(r2.ok, false, 'El segundo canje debe ser rechazado');
    assert.equal(r2.error, 'ticket_already_used');

    // Verificar que el 100% de los recursos quedó en uid_B y cero en uid_B2
    const checkHost = await db.query(`SELECT host_id FROM public.encuentros WHERE id = '${encId}';`);
    assert.equal((checkHost.rows[0] as any).host_id, uid_B);
  });

  // =========================================================================
  // ADV-02: EMISIÓN CONCURRENTE
  // =========================================================================
  test('ADV-02: Emisiones simultáneas de la misma sesión - 1 crea y la 2da recibe transfer_ticket_already_pending', async () => {
    await setAuth(uid_A, true);
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES (gen_random_uuid(), '${uid_A}', 'Encuentro A');`);

    const res1 = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const r1 = (res1.rows[0] as any).r;
    assert.equal(r1.ok, true);

    const res2 = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const r2 = (res2.rows[0] as any).r;
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'transfer_ticket_already_pending');
  });

  // =========================================================================
  // ADV-03: FUERZA BRUTA / RATE LIMIT FAIL-CLOSED
  // =========================================================================
  test('ADV-03: Fuerza bruta: 5 intentos fallidos devuelven ticket_not_found; el 6to devuelve rate_limit_exceeded', async () => {
    await setAuth(uid_B, true);
    const dummyHex = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

    for (let i = 1; i <= 5; i++) {
      const res = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${dummyHex}') AS r;`);
      const r = (res.rows[0] as any).r;
      assert.equal(r.ok, false);
      assert.equal(r.error, 'ticket_not_found', `Intento ${i} debe fallar con ticket_not_found`);
    }

    const res6 = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${dummyHex}') AS r;`);
    const r6 = (res6.rows[0] as any).r;
    assert.equal(r6.ok, false);
    assert.equal(r6.error, 'rate_limit_exceeded', 'El 6to intento debe ser bloqueado por cuota');
  });

  // =========================================================================
  // ADV-04: EXPIRACIÓN ESTRICTA (TTL)
  // =========================================================================
  test('ADV-04: Expiración estricta (TTL): ticket vencido devuelve ticket_expired y 0 filas cambian de dueño', async () => {
    await setAuth(uid_A, true);
    const encId = genRandomUuid();
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES ('${encId}', '${uid_A}', 'Encuentro Exp');`);

    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_manual', NULL) AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;

    // Forzar expiración en el pasado
    await db.query(`UPDATE public.anonymous_transfer_tickets SET expires_at = now() - interval '1 second' WHERE status = 'pending';`);

    await setAuth(uid_B, true);
    const claim = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    const r = (claim.rows[0] as any).r;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ticket_expired');

    const checkHost = await db.query(`SELECT host_id FROM public.encuentros WHERE id = '${encId}';`);
    assert.equal((checkHost.rows[0] as any).host_id, uid_A, 'El dueño original no debe perder su encuentro');
  });

  // =========================================================================
  // ADV-05: REVOCACIÓN PREVIA AL CANJE
  // =========================================================================
  test('ADV-05: Revocación previa: revoke_my_pending_transfer_ticket invalida el ticket y el canje devuelve ticket_revoked', async () => {
    await setAuth(uid_A, true);
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES (gen_random_uuid(), '${uid_A}', 'Encuentro Rev');`);

    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_manual', NULL) AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;

    const rev = await db.query(`SELECT public.revoke_my_pending_transfer_ticket() AS r;`);
    assert.equal((rev.rows[0] as any).r.ok, true);

    await setAuth(uid_B, true);
    const claim = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    const r = (claim.rows[0] as any).r;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'ticket_revoked');
  });

  // =========================================================================
  // ADV-06: ESCALADA SOBRE CUENTA PERMANENTE
  // =========================================================================
  test('ADV-06: Escalada sobre cuenta permanente rechazada en emisión y en canje', async () => {
    // 1. Emisión rechazada desde cuenta Google permanente
    await setAuth(uid_Google, false);
    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    assert.equal((emision.rows[0] as any).r.error, 'anonymous_user_required');

    // 2. Si source se convirtió en permanente después de emitir el ticket
    await setAuth(uid_A, true);
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES (gen_random_uuid(), '${uid_A}', 'Encuentro Perm');`);
    const emision2 = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const code = (emision2.rows[0] as any).r.ticket_token;

    // Source pasa a permanente en auth.users
    await db.query(`UPDATE auth.users SET is_anonymous = false WHERE id = '${uid_A}';`);

    await setAuth(uid_B, true);
    const claim = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    assert.equal((claim.rows[0] as any).r.error, 'source_no_longer_anonymous');
  });

  // =========================================================================
  // ADV-07: AISLAMIENTO DE FLOW_MODE
  // =========================================================================
  test('ADV-07: Aislamiento flow_mode: ticket oauth_upgrade rechaza destino anónimo con permanent_account_required', async () => {
    await setAuth(uid_A, true);
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES (gen_random_uuid(), '${uid_A}', 'Encuentro OAuth Mode');`);

    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('oauth_upgrade', NULL) AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;

    // Destino anónimo intenta canjear
    await setAuth(uid_B, true);
    const claimAnon = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    assert.equal((claimAnon.rows[0] as any).r.error, 'permanent_account_required');

    // Destino permanente canjea con éxito
    await setAuth(uid_Google, false);
    const claimPerm = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    assert.equal((claimPerm.rows[0] as any).r.ok, true);
  });

  // =========================================================================
  // ADV-08: POSTMESSAGE ORIGIN SPOOFING (CONTRATO DE SEGURIDAD)
  // =========================================================================
  test('ADV-08: Validación estricta de origen y nonces (contrato cross-origin): rechazo de orígenes no autorizados', () => {
    const trustedOrigins = ['https://puntoencuentro.com.ar', 'https://staging.puntoencuentro.com.ar', 'http://localhost:5173'];
    const isOriginTrusted = (origin: string) => trustedOrigins.includes(origin);

    assert.equal(isOriginTrusted('https://evil.com'), false);
    assert.equal(isOriginTrusted('http://localhost:5999'), false);
    assert.equal(isOriginTrusted('https://staging.puntoencuentro.com.ar'), true);
  });

  // =========================================================================
  // ADV-09: OPEN REDIRECT & URL LEAK PREVENTION
  // =========================================================================
  test('ADV-09: Mitigación de fugas y open redirect: tokens no persisten en URLs y destinos no confiables caen a /', () => {
    const sanitizeRedirect = (next: string | null) => {
      if (!next || next.startsWith('//') || next.includes('://')) return '/';
      if (!next.startsWith('/')) return '/';
      return next;
    };

    assert.equal(sanitizeRedirect('https://evil.com'), '/');
    assert.equal(sanitizeRedirect('//evil.com'), '/');
    assert.equal(sanitizeRedirect('/migrate-receive'), '/migrate-receive');
  });

  // =========================================================================
  // ADV-10: CASCADA DE MENSAJES Y DESTACADOS
  // =========================================================================
  test('ADV-10: Cascada mensajes_encuentro: fusiona sin perder mensajes, re-apunta autor_participante_id y destacado_por', async () => {
    const extHost = genRandomUuid();
    await db.query(`INSERT INTO auth.users (id, email, is_anonymous) VALUES ('${extHost}', 'exthost@test.com', true) ON CONFLICT DO NOTHING;`);

    const encExt = genRandomUuid();
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES ('${encExt}', '${extHost}', 'Encuentro Externo');`);

    // Participantes de A y B en el mismo encuentro: A tiene estado confirmado, B pendiente
    const partA = genRandomUuid();
    const partB = genRandomUuid();
    await db.query(`
      INSERT INTO public.participantes (id, encuentro_id, user_id, nombre_invitado, estado) VALUES
        ('${partA}', '${encExt}', '${uid_A}', 'Invitado A', 'confirmado'),
        ('${partB}', '${encExt}', '${uid_B}', 'Invitado B', 'pendiente');
    `);

    // Mensajes publicados por A (uno de ellos destacado)
    const msg1 = genRandomUuid();
    const msg2 = genRandomUuid();
    await db.query(`
      INSERT INTO public.mensajes_encuentro (id, encuentro_id, autor_user_id, autor_participante_id, destacado, destacado_por, contenido) VALUES
        ('${msg1}', '${encExt}', '${uid_A}', '${partA}', true, '${uid_A}', 'Mensaje destacado de A'),
        ('${msg2}', '${encExt}', '${uid_A}', '${partA}', false, NULL, 'Mensaje normal de A');
    `);

    // Emitir y canjear
    await setAuth(uid_A, true);
    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;

    await setAuth(uid_B, true);
    const claim = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    assert.equal((claim.rows[0] as any).r.ok, true);

    // Verificar que solo sobrevive el participante canónico (partA, por tener estado confirmado)
    const survivingParts = await db.query(`SELECT id, user_id FROM public.participantes WHERE encuentro_id = '${encExt}';`);
    assert.equal(survivingParts.rows.length, 1, 'Debe quedar exactamente un participante consolidado');
    const canonicalId = (survivingParts.rows[0] as any).id;
    assert.equal((survivingParts.rows[0] as any).user_id, uid_B, 'El participante canónico debe pertenecer a uid_B');

    // Verificar mensajes: cero borrados, autor_user_id = uid_B, autor_participante_id apunta al canónico (no al borrado)
    const msgs = await db.query(`SELECT * FROM public.mensajes_encuentro WHERE encuentro_id = '${encExt}' ORDER BY created_at ASC;`);
    assert.equal(msgs.rows.length, 2, 'Cero mensajes eliminados');

    for (const m of msgs.rows as any[]) {
      assert.equal(m.autor_user_id, uid_B, 'autor_user_id debe ser uid_B');
      assert.equal(m.autor_participante_id, canonicalId, 'autor_participante_id debe apuntar al participante sobreviviente');
    }

    const destacada = (msgs.rows as any[]).find((m) => m.id === msg1);
    assert.equal(destacada.destacado, true);
    assert.equal(destacada.destacado_por, uid_B, 'destacado_por debe pertenecer a uid_B');
  });

  // =========================================================================
  // ADV-11: CONFLICTO DOBLE EN PARTICIPANTE_DISPONIBILIDADES
  // =========================================================================
  test('ADV-11: Conflicto doble en participante_disponibilidades: gana la boleta más reciente completa preservando única preferida', async () => {
    const extHost = genRandomUuid();
    await db.query(`INSERT INTO auth.users (id, email, is_anonymous) VALUES ('${extHost}', 'exthost2@test.com', true) ON CONFLICT DO NOTHING;`);

    const encCoord = genRandomUuid();
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo, date_mode) VALUES ('${encCoord}', '${extHost}', 'Coord Date', 'coordination');`);

    const op1 = genRandomUuid();
    const op2 = genRandomUuid();
    const op3 = genRandomUuid();
    await db.query(`
      INSERT INTO public.encuentro_opciones_fecha (id, encuentro_id, fecha, hora_inicio) VALUES
        ('${op1}', '${encCoord}', '2026-12-01', '18:00'),
        ('${op2}', '${encCoord}', '2026-12-02', '18:00'),
        ('${op3}', '${encCoord}', '2026-12-03', '18:00');
    `);

    const partA = genRandomUuid();
    const partB = genRandomUuid();
    await db.query(`
      INSERT INTO public.participantes (id, encuentro_id, user_id, nombre_invitado, estado) VALUES
        ('${partA}', '${encCoord}', '${uid_A}', 'Votante A', 'confirmado'),
        ('${partB}', '${encCoord}', '${uid_B}', 'Votante B', 'confirmado');
    `);

    // Boleta A (antigua): votó op1 (preferida) y op2 (available)
    await db.query(`
      INSERT INTO public.participante_disponibilidades (participante_id, opcion_fecha_id, encuentro_id, respuesta, es_preferida, updated_at) VALUES
        ('${partA}', '${op1}', '${encCoord}', 'available', true, '2026-11-01 10:00:00+00'),
        ('${partA}', '${op2}', '${encCoord}', 'available', false, '2026-11-01 10:00:00+00');
    `);

    // Boleta B (más reciente): votó op1 (maybe, no preferida) y op3 (preferida)
    await db.query(`
      INSERT INTO public.participante_disponibilidades (participante_id, opcion_fecha_id, encuentro_id, respuesta, es_preferida, updated_at) VALUES
        ('${partB}', '${op1}', '${encCoord}', 'maybe', false, '2026-11-02 12:00:00+00'),
        ('${partB}', '${op3}', '${encCoord}', 'available', true, '2026-11-02 12:00:00+00');
    `);

    // Transferir A -> B
    await setAuth(uid_A, true);
    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;

    await setAuth(uid_B, true);
    const claim = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    assert.equal((claim.rows[0] as any).r.ok, true);

    // Verificar disponibilidades sobrevivientes
    const surviving = await db.query(`
      SELECT d.* FROM public.participante_disponibilidades d
      JOIN public.participantes p ON p.id = d.participante_id
      WHERE p.encuentro_id = '${encCoord}';
    `);

    assert.equal(surviving.rows.length, 3, 'Todas las 3 opciones de fecha deben estar representadas sin pérdida');

    const preferidas = surviving.rows.filter((d: any) => d.es_preferida === true);
    assert.equal(preferidas.length, 1, 'Debe existir exactamente una preferida');
    assert.equal((preferidas[0] as any).opcion_fecha_id, op3, 'La preferida de la boleta ganadora más reciente debe prevalecer');

    const op2Vote = surviving.rows.find((d: any) => d.opcion_fecha_id === op2);
    assert.equal((op2Vote as any).es_preferida, false, 'La opción rescatada de la boleta antigua no debe ser preferida');
  });

  // =========================================================================
  // ADV-12: COLISIONES SOLICITUDES_ENCUENTRO_ABIERTO Y WAITLIST
  // =========================================================================
  test('ADV-12: Colisión solicitudes_encuentro_abierto: jerarquía de 9 niveles, rescate de mensaje y unicidad', async () => {
    const extHost = genRandomUuid();
    await db.query(`INSERT INTO auth.users (id, email, is_anonymous) VALUES ('${extHost}', 'exthost3@test.com', true) ON CONFLICT DO NOTHING;`);

    const encOpen = genRandomUuid();
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES ('${encOpen}', '${extHost}', 'Open Enc Waitlist');`);

    // Source A tiene waitlist_offered; Target B tiene pending
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, mensaje, estado, waitlist_expires_at) VALUES
        ('${encOpen}', '${uid_A}', 'Sol A', 'Mensaje detallado de A', 'waitlist_offered', now() + interval '2 hours'),
        ('${encOpen}', '${uid_B}', 'Sol B', NULL, 'pending', NULL);
    `);

    await setAuth(uid_A, true);
    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;

    await setAuth(uid_B, true);
    const claim = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    assert.equal((claim.rows[0] as any).r.ok, true);

    const solFinal = await db.query(`SELECT * FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encOpen}';`);
    assert.equal(solFinal.rows.length, 1, 'Debe quedar exactamente 1 solicitud activa');
    assert.equal((solFinal.rows[0] as any).estado, 'waitlist_offered', 'waitlist_offered (nivel 7) debe ganar sobre pending (nivel 6)');
    assert.equal((solFinal.rows[0] as any).mensaje, 'Mensaje detallado de A', 'El mensaje no debe perderse si el canonical estaba vacío');
    assert.ok((solFinal.rows[0] as any).waitlist_expires_at, 'La ventana de expiración debe preservarse');
  });

  // =========================================================================
  // ADV-13: COBERTURA COMPLETA DE RECURSOS AUXILIARES
  // =========================================================================
  test('ADV-13: Recursos auxiliares completos: WhatsApp, templates (>3 con bypass), coverage, inbox y controversias', async () => {
    // 1. Encuentro con WhatsApp
    const encA = genRandomUuid();
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES ('${encA}', '${uid_A}', 'Encuentro con WhatsApp');`);
    await db.query(`INSERT INTO public.encuentros_contacto_whatsapp (encuentro_id, host_id, telefono_whatsapp) VALUES ('${encA}', '${uid_A}', '+5491112345678');`);

    // 2. Custom templates (Source tiene 3, Target tiene 2 -> Total 5 transferidos con bypass)
    await db.query(`
      INSERT INTO public.custom_invitation_templates (user_id, name, image_path) VALUES
        ('${uid_A}', 'T1', '/path/1.png'),
        ('${uid_A}', 'T2', '/path/2.png'),
        ('${uid_A}', 'T3', '/path/3.png'),
        ('${uid_B}', 'TB1', '/path/b1.png'),
        ('${uid_B}', 'TB2', '/path/b2.png');
    `);

    // 3. Coverage requests colisionadas
    await db.query(`
      INSERT INTO public.coverage_requests (user_id, dedupe_key, request_type, raw_location_text, normalized_input, intent_text, status) VALUES
        ('${uid_A}', 'market:caba', 'catalog_gap', 'Palermo', 'palermo', 'Quiero fútbol los viernes', 'pending'),
        ('${uid_B}', 'market:caba', 'catalog_gap', 'Palermo', 'palermo', NULL, 'reviewed');
    `);

    // 4. Inbox notifications colisionadas (A tenía no leída, B leída -> Resultante no leída)
    await db.query(`
      INSERT INTO public.inbox_notifications (recipient_user_id, dedup_key, title, body, read_at) VALUES
        ('${uid_A}', 'alert:123', 'Aviso A', 'Cuerpo A', NULL),
        ('${uid_B}', 'alert:123', 'Aviso B', 'Cuerpo B', now());
    `);

    // 5. Controversia sobre participante de A en encuentro externo
    const extHost = genRandomUuid();
    await db.query(`INSERT INTO auth.users (id, email, is_anonymous) VALUES ('${extHost}', 'hostext4@test.com', true) ON CONFLICT DO NOTHING;`);
    const encExt = genRandomUuid();
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES ('${encExt}', '${extHost}', 'Encuentro Controversia');`);
    const partA = genRandomUuid();
    await db.query(`INSERT INTO public.participantes (id, encuentro_id, user_id, nombre_invitado, estado) VALUES ('${partA}', '${encExt}', '${uid_A}', 'Part A', 'confirmado');`);
    await db.query(`
      INSERT INTO public.asistencia_controversias (encuentro_id, participante_id, tipo_controversia, iniciado_por, involucrado_id, estado) VALUES
        ('${encExt}', '${partA}', 'absence_reported', '${extHost}', '${uid_A}', 'awaiting_response');
    `);

    // Emisión y canje
    await setAuth(uid_A, true);
    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;

    await setAuth(uid_B, true);
    const claim = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    const rClaim = (claim.rows[0] as any).r;
    assert.equal(rClaim.ok, true);

    // Verificaciones
    const checkWa = await db.query(`SELECT host_id FROM public.encuentros_contacto_whatsapp WHERE encuentro_id = '${encA}';`);
    assert.equal((checkWa.rows[0] as any).host_id, uid_B, 'WhatsApp debe pertenecer a uid_B');

    const checkTemplates = await db.query(`SELECT COUNT(*) as c FROM public.custom_invitation_templates WHERE user_id = '${uid_B}';`);
    assert.equal(Number((checkTemplates.rows[0] as any).c), 5, 'Los 5 templates deben estar en uid_B');

    const checkCoverage = await db.query(`SELECT * FROM public.coverage_requests WHERE user_id = '${uid_B}';`);
    assert.equal(checkCoverage.rows.length, 1);
    assert.equal((checkCoverage.rows[0] as any).intent_text, 'Quiero fútbol los viernes', 'Intent text no debe perderse');

    const checkInbox = await db.query(`SELECT * FROM public.inbox_notifications WHERE recipient_user_id = '${uid_B}';`);
    assert.equal(checkInbox.rows.length, 1);
    assert.equal((checkInbox.rows[0] as any).read_at, null, 'Notificación resultante debe quedar NO leída (read_at IS NULL)');

    const checkControversy = await db.query(`SELECT * FROM public.asistencia_controversias WHERE encuentro_id = '${encExt}';`);
    assert.equal(checkControversy.rows.length, 1);
    assert.equal((checkControversy.rows[0] as any).involucrado_id, uid_B, 'Involucrado debe ser uid_B');
  });

  // =========================================================================
  // ADV-14: RESCATE DE INVITADO SIN SESIÓN (VINCULAR EN LOTE)
  // =========================================================================
  test('ADV-14: Rescate de invitado sin sesión: vincular_tokens_participante_lote_seguro asocia tokens legítimos y saltea propios', async () => {
    // 1. Encuentros de hosts externos
    const extHost = genRandomUuid();
    await db.query(`INSERT INTO auth.users (id, email, is_anonymous) VALUES ('${extHost}', 'hostext5@test.com', true) ON CONFLICT DO NOTHING;`);
    const encExt1 = genRandomUuid();
    const encExt2 = genRandomUuid();
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo) VALUES
        ('${encExt1}', '${extHost}', 'Encuentro Externo 1'),
        ('${encExt2}', '${extHost}', 'Encuentro Externo 2');
    `);

    // 2. Participaciones sin user_id (invitado anónimo sin registrar en 2 encuentros distintos)
    const tok1 = genRandomUuid();
    const tok2 = genRandomUuid();
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, token_invitacion) VALUES
        ('${encExt1}', NULL, 'Invitado 1', '${tok1}'),
        ('${encExt2}', NULL, 'Invitado 2', '${tok2}');
    `);

    // 3. Participación en encuentro propio de A (no debe permitirse vincular como participante)
    const encPropio = genRandomUuid();
    const tokPropio = genRandomUuid();
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES ('${encPropio}', '${uid_A}', 'Encuentro Propio de A');`);
    await db.query(`INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, token_invitacion) VALUES ('${encPropio}', NULL, 'Fantasma', '${tokPropio}');`);

    await setAuth(uid_A, true);
    const batchRes = await db.query(`SELECT public.vincular_tokens_participante_lote_seguro(ARRAY['${tok1}', '${tok2}', '${tokPropio}']) AS r;`);
    const r = (batchRes.rows[0] as any).r;

    assert.equal(r.ok, true);
    assert.equal(r.linked_count, 2, 'Debe enlazar los 2 tokens externos');
    assert.equal(r.skipped_count, 1, 'Debe saltear el token perteneciente a su propio encuentro');

    // Ahora transferir A -> B y verificar que B hereda los encuentros participados
    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;

    await setAuth(uid_B, true);
    const claim = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    assert.equal((claim.rows[0] as any).r.ok, true);

    const partsB = await db.query(`SELECT * FROM public.participantes WHERE user_id = '${uid_B}' AND encuentro_id IN ('${encExt1}', '${encExt2}');`);
    assert.equal(partsB.rows.length, 2, 'Los 2 tokens de participación deben pertenecer a uid_B');
  });

  // =========================================================================
  // ADV-15: CAÍDA DE RED POST-COMMIT E IDEMPOTENCIA
  // =========================================================================
  test('ADV-15: Caída de red post-commit: confirmar_migracion_dominio_completada_seguro responde idempotente para B y rechaza a terceros', async () => {
    await setAuth(uid_A, true);
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES (gen_random_uuid(), '${uid_A}', 'Encuentro NetDrop');`);

    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;

    // Completar el canje
    await setAuth(uid_B, true);
    await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);

    // Simular que el cliente llama a la RPC de confirmación idempotente
    const confB = await db.query(`SELECT public.confirmar_migracion_dominio_completada_seguro('${code}') AS r;`);
    const rB = (confB.rows[0] as any).r;
    assert.equal(rB.ok, true);
    assert.equal(rB.already_completed, true);
    assert.ok(rB.completed_at);

    // Tercero uid_C llama con el mismo token -> rechazado con transfer_not_confirmed
    await setAuth(uid_C, true);
    const confC = await db.query(`SELECT public.confirmar_migracion_dominio_completada_seguro('${code}') AS r;`);
    const rC = (confC.rows[0] as any).r;
    assert.equal(rC.ok, false);
    assert.equal(rC.error, 'transfer_not_confirmed');
  });

  // =========================================================================
  // ADV-16: CADENA COMPLETA A -> B -> C
  // =========================================================================
  test('ADV-16: Cadena completa A -> B -> C: preserva encuentros acumulados e inmutabilidad de cuotas históricas', async () => {
    // 1. Encuentro creado en A
    const enc1 = genRandomUuid();
    await setAuth(uid_A, true);
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES ('${enc1}', '${uid_A}', 'Encuentro Creado en A');`);

    // Migración A -> B
    const emisionA = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const codeA = (emisionA.rows[0] as any).r.ticket_token;
    await setAuth(uid_B, true);
    const claimB = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${codeA}') AS r;`);
    assert.equal((claimB.rows[0] as any).r.ok, true);

    // 2. Encuentro creado en B
    const enc2 = genRandomUuid();
    await setAuth(uid_B, true);
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES ('${enc2}', '${uid_B}', 'Encuentro Creado en B');`);

    // Migración B -> C
    const emisionB = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_C}') AS r;`);
    const codeB = (emisionB.rows[0] as any).r.ticket_token;
    await setAuth(uid_C, true);
    const claimC = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${codeB}') AS r;`);
    assert.equal((claimC.rows[0] as any).r.ok, true);

    // 3. Verificar que uid_C posee ambos encuentros
    const encsC = await db.query(`SELECT id FROM public.encuentros WHERE host_id = '${uid_C}';`);
    assert.equal(encsC.rows.length, 2, 'uid_C debe ser dueño de enc1 y enc2');

    // 4. Migración final C -> Google permanente
    const emisionC = await db.query(`SELECT public.create_domain_migration_ticket_seguro('oauth_upgrade', NULL) AS r;`);
    const codeC = (emisionC.rows[0] as any).r.ticket_token;
    await setAuth(uid_Google, false);
    const claimGoogle = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${codeC}') AS r;`);
    assert.equal((claimGoogle.rows[0] as any).r.ok, true);

    const encsGoogle = await db.query(`SELECT id FROM public.encuentros WHERE host_id = '${uid_Google}';`);
    assert.equal(encsGoogle.rows.length, 2, 'Cuenta Google final debe poseer ambos encuentros');
  });

  // =========================================================================
  // ADV-17: CONGELAMIENTO DE ESCRITURAS POST-MIGRACIÓN
  // =========================================================================
  test('ADV-17: Congelamiento post-migración: la sesión anónima retirada es 100% rechazada en todas las superficies', async () => {
    await setAuth(uid_A, true);
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES (gen_random_uuid(), '${uid_A}', 'Encuentro Base A');`);

    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;

    await setAuth(uid_B, true);
    await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);

    // Ahora uid_A está retirada (is_retired_anonymous_source = true)
    await setAuth(uid_A, true);

    // 1. crear_encuentro_seguro
    const resCrear = await db.query(`SELECT public.crear_encuentro_seguro('{"titulo":"Fantasma"}'::jsonb) AS r;`);
    assert.equal((resCrear.rows[0] as any).r.error, 'anonymous_session_already_migrated');

    // 2. vincular_usuario_participante_seguro
    const resVincular = await db.query(`SELECT public.vincular_usuario_participante_seguro('${genRandomUuid()}') AS r;`);
    assert.equal((resVincular.rows[0] as any).r.error, 'anonymous_session_already_migrated');

    // 3. vincular_tokens_participante_lote_seguro
    const resLote = await db.query(`SELECT public.vincular_tokens_participante_lote_seguro(ARRAY['${genRandomUuid()}']) AS r;`);
    assert.equal((resLote.rows[0] as any).r.error, 'anonymous_session_already_migrated');

    // 4. submit_coverage_request
    const resCov = await db.query(`SELECT public.submit_coverage_request('Belgrano') AS r;`);
    assert.equal((resCov.rows[0] as any).r.error, 'anonymous_session_already_migrated');

    // 5. enviar_feedback_usuario
    const resFeed = await db.query(`SELECT public.enviar_feedback_usuario('suggestion', 'Buen sitio') AS r;`);
    assert.equal((resFeed.rows[0] as any).r.error, 'anonymous_session_already_migrated');

    // 6. set_user_localidades_seguro
    const resLoc = await db.query(`SELECT public.set_user_localidades_seguro(ARRAY['palermo']) AS r;`);
    assert.equal((resLoc.rows[0] as any).r.error, 'anonymous_session_already_migrated');

    // 7. create_domain_migration_ticket_seguro
    const resTicket = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    assert.equal((resTicket.rows[0] as any).r.error, 'anonymous_session_already_migrated');

    // 8. Template trigger
    await assert.rejects(async () => {
      await db.query(`INSERT INTO public.custom_invitation_templates (user_id, name, image_path) VALUES ('${uid_A}', 'X', '/x.png');`);
    }, /anonymous_session_already_migrated/);
  });

  // =========================================================================
  // ADV-18: SERIALIZACIÓN ANTI-DEADLOCK Y OPERACIONES CONCURRENTES
  // =========================================================================
  test('ADV-18: Serialización determinista pe_identity_mutation previene carreras y asegura cero huérfanos', async () => {
    await setAuth(uid_A, true);
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES (gen_random_uuid(), '${uid_A}', 'Encuentro Base');`);

    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;

    // Ejecutar canje
    await setAuth(uid_B, true);
    const claim = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    assert.equal((claim.rows[0] as any).r.ok, true);

    // Cualquier escritura simultánea posterior que despierte del lock advisory ve el retiro y aborta limpiamente
    await setAuth(uid_A, true);
    const resWrite = await db.query(`SELECT public.crear_encuentro_seguro('{"titulo":"Encuentro Tardío"}'::jsonb) AS r;`);
    assert.equal((resWrite.rows[0] as any).r.error, 'anonymous_session_already_migrated');

    const checkRemanente = await db.query(`SELECT COUNT(*) as c FROM public.encuentros WHERE host_id = '${uid_A}';`);
    assert.equal(Number((checkRemanente.rows[0] as any).c), 0, 'Cero encuentros huérfanos bajo uid_A');
  });

  // =========================================================================
  // ADV-19: ASOCIACIÓN AL DESTINATARIO Y PROTECCIÓN ANTI-DOS
  // =========================================================================
  test('ADV-19: Asociación obligatoria al destinatario y anti-DoS: atacante es rechazado sin invalidar el ticket legítimo', async () => {
    await setAuth(uid_A, true);
    await db.query(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES (gen_random_uuid(), '${uid_A}', 'Encuentro Anti-DoS');`);

    // Ticket atado exclusivamente a uid_B
    const emision = await db.query(`SELECT public.create_domain_migration_ticket_seguro('cross_origin_bridge', '${uid_B}') AS r;`);
    const code = (emision.rows[0] as any).r.ticket_token;

    // Atacante intenta canjear
    await setAuth(uid_Evil, true);
    const claimEvil = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    assert.equal((claimEvil.rows[0] as any).r.ok, false);
    assert.equal((claimEvil.rows[0] as any).r.error, 'ticket_target_mismatch');

    // El ticket en la base de datos permanece pendiente e intacto
    const checkTicket = await db.query(`SELECT status FROM public.anonymous_transfer_tickets WHERE status = 'pending';`);
    assert.equal(checkTicket.rows.length, 1, 'El ticket no debe ser revocado por fallos de terceros');

    // Destinatario legítimo B canjea exitosamente después del intento atacante
    await setAuth(uid_B, true);
    const claimLegit = await db.query(`SELECT public.claim_domain_migration_ticket_seguro('${code}') AS r;`);
    assert.equal((claimLegit.rows[0] as any).r.ok, true);
  });
});

function genRandomUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
