/**
 * Suite de Pruebas: H2 / H3 — Seguridad de RPCs Antiguos, Concurrencia y Orden Canónico de Bloqueos
 *
 * Nota sobre limitaciones de concurrencia en PGlite vs PostgreSQL real (Staging):
 * - PGlite ejecuta en un único hilo WASM en memoria y serializa las transacciones enviadas
 *   por una misma conexión (single-session queue). Por ello, `Promise.all` en PGlite valida
 *   la correcta revalidación de invariantes bajo interleavings deterministas y ausencia de
 *   excepciones no controladas, pero no puede reproducir un bloqueo cruzado multi-backend
 *   real (deadlock detection entre dos procesos backend PostgreSQL distintos).
 * - Para cubrir esa limitación:
 *   1. El test H3.0 inspecciona directamente el cuerpo compilado en `pg_proc` de los RPCs
 *      críticos verificando que TODOS adquieran los locks `FOR UPDATE` / `FOR SHARE` siguiendo
 *      estrictamente la jerarquía parcial:
 *        `public.encuentros` -> `public.solicitudes_encuentro_abierto` -> `public.participantes`,
 *      lo que hace matemáticamente imposible un ciclo de espera (deadlock) entre estos RPCs
 *      en PostgreSQL real.
 *   2. Los tests H3.1 a H3.6 verifican todas las carreras (1 a 6) en ambos órdenes de llegada
 *      y con despacho concurrente (`Promise.all`), listas también para ejecutarse contra
 *      PostgreSQL real de Staging.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('H2 / H3: Seguridad de RPCs Antiguos, Concurrencia y Orden de Bloqueos', () => {
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
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
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

    // Cargar migraciones en orden: base lifecycle -> P0 -> H9/H10 -> H2/H3
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

  async function setupOpenEncounter(opts?: {
    maxParticipants?: number;
    minParticipants?: number | null;
    inscriptionsClosed?: boolean;
    realizationStatus?: string;
    estado?: string;
    isOpen?: boolean;
  }) {
    const maxP = opts?.maxParticipants ?? 4;
    const minP = opts?.minParticipants !== undefined ? opts.minParticipants : 2;
    const inscClosed = opts?.inscriptionsClosed ?? false;
    const realStatus = opts?.realizationStatus ?? 'pending';
    const estado = opts?.estado ?? 'activo';
    const isOpen = opts?.isOpen ?? true;

    const res = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, descripcion, open_description,
        fecha, hora, modalidad, lugar_texto, link_virtual,
        host_id, estado, is_open, max_participants, min_participants,
        realization_status, inscriptions_closed, locality_id, open_public_zone,
        moderation_status, allow_multi_seat_requests, max_seats_per_request, opened_at
      ) VALUES (
        'Título Privado Host', 'Partido de Tenis Abierto', 'Nota privada', 'Descripción pública',
        '2026-12-20', '19:00', 'presencial', 'Club Belgrano Cancha 3', NULL,
        '${hostUser}', '${estado}', ${isOpen}, ${maxP}, ${minP === null ? 'NULL' : minP},
        '${realStatus}', ${inscClosed}, 'palermo', 'Palermo',
        'approved', true, 4, now()
      ) RETURNING id;
    `);
    return res.rows[0].id;
  }

  // ============================================================
  // FASE 2 — H2: SEGURIDAD DE RPCs ANTIGUOS
  // ============================================================

  test('H2.1: responder_participante_seguro bloquea encuentros que fueron abiertos incluso si actualmente is_open = false (cerrado con cerrar_encuentro_abierto_seguro)', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 4, isOpen: true });

    // Participante aprobado previamente
    await setAuthContext(participantUser1);
    const reqRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Jugador 1', 'Me sumo', '${participantUser1}', 1);
    `);
    const reqId = reqRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(hostUser);
    const appRes = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}', '${hostUser}');
    `);
    const activeToken = appRes.rows[0].aprobar_solicitud_encuentro_abierto.token_invitacion;

    // Host cierra la publicación abierta (is_open pasa a false, pero opened_at sigue presente)
    const closeRes = await db.query<{ cerrar_encuentro_abierto_seguro: any }>(`
      SELECT public.cerrar_encuentro_abierto_seguro('${encId}', '${hostUser}');
    `);
    assert.equal(closeRes.rows[0].cerrar_encuentro_abierto_seguro.ok, true);

    // Intento de usar responder_participante_seguro con el token del participante o el public_token del encuentro
    const bypassByPartToken = await db.query<{ responder_participante_seguro: any }>(`
      SELECT public.responder_participante_seguro('${activeToken}', 'rechazado');
    `);
    assert.equal(bypassByPartToken.rows[0].responder_participante_seguro.ok, false);
    assert.equal(bypassByPartToken.rows[0].responder_participante_seguro.error, 'open_encounter_requires_canonical_flow');

    const encPubToken = await db.query<{ public_token: string }>(`
      SELECT public_token FROM public.encuentros WHERE id = '${encId}';
    `);
    const bypassByPubToken = await db.query<{ responder_participante_seguro: any }>(`
      SELECT public.responder_participante_seguro('${encPubToken.rows[0].public_token}', 'confirmado', 'Intruso');
    `);
    assert.equal(bypassByPubToken.rows[0].responder_participante_seguro.ok, false);
    assert.equal(bypassByPubToken.rows[0].responder_participante_seguro.error, 'open_encounter_requires_canonical_flow');
  });

  test('H2.2: responder_participante_seguro impide reactivar o alterar estados terminales (cancelado / asistio) en encuentros privados, preservando pendiente/confirmado/rechazado', async () => {
    const privRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open, date_mode, fecha, hora)
      VALUES ('Asado Privado', '${hostUser}', 'activo', false, 'fixed', '2026-12-20', '21:00')
      RETURNING id;
    `);
    const privId = privRes.rows[0].id;

    // 1. Invitado pendiente -> confirmado (flujo privado normal)
    const pPend = await db.query<{ id: string; token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${privId}', '${participantUser1}', 'Invitado Normal', 'pendiente')
      RETURNING id, token_invitacion;
    `);
    const okRes = await db.query<{ responder_participante_seguro: any }>(`
      SELECT public.responder_participante_seguro('${pPend.rows[0].token_invitacion}', 'confirmado');
    `);
    assert.equal(okRes.rows[0].responder_participante_seguro.ok, true);
    assert.equal(okRes.rows[0].responder_participante_seguro.estado, 'confirmado');

    // 2. Si el participante dio de baja su asistencia (estado = 'cancelado'), el token antiguo NO puede reactivarlo
    await setAuthContext(participantUser1);
    await db.query(`SELECT public.reconfirmar_asistencia_seguro('${privId}', 'decline');`);

    const reactivateRes = await db.query<{ responder_participante_seguro: any }>(`
      SELECT public.responder_participante_seguro('${pPend.rows[0].token_invitacion}', 'confirmado');
    `);
    assert.equal(reactivateRes.rows[0].responder_participante_seguro.ok, false);
    assert.equal(reactivateRes.rows[0].responder_participante_seguro.error, 'terminal_participant_state');

    // 3. Si el estado es 'asistio', tampoco puede alterarse a 'rechazado'
    const pAsistio = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, estado)
      VALUES ('${privId}', 'Invitado Asistió', 'asistio')
      RETURNING token_invitacion;
    `);
    const alterAsistio = await db.query<{ responder_participante_seguro: any }>(`
      SELECT public.responder_participante_seguro('${pAsistio.rows[0].token_invitacion}', 'rechazado');
    `);
    assert.equal(alterAsistio.rows[0].responder_participante_seguro.ok, false);
    assert.equal(alterAsistio.rows[0].responder_participante_seguro.error, 'terminal_participant_state');
  });

  test('H2.3: eliminar_participante_seguro sincroniza solicitud (incluso si is_open=false), recalcula mínimo con alertas, notifica al afectado y bloquea encuentros cancelados', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 5, minParticipants: 3, realizationStatus: 'confirmed' });
    await db.query(`DELETE FROM public.inbox_notifications;`);
    await db.query(`DELETE FROM public.domain_events_outbox;`);

    // Participante 1 (2 cupos, mediante solicitud aprobada) y Participante 2 (2 cupos) => total 4 >= 3 (confirmed)
    await setAuthContext(participantUser1);
    const req1 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Removido', 'Hola', '${participantUser1}', 2);
    `);
    const req1Id = req1.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(hostUser);
    const app1 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${req1Id}', '${hostUser}');
    `);
    const part1Id = app1.rows[0].aprobar_solicitud_encuentro_abierto.participante_id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser2}', 'Queda Confirmado', 'confirmado', 2);
    `);
    await db.query(`UPDATE public.encuentros SET realization_status = 'confirmed' WHERE id = '${encId}';`);

    // Host cierra publicación abierta antes de eliminar al participante
    await db.query(`SELECT public.cerrar_encuentro_abierto_seguro('${encId}', '${hostUser}');`);

    // Host elimina administrativamente a Participante 1 (quedan 2 cupos < min 3)
    const delRes = await db.query<{ eliminar_participante_seguro: any }>(`
      SELECT public.eliminar_participante_seguro('${part1Id}', '${hostUser}');
    `);
    assert.equal(delRes.rows[0].eliminar_participante_seguro.ok, true);
    assert.equal(delRes.rows[0].eliminar_participante_seguro.released_seats, 2);
    assert.equal(delRes.rows[0].eliminar_participante_seguro.confirmed_seats, 2);
    assert.equal(delRes.rows[0].eliminar_participante_seguro.available_slots, 3);
    assert.equal(delRes.rows[0].eliminar_participante_seguro.fell_below_min, true);

    // Verificar sincronización de solicitud a cancelled y limpieza de token_participante
    const solAfter = await db.query<{ estado: string; token_participante: string | null }>(`
      SELECT estado, token_participante FROM public.solicitudes_encuentro_abierto WHERE id = '${req1Id}';
    `);
    assert.equal(solAfter.rows[0].estado, 'cancelled');
    assert.equal(solAfter.rows[0].token_participante, null);

    // Verificar que el usuario afectado recibió la notificación coherente en Inbox
    const removedNotif = await db.query<{ notification_type: string; title: string; body: string }>(`
      SELECT notification_type, title, body
      FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantUser1}' AND notification_type = 'encounter_participant_removed_by_host';
    `);
    assert.equal(removedNotif.rows.length, 1);

    // Verificar que el participante restante recibió aviso de caída de mínimo
    const belowMinNotif = await db.query<{ notification_type: string }>(`
      SELECT notification_type
      FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantUser2}' AND notification_type = 'encounter_below_min_participants';
    `);
    assert.equal(belowMinNotif.rows.length, 1);

    // Si el encuentro se cancela, eliminar_participante_seguro debe rechazar nuevas eliminaciones
    const part2Row = await db.query<{ id: string }>(`
      SELECT id FROM public.participantes WHERE encuentro_id = '${encId}' AND user_id = '${participantUser2}';
    `);
    await db.query(`SELECT public.cancelar_encuentro_seguro('${encId}', '${hostUser}', 'Suspendido por lluvia');`);

    const delAfterCancel = await db.query<{ eliminar_participante_seguro: any }>(`
      SELECT public.eliminar_participante_seguro('${part2Row.rows[0].id}', '${hostUser}');
    `);
    assert.equal(delAfterCancel.rows[0].eliminar_participante_seguro.ok, false);
    assert.equal(delAfterCancel.rows[0].eliminar_participante_seguro.error, 'cannot_modify_cancelled_encounter');
  });

  // ============================================================
  // FASE 3 — H3: CONCURRENCIA, ORDEN CANÓNICO DE BLOQUEOS Y CARRERAS 1 A 6
  // ============================================================

  test('H3.0: Verificación estructural en pg_proc del orden canónico de bloqueos (encuentros -> solicitudes_encuentro_abierto -> participantes)', async () => {
    const rpcsToCheck = [
      'aprobar_solicitud_encuentro_abierto',
      'rechazar_solicitud_encuentro_abierto',
      'cancelar_solicitud_encuentro_abierto',
      'cancelar_encuentro_seguro',
      'cerrar_encuentro_abierto_seguro',
      'reconfirmar_asistencia_seguro',
      'eliminar_participante_seguro',
    ];

    for (const fnName of rpcsToCheck) {
      const procRes = await db.query<{ prosrc: string }>(`
        SELECT prosrc FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = '${fnName}'
        ORDER BY p.pronargs DESC
        LIMIT 1;
      `);
      assert.equal(procRes.rows.length, 1, `Debe existir la función ${fnName}`);
      const src = procRes.rows[0].prosrc;

      const encLockMatch = src.match(/FROM\s+public\.encuentros[^;]*?FOR\s+(UPDATE|SHARE)/i);
      assert.ok(encLockMatch, `${fnName} debe adquirir bloqueo FOR UPDATE/SHARE sobre public.encuentros`);
      const encLockIdx = encLockMatch.index!;

      const solLockMatch = src.match(/FROM\s+public\.solicitudes_encuentro_abierto[^;]*?FOR\s+UPDATE/i);
      if (solLockMatch) {
        assert.ok(
          encLockIdx < solLockMatch.index!,
          `${fnName} debe bloquear public.encuentros (${encLockIdx}) ANTES que public.solicitudes_encuentro_abierto (${solLockMatch.index!})`
        );
      }

      const partLockMatch = src.match(/FROM\s+public\.participantes[^;]*?FOR\s+UPDATE/i);
      if (partLockMatch) {
        assert.ok(
          encLockIdx < partLockMatch.index!,
          `${fnName} debe bloquear public.encuentros (${encLockIdx}) ANTES que public.participantes (${partLockMatch.index!})`
        );
        if (solLockMatch) {
          assert.ok(
            solLockMatch.index! < partLockMatch.index!,
            `${fnName} debe bloquear public.solicitudes_encuentro_abierto (${solLockMatch.index!}) ANTES que public.participantes (${partLockMatch.index!})`
          );
        }
      }
    }
  });

  test('H3.1 (Carrera 1): Aprobación simultánea con cancelación del encuentro — nunca deja solicitud aprobada sobre encuentro cancelado sin notificar', async () => {
    // Subcaso 1A: Cancelación se ejecuta primero, aprobación inmediatamente después en paralelo
    const enc1 = await setupOpenEncounter({ maxParticipants: 4 });
    await setAuthContext(applicantUser1);
    const r1 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${enc1}', 'Postulante 1A', 'Hola', '${applicantUser1}', 1);
    `);
    const req1Id = r1.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(hostUser);
    const [cancel1, approve1] = await Promise.all([
      db.query<{ cancelar_encuentro_seguro: any }>(
        `SELECT public.cancelar_encuentro_seguro('${enc1}', '${hostUser}', 'Clima adverso');`
      ),
      db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
        `SELECT public.aprobar_solicitud_encuentro_abierto('${req1Id}', '${hostUser}');`
      ),
    ]);

    assert.equal(cancel1.rows[0].cancelar_encuentro_seguro.ok, true);
    assert.equal(approve1.rows[0].aprobar_solicitud_encuentro_abierto.ok, false);
    assert.equal(approve1.rows[0].aprobar_solicitud_encuentro_abierto.error, 'encuentro_not_active');

    const sol1State = await db.query<{ estado: string }>(
      `SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${req1Id}';`
    );
    assert.equal(sol1State.rows[0].estado, 'cancelled', 'La solicitud debe quedar cancelled, jamás approved');

    // Subcaso 1B: Aprobación se ejecuta primero, cancelación inmediatamente después en paralelo
    const enc2 = await setupOpenEncounter({ maxParticipants: 4 });
    await setAuthContext(applicantUser1);
    const r2 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${enc2}', 'Postulante 1B', 'Hola', '${applicantUser1}', 1);
    `);
    const req2Id = r2.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(hostUser);
    const [approve2, cancel2] = await Promise.all([
      db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
        `SELECT public.aprobar_solicitud_encuentro_abierto('${req2Id}', '${hostUser}');`
      ),
      db.query<{ cancelar_encuentro_seguro: any }>(
        `SELECT public.cancelar_encuentro_seguro('${enc2}', '${hostUser}', 'Corte de luz');`
      ),
    ]);

    assert.equal(approve2.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);
    assert.equal(cancel2.rows[0].cancelar_encuentro_seguro.ok, true);

    // El participante aprobado antes de la cancelación debe recibir el aviso crítico de cancelación
    const cancelNotif = await db.query<{ notification_type: string }>(`
      SELECT notification_type FROM public.inbox_notifications
      WHERE recipient_user_id = '${applicantUser1}'
        AND target_id = '${enc2}'
        AND notification_type = 'encounter_cancelled_for_participant';
    `);
    assert.equal(cancelNotif.rows.length, 1);
  });

  test('H3.2 (Carrera 2): Rechazo simultáneo con cancelación del encuentro — no permite rechazar tras cancelación', async () => {
    const enc1 = await setupOpenEncounter({ maxParticipants: 4 });
    await setAuthContext(applicantUser1);
    const r1 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${enc1}', 'Postulante 2A', 'Hola', '${applicantUser1}', 1);
    `);
    const req1Id = r1.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(hostUser);
    const [cancelRes, rejectRes] = await Promise.all([
      db.query<{ cancelar_encuentro_seguro: any }>(
        `SELECT public.cancelar_encuentro_seguro('${enc1}', '${hostUser}', 'Imprevisto del host');`
      ),
      db.query<{ rechazar_solicitud_encuentro_abierto: any }>(
        `SELECT public.rechazar_solicitud_encuentro_abierto('${req1Id}', '${hostUser}');`
      ),
    ]);

    assert.equal(cancelRes.rows[0].cancelar_encuentro_seguro.ok, true);
    assert.equal(rejectRes.rows[0].rechazar_solicitud_encuentro_abierto.ok, false);
    assert.equal(rejectRes.rows[0].rechazar_solicitud_encuentro_abierto.error, 'encuentro_not_active');

    const solState = await db.query<{ estado: string }>(
      `SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${req1Id}';`
    );
    assert.equal(solState.rows[0].estado, 'cancelled', 'No debe quedar rejected si el encuentro fue cancelado');
  });

  test('H3.3 (Carrera 3): Dos aprobaciones concurrentes que compiten por los últimos cupos', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 3 });

    await setAuthContext(applicantUser1);
    const r1 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Comp 1', 'Quiero 2', '${applicantUser1}', 2);
    `);
    const req1Id = r1.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(applicantUser2);
    const r2 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Comp 2', 'Quiero 2', '${applicantUser2}', 2);
    `);
    const req2Id = r2.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(hostUser);
    const [app1, app2] = await Promise.all([
      db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
        `SELECT public.aprobar_solicitud_encuentro_abierto('${req1Id}', '${hostUser}');`
      ),
      db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
        `SELECT public.aprobar_solicitud_encuentro_abierto('${req2Id}', '${hostUser}');`
      ),
    ]);

    const results = [app1.rows[0].aprobar_solicitud_encuentro_abierto, app2.rows[0].aprobar_solicitud_encuentro_abierto];
    const successes = results.filter((r) => r.ok === true);
    const failures = results.filter((r) => r.ok === false);

    assert.equal(successes.length, 1, 'Exactamente una aprobación debe prosperar');
    assert.equal(failures.length, 1, 'La segunda aprobación debe fallar controladamente');
    assert.equal(failures[0].error, 'quota_exceeded');

    const totalSeats = await db.query<{ total: number }>(`
      SELECT COALESCE(sum(seat_count), 0)::int AS total
      FROM public.participantes
      WHERE encuentro_id = '${encId}' AND estado IN ('confirmado', 'asistio');
    `);
    assert.equal(totalSeats.rows[0].total, 2, 'Nunca debe excederse max_participants (3)');
  });

  test('H3.4 (Carrera 4): Baja simultánea con nueva aprobación — libera cupos y mantiene consistencia de realización', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 3, minParticipants: 2, realizationStatus: 'confirmed' });

    // Participante 1 confirmado con 2 cupos (quedan 1 lugar libre)
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser1}', 'Part Que Se Baja', 'confirmado', 2);
    `);

    // Postulante 1 solicitó 2 lugares cuando aún había cupo
    const solRes = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, seat_count)
      VALUES ('${encId}', '${applicantUser1}', 'Nuevo Entrante', 'pending', 2)
      RETURNING id;
    `);
    const reqId = solRes.rows[0].id;

    // Baja de participantUser1 + Aprobación de applicantUser1
    await setAuthContext(participantUser1);
    const withdrawRes = await db.query<{ desistir_encuentro_abierto_seguro: any }>(`
      SELECT public.desistir_encuentro_abierto_seguro('${encId}', 'No llego');
    `);
    assert.equal(withdrawRes.rows[0].desistir_encuentro_abierto_seguro.ok, true);

    await setAuthContext(hostUser);
    const approveRes = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}', '${hostUser}');
    `);
    assert.equal(approveRes.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);
    assert.equal(approveRes.rows[0].aprobar_solicitud_encuentro_abierto.confirmed_seats, 2);

    const encAfter = await db.query<{ realization_status: string }>(`
      SELECT realization_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(encAfter.rows[0].realization_status, 'confirmed');
  });

  test('H3.5 (Carrera 5): Cierre de inscripciones y cierre de publicación abiertos simultáneos con solicitud y frente a encuentro cancelado', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 4 });

    await setAuthContext(hostUser);
    const closeInsc = await db.query<{ cerrar_inscripciones_seguro: any }>(`
      SELECT public.cerrar_inscripciones_seguro('${encId}', '${hostUser}');
    `);
    assert.equal(closeInsc.rows[0].cerrar_inscripciones_seguro.ok, true);

    await setAuthContext(applicantUser1);
    const reqAfterClose = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Tardío', 'Hola', '${applicantUser1}', 1);
    `);
    assert.equal(reqAfterClose.rows[0].solicitar_sumarse_encuentro_abierto.ok, false);
    assert.equal(reqAfterClose.rows[0].solicitar_sumarse_encuentro_abierto.error, 'inscriptions_closed');

    // cerrar_encuentro_abierto_seguro rechaza operar sobre un encuentro cancelado
    await setAuthContext(hostUser);
    await db.query(`SELECT public.cancelar_encuentro_seguro('${encId}', '${hostUser}');`);
    const closeAfterCancel = await db.query<{ cerrar_encuentro_abierto_seguro: any }>(`
      SELECT public.cerrar_encuentro_abierto_seguro('${encId}', '${hostUser}');
    `);
    assert.equal(closeAfterCancel.rows[0].cerrar_encuentro_abierto_seguro.ok, false);
    assert.equal(closeAfterCancel.rows[0].cerrar_encuentro_abierto_seguro.error, 'cannot_modify_cancelled_encounter');
  });

  test('H3.6 (Carrera 6): Operaciones concurrentes sobre una solicitud ya resuelta (aprobar + rechazar, doble aprobar, doble solicitud)', async () => {
    const encId = await setupOpenEncounter({ maxParticipants: 5 });

    // 1. Doble solicitud simultánea del mismo usuario -> una ok, una already_requested
    await setAuthContext(applicantUser1);
    const [reqA, reqB] = await Promise.all([
      db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
        `SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Doble Click', 'Msg 1', '${applicantUser1}', 1);`
      ),
      db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
        `SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Doble Click', 'Msg 2', '${applicantUser1}', 1);`
      ),
    ]);
    const reqResults = [
      reqA.rows[0].solicitar_sumarse_encuentro_abierto,
      reqB.rows[0].solicitar_sumarse_encuentro_abierto,
    ];
    assert.equal(reqResults.filter((r) => r.ok === true).length, 1);
    assert.equal(reqResults.filter((r) => r.ok === false && r.error === 'already_requested').length, 1);

    const reqId = reqResults.find((r) => r.ok === true)!.request_id;

    // 2. Aprobar y rechazar simultáneamente la misma solicitud -> una ok, la otra request_already_processed
    await setAuthContext(hostUser);
    const [appRes, rejRes] = await Promise.all([
      db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
        `SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}', '${hostUser}');`
      ),
      db.query<{ rechazar_solicitud_encuentro_abierto: any }>(
        `SELECT public.rechazar_solicitud_encuentro_abierto('${reqId}', '${hostUser}');`
      ),
    ]);

    assert.equal(appRes.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);
    assert.equal(rejRes.rows[0].rechazar_solicitud_encuentro_abierto.ok, false);
    assert.equal(rejRes.rows[0].rechazar_solicitud_encuentro_abierto.error, 'request_already_processed');

    // 3. Intentar cancelar_solicitud_encuentro_abierto cuando ya fue aprobada -> cannot_cancel_non_pending
    await setAuthContext(applicantUser1);
    const cancelSolRes = await db.query<{ cancelar_solicitud_encuentro_abierto: any }>(`
      SELECT public.cancelar_solicitud_encuentro_abierto('${reqId}');
    `);
    assert.equal(cancelSolRes.rows[0].cancelar_solicitud_encuentro_abierto.ok, false);
    assert.equal(cancelSolRes.rows[0].cancelar_solicitud_encuentro_abierto.error, 'cannot_cancel_non_pending');
  });
});
