import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Mini-Sprint B: Lista de espera, prioridad FIFO, reservas temporales y recuperación de cupos', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const candA = '22222222-2222-2222-2222-222222222222';
  const candB = '33333333-3333-3333-3333-333333333333';
  const candC = '44444444-4444-4444-4444-444444444444';
  const blockedUser = '55555555-5555-5555-5555-555555555555';
  const confirmedUser1 = '66666666-6666-6666-6666-666666666666';

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
        ('${candA}', 'canda@test.com'),
        ('${candB}', 'candb@test.com'),
        ('${candC}', 'candc@test.com'),
        ('${blockedUser}', 'blocked@test.com'),
        ('${confirmedUser1}', 'conf1@test.com')
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
        ('guemes', 'Güemes', 'Mar del Plata', 'Costa Atlántica', true)
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        blocker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        blocked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
        PRIMARY KEY (blocker_id, blocked_id)
      );

      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id) VALUES
        ('${hostUser}', '${blockedUser}')
      ON CONFLICT DO NOTHING;

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
        tipo_invitacion TEXT DEFAULT 'individual',
        mensaje_respuesta TEXT,
        respondido_en TIMESTAMPTZ,
        reconfirmation_status TEXT DEFAULT 'pending' CHECK (reconfirmation_status IN ('pending', 'confirmed', 'declined')),
        reconfirmed_at TIMESTAMPTZ,
        reconfirmation_cycle_id UUID,
        attendance_status TEXT NOT NULL DEFAULT 'unverified',
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
          recipient_user_id, notification_type, target_type, target_id,
          deep_link, title, body, payload, dedup_key, expires_at
        ) VALUES (
          p_recipient_user_id, p_notification_type, p_target_type, p_target_id,
          p_deep_link, p_title, p_body, p_payload, p_dedup_key, now() + interval '30 days'
        )
        ON CONFLICT (recipient_user_id, dedup_key) DO UPDATE
        SET title = EXCLUDED.title,
            body = EXCLUDED.body,
            payload = EXCLUDED.payload,
            read_at = NULL,
            created_at = now()
        RETURNING id INTO v_id;

        RETURN v_id;
      END;
      $$;
    `);

    // 2. Ejecutar la migración SQL aditiva de Mini-Sprint B
    const waitlistPath = path.join(__dirname, '../supabase/migrations/20261024220000_open_encounters_waitlist_and_recovery_v1.sql');
    const waitlistSql = fs.readFileSync(waitlistPath, 'utf8');
    await db.exec(waitlistSql);

    await db.exec(`
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon, service_role, postgres;
      GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticated, anon, service_role, postgres;
    `);

    // 3. Ejecutar la migración correctiva del Hotfix Mini-Sprint B
    const hotfixPath = path.join(__dirname, '../supabase/migrations/20261024230000_hotfix_waitlist_concurrency_and_discovery_v1.sql');
    const hotfixSql = fs.readFileSync(hotfixPath, 'utf8');
    await db.exec(hotfixSql);
  });

  const createEncounterFixture = async (opts: {
    id: string;
    maxParticipants: number;
    allowMultiSeat?: boolean;
    maxSeatsPerRequest?: number;
    inscriptionsClosed?: boolean;
    estado?: string;
    fechaOffsetDays?: number;
  }) => {
    const days = opts.fechaOffsetDays ?? 3;
    await db.query(`
      INSERT INTO public.encuentros (
        id, host_id, titulo, open_public_title, open_public_zone, locality_id,
        max_participants, allow_multi_seat_requests, max_seats_per_request,
        fecha, hora, lugar_texto, is_open, opened_at, inscriptions_closed, estado, moderation_status
      ) VALUES (
        '${opts.id}', '${hostUser}', 'Encuentro Test Waitlist', 'Waitlist Abierto', 'Palermo', 'palermo',
        ${opts.maxParticipants}, ${opts.allowMultiSeat ? 'true' : 'false'}, ${opts.maxSeatsPerRequest || 1},
        (CURRENT_DATE + INTERVAL '${days} days')::date, '19:00:00', 'Lugar Secreto Privado', true, now(),
        ${opts.inscriptionsClosed ? 'true' : 'false'}, '${opts.estado || 'activo'}', 'approved'
      );
    `);
  };

  test('1. Encuentro completo: usuario se anota voluntariamente en lista de espera y adquiere posición #1', async () => {
    const encId = '00000000-0000-0000-0001-000000000001';
    await createEncounterFixture({ id: encId, maxParticipants: 1 });

    // Ocupar el único cupo con confirmedUser1
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${confirmedUser1}', 'Participante 1', 'confirmado', 1);
    `);

    // candA se anota en lista de espera
    await setAuth(candA);
    const res = await db.query(`
      SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Candidato A', 'Quiero sumarme si se libera lugar', 1) AS r;
    `);

    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, true);
    assert.equal(r.position, 1, 'Debe ser el puesto #1');
    assert.equal(r.seat_count, 1);

    // Verificar en base de datos
    const check = await db.query(`
      SELECT estado, is_waitlist, seat_count FROM public.solicitudes_encuentro_abierto WHERE id = '${r.request_id}';
    `);
    assert.equal((check.rows[0] as any).estado, 'waitlist_waiting');
    assert.equal((check.rows[0] as any).is_waitlist, true);
  });

  test('2. Inscripción única: segundo intento con el mismo usuario es rechazado con already_requested', async () => {
    const encId = '00000000-0000-0000-0001-000000000001';
    await setAuth(candA);

    const res = await db.query(`
      SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Candidato A de nuevo', NULL, 1) AS r;
    `);

    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'already_requested', 'Un usuario no puede duplicar su inscripción activa');
  });

  test('3. Orden FIFO determinístico: segundo candidato se anota y adquiere posición #2', async () => {
    const encId = '00000000-0000-0000-0001-000000000001';
    await setAuth(candB);

    const res = await db.query(`
      SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Candidato B', 'Yo también espero', 1) AS r;
    `);

    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, true);
    assert.equal(r.position, 2, 'Debe ser el puesto #2');
  });

  test('4. Liberación de cupo promueve automáticamente al candidato #1 (waitlist_offered) con plazo temporal', async () => {
    const encId = '00000000-0000-0000-0001-000000000001';

    // confirmedUser1 desiste mediante reconfirmar_asistencia_seguro (decline)
    await setAuth(confirmedUser1);
    await db.query(`
      UPDATE public.participantes
      SET estado = 'cancelado', reconfirmation_status = 'declined'
      WHERE encuentro_id = '${encId}' AND user_id = '${confirmedUser1}';
    `);

    // El trigger trg_participantes_liberacion_waitlist ejecuta automáticamente evaluar_y_promover_lista_espera
    // Verificar que candA recibió la oferta automáticamente por el trigger
    const candACheck = await db.query(`
      SELECT estado, waitlist_offered_at, waitlist_expires_at
      FROM public.solicitudes_encuentro_abierto
      WHERE encuentro_id = '${encId}' AND usuario_id = '${candA}';
    `);
    const rowA = candACheck.rows[0] as any;
    assert.equal(rowA.estado, 'waitlist_offered');
    assert.ok(rowA.waitlist_offered_at !== null);
    assert.ok(rowA.waitlist_expires_at !== null);

    // Una invocación manual posterior es idempotente y no genera sobrepromoción
    const evalRes = await db.query(`
      SELECT public.evaluar_y_promover_lista_espera('${encId}'::uuid) AS r;
    `);
    const evalR = (evalRes.rows[0] as any).r;
    assert.equal(evalR.ok, true);
    assert.equal(evalR.promoted_count, 0, 'Invocación posterior idempotente (0 promovidos adicionales)');

    // Verificar que candB SIGUE en espera (FIFO estricto)
    const candBCheck = await db.query(`
      SELECT estado FROM public.solicitudes_encuentro_abierto
      WHERE encuentro_id = '${encId}' AND usuario_id = '${candB}';
    `);
    assert.equal((candBCheck.rows[0] as any).estado, 'waitlist_waiting');

    // Verificar notificación inbox para candA
    const notifCheck = await db.query(`
      SELECT notification_type, title FROM public.inbox_notifications
      WHERE recipient_user_id = '${candA}' AND notification_type = 'waitlist_offer_available';
    `);
    assert.equal(notifCheck.rows.length, 1);
  });

  test('5. Multi-seat sin bloqueo de cola: si candidato #1 pide más plazas que las disponibles, avanza al que quepa', async () => {
    const encId = '00000000-0000-0000-0001-000000000002';
    // Encuentro para 2 personas, actualmente 0 confirmadas (2 disponibles)
    await createEncounterFixture({ id: encId, maxParticipants: 2, allowMultiSeat: true, maxSeatsPerRequest: 4 });

    // candA pide 3 cupos (no cabe en 2 cupos)
    await setAuth(candA);
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist, created_at)
      VALUES ('${encId}', '${candA}', 'Candidato A (3)', 3, 'waitlist_waiting', true, now() - INTERVAL '10 minutes');
    `);

    // candB pide 2 cupos (cabe exactamente en 2 cupos)
    await setAuth(candB);
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist, created_at)
      VALUES ('${encId}', '${candB}', 'Candidato B (2)', 2, 'waitlist_waiting', true, now() - INTERVAL '5 minutes');
    `);

    // Evaluar promoción: candA no debe bloquear a candB
    const res = await db.query(`
      SELECT public.evaluar_y_promover_lista_espera('${encId}'::uuid) AS r;
    `);
    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, true);
    assert.equal(r.promoted_count, 1);

    // candA permanece en espera (esperando 3 plazas)
    const checkA = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candA}';`);
    assert.equal((checkA.rows[0] as any).estado, 'waitlist_waiting');

    // candB fue promovido porque pedía 2 plazas
    const checkB = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candB}';`);
    assert.equal((checkB.rows[0] as any).estado, 'waitlist_offered');
  });

  test('6. Acción «Sigo interesado»: candidato confirma oferta y pasa a waitlist_confirmed para revisión del host', async () => {
    const encId = '00000000-0000-0000-0001-000000000001';
    await setAuth(candA);

    const reqA = await db.query(`
      SELECT id FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candA}';
    `);
    const reqId = (reqA.rows[0] as any).id;

    const res = await db.query(`
      SELECT public.responder_oferta_lista_espera_seguro('${reqId}'::uuid, true) AS r;
    `);
    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, true);
    assert.equal(r.status, 'waitlist_confirmed');

    // Verificar en DB
    const check = await db.query(`
      SELECT estado, waitlist_confirmed_at, host_approval_expires_at
      FROM public.solicitudes_encuentro_abierto WHERE id = '${reqId}';
    `);
    assert.equal((check.rows[0] as any).estado, 'waitlist_confirmed');
    assert.ok((check.rows[0] as any).waitlist_confirmed_at !== null);
    assert.ok((check.rows[0] as any).host_approval_expires_at !== null);

    // Verificar notificación enviada al anfitrión
    const notifHost = await db.query(`
      SELECT notification_type FROM public.inbox_notifications
      WHERE recipient_user_id = '${hostUser}' AND notification_type = 'waitlist_candidate_confirmed';
    `);
    assert.equal(notifHost.rows.length, 1);
  });

  test('7. Aprobación obligatoria del anfitrión: host aprueba al candidato confirmado y se genera el participante', async () => {
    const encId = '00000000-0000-0000-0001-000000000001';
    await setAuth(hostUser);

    const reqA = await db.query(`
      SELECT id FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candA}';
    `);
    const reqId = (reqA.rows[0] as any).id;

    const res = await db.query(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}'::uuid, '${hostUser}'::uuid) AS r;
    `);
    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, true);
    assert.ok(r.participante_id !== undefined);

    // Verificar que la solicitud pasó a approved
    const checkReq = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${reqId}';`);
    assert.equal((checkReq.rows[0] as any).estado, 'approved');

    // Verificar que se creó fila en public.participantes con estado confirmado
    const checkPart = await db.query(`
      SELECT estado, user_id, seat_count FROM public.participantes WHERE id = '${r.participante_id}';
    `);
    assert.equal((checkPart.rows[0] as any).estado, 'confirmado');
    assert.equal((checkPart.rows[0] as any).user_id, candA);
  });

  test('8. Rechazo del anfitrión: host rechaza y se liberan las plazas para promover al siguiente', async () => {
    const encId = '00000000-0000-0000-0001-000000000003';
    await createEncounterFixture({ id: encId, maxParticipants: 1 });

    // candA está en waitlist_confirmed
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist, created_at)
      VALUES ('${encId}', '${candA}', 'Candidato A', 1, 'waitlist_confirmed', true, now() - INTERVAL '10 minutes');
    `);

    // candB está en waitlist_waiting
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist, created_at)
      VALUES ('${encId}', '${candB}', 'Candidato B', 1, 'waitlist_waiting', true, now() - INTERVAL '5 minutes');
    `);

    // Host rechaza a candA
    await setAuth(hostUser);
    const reqA = await db.query(`SELECT id FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candA}';`);
    const reqId = (reqA.rows[0] as any).id;

    const res = await db.query(`
      SELECT public.rechazar_solicitud_encuentro_abierto('${reqId}'::uuid, '${hostUser}'::uuid) AS r;
    `);
    assert.equal((res.rows[0] as any).r.ok, true);

    // candA pasó a rejected
    const checkA = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${reqId}';`);
    assert.equal((checkA.rows[0] as any).estado, 'rejected');

    // candB fue automáticamente promovido a waitlist_offered al liberarse la plaza
    const checkB = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candB}';`);
    assert.equal((checkB.rows[0] as any).estado, 'waitlist_offered');
  });

  test('9. Ceder lugar voluntariamente: candidato declina y la lista avanza de inmediato', async () => {
    const encId = '00000000-0000-0000-0001-000000000003';

    // candC está en espera
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist, created_at)
      VALUES ('${encId}', '${candC}', 'Candidato C', 1, 'waitlist_waiting', true, now());
    `);

    // candB cede su lugar (p_acepta = false)
    await setAuth(candB);
    const reqB = await db.query(`SELECT id FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candB}';`);
    const reqBId = (reqB.rows[0] as any).id;

    const res = await db.query(`
      SELECT public.responder_oferta_lista_espera_seguro('${reqBId}'::uuid, false) AS r;
    `);
    assert.equal((res.rows[0] as any).r.ok, true);
    assert.equal((res.rows[0] as any).r.status, 'withdrawn');

    // candC recibe la oferta inmediatamente
    const checkC = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candC}';`);
    assert.equal((checkC.rows[0] as any).estado, 'waitlist_offered');
  });

  test('10. Retiro voluntario (retirarse_lista_espera_seguro) libera cupos si tenía oferta', async () => {
    const encId = '00000000-0000-0000-0001-000000000003';
    await setAuth(candC);

    const reqC = await db.query(`SELECT id FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candC}';`);
    const reqCId = (reqC.rows[0] as any).id;

    const res = await db.query(`
      SELECT public.retirarse_lista_espera_seguro('${reqCId}'::uuid) AS r;
    `);
    assert.equal((res.rows[0] as any).r.ok, true);
    assert.equal((res.rows[0] as any).r.status, 'withdrawn');
  });

  test('11. Expiración de oferta: si vence waitlist_expires_at, se marca waitlist_expired y la lista avanza', async () => {
    const encId = '00000000-0000-0000-0001-000000000004';
    await createEncounterFixture({ id: encId, maxParticipants: 1 });

    // candA con oferta vencida hace 1 hora
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist, waitlist_expires_at, created_at)
      VALUES ('${encId}', '${candA}', 'Candidato A', 1, 'waitlist_offered', true, now() - INTERVAL '1 hour', now() - INTERVAL '2 hours');
    `);

    // candB esperando en lista
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist, created_at)
      VALUES ('${encId}', '${candB}', 'Candidato B', 1, 'waitlist_waiting', true, now() - INTERVAL '1 hour');
    `);

    // Procesar expiraciones
    const res = await db.query(`
      SELECT public.evaluar_y_promover_lista_espera('${encId}'::uuid) AS r;
    `);
    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, true);
    assert.equal(r.expired_count, 1, 'Debe haber expirado la oferta de A');
    assert.equal(r.promoted_count, 1, 'Debe haber promovido a B');

    // candA pasó a waitlist_expired
    const checkA = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candA}';`);
    assert.equal((checkA.rows[0] as any).estado, 'waitlist_expired');

    // candB recibió la oferta
    const checkB = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candB}';`);
    assert.equal((checkB.rows[0] as any).estado, 'waitlist_offered');
  });

  test('12. Restricción de ciclo de vida: encuentro cancelado no permite promociones ni ofertas', async () => {
    const encId = '00000000-0000-0000-0001-000000000005';
    await createEncounterFixture({ id: encId, maxParticipants: 1, estado: 'cancelado' });

    const res = await db.query(`
      SELECT public.evaluar_y_promover_lista_espera('${encId}'::uuid) AS r;
    `);
    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, true);
    assert.equal(r.promoted_count, 0);
  });

  test('13. Restricción de ciclo de vida: inscripciones cerradas impiden unirse a lista de espera', async () => {
    const encId = '00000000-0000-0000-0001-000000000006';
    await createEncounterFixture({ id: encId, maxParticipants: 1, inscriptionsClosed: true });

    await setAuth(candA);
    const res = await db.query(`
      SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Candidato A', NULL, 1) AS r;
    `);
    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'inscriptions_closed');
  });

  test('14. Seguridad: usuario bloqueado no puede anotarse en lista de espera', async () => {
    const encId = '00000000-0000-0000-0001-000000000001';
    await setAuth(blockedUser);

    const res = await db.query(`
      SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Usuario Bloqueado', NULL, 1) AS r;
    `);
    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not_available', 'Usuario bloqueado debe ser rechazado');
  });

  test('15. Seguridad: el anfitrión no puede sumarse a su propia lista de espera', async () => {
    const encId = '00000000-0000-0000-0001-000000000001';
    await setAuth(hostUser);

    const res = await db.query(`
      SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'El Host', NULL, 1) AS r;
    `);
    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'cannot_request_own_encounter');
  });

  test('16. Seguridad: usuario sin autenticación es rechazado con authentication_required', async () => {
    const encId = '00000000-0000-0000-0001-000000000001';
    await setAuth(null);

    const res = await db.query(`
      SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Anonimo', NULL, 1) AS r;
    `);
    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'authentication_required');
  });

  test('17. Seguridad: usuario anónimo es rechazado con permanent_account_required', async () => {
    const encId = '00000000-0000-0000-0001-000000000001';
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${candA}', false);`);
    await db.query(`SELECT set_config('request.jwt.claims', '{"is_anonymous":true}', false);`);

    const res = await db.query(`
      SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Anonimo', NULL, 1) AS r;
    `);
    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'permanent_account_required');
  });

  test('18. get_estado_lista_espera_seguro proyecta posición, segundos restantes y total en cola', async () => {
    const encId = '00000000-0000-0000-0001-000000000007';
    await createEncounterFixture({ id: encId, maxParticipants: 1 });

    // candA en lista de espera
    await setAuth(candA);
    await db.query(`
      SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Candidato A', NULL, 1);
    `);

    // Consultar estado
    const res = await db.query(`
      SELECT public.get_estado_lista_espera_seguro('${encId}'::uuid) AS r;
    `);
    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, true);
    assert.equal(r.in_waitlist, true);
    assert.equal(r.status, 'waitlist_waiting');
    assert.equal(r.position, 1);
    assert.equal(r.total_waiting, 1);
  });

  test('19. get_mis_solicitudes_seguro proyecta campos de waitlist', async () => {
    await setAuth(candA);

    const res = await db.query(`
      SELECT public.get_mis_solicitudes_seguro() AS r;
    `);
    const list = (res.rows[0] as any).r;
    assert.ok(Array.isArray(list));
    const item = list.find((s: any) => s.is_waitlist === true);
    assert.ok(item !== undefined);
    assert.ok('waitlist_position' in item);
  });

  test('20. get_solicitudes_host_seguro proyecta postulantes de lista de espera al anfitrión', async () => {
    const encId = '00000000-0000-0000-0001-000000000007';
    await setAuth(hostUser);

    const res = await db.query(`
      SELECT public.get_solicitudes_host_seguro('${encId}'::uuid, '${hostUser}'::uuid) AS r;
    `);
    const r = (res.rows[0] as any).r;
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.solicitudes));
    assert.ok(r.solicitudes.length > 0);
    assert.equal(r.solicitudes[0].is_waitlist, true);
  });

  test('21. get_discovery_encuentros_abiertos descuenta reservas temporales de open_slots', async () => {
    const encId = '00000000-0000-0000-0001-000000000008';
    // Capacidad 2, 0 confirmados, pero 1 cupo ofrecido en espera
    await createEncounterFixture({ id: encId, maxParticipants: 2 });
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist, waitlist_expires_at)
      VALUES ('${encId}', '${candA}', 'Candidato A', 1, 'waitlist_offered', true, now() + INTERVAL '2 hours');
    `);

    await setAuth(candB);
    const res = await db.query(`
      SELECT public.get_discovery_encuentros_abiertos() AS r;
    `);
    const list = (res.rows[0] as any).r;
    const enc = list.find((e: any) => e.id === encId);
    assert.ok(enc !== undefined);
    assert.equal(enc.open_slots, 1, 'Debe quedar solo 1 cupo disponible (2 - 1 reservado)');
    assert.equal(enc.reserved_waitlist_seats, 1);
  });

  test('22. Concurrencia de postulantes: dos candidatos en cola y una sola plaza liberada', async () => {
    const encId = '00000000-0000-0000-0001-000000000009';
    await createEncounterFixture({ id: encId, maxParticipants: 1 });

    // Host llena el encuentro con confirmedUser1
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${confirmedUser1}', 'Titular', 'confirmado', 1);
    `);

    // candB y candC se anotan en lista de espera secuencialmente
    await setAuth(candB);
    await db.query(`SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Candidato B', NULL, 1);`);

    await setAuth(candC);
    await db.query(`SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Candidato C', NULL, 1);`);

    // Se libera el único cupo por baja de confirmedUser1
    await db.query(`
      UPDATE public.participantes
      SET estado = 'cancelado', reconfirmation_status = 'declined'
      WHERE encuentro_id = '${encId}' AND user_id = '${confirmedUser1}';
    `);

    // Verificar que ÚNICAMENTE candB recibió la oferta (FIFO)
    const solB = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candB}';`);
    assert.equal((solB.rows[0] as any).estado, 'waitlist_offered');

    // Verificar que candC permanece en espera y NO recibió oferta
    const solC = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candC}';`);
    assert.equal((solC.rows[0] as any).estado, 'waitlist_waiting');

    // Verificar que no hay sobrecupo
    const encCheck = await db.query(`
      SELECT COALESCE(SUM(seat_count), 0)::int as res
      FROM public.solicitudes_encuentro_abierto
      WHERE encuentro_id = '${encId}' AND estado IN ('waitlist_offered', 'waitlist_confirmed');
    `);
    assert.equal((encCheck.rows[0] as any).res, 1, 'Exactamente 1 cupo reservado');
  });

  test('23. Concurrencia del motor de promoción: dos procesos simultáneos de evaluar_y_promover_lista_espera', async () => {
    const encId = '00000000-0000-0000-0001-000000000010';
    await createEncounterFixture({ id: encId, maxParticipants: 2 });

    // candA y candB en cola
    await setAuth(candA);
    await db.query(`SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Candidato A', NULL, 1);`);
    await setAuth(candB);
    await db.query(`SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Candidato B', NULL, 1);`);

    // Invocación concurrente de evaluación sobre el mismo encuentro
    const [res1, res2] = await Promise.all([
      db.query(`SELECT public.evaluar_y_promover_lista_espera('${encId}'::uuid) AS r;`),
      db.query(`SELECT public.evaluar_y_promover_lista_espera('${encId}'::uuid) AS r;`)
    ]);

    const r1 = (res1.rows[0] as any).r;
    const r2 = (res2.rows[0] as any).r;
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);

    // La suma de promovidos entre ambos hilos concurrentes debe ser exactamente 2 (los cupos disponibles)
    const totalPromoted = (r1.promoted_count || 0) + (r2.promoted_count || 0);
    assert.equal(totalPromoted, 2, 'Entre ambos procesos concurrentes se promovió exactamente la capacidad disponible');

    // Ambos deben figurar como waitlist_offered sin sobrepasar 2
    const totalOffered = await db.query(`
      SELECT count(*)::int as c
      FROM public.solicitudes_encuentro_abierto
      WHERE encuentro_id = '${encId}' AND estado = 'waitlist_offered';
    `);
    assert.equal((totalOffered.rows[0] as any).c, 2);
  });

  test('24. Expiración automática y durabilidad: procesar_expiraciones_lista_espera_seguro', async () => {
    const encId = '00000000-0000-0000-0001-000000000011';
    await createEncounterFixture({ id: encId, maxParticipants: 1 });

    // candA tiene oferta pero ya venció en el pasado
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist, waitlist_expires_at)
      VALUES ('${encId}', '${candA}', 'Candidato A', 1, 'waitlist_offered', true, now() - INTERVAL '10 minutes');
    `);

    // candB está en espera
    await setAuth(candB);
    await db.query(`SELECT public.unirse_lista_espera_encuentro_abierto('${encId}'::uuid, 'Candidato B', NULL, 1);`);

    // Ejecución de mantenimiento periódico de expiraciones (contexto interno/pg_cron)
    await setAuth(null);
    const expRes = await db.query(`
      SELECT public.procesar_expiraciones_lista_espera_seguro() AS r;
    `);
    const expR = (expRes.rows[0] as any).r;
    assert.equal(expR.ok, true);
    assert.ok(expR.encuentros_procesados >= 1, 'Debe haber procesado al menos 1 encuentro con expiraciones');

    // candA debe haber pasado a waitlist_expired
    const candACheck = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candA}';`);
    assert.equal((candACheck.rows[0] as any).estado, 'waitlist_expired');

    // candB debe haber sido automáticamente promovido a waitlist_offered
    const candBCheck = await db.query(`SELECT estado, waitlist_offered_at FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candB}';`);
    assert.equal((candBCheck.rows[0] as any).estado, 'waitlist_offered');
    assert.ok((candBCheck.rows[0] as any).waitlist_offered_at !== null);

    // Notificación para candA de oferta vencida
    const notifA = await db.query(`
      SELECT notification_type FROM public.inbox_notifications
      WHERE recipient_user_id = '${candA}' AND notification_type = 'waitlist_offer_expired';
    `);
    assert.ok(notifA.rows.length >= 1);
  });

  test('25. Hotfix P0: Orden canónico de locks y concurrencia de operaciones cruzadas (aceptar y retirarse)', async () => {
    const encId = '00000000-0000-0000-0001-000000000012';
    await createEncounterFixture({ id: encId, maxParticipants: 2 });

    // candA tiene oferta activa
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist, waitlist_expires_at)
      VALUES ('${encId}', '${candA}', 'Candidato A', 1, 'waitlist_offered', true, now() + INTERVAL '1 hour');
    `);
    const reqARes = await db.query(`SELECT id FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candA}';`);
    const reqAId = (reqARes.rows[0] as any).id;

    // candB está en cola waitlist_waiting
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist)
      VALUES ('${encId}', '${candB}', 'Candidato B', 1, 'waitlist_waiting', true);
    `);
    const reqBRes = await db.query(`SELECT id FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candB}';`);
    const reqBId = (reqBRes.rows[0] as any).id;

    // Simulación de operaciones concurrentes cruzadas
    await setAuth(candA);
    const acceptP = db.query(`SELECT public.responder_oferta_lista_espera_seguro('${reqAId}'::uuid, true) AS r;`);

    await setAuth(candB);
    const withdrawP = db.query(`SELECT public.retirarse_lista_espera_seguro('${reqBId}'::uuid) AS r;`);

    const [acceptRes, withdrawRes] = await Promise.all([acceptP, withdrawP]);
    const acceptR = (acceptRes.rows[0] as any).r;
    const withdrawR = (withdrawRes.rows[0] as any).r;

    assert.equal(acceptR.ok, true);
    assert.equal(acceptR.status, 'waitlist_confirmed');
    assert.equal(withdrawR.ok, true);
    assert.equal(withdrawR.status, 'withdrawn');
  });

  test('26. Hotfix P1: Endurecimiento de funciones internas (rechaza ejecución directa de authenticated)', async () => {
    await setAuth(candA); // Rol 'authenticated'

    const directCall = await db.query(`
      SELECT public.procesar_expiraciones_lista_espera_seguro() AS r;
    `);
    const r = (directCall.rows[0] as any).r;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'forbidden');

    // Contexto interno (sin JWT role authenticated)
    await setAuth(null);
    const internalCall = await db.query(`
      SELECT public.procesar_expiraciones_lista_espera_seguro() AS r;
    `);
    const ir = (internalCall.rows[0] as any).r;
    assert.equal(ir.ok, true);
  });

  test('27. Hotfix P1: Desacople de vencimientos en inscripciones cerradas (limpia ofertas pero no promueve)', async () => {
    const encId = '00000000-0000-0000-0001-000000000013';
    // Encuentro con inscripciones cerradas
    await createEncounterFixture({ id: encId, maxParticipants: 2, inscriptionsClosed: true });

    // candA tiene oferta vencida
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist, waitlist_expires_at)
      VALUES ('${encId}', '${candA}', 'Candidato A', 1, 'waitlist_offered', true, now() - INTERVAL '5 minutes');
    `);

    // candB está en espera
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado, is_waitlist)
      VALUES ('${encId}', '${candB}', 'Candidato B', 1, 'waitlist_waiting', true);
    `);

    // Invocación interna de evaluación
    const evalRes = await db.query(`
      SELECT public.evaluar_y_promover_lista_espera('${encId}'::uuid) AS r;
    `);
    const evalR = (evalRes.rows[0] as any).r;

    // Debe haber limpiado la oferta vencida (Paso A) y detenido la promoción (Paso B)
    assert.equal(evalR.ok, true);
    assert.equal(evalR.expired_count, 1);
    assert.equal(evalR.promoted_count, 0);
    assert.equal(evalR.reason, 'inscriptions_not_admitted');

    // candA pasó a expired
    const candACheck = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candA}';`);
    assert.equal((candACheck.rows[0] as any).estado, 'waitlist_expired');

    // candB sigue en espera (NO promovido)
    const candBCheck = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE encuentro_id = '${encId}' AND usuario_id = '${candB}';`);
    assert.equal((candBCheck.rows[0] as any).estado, 'waitlist_waiting');
  });

  test('28. Hotfix P0: Restauración de invariantes Discovery (exclusión pasados, modalidad virtual geográfica, orden ascendente y límite 50)', async () => {
    await setAuth(null);

    const pastEncId = '00000000-0000-0000-0001-000000000014';
    const futurePresencialId = '00000000-0000-0000-0001-000000000015';
    const futureVirtualId = '00000000-0000-0000-0001-000000000016';

    // 1. Encuentro pasado (no debe aparecer)
    await createEncounterFixture({ id: pastEncId, maxParticipants: 5, fechaOffsetDays: -2 });

    // 2. Encuentro futuro presencial en Güemes (fecha +5 días)
    await createEncounterFixture({ id: futurePresencialId, maxParticipants: 5, fechaOffsetDays: 5 });
    await db.query(`UPDATE public.encuentros SET locality_id = 'guemes', modalidad = 'presencial' WHERE id = '${futurePresencialId}';`);

    // 3. Encuentro futuro virtual en Palermo (fecha +3 días)
    await createEncounterFixture({ id: futureVirtualId, maxParticipants: 5, fechaOffsetDays: 3 });
    await db.query(`UPDATE public.encuentros SET locality_id = 'palermo', modalidad = 'virtual' WHERE id = '${futureVirtualId}';`);

    // Consulta con filtro geográfico p_locality_ids = ['guemes']
    const discRes = await db.query(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes'], false) AS r;
    `);
    const discList = (discRes.rows[0] as any).r as any[];

    // a) El pasado NO debe aparecer
    assert.ok(!discList.some(e => e.id === pastEncId), 'Encuentro pasado no debe figurar en Discovery');

    // b) El presencial de Güemes SÍ debe aparecer
    assert.ok(discList.some(e => e.id === futurePresencialId), 'Encuentro presencial de Güemes debe figurar');

    // c) El virtual de Palermo SÍ debe aparecer (excepción virtual)
    assert.ok(discList.some(e => e.id === futureVirtualId), 'Encuentro virtual debe figurar independientemente de la localidad solicitada');

    // d) Orden cronológico: el virtual (+3 días) debe aparecer antes que el presencial (+5 días)
    const idxVirtual = discList.findIndex(e => e.id === futureVirtualId);
    const idxPresencial = discList.findIndex(e => e.id === futurePresencialId);
    assert.ok(idxVirtual < idxPresencial, 'Discovery debe ordenar cronológicamente de forma ascendente (más próximos primero)');

    // e) Límite determinista de 50 registros
    assert.ok(discList.length <= 50, 'Discovery debe tener límite máximo de 50');
  });
});
