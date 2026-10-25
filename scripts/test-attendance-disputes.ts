import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Mini-Sprint C: Controversias, derecho a respuesta y moderación de asistencia', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const partUserA = '22222222-2222-2222-2222-222222222222';
  const partUserB = '33333333-3333-3333-3333-333333333333';
  const modIndependent = '44444444-4444-4444-4444-444444444444';
  const modConflictHost = '55555555-5555-5555-5555-555555555555';
  const thirdPartyUser = '66666666-6666-6666-6666-666666666666';

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

    // 1. Roles y Mock Auth
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
        ('${partUserA}', 'parta@test.com'),
        ('${partUserB}', 'partb@test.com'),
        ('${modIndependent}', 'mod@test.com'),
        ('${modConflictHost}', 'modhost@test.com'),
        ('${thirdPartyUser}', 'thirdparty@test.com')
      ON CONFLICT DO NOTHING;

      -- Tablas preexistentes requeridas
      CREATE TABLE IF NOT EXISTS public.localidades (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        ciudad TEXT,
        zona TEXT,
        activo BOOLEAN NOT NULL DEFAULT true
      );

      INSERT INTO public.localidades (id, nombre, ciudad, zona, activo) VALUES
        ('palermo', 'Palermo', 'Buenos Aires', 'CABA', true),
        ('virtual', 'Virtual', 'Global', 'Online', true)
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
        fecha DATE,
        hora TIME WITHOUT TIME ZONE,
        duration_minutes INT DEFAULT 120,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        locality_id TEXT REFERENCES public.localidades(id),
        open_public_zone TEXT,
        lugar_texto TEXT,
        link_virtual TEXT,
        max_participants INT,
        min_participants INT DEFAULT 2,
        allow_multi_seat_requests BOOLEAN DEFAULT false,
        max_seats_per_request INT DEFAULT 1,
        min_seats_per_request INT DEFAULT 1,
        is_open BOOLEAN NOT NULL DEFAULT false,
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'cancelado')),
        inscriptions_closed BOOLEAN NOT NULL DEFAULT false,
        inscriptions_closed_at TIMESTAMPTZ,
        inscriptions_cycle_id UUID DEFAULT gen_random_uuid(),
        realization_status TEXT DEFAULT 'pending' CHECK (realization_status IN ('pending', 'confirmed', 'forced')),
        cancellation_reason TEXT,
        cancelled_by UUID REFERENCES auth.users(id),
        moderation_status TEXT NOT NULL DEFAULT 'approved',
        created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
        tema TEXT,
        tema_invitacion TEXT,
        open_activity_canonical TEXT,
        open_activity_matching_eligible BOOLEAN DEFAULT false
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        nombre_invitado TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'confirmado' CHECK (estado IN ('pendiente', 'confirmado', 'rechazado', 'cancelado', 'asistio')),
        token_invitacion UUID DEFAULT gen_random_uuid(),
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        mensaje_respuesta TEXT,
        respondido_en TIMESTAMPTZ,
        reconfirmation_status TEXT DEFAULT 'pending' CHECK (reconfirmation_status IN ('pending', 'confirmed', 'declined')),
        reconfirmed_at TIMESTAMPTZ,
        reconfirmation_cycle_id UUID,
        attendance_status TEXT NOT NULL DEFAULT 'unverified',
        attendance_dispute_status TEXT NOT NULL DEFAULT 'none',
        attendance_dispute_id UUID,
        seat_count INT NOT NULL DEFAULT 1 CHECK (seat_count >= 1),
        creado_en TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        motivo_baja TEXT,
        estado TEXT NOT NULL DEFAULT 'pending',
        participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
        token_participante UUID,
        seat_count INT NOT NULL DEFAULT 1 CHECK (seat_count >= 1),
        is_waitlist BOOLEAN NOT NULL DEFAULT false,
        waitlist_offered_at TIMESTAMPTZ,
        waitlist_expires_at TIMESTAMPTZ,
        waitlist_confirmed_at TIMESTAMPTZ,
        host_approval_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
        resolved_at TIMESTAMPTZ
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
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        read_at TIMESTAMPTZ,
        dedup_key TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
        CONSTRAINT uq_inbox_recipient_dedup UNIQUE (recipient_user_id, dedup_key)
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
          recipient_user_id,
          notification_type,
          target_type,
          target_id,
          deep_link,
          title,
          body,
          payload,
          dedup_key,
          expires_at
        ) VALUES (
          p_recipient_user_id,
          p_notification_type,
          p_target_type,
          p_target_id,
          p_deep_link,
          p_title,
          p_body,
          p_payload,
          COALESCE(p_dedup_key, gen_random_uuid()::text),
          pg_catalog.now() + interval '30 days'
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

      -- Tabla de moderación autorizada
      CREATE TABLE IF NOT EXISTS public.moderation_authorized_users (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'moderator',
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
      );

      CREATE OR REPLACE FUNCTION public.is_moderation_authorized()
      RETURNS BOOLEAN
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = ''
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.moderation_authorized_users
          WHERE user_id = auth.uid()
            AND active = true
            AND role IN ('admin', 'moderator')
        );
      $$;

      INSERT INTO public.moderation_authorized_users (user_id, role, active) VALUES
        ('${modIndependent}', 'moderator', true),
        ('${modConflictHost}', 'moderator', true)
      ON CONFLICT DO NOTHING;
    `);

    // 2. Cargar migraciones sucesivas
    const migrations = [
      '20261024180000_post_event_closure_and_attendance_v1.sql',
      '20261024200000_hotfix_post_event_closure_security_and_idempotency.sql',
      '20261024203000_harden_administrative_regularization_privileges.sql',
      '20261024210000_fix_session_user_administrative_regularization.sql',
      '20261024220000_open_encounters_waitlist_and_recovery_v1.sql',
      '20261024230000_hotfix_waitlist_concurrency_and_discovery_v1.sql',
      '20261024240000_attendance_disputes_and_right_to_reply_v1.sql',
    ];

    for (const mig of migrations) {
      const sqlPath = path.join(__dirname, '..', 'supabase', 'migrations', mig);
      const sqlContent = fs.readFileSync(sqlPath, 'utf8');
      await db.exec(sqlContent);
    }
  });

  test('01. Creación automática de controversia al reportar inasistencia (awaiting_response, 7 días)', async () => {
    await setAuth(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, fecha, hora, duration_minutes,
        is_open, opened_at, modalidad, locality_id, open_public_zone
      ) VALUES (
        '${hostUser}', 'Encuentro Cafe Filosofico', 'Cafe Filosofico',
        CURRENT_DATE - INTERVAL '1 day', '19:00:00', 120,
        true, CURRENT_TIMESTAMP - INTERVAL '2 days', 'presencial', 'palermo', 'Palermo'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion
      ) VALUES (
        '${encId}', '${partUserA}', 'Carlos A', 'confirmado', 'individual'
      ) RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    // El host cierra el encuentro reportando inasistencia sin aviso para Carlos A
    const closureRes = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        p_encuentro_id := '${encId}',
        p_realization_status := 'realized',
        p_unrealized_reason := NULL,
        p_asistencias := jsonb_build_array(
          jsonb_build_object(
            'participante_id', '${partId}',
            'attendance_status', 'reported_absent'
          )
        )
      ) AS res;
    `);

    const result = closureRes.rows[0].res as any;
    assert.equal(result.ok, true, 'El cierre debe completarse con éxito');

    // Verificar que la controversia fue creada automáticamente en awaiting_response
    const dispRes = await db.query<{
      id: string;
      estado: string;
      plazo_respuesta_vence_en: string;
      tipo_controversia: string;
    }>(`
      SELECT id, estado, plazo_respuesta_vence_en::text, tipo_controversia
      FROM public.asistencia_controversias
      WHERE encuentro_id = '${encId}' AND participante_id = '${partId}';
    `);

    assert.equal(dispRes.rows.length, 1, 'Debe haberse creado exactamente una controversia');
    const disp = dispRes.rows[0];
    assert.equal(disp.estado, 'awaiting_response');
    assert.equal(disp.tipo_controversia, 'absence_reported');

    // Comprobar que participante tiene attendance_status = reported_absent y controversia awaiting_response
    const partCheck = await db.query<{ attendance_status: string; attendance_dispute_status: string }>(`
      SELECT attendance_status, attendance_dispute_status FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partCheck.rows[0].attendance_status, 'reported_absent', 'Inasistencia reportada por el host');
    assert.equal(partCheck.rows[0].attendance_dispute_status, 'awaiting_response');
  });

  test('02. Notificación en Inbox con copy neutral y sin juicio de valor', async () => {
    // Verificar que la notificación enviada a Carlos A tiene tono neutro y respetuoso
    const notifRes = await db.query<{ title: string; body: string; notification_type: string }>(`
      SELECT title, body, notification_type
      FROM public.inbox_notifications
      WHERE recipient_user_id = '${partUserA}'
      ORDER BY created_at DESC LIMIT 1;
    `);

    assert.equal(notifRes.rows.length, 1, 'Debe existir notificación en inbox para Carlos A');
    const notif = notifRes.rows[0];
    assert.equal(notif.notification_type, 'attendance_reported_absent');
    assert.match(notif.title, /inasistencia|asistencia/i, 'El título debe ser neutro e informativo');
    assert.match(notif.body, /derecho a responder|revisión/i, 'El cuerpo debe garantizar el derecho a respuesta');
  });

  test('03. Descargo del participante: reconocimiento de inasistencia (confirmed_by_participant)', async () => {
    await setAuth(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, fecha, hora, duration_minutes,
        is_open, opened_at, modalidad, locality_id, open_public_zone
      ) VALUES (
        '${hostUser}', 'Taller de Teatro', 'Taller de Teatro',
        CURRENT_DATE - INTERVAL '1 day', '18:00:00', 120,
        true, CURRENT_TIMESTAMP - INTERVAL '2 days', 'presencial', 'palermo', 'Palermo'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion
      ) VALUES (
        '${encId}', '${partUserB}', 'Beatriz B', 'confirmado', 'individual'
      ) RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        p_encuentro_id := '${encId}',
        p_realization_status := 'realized',
        p_unrealized_reason := NULL,
        p_asistencias := jsonb_build_array(
          jsonb_build_object('participante_id', '${partId}', 'attendance_status', 'reported_absent')
        )
      );
    `);

    const dispId = (await db.query<{ id: string }>(`
      SELECT id FROM public.asistencia_controversias WHERE encuentro_id = '${encId}' AND participante_id = '${partId}';
    `)).rows[0].id;

    // Beatriz B reconoce honestamente su ausencia sin aviso
    await setAuth(partUserB);
    const replyRes = await db.query(`
      SELECT public.responder_controversia_asistencia_seguro(
        p_dispute_id := '${dispId}',
        p_decision := 'accept_absence',
        p_descargo_texto := 'Pido disculpas, se me complicó con el trabajo y no pude avisar antes.'
      ) AS res;
    `);

    const reply = replyRes.rows[0].res as any;
    assert.equal(reply.ok, true);
    assert.equal(reply.status, 'confirmed_by_participant');

    // Participante ahora tiene confirmed_by_participant y attendance_status = reported_absent
    const partCheck = await db.query<{ attendance_status: string; attendance_dispute_status: string }>(`
      SELECT attendance_status, attendance_dispute_status FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partCheck.rows[0].attendance_status, 'reported_absent');
    assert.equal(partCheck.rows[0].attendance_dispute_status, 'confirmed_by_participant');
  });

  test('04. Descargo del participante: contradicción («sí asistí») -> pasa a in_human_review, estado neutral', async () => {
    // Tomamos la controversia creada en test 01 para Carlos A
    const dispRes = await db.query<{ id: string; participante_id: string }>(`
      SELECT id, participante_id FROM public.asistencia_controversias WHERE involucrado_id = '${partUserA}';
    `);
    const dispId = dispRes.rows[0].id;
    const partId = dispRes.rows[0].participante_id;

    await setAuth(partUserA);
    const replyRes = await db.query(`
      SELECT public.responder_controversia_asistencia_seguro(
        p_dispute_id := '${dispId}',
        p_decision := 'attended_present',
        p_descargo_texto := 'Estuve presente toda la charla, me senté en la mesa del fondo junto a María.'
      ) AS res;
    `);

    const reply = replyRes.rows[0].res as any;
    assert.equal(reply.ok, true);
    assert.equal(reply.status, 'in_human_review', 'Debe pasar a revisión humana obligatoria');

    // Estado del participante debe mantenerse estrictamente neutral como unverified
    const partCheck = await db.query<{ attendance_status: string; attendance_dispute_status: string }>(`
      SELECT attendance_status, attendance_dispute_status FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partCheck.rows[0].attendance_status, 'unverified', 'Contradicción de hecho preserva presunción neutral');
    assert.equal(partCheck.rows[0].attendance_dispute_status, 'in_human_review');
  });

  test('05. Descargo del participante: aviso previo o fuerza mayor -> pasa a in_human_review', async () => {
    await setAuth(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, fecha, hora, duration_minutes,
        is_open, opened_at, modalidad, locality_id, open_public_zone
      ) VALUES (
        '${hostUser}', 'Salida de Running', 'Salida Running',
        CURRENT_DATE - INTERVAL '1 day', '08:00:00', 60,
        true, CURRENT_TIMESTAMP - INTERVAL '2 days', 'presencial', 'palermo', 'Palermo'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion
      ) VALUES (
        '${encId}', '${partUserA}', 'Carlos A', 'confirmado', 'individual'
      ) RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        p_encuentro_id := '${encId}',
        p_realization_status := 'realized',
        p_unrealized_reason := NULL,
        p_asistencias := jsonb_build_array(
          jsonb_build_object('participante_id', '${partId}', 'attendance_status', 'reported_absent')
        )
      );
    `);

    const dispId = (await db.query<{ id: string }>(`
      SELECT id FROM public.asistencia_controversias WHERE encuentro_id = '${encId}' AND participante_id = '${partId}';
    `)).rows[0].id;

    // Carlos A responde con fuerza mayor
    await setAuth(partUserA);
    const replyRes = await db.query(`
      SELECT public.responder_controversia_asistencia_seguro(
        p_dispute_id := '${dispId}',
        p_decision := 'force_majeure',
        p_descargo_texto := 'Tuve una urgencia médica familiar a las 7am, di aviso por el chat pero quizás no lo leyeron a tiempo.'
      ) AS res;
    `);

    const reply = replyRes.rows[0].res as any;
    assert.equal(reply.ok, true);
    assert.equal(reply.status, 'in_human_review');
  });

  test('06. Silencio del participante tras 7 días: transición a unverified_timeout, estado unverified sin penalización', async () => {
    await setAuth(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, fecha, hora, duration_minutes,
        is_open, opened_at, modalidad, locality_id, open_public_zone
      ) VALUES (
        '${hostUser}', 'Lectura Compartida', 'Lectura Compartida',
        CURRENT_DATE - INTERVAL '10 days', '17:00:00', 90,
        true, CURRENT_TIMESTAMP - INTERVAL '12 days', 'presencial', 'palermo', 'Palermo'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion
      ) VALUES (
        '${encId}', '${partUserB}', 'Beatriz Silenciosa', 'confirmado', 'individual'
      ) RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        p_encuentro_id := '${encId}',
        p_realization_status := 'realized',
        p_unrealized_reason := NULL,
        p_asistencias := jsonb_build_array(
          jsonb_build_object('participante_id', '${partId}', 'attendance_status', 'reported_absent')
        )
      );
    `);

    // Forzar plazo de vencimiento a pasado
    await db.query(`
      UPDATE public.asistencia_controversias
      SET plazo_respuesta_vence_en = pg_catalog.now() - INTERVAL '1 hour'
      WHERE encuentro_id = '${encId}' AND participante_id = '${partId}';
    `);

    // Ejecutar procesamiento periódico de vencimientos (contexto interno)
    await setAuth(null);
    const procRes = await db.query(`
      SELECT public.procesar_vencimientos_controversias_seguro() AS res;
    `);
    const proc = procRes.rows[0].res as any;
    assert.equal(proc.ok, true);
    assert.equal(proc.processed_count >= 1, true);

    // Verificar que el silencio NO se toma como confesión: permanencia neutral en unverified
    const partCheck = await db.query<{ attendance_status: string; attendance_dispute_status: string }>(`
      SELECT attendance_status, attendance_dispute_status FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partCheck.rows[0].attendance_status, 'unverified', 'El silencio no es admisión de culpa');
    assert.equal(partCheck.rows[0].attendance_dispute_status, 'unverified_timeout');
  });

  test('07. Solicitud de revisión extemporánea posterior al timeout (permitida con causa justificada)', async () => {
    // Beatriz intenta responder después del vencimiento
    const dispRes = await db.query<{ id: string }>(`
      SELECT id FROM public.asistencia_controversias WHERE estado = 'unverified_timeout' LIMIT 1;
    `);
    const dispId = dispRes.rows[0].id;

    await setAuth(partUserB);
    const lateRes = await db.query(`
      SELECT public.responder_controversia_asistencia_seguro(
        p_dispute_id := '${dispId}',
        p_decision := 'request_human_review',
        p_descargo_texto := 'Estuve de viaje sin señal durante 10 días. Quiero solicitar la revisión ahora que regresé.'
      ) AS res;
    `);

    const late = lateRes.rows[0].res as any;
    assert.equal(late.ok, true, 'Se permite descargo posterior con justificación');
    assert.equal(late.status, 'in_human_review');
  });

  test('08. Resolución de moderador: inasistencia justificada -> advance_notice_absent', async () => {
    // Tomamos una controversia en in_human_review
    const dispRes = await db.query<{ id: string; participante_id: string }>(`
      SELECT id, participante_id FROM public.asistencia_controversias
      WHERE estado = 'in_human_review' AND involucrado_id = '${partUserA}'
      LIMIT 1;
    `);
    const dispId = dispRes.rows[0].id;
    const partId = dispRes.rows[0].participante_id;

    await setAuth(modIndependent);
    const modRes = await db.query(`
      SELECT public.resolver_controversia_moderacion_seguro(
        p_dispute_id := '${dispId}',
        p_resolucion := 'justified',
        p_fundamentacion := 'Se constata aviso oportuno o causa de fuerza mayor verificable.'
      ) AS res;
    `);

    const result = modRes.rows[0].res as any;
    assert.equal(result.ok, true);
    assert.equal(result.resolution, 'justified');

    // Participante asentado con advance_notice_absent
    const partCheck = await db.query<{ attendance_status: string }>(`
      SELECT attendance_status FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partCheck.rows[0].attendance_status, 'advance_notice_absent');
  });

  test('09. Resolución de moderador: inasistencia confirmada -> reported_absent', async () => {
    // Creamos un caso nuevo para moderar como confirmed
    await setAuth(hostUser);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, open_public_title, fecha, hora, duration_minutes, is_open, opened_at, modalidad, locality_id, open_public_zone)
      VALUES ('${hostUser}', 'Encuentro Ajedrez', 'Ajedrez', CURRENT_DATE - INTERVAL '1 day', '19:00:00', 120, true, CURRENT_TIMESTAMP - INTERVAL '2 days', 'presencial', 'palermo', 'Palermo')
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion)
      VALUES ('${encId}', '${partUserA}', 'Carlos A', 'confirmado', 'individual')
      RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        p_encuentro_id := '${encId}',
        p_realization_status := 'realized',
        p_asistencias := jsonb_build_array(jsonb_build_object('participante_id', '${partId}', 'attendance_status', 'reported_absent'))
      );
    `);

    const dispId = (await db.query<{ id: string }>(`
      SELECT id FROM public.asistencia_controversias WHERE encuentro_id = '${encId}' AND participante_id = '${partId}';
    `)).rows[0].id;

    // Carlos pide revisión sin justificación válida
    await setAuth(partUserA);
    await db.query(`
      SELECT public.responder_controversia_asistencia_seguro(
        p_dispute_id := '${dispId}',
        p_decision := 'request_human_review',
        p_descargo_texto := 'Me quedé dormido y no tuve ganas de ir.'
      );
    `);

    // Moderador confirma inasistencia sin aviso
    await setAuth(modIndependent);
    const modRes = await db.query(`
      SELECT public.resolver_controversia_moderacion_seguro(
        p_dispute_id := '${dispId}',
        p_resolucion := 'confirmed',
        p_fundamentacion := 'Ausencia admitida sin causa de fuerza mayor ni preaviso.'
      ) AS res;
    `);

    assert.equal((modRes.rows[0].res as any).ok, true);
    const partCheck = await db.query<{ attendance_status: string }>(`
      SELECT attendance_status FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partCheck.rows[0].attendance_status, 'reported_absent');
  });

  test('10. Resolución de moderador: error de registro -> attended', async () => {
    await setAuth(hostUser);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, open_public_title, fecha, hora, duration_minutes, is_open, opened_at, modalidad, locality_id, open_public_zone)
      VALUES ('${hostUser}', 'Club del Libro', 'Libro', CURRENT_DATE - INTERVAL '1 day', '19:00:00', 120, true, CURRENT_TIMESTAMP - INTERVAL '2 days', 'presencial', 'palermo', 'Palermo')
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion)
      VALUES ('${encId}', '${partUserA}', 'Carlos A', 'confirmado', 'individual')
      RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        p_encuentro_id := '${encId}',
        p_realization_status := 'realized',
        p_asistencias := jsonb_build_array(jsonb_build_object('participante_id', '${partId}', 'attendance_status', 'reported_absent'))
      );
    `);

    const dispId = (await db.query<{ id: string }>(`
      SELECT id FROM public.asistencia_controversias WHERE encuentro_id = '${encId}' AND participante_id = '${partId}';
    `)).rows[0].id;

    await setAuth(partUserA);
    await db.query(`
      SELECT public.responder_controversia_asistencia_seguro(
        p_dispute_id := '${dispId}',
        p_decision := 'attended_present',
        p_descargo_texto := 'Estuve presente en la mesa principal.'
      );
    `);

    await setAuth(modIndependent);
    const modRes = await db.query(`
      SELECT public.resolver_controversia_moderacion_seguro(
        p_dispute_id := '${dispId}',
        p_resolucion := 'registration_error',
        p_fundamentacion := 'El anfitrión corrobora que Carlos estuvo presente y hubo confusión con otro asistente.'
      ) AS res;
    `);

    assert.equal((modRes.rows[0].res as any).ok, true);
    const partCheck = await db.query<{ attendance_status: string }>(`
      SELECT attendance_status FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partCheck.rows[0].attendance_status, 'attended', 'Error rectificado asigna asistencia efectiva');
  });

  test('11. Resolución de moderador: evidencia insuficiente -> unverified', async () => {
    // Creamos un caso donde la evidencia no sea concluyente
    await setAuth(hostUser);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, open_public_title, fecha, hora, duration_minutes, is_open, opened_at, modalidad, locality_id, open_public_zone)
      VALUES ('${hostUser}', 'Charla Incierta', 'Charla', CURRENT_DATE - INTERVAL '1 day', '20:00:00', 60, true, CURRENT_TIMESTAMP - INTERVAL '2 days', 'presencial', 'palermo', 'Palermo')
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion)
      VALUES ('${encId}', '${partUserB}', 'Beatriz Incierta', 'confirmado', 'individual')
      RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        p_encuentro_id := '${encId}',
        p_realization_status := 'realized',
        p_asistencias := jsonb_build_array(jsonb_build_object('participante_id', '${partId}', 'attendance_status', 'reported_absent'))
      );
    `);

    const dispId = (await db.query<{ id: string }>(`
      SELECT id FROM public.asistencia_controversias WHERE encuentro_id = '${encId}' AND participante_id = '${partId}';
    `)).rows[0].id;

    await setAuth(partUserB);
    await db.query(`
      SELECT public.responder_controversia_asistencia_seguro(
        p_dispute_id := '${dispId}',
        p_decision := 'attended_present',
        p_descargo_texto := 'Fui pero me fui a los 15 minutos.'
      );
    `);

    await setAuth(modIndependent);
    const modRes = await db.query(`
      SELECT public.resolver_controversia_moderacion_seguro(
        p_dispute_id := '${dispId}',
        p_resolucion := 'insufficient_evidence',
        p_fundamentacion := 'No es posible determinar la permanencia efectiva. Se declara neutral sin penalización.'
      ) AS res;
    `);

    assert.equal((modRes.rows[0].res as any).ok, true);
    const partCheck = await db.query<{ attendance_status: string }>(`
      SELECT attendance_status FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partCheck.rows[0].attendance_status, 'unverified', 'Evidencia insuficiente permanece neutral');
  });

  test('12. Intento de resolución por usuario no moderador -> rechazado con forbidden', async () => {
    const dispRes = await db.query<{ id: string }>(`
      SELECT id FROM public.asistencia_controversias WHERE estado = 'in_human_review' LIMIT 1;
    `);
    if (dispRes.rows.length === 0) return;
    const dispId = dispRes.rows[0].id;

    // Tercero común sin rol de moderador
    await setAuth(thirdPartyUser);
    const modRes = await db.query(`
      SELECT public.resolver_controversia_moderacion_seguro(
        p_dispute_id := '${dispId}',
        p_resolucion := 'justified',
        p_fundamentacion := 'Intento no autorizado'
      ) AS res;
    `);

    assert.equal((modRes.rows[0].res as any).ok, false);
    assert.equal((modRes.rows[0].res as any).error, 'forbidden');
  });

  test('13. Conflicto de interés: moderador que es anfitrión o participante -> rechazado con conflict_of_interest', async () => {
    // Creamos un encuentro donde modConflictHost es el anfitrión
    await setAuth(modConflictHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, open_public_title, fecha, hora, duration_minutes, is_open, opened_at, modalidad, locality_id, open_public_zone)
      VALUES ('${modConflictHost}', 'Encuentro con Conflicto', 'Conflicto', CURRENT_DATE - INTERVAL '1 day', '20:00:00', 60, true, CURRENT_TIMESTAMP - INTERVAL '2 days', 'presencial', 'palermo', 'Palermo')
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion)
      VALUES ('${encId}', '${partUserA}', 'Carlos Part', 'confirmado', 'individual')
      RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        p_encuentro_id := '${encId}',
        p_realization_status := 'realized',
        p_asistencias := jsonb_build_array(jsonb_build_object('participante_id', '${partId}', 'attendance_status', 'reported_absent'))
      );
    `);

    const dispId = (await db.query<{ id: string }>(`
      SELECT id FROM public.asistencia_controversias WHERE encuentro_id = '${encId}' AND participante_id = '${partId}';
    `)).rows[0].id;

    await setAuth(partUserA);
    await db.query(`
      SELECT public.responder_controversia_asistencia_seguro(
        p_dispute_id := '${dispId}',
        p_decision := 'request_human_review',
        p_descargo_texto := 'Solicito revisión independiente'
      );
    `);

    // El host tiene rol de moderador pero ES EL ANFITRIÓN DEL ENCUENTRO -> conflicto de interés
    await setAuth(modConflictHost);
    const resTry = await db.query(`
      SELECT public.resolver_controversia_moderacion_seguro(
        p_dispute_id := '${dispId}',
        p_resolucion := 'confirmed',
        p_fundamentacion := 'Yo mismo soy el host y confirmo que no vino'
      ) AS res;
    `);

    assert.equal((resTry.rows[0].res as any).ok, false);
    assert.equal((resTry.rows[0].res as any).error, 'conflict_of_interest');
  });

  test('14. Idempotencia de resolución y registro durable en auditoría', async () => {
    // Tomamos la controversia resuelta en test 08
    const dispRes = await db.query<{ id: string }>(`
      SELECT id FROM public.asistencia_controversias WHERE estado = 'resolved_justified' LIMIT 1;
    `);
    const dispId = dispRes.rows[0].id;

    // Repetir la misma resolución con idénticos parámetros -> respuesta idempotente ok: true
    await setAuth(modIndependent);
    const repeatRes = await db.query(`
      SELECT public.resolver_controversia_moderacion_seguro(
        p_dispute_id := '${dispId}',
        p_resolucion := 'justified',
        p_fundamentacion := 'Se constata aviso oportuno o causa de fuerza mayor verificable.'
      ) AS res;
    `);

    const rep = repeatRes.rows[0].res as any;
    assert.equal(rep.ok, true);
    assert.equal(rep.idempotent, true, 'Debe retornar idempotent: true en llamada repetida');

    // Verificar que existe el registro en la tabla de auditoría durable
    const auditRes = await db.query<{ accion: string; estado_nuevo: string; actor_id: string }>(`
      SELECT accion, estado_nuevo, actor_id
      FROM public.asistencia_controversia_auditoria
      WHERE controversia_id = '${dispId}' AND accion = 'resolved_by_moderator';
    `);

    assert.equal(auditRes.rows.length >= 1, true, 'Debe existir auditoría durable');
    assert.equal(auditRes.rows[0].actor_id, modIndependent);
  });

  test('15. Aislamiento de privacidad: un tercero no puede consultar la controversia ni su descargo', async () => {
    const dispRes = await db.query<{ id: string }>(`
      SELECT id FROM public.asistencia_controversias LIMIT 1;
    `);
    const dispId = dispRes.rows[0].id;

    // Tercero ajeno sin rol de moderador
    await setAuth(thirdPartyUser);
    const detailRes = await db.query(`
      SELECT public.get_detalle_controversia_seguro(
        p_dispute_id := '${dispId}'
      ) AS res;
    `);

    assert.equal((detailRes.rows[0].res as any).ok, false);
    assert.equal((detailRes.rows[0].res as any).error, 'forbidden');
  });

  test('16. Apertura de controversia de realización por participante confirmado', async () => {
    await setAuth(hostUser);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, open_public_title, fecha, hora, duration_minutes, is_open, opened_at, modalidad, locality_id, open_public_zone)
      VALUES ('${hostUser}', 'Encuentro Fantasma', 'Fantasma', CURRENT_DATE - INTERVAL '1 day', '20:00:00', 60, true, CURRENT_TIMESTAMP - INTERVAL '2 days', 'presencial', 'palermo', 'Palermo')
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion)
      VALUES ('${encId}', '${partUserA}', 'Carlos A', 'confirmado', 'individual');
    `);

    // Participante confirmado reporta que el anfitrión no se presentó
    await setAuth(partUserA);
    const reportRes = await db.query(`
      SELECT public.iniciar_controversia_realizacion_seguro(
        p_encuentro_id := '${encId}',
        p_tipo_controversia := 'host_no_show',
        p_motivo := 'Llegamos 4 personas al punto de encuentro y el organizador nunca apareció ni respondió mensajes.'
      ) AS res;
    `);

    const rep = reportRes.rows[0].res as any;
    assert.equal(rep.ok, true);
    assert.equal(rep.status, 'in_human_review');

    // Comprobar registro en controversias
    const dispCheck = await db.query<{ tipo_controversia: string; iniciado_por: string }>(`
      SELECT tipo_controversia, iniciado_por FROM public.asistencia_controversias WHERE id = '${rep.dispute_id}';
    `);
    assert.equal(dispCheck.rows[0].tipo_controversia, 'host_no_show');
    assert.equal(dispCheck.rows[0].iniciado_por, partUserA);
  });

  test('17. Aclaración del anfitrión ante controversia de realización (sin alterar unilateralmente el estado)', async () => {
    // Tomamos la controversia creada en test 16
    const dispRes = await db.query<{ id: string; encuentro_id: string }>(`
      SELECT id, encuentro_id FROM public.asistencia_controversias WHERE tipo_controversia = 'host_no_show' LIMIT 1;
    `);
    const dispId = dispRes.rows[0].id;

    // El host ingresa su aclaración
    await setAuth(hostUser);
    const clarifRes = await db.query(`
      SELECT public.aportar_aclaracion_controversia_seguro(
        p_dispute_id := '${dispId}',
        p_aclaracion_texto := 'Tuve una demora de 15 minutos por el subte D, luego llegué al bar pero no los vi en la entrada.'
      ) AS res;
    `);

    assert.equal((clarifRes.rows[0].res as any).ok, true);

    // Comprobar que la aclaración está registrada pero el estado sigue en in_human_review (el anfitrión no puede resolverla unilateralmente)
    const dispCheck = await db.query<{ explicacion_contraparte: string; estado: string }>(`
      SELECT explicacion_contraparte, estado FROM public.asistencia_controversias WHERE id = '${dispId}';
    `);
    assert.match(dispCheck.rows[0].explicacion_contraparte, /demora de 15 minutos/);
    assert.equal(dispCheck.rows[0].estado, 'in_human_review', 'La aclaración no cierra la controversia');
  });

  test('18. Multi-seat o acompañante no registrado: no acumulación de antecedentes en identidades inexistentes', async () => {
    await setAuth(hostUser);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, open_public_title, fecha, hora, duration_minutes, is_open, opened_at, modalidad, locality_id, open_public_zone)
      VALUES ('${hostUser}', 'Padel 4 personas', 'Padel', CURRENT_DATE - INTERVAL '1 day', '21:00:00', 90, true, CURRENT_TIMESTAMP - INTERVAL '2 days', 'presencial', 'palermo', 'Palermo')
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Participante anónimo o acompañante sin cuenta (user_id = NULL)
    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion, seat_count)
      VALUES ('${encId}', NULL, 'Acompañante de Juan', 'confirmado', 'individual', 2)
      RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    // El host cierra el encuentro reportando reported_absent para este participante anónimo
    const closureRes = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        p_encuentro_id := '${encId}',
        p_realization_status := 'realized',
        p_asistencias := jsonb_build_array(
          jsonb_build_object('participante_id', '${partId}', 'attendance_status', 'reported_absent')
        )
      ) AS res;
    `);

    assert.equal((closureRes.rows[0].res as any).ok, true);

    // No debe haberse abierto controversia ni notificación ya que no tiene usuario registrado
    const dispCount = await db.query(`
      SELECT count(*) as c FROM public.asistencia_controversias WHERE participante_id = '${partId}';
    `);
    assert.equal(Number(dispCount.rows[0].c), 0, 'No se abren controversias para acompañantes sin cuenta');
  });

  test('19. Integridad de la proyección factual de confianza (métricas fácticas privadas sin scoring)', async () => {
    // Carlos A consulta su historial de asistencia factual
    await setAuth(partUserA);
    const histRes = await db.query(`
      SELECT public.get_historial_asistencia_factual_seguro(p_user_id := '${partUserA}') AS res;
    `);

    const h = histRes.rows[0].res as any;
    assert.equal(h.ok, true);
    assert.equal(typeof h.total_encuentros_participados, 'number');
    assert.equal(typeof h.asistencias_verificadas, 'number');
    assert.equal(typeof h.inasistencias_reportadas_pendientes, 'number');
    assert.equal(typeof h.inasistencias_reconocidas, 'number');
    assert.equal(typeof h.inasistencias_moderadas, 'number');
    assert.equal(typeof h.reportes_rectificados_o_desestimados, 'number');

    // Verificar que un tercero común NO puede ver el historial factual de otro usuario
    await setAuth(thirdPartyUser);
    const forbiddenHist = await db.query(`
      SELECT public.get_historial_asistencia_factual_seguro(p_user_id := '${partUserA}') AS res;
    `);
    assert.equal((forbiddenHist.rows[0].res as any).ok, false);
    assert.equal((forbiddenHist.rows[0].res as any).error, 'forbidden');
  });
});
