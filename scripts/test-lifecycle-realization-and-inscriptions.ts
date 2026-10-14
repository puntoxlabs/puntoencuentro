import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Fase Lifecycle: Motivo de Cancelación, Realización por Mínimo, Cierre de Inscripciones y Reconfirmación', () => {
  let db: PGlite;

  const hostUser = '10000000-0000-0000-0000-000000000001';
  const participantUser1 = '20000000-0000-0000-0000-000000000002';
  const participantUser2 = '20000000-0000-0000-0000-000000000003';
  const applicantUser = '30000000-0000-0000-0000-000000000004';
  const otherUser = '40000000-0000-0000-0000-000000000005';

  before(async () => {
    db = new PGlite();

    // 1. Roles y Mock Auth
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
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
        ('${participantUser1}', 'participant1@test.com'),
        ('${participantUser2}', 'participant2@test.com'),
        ('${applicantUser}', 'applicant@test.com'),
        ('${otherUser}', 'other@test.com')
      ON CONFLICT DO NOTHING;

      -- Tablas base
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

      INSERT INTO public.localidades (id, nombre, ciudad, zona, activo) VALUES
        ('palermo', 'Palermo', 'Buenos Aires', 'CABA', true),
        ('belgrano', 'Belgrano', 'Buenos Aires', 'CABA', true)
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        titulo TEXT NOT NULL,
        open_public_title TEXT,
        descripcion TEXT,
        fecha DATE,
        hora TIME,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        lugar_texto TEXT,
        link_virtual TEXT,
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        host_id UUID NOT NULL REFERENCES auth.users(id),
        public_token UUID DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'activo',
        tema TEXT DEFAULT 'blue',
        tema_invitacion TEXT DEFAULT 'sports',
        invitation_template TEXT,
        date_mode TEXT DEFAULT 'fixed',
        reemplaza_a UUID,
        is_open BOOLEAN NOT NULL DEFAULT false,
        open_description TEXT,
        max_participants INT,
        locality_id TEXT REFERENCES public.localidades(id),
        open_public_zone TEXT,
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        cancelled_by UUID REFERENCES auth.users(id),
        cancellation_reason TEXT,
        min_participants INT,
        realization_status TEXT DEFAULT 'pending',
        inscriptions_closed BOOLEAN DEFAULT false,
        inscriptions_closed_at TIMESTAMPTZ,
        min_confirmed_notified_at TIMESTAMPTZ,
        final_confirmation_notified_at TIMESTAMPTZ,
        min_seats_per_request INT DEFAULT 1,
        moderation_status TEXT DEFAULT 'approved',
        open_activity_canonical TEXT,
        open_activity_matching_eligible BOOLEAN DEFAULT false,
        allow_multi_seat_requests BOOLEAN DEFAULT true,
        max_seats_per_request INT DEFAULT 4,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        nombre_invitado TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        token_invitacion UUID DEFAULT gen_random_uuid(),
        seat_count INT NOT NULL DEFAULT 1,
        reconfirmation_status TEXT DEFAULT 'pending',
        reconfirmed_at TIMESTAMPTZ,
        mensaje_respuesta TEXT,
        tipo_invitacion TEXT DEFAULT 'individual',
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        blocker_id UUID NOT NULL REFERENCES auth.users(id),
        blocked_id UUID NOT NULL REFERENCES auth.users(id),
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        seat_count INT NOT NULL DEFAULT 1,
        estado TEXT NOT NULL DEFAULT 'pending',
        participante_id UUID,
        token_participante UUID,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        resolved_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS public.domain_events_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type TEXT NOT NULL,
        event_version INT NOT NULL DEFAULT 1,
        aggregate_type TEXT NOT NULL,
        aggregate_id UUID NOT NULL,
        actor_user_id UUID REFERENCES auth.users(id),
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        dedup_key TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
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
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
        CONSTRAINT uq_inbox_recipient_dedup UNIQUE (recipient_user_id, dedup_key)
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
          p_dedup_key TEXT DEFAULT NULL,
          p_expires_at TIMESTAMPTZ DEFAULT NULL
      )
      RETURNS JSONB
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $$
      DECLARE
          v_dedup TEXT := COALESCE(p_dedup_key, p_notification_type || ':' || p_target_id || ':' || pg_catalog.gen_random_uuid()::text);
          v_expires TIMESTAMPTZ := COALESCE(p_expires_at, timezone('utc', now()) + INTERVAL '14 days');
          v_inserted_id UUID;
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
              COALESCE(p_payload, '{}'::jsonb),
              v_dedup,
              v_expires
          )
          ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING
          RETURNING id INTO v_inserted_id;

          RETURN pg_catalog.jsonb_build_object(
              'ok', true,
              'inserted', (v_inserted_id IS NOT NULL),
              'notification_id', v_inserted_id
          );
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(p_action TEXT, p_key TEXT)
      RETURNS JSONB AS $$ BEGIN RETURN '{"allowed": true}'::jsonb; END; $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION public.verificar_y_consumir_rate_limit(
          p_usuario_id UUID,
          p_accion TEXT,
          p_max_requests INT,
          p_ventana INTERVAL
      )
      RETURNS JSONB AS $$ BEGIN RETURN '{"allowed": true}'::jsonb; END; $$ LANGUAGE plpgsql;
    `);

    // 2. Aplicar la migración de la fase y su corrección de sintaxis
    const migrationSql = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20261014180000_fase_lifecycle_realization_and_cancellation_reasons.sql'),
      'utf8'
    );
    await db.exec(migrationSql);

    const fixSql = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20261014183000_fix_nullif_syntax_lifecycle.sql'),
      'utf8'
    );
    await db.exec(fixSql);
  });

  const setAuthContext = async (userId: string | null, isAnon: boolean = false) => {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "role": "authenticated", "is_anonymous": ${isAnon}}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    }
  };

  test('1. Cancelación: Motivo es obligatorio si hay afectados y opcional para borradores sin interacción', async () => {
    // Caso A: Encuentro con participante confirmado. Cancelar sin motivo debe fallar.
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open, max_participants)
      VALUES ('Tenis Dobles', '${hostUser}', 'activo', true, 4)
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser1}', 'Carlos', 'confirmado', 1);
    `);

    await setAuthContext(hostUser);
    const failRes = await db.query<{ cancelar_encuentro_seguro: any }>(`
      SELECT public.cancelar_encuentro_seguro('${encId}', '${hostUser}', '') as cancelar_encuentro_seguro;
    `);
    assert.equal(failRes.rows[0].cancelar_encuentro_seguro.ok, false);
    assert.equal(failRes.rows[0].cancelar_encuentro_seguro.error, 'cancellation_reason_required');

    // Caso B: Cancelar con motivo >= 3 caracteres tiene éxito y registra trazabilidad
    const successRes = await db.query<{ cancelar_encuentro_seguro: any }>(`
      SELECT public.cancelar_encuentro_seguro('${encId}', '${hostUser}', 'Canchas inundadas por lluvia') as cancelar_encuentro_seguro;
    `);
    assert.equal(successRes.rows[0].cancelar_encuentro_seguro.ok, true);

    const checkEnc = await db.query<{ estado: string; cancellation_reason: string; cancelled_by: string }>(`
      SELECT estado, cancellation_reason, cancelled_by::text FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(checkEnc.rows[0].estado, 'cancelado');
    assert.equal(checkEnc.rows[0].cancellation_reason, 'Canchas inundadas por lluvia');
    assert.equal(checkEnc.rows[0].cancelled_by, hostUser);

    // Verificar que se emitió notificación crítica al participante
    const notifCheck = await db.query<{ recipient_user_id: string; title: string; body: string }>(`
      SELECT recipient_user_id::text, title, body FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantUser1}' AND notification_type = 'encounter_cancelled_for_participant';
    `);
    assert.equal(notifCheck.rows.length, 1);
    assert.ok(notifCheck.rows[0].body.includes('Canchas inundadas por lluvia'));

    // Caso C: Borrador sin participantes ni solicitudes se cancela sin motivo
    const draftRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open)
      VALUES ('Borrador solo', '${hostUser}', 'activo', false)
      RETURNING id;
    `);
    const draftId = draftRes.rows[0].id;
    const cancelDraftRes = await db.query<{ cancelar_encuentro_seguro: any }>(`
      SELECT public.cancelar_encuentro_seguro('${draftId}', '${hostUser}', NULL) as cancelar_encuentro_seguro;
    `);
    assert.equal(cancelDraftRes.rows[0].cancelar_encuentro_seguro.ok, true);
  });

  test('2. Mínimo de participantes: Transición pending -> confirmed -> pending', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open, max_participants, min_participants, realization_status)
      VALUES ('Fútbol 5', '${hostUser}', 'activo', true, 10, 3, 'pending')
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Crear 2 solicitudes pendientes
    const req1Res = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado)
      VALUES ('${encId}', '${participantUser1}', 'Lucas', 2, 'pending')
      RETURNING id;
    `);
    const req1Id = req1Res.rows[0].id;

    const req2Res = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado)
      VALUES ('${encId}', '${participantUser2}', 'Martín', 1, 'pending')
      RETURNING id;
    `);
    const req2Id = req2Res.rows[0].id;

    // Host aprueba req 1 (2 lugares) -> total 2 confirmed_seats < 3 min -> sigue pending
    await setAuthContext(hostUser);
    const apr1 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`SELECT public.aprobar_solicitud_encuentro_abierto('${req1Id}', '${hostUser}') as aprobar_solicitud_encuentro_abierto;`);
    assert.equal(apr1.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);

    let statusCheck = await db.query<{ realization_status: string }>(`
      SELECT realization_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(statusCheck.rows[0].realization_status, 'pending');

    // Host aprueba req 2 (1 lugar) -> total 3 confirmed_seats >= 3 min -> se realiza (confirmed)
    const apr2 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`SELECT public.aprobar_solicitud_encuentro_abierto('${req2Id}', '${hostUser}') as aprobar_solicitud_encuentro_abierto;`);
    assert.equal(apr2.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);

    statusCheck = await db.query<{ realization_status: string }>(`
      SELECT realization_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(statusCheck.rows[0].realization_status, 'confirmed');

    // Verificar notificación de realización a los participantes
    const notifs = await db.query<{ recipient_user_id: string; title: string }>(`
      SELECT recipient_user_id::text, title FROM public.inbox_notifications
      WHERE target_id = '${encId}' AND notification_type = 'encounter_min_participants_reached';
    `);
    assert.equal(notifs.rows.length, 2);
    assert.ok(notifs.rows[0].title.includes('¡Se hace!'));

    // Si el anfitrión aumenta el mínimo a 4 personas -> cae de nuevo a pending
    const changeMinRes = await db.query<{ set_min_participants_seguro: any }>(`
      SELECT public.set_min_participants_seguro('${encId}', '${hostUser}', 4) as set_min_participants_seguro;
    `);
    assert.equal(changeMinRes.rows[0].set_min_participants_seguro.realization_status, 'pending');

    statusCheck = await db.query<{ realization_status: string }>(`
      SELECT realization_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(statusCheck.rows[0].realization_status, 'pending');
  });

  test('3. Acción "Hacerlo igual" fuerza la realización ante caídas del mínimo', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open, max_participants, min_participants, realization_status)
      VALUES ('Taller de Cerámica', '${hostUser}', 'activo', true, 6, 4, 'pending')
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Participante confirmado con 2 lugares
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser1}', 'Ana', 'confirmado', 2);
    `);

    // Host activa "Hacerlo igual"
    await setAuthContext(hostUser);
    const forceRes = await db.query<{ hacerlo_igual_seguro: any }>(`
      SELECT public.hacerlo_igual_seguro('${encId}', '${hostUser}') as hacerlo_igual_seguro;
    `);
    assert.equal(forceRes.rows[0].hacerlo_igual_seguro.ok, true);
    assert.equal(forceRes.rows[0].hacerlo_igual_seguro.realization_status, 'forced');

    const statusCheck = await db.query<{ realization_status: string }>(`
      SELECT realization_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(statusCheck.rows[0].realization_status, 'forced');

    // Cambiar el mínimo no altera el estado forced
    await db.query(`SELECT public.set_min_participants_seguro('${encId}', '${hostUser}', 5);`);
    const statusCheck2 = await db.query<{ realization_status: string }>(`
      SELECT realization_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(statusCheck2.rows[0].realization_status, 'forced');
  });

  test('4. Cierre y Reapertura de inscripciones', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open, max_participants, realization_status, inscriptions_closed)
      VALUES ('Cena Gourmet', '${hostUser}', 'activo', true, 6, 'confirmed', false)
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser1}', 'Facundo', 'confirmado', 1);
    `);

    // 1. Cerrar inscripciones
    await setAuthContext(hostUser);
    const closeRes = await db.query<{ cerrar_inscripciones_seguro: any }>(`
      SELECT public.cerrar_inscripciones_seguro('${encId}', '${hostUser}') as cerrar_inscripciones_seguro;
    `);
    assert.equal(closeRes.rows[0].cerrar_inscripciones_seguro.ok, true);
    assert.equal(closeRes.rows[0].cerrar_inscripciones_seguro.inscriptions_closed, true);

    // Intentar solicitar sumarse con inscripciones cerradas debe ser bloqueado
    await setAuthContext(applicantUser);
    const joinRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Nuevo Solicitante', 'Quiero ir', NULL, 1) as solicitar_sumarse_encuentro_abierto;
    `);
    assert.equal(joinRes.rows[0].solicitar_sumarse_encuentro_abierto.ok, false);
    assert.equal(joinRes.rows[0].solicitar_sumarse_encuentro_abierto.error, 'inscriptions_closed');

    // 2. Reabrir inscripciones
    await setAuthContext(hostUser);
    const reopenRes = await db.query<{ reabrir_inscripciones_seguro: any }>(`
      SELECT public.reabrir_inscripciones_seguro('${encId}', '${hostUser}') as reabrir_inscripciones_seguro;
    `);
    assert.equal(reopenRes.rows[0].reabrir_inscripciones_seguro.ok, true);
    assert.equal(reopenRes.rows[0].reabrir_inscripciones_seguro.inscriptions_closed, false);

    // Ahora la solicitud procede
    await setAuthContext(applicantUser);
    const joinRes2 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Nuevo Solicitante', 'Quiero ir', NULL, 1) as solicitar_sumarse_encuentro_abierto;
    `);
    assert.equal(joinRes2.rows[0].solicitar_sumarse_encuentro_abierto.ok, true);
  });

  test('5. Reconfirmación de asistencia: confirm vs decline (libera cupos)', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open, max_participants, min_participants, realization_status, inscriptions_closed)
      VALUES ('Asado de Domingo', '${hostUser}', 'activo', true, 6, 2, 'confirmed', true)
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count, reconfirmation_status)
      VALUES
        ('${encId}', '${participantUser1}', 'Valeria', 'confirmado', 1, 'pending'),
        ('${encId}', '${participantUser2}', 'Gonzalo', 'confirmado', 1, 'pending');
    `);

    // Participante 1 confirma
    await setAuthContext(participantUser1);
    const reconf1 = await db.query<{ reconfirmar_asistencia_seguro: any }>(`
      SELECT public.reconfirmar_asistencia_seguro('${encId}', 'confirm') as reconfirmar_asistencia_seguro;
    `);
    assert.equal(reconf1.rows[0].reconfirmar_asistencia_seguro.ok, true);
    assert.equal(reconf1.rows[0].reconfirmar_asistencia_seguro.reconfirmation_status, 'confirmed');

    // Participante 2 desiste ('decline') -> libera cupos (seat_count = 0)
    await setAuthContext(participantUser2);
    const reconf2 = await db.query<{ reconfirmar_asistencia_seguro: any }>(`
      SELECT public.reconfirmar_asistencia_seguro('${encId}', 'decline') as reconfirmar_asistencia_seguro;
    `);
    assert.equal(reconf2.rows[0].reconfirmar_asistencia_seguro.ok, true);
    assert.equal(reconf2.rows[0].reconfirmar_asistencia_seguro.reconfirmation_status, 'declined');

    // Verificar que el participante 2 pasó a cancelado (liberando cupos) y reconfirmation_status = declined
    const part2 = await db.query<{ estado: string; reconfirmation_status: string }>(`
      SELECT estado, reconfirmation_status FROM public.participantes WHERE encuentro_id = '${encId}' AND user_id = '${participantUser2}';
    `);
    assert.equal(part2.rows[0].estado, 'cancelado');
    assert.equal(part2.rows[0].reconfirmation_status, 'declined');

    // Como ahora solo queda 1 confirmed seat y el mínimo era 2, realization_status debe revertir a pending
    const statusCheck = await db.query<{ realization_status: string }>(`
      SELECT realization_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(statusCheck.rows[0].realization_status, 'pending');
  });

  test('6. Invariante: Bloqueo de reapertura de encuentros cancelados', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open, max_participants, cancellation_reason)
      VALUES ('Cancelado Previo', '${hostUser}', 'cancelado', false, 5, 'Cancelado')
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await setAuthContext(hostUser);
    const reopenRes = await db.query<{ reabrir_inscripciones_seguro: any }>(`
      SELECT public.reabrir_inscripciones_seguro('${encId}', '${hostUser}') as reabrir_inscripciones_seguro;
    `);
    assert.equal(reopenRes.rows[0].reabrir_inscripciones_seguro.ok, false);
    assert.equal(reopenRes.rows[0].reabrir_inscripciones_seguro.error, 'cannot_reopen_cancelled_encounter');
  });

  test('7. Discovery: Encuentros completos permanecen visibles como social proof con filtro opcional', async () => {
    // Encuentro completo
    const fullEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, open_public_title, host_id, estado, is_open, max_participants, locality_id, moderation_status)
      VALUES ('Concierto Lleno', 'Concierto Lleno', '${hostUser}', 'activo', true, 2, 'palermo', 'approved')
      RETURNING id;
    `);
    const fullId = fullEnc.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${fullId}', '${participantUser1}', 'Mario', 'confirmado', 2);
    `);

    // Encuentro con lugares disponibles
    const availEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, open_public_title, host_id, estado, is_open, max_participants, locality_id, moderation_status)
      VALUES ('Pádel Abierto', 'Pádel Abierto', '${hostUser}', 'activo', true, 4, 'palermo', 'approved')
      RETURNING id;
    `);
    const availId = availEnc.rows[0].id;

    await setAuthContext(otherUser);

    // Por defecto (solo_disponibles = false): ambos encuentros aparecen
    const discAll = await db.query<{ get_discovery_encuentros_abiertos: any }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['palermo']::text[], false) as get_discovery_encuentros_abiertos;
    `);
    const listAll = discAll.rows[0].get_discovery_encuentros_abiertos;
    const idsAll = listAll.map((e: any) => e.id);
    assert.ok(idsAll.includes(fullId));
    assert.ok(idsAll.includes(availId));

    // Con filtro solo_disponibles = true: el encuentro completo NO aparece
    const discAvail = await db.query<{ get_discovery_encuentros_abiertos: any }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['palermo']::text[], true) as get_discovery_encuentros_abiertos;
    `);
    const listAvail = discAvail.rows[0].get_discovery_encuentros_abiertos;
    const idsAvail = listAvail.map((e: any) => e.id);
    assert.ok(!idsAvail.includes(fullId));
    assert.ok(idsAvail.includes(availId));
  });
});
