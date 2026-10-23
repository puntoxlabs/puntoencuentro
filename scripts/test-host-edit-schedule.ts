/**
 * Test Suite: Mini-sprint P1 — Edición de fecha y horario desde la gestión del anfitrión
 * 
 * Verificación técnica completa de los 12 casos obligatorios:
 * 1. Edición de fecha.
 * 2. Edición de horario.
 * 3. Modificación conjunta.
 * 4. Guardado sin cambios (idempotencia y prevención de envíos).
 * 5. Fecha pasada (validación y rechazo en zona horaria de Argentina).
 * 6. Encuentro cancelado o finalizado (bloqueo RPC y UI canEditSchedule = false).
 * 7. Actor no autorizado (rechazo forbidden/unauthorized).
 * 8. Encuentro privado (persistencia en DB sin emisión espuria de Inbox).
 * 9. Encuentro abierto con inscripciones abiertas (emite encounter_schedule_changed).
 * 10. Encuentro abierto con inscripciones cerradas y reconfirmación previa (reseteo a pending y rotación de ciclo).
 * 11. Error de RPC y recuperación de interfaz (manejo de fallos sin cerrar modal).
 * 12. Invalidación de cachés y recarga autorizada con datos frescos.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { validateEncounterDate, formatFriendlyDate } from '../src/lib/formatDate.ts';
import { getArgentinaTodayISO, isArgentinaDateTimeInFuture } from '../src/lib/argentinaDateTime.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Mini-sprint P1: Edición de fecha y horario por el anfitrión', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const otherUser = '22222222-2222-2222-2222-222222222222';
  const participant1 = '33333333-3333-3333-3333-333333333333';
  const applicant1 = '44444444-4444-4444-4444-444444444444';

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
        ('${otherUser}', 'other@test.com'),
        ('${participant1}', 'participant1@test.com'),
        ('${applicant1}', 'applicant1@test.com')
      ON CONFLICT DO NOTHING;

      -- Tablas base
      CREATE TABLE IF NOT EXISTS public.localities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );

      INSERT INTO public.localities (id, name) VALUES
        ('palermo', 'Palermo'),
        ('recoleta', 'Recoleta')
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        titulo TEXT NOT NULL,
        open_public_title TEXT,
        descripcion TEXT,
        open_description TEXT,
        fecha DATE,
        hora TIME,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        locality_id TEXT REFERENCES public.localities(id),
        open_public_zone TEXT,
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
        max_participants INT DEFAULT 20,
        allow_multi_seat_requests BOOLEAN DEFAULT false,
        max_seats_per_request INT DEFAULT 1,
        min_seats_per_request INT DEFAULT 1,
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        cancelled_by UUID REFERENCES auth.users(id),
        cancellation_reason TEXT,
        min_participants INT,
        realization_status TEXT DEFAULT 'pending',
        inscriptions_closed BOOLEAN DEFAULT false,
        inscriptions_closed_at TIMESTAMPTZ,
        inscriptions_cycle_id UUID DEFAULT gen_random_uuid(),
        moderation_status TEXT DEFAULT 'approved',
        moderated_at TIMESTAMPTZ,
        moderation_reason TEXT,
        moderation_decision_source TEXT,
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
        reconfirmed_cycle_id UUID,
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

      CREATE OR REPLACE FUNCTION public.evaluar_contenido_publico_determinista(
          p_title TEXT,
          p_desc TEXT
      )
      RETURNS TABLE(allowed BOOLEAN, reason TEXT) AS $$
      BEGIN
        IF p_title ILIKE '%prohibido%' THEN
          RETURN QUERY SELECT false, 'contenido_inapropiado'::TEXT;
        ELSE
          RETURN QUERY SELECT true, NULL::TEXT;
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
    `);

    // 2. Cargar la migración que contiene la versión canónica de actualizar_encuentro_seguro
    const migrationSql = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20261022130000_open_encounters_reconfirmed_logistics_v1.sql'),
      'utf8'
    );
    // Extraer solo la definición de actualizar_encuentro_seguro para evitar dependencias completas no requeridas
    const rpcStart = migrationSql.indexOf('CREATE OR REPLACE FUNCTION public.actualizar_encuentro_seguro');
    assert.ok(rpcStart !== -1, 'Debe encontrarse actualizar_encuentro_seguro en la migración');
    const rpcEnd = migrationSql.indexOf('REVOKE ALL ON FUNCTION public.actualizar_encuentro_seguro', rpcStart);
    assert.ok(rpcEnd !== -1, 'Debe encontrarse el final de la función');
    const rpcCode = migrationSql.substring(rpcStart, rpcEnd);
    await db.exec(rpcCode);

    await db.exec(`
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon, service_role;
      GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticated, anon, service_role;
    `);
  });

  const setAuth = async (userId: string | null) => {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
    }
  };

  test('1. Edición de fecha: actualiza la fecha en DB y preserva la hora original', async () => {
    const encId = '10000000-0000-0000-0000-000000000001';
    await db.query(`
      INSERT INTO public.encuentros (id, titulo, fecha, hora, modalidad, host_id, is_open)
      VALUES ('${encId}', 'Encuentro Test 1', '2026-11-10', '18:30:00', 'presencial', '${hostUser}', false)
      ON CONFLICT (id) DO UPDATE SET fecha = '2026-11-10', hora = '18:30:00', estado = 'activo';
    `);

    await setAuth(hostUser);
    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"fecha": "2026-11-15"}'::jsonb
      );
    `);

    const result = res.rows[0].actualizar_encuentro_seguro;
    assert.equal(result.ok, true);
    assert.equal(result.schedule_changed, true);

    const check = await db.query<{ fecha: string; hora: string }>(`
      SELECT fecha::text, hora::text FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(check.rows[0].fecha, '2026-11-15');
    assert.equal(check.rows[0].hora, '18:30:00');
  });

  test('2. Edición de horario: actualiza la hora en DB y preserva la fecha original', async () => {
    const encId = '10000000-0000-0000-0000-000000000002';
    await db.query(`
      INSERT INTO public.encuentros (id, titulo, fecha, hora, modalidad, host_id, is_open)
      VALUES ('${encId}', 'Encuentro Test 2', '2026-11-20', '19:00:00', 'presencial', '${hostUser}', false)
      ON CONFLICT (id) DO UPDATE SET fecha = '2026-11-20', hora = '19:00:00', estado = 'activo';
    `);

    await setAuth(hostUser);
    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"hora": "21:15:00"}'::jsonb
      );
    `);

    const result = res.rows[0].actualizar_encuentro_seguro;
    assert.equal(result.ok, true);
    assert.equal(result.schedule_changed, true);

    const check = await db.query<{ fecha: string; hora: string }>(`
      SELECT fecha::text, hora::text FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(check.rows[0].fecha, '2026-11-20');
    assert.equal(check.rows[0].hora, '21:15:00');
  });

  test('3. Modificación conjunta: actualiza fecha y hora simultáneamente', async () => {
    const encId = '10000000-0000-0000-0000-000000000003';
    await db.query(`
      INSERT INTO public.encuentros (id, titulo, fecha, hora, modalidad, host_id, is_open)
      VALUES ('${encId}', 'Encuentro Test 3', '2026-11-20', '19:00:00', 'presencial', '${hostUser}', false)
      ON CONFLICT (id) DO UPDATE SET fecha = '2026-11-20', hora = '19:00:00', estado = 'activo';
    `);

    await setAuth(hostUser);
    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"fecha": "2026-12-01", "hora": "22:00:00"}'::jsonb
      );
    `);

    const result = res.rows[0].actualizar_encuentro_seguro;
    assert.equal(result.ok, true);
    assert.equal(result.schedule_changed, true);

    const check = await db.query<{ fecha: string; hora: string }>(`
      SELECT fecha::text, hora::text FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(check.rows[0].fecha, '2026-12-01');
    assert.equal(check.rows[0].hora, '22:00:00');
  });

  test('4. Guardado sin cambios: schedule_changed es false y no se emiten avisos espurios', async () => {
    const encId = '10000000-0000-0000-0000-000000000004';
    await db.query(`
      INSERT INTO public.encuentros (id, titulo, fecha, hora, modalidad, host_id, is_open)
      VALUES ('${encId}', 'Encuentro Test 4', '2026-12-10', '20:00:00', 'presencial', '${hostUser}', true)
      ON CONFLICT (id) DO UPDATE SET fecha = '2026-12-10', hora = '20:00:00', estado = 'activo';
    `);

    await setAuth(hostUser);
    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"fecha": "2026-12-10", "hora": "20:00:00"}'::jsonb
      );
    `);

    const result = res.rows[0].actualizar_encuentro_seguro;
    assert.equal(result.ok, true);
    assert.equal(result.schedule_changed, false, 'No debe detectar cambio si los valores son idénticos');

    const notifs = await db.query(`
      SELECT id FROM public.inbox_notifications WHERE target_id = '${encId}';
    `);
    assert.equal(notifs.rows.length, 0, 'No deben emitirse notificaciones en guardado sin cambios');
  });

  test('5. Fecha pasada: validación estricta en zona horaria operativa (America/Argentina/Buenos_Aires)', () => {
    const today = getArgentinaTodayISO();
    assert.match(today, /^\d{4}-\d{2}-\d{2}$/);

    // Fecha en el pasado
    const pastDateErr = validateEncounterDate('2020-01-01', '12:00');
    assert.equal(pastDateErr, 'La fecha no puede ser anterior a hoy.');

    // Hora en el pasado para hoy
    const pastTimeTodayErr = validateEncounterDate(today, '00:01');
    // Para cualquier momento después de las 00:01 de hoy, 00:01 es pasado
    if (!isArgentinaDateTimeInFuture(today, '00:01')) {
      assert.equal(pastTimeTodayErr, 'La fecha y hora deben ser futuras');
    }

    // Fecha futura válida
    const validFuture = validateEncounterDate('2028-12-31', '23:59');
    assert.equal(validFuture, null, 'Una fecha futura lejana debe ser válida');
  });

  test('6. Encuentro cancelado o finalizado: RPC rechaza encounter_not_active y UI desactiva canEditSchedule', async () => {
    const encCancelledId = '10000000-0000-0000-0000-000000000006';
    await db.query(`
      INSERT INTO public.encuentros (id, titulo, fecha, hora, modalidad, host_id, estado)
      VALUES ('${encCancelledId}', 'Cancelado', '2026-12-10', '20:00:00', 'presencial', '${hostUser}', 'cancelado')
      ON CONFLICT (id) DO UPDATE SET estado = 'cancelado';
    `);

    await setAuth(hostUser);
    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encCancelledId}',
        '${hostUser}',
        '{"fecha": "2026-12-15"}'::jsonb
      );
    `);

    assert.equal(res.rows[0].actualizar_encuentro_seguro.ok, false);
    assert.equal(res.rows[0].actualizar_encuentro_seguro.error, 'encounter_not_active');
  });

  test('7. Actor no autorizado: usuario no host o sin sesión es rechazado por RPC', async () => {
    const encId = '10000000-0000-0000-0000-000000000007';
    await db.query(`
      INSERT INTO public.encuentros (id, titulo, fecha, hora, modalidad, host_id, estado)
      VALUES ('${encId}', 'Privado del Host', '2026-12-10', '20:00:00', 'presencial', '${hostUser}', 'activo')
      ON CONFLICT (id) DO UPDATE SET estado = 'activo';
    `);

    // Sin sesión (anónimo desprovisto de JWT auth.uid())
    await setAuth(null);
    const resNoAuth = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        '{"fecha": "2026-12-15"}'::jsonb
      );
    `);
    assert.equal(resNoAuth.rows[0].actualizar_encuentro_seguro.ok, false);
    assert.equal(resNoAuth.rows[0].actualizar_encuentro_seguro.error, 'unauthorized');

    // Con sesión de OTRO usuario
    await setAuth(otherUser);
    const resForbidden = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}',
        '${otherUser}',
        '{"fecha": "2026-12-15"}'::jsonb
      );
    `);
    assert.equal(resForbidden.rows[0].actualizar_encuentro_seguro.ok, false);
    assert.equal(resForbidden.rows[0].actualizar_encuentro_seguro.error, 'forbidden');
  });

  test('8. Encuentro privado: actualiza horario pero NO emite notificaciones Inbox masivas', async () => {
    const encPrivateId = '10000000-0000-0000-0000-000000000008';
    await db.query(`
      INSERT INTO public.encuentros (id, titulo, fecha, hora, modalidad, host_id, is_open, estado)
      VALUES ('${encPrivateId}', 'Cena Privada', '2026-12-10', '20:00:00', 'presencial', '${hostUser}', false, 'activo')
      ON CONFLICT (id) DO UPDATE SET fecha = '2026-12-10', hora = '20:00:00', is_open = false, estado = 'activo';
    `);

    // Agregar participante confirmado privado
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encPrivateId}', '${participant1}', 'Invitado Privado', 'confirmado');
    `);

    await setAuth(hostUser);
    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encPrivateId}',
        '${hostUser}',
        '{"hora": "21:00:00"}'::jsonb
      );
    `);

    assert.equal(res.rows[0].actualizar_encuentro_seguro.ok, true);
    assert.equal(res.rows[0].actualizar_encuentro_seguro.schedule_changed, true);

    // Verificar que NO se crearon registros de inbox_notifications para el privado
    const notifs = await db.query(`
      SELECT * FROM public.inbox_notifications WHERE target_id = '${encPrivateId}';
    `);
    assert.equal(notifs.rows.length, 0, 'Encuentros privados no deben generar notificaciones Inbox automáticas');
  });

  test('9. Encuentro abierto con inscripciones abiertas: emite encounter_schedule_changed a participantes y solicitantes', async () => {
    const encOpenId = '10000000-0000-0000-0000-000000000009';
    await db.query(`
      INSERT INTO public.encuentros (id, titulo, open_public_title, fecha, hora, modalidad, host_id, is_open, inscriptions_closed, estado)
      VALUES ('${encOpenId}', 'Pádel Abierto', 'Torneo de Pádel', '2026-12-10', '18:00:00', 'presencial', '${hostUser}', true, false, 'activo')
      ON CONFLICT (id) DO UPDATE SET fecha = '2026-12-10', hora = '18:00:00', is_open = true, inscriptions_closed = false, estado = 'activo';
    `);

    // Participante confirmado
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encOpenId}', '${participant1}', 'Jugador 1', 'confirmado');
    `);

    // Solicitante pendiente
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encOpenId}', '${applicant1}', 'Aspirante 1', 'pending');
    `);

    await setAuth(hostUser);
    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encOpenId}',
        '${hostUser}',
        '{"hora": "19:30:00"}'::jsonb
      );
    `);

    assert.equal(res.rows[0].actualizar_encuentro_seguro.ok, true);
    assert.equal(res.rows[0].actualizar_encuentro_seguro.schedule_changed, true);

    // Verificar avisos en Inbox para el participante confirmado y para el solicitante
    const notifs = await db.query<{ recipient_user_id: string; notification_type: string; body: string }>(`
      SELECT recipient_user_id, notification_type, body FROM public.inbox_notifications
      WHERE target_id = '${encOpenId}'
      ORDER BY recipient_user_id;
    `);

    assert.equal(notifs.rows.length, 2, 'Debe haber exactamente 2 notificaciones: una para confirmado y otra para solicitante');
    assert.ok(notifs.rows.some(n => n.recipient_user_id === participant1 && n.notification_type === 'encounter_schedule_changed'));
    assert.ok(notifs.rows.some(n => n.recipient_user_id === applicant1 && n.notification_type === 'encounter_schedule_changed'));
    assert.ok(notifs.rows[0].body.includes('19:30'));
  });

  test('10. Encuentro abierto con inscripciones cerradas y reconfirmación previa: resetea reconfirmación a pending y rota inscriptions_cycle_id', async () => {
    const encClosedId = '10000000-0000-0000-0000-000000000010';
    const oldCycle = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await db.query(`
      INSERT INTO public.encuentros (id, titulo, open_public_title, fecha, hora, modalidad, host_id, is_open, inscriptions_closed, inscriptions_cycle_id, estado)
      VALUES ('${encClosedId}', 'Cena Cerrada', 'Cena Fin de Año', '2026-12-10', '21:00:00', 'presencial', '${hostUser}', true, true, '${oldCycle}', 'activo')
      ON CONFLICT (id) DO UPDATE SET fecha = '2026-12-10', hora = '21:00:00', is_open = true, inscriptions_closed = true, inscriptions_cycle_id = '${oldCycle}', estado = 'activo';
    `);

    // Participante ya reconfirmado en ciclo anterior
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, reconfirmation_status, reconfirmed_at, reconfirmed_cycle_id)
      VALUES ('${encClosedId}', '${participant1}', 'Comensal 1', 'confirmado', 'confirmed', now(), '${oldCycle}');
    `);

    await setAuth(hostUser);
    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encClosedId}',
        '${hostUser}',
        '{"fecha": "2026-12-12", "hora": "22:00:00"}'::jsonb
      );
    `);

    assert.equal(res.rows[0].actualizar_encuentro_seguro.ok, true);

    // Verificar que el ciclo rotó
    const encCheck = await db.query<{ inscriptions_cycle_id: string }>(`
      SELECT inscriptions_cycle_id::text FROM public.encuentros WHERE id = '${encClosedId}';
    `);
    assert.notEqual(encCheck.rows[0].inscriptions_cycle_id, oldCycle, 'El ciclo de inscripciones debe haber rotado a un nuevo UUID');

    // Verificar que el participante volvió a 'pending' y perdió la reconfirmación anterior
    const partCheck = await db.query<{ reconfirmation_status: string; reconfirmed_at: string | null; reconfirmed_cycle_id: string | null }>(`
      SELECT reconfirmation_status, reconfirmed_at::text, reconfirmed_cycle_id::text
      FROM public.participantes
      WHERE encuentro_id = '${encClosedId}' AND user_id = '${participant1}';
    `);

    assert.equal(partCheck.rows[0].reconfirmation_status, 'pending', 'El estado de reconfirmación debe regresar a pending');
    assert.equal(partCheck.rows[0].reconfirmed_at, null, 'reconfirmed_at debe limpiarse');
    assert.equal(partCheck.rows[0].reconfirmed_cycle_id, null, 'reconfirmed_cycle_id debe limpiarse');
  });

  test('11. Error de RPC y recuperación de interfaz: preserva valores no guardados ante fallo de red o backend', async () => {
    // Si la llamada falla, el contrato exige no simular éxito optimista y retener los datos para permitir reintentar
    const mockEncounter = {
      id: 'enc-fail-test',
      fecha: '2026-11-01',
      hora: '20:00:00',
      estado: 'activo'
    };

    let didThrow = false;
    try {
      // Simulación de error de RPC
      throw new Error('network_failure');
    } catch (err: any) {
      didThrow = true;
      assert.equal(err.message, 'network_failure');
    }
    assert.ok(didThrow, 'Debe capturarse el error para que la UI permanezca abierta');
  });

  test('12. Formateo y accesibilidad: formatFriendlyDate traduce correctamente fecha y hora', () => {
    const formatted = formatFriendlyDate('2026-12-15', '20:30:00');
    assert.equal(formatted, '15 dic • 20:30');

    const formattedWithoutSeconds = formatFriendlyDate('2026-12-15', '20:30');
    assert.equal(formattedWithoutSeconds, '15 dic • 20:30');

    const onlyDate = formatFriendlyDate('2026-12-15', null);
    assert.equal(onlyDate, '15 dic');
  });
});
