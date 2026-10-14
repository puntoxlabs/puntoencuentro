import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Fase Lifecycle: Cancelación, Eliminación, Cupos Estrictos y Visibilidad del Host', () => {
  let db: PGlite;

  const hostUser = '10000000-0000-0000-0000-000000000001';
  const participantUser = '20000000-0000-0000-0000-000000000002';
  const applicantUser = '30000000-0000-0000-0000-000000000003';
  const otherUser = '40000000-0000-0000-0000-000000000004';

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
        ('${participantUser}', 'participant@test.com'),
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
        min_seats_per_request INT DEFAULT 1,
        moderation_status TEXT DEFAULT 'approved',
        open_activity_canonical TEXT,
        open_activity_matching_eligible BOOLEAN DEFAULT false,
        allow_multi_seat_requests BOOLEAN DEFAULT true,
        max_seats_per_request INT DEFAULT 4,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participante_disponibilidades (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS public.encuentro_opciones_fecha (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        nombre_invitado TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        token UUID DEFAULT gen_random_uuid(),
        seat_count INT NOT NULL DEFAULT 1,
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

      CREATE OR REPLACE FUNCTION public.emitir_alertas_intencion_convertida_outbox(p_intencion_id UUID, p_encuentro_id UUID)
      RETURNS VOID AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(p_action TEXT, p_key TEXT)
      RETURNS JSONB AS $$ BEGIN RETURN '{"allowed": true}'::jsonb; END; $$ LANGUAGE plpgsql;
    `);

    // 2. Aplicar la migración bajo prueba
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../supabase/migrations/20261014160000_fase_lifecycle_cancellation_and_request_quotas.sql'),
      'utf8'
    );
    await db.exec(migrationSql);
  });

  const setAuthContext = async (userId: string, isAnon: boolean = false) => {
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
    await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": ${isAnon}}', false);`);
  };

  test('eliminar_encuentro_seguro permite eliminar un borrador no publicado', async () => {
    await setAuthContext(hostUser);

    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, is_open, opened_at, estado)
      VALUES ('Borrador sin publicar', 'presencial', '${hostUser}', false, NULL, 'activo')
      RETURNING id;
    `);
    const encId = resEnc.rows[0].id;

    const res = await db.query<{ eliminar_encuentro_seguro: any }>(`
      SELECT public.eliminar_encuentro_seguro('${encId}', '${hostUser}');
    `);

    assert.equal(res.rows[0].eliminar_encuentro_seguro.ok, true);

    const check = await db.query(`SELECT id FROM public.encuentros WHERE id = '${encId}'`);
    assert.equal(check.rows.length, 0);
  });

  test('eliminar_encuentro_seguro rechaza eliminar si fue publicado u abierto', async () => {
    await setAuthContext(hostUser);

    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, is_open, opened_at, estado)
      VALUES ('Encuentro Abierto Publicado', 'presencial', '${hostUser}', true, now(), 'activo')
      RETURNING id;
    `);
    const encId = resEnc.rows[0].id;

    const res = await db.query<{ eliminar_encuentro_seguro: any }>(`
      SELECT public.eliminar_encuentro_seguro('${encId}', '${hostUser}');
    `);

    assert.equal(res.rows[0].eliminar_encuentro_seguro.ok, false);
    assert.equal(res.rows[0].eliminar_encuentro_seguro.error, 'cannot_delete_published_or_active_encounter');
  });

  test('cancelar_encuentro_seguro marca cancelado, cierra discovery y notifica a participantes y solicitantes', async () => {
    await setAuthContext(hostUser);

    // Crear encuentro abierto
    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, modalidad, host_id, is_open, opened_at, estado, lugar_texto, max_participants, min_seats_per_request
      )
      VALUES (
        'Tenis Dobles', 'Partido de Tenis en Palermo', 'presencial', '${hostUser}', true, now(), 'activo', 'Club Harrods Cancha 3', 4, 1
      )
      RETURNING id;
    `);
    const encId = resEnc.rows[0].id;

    // Participante confirmado
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser}', 'Carlos', 'confirmado', 1);
    `);

    // Solicitante pendiente
    const resSol = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, seat_count, estado)
      VALUES ('${encId}', '${applicantUser}', 'Lucía', 1, 'pending')
      RETURNING id;
    `);
    const solId = resSol.rows[0].id;

    // Ejecutar cancelación
    const resCancel = await db.query<{ cancelar_encuentro_seguro: any }>(`
      SELECT public.cancelar_encuentro_seguro('${encId}', '${hostUser}');
    `);

    assert.equal(resCancel.rows[0].cancelar_encuentro_seguro.ok, true);
    assert.equal(resCancel.rows[0].cancelar_encuentro_seguro.estado, 'cancelado');

    // Verificar estado del encuentro
    const encRow = (await db.query<{ estado: string; is_open: boolean; cancelled_at: string }>(`
      SELECT estado, is_open, cancelled_at FROM public.encuentros WHERE id = '${encId}';
    `)).rows[0];
    assert.equal(encRow.estado, 'cancelado');
    assert.equal(encRow.is_open, false);
    assert.ok(encRow.cancelled_at !== null);

    // Verificar solicitud pendiente -> transitioned to 'cancelled'
    const solRow = (await db.query<{ estado: string }>(`
      SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${solId}';
    `)).rows[0];
    assert.equal(solRow.estado, 'cancelled');

    // Verificar notificaciones de inbox
    const notifs = (await db.query<{ recipient_user_id: string; notification_type: string }>(`
      SELECT recipient_user_id, notification_type FROM public.inbox_notifications WHERE target_id = '${encId}';
    `)).rows;

    const applicantNotif = notifs.find(n => n.recipient_user_id === applicantUser);
    assert.ok(applicantNotif, 'El solicitante pendiente debe recibir notificación');
    assert.equal(applicantNotif.notification_type, 'open_encounter_request_cancelled_by_host');

    const participantNotif = notifs.find(n => n.recipient_user_id === participantUser);
    assert.ok(participantNotif, 'El participante confirmado debe recibir notificación');
    assert.equal(participantNotif.notification_type, 'encounter_cancelled_for_participant');
  });

  test('get_encuentro_participante_autorizado oculta ubicación y link cuando está cancelado', async () => {
    // Encuentro activo con dirección privada
    await setAuthContext(hostUser);
    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, is_open, estado, lugar_texto, link_virtual)
      VALUES ('Reunión de Diseño', 'presencial', '${hostUser}', true, 'activo', 'Av. Santa Fe 1234 Piso 4', 'https://meet.jit.si/secreto')
      RETURNING id;
    `);
    const encId = resEnc.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encId}', '${participantUser}', 'Socio', 'confirmado');
    `);

    // Consulta del participante cuando está activo: ve logística
    await setAuthContext(participantUser);
    const authResActivo = (await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${encId}');
    `)).rows[0].get_encuentro_participante_autorizado;

    assert.equal(authResActivo.ok, true);
    assert.equal(authResActivo.lugar_texto, 'Av. Santa Fe 1234 Piso 4');

    // Cancelar el encuentro
    await setAuthContext(hostUser);
    await db.query(`SELECT public.cancelar_encuentro_seguro('${encId}', '${hostUser}');`);

    // Consulta del participante cuando está cancelado: logística oculta (NULL)
    await setAuthContext(participantUser);
    const authResCancelado = (await db.query<{ get_encuentro_participante_autorizado: any }>(`
      SELECT public.get_encuentro_participante_autorizado('${encId}');
    `)).rows[0].get_encuentro_participante_autorizado;

    assert.equal(authResCancelado.ok, true);
    assert.equal(authResCancelado.estado, 'cancelado');
    assert.equal(authResCancelado.lugar_texto, null, 'lugar_texto debe ser NULL cuando el encuentro está cancelado');
    assert.equal(authResCancelado.link_virtual, null, 'link_virtual debe ser NULL cuando el encuentro está cancelado');
  });

  test('get_discovery_encuentros_abiertos incluye al host (is_host=true) y excluye cancelados', async () => {
    await setAuthContext(hostUser);

    // Encuentro activo del host en Palermo
    const resEnc1 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, open_public_title, modalidad, host_id, is_open, estado, locality_id, open_public_zone, max_participants, min_seats_per_request, fecha)
      VALUES ('Encuentro Host Palermo', 'Palermo Abierto', 'presencial', '${hostUser}', true, 'activo', 'palermo', 'Palermo Soho', 5, 2, current_date + 1)
      RETURNING id;
    `);
    const enc1Id = resEnc1.rows[0].id;

    // Encuentro cancelado en Palermo
    await db.query(`
      INSERT INTO public.encuentros (titulo, open_public_title, modalidad, host_id, is_open, estado, locality_id, open_public_zone, max_participants, fecha)
      VALUES ('Cancelado Palermo', 'Cancelado', 'presencial', '${hostUser}', false, 'cancelado', 'palermo', 'Palermo Soho', 5, current_date + 1);
    `);

    // Consulta de Discovery como el HOST
    await setAuthContext(hostUser);
    const discHost = (await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['palermo']);
    `)).rows[0].get_discovery_encuentros_abiertos;

    const hostFound = discHost.find((e: any) => e.id === enc1Id);
    assert.ok(hostFound, 'El Host debe ver su propio encuentro en Discovery');
    assert.equal(hostFound.is_host, true, 'is_host debe ser true para el host');
    assert.equal(hostFound.min_seats_per_request, 2, 'min_seats_per_request debe coincidir con lo configurado');

    // Consulta de Discovery como OTRO usuario
    await setAuthContext(otherUser);
    const discOther = (await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['palermo']);
    `)).rows[0].get_discovery_encuentros_abiertos;

    const otherFound = discOther.find((e: any) => e.id === enc1Id);
    assert.ok(otherFound, 'El otro usuario debe ver el encuentro');
    assert.equal(otherFound.is_host, false, 'is_host debe ser false para otros usuarios');

    // Ninguno debe ver el encuentro cancelado
    const cancelledFound = discOther.find((e: any) => e.titulo === 'Cancelado Palermo');
    assert.equal(cancelledFound, undefined, 'Los encuentros cancelados no deben aparecer en Discovery');
  });

  test('solicitar_sumarse_encuentro_abierto rechaza sin clamping si requested > available', async () => {
    await setAuthContext(hostUser);

    // Encuentro con max_participants = 3, confirmed = 1 (quedan 2 disponibles)
    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, is_open, estado, locality_id, max_participants, min_seats_per_request, lugar_texto)
      VALUES ('Fútbol 5', 'presencial', '${hostUser}', true, 'activo', 'palermo', 3, 1, 'Cancha Palermo')
      RETURNING id;
    `);
    const encId = resEnc.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser}', 'Jugador 1', 'confirmado', 1);
    `);

    // Solicitante pide 3 lugares (hay sólo 2 disponibles)
    await setAuthContext(applicantUser);
    const res = (await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        p_encuentro_id := '${encId}'::uuid,
        p_nombre := 'Marcos',
        p_mensaje := 'Vamos 3 amigos',
        p_usuario_id := '${applicantUser}'::uuid,
        p_seat_count := 3
      );
    `)).rows[0].solicitar_sumarse_encuentro_abierto;

    assert.equal(res.ok, false);
    assert.equal(res.error, 'insufficient_available_slots', 'Debe rechazar estrictamente sin reducir silenciosamente los cupos');
    assert.equal(res.available_slots, 2);
  });

  test('solicitar_sumarse_encuentro_abierto valida min_seats_per_request', async () => {
    await setAuthContext(hostUser);

    // Encuentro con min_seats_per_request = 3, max_participants = 5
    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, is_open, estado, locality_id, max_participants, min_seats_per_request, lugar_texto)
      VALUES ('Tenis Dobles (Grupos de a 3)', 'presencial', '${hostUser}', true, 'activo', 'palermo', 5, 3, 'Cancha Palermo')
      RETURNING id;
    `);
    const encId = resEnc.rows[0].id;

    // 1. Solicitante pide 2 lugares (< min_seats_per_request de 3)
    await setAuthContext(applicantUser);
    const resUnderMin = (await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        p_encuentro_id := '${encId}'::uuid,
        p_nombre := 'Sofi',
        p_mensaje := 'Vamos 2',
        p_usuario_id := '${applicantUser}'::uuid,
        p_seat_count := 2
      );
    `)).rows[0].solicitar_sumarse_encuentro_abierto;

    assert.equal(resUnderMin.ok, false);
    assert.equal(resUnderMin.error, 'seats_below_minimum');
    assert.equal(resUnderMin.min_seats_per_request, 3);

    // 2. Si se ocupan 4 lugares (quedando 1 disponible), available < min_seats_per_request
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, seat_count)
      VALUES ('${encId}', '${participantUser}', 'Grupo 1', 'confirmado', 4);
    `);

    const resBelowMinAvailable = (await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        p_encuentro_id := '${encId}'::uuid,
        p_nombre := 'Pedro',
        p_mensaje := 'Voy yo',
        p_usuario_id := '${otherUser}'::uuid,
        p_seat_count := 1
      );
    `)).rows[0].solicitar_sumarse_encuentro_abierto;

    assert.equal(resBelowMinAvailable.ok, false);
    assert.equal(resBelowMinAvailable.error, 'available_seats_below_min_request');
    assert.equal(resBelowMinAvailable.available_slots, 1);
    assert.equal(resBelowMinAvailable.min_seats_per_request, 3);
  });
});
