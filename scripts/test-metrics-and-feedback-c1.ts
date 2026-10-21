import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { normalizeRouteForFeedback } from '../src/services/feedbackService';

describe('Mini-sprint C1: Métricas y feedback de prelanzamiento (Microcierre)', () => {
  let db: PGlite;
  const adminUser = '11111111-1111-1111-1111-111111111111';
  const normalUser = '22222222-2222-2222-2222-222222222222';
  const anonAuthUser = '99999999-9999-9999-9999-999999999999';
  const otherUser = '33333333-3333-3333-3333-333333333333';

  before(async () => {
    db = new PGlite();

    // 1. Roles & Schema base mock
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN
          CREATE ROLE postgres;
        END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT,
        is_anonymous BOOLEAN DEFAULT false
      );
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT jsonb_build_object(
          'sub', current_setting('request.jwt.claim.sub', true),
          'is_anonymous', current_setting('request.jwt.claim.is_anonymous', true) = 'true'
        );
      $$ LANGUAGE SQL STABLE;

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        titulo TEXT
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID REFERENCES public.encuentros(id),
        estado TEXT NOT NULL,
        respondido_en TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      -- Esquema canónico real de solicitudes_encuentro_abierto (resolved_at y approved/rejected)
      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID REFERENCES public.encuentros(id),
        usuario_id UUID,
        estado TEXT NOT NULL CHECK (estado IN ('pending', 'approved', 'rejected', 'withdrawn', 'cancelled')),
        created_at TIMESTAMPTZ DEFAULT now(),
        resolved_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS public.match_alert_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.qa_authorized_users (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id),
        role TEXT NOT NULL DEFAULT 'qa'
      );

      CREATE OR REPLACE FUNCTION public.is_qa_authorized()
      RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
      DECLARE
        v_user_id UUID := auth.uid();
      BEGIN
        IF v_user_id IS NULL THEN RETURN false; END IF;
        RETURN EXISTS (SELECT 1 FROM public.qa_authorized_users WHERE user_id = v_user_id);
      END;
      $$;

      -- Generic rate limiting tables
      CREATE TABLE IF NOT EXISTS public.rate_limit_policies (
        action TEXT PRIMARY KEY,
        max_requests INT NOT NULL,
        window_seconds INT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
        action TEXT NOT NULL REFERENCES public.rate_limit_policies(action) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        scope_key TEXT NOT NULL DEFAULT '',
        window_start TIMESTAMPTZ NOT NULL,
        request_count INT NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (action, user_id, scope_key, window_start)
      );

      CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(
        p_action TEXT,
        p_scope_key TEXT DEFAULT ''
      )
      RETURNS JSONB
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $$
      DECLARE
        v_user_id UUID := auth.uid();
        v_policy RECORD;
        v_window_start TIMESTAMPTZ;
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

        v_window_start := to_timestamp(floor(extract(epoch from now()) / v_policy.window_seconds) * v_policy.window_seconds);

        INSERT INTO public.rate_limit_buckets (action, user_id, scope_key, window_start, request_count, updated_at)
        VALUES (p_action, v_user_id, COALESCE(p_scope_key, ''), v_window_start, 1, now())
        ON CONFLICT (action, user_id, scope_key, window_start)
        DO UPDATE SET request_count = public.rate_limit_buckets.request_count + 1, updated_at = now();

        IF (SELECT request_count FROM public.rate_limit_buckets
            WHERE action = p_action AND user_id = v_user_id AND scope_key = COALESCE(p_scope_key, '') AND window_start = v_window_start) > v_policy.max_requests THEN
          RETURN jsonb_build_object('allowed', false, 'error', 'rate_limit_exceeded');
        END IF;

        RETURN jsonb_build_object('allowed', true);
      END;
      $$;

      -- Creation sessions
      CREATE TABLE IF NOT EXISTS public.creation_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES auth.users(id),
        client_token_hash TEXT,
        creation_source TEXT NOT NULL,
        initial_route TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'started',
        date_mode TEXT,
        encounter_id UUID REFERENCES public.encuentros(id),
        turns INT NOT NULL DEFAULT 0,
        elapsed_ms INT DEFAULT 0,
        frontend_version TEXT,
        edge_version TEXT,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        completed_at TIMESTAMPTZ,
        last_event_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.creation_session_events (
        id BIGSERIAL PRIMARY KEY,
        session_id UUID NOT NULL REFERENCES public.creation_sessions(id) ON DELETE CASCADE,
        turn_number INT NOT NULL DEFAULT 0,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        operation TEXT,
        result TEXT,
        provider TEXT,
        fallback_used BOOLEAN NOT NULL DEFAULT false,
        latency_ms INT,
        fields_changed TEXT[],
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      INSERT INTO auth.users (id, email, is_anonymous) VALUES
        ('${adminUser}', 'admin@test.com', false),
        ('${normalUser}', 'user@test.com', false),
        ('${anonAuthUser}', NULL, true),
        ('${otherUser}', 'other@test.com', false)
      ON CONFLICT DO NOTHING;

      INSERT INTO public.qa_authorized_users (user_id, role) VALUES
        ('${adminUser}', 'admin')
      ON CONFLICT DO NOTHING;
    `);

    // 2. Ejecutar la migración base C1
    const migration1 = path.resolve(process.cwd(), 'supabase/migrations/20261021150000_metrics_and_feedback_c1.sql');
    await db.exec(fs.readFileSync(migration1, 'utf8'));

    // 3. Ejecutar la migración correctiva de Microcierre C1
    const migration2 = path.resolve(process.cwd(), 'supabase/migrations/20261021160000_fix_c1_metrics_and_feedback.sql');
    await db.exec(fs.readFileSync(migration2, 'utf8'));
  });

  const setAuth = async (userId: string | null, isAnonymous: boolean = false) => {
    if (userId) {
      await db.exec(`
        SET request.jwt.claim.sub = '${userId}';
        SET request.jwt.claim.is_anonymous = '${isAnonymous}';
      `);
    } else {
      await db.exec(`
        RESET request.jwt.claim.sub;
        RESET request.jwt.claim.is_anonymous;
      `);
    }
  };

  test('1. Telemetría de uso: registrar_evento_uso y mitigación anti-abuso con IP hash', async () => {
    await setAuth(null);
    const clientToken = 'abcdef1234567890abcdef1234567890';

    // 1.1 Registrar home_visit
    const resHome = await db.query<{ registrar_evento_uso: { ok: boolean } }>(
      `SELECT public.registrar_evento_uso('home_visit', $1) AS registrar_evento_uso;`,
      [clientToken]
    );
    assert.equal(resHome.rows[0].registrar_evento_uso.ok, true);

    // 1.2 Registrar invitation_shared
    const resShare = await db.query<{ registrar_evento_uso: { ok: boolean } }>(
      `SELECT public.registrar_evento_uso('invitation_shared', $1, NULL, 'fixed', 'system_share') AS registrar_evento_uso;`,
      [clientToken]
    );
    assert.equal(resShare.rows[0].registrar_evento_uso.ok, true);

    // 1.3 Registrar invitation_opened
    const resOpen = await db.query<{ registrar_evento_uso: { ok: boolean } }>(
      `SELECT public.registrar_evento_uso('invitation_opened', $1, NULL, 'coordination', NULL, 'coordination_individual') AS registrar_evento_uso;`,
      [clientToken]
    );
    assert.equal(resOpen.rows[0].registrar_evento_uso.ok, true);

    // 1.4 Verificar almacenamiento seguro y cero URLs o PII
    const events = await db.query<{ event_name: string; encounter_mode: string; share_channel: string; client_token_hash: string }>(
      `SELECT event_name, encounter_mode, share_channel, client_token_hash FROM public.app_usage_events ORDER BY id ASC;`
    );
    assert.equal(events.rows.length, 3);
    assert.equal(events.rows[0].event_name, 'home_visit');
    assert.equal(events.rows[1].event_name, 'invitation_shared');
    assert.equal(events.rows[1].share_channel, 'system_share');
    assert.equal(events.rows[2].event_name, 'invitation_opened');
    assert.equal(events.rows[0].client_token_hash.length, 64);
  });

  test('2. Exclusión estricta de usuarios anónimos (Item 3)', async () => {
    // 2.1 Sin sesión -> authentication_required
    await setAuth(null);
    await assert.rejects(
      db.query(`SELECT public.enviar_feedback_usuario('issue', 'No puedo invitar');`),
      /authentication_required/
    );

    // 2.2 Sesión autenticada pero ANÓNIMA -> permanent_account_required
    await setAuth(anonAuthUser, true);
    await assert.rejects(
      db.query(`SELECT public.enviar_feedback_usuario('issue', 'Intento desde cuenta anónima');`),
      /permanent_account_required/
    );

    // 2.3 Sesión permanente -> Permite envío
    await setAuth(normalUser, false);
    const okRes = await db.query<{ enviar_feedback_usuario: { ok: boolean; id: string } }>(
      `SELECT public.enviar_feedback_usuario('suggestion', 'Excelente app desde cuenta permanente', '/') AS enviar_feedback_usuario;`
    );
    assert.equal(okRes.rows[0].enviar_feedback_usuario.ok, true);
    assert.ok(okRes.rows[0].enviar_feedback_usuario.id);
  });

  test('3. Normalización estricta de rutas y cero persistencia de tokens privados (Item 2)', async () => {
    // 3.1 Normalización en TypeScript
    assert.equal(normalizeRouteForFeedback('/invite/abc-123-token-secreto'), '/invite/:token');
    assert.equal(normalizeRouteForFeedback('/join/xyz-public-token'), '/join/:token');
    assert.equal(normalizeRouteForFeedback('/coordination/invite/token-456'), '/coordination/invite/:token');
    assert.equal(normalizeRouteForFeedback('/coordination/join/token-789'), '/coordination/join/:token');
    assert.equal(normalizeRouteForFeedback('/meet/88888888-8888-8888-8888-888888888888?share=1#top'), '/meet/:id');
    assert.equal(normalizeRouteForFeedback('/internal/qa/sessions/some-session-uuid'), '/internal/qa/sessions/:sessionId');
    assert.equal(normalizeRouteForFeedback('/create/ai'), '/create/ai');
    assert.equal(normalizeRouteForFeedback('/'), '/');
    assert.equal(normalizeRouteForFeedback('/unknown/private/route/123'), null);

    // 3.2 Normalización en PostgreSQL (public.normalizar_ruta_feedback)
    const dbNorm = await db.query<{ route: string | null }>(`
      SELECT public.normalizar_ruta_feedback('/invite/00000000-0000-0000-0000-000000000000?ref=whatsapp#part') AS route;
    `);
    assert.equal(dbNorm.rows[0].route, '/invite/:token');

    // 3.3 Envío con ruta dinámica: persiste el template canónico literal ':token' sin el token real
    await setAuth(normalUser, false);
    const res = await db.query<{ enviar_feedback_usuario: { ok: boolean; id: string } }>(
      `SELECT public.enviar_feedback_usuario('issue', 'Fallo al abrir link', '/invite/secreto-token-999?query=1') AS enviar_feedback_usuario;`
    );
    assert.equal(res.rows[0].enviar_feedback_usuario.ok, true);

    const check = await db.query<{ page_route: string }>(
      `SELECT page_route FROM public.user_feedback WHERE id = $1;`,
      [res.rows[0].enviar_feedback_usuario.id]
    );
    assert.equal(check.rows[0].page_route, '/invite/:token');
    assert.equal(check.rows[0].page_route.includes('secreto'), false);
  });

  test('4. Métricas de solicitudes abiertas corregidas con esquema real (Item 1)', async () => {
    await setAuth(adminUser);

    const encId = '55555555-5555-5555-5555-555555555555';
    await db.exec(`
      INSERT INTO public.encuentros (id, titulo) VALUES ('${encId}', 'Encuentro Abierto Test') ON CONFLICT DO NOTHING;

      -- Insertar solicitudes usando los estados reales ('approved', 'rejected', 'pending') y resolved_at
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, estado, created_at, resolved_at) VALUES
        ('${encId}', 'approved', now(), now()),
        ('${encId}', 'approved', now(), now()),
        ('${encId}', 'rejected', now(), now()),
        ('${encId}', 'pending', now(), NULL);
    `);

    const metricsRes = await db.query<{ get_qa_dashboard_metrics: any }>(
      `SELECT public.get_qa_dashboard_metrics(7) AS get_qa_dashboard_metrics;`
    );
    const m = metricsRes.rows[0].get_qa_dashboard_metrics;

    assert.equal(m.ok, true);
    // 4 solicitudes creadas en total
    assert.equal(m.open_requests_created, 4);
    assert.equal(m.open_requests_approved, 2);
    assert.equal(m.open_requests_rejected, 1);
    // 2 aprobadas sobre (2 + 1) resueltas = 66.7%
    assert.equal(m.open_request_approval_rate, 66.7);
  });

  test('5. Retención y política programada', async () => {
    await setAuth(null);
    const deleted = await db.query<{ purgar_telemetria_uso_antigua: number }>(
      `SELECT public.purgar_telemetria_uso_antigua(90) AS purgar_telemetria_uso_antigua;`
    );
    assert.equal(deleted.rows[0].purgar_telemetria_uso_antigua, 0);
  });

  test('6. i18n: verificación de claves y permanent_account_msg', () => {
    const es = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/es.json'), 'utf8'));
    const en = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/en.json'), 'utf8'));
    const pt = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/pt-BR.json'), 'utf8'));

    assert.ok(es.feedback.permanent_account_msg);
    assert.ok(en.feedback.permanent_account_msg);
    assert.ok(pt.feedback.permanent_account_msg);
  });
});
