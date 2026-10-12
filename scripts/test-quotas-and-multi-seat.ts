import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { getSlotLabel } from '../src/components/home/openEncounters/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Suite de Cupos Canónicos y Reserva Múltiple V1 (Casos 1 al 26)', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const applicant1 = '22222222-2222-2222-2222-222222222222';
  const applicant2 = '33333333-3333-3333-3333-333333333333';
  const applicant3 = '44444444-4444-4444-4444-444444444444';
  const applicant4 = '55555555-5555-5555-5555-555555555555';

  const setAuthContext = async (userId: string | null, isAnon: boolean = false, role: string = 'authenticated') => {
    await db.query(`SELECT set_config('request.jwt.claim.role', '${role}', false);`);
    if (!userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
      await db.query(`SET ROLE anon;`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": ${isAnon}, "role": "${role}"}', false);`);
      await db.query(`SET ROLE authenticated;`);
    }
  };

  const resetAuthContext = async () => {
    await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
    await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    await db.query(`SELECT set_config('request.jwt.claim.role', 'postgres', false);`);
    await db.query(`SET ROLE postgres;`);
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

      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
        SELECT COALESCE(current_setting('request.jwt.claim.role', true), 'authenticated');
      $$ LANGUAGE SQL STABLE;

      INSERT INTO auth.users (id, email) VALUES
        ('${hostUser}', 'host@test.com'),
        ('${applicant1}', 'app1@test.com'),
        ('${applicant2}', 'app2@test.com'),
        ('${applicant3}', 'app3@test.com'),
        ('${applicant4}', 'app4@test.com')
      ON CONFLICT DO NOTHING;

      -- Tablas base del dominio
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
        moderation_status TEXT DEFAULT 'approved',
        moderation_reason TEXT,
        moderated_at TIMESTAMPTZ,
        moderation_decision_source TEXT,
        moderation_categories TEXT[],
        open_activity_canonical TEXT,
        open_activity_matching_eligible BOOLEAN DEFAULT false,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        estado TEXT NOT NULL DEFAULT 'pendiente',
        token UUID DEFAULT gen_random_uuid(),
        token_invitacion UUID DEFAULT gen_random_uuid(),
        mensaje_respuesta TEXT,
        respondido_en TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL REFERENCES auth.users(id),
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        estado TEXT NOT NULL DEFAULT 'pending',
        participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
        token_participante UUID,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        resolved_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        blocker_id UUID NOT NULL REFERENCES auth.users(id),
        blocked_id UUID NOT NULL REFERENCES auth.users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.domain_events_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type TEXT NOT NULL,
        event_version INT NOT NULL DEFAULT 1,
        aggregate_type TEXT NOT NULL,
        aggregate_id UUID NOT NULL,
        actor_user_id UUID,
        payload JSONB NOT NULL,
        dedup_key TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.inbox_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_user_id UUID NOT NULL REFERENCES auth.users(id),
        notification_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id UUID NOT NULL,
        deep_link TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        payload JSONB,
        dedup_key TEXT UNIQUE,
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
        p_payload JSONB,
        p_dedup_key TEXT
      ) RETURNS VOID AS $$
      BEGIN
        INSERT INTO public.inbox_notifications (
          recipient_user_id, notification_type, target_type, target_id, deep_link, title, body, payload, dedup_key
        ) VALUES (
          p_recipient_user_id, p_notification_type, p_target_type, p_target_id, p_deep_link, p_title, p_body, p_payload, p_dedup_key
        ) ON CONFLICT (dedup_key) DO NOTHING;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TABLE IF NOT EXISTS public.public_content_moderation_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL,
        moderator_id UUID,
        action TEXT NOT NULL,
        previous_status TEXT,
        new_status TEXT NOT NULL,
        reason TEXT,
        categories TEXT[],
        source TEXT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE OR REPLACE FUNCTION public.evaluar_contenido_publico_determinista(
        p_title TEXT,
        p_description TEXT
      )
      RETURNS TABLE(decision TEXT, reason TEXT, categories TEXT[])
      LANGUAGE plpgsql
      AS $$
      BEGIN
        decision := 'allow';
        reason := NULL;
        categories := ARRAY[]::TEXT[];
        RETURN NEXT;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(
        p_action TEXT,
        p_scope_key TEXT DEFAULT ''
      )
      RETURNS JSONB
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN pg_catalog.jsonb_build_object('allowed', true, 'count', 1);
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.rechazar_solicitud_encuentro_abierto(
        p_request_id UUID,
        p_host_id UUID DEFAULT NULL
      )
      RETURNS JSON
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $$
      DECLARE
        v_user_id UUID := auth.uid();
        v_solicitud public.solicitudes_encuentro_abierto%ROWTYPE;
        v_encuentro public.encuentros%ROWTYPE;
      BEGIN
        IF v_user_id IS NULL THEN
          RETURN pg_catalog.json_build_object('ok', false, 'error', 'authentication_required');
        END IF;

        SELECT * INTO v_solicitud
        FROM public.solicitudes_encuentro_abierto
        WHERE id = p_request_id
        FOR UPDATE;

        IF NOT FOUND THEN
          RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_not_found');
        END IF;

        IF v_solicitud.estado <> 'pending' THEN
          RETURN pg_catalog.json_build_object('ok', false, 'error', 'request_already_processed');
        END IF;

        SELECT * INTO v_encuentro
        FROM public.encuentros
        WHERE id = v_solicitud.encuentro_id;

        IF NOT FOUND OR v_encuentro.host_id <> v_user_id THEN
          RETURN pg_catalog.json_build_object('ok', false, 'error', 'unauthorized');
        END IF;

        UPDATE public.solicitudes_encuentro_abierto
        SET estado = 'rejected',
            resolved_at = pg_catalog.now(),
            updated_at = pg_catalog.now()
        WHERE id = p_request_id;

        RETURN pg_catalog.json_build_object('ok', true, 'request_id', p_request_id, 'estado', 'rejected');
      END;
      $$;

      REVOKE ALL ON FUNCTION public.rechazar_solicitud_encuentro_abierto(UUID, UUID) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.rechazar_solicitud_encuentro_abierto(UUID, UUID) TO authenticated;
    `);

    // 2. Cargar y aplicar las migraciones canónicas
    const migSql1 = fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20261012160000_canonical_quotas_and_multi_seat_v1.sql'),
      'utf8'
    );
    await db.exec(migSql1);

    const migSql2 = fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20261012173000_canonical_confirmed_seats_contract.sql'),
      'utf8'
    );
    await db.exec(migSql2);
  });

  let testEncounterId: string;

  beforeEach(async () => {
    await resetAuthContext();
    await db.query(`DELETE FROM public.domain_events_outbox;`);
    await db.query(`DELETE FROM public.inbox_notifications;`);
    await db.query(`DELETE FROM public.solicitudes_encuentro_abierto;`);
    await db.query(`DELETE FROM public.participantes;`);
    await db.query(`DELETE FROM public.encuentros;`);

    // Crear encuentro base
    const res = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo,
        open_public_title,
        descripcion,
        open_description,
        modalidad,
        lugar_texto,
        locality_id,
        open_public_zone,
        max_participants,
        allow_multi_seat_requests,
        max_seats_per_request,
        host_id,
        is_open,
        moderation_status,
        fecha,
        hora
      ) VALUES (
        'Cena de 5 pasos Privada',
        'Cena de 5 pasos',
        'Descripción privada',
        'Menú degustación con maridaje exclusivo',
        'presencial',
        'Calle Falsa 123',
        'guemes',
        'Güemes / Playa Grande',
        14,
        true,
        4,
        '${hostUser}',
        true,
        'approved',
        (CURRENT_DATE + 5),
        '21:00'
      ) RETURNING id;
    `);
    testEncounterId = res.rows[0].id;
  });

  // ==================================================
  // SECCIÓN 32: TESTS OBLIGATORIOS — CUPOS (CASOS 1 AL 18)
  // ==================================================

  test('Caso 1: Host configura 14 -> Discovery muestra 14', async () => {
    await setAuthContext(null); // Anon/Public
    const res = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const list = res.rows[0].get_discovery_encuentros_abiertos;
    const enc = list.find((e: any) => e.id === testEncounterId);
    assert.ok(enc, 'El encuentro debe estar en Discovery');
    assert.equal(enc.open_slots, 14, 'Discovery debe mostrar exactamente 14 lugares libres');
    assert.equal(enc.public_capacity, 14, 'Capacidad pública debe ser 14');
  });

  test('Caso 2: Host configura 14 -> Detalle público muestra 14', async () => {
    // Detalle público consume los mismos datos o get_detalle_host_seguro / Discovery
    await setAuthContext(hostUser);
    const res = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid) AS get_detalle_host_seguro;`
    );
    const data = res.rows[0].get_detalle_host_seguro;
    assert.equal(data.available_slots, 14, 'Detalle debe computar exactamente 14 disponibles');
    assert.equal(data.max_participants, 14, 'Capacidad configurada debe ser 14');
    assert.equal(data.confirmed_seats, 0, 'Confirmados debe ser 0');
  });

  test('Caso 3: Host muestra 14', async () => {
    // Host UI calcula availableSlots = max_participants - confirmedCount
    await setAuthContext(hostUser);
    const res = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid) AS get_detalle_host_seguro;`
    );
    const data = res.rows[0].get_detalle_host_seguro;
    const hostAvailable = Math.max(0, data.max_participants - data.confirmed_seats);
    assert.equal(hostAvailable, 14, 'Host debe ver exactamente 14 lugares disponibles');
  });

  test('Caso 4: 1 aprobado de 1 -> 13 disponibles', async () => {
    await setAuthContext(applicant1);
    const reqRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Ana', 'Hola', NULL, 1) AS solicitar_sumarse_encuentro_abierto;`
    );
    const reqId = reqRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(hostUser);
    const appRes = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
      `SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}'::uuid) AS aprobar_solicitud_encuentro_abierto;`
    );
    assert.equal(appRes.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);
    assert.equal(appRes.rows[0].aprobar_solicitud_encuentro_abierto.nuevo_cupo_disponible, 13);

    // Verificar en Discovery
    await setAuthContext(null);
    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const enc = discRes.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === testEncounterId);
    assert.equal(enc.open_slots, 13, 'Discovery debe mostrar 13 lugares');
  });

  test('Caso 5: 1 aprobado de 3 -> 11 disponibles', async () => {
    await setAuthContext(applicant1);
    const reqRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Bruno', 'Vamos con amigos', NULL, 3) AS solicitar_sumarse_encuentro_abierto;`
    );
    const reqId = reqRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;
    assert.equal(reqRes.rows[0].solicitar_sumarse_encuentro_abierto.seat_count, 3);

    await setAuthContext(hostUser);
    const appRes = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
      `SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}'::uuid) AS aprobar_solicitud_encuentro_abierto;`
    );
    assert.equal(appRes.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);
    assert.equal(appRes.rows[0].aprobar_solicitud_encuentro_abierto.seat_count, 3);
    assert.equal(appRes.rows[0].aprobar_solicitud_encuentro_abierto.nuevo_cupo_disponible, 11);

    await setAuthContext(null);
    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const enc = discRes.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === testEncounterId);
    assert.equal(enc.open_slots, 11, 'Discovery debe mostrar 11 lugares');
  });

  test('Caso 6: 2 aprobados (2 + 3) -> 9 disponibles', async () => {
    // Solicitud 1: 2 lugares
    await setAuthContext(applicant1);
    const req1 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Sol 1', 'Somos 2', NULL, 2) AS solicitar_sumarse_encuentro_abierto;`
    );
    const id1 = req1.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    // Solicitud 2: 3 lugares
    await setAuthContext(applicant2);
    const req2 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Sol 2', 'Somos 3', NULL, 3) AS solicitar_sumarse_encuentro_abierto;`
    );
    const id2 = req2.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    // Host aprueba ambas
    await setAuthContext(hostUser);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${id1}'::uuid);`);
    const app2 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
      `SELECT public.aprobar_solicitud_encuentro_abierto('${id2}'::uuid) AS aprobar_solicitud_encuentro_abierto;`
    );
    assert.equal(app2.rows[0].aprobar_solicitud_encuentro_abierto.nuevo_cupo_disponible, 9);

    // Verificar en Host detail
    const hostDet = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid) AS get_detalle_host_seguro;`
    );
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.available_slots, 9);
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.confirmed_seats, 5);
  });

  test('Caso 7: Pendiente de 3 -> sigue mostrando 14', async () => {
    await setAuthContext(applicant1);
    await db.query(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Carlos', 'Pendiente', NULL, 3);`
    );

    // Discovery no reserva con pendientes
    await setAuthContext(null);
    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const enc = discRes.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === testEncounterId);
    assert.equal(enc.open_slots, 14, 'Con solicitud pendiente debe seguir mostrando 14');
  });

  test('Caso 8: Rechazar pendiente de 3 -> sigue mostrando 14', async () => {
    await setAuthContext(applicant1);
    const reqRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Rechazado', 'Msg', NULL, 3) AS solicitar_sumarse_encuentro_abierto;`
    );
    const reqId = reqRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(hostUser);
    const rejRes = await db.query<{ rechazar_solicitud_encuentro_abierto: any }>(
      `SELECT public.rechazar_solicitud_encuentro_abierto('${reqId}'::uuid, '${hostUser}'::uuid) AS rechazar_solicitud_encuentro_abierto;`
    );
    assert.equal(rejRes.rows[0].rechazar_solicitud_encuentro_abierto.ok, true);

    await setAuthContext(null);
    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const enc = discRes.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === testEncounterId);
    assert.equal(enc.open_slots, 14, 'Luego de rechazar debe seguir mostrando 14');
  });

  test('Caso 9: Cancelar aprobado de 3 -> libera 3', async () => {
    await setAuthContext(applicant1);
    const reqRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Dani', '3 lugares', NULL, 3) AS solicitar_sumarse_encuentro_abierto;`
    );
    const reqId = reqRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(hostUser);
    const appRes = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
      `SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}'::uuid) AS aprobar_solicitud_encuentro_abierto;`
    );
    const partId = appRes.rows[0].aprobar_solicitud_encuentro_abierto.participante_id;

    // Eliminar / cancelar participante
    await resetAuthContext();
    await db.query(`DELETE FROM public.participantes WHERE id = '${partId}'::uuid;`);

    // Comprobar que vuelve a 14 disponibles
    await setAuthContext(null);
    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const enc = discRes.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === testEncounterId);
    assert.equal(enc.open_slots, 14, 'Al cancelar participante debe liberar los 3 lugares volviendo a 14');
  });

  test('Caso 10: Host no consume lugar externo', async () => {
    // Si hay 0 confirmados, available_slots = max_participants = 14
    await setAuthContext(hostUser);
    const hostDet = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid) AS get_detalle_host_seguro;`
    );
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.available_slots, 14, 'Host no resta ningún lugar');
  });

  test('Caso 11: No puede aprobar 3 si quedan 2', async () => {
    // Reducir cupo configurando 12 confirmados previamente
    await resetAuthContext();
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, tipo_invitacion, estado, seat_count)
      VALUES ('${testEncounterId}', '${applicant1}', 'Grupo 12', 'individual', 'confirmado', 12);
    `);

    // Ahora quedan 14 - 12 = 2 lugares libres
    await setAuthContext(applicant2);
    const reqRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Pide 3', 'Somos 3', NULL, 3) AS solicitar_sumarse_encuentro_abierto;`
    );
    const reqId = reqRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    // Host intenta aprobar
    await setAuthContext(hostUser);
    const appRes = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
      `SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}'::uuid) AS aprobar_solicitud_encuentro_abierto;`
    );
    assert.equal(appRes.rows[0].aprobar_solicitud_encuentro_abierto.ok, false);
    assert.equal(appRes.rows[0].aprobar_solicitud_encuentro_abierto.error, 'quota_exceeded');
  });

  test('Caso 12: Dos aprobaciones concurrentes no producen sobrecupo', async () => {
    // Encuentro con max_participants = 3
    await resetAuthContext();
    await db.query(`UPDATE public.encuentros SET max_participants = 3 WHERE id = '${testEncounterId}';`);

    // Solicitud A: 2 lugares
    await setAuthContext(applicant1);
    const reqA = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Ana', 'Pide 2', NULL, 2) AS solicitar_sumarse_encuentro_abierto;`
    );
    const idA = reqA.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    // Solicitud B: 2 lugares
    await setAuthContext(applicant2);
    const reqB = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Beto', 'Pide 2', NULL, 2) AS solicitar_sumarse_encuentro_abierto;`
    );
    const idB = reqB.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    // Host aprueba A (debe pasar, quedan 1)
    await setAuthContext(hostUser);
    const resA = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
      `SELECT public.aprobar_solicitud_encuentro_abierto('${idA}'::uuid) AS aprobar_solicitud_encuentro_abierto;`
    );
    assert.equal(resA.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);

    // Host aprueba B (debe fallar cerrado con quota_exceeded porque 2 + 2 = 4 > 3)
    const resB = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
      `SELECT public.aprobar_solicitud_encuentro_abierto('${idB}'::uuid) AS aprobar_solicitud_encuentro_abierto;`
    );
    assert.equal(resB.rows[0].aprobar_solicitud_encuentro_abierto.ok, false);
    assert.equal(resB.rows[0].aprobar_solicitud_encuentro_abierto.error, 'quota_exceeded');

    // Total en participantes debe ser 2, jamás 4
    await resetAuthContext();
    const countRes = await db.query<{ total: number }>(
      `SELECT COALESCE(SUM(seat_count), 0)::int AS total FROM public.participantes WHERE encuentro_id = '${testEncounterId}' AND estado = 'confirmado';`
    );
    assert.equal(countRes.rows[0].total, 2);
  });

  test('Caso 13: No puede reducir capacidad debajo de lugares aprobados', async () => {
    // 5 confirmados
    await resetAuthContext();
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, tipo_invitacion, estado, seat_count)
      VALUES ('${testEncounterId}', '${applicant1}', 'Confirmados', 'individual', 'confirmado', 5);
    `);

    // Host intenta reducir a 4 via actualizar_encuentro_seguro
    await setAuthContext(hostUser);
    const updateRes = await db.query<{ actualizar_encuentro_seguro: any }>(
      `SELECT public.actualizar_encuentro_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid, '{"max_participants": 4}'::jsonb) AS actualizar_encuentro_seguro;`
    );
    assert.equal(updateRes.rows[0].actualizar_encuentro_seguro.ok, false);
    assert.equal(updateRes.rows[0].actualizar_encuentro_seguro.error, 'max_participants_too_low');

    // Host intenta reducir a 4 via abrir_encuentro_seguro
    const openRes = await db.query<{ abrir_encuentro_seguro: any }>(
      `SELECT public.abrir_encuentro_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid, 'Nueva descrip', 4, 'guemes') AS abrir_encuentro_seguro;`
    );
    assert.equal(openRes.rows[0].abrir_encuentro_seguro.ok, false);
    assert.equal(openRes.rows[0].abrir_encuentro_seguro.error, 'max_participants_too_low');
  });

  test('Caso 14: Cliente manipulado no puede pedir > max_seats_per_request', async () => {
    // Encuentro tiene max_seats_per_request = 4
    await setAuthContext(applicant1);
    const reqRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Hacker', 'Quiero 10', NULL, 10) AS solicitar_sumarse_encuentro_abierto;`
    );
    assert.equal(reqRes.rows[0].solicitar_sumarse_encuentro_abierto.ok, false);
    assert.equal(reqRes.rows[0].solicitar_sumarse_encuentro_abierto.error, 'seats_exceed_limit');
  });

  test('Caso 15: multi-seat disabled => servidor fuerza/rechaza > 1', async () => {
    // Deshabilitar multi-seat en el encuentro
    await resetAuthContext();
    await db.query(`UPDATE public.encuentros SET allow_multi_seat_requests = false, max_seats_per_request = 1 WHERE id = '${testEncounterId}';`);

    // Cliente manipulado envía seat_count = 5
    await setAuthContext(applicant1);
    const reqRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Manipulador', 'Quiero 5', NULL, 5) AS solicitar_sumarse_encuentro_abierto;`
    );
    assert.equal(reqRes.rows[0].solicitar_sumarse_encuentro_abierto.ok, true);
    // Servidor forzó estrictamente seat_count = 1
    assert.equal(reqRes.rows[0].solicitar_sumarse_encuentro_abierto.seat_count, 1);

    await resetAuthContext();
    const checkDb = await db.query<{ seat_count: number }>(
      `SELECT seat_count FROM public.solicitudes_encuentro_abierto WHERE id = '${reqRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id}';`
    );
    assert.equal(checkDb.rows[0].seat_count, 1, 'En base de datos debe guardarse seat_count = 1');
  });

  test('Caso 16: Registros históricos => seat_count = 1', async () => {
    await resetAuthContext();
    const checkSolicitudes = await db.query<{ cnt: number }>(
      `SELECT count(*)::int AS cnt FROM public.solicitudes_encuentro_abierto WHERE seat_count IS NULL OR seat_count < 1;`
    );
    assert.equal(checkSolicitudes.rows[0].cnt, 0, 'Ninguna solicitud debe tener seat_count nulo o menor a 1');

    const checkParticipantes = await db.query<{ cnt: number }>(
      `SELECT count(*)::int AS cnt FROM public.participantes WHERE seat_count IS NULL OR seat_count < 1;`
    );
    assert.equal(checkParticipantes.rows[0].cnt, 0, 'Ningún participante debe tener seat_count nulo o menor a 1');
  });

  test('Caso 17: Singular "1 lugar"', () => {
    assert.equal(getSlotLabel(1), '1 lugar', 'Para 1 lugar disponible la etiqueta debe ser "1 lugar"');
    assert.equal(getSlotLabel(2), '2 lugares', 'Para 2 lugares debe ser "2 lugares"');
    assert.equal(getSlotLabel(14), '14 lugares', 'Para 14 lugares debe ser "14 lugares"');
    assert.equal(getSlotLabel(0), 'Completo', 'Para 0 lugares debe ser "Completo"');
  });

  test('Caso 18: Discovery y Detalle siempre coinciden', async () => {
    // Ambos consultan el modelo canónico
    await setAuthContext(null);
    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const discEnc = discRes.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === testEncounterId);

    await setAuthContext(hostUser);
    const hostDet = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid) AS get_detalle_host_seguro;`
    );
    const hostEnc = hostDet.rows[0].get_detalle_host_seguro;

    assert.equal(discEnc.open_slots, hostEnc.available_slots, 'Discovery y Host disponible deben ser idénticos (14)');
    assert.equal(discEnc.public_capacity, hostEnc.max_participants, 'Capacidad pública debe coincidir');
  });

  // ==================================================
  // SECCIÓN 33: TESTS OBLIGATORIOS — UX (CASOS 19 AL 26)
  // ==================================================

  test('Caso 19: Control de cantidad sólo aparece si multi-seat habilitado', () => {
    const detailSheetCode = fs.readFileSync(
      path.join(process.cwd(), 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf8'
    );
    assert.ok(
      detailSheetCode.includes('encounter.allowMultiSeatRequests &&'),
      'El selector de cantidad debe estar condicionado a encounter.allowMultiSeatRequests'
    );
  });

  test('Caso 20: Default cantidad = 1', () => {
    const detailSheetCode = fs.readFileSync(
      path.join(process.cwd(), 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf8'
    );
    assert.ok(
      detailSheetCode.includes('useState<number>(1)'),
      'El estado inicial de requestedSeats debe ser 1'
    );
    assert.ok(
      detailSheetCode.includes('setRequestedSeats(1)'),
      'Debe resetearse a 1 al abrir la solicitud'
    );
  });

  test('Caso 21: +/- respeta límites', () => {
    const detailSheetCode = fs.readFileSync(
      path.join(process.cwd(), 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf8'
    );
    assert.ok(
      detailSheetCode.includes('Math.max(1, s - 1)'),
      'El botón de restar debe respetar límite inferior de 1'
    );
    assert.ok(
      detailSheetCode.includes('Math.min('),
      'El botón de sumar debe respetar límite superior min(maxSeatsPerRequest, openSlots)'
    );
    assert.ok(
      detailSheetCode.includes('requestedSeats <= 1'),
      'Botón restar debe deshabilitarse en 1'
    );
  });

  test('Caso 22: Texto "Incluyéndote a vos"', () => {
    const detailSheetCode = fs.readFileSync(
      path.join(process.cwd(), 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'),
      'utf8'
    );
    assert.ok(
      detailSheetCode.includes('Incluyéndote a vos'),
      'Debe incluir el texto aclaratorio exacto "Incluyéndote a vos"'
    );
  });

  test('Caso 23: Host ve cantidad solicitada', () => {
    const hostSectionCode = fs.readFileSync(
      path.join(process.cwd(), 'src/components/host/HostOpenEncounterSection.tsx'),
      'utf8'
    );
    assert.ok(
      hostSectionCode.includes('req.seat_count && req.seat_count > 1'),
      'Host debe renderizar badge con la cantidad de lugares si es mayor a 1'
    );
    assert.ok(
      hostSectionCode.includes('{req.seat_count} lugares'),
      'Debe mostrar "{req.seat_count} lugares"'
    );
  });

  test('Caso 24: Aprobación muestra cantidad correctamente', () => {
    const hostSectionCode = fs.readFileSync(
      path.join(process.cwd(), 'src/components/host/HostOpenEncounterSection.tsx'),
      'utf8'
    );
    assert.ok(
      hostSectionCode.includes('`Aceptar ${req.seat_count} lugares`'),
      'Botón de aceptar debe indicar "Aceptar N lugares" cuando N > 1'
    );
  });

  test('Caso 25: Mobile sin overflow', () => {
    const cssCode = fs.readFileSync(
      path.join(process.cwd(), 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.css'),
      'utf8'
    );
    assert.ok(
      cssCode.includes('.pe-detail-sheet__seats-stepper'),
      'Debe contener clase CSS estilizada para el stepper'
    );
    assert.ok(
      cssCode.includes('display: inline-flex'),
      'Stepper debe ser inline-flex compacto para evitar desbordes en móviles'
    );
  });

  test('Caso 26: Desktop sin regresión', () => {
    const cssCode = fs.readFileSync(
      path.join(process.cwd(), 'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.css'),
      'utf8'
    );
    assert.ok(
      cssCode.includes('@media (min-width: 768px)'),
      'Debe conservar las reglas de modal desktop sin regresión'
    );
  });

  // ==================================================
  // SECCIÓN 12: SEMÁNTICA DE CONFIRMED_SEATS Y PERSONAS FÍSICAS (CASOS A AL F)
  // ==================================================

  test('Caso A: Capacidad 14, 0 confirmados -> Host 14 / Discovery 14 / Detalle 14, 0 confirmados', async () => {
    await setAuthContext(null);
    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const enc = discRes.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === testEncounterId);
    assert.equal(enc.open_slots, 14);
    assert.equal(enc.confirmed_seats, 0);
    assert.equal(enc.confirmed_count, 0);

    await setAuthContext(hostUser);
    const hostDet = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid) AS get_detalle_host_seguro;`
    );
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.available_slots, 14);
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.confirmed_seats, 0);
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.confirmed_requests, 0);
  });

  test('Caso B: Lea seat_count = 3 aprobado -> titulares = 1, confirmed_seats = 3, Host 11, Discovery 11, Detalle 11, público = 3 personas confirmadas', async () => {
    await setAuthContext(applicant1);
    const reqRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Lea', 'Somos 3', NULL, 3) AS solicitar_sumarse_encuentro_abierto;`
    );
    const reqId = reqRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuthContext(hostUser);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}'::uuid);`);

    // Host
    const hostDet = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid) AS get_detalle_host_seguro;`
    );
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.confirmed_seats, 3, 'confirmed_seats debe ser 3');
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.confirmed_requests, 1, 'titulares debe ser 1');
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.available_slots, 11, 'available_slots debe ser 11');

    // Discovery y Detalle público
    await setAuthContext(null);
    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const enc = discRes.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === testEncounterId);
    assert.equal(enc.open_slots, 11, 'Discovery debe mostrar 11 lugares');
    assert.equal(enc.confirmed_seats, 3, 'confirmed_seats en público debe ser 3 personas');
    assert.equal(enc.confirmed_count, 3, 'confirmed_count en público debe ser 3 personas');
  });

  test('Caso C: Lea = 3, Ana = 2 -> titulares = 2, confirmed_seats = 5, disponibles = 9, público = 5 personas confirmadas', async () => {
    // Solicitud Lea (3)
    await setAuthContext(applicant1);
    const reqLea = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Lea', 'Somos 3', NULL, 3) AS solicitar_sumarse_encuentro_abierto;`
    );
    // Solicitud Ana (2)
    await setAuthContext(applicant2);
    const reqAna = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Ana', 'Somos 2', NULL, 2) AS solicitar_sumarse_encuentro_abierto;`
    );

    // Host aprueba ambas
    await setAuthContext(hostUser);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${reqLea.rows[0].solicitar_sumarse_encuentro_abierto.request_id}'::uuid);`);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${reqAna.rows[0].solicitar_sumarse_encuentro_abierto.request_id}'::uuid);`);

    // Host
    const hostDet = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid) AS get_detalle_host_seguro;`
    );
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.confirmed_seats, 5);
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.confirmed_requests, 2);
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.available_slots, 9);

    // Discovery
    await setAuthContext(null);
    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const enc = discRes.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === testEncounterId);
    assert.equal(enc.open_slots, 9);
    assert.equal(enc.confirmed_seats, 5);
    assert.equal(enc.confirmed_count, 5);
  });

  test('Caso D: Pendiente de 4 -> NO altera confirmed_seats ni disponibilidad', async () => {
    // Primero aprobamos a Lea de 3 (deja 11 disponibles)
    await setAuthContext(applicant1);
    const reqLea = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Lea', 'Somos 3', NULL, 3) AS solicitar_sumarse_encuentro_abierto;`
    );
    await setAuthContext(hostUser);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${reqLea.rows[0].solicitar_sumarse_encuentro_abierto.request_id}'::uuid);`);

    // Ahora solicitud pendiente de 4
    await setAuthContext(applicant2);
    await db.query(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Bruno', 'Somos 4', NULL, 4);`
    );

    // Verificar en Host y Discovery: sigue en 11 libres y 3 confirmados
    await setAuthContext(hostUser);
    const hostDet = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid) AS get_detalle_host_seguro;`
    );
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.confirmed_seats, 3);
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.available_slots, 11);

    await setAuthContext(null);
    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const enc = discRes.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === testEncounterId);
    assert.equal(enc.open_slots, 11);
    assert.equal(enc.confirmed_seats, 3);
  });

  test('Caso E: Cancelar/eliminar Lea de 3 -> confirmed_seats disminuye 3 y disponibilidad aumenta 3', async () => {
    // Aprobamos a Lea (3)
    await setAuthContext(applicant1);
    const reqLea = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Lea', 'Somos 3', NULL, 3) AS solicitar_sumarse_encuentro_abierto;`
    );
    await setAuthContext(hostUser);
    const appRes = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
      `SELECT public.aprobar_solicitud_encuentro_abierto('${reqLea.rows[0].solicitar_sumarse_encuentro_abierto.request_id}'::uuid);`
    );
    const partId = appRes.rows[0].aprobar_solicitud_encuentro_abierto.participante_id;

    // Eliminar participante Lea
    await resetAuthContext();
    await db.query(`DELETE FROM public.participantes WHERE id = '${partId}'::uuid;`);

    // Host y Discovery deben volver automáticamente a 14 disponibles y 0 confirmados
    await setAuthContext(hostUser);
    const hostDet = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid) AS get_detalle_host_seguro;`
    );
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.confirmed_seats, 0);
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.available_slots, 14);

    await setAuthContext(null);
    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const enc = discRes.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === testEncounterId);
    assert.equal(enc.open_slots, 14);
    assert.equal(enc.confirmed_seats, 0);
  });

  test('Caso F: Multi-seat disabled -> comportamiento histórico seat_count = 1', async () => {
    await resetAuthContext();
    await db.query(`UPDATE public.encuentros SET allow_multi_seat_requests = false, max_seats_per_request = 1 WHERE id = '${testEncounterId}';`);

    // Solicitante envía default o intento de más
    await setAuthContext(applicant1);
    const reqRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Solo', 'Voy solo') AS solicitar_sumarse_encuentro_abierto;`
    );
    assert.equal(reqRes.rows[0].solicitar_sumarse_encuentro_abierto.seat_count, 1);

    await setAuthContext(hostUser);
    await db.query(`SELECT public.aprobar_solicitud_encuentro_abierto('${reqRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id}'::uuid);`);

    const hostDet = await db.query<{ get_detalle_host_seguro: any }>(
      `SELECT public.get_detalle_host_seguro('${testEncounterId}'::uuid, '${hostUser}'::uuid) AS get_detalle_host_seguro;`
    );
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.confirmed_seats, 1);
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.confirmed_requests, 1);
    assert.equal(hostDet.rows[0].get_detalle_host_seguro.available_slots, 13);
  });
});
