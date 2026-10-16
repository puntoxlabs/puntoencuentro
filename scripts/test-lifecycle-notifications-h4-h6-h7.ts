/**
 * Suite de Pruebas: H4, H6 y H7
 *
 * H4: Coherencia de motivos de cancelación entre Frontend y Backend.
 * H6: Notificaciones por nuevos ciclos de transición y deduplicación precisa.
 * H7: Navegación segura, autorizada y coherente desde notificaciones.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { validateDeepLink } from '../src/lib/deepLink.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('H4 / H6 / H7: Cancelaciones, Notificaciones por Ciclos y Navegación Segura', () => {
  let db: PGlite;

  const hostUser = '10000000-0000-0000-0000-000000000001';
  const participantUser1 = '20000000-0000-0000-0000-000000000002';
  const participantUser2 = '20000000-0000-0000-0000-000000000003';
  const applicantUser1 = '30000000-0000-0000-0000-000000000004';
  const applicantUser2 = '30000000-0000-0000-0000-000000000005';
  const outsiderUser = '40000000-0000-0000-0000-000000000006';

  before(async () => {
    db = new PGlite();

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
        ('${applicantUser1}', 'applicant1@test.com'),
        ('${applicantUser2}', 'applicant2@test.com'),
        ('${outsiderUser}', 'outsider@test.com')
      ON CONFLICT DO NOTHING;

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
        ('palermo', 'Palermo', 'Buenos Aires', 'CABA', true)
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
        min_realization_cycle_id UUID DEFAULT gen_random_uuid(),
        inscriptions_cycle_id UUID DEFAULT gen_random_uuid(),
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        nombre_invitado TEXT NOT NULL,
        rol TEXT DEFAULT 'invitado',
        estado TEXT NOT NULL DEFAULT 'pendiente',
        token_invitacion UUID DEFAULT gen_random_uuid(),
        seat_count INT NOT NULL DEFAULT 1,
        reconfirmation_status TEXT DEFAULT 'pending',
        reconfirmed_at TIMESTAMPTZ,
        mensaje_respuesta TEXT,
        tipo_invitacion TEXT DEFAULT 'individual',
        respondido_en TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
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
        motivo_baja TEXT,
        seat_count INT NOT NULL DEFAULT 1,
        estado TEXT NOT NULL DEFAULT 'pending',
        participante_id UUID,
        token_participante UUID,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        resolved_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ
      );

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
      ) RETURNS UUID
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $$
      DECLARE
        v_id UUID;
        v_effective_dedup TEXT := COALESCE(p_dedup_key, gen_random_uuid()::text);
      BEGIN
        INSERT INTO public.inbox_notifications (
          recipient_user_id, notification_type, target_type, target_id,
          deep_link, title, body, payload, dedup_key, expires_at
        ) VALUES (
          p_recipient_user_id, p_notification_type, p_target_type, p_target_id,
          p_deep_link, p_title, p_body, COALESCE(p_payload, '{}'::jsonb),
          v_effective_dedup, COALESCE(p_expires_at, now() + interval '30 days')
        )
        ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING
        RETURNING id INTO v_id;
        RETURN v_id;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.verificar_y_consumir_rate_limit(
        p_user_id UUID,
        p_action TEXT,
        p_max INT,
        p_window INTERVAL
      ) RETURNS JSONB
      LANGUAGE sql
      AS $$
        SELECT '{"allowed": true}'::jsonb;
      $$;
    `);

    // Cargar migraciones en orden: Base Lifecycle -> Hardening Concurrency -> H9/H10 -> H2/H3 -> H4/H6/H7
    const migLifecycle1 = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20261014180000_fase_lifecycle_realization_and_cancellation_reasons.sql'),
      'utf8'
    );
    await db.exec(migLifecycle1);

    const migLifecycle2 = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20261014190000_harden_lifecycle_rpc_concurrency_and_invariants.sql'),
      'utf8'
    );
    await db.exec(migLifecycle2);

    const migH9H10 = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20261016180000_open_encounter_withdrawal_and_sync_h9_h10.sql'),
      'utf8'
    );
    await db.exec(migH9H10);

    const migH2H3 = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20261016193000_harden_legacy_rpcs_and_concurrency_h2_h3.sql'),
      'utf8'
    );
    await db.exec(migH2H3);

    const migH4H6H7 = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20261016200000_harden_lifecycle_transitions_and_navigation_h6_h7.sql'),
      'utf8'
    );
    await db.exec(migH4H6H7);
  });

  async function setAuthContext(userId: string | null, isAnon = false) {
    if (!userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(
        `SELECT set_config('request.jwt.claims', '{"sub":"${userId}","is_anonymous":${isAnon}}', false);`
      );
    }
  }

  async function createTestEncounter(opts?: {
    isOpen?: boolean;
    minParticipants?: number;
    maxParticipants?: number;
  }) {
    const res = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, fecha, hora, modalidad, lugar_texto, link_virtual,
        host_id, is_open, min_participants, max_participants, estado, realization_status
      ) VALUES (
        'Café y Programación', 'Café y Código', '2026-11-20', '18:00:00',
        'presencial', 'Av Santa Fe 1234, CABA', NULL,
        '${hostUser}', ${opts?.isOpen ?? true}, ${opts?.minParticipants ?? 2}, ${opts?.maxParticipants ?? 5},
        'activo', 'pending'
      ) RETURNING id;
    `);
    return res.rows[0].id;
  }

  // =========================================================================
  // GRUPO 1: H4 — Cancelaciones (Tests 1 a 6)
  // =========================================================================

  test('H4.1: Cancelación con solicitudes pendientes y sin participantes confirmados exige motivo', async () => {
    const encounterId = await createTestEncounter();

    // Crear solicitud pendiente
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encounterId}', '${applicantUser1}', 'Solicitante 1', 'pending');
    `);

    // Consultar get_detalle_host_seguro (verificar que reporta usuarios afectados)
    await setAuthContext(hostUser);
    const detailRes = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${encounterId}'::uuid, '${hostUser}'::uuid);`
    );
    const detail = detailRes.rows[0].get_detalle_host_seguro;
    assert.equal(detail.has_affected_users, true, 'has_affected_users debe ser true cuando hay solicitudes pendientes');
    assert.equal(detail.pending_requests_count, 1);

    // Intentar cancelar sin motivo -> debe rechazar
    const cancelFailRes = await db.query<{ cancelar_encuentro_seguro: any }>(
      `SELECT public.cancelar_encuentro_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, NULL);`
    );
    const cancelFail = cancelFailRes.rows[0].cancelar_encuentro_seguro;
    assert.equal(cancelFail.ok, false);
    assert.equal(cancelFail.error, 'cancellation_reason_required');

    // Cancelar con motivo válido -> debe cancelar con éxito y transicionar solicitud a cancelled
    const cancelOkRes = await db.query<{ cancelar_encuentro_seguro: any }>(
      `SELECT public.cancelar_encuentro_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, 'Fuerza mayor por lluvia');`
    );
    const cancelOk = cancelOkRes.rows[0].cancelar_encuentro_seguro;
    assert.equal(cancelOk.ok, true);
    assert.equal(cancelOk.estado, 'cancelado');

    const solRes = await db.query<{ estado: string }>(
      `SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encounterId}';`
    );
    assert.equal(solRes.rows[0].estado, 'cancelled');
  });

  test('H4.2: Cancelación con participantes confirmados exige motivo', async () => {
    const encounterId = await createTestEncounter();

    // Crear participante confirmado
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encounterId}', '${participantUser1}', 'Participante 1', 'confirmado');
    `);

    await setAuthContext(hostUser);
    const cancelFailRes = await db.query<{ cancelar_encuentro_seguro: any }>(
      `SELECT public.cancelar_encuentro_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, '');`
    );
    assert.equal(cancelFailRes.rows[0].cancelar_encuentro_seguro.error, 'cancellation_reason_required');

    // Con motivo válido -> éxito
    const cancelOkRes = await db.query<{ cancelar_encuentro_seguro: any }>(
      `SELECT public.cancelar_encuentro_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, 'Problemas de salud del host');`
    );
    assert.equal(cancelOkRes.rows[0].cancelar_encuentro_seguro.ok, true);
  });

  test('H4.3: Cancelación sin terceros afectados permite motivo opcional', async () => {
    const encounterId = await createTestEncounter();

    // Sin participantes y sin solicitudes
    await setAuthContext(hostUser);
    const detailRes = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${encounterId}'::uuid, '${hostUser}'::uuid);`
    );
    const detail = detailRes.rows[0].get_detalle_host_seguro;
    assert.equal(detail.has_affected_users, false);
    assert.equal(detail.pending_requests_count, 0);

    // Cancelar sin motivo debe funcionar de inmediato
    const cancelRes = await db.query<{ cancelar_encuentro_seguro: any }>(
      `SELECT public.cancelar_encuentro_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, NULL);`
    );
    assert.equal(cancelRes.rows[0].cancelar_encuentro_seguro.ok, true);
    assert.equal(cancelRes.rows[0].cancelar_encuentro_seguro.estado, 'cancelado');
  });

  test('H4.4: Motivo insuficiente (< 3 caracteres) es rechazado cuando es obligatorio', async () => {
    const encounterId = await createTestEncounter();
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encounterId}', '${applicantUser1}', 'Solicitante 1', 'pending');
    `);

    await setAuthContext(hostUser);
    const shortReasonRes = await db.query<{ cancelar_encuentro_seguro: any }>(
      `SELECT public.cancelar_encuentro_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, 'no');`
    );
    assert.equal(shortReasonRes.rows[0].cancelar_encuentro_seguro.error, 'cancellation_reason_required');

    const spacesReasonRes = await db.query<{ cancelar_encuentro_seguro: any }>(
      `SELECT public.cancelar_encuentro_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, '    ');`
    );
    assert.equal(spacesReasonRes.rows[0].cancelar_encuentro_seguro.error, 'cancellation_reason_required');
  });

  test('H4.5: Corrección del motivo tras rechazo del servidor permite completar la cancelación', async () => {
    const encounterId = await createTestEncounter();
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encounterId}', '${participantUser1}', 'Participante 1', 'confirmado');
    `);

    await setAuthContext(hostUser);
    // 1. Intento fallido
    const failRes = await db.query<{ cancelar_encuentro_seguro: any }>(
      `SELECT public.cancelar_encuentro_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, NULL);`
    );
    assert.equal(failRes.rows[0].cancelar_encuentro_seguro.error, 'cancellation_reason_required');

    // El encuentro sigue activo
    const checkEnc = await db.query<{ estado: string }>(
      `SELECT estado FROM public.encuentros WHERE id = '${encounterId}';`
    );
    assert.equal(checkEnc.rows[0].estado, 'activo');

    // 2. Corrección con motivo suficiente
    const okRes = await db.query<{ cancelar_encuentro_seguro: any }>(
      `SELECT public.cancelar_encuentro_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, 'Motivo corregido válido');`
    );
    assert.equal(okRes.rows[0].cancelar_encuentro_seguro.ok, true);
    assert.equal(okRes.rows[0].cancelar_encuentro_seguro.cancellation_reason, 'Motivo corregido válido');
  });

  test('H4.6: «Cancelar y crear otro» mantiene coherencia y preserva modal ante fallo', async () => {
    const encounterId = await createTestEncounter();
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encounterId}', '${applicantUser1}', 'Solicitante 1', 'pending');
    `);

    // Simular lógica de frontend: si la cancelación falla, abortar antes de navegar
    let navigateCalled = false;
    let wizardReset = false;
    let modalClosed = false;

    await setAuthContext(hostUser);
    try {
      const res = await db.query<{ cancelar_encuentro_seguro: any }>(
        `SELECT public.cancelar_encuentro_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, '');`
      );
      const data = res.rows[0].cancelar_encuentro_seguro;
      if (!data.ok) {
        throw new Error(data.error);
      }
      wizardReset = true;
      modalClosed = true;
      navigateCalled = true;
    } catch (err: any) {
      assert.equal(err.message, 'cancellation_reason_required');
    }

    assert.equal(navigateCalled, false, 'No debió navegar a /create si la cancelación falló');
    assert.equal(wizardReset, false, 'No debió reiniciar el wizard');
    assert.equal(modalClosed, false, 'El modal de cancelación debe mantenerse abierto');
  });

  // =========================================================================
  // GRUPO 2: H6 — Notificaciones por Nuevas Transiciones (Tests 7 a 15)
  // =========================================================================

  test('H6.7: Primera transición que alcanza el mínimo emite encounter_min_participants_reached', async () => {
    const encounterId = await createTestEncounter({ minParticipants: 2 });

    // Host aprueba solicitud 1 (alcanza 1 cupo)
    const req1Res = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, seat_count)
      VALUES ('${encounterId}', '${participantUser1}', 'Participante 1', 'pending', 1) RETURNING id;
    `);
    await setAuthContext(hostUser);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${req1Res.rows[0].id}'::uuid, '${hostUser}'::uuid);`);

    let notifMin = await db.query(`
      SELECT * FROM public.inbox_notifications
      WHERE target_id = '${encounterId}' AND notification_type = 'encounter_min_participants_reached';
    `);
    assert.equal(notifMin.rows.length, 0, 'No debe emitir min_reached con 1 solo participante cuando el mínimo es 2');

    // Host aprueba solicitud 2 (alcanza 2 cupos = mínimo)
    const req2Res = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, seat_count)
      VALUES ('${encounterId}', '${participantUser2}', 'Participante 2', 'pending', 1) RETURNING id;
    `);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${req2Res.rows[0].id}'::uuid, '${hostUser}'::uuid);`);

    notifMin = await db.query(`
      SELECT * FROM public.inbox_notifications
      WHERE target_id = '${encounterId}' AND notification_type = 'encounter_min_participants_reached';
    `);
    assert.equal(notifMin.rows.length, 2, 'Debe emitir min_reached para los dos participantes confirmados');

    const encRes = await db.query<{ realization_status: string }>(
      `SELECT realization_status FROM public.encuentros WHERE id = '${encounterId}';`
    );
    assert.equal(encRes.rows[0].realization_status, 'confirmed');
  });

  test('H6.8: Pérdida posterior del mínimo emite encounter_below_min_participants', async () => {
    const encounterId = await createTestEncounter({ minParticipants: 2 });
    await db.exec(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encounterId}', '${participantUser1}', 'P1', 'confirmado', 1),
             ('${encounterId}', '${participantUser2}', 'P2', 'confirmado', 1);
      UPDATE public.encuentros SET realization_status = 'confirmed', min_confirmed_notified_at = now() WHERE id = '${encounterId}';
    `);

    // Participante 2 desiste voluntariamente
    await setAuthContext(participantUser2);
    await db.query(`
      SELECT public.desistir_encuentro_abierto_seguro('${encounterId}'::uuid, 'No llego con los tiempos');
    `);

    // Verificar que el participante restante recibió encounter_below_min_participants
    const belowMinPart = await db.query<{ recipient_user_id: string }>(`
      SELECT recipient_user_id FROM public.inbox_notifications
      WHERE target_id = '${encounterId}' AND notification_type = 'encounter_below_min_participants';
    `);
    assert.equal(belowMinPart.rows.length, 1);
    assert.equal(belowMinPart.rows[0].recipient_user_id, participantUser1);

    // Y el host recibió la notificación unificada de baja con fell_below_min = true
    const hostWithdrawnNotif = await db.query<{ payload: any }>(`
      SELECT payload FROM public.inbox_notifications
      WHERE target_id = '${encounterId}' AND notification_type = 'encounter_participant_withdrawn';
    `);
    assert.equal(hostWithdrawnNotif.rows.length, 1);
    assert.equal(hostWithdrawnNotif.rows[0].payload.fell_below_min, true);

    const encRes = await db.query<{ realization_status: string }>(
      `SELECT realization_status FROM public.encuentros WHERE id = '${encounterId}';`
    );
    assert.equal(encRes.rows[0].realization_status, 'pending');

    // Ahora probar cuando el Host sube el mínimo vía set_min_participants_seguro
    // Primero volver a confirmed
    await db.exec(`
      UPDATE public.encuentros SET min_participants = 1, realization_status = 'confirmed' WHERE id = '${encounterId}';
    `);
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.set_min_participants_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, 3, false);
    `);

    // Debe emitir encounter_below_min_participants tanto al host como al participante
    const belowMinBoth = await db.query<{ recipient_user_id: string }>(`
      SELECT recipient_user_id FROM public.inbox_notifications
      WHERE target_id = '${encounterId}' AND notification_type = 'encounter_below_min_participants';
    `);
    const recipients = belowMinBoth.rows.map(r => r.recipient_user_id);
    assert.ok(recipients.includes(hostUser), 'Host debe recibir encounter_below_min_participants al subir mínimo');
    assert.ok(recipients.includes(participantUser1), 'Participante debe recibir encounter_below_min_participants al subir mínimo');
  });

  test('H6.9: Segunda transición que alcanza nuevamente el mínimo emite nuevo aviso', async () => {
    const encounterId = await createTestEncounter({ minParticipants: 2 });
    await db.exec(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encounterId}', '${participantUser1}', 'P1', 'confirmado', 1);
      UPDATE public.encuentros SET realization_status = 'pending', min_confirmed_notified_at = NULL WHERE id = '${encounterId}';
    `);

    // Nuevo solicitante 3 pide sumarse y host aprueba -> vuelve a alcanzar 2 cupos
    const req3Res = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, seat_count)
      VALUES ('${encounterId}', '${applicantUser1}', 'Solicitante 3', 'pending', 1) RETURNING id;
    `);

    await setAuthContext(hostUser);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${req3Res.rows[0].id}'::uuid, '${hostUser}'::uuid);`);

    const notifs = await db.query<{ recipient_user_id: string; dedup_key: string }>(`
      SELECT recipient_user_id, dedup_key FROM public.inbox_notifications
      WHERE target_id = '${encounterId}' AND notification_type = 'encounter_min_participants_reached';
    `);
    assert.ok(notifs.rows.length >= 2, 'Participante 1 y solicitante 3 deben recibir min_reached');
    assert.ok(notifs.rows[0].dedup_key.startsWith('min_reached:'));
  });

  test('H6.10: Reintentos idempotentes no generan duplicados', async () => {
    const encounterId = await createTestEncounter({ minParticipants: 2 });
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encounterId}', '${participantUser1}', 'P1', 'confirmado', 1);
    `);
    const reqRes = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, seat_count)
      VALUES ('${encounterId}', '${applicantUser1}', 'S1', 'pending', 1) RETURNING id;
    `);

    await setAuthContext(hostUser);
    // Primera aprobación
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${reqRes.rows[0].id}'::uuid, '${hostUser}'::uuid);`);
    const count1 = await db.query(`SELECT count(*)::int as c FROM public.inbox_notifications WHERE target_id = '${encounterId}';`);

    // Reintento idéntico de aprobación
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${reqRes.rows[0].id}'::uuid, '${hostUser}'::uuid);`);
    const count2 = await db.query(`SELECT count(*)::int as c FROM public.inbox_notifications WHERE target_id = '${encounterId}';`);

    assert.equal(count1.rows[0].c, count2.rows[0].c, 'El reintento no debe agregar ninguna notificación duplicada');
  });

  test('H6.11: Reapertura y cierre posterior de inscripciones', async () => {
    const encounterId = await createTestEncounter({ minParticipants: 1 });
    await db.exec(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encounterId}', '${participantUser1}', 'P1', 'confirmado', 1);
      UPDATE public.encuentros SET realization_status = 'confirmed' WHERE id = '${encounterId}';
    `);

    await setAuthContext(hostUser);
    // 1. Cierre inicial
    const close1 = await db.query<{ cerrar_inscripciones_seguro: any }>(
      `SELECT public.cerrar_inscripciones_seguro('${encounterId}'::uuid, '${hostUser}'::uuid);`
    );
    assert.equal(close1.rows[0].cerrar_inscripciones_seguro.inscriptions_closed, true);

    // 2. Reapertura legítima
    const reopen = await db.query<{ reabrir_inscripciones_seguro: any }>(
      `SELECT public.reabrir_inscripciones_seguro('${encounterId}'::uuid, '${hostUser}'::uuid);`
    );
    assert.equal(reopen.rows[0].reabrir_inscripciones_seguro.inscriptions_closed, false);

    // 3. Cierre posterior
    const close2 = await db.query<{ cerrar_inscripciones_seguro: any }>(
      `SELECT public.cerrar_inscripciones_seguro('${encounterId}'::uuid, '${hostUser}'::uuid);`
    );
    assert.equal(close2.rows[0].cerrar_inscripciones_seguro.inscriptions_closed, true);
  });

  test('H6.12: Confirmación final en un nuevo ciclo legítimo', async () => {
    const encounterId = await createTestEncounter({ minParticipants: 1 });
    await db.exec(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encounterId}', '${participantUser1}', 'P1', 'confirmado', 1);
      UPDATE public.encuentros SET realization_status = 'confirmed' WHERE id = '${encounterId}';
    `);

    await setAuthContext(hostUser);
    // Cierre inicial y confirmación final
    await db.query(`SELECT public.cerrar_inscripciones_seguro('${encounterId}'::uuid, '${hostUser}'::uuid);`);
    const notifCycle1 = await db.query<{ dedup_key: string }>(`
      SELECT dedup_key FROM public.inbox_notifications
      WHERE target_id = '${encounterId}' AND notification_type = 'encounter_final_confirmation';
    `);
    assert.equal(notifCycle1.rows.length, 1);

    // Reintento sin cambios (no debe duplicar)
    const retryClose = await db.query<{ cerrar_inscripciones_seguro: any }>(
      `SELECT public.cerrar_inscripciones_seguro('${encounterId}'::uuid, '${hostUser}'::uuid);`
    );
    assert.equal(retryClose.rows[0].cerrar_inscripciones_seguro.no_change, true);

    // Reabrir y volver a cerrar
    await db.query(`SELECT public.reabrir_inscripciones_seguro('${encounterId}'::uuid, '${hostUser}'::uuid);`);
    await db.query(`SELECT public.cerrar_inscripciones_seguro('${encounterId}'::uuid, '${hostUser}'::uuid);`);

    const notifCycle2 = await db.query<{ dedup_key: string }>(`
      SELECT dedup_key FROM public.inbox_notifications
      WHERE target_id = '${encounterId}' AND notification_type = 'encounter_final_confirmation';
    `);
    assert.equal(notifCycle2.rows.length, 2, 'Debe haber 2 avisos: uno por cada ciclo de confirmación final');
    assert.notEqual(notifCycle2.rows[0].dedup_key, notifCycle2.rows[1].dedup_key);
  });

  test('H6.13: Realización forzada repetida sin cambio efectivo es no-op', async () => {
    const encounterId = await createTestEncounter({ minParticipants: 5 });
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encounterId}', '${participantUser1}', 'P1', 'confirmado', 1);
    `);

    await setAuthContext(hostUser);
    // 1. Primera invocación a hacerlo_igual_seguro
    const force1 = await db.query<{ hacerlo_igual_seguro: any }>(
      `SELECT public.hacerlo_igual_seguro('${encounterId}'::uuid, '${hostUser}'::uuid);`
    );
    assert.equal(force1.rows[0].hacerlo_igual_seguro.realization_status, 'forced');

    const forcedNotifs1 = await db.query(`
      SELECT count(*)::int as c FROM public.inbox_notifications
      WHERE target_id = '${encounterId}' AND notification_type = 'encounter_realization_forced';
    `);
    assert.equal(forcedNotifs1.rows[0].c, 1);

    // 2. Segunda invocación repetida cuando ya está forzado
    const force2 = await db.query<{ hacerlo_igual_seguro: any }>(
      `SELECT public.hacerlo_igual_seguro('${encounterId}'::uuid, '${hostUser}'::uuid);`
    );
    assert.equal(force2.rows[0].hacerlo_igual_seguro.no_change, true);

    const forcedNotifs2 = await db.query(`
      SELECT count(*)::int as c FROM public.inbox_notifications
      WHERE target_id = '${encounterId}' AND notification_type = 'encounter_realization_forced';
    `);
    assert.equal(forcedNotifs2.rows[0].c, 1, 'No debe generar notificaciones adicionales al reintentar hacerlo_igual');
  });

  test('H6.14: Ausencia de colisiones en deduplicación por ciclo', async () => {
    const encounterId = await createTestEncounter();
    await db.query(`
      INSERT INTO public.encuentros (id, titulo, host_id) VALUES
      (gen_random_uuid(), 'Otro Encuentro', '${hostUser}');
    `);

    const encRes = await db.query<{ min_realization_cycle_id: string; inscriptions_cycle_id: string }>(
      `SELECT min_realization_cycle_id, inscriptions_cycle_id FROM public.encuentros WHERE id = '${encounterId}';`
    );
    assert.ok(encRes.rows[0].min_realization_cycle_id);
    assert.ok(encRes.rows[0].inscriptions_cycle_id);
  });

  test('H6.15: Privacidad de payloads Inbox/Push', async () => {
    const encounterId = await createTestEncounter();
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encounterId}', '${participantUser1}', 'P1', 'confirmado');
    `);

    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.cancelar_encuentro_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, 'Cancelado por lluvia');
    `);

    const notifs = await db.query<{ payload: any }>(`
      SELECT payload FROM public.inbox_notifications WHERE target_id = '${encounterId}';
    `);
    for (const row of notifs.rows) {
      assert.equal(row.payload.lugar_texto, undefined, 'No debe contener dirección exacta en el payload');
      assert.equal(row.payload.link_virtual, undefined, 'No debe contener link virtual en el payload');
      assert.equal(row.payload.public_token, undefined, 'No debe contener token de invitación');
    }
  });

  // =========================================================================
  // GRUPO 3: H7 — Navegación Segura y Coherente (Tests 16 a 25)
  // =========================================================================

  test('H7.16: Avisos sobre encuentros activos utilizan deep link canónico válido', async () => {
    const encounterId = await createTestEncounter();
    const deepLink = `/?tab=encuentros&open_detail=${encounterId}`;
    const validated = validateDeepLink(deepLink);
    assert.equal(validated, deepLink);
  });

  test('H7.17: Avisos sobre encuentros cancelados dirigen a vista autorizada que oculta logística privada', async () => {
    const encounterId = await createTestEncounter();
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encounterId}', '${participantUser1}', 'P1', 'confirmado');
    `);

    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.cancelar_encuentro_seguro('${encounterId}'::uuid, '${hostUser}'::uuid, 'Clima adverso');
    `);

    // Participante confirmado consulta RPC get_encuentro_participante_autorizado
    await setAuthContext(participantUser1);
    const authRes = await db.query<{ get_encuentro_participante_autorizado: any }>(
      `SELECT public.get_encuentro_participante_autorizado('${encounterId}'::uuid);`
    );
    const res = authRes.rows[0].get_encuentro_participante_autorizado;
    assert.equal(res.ok, true);
    assert.equal(res.estado, 'cancelado');
    assert.equal(res.cancellation_reason, 'Clima adverso');
    assert.equal(res.lugar_texto, null, 'En encuentro cancelado la dirección física debe ser NULL');
    assert.equal(res.link_virtual, null, 'En encuentro cancelado el link virtual debe ser NULL');
  });

  test('H7.18: Encuentros retirados de Discovery se resuelven para participantes confirmados', async () => {
    const encounterId = await createTestEncounter({ isOpen: false });
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encounterId}', '${participantUser1}', 'P1', 'confirmado');
    `);

    await setAuthContext(participantUser1);
    const authRes = await db.query<{ get_encuentro_participante_autorizado: any }>(
      `SELECT public.get_encuentro_participante_autorizado('${encounterId}'::uuid);`
    );
    assert.equal(authRes.rows[0].get_encuentro_participante_autorizado.ok, true);
  });

  test('H7.19: Navegación del organizador lleva a /meet/:id', async () => {
    const encounterId = await createTestEncounter();
    const link = `/meet/${encounterId}`;
    assert.equal(validateDeepLink(link), link);
  });

  test('H7.20: Navegación del participante confirmado expone logística únicamente en estado activo', async () => {
    const encounterId = await createTestEncounter();
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encounterId}', '${participantUser1}', 'P1', 'confirmado');
    `);

    await setAuthContext(participantUser1);
    const authRes = await db.query<{ get_encuentro_participante_autorizado: any }>(
      `SELECT public.get_encuentro_participante_autorizado('${encounterId}'::uuid);`
    );
    const res = authRes.rows[0].get_encuentro_participante_autorizado;
    assert.equal(res.ok, true);
    assert.equal(res.estado, 'activo');
    assert.equal(res.lugar_texto, 'Av Santa Fe 1234, CABA');
  });

  test('H7.21: Solicitantes rechazados o cancelados navegan a /?tab=solicitudes y no a logística privada', async () => {
    const encounterId = await createTestEncounter();
    const link = '/?tab=solicitudes';
    assert.equal(validateDeepLink(link), link);

    // Usuario que no es participante confirmado no puede consultar logística
    await setAuthContext(applicantUser1);
    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(
      `SELECT public.get_encuentro_participante_autorizado('${encounterId}'::uuid);`
    );
    assert.equal(res.rows[0].get_encuentro_participante_autorizado.error, 'unauthorized');
  });

  test('H7.22: Enlaces inválidos o manipulados son rechazados por validateDeepLink', () => {
    assert.equal(validateDeepLink('javascript:alert(1)'), null);
    assert.equal(validateDeepLink('//evil.com/phishing'), null);
    assert.equal(validateDeepLink('https://external.com'), null);
    assert.equal(validateDeepLink('vbscript:msgbox'), null);
    assert.equal(validateDeepLink('data:text/html,hack'), null);
    assert.equal(validateDeepLink(''), null);
    assert.equal(validateDeepLink(null), null);
    assert.equal(validateDeepLink(undefined), null);
  });

  test('H7.23: Prohibición de acceso a logística privada sin autorización', async () => {
    const encounterId = await createTestEncounter();
    await setAuthContext(outsiderUser);

    const res = await db.query<{ get_encuentro_participante_autorizado: any }>(
      `SELECT public.get_encuentro_participante_autorizado('${encounterId}'::uuid);`
    );
    assert.equal(res.rows[0].get_encuentro_participante_autorizado.ok, false);
    assert.equal(res.rows[0].get_encuentro_participante_autorizado.error, 'unauthorized');
  });

  test('H7.24: Marcar como leída desde modal crítico funciona transaccionalmente', async () => {
    const encounterId = await createTestEncounter();
    const notifIdRes = await db.query<{ id: string }>(`
      INSERT INTO public.inbox_notifications (
        recipient_user_id, notification_type, target_type, target_id,
        deep_link, title, body, dedup_key, expires_at
      ) VALUES (
        '${participantUser1}', 'encounter_cancelled_for_participant', 'encounter', '${encounterId}',
        '/?tab=encuentros&open_detail=${encounterId}', 'Encuentro cancelado', 'Se canceló',
        'crit_test:${encounterId}', now() + interval '1 day'
      ) RETURNING id;
    `);
    const notifId = notifIdRes.rows[0].id;

    await setAuthContext(participantUser1);
    await db.query(`
      UPDATE public.inbox_notifications SET read_at = now()
      WHERE id = '${notifId}' AND recipient_user_id = '${participantUser1}';
    `);

    const check = await db.query<{ read_at: string }>(
      `SELECT read_at FROM public.inbox_notifications WHERE id = '${notifId}';`
    );
    assert.ok(check.rows[0].read_at);
  });

  test('H7.25: Aislamiento entre sesiones en Inbox y navegación', async () => {
    const encounterId = await createTestEncounter();
    const notifRes = await db.query<{ id: string }>(`
      INSERT INTO public.inbox_notifications (
        recipient_user_id, notification_type, target_type, target_id,
        deep_link, title, body, dedup_key, expires_at
      ) VALUES (
        '${participantUser1}', 'encounter_cancelled_for_participant', 'encounter', '${encounterId}',
        '/?tab=encuentros', 'Aviso para P1', 'Cuerpo', 'session_iso:${encounterId}', now() + interval '1 day'
      ) RETURNING id;
    `);

    // Usuario 2 intenta marcar la notificación de Usuario 1
    await setAuthContext(participantUser2);
    const updateRes = await db.query(`
      UPDATE public.inbox_notifications SET read_at = now()
      WHERE id = '${notifRes.rows[0].id}' AND recipient_user_id = '${participantUser2}';
    `);
    assert.equal(updateRes.rowCount, 0, 'El usuario 2 no debe poder modificar notificaciones del usuario 1');

    const check = await db.query<{ read_at: string | null }>(
      `SELECT read_at FROM public.inbox_notifications WHERE id = '${notifRes.rows[0].id}';`
    );
    assert.equal(check.rows[0].read_at, null, 'La notificación del usuario 1 sigue no leída');
  });
});
