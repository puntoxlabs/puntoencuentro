import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Mini-sprint C1: Métricas y feedback de prelanzamiento', () => {
  let db: PGlite;
  const adminUser = '11111111-1111-1111-1111-111111111111';
  const normalUser = '22222222-2222-2222-2222-222222222222';
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
        email TEXT
      );
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
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

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID REFERENCES public.encuentros(id),
        usuario_id UUID,
        estado TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        respondido_al TIMESTAMPTZ
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

      INSERT INTO auth.users (id, email) VALUES
        ('${adminUser}', 'admin@test.com'),
        ('${normalUser}', 'user@test.com'),
        ('${otherUser}', 'other@test.com')
      ON CONFLICT DO NOTHING;

      INSERT INTO public.qa_authorized_users (user_id, role) VALUES
        ('${adminUser}', 'admin')
      ON CONFLICT DO NOTHING;
    `);

    // 2. Ejecutar la migración de Mini-sprint C1
    const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20261021150000_metrics_and_feedback_c1.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(sql);
  });

  const setAuth = async (userId: string | null) => {
    if (userId) {
      await db.exec(`SET request.jwt.claim.sub = '${userId}';`);
    } else {
      await db.exec(`RESET request.jwt.claim.sub;`);
    }
  };

  test('1. Telemetría de uso: registrar_evento_uso almacena eventos observados de forma segura', async () => {
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

    // 1.4 Verificar almacenamiento y cero PII
    const events = await db.query<{ event_name: string; encounter_mode: string; share_channel: string; client_token_hash: string }>(
      `SELECT event_name, encounter_mode, share_channel, client_token_hash FROM public.app_usage_events ORDER BY id ASC;`
    );
    assert.equal(events.rows.length, 3);
    assert.equal(events.rows[0].event_name, 'home_visit');
    assert.equal(events.rows[1].event_name, 'invitation_shared');
    assert.equal(events.rows[1].share_channel, 'system_share');
    assert.equal(events.rows[2].event_name, 'invitation_opened');
    assert.equal(events.rows[0].client_token_hash.length, 64); // SHA256 hex
  });

  test('1.5 Telemetría de uso: rechaza nombres inválidos o tokens manipulados', async () => {
    await setAuth(null);
    await assert.rejects(
      db.query(`SELECT public.registrar_evento_uso('hacked_event', 'abcdef1234567890');`),
      /invalid_event_name/
    );

    await assert.rejects(
      db.query(`SELECT public.registrar_evento_uso('home_visit', 'short');`),
      /invalid_client_token/
    );
  });

  test('2. Feedback de usuario: control de autenticación estricto (Ajuste 1)', async () => {
    // 2.1 Sin autenticación debe fallar cerrado
    await setAuth(null);
    await assert.rejects(
      db.query(`SELECT public.enviar_feedback_usuario('issue', 'No puedo invitar');`),
      /authentication_required/
    );
  });

  test('2.2 Feedback de usuario: trampa Honeypot rechaza bots de forma inmediata', async () => {
    await setAuth(normalUser);
    const res = await db.query<{ enviar_feedback_usuario: { ok: boolean; error?: string } }>(
      `SELECT public.enviar_feedback_usuario('suggestion', 'Excelente app', '/', 'spam_bot_field') AS enviar_feedback_usuario;`
    );
    assert.equal(res.rows[0].enviar_feedback_usuario.ok, false);
    assert.equal(res.rows[0].enviar_feedback_usuario.error, 'invalid_submission');
  });

  test('2.3 Feedback de usuario: validación de longitud (3 a 1000 caracteres)', async () => {
    await setAuth(normalUser);
    // Demasiado corto
    await assert.rejects(
      db.query(`SELECT public.enviar_feedback_usuario('issue', 'ab');`),
      /invalid_comment_length/
    );

    // Demasiado largo
    const longText = 'a'.repeat(1001);
    await assert.rejects(
      db.query(`SELECT public.enviar_feedback_usuario('issue', $1);`, [longText]),
      /invalid_comment_length/
    );
  });

  test('2.4 Feedback de usuario: inserción exitosa y sanitización de ruta sin PII (Ajuste 2)', async () => {
    await setAuth(normalUser);
    const res = await db.query<{ enviar_feedback_usuario: { ok: boolean; id: string } }>(
      `SELECT public.enviar_feedback_usuario('suggestion', 'Sería genial tener modo oscuro', '/meet/12345?token=secret123#detail') AS enviar_feedback_usuario;`
    );
    assert.equal(res.rows[0].enviar_feedback_usuario.ok, true);
    assert.ok(res.rows[0].enviar_feedback_usuario.id);

    // Verificar en tabla que la ruta se sanitizó descartando query parameters y fragmentos
    const row = await db.query<{ category: string; comment: string; page_route: string; status: string }>(
      `SELECT category, comment, page_route, status FROM public.user_feedback WHERE id = $1;`,
      [res.rows[0].enviar_feedback_usuario.id]
    );
    assert.equal(row.rows[0].category, 'suggestion');
    assert.equal(row.rows[0].page_route, '/meet/12345'); // sin token ni fragmento
    assert.equal(row.rows[0].status, 'unread');
  });

  test('2.5 Feedback de usuario: rate limit server-side (máximo 5 envíos por hora)', async () => {
    await setAuth(otherUser);

    // Enviar 5 feedbacks exitosos
    for (let i = 0; i < 5; i++) {
      const res = await db.query<{ enviar_feedback_usuario: { ok: boolean } }>(
        `SELECT public.enviar_feedback_usuario('general', 'Comentario número ' || $1, '/') AS enviar_feedback_usuario;`,
        [i + 1]
      );
      assert.equal(res.rows[0].enviar_feedback_usuario.ok, true);
    }

    // El 6to debe ser rechazado por rate_limit_exceeded
    const blockedRes = await db.query<{ enviar_feedback_usuario: { ok: boolean; error: string } }>(
      `SELECT public.enviar_feedback_usuario('general', 'Intento número 6 bloqueado', '/') AS enviar_feedback_usuario;`
    );
    assert.equal(blockedRes.rows[0].enviar_feedback_usuario.ok, false);
    assert.equal(blockedRes.rows[0].enviar_feedback_usuario.error, 'rate_limit_exceeded');
  });

  test('3. Consultas administrativas QA: get_qa_user_feedback y update_qa_user_feedback_status', async () => {
    // 3.1 Usuario normal rechazado
    await setAuth(normalUser);
    await assert.rejects(
      db.query(`SELECT public.get_qa_user_feedback(30);`),
      /unauthorized/
    );

    // 3.2 Usuario admin QA autorizado
    await setAuth(adminUser);
    const feedbackList = await db.query<{ get_qa_user_feedback: any }>(
      `SELECT public.get_qa_user_feedback(30) AS get_qa_user_feedback;`
    );
    const data = feedbackList.rows[0].get_qa_user_feedback;
    assert.equal(data.ok, true);
    assert.ok(data.feedback.length >= 6);
    assert.equal(data.total_count >= 6, true);

    const firstId = data.feedback[0].id;

    // 3.3 Actualizar estado a reviewed
    const updateRes = await db.query<{ update_qa_user_feedback_status: { ok: boolean; status: string } }>(
      `SELECT public.update_qa_user_feedback_status($1, 'reviewed') AS update_qa_user_feedback_status;`,
      [firstId]
    );
    assert.equal(updateRes.rows[0].update_qa_user_feedback_status.ok, true);
    assert.equal(updateRes.rows[0].update_qa_user_feedback_status.status, 'reviewed');
  });

  test('4. Dashboard QA: get_qa_dashboard_metrics devuelve métricas observadas con denominadores', async () => {
    await setAuth(adminUser);

    // Insertar datos de prueba para participantes (RSVP)
    const encId = '44444444-4444-4444-4444-444444444444';
    await db.exec(`
      INSERT INTO public.encuentros (id, titulo) VALUES ('${encId}', 'Encuentro Test') ON CONFLICT DO NOTHING;

      INSERT INTO public.participantes (encuentro_id, estado, respondido_en) VALUES
        ('${encId}', 'confirmado', now()),
        ('${encId}', 'confirmado', now()),
        ('${encId}', 'rechazado', now());

      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, estado, created_at, respondido_al) VALUES
        ('${encId}', 'aprobada', now(), now()),
        ('${encId}', 'rechazada', now(), now()),
        ('${encId}', 'pendiente', now(), NULL);

      INSERT INTO public.match_alert_subscriptions (created_at) VALUES (now()), (now());
    `);

    const metricsRes = await db.query<{ get_qa_dashboard_metrics: any }>(
      `SELECT public.get_qa_dashboard_metrics(7) AS get_qa_dashboard_metrics;`
    );
    const m = metricsRes.rows[0].get_qa_dashboard_metrics;

    assert.equal(m.ok, true);
    // Métricas observadas de uso
    assert.ok(m.home_visits >= 1);
    assert.ok(m.invitations_shared >= 1);
    assert.ok(m.invitations_opened >= 1);

    // Respuestas (RSVP)
    assert.equal(m.rsvps_confirmed, 2);
    assert.equal(m.rsvps_declined, 1);
    assert.equal(m.rsvps_total, 3);
    assert.equal(m.rsvp_confirmation_rate, 66.7); // 2 / 3 * 100

    // Solicitudes en abiertos
    assert.equal(m.open_requests_created, 3);
    assert.equal(m.open_requests_approved, 1);
    assert.equal(m.open_requests_rejected, 1);
    assert.equal(m.open_request_approval_rate, 50.0); // 1 / 2 * 100

    // Avisame
    assert.equal(m.avisame_created, 2);

    // Retención documentada
    assert.equal(m.retention_policy_days, 90);
  });

  test('5. Purga de telemetría: purgar_telemetria_uso_antigua respeta ventana mínima de 7 días', async () => {
    await setAuth(null);
    await assert.rejects(
      db.query(`SELECT public.purgar_telemetria_uso_antigua(3);`),
      /invalid_retention_days/
    );

    const deleted = await db.query<{ purgar_telemetria_uso_antigua: number }>(
      `SELECT public.purgar_telemetria_uso_antigua(90) AS purgar_telemetria_uso_antigua;`
    );
    assert.equal(deleted.rows[0].purgar_telemetria_uso_antigua, 0); // No hay eventos de >90 días
  });

  test('6. i18n: consistencia y presencia de todas las claves de feedback en ES, EN y PT-BR', () => {
    const es = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/es.json'), 'utf8'));
    const en = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/en.json'), 'utf8'));
    const pt = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/pt-BR.json'), 'utf8'));

    const requiredKeys = [
      'title',
      'cta_secondary',
      'cat_issue',
      'cat_suggestion',
      'cat_general',
      'category_label',
      'placeholder_issue',
      'placeholder_suggestion',
      'placeholder_general',
      'textarea_label',
      'submit_btn',
      'submitting',
      'success_title',
      'success_desc',
      'close_btn',
      'rate_limited',
      'auth_required_msg',
      'auth_note',
      'login_cta',
      'login_prompt',
      'generic_error',
    ];

    assert.ok(es.feedback, 'es.json debe incluir la sección feedback');
    assert.ok(en.feedback, 'en.json debe incluir la sección feedback');
    assert.ok(pt.feedback, 'pt-BR.json debe incluir la sección feedback');

    for (const k of requiredKeys) {
      assert.ok(es.feedback[k], `es.feedback.${k} debe estar definido y no vacío`);
      assert.ok(en.feedback[k], `en.feedback.${k} debe estar definido y no vacío`);
      assert.ok(pt.feedback[k], `pt-BR.feedback.${k} debe estar definido y no vacío`);
    }
  });
});
