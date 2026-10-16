/**
 * Suite de Pruebas: H9 / H10 — Bajas Voluntarias, Cupos y Sincronización de Participantes
 * Verificación en motor PostgreSQL en memoria (PGlite).
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('H9 / H10: Bajas Voluntarias, Cupos y Sincronización de Participantes', () => {
  let db: PGlite;

  const hostUser = '10000000-0000-0000-0000-000000000001';
  const participantUser1 = '20000000-0000-0000-0000-000000000002';
  const participantUser2 = '20000000-0000-0000-0000-000000000003';
  const participantUser3 = '20000000-0000-0000-0000-000000000004';
  const applicantUser1 = '30000000-0000-0000-0000-000000000005';
  const outsiderUser = '40000000-0000-0000-0000-000000000006';

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
        ('${participantUser3}', 'participant3@test.com'),
        ('${applicantUser1}', 'applicant1@test.com'),
        ('${outsiderUser}', 'outsider@test.com')
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
        ('recoleta', 'Recoleta', 'Buenos Aires', 'CABA', true)
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
        moderated_at TIMESTAMPTZ,
        moderation_reason TEXT,
        moderation_decision_source TEXT,
        open_activity_canonical TEXT,
        open_activity_matching_eligible BOOLEAN DEFAULT false,
        allow_multi_seat_requests BOOLEAN DEFAULT true,
        max_seats_per_request INT DEFAULT 4,
        coordination_status TEXT DEFAULT 'pending',
        post_event_active_minutes INT DEFAULT 45,
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
        respondido_en TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );


      CREATE TABLE IF NOT EXISTS public.participante_disponibilidades (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        participante_id UUID NOT NULL REFERENCES public.participantes(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        disponible BOOLEAN NOT NULL DEFAULT true
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
        updated_at TIMESTAMPTZ,
        UNIQUE (encuentro_id, usuario_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_solicitudes_pendientes_unicas
        ON public.solicitudes_encuentro_abierto(encuentro_id, usuario_id)
        WHERE estado = 'pending';

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        blocker_id UUID NOT NULL REFERENCES auth.users(id),
        blocked_id UUID NOT NULL REFERENCES auth.users(id),
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        PRIMARY KEY (blocker_id, blocked_id)
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

      CREATE OR REPLACE FUNCTION public.verificar_y_consumir_rate_limit(
          p_user_id UUID,
          p_action TEXT,
          p_limit INT,
          p_window INTERVAL
      )
      RETURNS JSONB AS $$
      BEGIN
          RETURN pg_catalog.jsonb_build_object('allowed', true);
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 2. Cargar migraciones vigentes
    const mParity = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261001080000_normalize_production_schema_parity.sql'), 'utf8');
    await db.exec(mParity);

    const mLifecycle18 = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261014180000_fase_lifecycle_realization_and_cancellation_reasons.sql'), 'utf8');
    await db.exec(mLifecycle18);

    const mLifecycle = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261014190000_harden_lifecycle_rpc_concurrency_and_invariants.sql'), 'utf8');
    await db.exec(mLifecycle);

    // 3. Cargar migración P0
    const mP0 = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261016150000_harden_actualizar_encuentro_and_critical_notifications.sql'), 'utf8');
    await db.exec(mP0);

    // 4. Cargar NUESTRA nueva migración H9/H10
    const mH9H10 = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261016180000_open_encounter_withdrawal_and_sync_h9_h10.sql'), 'utf8');
    await db.exec(mH9H10);

    // Otorgar permisos sobre tablas y funciones en el entorno simulado
    await db.exec(`
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon, service_role;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, anon, service_role;
      GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticated, anon, service_role;
    `);
  });

  const setAuthContext = async (userId: string | null, isAnon: boolean = false) => {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "role": "authenticated", "is_anonymous": ${isAnon}}', false);`);
      await db.query(`SET ROLE authenticated;`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
      await db.query(`SET ROLE anon;`);
    }
  };

  // Helper para crear un encuentro abierto con participantes y solicitudes
  const setupOpenEncounter = async (opts: {
    maxParticipants: number;
    minParticipants?: number;
    inscriptionsClosed?: boolean;
    realizationStatus?: string;
  }) => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, host_id, estado, is_open, max_participants,
        min_participants, inscriptions_closed, realization_status
      ) VALUES (
        'Pádel Palermo', 'Pádel Abierto', '${hostUser}', 'activo', true, ${opts.maxParticipants},
        ${opts.minParticipants !== undefined ? opts.minParticipants : 'NULL'},
        ${opts.inscriptionsClosed ? true : false},
        '${opts.realizationStatus || 'pending'}'
      ) RETURNING id;
    `);
    return encRes.rows[0].id;
  };

  // ============================================================
  // BLOQUE 1: BAJA VOLUNTARIA CON INSCRIPCIONES ABIERTAS (H10)
  // ============================================================

  test('H10.1: Participante confirmado puede desistir mientras las inscripciones siguen ABIERTAS', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 4 });

    // Insertar participante confirmado
    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count, reconfirmation_status)
      VALUES ('${encId}', '${participantUser1}', 'Carlos', 'confirmado', 1, 'pending')
      RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    // Insertar solicitud asociada
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, seat_count, participante_id)
      VALUES ('${encId}', '${participantUser1}', 'Carlos', 'approved', 1, '${partId}');
    `);

    // Carlos desiste voluntariamente
    await setAuthContext(participantUser1);
    const res = await db.query<{ desistir_encuentro_abierto_seguro: any }>(`
      SELECT public.desistir_encuentro_abierto_seguro('${encId}', 'No llego con los tiempos');
    `);

    const result = res.rows[0].desistir_encuentro_abierto_seguro;
    assert.equal(result.ok, true);
    assert.equal(result.decision, 'decline');
    assert.equal(result.reconfirmation_status, 'declined');
    assert.equal(result.released_seats, 1);

    // Verificar en DB: participante pasa a 'cancelado'
    const partCheck = await db.query<{ estado: string; reconfirmation_status: string; mensaje_respuesta: string }>(`
      SELECT estado, reconfirmation_status, mensaje_respuesta FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partCheck.rows[0].estado, 'cancelado');
    assert.equal(partCheck.rows[0].reconfirmation_status, 'declined');
    assert.equal(partCheck.rows[0].mensaje_respuesta, 'No llego con los tiempos');

    // Verificar en DB (H9): solicitud pasa a 'cancelled'
    const solCheck = await db.query<{ estado: string }>(`
      SELECT estado FROM public.solicitudes_encuentro_abierto WHERE participante_id = '${partId}';
    `);
    assert.equal(solCheck.rows[0].estado, 'cancelled');
  });

  // ============================================================
  // BLOQUE 2: BAJA VOLUNTARIA CON INSCRIPCIONES CERRADAS (H10)
  // ============================================================

  test('H10.2: Participante confirmado puede desistir cuando las inscripciones están CERRADAS', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 4, inscriptionsClosed: true, realizationStatus: 'confirmed' });

    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count, reconfirmation_status)
      VALUES ('${encId}', '${participantUser2}', 'Lucía', 'confirmado', 1, 'pending')
      RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    await setAuthContext(participantUser2);
    const res = await db.query<{ reconfirmar_asistencia_seguro: any }>(`
      SELECT public.reconfirmar_asistencia_seguro('${encId}', 'decline', 'Fiebre alta');
    `);

    const result = res.rows[0].reconfirmar_asistencia_seguro;
    assert.equal(result.ok, true);
    assert.equal(result.decision, 'decline');
    assert.equal(result.reconfirmation_status, 'declined');

    const partCheck = await db.query<{ estado: string }>(`
      SELECT estado FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partCheck.rows[0].estado, 'cancelado');
  });

  // ============================================================
  // BLOQUE 3: LIBERACIÓN DE CUPOS MULTI-SEAT
  // ============================================================

  test('H9.3: Liberación de cupos multi-seat (seat_count = 3) al desistir', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 6 });

    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser1}', 'Familia Pérez', 'confirmado', 3)
      RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    await setAuthContext(participantUser1);
    const res = await db.query<{ desistir_encuentro_abierto_seguro: any }>(`
      SELECT public.desistir_encuentro_abierto_seguro('${encId}');
    `);

    assert.equal(res.rows[0].desistir_encuentro_abierto_seguro.released_seats, 3);

    // Cupos confirmados restantes deben ser 0
    const seatsCheck = await db.query<{ total: number }>(`
      SELECT COALESCE(SUM(seat_count), 0)::int as total FROM public.participantes
      WHERE encuentro_id = '${encId}' AND estado IN ('confirmado', 'asistio');
    `);
    assert.equal(seatsCheck.rows[0].total, 0);
  });

  // ============================================================
  // BLOQUE 4: NOTIFICACIÓN OBLIGATORIA AL ANFITRIÓN
  // ============================================================

  test('H9.4: Emisión de notificación al anfitrión en la misma transacción (encounter_participant_withdrawn)', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 5 });

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser3}', 'Martín', 'confirmado', 2);
    `);

    await setAuthContext(participantUser3);
    await db.query(`
      SELECT public.desistir_encuentro_abierto_seguro('${encId}', 'Se me complicó el horario');
    `);

    // Verificar notificación al host
    const notifs = await db.query<{
      recipient_user_id: string;
      notification_type: string;
      body: string;
      payload: any;
    }>(`
      SELECT recipient_user_id, notification_type, body, payload
      FROM public.inbox_notifications
      WHERE recipient_user_id = '${hostUser}'
        AND target_id = '${encId}'
        AND notification_type = 'encounter_participant_withdrawn';
    `);

    assert.equal(notifs.rows.length, 1);
    assert.equal(notifs.rows[0].notification_type, 'encounter_participant_withdrawn');
    assert.ok(notifs.rows[0].body.includes('Martín'));
    assert.ok(notifs.rows[0].body.includes('2 lugares'));
    assert.equal(notifs.rows[0].payload.cancellation_reason, 'Se me complicó el horario');
    assert.equal(notifs.rows[0].payload.freed_seats, 2);
  });

  // ============================================================
  // BLOQUE 5: CAÍDA POR DEBAJO DEL MÍNIMO Y NOTIFICACIÓN UNIFICADA
  // ============================================================

  test('H9.5: Si la baja hace caer por debajo del mínimo, revierte a pending y unifica notificación al anfitrión sin duplicado', async () => {
    // Mínimo de 3 participantes, actualmente con 3
    const encId = await setupOpenEncounter({ maxParticipants: 5, minParticipants: 3, realizationStatus: 'confirmed' });

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count) VALUES
        ('${encId}', '${participantUser1}', 'P1', 'confirmado', 2),
        ('${encId}', '${participantUser2}', 'P2', 'confirmado', 1);
    `);

    // P1 se baja con 2 lugares -> quedan 1 de 3 mínimos -> cae por debajo del mínimo
    await setAuthContext(participantUser1);
    const res = await db.query<{ desistir_encuentro_abierto_seguro: any }>(`
      SELECT public.desistir_encuentro_abierto_seguro('${encId}');
    `);

    assert.equal(res.rows[0].desistir_encuentro_abierto_seguro.fell_below_min, true);

    // Verificar estado de realización del encuentro
    const encCheck = await db.query<{ realization_status: string }>(`
      SELECT realization_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(encCheck.rows[0].realization_status, 'pending');

    // Verificar notificaciones recibidas por el anfitrión para este encuentro:
    // debe tener exactamente 1 aviso (la baja unificada con aviso de caída del mínimo)
    const hostNotifs = await db.query<{ notification_type: string; body: string }>(`
      SELECT notification_type, body FROM public.inbox_notifications
      WHERE recipient_user_id = '${hostUser}' AND target_id = '${encId}';
    `);


    assert.equal(hostNotifs.rows.length, 1);
    assert.equal(hostNotifs.rows[0].notification_type, 'encounter_participant_withdrawn');
    assert.ok(hostNotifs.rows[0].body.includes('quedar por debajo del mínimo'));

    // Los participantes confirmados restantes (P2) reciben aviso de caída de mínimo
    const p2Notifs = await db.query<{ notification_type: string }>(`
      SELECT notification_type FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantUser2}';
    `);
    assert.equal(p2Notifs.rows.length, 1);
    assert.equal(p2Notifs.rows[0].notification_type, 'encounter_below_min_participants');
  });

  // ============================================================
  // BLOQUE 6: IDEMPOTENCIA ANTE DOBLE INVOCACIÓN
  // ============================================================

  test('H9.6: Idempotencia: segunda llamada tras haber desistido no libera cupos dobles ni re-notifica', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 4 });

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser1}', 'Lucas', 'confirmado', 1);
    `);

    await setAuthContext(participantUser1);
    // Primera llamada
    await db.query(`SELECT public.desistir_encuentro_abierto_seguro('${encId}');`);

    const notifsAfterFirst = await db.query(`SELECT count(*)::int as c FROM public.inbox_notifications;`);
    const count1 = notifsAfterFirst.rows[0].c;

    // Segunda llamada
    const res2 = await db.query<{ desistir_encuentro_abierto_seguro: any }>(`
      SELECT public.desistir_encuentro_abierto_seguro('${encId}');
    `);

    assert.equal(res2.rows[0].desistir_encuentro_abierto_seguro.ok, true);
    assert.equal(res2.rows[0].desistir_encuentro_abierto_seguro.already_withdrawn, true);
    assert.equal(res2.rows[0].desistir_encuentro_abierto_seguro.released_seats, 0);

    const notifsAfterSecond = await db.query(`SELECT count(*)::int as c FROM public.inbox_notifications;`);
    assert.equal(notifsAfterSecond.rows[0].c, count1); // Sin notificaciones duplicadas
  });

  // ============================================================
  // BLOQUE 7: PRIVACIDAD Y LONGITUD DEL MOTIVO OPCIONAL
  // ============================================================

  test('H9.7: Validación de longitud máxima del motivo (280 caracteres)', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 4 });

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser1}', 'Ana', 'confirmado', 1);
    `);

    await setAuthContext(participantUser1);

    const longMotivo = 'a'.repeat(281);
    const res = await db.query<{ desistir_encuentro_abierto_seguro: any }>(`
      SELECT public.desistir_encuentro_abierto_seguro('${encId}', '${longMotivo}');
    `);

    assert.equal(res.rows[0].desistir_encuentro_abierto_seguro.ok, false);
    assert.equal(res.rows[0].desistir_encuentro_abierto_seguro.error, 'motivo_too_long');
  });

  test('H9.8: Privacidad del motivo: visible para el host pero oculto para el público', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 4 });

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser1}', 'Privado', 'confirmado', 1);
    `);

    await setAuthContext(participantUser1);
    await db.query(`SELECT public.desistir_encuentro_abierto_seguro('${encId}', 'Razón confidencial personal');`);

    // Host consulta participantes por RPC seguro: ve el motivo
    await setAuthContext(hostUser);
    const hostPartsRes = await db.query<{ get_participantes_host_seguro: any }>(`
      SELECT public.get_participantes_host_seguro('${encId}', '${hostUser}');
    `);
    const hostParts = hostPartsRes.rows[0].get_participantes_host_seguro;
    const pRecord = hostParts.find((p: any) => p.user_id === participantUser1);
    assert.equal(pRecord.mensaje_respuesta, 'Razón confidencial personal');

    // Tercero consulta detalle autorizado de participante: es rechazado por unauthorized
    await setAuthContext(outsiderUser);
    const outsiderRes = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${encId}');
    `);
    assert.equal(outsiderRes.rows[0].get_encuentro_participante_autorizado.ok, false);
    assert.equal(outsiderRes.rows[0].get_encuentro_participante_autorizado.error, 'unauthorized');
  });

  // ============================================================
  // BLOQUE 8: RE-POSTULACIÓN POST-BAJA (SECUENCIA COMPLETA DE 9 PASOS, HISTORIAL, TOKENS, COOLDOWN Y CONCURRENCIA)
  // ============================================================

  test('H9.9: Secuencia completa de 9 pasos por RPC: solicitar (2 cupos) -> aprobar -> confirmado -> desistir -> cancelado/cancelled -> re-solicitar (3 cupos) -> pending -> aprobar -> confirmado (3 cupos)', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 5, minParticipants: 2, realizationStatus: 'pending' });
    await db.query(`DELETE FROM public.inbox_notifications;`);
    await db.query(`DELETE FROM public.domain_events_outbox;`);

    // PASO 1: Usuario solicita sumarse con 2 cupos
    await setAuthContext(participantUser1);
    const req1Res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encId}',
        'Reaplicante Ciclo 1',
        'Vamos con mi pareja (2 lugares)',
        '${participantUser1}',
        2
      );
    `);
    assert.equal(req1Res.rows[0].solicitar_sumarse_encuentro_abierto.ok, true);
    assert.equal(req1Res.rows[0].solicitar_sumarse_encuentro_abierto.seat_count, 2);
    const req1Id = req1Res.rows[0].solicitar_sumarse_encuentro_abierto.request_id;
    assert.equal(req1Id, req1Res.rows[0].solicitar_sumarse_encuentro_abierto.solicitud_id);
    assert.ok(req1Id);

    // PASO 2: Organizador aprueba la primera solicitud
    await setAuthContext(hostUser);
    const app1Res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${req1Id}', '${hostUser}');
    `);
    assert.equal(app1Res.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);
    assert.equal(app1Res.rows[0].aprobar_solicitud_encuentro_abierto.confirmed_seats, 2);
    assert.equal(app1Res.rows[0].aprobar_solicitud_encuentro_abierto.available_slots, 3);
    const partIdCycle1 = app1Res.rows[0].aprobar_solicitud_encuentro_abierto.participante_id;
    const tokenCycle1 = app1Res.rows[0].aprobar_solicitud_encuentro_abierto.token_invitacion;
    assert.ok(tokenCycle1);

    // PASO 3: Usuario queda confirmado con 2 cupos y acceso autorizado
    await setAuthContext(participantUser1);
    const authCycle1 = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${encId}');
    `);
    assert.equal(authCycle1.rows[0].get_encuentro_participante_autorizado.ok, true);
    assert.equal(authCycle1.rows[0].get_encuentro_participante_autorizado.seat_count, 2);

    // Confirmar asistencia antes de desistir para verificar luego el reset de reconfirmación
    await db.query(`SELECT public.reconfirmar_asistencia_seguro('${encId}', 'confirm');`);

    // PASO 4: Usuario desiste voluntariamente con motivo privado para el organizador
    const withdraw1Res = await db.query<{ desistir_encuentro_abierto_seguro: any }>(`
      SELECT public.desistir_encuentro_abierto_seguro('${encId}', 'Nos surgió un viaje imprevisto');
    `);
    assert.equal(withdraw1Res.rows[0].desistir_encuentro_abierto_seguro.ok, true);
    assert.equal(withdraw1Res.rows[0].desistir_encuentro_abierto_seguro.released_seats, 2);
    assert.equal(withdraw1Res.rows[0].desistir_encuentro_abierto_seguro.fell_below_min, true);

    // PASO 5: Participante pasa a 'cancelado', solicitud 1 pasa a 'cancelled' y token 1 queda invalidado
    const partAfterWithdraw = await db.query<{ estado: string; reconfirmation_status: string; token_invitacion: string; mensaje_respuesta: string }>(`
      SELECT estado, reconfirmation_status, token_invitacion, mensaje_respuesta
      FROM public.participantes WHERE id = '${partIdCycle1}';
    `);
    assert.equal(partAfterWithdraw.rows[0].estado, 'cancelado');
    assert.equal(partAfterWithdraw.rows[0].reconfirmation_status, 'declined');
    assert.equal(partAfterWithdraw.rows[0].mensaje_respuesta, 'Nos surgió un viaje imprevisto');
    assert.notEqual(partAfterWithdraw.rows[0].token_invitacion, tokenCycle1, 'El token del ciclo 1 debe rotarse al desistir');

    const sol1AfterWithdraw = await db.query<{ estado: string; token_participante: string | null; resolved_at: string | null }>(`
      SELECT estado, token_participante, resolved_at FROM public.solicitudes_encuentro_abierto WHERE id = '${req1Id}';
    `);
    assert.equal(sol1AfterWithdraw.rows[0].estado, 'cancelled');
    assert.equal(sol1AfterWithdraw.rows[0].token_participante, null, 'token_participante de la solicitud cancelada debe anularse');
    assert.ok(sol1AfterWithdraw.rows[0].resolved_at);

    // Verificar que el token antiguo del Ciclo 1 no permite acceder por get_encuentros_participados_por_tokens
    const byOldToken = await db.query<{ get_encuentros_participados_por_tokens: any[] }>(`
      SELECT public.get_encuentros_participados_por_tokens(ARRAY['${tokenCycle1}']);
    `);
    assert.equal(byOldToken.rows[0].get_encuentros_participados_por_tokens.length, 0, 'Token antiguo no debe devolver el encuentro tras desistir');

    // PASO 6: Usuario vuelve a solicitar participación con 3 cupos (sin violar UNIQUE ni borrar historial)
    const req2Res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encId}',
        'Reaplicante Ciclo 2',
        'Se canceló el viaje, ahora somos 3!',
        '${participantUser1}',
        3
      );
    `);
    assert.equal(req2Res.rows[0].solicitar_sumarse_encuentro_abierto.ok, true);
    assert.equal(req2Res.rows[0].solicitar_sumarse_encuentro_abierto.seat_count, 3);
    const req2Id = req2Res.rows[0].solicitar_sumarse_encuentro_abierto.request_id;
    assert.ok(req2Id);
    assert.notEqual(req2Id, req1Id, 'La segunda postulación debe tener su propio ID de ciclo');

    // PASO 7: Nueva postulación queda 'pending' y NO restaura automáticamente la participación antes de que el host apruebe
    const miSolPending = await db.query<{ get_mi_solicitud_encuentro_abierto: any }>(`
      SELECT public.get_mi_solicitud_encuentro_abierto('${encId}', '${participantUser1}');
    `);
    assert.equal(miSolPending.rows[0].get_mi_solicitud_encuentro_abierto.ok, true);
    assert.equal(miSolPending.rows[0].get_mi_solicitud_encuentro_abierto.has_request, true);
    assert.equal(miSolPending.rows[0].get_mi_solicitud_encuentro_abierto.request_id, req2Id);
    assert.equal(miSolPending.rows[0].get_mi_solicitud_encuentro_abierto.estado, 'pending');
    assert.equal(miSolPending.rows[0].get_mi_solicitud_encuentro_abierto.seat_count, 3);

    const authWhilePending = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${encId}');
    `);
    assert.equal(authWhilePending.rows[0].get_encuentro_participante_autorizado.ok, false);
    assert.equal(authWhilePending.rows[0].get_encuentro_participante_autorizado.error, 'unauthorized');

    const partWhilePending = await db.query<{ estado: string; mensaje_respuesta: string }>(`
      SELECT estado, mensaje_respuesta FROM public.participantes WHERE id = '${partIdCycle1}';
    `);
    assert.equal(partWhilePending.rows[0].estado, 'cancelado', 'No debe restaurarse participación sin aprobación del host');
    assert.equal(partWhilePending.rows[0].mensaje_respuesta, 'Nos surgió un viaje imprevisto', 'El motivo de baja previo sigue intacto mientras está pendiente');

    // PASO 8: Organizador aprueba nuevamente la segunda solicitud
    await setAuthContext(hostUser);
    const app2Res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${req2Id}', '${hostUser}');
    `);
    assert.equal(app2Res.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);
    assert.equal(app2Res.rows[0].aprobar_solicitud_encuentro_abierto.confirmed_seats, 3);
    assert.equal(app2Res.rows[0].aprobar_solicitud_encuentro_abierto.available_slots, 2);
    const tokenCycle2 = app2Res.rows[0].aprobar_solicitud_encuentro_abierto.token_invitacion;
    assert.notEqual(tokenCycle2, tokenCycle1, 'El ciclo 2 debe emitir un nuevo token_invitacion');

    // PASO 9: Usuario vuelve a quedar confirmado con los 3 cupos solicitados en esta segunda ocasión
    const finalPart = await db.query<{
      id: string;
      estado: string;
      seat_count: number;
      reconfirmation_status: string;
      reconfirmed_at: string | null;
      mensaje_respuesta: string;
      token_invitacion: string;
    }>(`
      SELECT id, estado, seat_count, reconfirmation_status, reconfirmed_at, mensaje_respuesta, token_invitacion
      FROM public.participantes
      WHERE encuentro_id = '${encId}' AND user_id = '${participantUser1}';
    `);
    assert.equal(finalPart.rows.length, 1);
    assert.equal(finalPart.rows[0].id, partIdCycle1);
    assert.equal(finalPart.rows[0].estado, 'confirmado');
    assert.equal(finalPart.rows[0].seat_count, 3);
    assert.equal(finalPart.rows[0].reconfirmation_status, 'pending');
    assert.equal(finalPart.rows[0].reconfirmed_at, null);
    assert.equal(finalPart.rows[0].mensaje_respuesta, 'Se canceló el viaje, ahora somos 3!');
    assert.equal(finalPart.rows[0].token_invitacion, tokenCycle2);

    // Verificar trazabilidad de ambos ciclos en solicitudes_encuentro_abierto (no se borró la fila cancelled del Ciclo 1
    // y el motivo de la primera baja persiste en motivo_baja sin sobrescribir el mensaje original de ninguna solicitud)
    const allSolicitudes = await db.query<{
      id: string;
      estado: string;
      seat_count: number;
      token_participante: string | null;
      mensaje: string | null;
      motivo_baja: string | null;
    }>(`
      SELECT id, estado, seat_count, token_participante, mensaje, motivo_baja
      FROM public.solicitudes_encuentro_abierto
      WHERE encuentro_id = '${encId}' AND usuario_id = '${participantUser1}'
      ORDER BY created_at ASC;
    `);
    assert.equal(allSolicitudes.rows.length, 2, 'Deben conservarse los registros de ambos ciclos');
    assert.equal(allSolicitudes.rows[0].id, req1Id);
    assert.equal(allSolicitudes.rows[0].estado, 'cancelled');
    assert.equal(allSolicitudes.rows[0].seat_count, 2);
    assert.equal(allSolicitudes.rows[0].token_participante, null);
    assert.equal(allSolicitudes.rows[0].mensaje, 'Vamos con mi pareja (2 lugares)', 'El mensaje original de la Solicitud 1 no debe sobrescribirse');
    assert.equal(allSolicitudes.rows[0].motivo_baja, 'Nos surgió un viaje imprevisto', 'El motivo de la primera baja debe persistir en la Solicitud 1 incluso tras la segunda aprobación');

    assert.equal(allSolicitudes.rows[1].id, req2Id);
    assert.equal(allSolicitudes.rows[1].estado, 'approved');
    assert.equal(allSolicitudes.rows[1].seat_count, 3);
    assert.equal(allSolicitudes.rows[1].token_participante, tokenCycle2);
    assert.equal(allSolicitudes.rows[1].mensaje, 'Se canceló el viaje, ahora somos 3!', 'El mensaje de la Solicitud 2 debe conservarse intacto');
    assert.equal(allSolicitudes.rows[1].motivo_baja, null, 'La Solicitud 2 aprobada no debe tener motivo_baja');

    // Verificar que el organizador autorizado ve el motivo histórico por ciclo y en participantes, y terceros no tienen acceso
    await setAuthContext(hostUser);
    const hostSolsRes = await db.query<{ get_solicitudes_host_seguro: any }>(`
      SELECT public.get_solicitudes_host_seguro('${encId}', '${hostUser}');
    `);
    assert.equal(hostSolsRes.rows[0].get_solicitudes_host_seguro.ok, true);
    const hostSols = hostSolsRes.rows[0].get_solicitudes_host_seguro.solicitudes;
    const hostSol1 = hostSols.find((s: any) => s.id === req1Id);
    const hostSol2 = hostSols.find((s: any) => s.id === req2Id);
    assert.equal(hostSol1.mensaje, 'Vamos con mi pareja (2 lugares)');
    assert.equal(hostSol1.motivo_baja, 'Nos surgió un viaje imprevisto');
    assert.equal(hostSol2.mensaje, 'Se canceló el viaje, ahora somos 3!');
    assert.equal(hostSol2.motivo_baja, null);

    const hostPartsAfterCycle2 = await db.query<{ get_participantes_host_seguro: any[] }>(`
      SELECT public.get_participantes_host_seguro('${encId}', '${hostUser}');
    `);
    const activeHostPart = hostPartsAfterCycle2.rows[0].get_participantes_host_seguro.find(
      (p: any) => p.user_id === participantUser1
    );
    assert.equal(activeHostPart.estado, 'confirmado');
    assert.equal(activeHostPart.mensaje_respuesta, 'Se canceló el viaje, ahora somos 3!');
    assert.equal(activeHostPart.ultimo_motivo_baja_historico, 'Nos surgió un viaje imprevisto');

    // Verificar que un tercero no puede consultar las solicitudes ni motivos del organizador
    await setAuthContext(outsiderUser);
    const outsiderSolsRes = await db.query<{ get_solicitudes_host_seguro: any }>(`
      SELECT public.get_solicitudes_host_seguro('${encId}', '${hostUser}');
    `);
    assert.equal(outsiderSolsRes.rows[0].get_solicitudes_host_seguro.ok, false);
    assert.equal(outsiderSolsRes.rows[0].get_solicitudes_host_seguro.error, 'unauthorized');

    // Verificar que no hubo colisión de deduplicación en Inbox ni Outbox entre Ciclo 1 y Ciclo 2
    const hostJoinNotifs = await db.query<{ id: string; payload: any }>(`
      SELECT id, payload FROM public.inbox_notifications
      WHERE recipient_user_id = '${hostUser}' AND notification_type = 'open_encounter_join_requested' AND target_id = '${encId}';
    `);
    assert.equal(hostJoinNotifs.rows.length, 2, 'El host debe recibir notificación de solicitud en ambos ciclos');

    const userApprovedNotifs = await db.query<{ id: string }>(`
      SELECT id FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantUser1}' AND notification_type = 'open_encounter_request_accepted' AND target_id = '${encId}';
    `);
    assert.equal(userApprovedNotifs.rows.length, 2, 'El usuario debe recibir notificación de aprobación en ambos ciclos');

    const userMinReachedNotifs = await db.query<{ id: string }>(`
      SELECT id FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantUser1}' AND notification_type = 'encounter_min_participants_reached' AND target_id = '${encId}';
    `);
    assert.equal(userMinReachedNotifs.rows.length, 2, 'Al volver a alcanzar el mínimo en el Ciclo 2 debe emitirse un nuevo aviso sin colisionar con el Ciclo 1');

    const outboxEvents = await db.query<{ event_type: string }>(`
      SELECT event_type FROM public.domain_events_outbox WHERE aggregate_id = '${encId}';
    `);
    assert.equal(outboxEvents.rows.filter((r) => r.event_type === 'encounter.join_request.created.v1').length, 2);
    assert.equal(outboxEvents.rows.filter((r) => r.event_type === 'encounter.join_request.approved.v1').length, 2);
    assert.equal(outboxEvents.rows.filter((r) => r.event_type === 'encounter.participant.withdrawn.v1').length, 1);
  });

  test('H9.9d: Índices parciales de unicidad impiden dos pending, dos approved o pending+approved simultáneos, pero permiten múltiples históricas terminales', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 6 });

    // Múltiples solicitudes históricas terminales del mismo usuario se conservan sin conflicto
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, motivo_baja)
      VALUES
        ('${encId}', '${participantUser1}', 'Ciclo 1', 'cancelled', 'Motivo baja 1'),
        ('${encId}', '${participantUser1}', 'Ciclo 2', 'rejected', NULL),
        ('${encId}', '${participantUser1}', 'Ciclo 3', 'cancelled', 'Motivo baja 2');
    `);

    // Insertar una solicitud pending activa es válido
    const pendingRes = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encId}', '${participantUser1}', 'Ciclo 4 Activo', 'pending')
      RETURNING id;
    `);
    const activeId = pendingRes.rows[0].id;

    // Intentar insertar una segunda solicitud pending para el mismo usuario y encuentro falla por índice único parcial
    await assert.rejects(
      async () => {
        await db.query(`
          INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
          VALUES ('${encId}', '${participantUser1}', 'Duplicado Pending', 'pending');
        `);
      },
      /idx_solicitudes_pendientes_unicas|idx_solicitudes_activas_unicas|duplicate key value/
    );

    // Intentar insertar una solicitud approved mientras ya existe una pending también falla por idx_solicitudes_activas_unicas
    await assert.rejects(
      async () => {
        await db.query(`
          INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
          VALUES ('${encId}', '${participantUser1}', 'Simultáneo Approved', 'approved');
        `);
      },
      /idx_solicitudes_activas_unicas|duplicate key value/
    );

    // Transicionar la solicitud activa a approved
    await db.query(`
      UPDATE public.solicitudes_encuentro_abierto SET estado = 'approved' WHERE id = '${activeId}';
    `);

    // Intentar insertar otra solicitud approved mientras ya existe una approved falla por idx_solicitudes_aprobadas_unicas / idx_solicitudes_activas_unicas
    await assert.rejects(
      async () => {
        await db.query(`
          INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
          VALUES ('${encId}', '${participantUser1}', 'Duplicado Approved', 'approved');
        `);
      },
      /idx_solicitudes_aprobadas_unicas|idx_solicitudes_activas_unicas|duplicate key value/
    );
  });

  test('H9.9b: Cooldown de rechazo activo no se puede saltar con historial de baja, y rechazo vencido (>24h) no borra historial previo', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 5 });

    // Usuario tiene una solicitud previa cancelada (baja) y luego una rechazada hace 2 horas (cooldown activo)
    const threeDaysAgo = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

    const solCancelledRes = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, seat_count, created_at, updated_at, resolved_at)
      VALUES ('${encId}', '${participantUser1}', 'Histórico Cancelado', 'cancelled', 1, '${threeDaysAgo}', '${threeDaysAgo}', '${threeDaysAgo}')
      RETURNING id;
    `);
    const solCancelledId = solCancelledRes.rows[0].id;

    const solRejectedRes = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, seat_count, created_at, updated_at, resolved_at)
      VALUES ('${encId}', '${participantUser1}', 'Rechazado Reciente', 'rejected', 1, '${twoHoursAgo}', '${twoHoursAgo}', '${twoHoursAgo}')
      RETURNING id;
    `);
    const solRejectedId = solRejectedRes.rows[0].id;

    await setAuthContext(participantUser1);

    // Intento de postularse dentro de las 24h del rechazo -> bloqueado por cooldown_active
    const blockedRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Intento En Cooldown', 'Quiero volver', '${participantUser1}', 1);
    `);
    assert.equal(blockedRes.rows[0].solicitar_sumarse_encuentro_abierto.ok, false);
    assert.equal(blockedRes.rows[0].solicitar_sumarse_encuentro_abierto.error, 'cooldown_active');

    // Envejecer el rechazo a 25 horas atrás -> cooldown expirado
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await db.query(`
      UPDATE public.solicitudes_encuentro_abierto
      SET resolved_at = '${twentyFiveHoursAgo}', updated_at = '${twentyFiveHoursAgo}', created_at = '${twentyFiveHoursAgo}'
      WHERE id = '${solRejectedId}';
    `);

    // Ahora sí puede postularse y NO debe haberse eliminado ni la fila 'cancelled' ni la 'rejected' previa
    const allowedRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Post Cooldown', 'Ahora sí', '${participantUser1}', 2);
    `);
    assert.equal(allowedRes.rows[0].solicitar_sumarse_encuentro_abierto.ok, true);
    const newPendingId = allowedRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    const historyRows = await db.query<{ id: string; estado: string }>(`
      SELECT id, estado FROM public.solicitudes_encuentro_abierto
      WHERE encuentro_id = '${encId}' AND usuario_id = '${participantUser1}'
      ORDER BY created_at ASC;
    `);
    assert.equal(historyRows.rows.length, 3, 'Se deben conservar la solicitud cancelada, la rechazada vencida y la nueva pendiente');
    assert.ok(historyRows.rows.some((r) => r.id === solCancelledId && r.estado === 'cancelled'));
    assert.ok(historyRows.rows.some((r) => r.id === solRejectedId && r.estado === 'rejected'));
    assert.ok(historyRows.rows.some((r) => r.id === newPendingId && r.estado === 'pending'));
  });

  test('H9.9c: Concurrencia y cupos en re-postulación: competencia por últimos lugares tras una baja y cierre de inscripciones', async () => {
    // Encuentro con capacidad 3; participantUser2 ya ocupa 1 lugar confirmado y participantUser1 ocupa 2 lugares confirmados (3/3 lleno)
    const encId = await setupOpenEncounter({ maxParticipants: 3 });

    await setAuthContext(participantUser2);
    const r2 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Fijo', null, '${participantUser2}', 1);
    `);
    const reqUser2 = r2.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(participantUser1);
    const r1 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Va y vuelve', null, '${participantUser1}', 2);
    `);
    const reqUser1Cycle1 = r1.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(hostUser);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${reqUser2}', '${hostUser}');`);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${reqUser1Cycle1}', '${hostUser}');`);

    // participantUser1 desiste -> libera 2 lugares (quedan 2 disponibles de 3)
    await setAuthContext(participantUser1);
    await db.query(`SELECT public.desistir_encuentro_abierto_seguro('${encId}', 'Duda temporal');`);

    // Simultáneamente: participantUser1 re-solicita 2 lugares Y applicantUser1 solicita 2 lugares
    await setAuthContext(participantUser1);
    const reReq1 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Va y vuelve', 'Volví', '${participantUser1}', 2);
    `);
    assert.equal(reReq1.rows[0].solicitar_sumarse_encuentro_abierto.ok, true);
    const reqUser1Cycle2 = reReq1.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(applicantUser1);
    const compReq = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Competidor', 'Quiero ir con un amigo', '${applicantUser1}', 2);
    `);
    assert.equal(compReq.rows[0].solicitar_sumarse_encuentro_abierto.ok, true);
    const reqCompetitor = compReq.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    // Host aprueba primero a applicantUser1 (ocupa los 2 lugares libres -> 3/3 lleno)
    await setAuthContext(hostUser);
    const appComp = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${reqCompetitor}', '${hostUser}');
    `);
    assert.equal(appComp.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);
    assert.equal(appComp.rows[0].aprobar_solicitud_encuentro_abierto.is_full, true);

    // Host intenta aprobar la re-postulación de participantUser1 -> debe fallar por quota_exceeded sin reactivar su fila cancelada
    const appReReq = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${reqUser1Cycle2}', '${hostUser}');
    `);
    assert.equal(appReReq.rows[0].aprobar_solicitud_encuentro_abierto.ok, false);
    assert.equal(appReReq.rows[0].aprobar_solicitud_encuentro_abierto.error, 'quota_exceeded');

    const part1State = await db.query<{ estado: string }>(`
      SELECT estado FROM public.participantes WHERE encuentro_id = '${encId}' AND user_id = '${participantUser1}';
    `);
    assert.equal(part1State.rows[0].estado, 'cancelado');
  });

  // ============================================================
  // BLOQUE 9: HARDENING ANTI-BYPASS EN ENCUENTROS ABIERTOS
  // ============================================================

  test('H9.10: responder_participante_seguro rechaza invocaciones en encuentros abiertos (anti-bypass)', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 4 });

    const partRes = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser1}', 'Bypass Tester', 'cancelado', 1)
      RETURNING token_invitacion;
    `);
    const token = partRes.rows[0].token_invitacion;

    // Intento de reactivar participación mediante responder_participante_seguro
    const res = await db.query<{ responder_participante_seguro: any }>(`
      SELECT public.responder_participante_seguro('${token}', 'confirmado');
    `);

    assert.equal(res.rows[0].responder_participante_seguro.ok, false);
    assert.equal(res.rows[0].responder_participante_seguro.error, 'open_encounter_requires_canonical_flow');
  });

  test('H9.11: responder_participante_seguro sigue funcionando normalmente para encuentros PRIVADOS', async () => {
    // Encuentro privado (is_open = false)
    const privRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open, date_mode, fecha, hora)
      VALUES ('Cena íntima', '${hostUser}', 'activo', false, 'fixed', '2026-12-01', '21:00')
      RETURNING id;
    `);
    const privId = privRes.rows[0].id;

    const partRes = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, estado)
      VALUES ('${privId}', 'Invitado Privado', 'pendiente')
      RETURNING token_invitacion;
    `);
    const token = partRes.rows[0].token_invitacion;

    const res = await db.query<{ responder_participante_seguro: any }>(`
      SELECT public.responder_participante_seguro('${token}', 'confirmado');
    `);

    assert.equal(res.rows[0].responder_participante_seguro.ok, true);
    assert.equal(res.rows[0].responder_participante_seguro.estado, 'confirmado');
  });

  // ============================================================
  // BLOQUE 10: eliminar_participante_seguro SINCRONIZACIÓN
  // ============================================================

  test('H9.12: Host elimina participante de encuentro abierto -> sincroniza solicitud a cancelled y recalcula cupos', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 4, minParticipants: 2, realizationStatus: 'confirmed' });

    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser1}', 'Eliminable', 'confirmado', 1)
      RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, seat_count, participante_id)
      VALUES ('${encId}', '${participantUser1}', 'Eliminable', 'approved', 1, '${partId}');
    `);

    // Host elimina el participante
    await setAuthContext(hostUser);
    const res = await db.query<{ eliminar_participante_seguro: any }>(`
      SELECT public.eliminar_participante_seguro('${partId}', '${hostUser}');
    `);

    assert.equal(res.rows[0].eliminar_participante_seguro.ok, true);

    // Solicitud debe estar en 'cancelled'
    const solCheck = await db.query<{ estado: string }>(`
      SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${participantUser1}';
    `);
    assert.equal(solCheck.rows[0].estado, 'cancelled');

    // Realización debe revertir a pending (quedaron 0 de 2 mínimos)
    const encCheck = await db.query<{ realization_status: string }>(`
      SELECT realization_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(encCheck.rows[0].realization_status, 'pending');
  });
});
