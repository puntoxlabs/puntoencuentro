/**
 * Suite de Pruebas: P0 / Bloque 1 — Comunicaciones Críticas (H1, H5, H8)
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

describe('P0 / Bloque 1: Comunicaciones Críticas e Integridad de Estados', () => {
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
        moderated_at TIMESTAMPTZ,
        moderation_reason TEXT,
        moderation_decision_source TEXT,
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

      CREATE OR REPLACE FUNCTION public.evaluar_contenido_publico_determinista(
          p_title TEXT,
          p_desc TEXT
      )
      RETURNS TABLE(decision TEXT, reason TEXT) AS $$
      BEGIN
        IF p_title ILIKE '%prohibido%' THEN
          RETURN QUERY SELECT 'block'::TEXT, 'contenido_inapropiado'::TEXT;
        ELSE
          RETURN QUERY SELECT 'allow'::TEXT, NULL::TEXT;
        END IF;
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

      CREATE OR REPLACE FUNCTION public.marcar_notificacion_leida_seguro(p_notification_id UUID)
      RETURNS JSONB
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $$
      DECLARE
          v_user_id UUID := auth.uid();
          v_updated_id UUID;
          v_read_at TIMESTAMPTZ := timezone('utc', now());
      BEGIN
          IF v_user_id IS NULL THEN
              RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
          END IF;

          UPDATE public.inbox_notifications
          SET read_at = v_read_at
          WHERE id = p_notification_id
            AND recipient_user_id = v_user_id
            AND read_at IS NULL
          RETURNING id INTO v_updated_id;

          RETURN pg_catalog.jsonb_build_object(
              'ok', true,
              'notification_id', p_notification_id,
              'read_at', v_read_at
          );
      END;
      $$;
    `);

    // 2. Cargar migraciones de ciclo de vida vigentes
    const mFix = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261014183000_fix_nullif_syntax_lifecycle.sql'), 'utf8');
    await db.exec(mFix);

    // 3. Cargar nuestra nueva migración H1 + H5 + H8
    const mNew = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261016150000_harden_actualizar_encuentro_and_critical_notifications.sql'), 'utf8');
    await db.exec(mNew);

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

  // ============================================================
  // BLOQUE 1: SEGURIDAD (H1)
  // ============================================================

  test('H1.1: Host no puede cancelar mediante actualizar_encuentro_seguro (rechaza state_transition_not_allowed)', async () => {
    await setAuthContext(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open)
      VALUES ('Fútbol 5', '${hostUser}', 'activo', true)
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Intento de forzar estado = 'cancelado' mediante actualizar_encuentro_seguro
    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"estado": "cancelado"}'::jsonb
      );
    `);

    const result = res.rows[0].actualizar_encuentro_seguro;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'state_transition_not_allowed');

    // Verificar en DB que el estado sigue siendo 'activo'
    const check = await db.query<{ estado: string }>(`SELECT estado FROM public.encuentros WHERE id = '${encId}';`);
    assert.equal(check.rows[0].estado, 'activo');
  });

  test('H1.2: Host puede enviar el estado actual sin alterarlo (compatibilidad frontend)', async () => {
    await setAuthContext(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open)
      VALUES ('Asado', '${hostUser}', 'activo', true)
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"estado": "activo", "descripcion": "Traer bebidas"}'::jsonb
      );
    `);

    const result = res.rows[0].actualizar_encuentro_seguro;
    assert.equal(result.ok, true);

    const check = await db.query<{ descripcion: string; estado: string }>(`SELECT descripcion, estado FROM public.encuentros WHERE id = '${encId}';`);
    assert.equal(check.rows[0].descripcion, 'Traer bebidas');
    assert.equal(check.rows[0].estado, 'activo');
  });

  test('H1.3: Usuario no autorizado no puede actualizar el encuentro (forbidden)', async () => {
    await setAuthContext(attackerUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado)
      VALUES ('Privado', '${hostUser}', 'activo')
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"titulo": "Hackeado"}'::jsonb
      );
    `);

    const result = res.rows[0].actualizar_encuentro_seguro;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'forbidden');
  });

  test('H1.4: Cancelación canónica con cancelar_encuentro_seguro funciona y exige motivo', async () => {
    await setAuthContext(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open)
      VALUES ('Vóley', '${hostUser}', 'activo', true)
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Agregar participante confirmado
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encId}', '${participantUser1}', 'Laura', 'confirmado');
    `);

    // Cancelar sin motivo debe fallar
    const failRes = await db.query<{ cancelar_encuentro_seguro: any }>(`
      SELECT public.cancelar_encuentro_seguro('${encId}', '${hostUser}', '');
    `);
    assert.equal(failRes.rows[0].cancelar_encuentro_seguro.ok, false);
    assert.equal(failRes.rows[0].cancelar_encuentro_seguro.error, 'cancellation_reason_required');

    // Cancelar con motivo debe pasar y notificar al participante
    const okRes = await db.query<{ cancelar_encuentro_seguro: any }>(`
      SELECT public.cancelar_encuentro_seguro('${encId}', '${hostUser}', 'Cancha inundada');
    `);
    assert.equal(okRes.rows[0].cancelar_encuentro_seguro.ok, true);

    const checkNotif = await db.query<{ notification_type: string; payload: any }>(`
      SELECT notification_type, payload
      FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantUser1}'
        AND target_id = '${encId}';
    `);
    assert.equal(checkNotif.rows.length, 1);
    assert.equal(checkNotif.rows[0].notification_type, 'encounter_cancelled_for_participant');
    assert.equal(checkNotif.rows[0].payload.cancellation_reason, 'Cancha inundada');
  });

  test('H1.5: Encuentro privado se actualiza sin error y sin emitir avisos de Encuentros Abiertos', async () => {
    await setAuthContext(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, estado, is_open, modalidad)
      VALUES ('Cena íntima', '${hostUser}', 'activo', false, 'presencial')
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Participante privado
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encId}', '${participantUser1}', 'Martín', 'confirmado');
    `);

    // Cambiar fecha en encuentro estrictamente privado
    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"fecha": "2026-11-20"}'::jsonb
      );
    `);
    assert.equal(res.rows[0].actualizar_encuentro_seguro.ok, true);

    // Cero notificaciones en inbox para encuentro privado
    const checkNotif = await db.query(`
      SELECT id FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantUser1}'
        AND target_id = '${encId}';
    `);
    assert.equal(checkNotif.rows.length, 0);
  });

  // ============================================================
  // BLOQUE 2: CAMBIOS DE AGENDA Y LOGÍSTICA (H5)
  // ============================================================

  test('H5.1: Cambio de fecha en Encuentro Abierto notifica a confirmados y solicitantes pendientes', async () => {
    await setAuthContext(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, host_id, estado, is_open, fecha, hora, open_public_zone
      ) VALUES (
        'Pádel Palermo', 'Pádel Abierto', '${hostUser}', 'activo', true, '2026-11-10', '18:00:00', 'Palermo'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encId}', '${participantUser1}', 'Sofi', 'confirmado');
    `);

    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encId}', '${applicantUser1}', 'Juan', 'pending');
    `);

    // Modificar fecha
    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"fecha": "2026-11-12"}'::jsonb
      );
    `);
    assert.equal(res.rows[0].actualizar_encuentro_seguro.ok, true);

    // 1. Participante confirmado recibe aviso de reprogramación
    const notifPart = await db.query<{ notification_type: string; body: string; payload: any }>(`
      SELECT notification_type, body, payload
      FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantUser1}'
        AND target_id = '${encId}'
        AND notification_type = 'encounter_schedule_changed';
    `);
    assert.equal(notifPart.rows.length, 1);
    assert.equal(notifPart.rows[0].payload.priority, 'critical');
    assert.ok(notifPart.rows[0].body.includes('Nueva fecha: 12/11/2026 18:00'));

    // 2. Solicitante pendiente recibe aviso con datos públicos
    const notifSol = await db.query<{ notification_type: string; body: string; payload: any }>(`
      SELECT notification_type, body, payload
      FROM public.inbox_notifications
      WHERE recipient_user_id = '${applicantUser1}'
        AND target_id = '${encId}'
        AND notification_type = 'encounter_schedule_changed';
    `);
    assert.equal(notifSol.rows.length, 1);
    assert.equal(notifSol.rows[0].payload.is_applicant, true);
    assert.equal(notifSol.rows[0].payload.public_zone, 'Palermo');
    assert.equal(notifSol.rows[0].payload.lugar_texto, undefined);
  });

  test('H5.2: Cambio de horario reinicia reconfirmation_status si inscripciones cerradas', async () => {
    await setAuthContext(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, host_id, estado, is_open, fecha, hora, inscriptions_closed
      ) VALUES (
        'Tenis', '${hostUser}', 'activo', true, '2026-11-10', '10:00:00', true
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, reconfirmation_status, reconfirmed_at)
      VALUES ('${encId}', '${participantUser1}', 'Ana', 'confirmado', 'confirmed', now());
    `);

    // Cambiar hora
    await db.query(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"hora": "15:00:00"}'::jsonb
      );
    `);

    // Participante debe tener reconfirmation_status = 'pending' y reconfirmed_at = NULL
    const checkPart = await db.query<{ reconfirmation_status: string; reconfirmed_at: any }>(`
      SELECT reconfirmation_status, reconfirmed_at
      FROM public.participantes
      WHERE encuentro_id = '${encId}' AND user_id = '${participantUser1}';
    `);
    assert.equal(checkPart.rows[0].reconfirmation_status, 'pending');
    assert.equal(checkPart.rows[0].reconfirmed_at, null);
  });

  test('H5.3: Cambio de lugar_texto notifica solo a confirmados y CERO a pendientes', async () => {
    await setAuthContext(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, host_id, estado, is_open, lugar_texto
      ) VALUES (
        'Charla Tech', '${hostUser}', 'activo', true, 'Club Social'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encId}', '${participantUser1}', 'Nico', 'confirmado');
    `);

    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encId}', '${applicantUser1}', 'Pedro', 'pending');
    `);

    // Actualizar solo dirección
    await db.query(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"lugar_texto": "Av. Libertador 1234, Piso 5"}'::jsonb
      );
    `);

    // 1. Participante confirmado recibe aviso de logística
    const notifPart = await db.query<{ notification_type: string; body: string; payload: any }>(`
      SELECT notification_type, body, payload
      FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantUser1}'
        AND target_id = '${encId}';
    `);
    assert.equal(notifPart.rows.length, 1);
    assert.equal(notifPart.rows[0].notification_type, 'encounter_logistics_changed');
    // Invariante de privacidad: NO persistir la dirección exacta en el payload innecesariamente
    assert.equal(notifPart.rows[0].payload.lugar_texto, undefined);

    // 2. Solicitante pendiente recibe CERO notificaciones
    const notifSol = await db.query(`
      SELECT id FROM public.inbox_notifications
      WHERE recipient_user_id = '${applicantUser1}'
        AND target_id = '${encId}';
    `);
    assert.equal(notifSol.rows.length, 0);
  });

  test('H5.4: Guardar los mismos valores no genera avisos duplicados', async () => {
    await setAuthContext(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, host_id, estado, is_open, fecha, hora
      ) VALUES (
        'Café', '${hostUser}', 'activo', true, '2026-11-15', '16:00:00'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encId}', '${participantUser1}', 'Lucas', 'confirmado');
    `);

    // Guardar exactamente la misma fecha y hora
    await db.query(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"fecha": "2026-11-15", "hora": "16:00:00"}'::jsonb
      );
    `);

    const notifs = await db.query(`
      SELECT id FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantUser1}' AND target_id = '${encId}';
    `);
    assert.equal(notifs.rows.length, 0);
  });

  test('H5.5: Dos modificaciones reales sucesivas generan dos avisos legítimos (dedup key dinámica)', async () => {
    await setAuthContext(hostUser);

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, host_id, estado, is_open, fecha, hora
      ) VALUES (
        'Torneo Ajedrez', '${hostUser}', 'activo', true, '2026-11-01', '10:00:00'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encId}', '${participantUser1}', 'Gabi', 'confirmado');
    `);

    // Modificación 1: Pasa al 02/11
    await db.query(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"fecha": "2026-11-02"}'::jsonb
      );
    `);

    // Reintento idéntico (simula retry de red): NO debe duplicar
    await db.query(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"fecha": "2026-11-02"}'::jsonb
      );
    `);

    // Modificación 2: Pasa al 03/11
    await db.query(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"fecha": "2026-11-03"}'::jsonb
      );
    `);

    const notifs = await db.query<{ id: string; body: string }>(`
      SELECT id, body FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantUser1}' AND target_id = '${encId}'
      ORDER BY created_at ASC;
    `);
    // Debe haber exactamente 2 notificaciones (02/11 y 03/11), no 3
    assert.equal(notifs.rows.length, 2);
    assert.ok(notifs.rows[0].body.includes('02/11/2026'));
    assert.ok(notifs.rows[1].body.includes('03/11/2026'));
  });

  // ============================================================
  // BLOQUE 3: NOTIFICACIONES CRÍTICAS AUTOMÁTICAS (H8)
  // ============================================================

  test('H8.1: get_notificaciones_criticas_no_leidas_seguro recupera cancelaciones y cambios de agenda no leídos', async () => {
    await setAuthContext(participantUser1);

    const res = await db.query<{ get_notificaciones_criticas_no_leidas_seguro: any }>(`
      SELECT public.get_notificaciones_criticas_no_leidas_seguro();
    `);
    const data = res.rows[0].get_notificaciones_criticas_no_leidas_seguro;
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.data));
    assert.ok(data.data.length >= 2);

    // Verificar que solo contiene avisos con read_at IS NULL
    const allUnread = data.data.every((n: any) => n.read_at === null && n.is_read === false);
    assert.equal(allUnread, true);
  });

  test('H8.2: Sincronización multi-dispositivo - al marcar como leída desaparece de las críticas', async () => {
    await setAuthContext(participantUser1);

    // Obtener las críticas no leídas actuales
    const resBefore = await db.query<{ get_notificaciones_criticas_no_leidas_seguro: any }>(`
      SELECT public.get_notificaciones_criticas_no_leidas_seguro();
    `);
    const listBefore = resBefore.rows[0].get_notificaciones_criticas_no_leidas_seguro.data;
    const firstNotifId = listBefore[0].id;

    // Simular que el usuario reconoció la primera notificación en Dispositivo B
    await db.query(`
      SELECT public.marcar_notificacion_leida_seguro('${firstNotifId}');
    `);

    // En Dispositivo A, la consulta ahora NO debe devolver esa notificación
    const resAfter = await db.query<{ get_notificaciones_criticas_no_leidas_seguro: any }>(`
      SELECT public.get_notificaciones_criticas_no_leidas_seguro();
    `);
    const listAfter = resAfter.rows[0].get_notificaciones_criticas_no_leidas_seguro.data;
    const stillPresent = listAfter.some((n: any) => n.id === firstNotifId);
    assert.equal(stillPresent, false);
  });
});
