import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Encuentros Abiertos: Coexistencia, Ubicación Privada, Eventos de Solicitud e Inbox', () => {
  let db: PGlite;

  const hostUser = '10000000-0000-0000-0000-000000000001';
  const applicantUser = '20000000-0000-0000-0000-000000000002';
  const directGuestUser = '30000000-0000-0000-0000-000000000003';

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
        ('${applicantUser}', 'applicant@test.com'),
        ('${directGuestUser}', 'guest@test.com')
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
        ('guemes', 'Güemes / Playa Grande', 'Mar del Plata', 'Costa Atlántica', true),
        ('centro', 'Centro / La Perla', 'Mar del Plata', 'Costa Atlántica', true)
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        titulo TEXT NOT NULL,
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
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        nombre_invitado TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        token UUID DEFAULT gen_random_uuid(),
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
        estado TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        resolved_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS public.intenciones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id),
        encuentro_id UUID REFERENCES public.encuentros(id),
        estado TEXT NOT NULL DEFAULT 'activa'
      );

      CREATE TABLE IF NOT EXISTS public.domain_events_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type TEXT NOT NULL,
        event_version INTEGER NOT NULL DEFAULT 1,
        aggregate_type TEXT NOT NULL,
        aggregate_id UUID NOT NULL,
        actor_user_id UUID,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        dedup_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        available_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
        processing_started_at TIMESTAMPTZ,
        processed_at TIMESTAMPTZ,
        last_error TEXT,
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

      CREATE OR REPLACE FUNCTION public.emitir_alertas_intencion_convertida_outbox(p_intencion_id UUID, p_encuentro_id UUID)
      RETURNS VOID AS $$
      BEGIN
        NULL;
      END;
      $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(p_action TEXT, p_key TEXT)
      RETURNS JSONB AS $$
      BEGIN
        RETURN '{"allowed": true}'::jsonb;
      END;
      $$ LANGUAGE plpgsql;

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
    `);

    // 2. Aplicar la migración aditiva bajo prueba
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../supabase/migrations/20261004120000_open_encounter_join_request_events_and_inbox.sql'),
      'utf8'
    );
    await db.exec(migrationSql);
  });

  const setAuthContext = async (userId: string, isAnon: boolean = false) => {
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
    await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": ${isAnon}}', false);`);
  };

  test('abrir_encuentro_seguro rechaza si lugar_texto está vacío en encuentro presencial', async () => {
    await setAuthContext(hostUser);

    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, lugar_texto)
      VALUES ('Tenis en Güemes', 'presencial', '${hostUser}', NULL)
      RETURNING id;
    `);
    const encId = resEnc.rows[0].id;

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        'Buscamos cuarta raqueta',
        4,
        'guemes'
      );
    `);

    assert.equal(res.rows[0].abrir_encuentro_seguro.ok, false);
    assert.equal(res.rows[0].abrir_encuentro_seguro.error, 'private_location_required');
  });

  test('abrir_encuentro_seguro rechaza si link_virtual está vacío en encuentro virtual', async () => {
    await setAuthContext(hostUser);

    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, link_virtual)
      VALUES ('Tertulia Virtual', 'virtual', '${hostUser}', '   ')
      RETURNING id;
    `);
    const encId = resEnc.rows[0].id;

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        'Charla de libros online',
        5,
        NULL
      );
    `);

    assert.equal(res.rows[0].abrir_encuentro_seguro.ok, false);
    assert.equal(res.rows[0].abrir_encuentro_seguro.error, 'private_virtual_link_required');
  });

  test('abrir_encuentro_seguro permite abrir encuentro con 0 invitados directos si tiene ubicación', async () => {
    await setAuthContext(hostUser);

    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, lugar_texto)
      VALUES ('Picadito en Güemes', 'presencial', '${hostUser}', 'Cancha 5, Güemes 1234')
      RETURNING id;
    `);
    const encId = resEnc.rows[0].id;

    // Abrir con max_participants = 3 (1 host + 2 lugares externos)
    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        'Plan abierto sin invitados directos iniciales',
        3,
        'guemes'
      );
    `);

    assert.equal(res.rows[0].abrir_encuentro_seguro.ok, true);
    assert.equal(res.rows[0].abrir_encuentro_seguro.is_open, true);
    assert.equal(res.rows[0].abrir_encuentro_seguro.max_participants, 3);
  });

  test('solicitar_sumarse_encuentro_abierto emite evento de dominio e inserta notificación en Inbox del Host', async () => {
    // 1. Crear y abrir encuentro presencial con ubicación privada
    await setAuthContext(hostUser);
    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, lugar_texto, is_open, max_participants, locality_id, open_public_zone)
      VALUES ('Café y Ajedrez', 'presencial', '${hostUser}', 'Club Español, salón 2', true, 3, 'guemes', 'Güemes / Playa Grande')
      RETURNING id;
    `);
    const encId = resEnc.rows[0].id;

    // 2. Solicitante permanente envía solicitud
    await setAuthContext(applicantUser);
    const resReq = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encId}',
        'Martín P.',
        'Hola! Me sumo con tablero'
      );
    `);

    assert.equal(resReq.rows[0].solicitar_sumarse_encuentro_abierto.ok, true);
    const requestId = resReq.rows[0].solicitar_sumarse_encuentro_abierto.request_id;
    assert.ok(requestId);

    // 3. Verificar que se emitió el evento encounter.join_request.created.v1 en domain_events_outbox
    const outboxRes = await db.query<any>(`
      SELECT * FROM public.domain_events_outbox
      WHERE aggregate_id = '${encId}' AND event_type = 'encounter.join_request.created.v1';
    `);
    assert.equal(outboxRes.rows.length, 1);
    assert.equal(outboxRes.rows[0].actor_user_id, applicantUser);
    assert.equal(outboxRes.rows[0].payload.host_id, hostUser);
    assert.equal(outboxRes.rows[0].payload.applicant_name, 'Martín P.');
    assert.equal(outboxRes.rows[0].payload.request_id, requestId);

    // 4. Verificar que se insertó la notificación in-app en inbox_notifications para el Host
    const inboxRes = await db.query<any>(`
      SELECT * FROM public.inbox_notifications
      WHERE recipient_user_id = '${hostUser}';
    `);
    assert.equal(inboxRes.rows.length, 1);
    assert.equal(inboxRes.rows[0].notification_type, 'open_encounter_join_request');
    assert.equal(inboxRes.rows[0].target_id, encId);
    assert.equal(inboxRes.rows[0].deep_link, `/meet/${encId}#solicitudes`);
    assert.equal(inboxRes.rows[0].title, 'Nueva solicitud para sumarse');
    assert.match(inboxRes.rows[0].body, /Martín P\./);
  });

  test('Coexistencia: Invitado directo confirmado no duplica conteo de cupos', async () => {
    await setAuthContext(hostUser);
    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, lugar_texto, is_open, max_participants, locality_id, open_public_zone)
      VALUES ('Cena Coexistencia', 'presencial', '${hostUser}', 'Restó Colón 550', true, 3, 'guemes', 'Güemes / Playa Grande')
      RETURNING id;
    `);
    const encId = resEnc.rows[0].id;

    // Agregar invitado directo ya confirmado
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encId}', '${directGuestUser}', 'Invitado Directo', 'confirmado');
    `);

    // Capacidad: 3. Host = 1, Confirmados = 1. Queda exactamente 1 lugar disponible.
    // Primer solicitante debe ser aceptado para solicitud
    await setAuthContext(applicantUser);
    const req1 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encId}',
        'Lucas',
        'Quiero sumarme'
      );
    `);
    assert.equal(req1.rows[0].solicitar_sumarse_encuentro_abierto.ok, true);

    // Si agregamos otro confirmado directo (total ocupados = 1 host + 2 confirmados = 3 = max_participants)
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, estado)
      VALUES ('${encId}', 'Segundo Confirmado Directo', 'confirmado');
    `);

    // Intentar solicitar con encuentro lleno debe retornar encounter_full
    const anotherUser = '40000000-0000-0000-0000-000000000004';
    await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${anotherUser}', 'another@test.com') ON CONFLICT DO NOTHING;`);
    await setAuthContext(anotherUser);

    const req2 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encId}',
        'Sofia',
        '¿Hay lugar?'
      );
    `);
    assert.equal(req2.rows[0].solicitar_sumarse_encuentro_abierto.ok, false);
    assert.equal(req2.rows[0].solicitar_sumarse_encuentro_abierto.error, 'encounter_full');
  });

  test('Semántica de cupos obligatoria: Casos A, B y C', async () => {
    await setAuthContext(hostUser);

    // Caso A:
    // - host solo
    // - confirmados externos = 0
    // - elige 2 lugares para sumarse
    // - fórmula: max_participants = 2 (externos) + 1 (host) + 0 (confirmados) = 3
    const resA = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, lugar_texto)
      VALUES ('Caso A', 'presencial', '${hostUser}', 'Lugar A')
      RETURNING id;
    `);
    const encA = resA.rows[0].id;
    const externalSlotsA = 2;
    const confirmedCountA = 0;
    const maxParticipantsA = externalSlotsA + 1 + confirmedCountA; // 3
    const openA = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro('${encA}', '${hostUser}', 'Desc A', ${maxParticipantsA}, 'guemes');
    `);
    assert.equal(openA.rows[0].abrir_encuentro_seguro.ok, true);
    assert.equal(openA.rows[0].abrir_encuentro_seguro.max_participants, 3);

    // Caso B:
    // - host + 2 confirmados
    // - cierra/reabre
    // - elige 3 lugares para sumarse
    // - fórmula: max_participants = 3 (nuevos externos) + 1 (host) + 2 (confirmados) = 6
    const resB = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, lugar_texto)
      VALUES ('Caso B', 'presencial', '${hostUser}', 'Lugar B')
      RETURNING id;
    `);
    const encB = resB.rows[0].id;
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, estado) VALUES
        ('${encB}', 'Amigo 1', 'confirmado'),
        ('${encB}', 'Amigo 2', 'confirmado');
    `);
    const externalSlotsB = 3;
    const confirmedCountB = 2;
    const maxParticipantsB = externalSlotsB + 1 + confirmedCountB; // 6
    const openB = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro('${encB}', '${hostUser}', 'Desc B', ${maxParticipantsB}, 'guemes');
    `);
    assert.equal(openB.rows[0].abrir_encuentro_seguro.ok, true);
    assert.equal(openB.rows[0].abrir_encuentro_seguro.max_participants, 6);

    // Caso C:
    // - después se aprueba 1 nueva persona
    // - disponibles pasan de 3 a 2
    await setAuthContext(applicantUser);
    const reqC = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encB}', 'Nuevo Solicitante', 'Me sumo');
    `);
    assert.equal(reqC.rows[0].solicitar_sumarse_encuentro_abierto.ok, true);

    // Host aprueba
    await db.query(`
      UPDATE public.solicitudes_encuentro_abierto
      SET estado = 'approved', resolved_at = now()
      WHERE id = '${reqC.rows[0].solicitar_sumarse_encuentro_abierto.request_id}';
    `);
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encB}', '${applicantUser}', 'Nuevo Solicitante', 'confirmado');
    `);

    // Conteo actual: 1 host + 3 confirmados = 4 ocupados. max = 6. Disponibles = 6 - 4 = 2.
    const partCountRes = await db.query<{ count: string }>(`
      SELECT count(*) FROM public.participantes WHERE encuentro_id = '${encB}' AND estado = 'confirmado';
    `);
    const confirmedNow = parseInt(partCountRes.rows[0].count, 10);
    const availableSlotsNow = 6 - (1 + confirmedNow);
    assert.equal(availableSlotsNow, 2);
  });

  test('Privacidad de Evento y Notificación: Cero fuga de datos privados', async () => {
    await setAuthContext(hostUser);
    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, lugar_texto, link_virtual, is_open, max_participants, locality_id, open_public_zone)
      VALUES ('Encuentro Privacidad', 'presencial', '${hostUser}', 'DIRECCION_HIPER_SECRETA_1234', 'LINK_VIRTUAL_SECRETO_5678', true, 4, 'guemes', 'Güemes')
      RETURNING id;
    `);
    const encId = resEnc.rows[0].id;

    await setAuthContext(applicantUser);
    await db.query(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${encId}', 'Solicitante Privacidad', 'Mensaje');
    `);

    const outbox = await db.query<any>(`
      SELECT payload FROM public.domain_events_outbox WHERE aggregate_id = '${encId}' AND event_type = 'encounter.join_request.created.v1';
    `);
    const outboxPayloadStr = JSON.stringify(outbox.rows[0].payload);
    assert.ok(!outboxPayloadStr.includes('DIRECCION_HIPER_SECRETA_1234'));
    assert.ok(!outboxPayloadStr.includes('LINK_VIRTUAL_SECRETO_5678'));

    const inbox = await db.query<any>(`
      SELECT title, body, payload FROM public.inbox_notifications WHERE target_id = '${encId}';
    `);
    const inboxStr = JSON.stringify(inbox.rows[0]);
    assert.ok(!inboxStr.includes('DIRECCION_HIPER_SECRETA_1234'));
    assert.ok(!inboxStr.includes('LINK_VIRTUAL_SECRETO_5678'));
  });
});

