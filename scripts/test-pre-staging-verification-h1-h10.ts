import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

test('Pre-Staging Verification: H1-H10 Migrations, Notifications Dedup & Safe Navigation', async (t) => {
  const db = new PGlite();

  // Helper para simular auth.uid() en PGlite
  let currentUserId: string | null = null;
  const setAuthContext = async (userId: string | null) => {
    currentUserId = userId;
  };

  // Mock de auth.uid() y auth.jwt()
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
      SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$ LANGUAGE sql STABLE;

    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$
      SELECT COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
    $$ LANGUAGE sql STABLE;
  `);

  const setDbAuthUser = async (userId: string | null, isAnon: boolean = false) => {
    currentUserId = userId;
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": ${isAnon}}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    }
  };

  // 1. Cargar migraciones base necesarias
  const readMigration = (relPath: string) => {
    return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf-8');
  };

  // Setup de esquema base mínimo
  await db.exec(`
    CREATE TABLE IF NOT EXISTS public.perfiles (
      id UUID PRIMARY KEY,
      nombre TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.encuentros (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      host_id UUID NOT NULL,
      titulo TEXT,
      descripcion TEXT,
      fecha DATE,
      hora TIME,
      modalidad TEXT DEFAULT 'presencial',
      lugar_texto TEXT,
      link_virtual TEXT,
      estado TEXT DEFAULT 'creado',
      is_open BOOLEAN DEFAULT false,
      max_participants INT DEFAULT 10,
      min_participants INT,
      realization_status TEXT DEFAULT 'pending',
      inscriptions_closed BOOLEAN DEFAULT false,
      inscriptions_closed_at TIMESTAMPTZ,
      min_confirmed_notified_at TIMESTAMPTZ,
      open_public_title TEXT,
      open_description TEXT,
      open_public_zone TEXT,
      cancelled_at TIMESTAMPTZ,
      cancelled_by UUID,
      cancellation_reason TEXT,
      min_realization_cycle_id UUID,
      inscriptions_cycle_id UUID,
      allow_multi_seat_requests BOOLEAN DEFAULT false,
      max_seats_per_request INT DEFAULT 1,
      min_seats_per_request INT DEFAULT 1,
      moderation_status TEXT DEFAULT 'approved',
      opened_at TIMESTAMPTZ,
      creado_en TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
      blocker_id UUID,
      blocked_id UUID
    );

    CREATE TABLE IF NOT EXISTS public.participantes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
      user_id UUID,
      usuario_id UUID,
      nombre_invitado TEXT,
      rol TEXT DEFAULT 'invitado',
      tipo_invitacion TEXT DEFAULT 'individual',
      estado TEXT DEFAULT 'pendiente',
      token_invitacion UUID DEFAULT gen_random_uuid(),
      seat_count INT DEFAULT 1,
      reconfirmation_status TEXT DEFAULT 'pending',
      reconfirmed_at TIMESTAMPTZ,
      mensaje_respuesta TEXT,
      motivo_baja TEXT,
      motivo_baja_privado TEXT,
      motivo_baja_updated_at TIMESTAMPTZ,
      creado_en TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
      usuario_id UUID NOT NULL,
      nombre_solicitante TEXT NOT NULL,
      mensaje TEXT,
      estado TEXT DEFAULT 'pending',
      seat_count INT DEFAULT 1,
      participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
      token_participante UUID,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.inbox_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipient_user_id UUID NOT NULL,
      notification_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id UUID NOT NULL,
      deep_link TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      payload JSONB DEFAULT '{}'::jsonb,
      dedup_key TEXT,
      is_read BOOLEAN DEFAULT false,
      read_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '14 days',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT uq_inbox_notifications_user_dedup UNIQUE (recipient_user_id, dedup_key)
    );

    CREATE TABLE IF NOT EXISTS public.domain_events_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type TEXT NOT NULL,
      event_version INT NOT NULL DEFAULT 1,
      aggregate_type TEXT NOT NULL,
      aggregate_id UUID NOT NULL,
      actor_user_id UUID,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      dedup_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT uq_domain_events_dedup UNIQUE (dedup_key)
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
      v_dedup TEXT := COALESCE(p_dedup_key, p_notification_type || ':' || p_target_id);
      v_expires TIMESTAMPTZ := COALESCE(p_expires_at, timezone('utc', now()) + INTERVAL '14 days');
      v_inserted_id UUID;
    BEGIN
      IF p_recipient_user_id IS NULL OR p_notification_type IS NULL OR p_target_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
      END IF;

      INSERT INTO public.inbox_notifications (
        recipient_user_id, notification_type, target_type, target_id,
        deep_link, title, body, payload, dedup_key, expires_at
      ) VALUES (
        p_recipient_user_id, p_notification_type, p_target_type, p_target_id,
        p_deep_link, p_title, p_body, COALESCE(p_payload, '{}'::jsonb), v_dedup, v_expires
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

  // 2. Aplicar migraciones previas necesarias para get_encuentro_participante_autorizado
  const mig1418 = readMigration('supabase/migrations/20261014180000_fase_lifecycle_realization_and_cancellation_reasons.sql');
  // Extraer get_encuentro_participante_autorizado
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.get_encuentro_participante_autorizado(
        p_encuentro_id UUID
    )
    RETURNS JSON
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = ''
    AS $$
    DECLARE
        v_user_id UUID := auth.uid();
        v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
        v_encuentro public.encuentros%ROWTYPE;
        v_is_host BOOLEAN := false;
        v_is_participant BOOLEAN := false;
        v_part_seats INT := 1;
        v_reconf_status TEXT := 'pending';
    BEGIN
        IF v_user_id IS NULL THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
        END IF;

        IF v_is_anon THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'permanent_account_required');
        END IF;

        SELECT * INTO v_encuentro
        FROM public.encuentros
        WHERE id = p_encuentro_id;

        IF NOT FOUND THEN
            RETURN pg_catalog.json_build_object('ok', false, 'error', 'not_found');
        END IF;

        IF v_encuentro.host_id = v_user_id THEN
            v_is_host := true;
        ELSE
            SELECT EXISTS (
                SELECT 1 FROM public.participantes p
                WHERE p.encuentro_id = p_encuentro_id
                  AND p.user_id = v_user_id
                  AND p.estado IN ('confirmado', 'asistio')
            ) INTO v_is_participant;

            IF NOT v_is_participant THEN
                RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
            END IF;

            SELECT
                COALESCE(p.seat_count, 1),
                COALESCE(p.reconfirmation_status, 'pending')
            INTO
                v_part_seats,
                v_reconf_status
            FROM public.participantes p
            WHERE p.encuentro_id = p_encuentro_id
              AND p.user_id = v_user_id
              AND p.estado IN ('confirmado', 'asistio')
            LIMIT 1;
        END IF;

        RETURN pg_catalog.json_build_object(
            'ok', true,
            'id', v_encuentro.id,
            'is_host', v_is_host,
            'open_public_title', CASE
                WHEN v_is_host THEN COALESCE(v_encuentro.open_public_title, v_encuentro.titulo)
                ELSE COALESCE(v_encuentro.open_public_title, 'Encuentro')
            END,
            'open_description', CASE
                WHEN v_is_host THEN COALESCE(v_encuentro.open_description, v_encuentro.descripcion)
                ELSE COALESCE(v_encuentro.open_description, '')
            END,
            'fecha', v_encuentro.fecha,
            'hora', v_encuentro.hora,
            'modalidad', v_encuentro.modalidad,
            'open_public_zone', v_encuentro.open_public_zone,
            'lugar_texto', CASE
                WHEN v_encuentro.estado = 'cancelado' THEN NULL
                WHEN v_encuentro.modalidad = 'presencial' THEN v_encuentro.lugar_texto
                ELSE NULL
            END,
            'link_virtual', CASE
                WHEN v_encuentro.estado = 'cancelado' THEN NULL
                WHEN v_encuentro.modalidad = 'virtual' THEN v_encuentro.link_virtual
                ELSE NULL
            END,
            'seat_count', CASE WHEN v_is_host THEN NULL ELSE v_part_seats END,
            'estado', v_encuentro.estado,
            'cancellation_reason', CASE WHEN v_encuentro.estado = 'cancelado' THEN v_encuentro.cancellation_reason ELSE NULL END,
            'min_participants', v_encuentro.min_participants,
            'realization_status', COALESCE(v_encuentro.realization_status, 'pending'),
            'inscriptions_closed', COALESCE(v_encuentro.inscriptions_closed, false),
            'reconfirmation_status', CASE WHEN v_is_host THEN NULL ELSE v_reconf_status END
        );
    END;
    $$;
  `);

  // 3. Aplicar las 3 migraciones pendientes en estricto orden cronológico
  console.log('1. Verificando aplicación ordenada de las 3 migraciones locales pendientes...');

  const migH9H10 = readMigration('supabase/migrations/20261016180000_open_encounter_withdrawal_and_sync_h9_h10.sql');
  await db.exec(migH9H10);
  console.log('  ✔ 20261016180000_open_encounter_withdrawal_and_sync_h9_h10.sql aplicada correctamente.');

  const migH2H3 = readMigration('supabase/migrations/20261016193000_harden_legacy_rpcs_and_concurrency_h2_h3.sql');
  await db.exec(migH2H3);
  console.log('  ✔ 20261016193000_harden_legacy_rpcs_and_concurrency_h2_h3.sql aplicada correctamente.');

  const migH6H7 = readMigration('supabase/migrations/20261016200000_harden_lifecycle_transitions_and_navigation_h6_h7.sql');
  await db.exec(migH6H7);
  console.log('  ✔ 20261016200000_harden_lifecycle_transitions_and_navigation_h6_h7.sql aplicada correctamente.');

  // Constantes de prueba
  const hostId = '11111111-1111-4111-8111-111111111111';
  const user1 = '22222222-2222-4222-8222-222222222222';
  const user2 = '33333333-3333-4333-8333-333333333333';
  const user3 = '44444444-4444-4444-8444-444444444444';
  const user4 = '55555555-5555-4555-8555-555555555555';
  const stranger = '99999999-9999-4999-8999-999999999999';

  // ----------------------------------------------------
  // PRUEBA 2: Deduplicación con múltiples destinatarios y outbox
  // ----------------------------------------------------
  await t.test('2. Deduplicación por ciclo con múltiples destinatarios e integridad de outbox', async () => {
    // Crear encuentro con min_participants = 3, max_participants = 5
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, fecha, hora, modalidad, lugar_texto,
        estado, is_open, max_participants, min_participants, realization_status, moderation_status
      ) VALUES (
        '${hostId}', 'Juegos de mesa', 'Tarde de Juegos', CURRENT_DATE + 3, '18:00',
        'presencial', 'Av. Corrientes 1234, CABA', 'activo', true, 5, 3, 'pending', 'approved'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Crear solicitudes de user1, user2, user3
    await setDbAuthUser(user1);
    const req1Res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'User 1', 'Quiero ir', '${user1}', 1);
    `);
    assert.equal(req1Res.rows[0].solicitar_sumarse_encuentro_abierto.ok, true, JSON.stringify(req1Res.rows[0]));
    const req1Id = req1Res.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setDbAuthUser(user2);
    const req2Res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'User 2', 'Voy', '${user2}', 1);
    `);
    assert.equal(req2Res.rows[0].solicitar_sumarse_encuentro_abierto.ok, true, JSON.stringify(req2Res.rows[0]));
    const req2Id = req2Res.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setDbAuthUser(user3);
    const req3Res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'User 3', 'Me sumo', '${user3}', 1);
    `);
    assert.equal(req3Res.rows[0].solicitar_sumarse_encuentro_abierto.ok, true, JSON.stringify(req3Res.rows[0]));
    const req3Id = req3Res.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    // Host aprueba solicitud 1 y 2
    await setDbAuthUser(hostId);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${req1Id}', '${hostId}');`);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${req2Id}', '${hostId}');`);

    // El encuentro aún no alcanza el mínimo (2 < 3)
    let notifsMin = await db.query(`
      SELECT * FROM public.inbox_notifications
      WHERE target_id = '${encId}' AND notification_type = 'encounter_min_participants_reached';
    `);
    assert.equal(notifsMin.rows.length, 0, 'No debe haber avisos de mínimo alcanzado antes de 3 participantes');

    // Host aprueba solicitud 3 -> se alcanza el mínimo (3 >= 3)!
    const app3Res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${req3Id}', '${hostId}');
    `);
    assert.equal(app3Res.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);

    // Verificar que CADA UNO de los participantes confirmados (user1, user2, user3) recibió su aviso en inbox
    notifsMin = await db.query(`
      SELECT recipient_user_id, dedup_key FROM public.inbox_notifications
      WHERE target_id = '${encId}' AND notification_type = 'encounter_min_participants_reached'
      ORDER BY recipient_user_id;
    `);
    assert.equal(notifsMin.rows.length, 3, 'Los 3 participantes confirmados deben recibir notificación de mínimo alcanzado');
    const recipients = notifsMin.rows.map((r: any) => r.recipient_user_id).sort();
    assert.deepEqual(recipients, [user1, user2, user3].sort(), 'Destinatarios deben ser exactamente user1, user2, user3');

    // Verificar eventos en domain_events_outbox para aprobaciones
    const outboxEvents = await db.query(`
      SELECT dedup_key, payload FROM public.domain_events_outbox
      WHERE aggregate_id = '${encId}' AND event_type = 'encounter.join_request.approved.v1'
      ORDER BY dedup_key;
    `);
    assert.equal(outboxEvents.rows.length, 3, 'Debe haber 3 eventos de dominio de aprobación en outbox sin colisiones');

    // Idempotencia: reintentar no duplica avisos ni eventos
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${req3Id}', '${hostId}');`);
    const notifsAfterRetry = await db.query(`
      SELECT id FROM public.inbox_notifications
      WHERE target_id = '${encId}' AND notification_type = 'encounter_min_participants_reached';
    `);
    assert.equal(notifsAfterRetry.rows.length, 3, 'Reintento idempotente no genera avisos duplicados');

    // Transición de baja (user3 desiste) -> cae por debajo del mínimo (2 < 3)
    await setDbAuthUser(user3);
    const desistRes = await db.query<{ desistir_encuentro_abierto_seguro: any }>(`
      SELECT public.desistir_encuentro_abierto_seguro('${encId}', 'No puedo ir');
    `);
    assert.equal(desistRes.rows[0].desistir_encuentro_abierto_seguro.ok, true, JSON.stringify(desistRes.rows[0]));

    // Los participantes restantes (user1 y user2) reciben encounter_below_min_participants
    const notifsBelow = await db.query(`
      SELECT recipient_user_id FROM public.inbox_notifications
      WHERE target_id = '${encId}' AND notification_type = 'encounter_below_min_participants'
        AND recipient_user_id <> '${hostId}';
    `);
    assert.equal(notifsBelow.rows.length, 2, 'Los 2 participantes restantes deben recibir encounter_below_min_participants');

    // Nueva postulación: user4 se suma y host aprueba -> NUEVO CICLO legítimo
    await setDbAuthUser(user4);
    const req4Res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'User 4', 'Me uno', '${user4}', 1);
    `);
    assert.equal(req4Res.rows[0].solicitar_sumarse_encuentro_abierto.ok, true, JSON.stringify(req4Res.rows[0]));
    const req4Id = req4Res.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setDbAuthUser(hostId);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${req4Id}', '${hostId}');`);

    // Comprobar que en el nuevo ciclo se generaron NUEVOS avisos para los participantes confirmados actuales
    const allMinReached = await db.query(`
      SELECT recipient_user_id, dedup_key FROM public.inbox_notifications
      WHERE target_id = '${encId}' AND notification_type = 'encounter_min_participants_reached';
    `);
    // user1 tiene 2 avisos (uno por ciclo 1, otro por ciclo 2)
    // user2 tiene 2 avisos (uno por ciclo 1, otro por ciclo 2)
    // user3 tiene 1 aviso (del ciclo 1)
    // user4 tiene 1 aviso (del ciclo 2)
    // Total = 6 notificaciones en inbox
    assert.equal(allMinReached.rows.length, 6, 'El segundo ciclo legítimo genera nuevos avisos para cada participante activo');
  });

  // ----------------------------------------------------
  // PRUEBA 3: Navegación real H7 y privacidad de logística
  // ----------------------------------------------------
  await t.test('3. Navegación autorizada H7 y ocultamiento estricto de logística privada', async () => {
    // Crear encuentro activo presencial con logística privada
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, fecha, hora, modalidad, lugar_texto, link_virtual,
        estado, is_open, max_participants, min_participants, realization_status
      ) VALUES (
        '${hostId}', 'Taller de Arte', 'Taller Abierto', CURRENT_DATE + 5, '15:00',
        'presencial', 'Calle Privada 742, Piso 4 B', 'https://meet.google.com/secret',
        'creado', true, 10, 2, 'pending'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // user1 confirmado
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${user1}', 'User 1', 'confirmado', 1);
    `);

    // user2 solicitante pendiente
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encId}', '${user2}', 'User 2', 'pending');
    `);

    // user3 solicitante rechazado
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encId}', '${user3}', 'User 3', 'rejected');
    `);

    // CASO A: Participante confirmado en encuentro ACTIVO
    await setDbAuthUser(user1);
    const detUser1Active = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${encId}');
    `);
    const dataActive = detUser1Active.rows[0].get_encuentro_participante_autorizado;
    assert.equal(dataActive.ok, true, 'Participante confirmado debe tener acceso ok: true');
    assert.equal(dataActive.lugar_texto, 'Calle Privada 742, Piso 4 B', 'Logística presencial visible en estado activo');

    // CASO B: Solicitante pendiente en encuentro activo -> NO tiene acceso a logística privada
    await setDbAuthUser(user2);
    const detUser2 = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${encId}');
    `);
    assert.equal(detUser2.rows[0].get_encuentro_participante_autorizado.ok, false);
    assert.equal(detUser2.rows[0].get_encuentro_participante_autorizado.error, 'unauthorized');

    // CASO C: Solicitante rechazado -> NO tiene acceso
    await setDbAuthUser(user3);
    const detUser3 = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${encId}');
    `);
    assert.equal(detUser3.rows[0].get_encuentro_participante_autorizado.ok, false);
    assert.equal(detUser3.rows[0].get_encuentro_participante_autorizado.error, 'unauthorized');

    // CASO D: Usuario sin autorización (extraño) -> NO tiene acceso
    await setDbAuthUser(stranger);
    const detStranger = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${encId}');
    `);
    assert.equal(detStranger.rows[0].get_encuentro_participante_autorizado.ok, false);
    assert.equal(detStranger.rows[0].get_encuentro_participante_autorizado.error, 'unauthorized');

    // CASO E: Encuentro retirado de Discovery (is_open = false) pero sigue activo
    await db.query(`UPDATE public.encuentros SET is_open = false WHERE id = '${encId}';`);
    await setDbAuthUser(user1);
    const detWithdrawnDiscovery = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${encId}');
    `);
    assert.equal(detWithdrawnDiscovery.rows[0].get_encuentro_participante_autorizado.ok, true);
    assert.equal(detWithdrawnDiscovery.rows[0].get_encuentro_participante_autorizado.lugar_texto, 'Calle Privada 742, Piso 4 B');

    // CASO F: Cancelación del encuentro -> Participante confirmado conserva acceso a motivo pero CERO logística
    await setDbAuthUser(hostId);
    const cancelRes = await db.query<{ cancelar_encuentro_seguro: any }>(`
      SELECT public.cancelar_encuentro_seguro('${encId}', '${hostId}', 'Lluvia torrencial');
    `);
    assert.equal(cancelRes.rows[0].cancelar_encuentro_seguro.ok, true);

    await setDbAuthUser(user1);
    const detUser1Cancelled = await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${encId}');
    `);
    const dataCancelled = detUser1Cancelled.rows[0].get_encuentro_participante_autorizado;
    assert.equal(dataCancelled.ok, true, 'Participante confirmado conserva acceso a la ficha de cancelación');
    assert.equal(dataCancelled.estado, 'cancelado');
    assert.equal(dataCancelled.cancellation_reason, 'Lluvia torrencial', 'Motivo de cancelación visible');
    assert.equal(dataCancelled.lugar_texto, null, 'Logística presencial CENSURADA forzosamente al cancelar');
    assert.equal(dataCancelled.link_virtual, null, 'Enlace virtual CENSURADO forzosamente al cancelar');

    // Verificar deep links generados por la cancelación
    const notifUser1 = await db.query(`
      SELECT deep_link FROM public.inbox_notifications
      WHERE recipient_user_id = '${user1}' AND target_id = '${encId}';
    `);
    assert.equal(
      notifUser1.rows[0].deep_link,
      `/?tab=encuentros&open_detail=${encId}`,
      'Deep link para participante confirmado debe abrir sheet autorizado open_detail'
    );

    const notifUser2 = await db.query(`
      SELECT deep_link FROM public.inbox_notifications
      WHERE recipient_user_id = '${user2}' AND target_id = '${encId}';
    `);
    assert.equal(
      notifUser2.rows[0].deep_link,
      `/?tab=solicitudes`,
      'Deep link para solicitante cancelado debe dirigir a /?tab=solicitudes'
    );
  });
});
