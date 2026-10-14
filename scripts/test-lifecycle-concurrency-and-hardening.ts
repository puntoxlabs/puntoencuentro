import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Hardening de Concurrencia, Invariantes y Seguridad del Lifecycle', () => {
  let db: PGlite;

  const hostUser = '10000000-0000-0000-0000-000000000001';
  const participantUser1 = '20000000-0000-0000-0000-000000000002';
  const participantUser2 = '20000000-0000-0000-0000-000000000003';
  const applicantUser1 = '30000000-0000-0000-0000-000000000004';
  const applicantUser2 = '30000000-0000-0000-0000-000000000005';
  const attackerUser = '40000000-0000-0000-0000-000000000006';

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
        ('${applicantUser1}', 'applicant1@test.com'),
        ('${applicantUser2}', 'applicant2@test.com'),
        ('${attackerUser}', 'attacker@test.com')
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

    // 2. Aplicar migraciones en orden
    const m1 = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261014180000_fase_lifecycle_realization_and_cancellation_reasons.sql'), 'utf8');
    await db.exec(m1);

    const m2 = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261014183000_fix_nullif_syntax_lifecycle.sql'), 'utf8');
    await db.exec(m2);

    const m3 = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261014190000_harden_lifecycle_rpc_concurrency_and_invariants.sql'), 'utf8');
    await db.exec(m3);
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

  test('A. Concurrencia: host cambia min_participants mientras se aprueba una solicitud', async () => {
    // Encuentro capacidad 5, min_participants = 3, confirmed_seats = 2 (p1: 2)
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, host_id, is_open, estado, max_participants, min_participants, realization_status
      ) VALUES (
        'Tenis Dobles', 'Tenis Dobles', '${hostUser}', true, 'activo', 5, 3, 'pending'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser1}', 'Carlos', 'confirmado', 2);
    `);

    // Solicitud de 1 lugar
    const reqRes = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado)
      VALUES ('${encId}', '${applicantUser1}', 'Ana', 1, 'pending')
      RETURNING id;
    `);
    const reqId = reqRes.rows[0].id;

    // Ejecutar aprobación y cambio de mínimo concurrentemente
    await setAuthContext(hostUser);
    const [aprobacion, cambioMin] = await Promise.all([
      db.query<{ res: any }>(`SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}') AS res;`),
      db.query<{ res: any }>(`SELECT public.set_min_participants_seguro('${encId}', '${hostUser}', 4) AS res;`)
    ]);

    assert.equal(aprobacion.rows[0].res.ok, true, 'La solicitud debe aprobarse');
    assert.equal(cambioMin.rows[0].res.ok, true, 'El cambio de mínimo debe aplicarse');

    // Estado final consistente: confirmed_seats = 3 (2 + 1), min_participants = 4 -> realization_status = 'pending'
    const finalEnc = await db.query<{ realization_status: string; min_participants: number }>(
      `SELECT realization_status, min_participants FROM public.encuentros WHERE id = '${encId}';`
    );
    assert.equal(finalEnc.rows[0].min_participants, 4);
    assert.equal(finalEnc.rows[0].realization_status, 'pending');
  });

  test('B. Concurrencia: participante marca "No voy a poder" mientras otra solicitud se aprueba', async () => {
    // Capacidad 3, 2 confirmados (User1: 2 lugares), available = 1
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, host_id, is_open, estado, max_participants, min_participants, realization_status
      ) VALUES (
        'Café', 'Café', '${hostUser}', true, 'activo', 3, 2, 'confirmed'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count, reconfirmation_status)
      VALUES ('${encId}', '${participantUser1}', 'Carlos', 'confirmado', 2, 'pending');
    `);

    // Solicitud que pide 2 lugares (sólo entra si User1 desiste y libera sus 2 lugares)
    const reqRes = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado)
      VALUES ('${encId}', '${applicantUser2}', 'Marta', 2, 'pending')
      RETURNING id;
    `);
    const reqId = reqRes.rows[0].id;

    // Participante declina
    await setAuthContext(participantUser1);
    const declineRes = await db.query<{ res: any }>(
      `SELECT public.reconfirmar_asistencia_seguro('${encId}', 'decline') AS res;`
    );
    assert.equal(declineRes.rows[0].res.ok, true);
    assert.equal(declineRes.rows[0].res.decision, 'decline');
    assert.equal(declineRes.rows[0].res.released_seats, 2);

    // Host aprueba solicitud de 2 lugares
    await setAuthContext(hostUser);
    const approveRes = await db.query<{ res: any }>(
      `SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}') AS res;`
    );
    assert.equal(approveRes.rows[0].res.ok, true, 'Debe aprobarse tras la liberación de cupos sin sobrecupo');

    // Verificar cupos totales: exactamente 2 confirmados (Marta: 2, Carlos: cancelado)
    const sumSeats = await db.query<{ sum: number }>(`
      SELECT COALESCE(SUM(seat_count), 0)::int as sum
      FROM public.participantes
      WHERE encuentro_id = '${encId}' AND estado IN ('confirmado', 'asistio');
    `);
    assert.equal(sumSeats.rows[0].sum, 2);
    assert.ok(sumSeats.rows[0].sum <= 3, 'No debe existir sobrecupo');
  });

  test('C. Concurrencia e invariante: host cierra inscripciones mientras entra "Solicitar sumarme"', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, host_id, is_open, estado, max_participants
      ) VALUES (
        'Running', 'Running', '${hostUser}', true, 'activo', 10
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Host cierra inscripciones
    await setAuthContext(hostUser);
    const closeRes = await db.query<{ res: any }>(
      `SELECT public.cerrar_inscripciones_seguro('${encId}', '${hostUser}') AS res;`
    );
    assert.equal(closeRes.rows[0].res.ok, true);
    assert.equal(closeRes.rows[0].res.inscriptions_closed, true);

    // Usuario intenta solicitar sumarse
    await setAuthContext(applicantUser1);
    const reqRes = await db.query<{ res: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Lucas', 'Quiero ir') AS res;`
    );
    assert.equal(reqRes.rows[0].res.ok, false);
    assert.equal(reqRes.rows[0].res.error, 'inscriptions_closed');
  });

  test('D. Concurrencia e invariante: host cancela mientras participante intenta reconfirmar', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, host_id, is_open, estado, max_participants
      ) VALUES (
        'Cena', 'Cena', '${hostUser}', true, 'activo', 6
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count, reconfirmation_status)
      VALUES ('${encId}', '${participantUser1}', 'Sofi', 'confirmado', 1, 'pending');
    `);

    // Host cancela el encuentro con motivo
    await setAuthContext(hostUser);
    const cancelRes = await db.query<{ res: any }>(
      `SELECT public.cancelar_encuentro_seguro('${encId}', '${hostUser}', 'Lluvia intensa') AS res;`
    );
    assert.equal(cancelRes.rows[0].res.ok, true);

    // Participante intenta reconfirmar
    await setAuthContext(participantUser1);
    const reconfRes = await db.query<{ res: any }>(
      `SELECT public.reconfirmar_asistencia_seguro('${encId}', 'confirm') AS res;`
    );
    assert.equal(reconfRes.rows[0].res.ok, false);
    assert.equal(reconfRes.rows[0].res.error, 'cannot_reconfirm_cancelled_encounter');

    // Logística privada no debe exponerse al participante
    const detailRes = await db.query<{ res: any }>(
      `SELECT public.get_encuentro_participante_autorizado('${encId}') AS res;`
    );
    assert.equal(detailRes.rows[0].res.lugar_texto, null, 'Ubicación debe ser null en encuentro cancelado');
    assert.equal(detailRes.rows[0].res.link_virtual, null, 'Link virtual debe ser null en encuentro cancelado');
  });

  test('E. Advertencia obligatoria: cambio de min_participants que regresa a pending con inscripciones cerradas', async () => {
    // Encuentro confirmado con inscripciones cerradas (2 confirmados, min = 2)
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, host_id, is_open, estado, max_participants, min_participants, realization_status, inscriptions_closed
      ) VALUES (
        'Teatro', 'Teatro', '${hostUser}', true, 'activo', 4, 2, 'confirmed', true
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser1}', 'Juan', 'confirmado', 2);
    `);

    await setAuthContext(hostUser);

    // Intento 1: Sin confirmar reversión -> debe exigir confirmación
    const unconfirmedRes = await db.query<{ res: any }>(
      `SELECT public.set_min_participants_seguro('${encId}', '${hostUser}', 3, false) AS res;`
    );
    assert.equal(unconfirmedRes.rows[0].res.ok, false);
    assert.equal(unconfirmedRes.rows[0].res.error, 'reversion_confirmation_required');

    // Intento 2: Con confirmación explícita (p_confirm_reversion = true) -> debe tener éxito y pasar a pending
    const confirmedRes = await db.query<{ res: any }>(
      `SELECT public.set_min_participants_seguro('${encId}', '${hostUser}', 3, true) AS res;`
    );
    assert.equal(confirmedRes.rows[0].res.ok, true);
    assert.equal(confirmedRes.rows[0].res.realization_status, 'pending');
    assert.equal(confirmedRes.rows[0].res.min_participants, 3);
  });

  test('F. Discovery: filtro "Solo con lugares disponibles" oculta completos E inscripciones cerradas', async () => {
    // 1. Encuentro A: Disponible y abierto (debe aparecer)
    const encA = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, host_id, is_open, estado, max_participants, inscriptions_closed, moderation_status
      ) VALUES ('A', 'Encuentro A', '${hostUser}', true, 'activo', 5, false, 'approved') RETURNING id;
    `);

    // 2. Encuentro B: Completo (cupo 2, confirmados 2) -> debe ocultarse con filtro
    const encB = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, host_id, is_open, estado, max_participants, inscriptions_closed, moderation_status
      ) VALUES ('B', 'Encuentro B', '${participantUser1}', true, 'activo', 2, false, 'approved') RETURNING id;
    `);
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encB.rows[0].id}', '${participantUser2}', 'Pedro', 'confirmado', 2);
    `);

    // 3. Encuentro C: Con lugares pero inscripciones cerradas -> debe ocultarse con filtro
    const encC = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, host_id, is_open, estado, max_participants, inscriptions_closed, moderation_status
      ) VALUES ('C', 'Encuentro C', '${participantUser2}', true, 'activo', 5, true, 'approved') RETURNING id;
    `);

    await setAuthContext(null); // Anon en discovery

    // Sin filtro (p_only_available = false): los 3 visibles
    const allRes = await db.query<{ res: any[] }>(
      `SELECT public.get_discovery_encuentros_abiertos(NULL, false) AS res;`
    );
    const allIds = allRes.rows[0].res.map((e: any) => e.id);
    assert.ok(allIds.includes(encA.rows[0].id), 'A debe aparecer');
    assert.ok(allIds.includes(encB.rows[0].id), 'B completo debe aparecer por defecto');
    assert.ok(allIds.includes(encC.rows[0].id), 'C cerrado debe aparecer por defecto');

    // Con filtro (p_only_available = true): sólo A debe aparecer
    const availRes = await db.query<{ res: any[] }>(
      `SELECT public.get_discovery_encuentros_abiertos(NULL, true) AS res;`
    );
    const availIds = availRes.rows[0].res.map((e: any) => e.id);
    assert.ok(availIds.includes(encA.rows[0].id), 'A disponible debe aparecer');
    assert.ok(!availIds.includes(encB.rows[0].id), 'B completo debe quedar oculto');
    assert.ok(!availIds.includes(encC.rows[0].id), 'C con inscripciones cerradas debe quedar oculto');
  });

  test('G. Seguridad RPC: get_detalle_host_seguro valida estrictamente auth.uid() sin confiar en p_host_id', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, host_id, is_open, estado, max_participants, lugar_texto
      ) VALUES (
        'Privado', 'Privado', '${hostUser}', true, 'activo', 5, 'Dirección Secreta 123'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Caso 1: Llamada no autenticada (auth.uid() = NULL) pero pasando p_host_id del dueño
    await setAuthContext(null);
    const anonRes = await db.query<{ res: any }>(
      `SELECT public.get_detalle_host_seguro('${encId}', '${hostUser}') AS res;`
    );
    assert.equal(anonRes.rows[0].res.ok, false);
    assert.equal(anonRes.rows[0].res.error, 'not_authenticated');

    // Caso 2: Atacante autenticado pasando su propio token pero p_host_id del dueño
    await setAuthContext(attackerUser);
    const attackerRes = await db.query<{ res: any }>(
      `SELECT public.get_detalle_host_seguro('${encId}', '${hostUser}') AS res;`
    );
    assert.equal(attackerRes.rows[0].res.error, 'unauthorized');

    // Caso 3: Dueño legítimo
    await setAuthContext(hostUser);
    const ownerRes = await db.query<{ res: any }>(
      `SELECT public.get_detalle_host_seguro('${encId}', '${hostUser}') AS res;`
    );
    assert.equal(ownerRes.rows[0].res.lugar_texto, 'Dirección Secreta 123');
  });

  test('H. Host en Discovery: ve is_host=true y nunca puede solicitar sumarse a su propio encuentro', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, host_id, is_open, estado, max_participants, moderation_status
      ) VALUES (
        'Encuentro Host', 'Encuentro Host', '${hostUser}', true, 'activo', 4, 'approved'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // En Discovery, el host ve is_host = true
    await setAuthContext(hostUser);
    const discRes = await db.query<{ res: any[] }>(
      `SELECT public.get_discovery_encuentros_abiertos(NULL, false) AS res;`
    );
    const hostItem = discRes.rows[0].res.find((e: any) => e.id === encId);
    assert.ok(hostItem, 'Encuentro debe estar en Discovery');
    assert.equal(hostItem.is_host, true, 'is_host debe ser true para el creador');

    // Host intenta auto-solicitarse sumarse
    const joinRes = await db.query<{ res: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Host Name', 'Me sumo yo mismo') AS res;`
    );
    assert.equal(joinRes.rows[0].res.ok, false);
    assert.equal(joinRes.rows[0].res.error, 'cannot_request_own_encounter');
  });
});
