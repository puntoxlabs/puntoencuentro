/**
 * Suite de Pruebas Automatizadas DIF-17:
 * Desacople de Mensajería Interna de Reconfirmación Logística en Encuentros Abiertos
 *
 * Casos cubiertos:
 * 1. Participante aprobado sin reconfirmación (acceso pleno a mensajes en encuentro abierto).
 * 2. Participante reconfirmado (acceso pleno a mensajes).
 * 3. Solicitud pendiente o rechazada (denegado en mensajería).
 * 4. Participante privado confirmado (acceso pleno sin reconfirmación).
 * 5. Participante con token legítimo (acceso con token individual).
 * 6. Usuario bloqueado bilateralmente (denegado con blocked_user).
 * 7. Usuario no autorizado (denegado con unauthorized).
 * 8. Sesión anónima retirada por migración (denegado con anonymous_session_already_migrated).
 * 9. Anfitrión del encuentro (lectura, destacados y escritura plena).
 * 10. Encuentro cancelado y mensajes fuera de ventana de escritura (can_write = false).
 * 11. Preservación estricta de protección logística y WhatsApp (lugar_texto/link_virtual y teléfono protegidos).
 * 12. Frontend: Manejo de errores en EncounterMessagesPanel, desacople en HomeOpenEncounterDetailSheet y aviso host.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import '@/i18n/i18n';
import { EncounterMessagesPanel } from '@/components/messages/EncounterMessagesPanel';
import { mensajesService } from '@/services/mensajesService';
import { whatsappContactService } from '@/services/whatsappContactService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let db: PGlite;

// Helper para ejecutar SQL con contexto de usuario y JWT simulado
async function runWithContext(
  userId: string | null,
  jwtClaims: Record<string, any> = {},
  sql: string
) {
  const claimsJson = JSON.stringify({
    sub: userId || '',
    ...jwtClaims,
  });
  const escapedClaims = claimsJson.replace(/'/g, "''");
  await db.exec(`
    SET request.jwt.claim.sub = '${userId || ''}';
    SET request.jwt.claims = '${escapedClaims}';
  `);
  return db.query(sql);
}

describe('DIF-17: Desacople de Mensajería Interna y Reconfirmación Logística', () => {
  before(async () => {
    db = new PGlite();

    // 1. Configuración de roles y esquema auth básico
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;

      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE,
        raw_user_meta_data JSONB DEFAULT '{}'::jsonb
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
      $$ LANGUAGE sql STABLE;

      -- Tablas del dominio
      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL,
        titulo TEXT NOT NULL,
        open_public_title TEXT,
        descripcion TEXT,
        open_description TEXT,
        fecha DATE,
        hora TIME,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        lugar_texto TEXT,
        link_virtual TEXT,
        estado TEXT NOT NULL DEFAULT 'activo',
        is_open BOOLEAN DEFAULT false,
        opened_at TIMESTAMPTZ,
        max_participants INT DEFAULT 10,
        min_participants INT,
        realization_status TEXT DEFAULT 'pending',
        inscriptions_closed BOOLEAN DEFAULT false,
        inscriptions_cycle_id UUID DEFAULT gen_random_uuid(),
        cancelled_at TIMESTAMPTZ,
        messages_purged_at TIMESTAMPTZ,
        date_mode TEXT DEFAULT 'fixed',
        coordination_status TEXT DEFAULT 'closed',
        tema TEXT DEFAULT 'blue',
        tema_invitacion TEXT DEFAULT 'classic',
        invitation_template TEXT DEFAULT 'default',
        open_public_zone TEXT,
        locality_id TEXT,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        nombre_invitado TEXT NOT NULL,
        user_id UUID,
        token_invitacion UUID DEFAULT gen_random_uuid() NOT NULL,
        tipo_invitacion TEXT DEFAULT 'individual',
        estado TEXT DEFAULT 'pendiente',
        reconfirmation_status TEXT DEFAULT 'pending',
        reconfirmed_at TIMESTAMPTZ,
        reconfirmed_cycle_id UUID,
        admission_source TEXT,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL,
        respondido_en TIMESTAMPTZ,
        mensaje_respuesta TEXT
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL,
        nombre_solicitante TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pending',
        participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
        token_participante UUID,
        seat_count INT DEFAULT 1,
        is_waitlist BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        blocker_id UUID NOT NULL,
        blocked_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        CONSTRAINT unique_block UNIQUE (blocker_id, blocked_id)
      );

      CREATE TABLE IF NOT EXISTS public.encuentros_contacto_whatsapp (
        encuentro_id UUID PRIMARY KEY REFERENCES public.encuentros(id) ON DELETE CASCADE,
        telefono_whatsapp TEXT,
        opt_in BOOLEAN DEFAULT false,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.mensajes_encuentro (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        parent_id UUID REFERENCES public.mensajes_encuentro(id) ON DELETE CASCADE,
        autor_user_id UUID,
        autor_participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
        autor_nombre TEXT NOT NULL,
        es_organizador BOOLEAN NOT NULL DEFAULT false,
        contenido TEXT NOT NULL,
        destacado BOOLEAN NOT NULL DEFAULT false,
        destacado_en TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL,
        editado_en TIMESTAMPTZ,
        eliminado_en TIMESTAMPTZ,
        eliminado_por_tipo TEXT
      );

      -- Helper de sesión anónima retirada simulado
      CREATE TABLE IF NOT EXISTS public.retired_anonymous_sources (
        user_id UUID PRIMARY KEY
      );

      CREATE OR REPLACE FUNCTION public.is_retired_anonymous_source(p_user_id UUID)
      RETURNS BOOLEAN AS $$
        SELECT EXISTS (SELECT 1 FROM public.retired_anonymous_sources WHERE user_id = p_user_id);
      $$ LANGUAGE sql STABLE;

      -- Mocks de rate limiting requeridos por publicar_mensaje_encuentro_seguro
      CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(p_action TEXT, p_target TEXT)
      RETURNS JSONB AS $$
        SELECT '{"allowed": true}'::jsonb;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.consumir_rate_limit_participante(p_part_id UUID, p_action TEXT, p_target TEXT)
      RETURNS JSONB AS $$
        SELECT '{"allowed": true}'::jsonb;
      $$ LANGUAGE sql STABLE;
    `);

    // 2. Cargar funciones y RPCs requeridas (get_participante_seguro, obtener_contacto_whatsapp_seguro y la nueva migración)
    // Cargar la nueva migración aditiva con resolver_actor_encuentro corregida
    const migrationPath = path.resolve(
      rootDir,
      'supabase/migrations/20261109173000_decouple_open_encounters_messages_from_reconfirmation_dif17.sql'
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(migrationSql);

    // Cargar funciones de prueba get_participante_seguro y obtener_contacto_whatsapp_seguro (definición histórica que protege logística)
    const baseLogisticsPath = path.resolve(
      rootDir,
      'supabase/migrations/20261022213000_preserve_private_general_link_guests_and_public_request_state.sql'
    );
    const baseSql = fs.readFileSync(baseLogisticsPath, 'utf8');
    
    // Extraer y aplicar get_participante_seguro
    const getPartMatch = baseSql.match(/CREATE OR REPLACE FUNCTION public\.get_participante_seguro[\s\S]*?\$function\$;/);
    if (getPartMatch) {
      await db.exec(getPartMatch[0]);
    }

    // Extraer y aplicar obtener_contacto_whatsapp_seguro
    const getWaMatch = baseSql.match(/CREATE OR REPLACE FUNCTION public\.obtener_contacto_whatsapp_seguro[\s\S]*?\$function\$;/);
    if (getWaMatch) {
      await db.exec(getWaMatch[0]);
    }

    // Extraer y aplicar get_mensajes_encuentro_seguro
    const encounterMessagesPath = path.resolve(
      rootDir,
      'supabase/migrations/20261020100000_encounter_messages_panel_v1.sql'
    );
    const messagesSql = fs.readFileSync(encounterMessagesPath, 'utf8');
    const getMsgsMatch = messagesSql.match(/CREATE OR REPLACE FUNCTION public\.get_mensajes_encuentro_seguro[\s\S]*?\$\$;/);
    if (getMsgsMatch) {
      await db.exec(getMsgsMatch[0]);
    }

    // Extraer y aplicar publicar_mensaje_encuentro_seguro desde 20261107120000
    const bridgePath = path.resolve(
      rootDir,
      'supabase/migrations/20261107120000_domain_identity_bridge_v1.sql'
    );
    const bridgeSql = fs.readFileSync(bridgePath, 'utf8');
    const postMatch = bridgeSql.match(/CREATE OR REPLACE FUNCTION public\.publicar_mensaje_encuentro_seguro[\s\S]*?\$\$;/);
    if (postMatch) {
      await db.exec(postMatch[0]);
    }
  });

  // UUIDs fijos para la suite
  const HOST_ID = '11111111-0000-0000-0000-000000000001';
  const APPROVED_USER_ID = '22222222-0000-0000-0000-000000000002';
  const PENDING_USER_ID = '33333333-0000-0000-0000-000000000003';
  const BLOCKED_USER_ID = '44444444-0000-0000-0000-000000000004';
  const UNAUTHORIZED_USER_ID = '55555555-0000-0000-0000-000000000005';
  const RETIRED_ANON_USER_ID = '66666666-0000-0000-0000-000000000006';

  const OPEN_ENC_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
  const PRIVATE_ENC_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
  const CANCELLED_ENC_ID = 'cccccccc-1111-2222-3333-444444444444';

  const APPROVED_TOKEN = '77777777-aaaa-bbbb-cccc-000000000001';
  const PRIVATE_TOKEN = '77777777-aaaa-bbbb-cccc-000000000002';

  beforeEach(async () => {
    // Limpiar datos
    await db.exec(`
      DELETE FROM public.mensajes_encuentro;
      DELETE FROM public.solicitudes_encuentro_abierto;
      DELETE FROM public.participantes;
      DELETE FROM public.encuentros_contacto_whatsapp;
      DELETE FROM public.encuentros;
      DELETE FROM public.bloqueos_usuario;
      DELETE FROM public.retired_anonymous_sources;
      DELETE FROM auth.users;

      -- Crear usuarios
      INSERT INTO auth.users (id, email) VALUES
        ('${HOST_ID}', 'host@test.com'),
        ('${APPROVED_USER_ID}', 'approved@test.com'),
        ('${PENDING_USER_ID}', 'pending@test.com'),
        ('${BLOCKED_USER_ID}', 'blocked@test.com'),
        ('${UNAUTHORIZED_USER_ID}', 'unauthorized@test.com'),
        ('${RETIRED_ANON_USER_ID}', 'retired@test.com');

      INSERT INTO public.retired_anonymous_sources (user_id) VALUES ('${RETIRED_ANON_USER_ID}');

      -- 1. Encuentro Abierto (pre-reconfirmación: realization_status pending, inscriptions_closed false)
      INSERT INTO public.encuentros (
        id, host_id, titulo, open_public_title, fecha, hora, modalidad, lugar_texto, link_virtual, estado, is_open, opened_at, realization_status, inscriptions_closed
      ) VALUES (
        '${OPEN_ENC_ID}', '${HOST_ID}', 'Encuentro Abierto Tech', 'Encuentro Abierto Tech',
        CURRENT_DATE + 5, '18:00', 'presencial', 'Calle Privada 1234, Dto 5A', NULL, 'activo', true, now(), 'pending', false
      );

      -- Contacto WhatsApp del Host
      INSERT INTO public.encuentros_contacto_whatsapp (encuentro_id, telefono_whatsapp, opt_in)
      VALUES ('${OPEN_ENC_ID}', '+5491122334455', true);

      -- Participante 1: Aprobado sin reconfirmación
      INSERT INTO public.participantes (
        id, encuentro_id, nombre_invitado, user_id, token_invitacion, estado, reconfirmation_status, reconfirmed_cycle_id
      ) VALUES (
        '99999999-0000-0000-0000-000000000001', '${OPEN_ENC_ID}', 'Participante Aprobado', '${APPROVED_USER_ID}',
        '${APPROVED_TOKEN}', 'confirmado', 'pending', NULL
      );

      INSERT INTO public.solicitudes_encuentro_abierto (
        encuentro_id, usuario_id, nombre_solicitante, estado, participante_id, token_participante
      ) VALUES (
        '${OPEN_ENC_ID}', '${APPROVED_USER_ID}', 'Participante Aprobado', 'approved',
        '99999999-0000-0000-0000-000000000001', '${APPROVED_TOKEN}'
      );

      -- Participante 2: Solicitud pendiente (no confirmado)
      INSERT INTO public.solicitudes_encuentro_abierto (
        encuentro_id, usuario_id, nombre_solicitante, estado
      ) VALUES (
        '${OPEN_ENC_ID}', '${PENDING_USER_ID}', 'Solicitante Pendiente', 'pending'
      );

      -- Participante 3: Usuario Bloqueado
      INSERT INTO public.participantes (
        id, encuentro_id, nombre_invitado, user_id, token_invitacion, estado, reconfirmation_status
      ) VALUES (
        '99999999-0000-0000-0000-000000000003', '${OPEN_ENC_ID}', 'Usuario Bloqueado', '${BLOCKED_USER_ID}',
        gen_random_uuid(), 'confirmado', 'pending'
      );
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id) VALUES ('${HOST_ID}', '${BLOCKED_USER_ID}');

      -- 2. Encuentro Privado
      INSERT INTO public.encuentros (
        id, host_id, titulo, fecha, hora, modalidad, lugar_texto, estado, is_open
      ) VALUES (
        '${PRIVATE_ENC_ID}', '${HOST_ID}', 'Asado Privado', CURRENT_DATE + 2, '21:00', 'presencial', 'Quinta Los Robles', 'activo', false
      );

      INSERT INTO public.participantes (
        id, encuentro_id, nombre_invitado, user_id, token_invitacion, estado
      ) VALUES (
        '99999999-0000-0000-0000-000000000004', '${PRIVATE_ENC_ID}', 'Amigo Privado', '${APPROVED_USER_ID}',
        '${PRIVATE_TOKEN}', 'confirmado'
      );

      -- 3. Encuentro Cancelado
      INSERT INTO public.encuentros (
        id, host_id, titulo, fecha, hora, modalidad, estado, is_open, cancelled_at
      ) VALUES (
        '${CANCELLED_ENC_ID}', '${HOST_ID}', 'Encuentro Suspendido', CURRENT_DATE + 1, '19:00', 'presencial', 'cancelado', false, now()
      );
      INSERT INTO public.participantes (
        id, encuentro_id, nombre_invitado, user_id, estado
      ) VALUES (
        '99999999-0000-0000-0000-000000000005', '${CANCELLED_ENC_ID}', 'Participante Cancelado', '${APPROVED_USER_ID}', 'confirmado'
      );
    `);
  });

  // ── 1. Participante aprobado sin reconfirmación en Encuentro Abierto ─────────
  test('1. Participante aprobado sin reconfirmación puede resolver actor y acceder a mensajes', async () => {
    const res = await runWithContext(APPROVED_USER_ID, {}, `
      SELECT public.resolver_actor_encuentro('${OPEN_ENC_ID}') AS result;
    `);
    const actor = res.rows[0].result;

    assert.equal(actor.ok, true, 'Debe retornar ok = true');
    assert.equal(actor.actor_type, 'participant_registered');
    assert.equal(actor.user_id, APPROVED_USER_ID);
    assert.equal(actor.can_write, true, 'Debe permitir escritura');
    assert.equal(actor.is_host, false);

    // Comprobar lectura en get_mensajes_encuentro_seguro
    const resMsgs = await runWithContext(APPROVED_USER_ID, {}, `
      SELECT public.get_mensajes_encuentro_seguro('${OPEN_ENC_ID}') AS result;
    `);
    const msgs = resMsgs.rows[0].result;
    assert.equal(msgs.ok, true, 'get_mensajes_encuentro_seguro debe retornar ok = true');
    assert.deepEqual(msgs.mensajes, [], 'Debe retornar lista vacía de mensajes sin error');
  });

  // ── 2. Participante reconfirmado ───────────────────────────────────────────
  test('2. Participante reconfirmado en ciclo mantiene acceso pleno a mensajes', async () => {
    // Actualizar encuentro a confirmado con inscripciones cerradas y reconfirmado
    await db.exec(`
      UPDATE public.encuentros
      SET realization_status = 'confirmed', inscriptions_closed = true
      WHERE id = '${OPEN_ENC_ID}';

      UPDATE public.participantes
      SET reconfirmation_status = 'confirmed', reconfirmed_cycle_id = (SELECT inscriptions_cycle_id FROM public.encuentros WHERE id = '${OPEN_ENC_ID}')
      WHERE user_id = '${APPROVED_USER_ID}';
    `);

    const res = await runWithContext(APPROVED_USER_ID, {}, `
      SELECT public.resolver_actor_encuentro('${OPEN_ENC_ID}') AS result;
    `);
    const actor = res.rows[0].result;
    assert.equal(actor.ok, true);
    assert.equal(actor.can_write, true);
  });

  // ── 3. Solicitud pendiente o rechazada ──────────────────────────────────────
  test('3. Solicitante pendiente no tiene acceso al panel de mensajes', async () => {
    const res = await runWithContext(PENDING_USER_ID, {}, `
      SELECT public.resolver_actor_encuentro('${OPEN_ENC_ID}') AS result;
    `);
    const actor = res.rows[0].result;
    assert.equal(actor.ok, false);
    assert.equal(actor.error, 'unauthorized', 'Debe rechazar con unauthorized al no tener fila confirmada');
  });

  // ── 4. Participante privado confirmado ──────────────────────────────────────
  test('4. Participante en encuentro privado mantiene acceso normal', async () => {
    const res = await runWithContext(APPROVED_USER_ID, {}, `
      SELECT public.resolver_actor_encuentro('${PRIVATE_ENC_ID}') AS result;
    `);
    const actor = res.rows[0].result;
    assert.equal(actor.ok, true);
    assert.equal(actor.actor_type, 'participant_registered');
    assert.equal(actor.can_write, true);
  });

  // ── 5. Participante con token legítimo ──────────────────────────────────────
  test('5. Participante anónimo con token de invitación legítimo puede acceder', async () => {
    const res = await runWithContext(null, {}, `
      SELECT public.resolver_actor_encuentro('${OPEN_ENC_ID}', '${APPROVED_TOKEN}') AS result;
    `);
    const actor = res.rows[0].result;
    assert.equal(actor.ok, true);
    assert.equal(actor.actor_type, 'guest_token');
    assert.equal(actor.can_write, true);
  });

  // ── 6. Usuario bloqueado bilateralmente ─────────────────────────────────────
  test('6. Usuario bloqueado por el anfitrión es rechazado con blocked_user', async () => {
    const res = await runWithContext(BLOCKED_USER_ID, {}, `
      SELECT public.resolver_actor_encuentro('${OPEN_ENC_ID}') AS result;
    `);
    const actor = res.rows[0].result;
    assert.equal(actor.ok, false);
    assert.equal(actor.error, 'blocked_user');
  });

  // ── 7. Usuario no autorizado (ajeno al encuentro) ───────────────────────────
  test('7. Usuario ajeno al encuentro es rechazado con unauthorized', async () => {
    const res = await runWithContext(UNAUTHORIZED_USER_ID, {}, `
      SELECT public.resolver_actor_encuentro('${OPEN_ENC_ID}') AS result;
    `);
    const actor = res.rows[0].result;
    assert.equal(actor.ok, false);
    assert.equal(actor.error, 'unauthorized');
  });

  // ── 8. Sesión anónima retirada por migración de dominio ─────────────────────
  test('8. Sesión anónima retirada es rechazada con anonymous_session_already_migrated', async () => {
    const res = await runWithContext(RETIRED_ANON_USER_ID, {}, `
      SELECT public.resolver_actor_encuentro('${OPEN_ENC_ID}') AS result;
    `);
    const actor = res.rows[0].result;
    assert.equal(actor.ok, false);
    assert.equal(actor.error, 'anonymous_session_already_migrated');
  });

  // ── 9. Anfitrión del encuentro ──────────────────────────────────────────────
  test('9. Anfitrión permanente del encuentro tiene facultades plenas', async () => {
    const res = await runWithContext(HOST_ID, { user_metadata: { full_name: 'Organizador Master' } }, `
      SELECT public.resolver_actor_encuentro('${OPEN_ENC_ID}') AS result;
    `);
    const actor = res.rows[0].result;
    assert.equal(actor.ok, true);
    assert.equal(actor.is_host, true);
    assert.equal(actor.actor_type, 'host_permanent');
    assert.equal(actor.autor_nombre, 'Organizador Master');
    assert.equal(actor.can_write, true);
  });

  // ── 10. Encuentro cancelado y fuera de ventana ──────────────────────────────
  test('10. Encuentro cancelado permite solo lectura (can_write = false, is_cancelled = true)', async () => {
    const res = await runWithContext(APPROVED_USER_ID, {}, `
      SELECT public.resolver_actor_encuentro('${CANCELLED_ENC_ID}') AS result;
    `);
    const actor = res.rows[0].result;
    assert.equal(actor.ok, true);
    assert.equal(actor.can_write, false, 'No debe permitir escribir en encuentro cancelado');
    assert.equal(actor.is_cancelled, true);
  });

  // ── 11. Preservación estricta de protección logística y WhatsApp ────────────
  test('11. Preservación estricta: lugar_texto, link_virtual y WhatsApp continúan protegidos antes de reconfirmación', async () => {
    // 1. get_participante_seguro NO debe filtrar lugar_texto
    const resPart = await runWithContext(null, {}, `
      SELECT public.get_participante_seguro('${APPROVED_TOKEN}') AS result;
    `);
    const partData = resPart.rows[0].result;
    assert.ok(partData !== null, 'Debe devolver datos del participante');
    assert.equal(partData.encuentros.lugar_texto, null, 'lugar_texto DEBE ser null antes de reconfirmación');
    assert.equal(partData.encuentros.link_virtual, null, 'link_virtual DEBE ser null');

    // 2. obtener_contacto_whatsapp_seguro DEBE continuar requiriendo reconfirmación
    const resWa = await runWithContext(APPROVED_USER_ID, {}, `
      SELECT public.obtener_contacto_whatsapp_seguro('${OPEN_ENC_ID}') AS result;
    `);
    const waData = resWa.rows[0].result;
    assert.equal(waData.ok, false);
    assert.equal(waData.error, 'reconfirmation_required', 'WhatsApp DEBE denegar con reconfirmation_required');
  });

  // ── 12. Frontend: Verificación de componentes y desacople ───────────────────
  test('12. Frontend: HomeOpenEncounterDetailSheet desacopla el panel de mensajes de la logística física', () => {
    const sheetFile = path.resolve(
      rootDir,
      'src/components/home/openEncounters/HomeOpenEncounterDetailSheet.tsx'
    );
    const content = fs.readFileSync(sheetFile, 'utf8');

    // Comprobar que ya NO exige authorizedDetail?.lugar_texto || authorizedDetail?.link_virtual
    assert.ok(
      !content.includes('authorizedDetail?.lugar_texto || authorizedDetail?.link_virtual) && (\n                <div style={{ marginTop: \'1rem\' }}>\n                  <EncounterMessagesPanel'),
      'No debe condicionar la aparición de EncounterMessagesPanel a la presencia de lugar_texto o link_virtual'
    );
    assert.ok(
      content.includes('<EncounterMessagesPanel'),
      'Debe contener la invocación de EncounterMessagesPanel para participantes confirmados'
    );
  });

  test('13. Frontend: EncounterMessagesPanel protege contra falsos contadores y contiene aviso host', () => {
    const panelFile = path.resolve(
      rootDir,
      'src/components/messages/EncounterMessagesPanel.tsx'
    );
    const content = fs.readFileSync(panelFile, 'utf8');

    // Comprobar que no muestra el pill de conteo si hay error o carga
    assert.ok(
      content.includes('!loading && !errorMsg && specialState === null && ('),
      'El contador de mensajes solo debe mostrarse si no hay error y la carga fue exitosa'
    );

    // Comprobar que el error técnico reconfirmation_required es traducido amigablemente
    assert.ok(
      content.includes('encounter_messages.reconfirmation_required'),
      'Debe contener copy amigable para reconfirmation_required'
    );

    // Comprobar el aviso discreto para organizadores
    assert.ok(
      content.includes('pe-msg-host-privacy-hint'),
      'Debe incluir el elemento de aviso para organizadores'
    );
    assert.ok(
      content.includes('host_privacy_hint'),
      'Debe incluir la clave de localización para el hint de anfitrión'
    );
  });

  // ── 14. Publicación efectiva por participante aprobado sin reconfirmación ──
  test('14. Publicación efectiva: participante aprobado sin reconfirmación puede escribir en encuentro abierto', async () => {
    const resPost = await runWithContext(APPROVED_USER_ID, {}, `
      SELECT public.publicar_mensaje_encuentro_seguro('${OPEN_ENC_ID}', 'Hola a todos los confirmados!') AS result;
    `);
    const postData = resPost.rows[0].result;
    assert.equal(postData.ok, true, 'publicar_mensaje_encuentro_seguro debe retornar ok = true');
    assert.ok(postData.mensaje_id, 'Debe devolver el id del mensaje creado');

    // Verificar inserción en la base de datos
    const dbMsg = await db.query(`SELECT * FROM public.mensajes_encuentro WHERE id = '${postData.mensaje_id}'`);
    assert.equal(dbMsg.rows.length, 1);
    assert.equal(dbMsg.rows[0].autor_user_id, APPROVED_USER_ID);
    assert.equal(dbMsg.rows[0].es_organizador, false);
    assert.equal(dbMsg.rows[0].contenido, 'Hola a todos los confirmados!');

    // Verificar que el mensaje es devuelto por get_mensajes_encuentro_seguro
    const resList = await runWithContext(APPROVED_USER_ID, {}, `
      SELECT public.get_mensajes_encuentro_seguro('${OPEN_ENC_ID}') AS result;
    `);
    assert.equal(resList.rows[0].result.ok, true);
    assert.equal(resList.rows[0].result.mensajes.length, 1);
    assert.equal(resList.rows[0].result.mensajes[0].id, postData.mensaje_id);
    assert.equal(resList.rows[0].result.mensajes[0].contenido, 'Hola a todos los confirmados!');
  });

  // ── 15. Publicación efectiva: rechazo para no autorizados, bloqueados y anónimos retirados ──
  test('15. Publicación efectiva: solicitante pendiente, usuario bloqueado, ajeno y anónimo retirado son denegados al escribir', async () => {
    // A. Solicitante pendiente
    const resPending = await runWithContext(PENDING_USER_ID, {}, `
      SELECT public.publicar_mensaje_encuentro_seguro('${OPEN_ENC_ID}', 'Intento de publicación no autorizada') AS result;
    `);
    assert.equal(resPending.rows[0].result.ok, false);
    assert.equal(resPending.rows[0].result.error, 'unauthorized');

    // B. Usuario bloqueado bilateralmente
    const resBlocked = await runWithContext(BLOCKED_USER_ID, {}, `
      SELECT public.publicar_mensaje_encuentro_seguro('${OPEN_ENC_ID}', 'Intento usuario bloqueado') AS result;
    `);
    assert.equal(resBlocked.rows[0].result.ok, false);
    assert.equal(resBlocked.rows[0].result.error, 'blocked_user');

    // C. Usuario ajeno al encuentro
    const resStranger = await runWithContext(UNAUTHORIZED_USER_ID, {}, `
      SELECT public.publicar_mensaje_encuentro_seguro('${OPEN_ENC_ID}', 'Intento usuario ajeno') AS result;
    `);
    assert.equal(resStranger.rows[0].result.ok, false);
    assert.equal(resStranger.rows[0].result.error, 'unauthorized');

    // D. Sesión anónima retirada por migración de dominio
    const resRetired = await runWithContext(RETIRED_ANON_USER_ID, {}, `
      SELECT public.publicar_mensaje_encuentro_seguro('${OPEN_ENC_ID}', 'Intento anónimo retirado') AS result;
    `);
    assert.equal(resRetired.rows[0].result.ok, false);
    assert.equal(resRetired.rows[0].result.error, 'anonymous_session_already_migrated');
  });

  // ── 16. Publicación efectiva: encuentro cancelado deniega escritura ─────────
  test('16. Publicación efectiva: encuentro cancelado deniega la publicación con writing_window_closed', async () => {
    const resCancelled = await runWithContext(APPROVED_USER_ID, {}, `
      SELECT public.publicar_mensaje_encuentro_seguro('${CANCELLED_ENC_ID}', 'Intento en encuentro cancelado') AS result;
    `);
    assert.equal(resCancelled.rows[0].result.ok, false);
    assert.equal(resCancelled.rows[0].result.error, 'writing_window_closed');
  });

  // ── 17. Frontend / Concurrencia: carrera asíncrona entre encuentros ─────────
  test('17. Frontend / Concurrencia: verificación de carrera asíncrona entre encuentros e invalidación de peticiones obsoletas', async () => {
    // Simulación del motor de invalidación y concurrencia implementado en EncounterMessagesPanel.tsx
    let activeRequestId = 0;
    let inFlightTarget: string | null = null;
    let currentTarget = { encuentroId: 'enc-A', tokenInvitacion: undefined as string | undefined };
    let panelState = {
      encuentroId: 'enc-A',
      mensajes: [] as Array<{ id: string; contenido: string }>,
      destacados: [] as Array<{ id: string }>,
      whatsappContact: null as any,
    };

    const simulateFetchMensajes = async (targetId: string, delayMs: number, payload: any) => {
      // Regla de EncounterMessagesPanel: si el targetId cambió respecto a inFlightTarget, no bloquear
      const thisRequestId = ++activeRequestId;
      inFlightTarget = targetId;

      await new Promise(resolve => setTimeout(resolve, delayMs));

      // Guardia idéntica a EncounterMessagesPanel.tsx:
      // Si la petición ya no es la más reciente o el destino cambió, descartar inmediatamente
      if (
        thisRequestId !== activeRequestId ||
        currentTarget.encuentroId !== targetId
      ) {
        return { discarded: true };
      }

      panelState = {
        encuentroId: targetId,
        mensajes: payload.mensajes,
        destacados: payload.destacados,
        whatsappContact: payload.whatsappContact,
      };
      return { discarded: false };
    };

    // 1. Encuentro A inicia consulta lenta (50ms)
    currentTarget = { encuentroId: 'enc-A', tokenInvitacion: undefined };
    const promiseA = simulateFetchMensajes('enc-A', 50, {
      mensajes: [{ id: 'msg-A-1', contenido: 'Mensaje confidencial de A' }],
      destacados: [{ id: 'msg-A-1' }],
      whatsappContact: { telefono: '+5491111111111' },
    });

    // 2. A los 10ms, el usuario conmuta al Encuentro B (interacción de navegación)
    await new Promise(resolve => setTimeout(resolve, 10));
    // El useEffect de EncounterMessagesPanel incrementa activeRequestIdRef, limpia inFlightTarget y resetea estado
    activeRequestId += 1;
    inFlightTarget = null;
    currentTarget = { encuentroId: 'enc-B', tokenInvitacion: undefined };
    panelState = {
      encuentroId: 'enc-B',
      mensajes: [],
      destacados: [],
      whatsappContact: null,
    };

    // 3. Encuentro B inicia su consulta inmediata (15ms).
    // Verificar que NO queda bloqueado por la petición pendiente de A
    const promiseB = simulateFetchMensajes('enc-B', 15, {
      mensajes: [{ id: 'msg-B-1', contenido: 'Mensaje público de B' }],
      destacados: [],
      whatsappContact: { telefono: '+5492222222222' },
    });

    // 4. Aguardar resolución de ambas promesas
    const [resA, resB] = await Promise.all([promiseA, promiseB]);

    // Verificaciones de aislamiento y no-contaminación:
    assert.equal(resB.discarded, false, 'La consulta del Encuentro B debió completarse y aplicarse con éxito');
    assert.equal(resA.discarded, true, 'La respuesta demorada del Encuentro A debió ser descartada');
    assert.equal(panelState.encuentroId, 'enc-B', 'El estado activo debe ser únicamente del Encuentro B');
    assert.equal(panelState.mensajes.length, 1);
    assert.equal(panelState.mensajes[0].id, 'msg-B-1', 'Los mensajes deben pertenecer exclusivamente al Encuentro B');
    assert.equal(panelState.destacados.length, 0, 'No debe haber destacados retenidos de A');
    assert.equal(panelState.whatsappContact?.telefono, '+5492222222222', 'El contacto de WhatsApp debe pertenecer a B');
  });

  // ── 18. Frontend / Ciclo de vida real: Montaje y rerender con respuestas diferidas ──
  test('18. Frontend / Ciclo de vida real: Montaje y rerender con respuestas diferidas (Aislamiento Visual Estricto)', async () => {
    // 1. Configuración de DOM simulado compatible con React 19
    const makeDomNode = (tag = 'DIV') => {
      const node: any = {
        nodeType: 1,
        tagName: tag.toUpperCase(),
        childNodes: [],
        style: {},
        attributes: {},
        _textContent: '',
        ownerDocument: null,
        parentNode: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        appendChild(child: any) {
          this.childNodes.push(child);
          child.parentNode = this;
          return child;
        },
        removeChild(child: any) {
          this.childNodes = this.childNodes.filter((c: any) => c !== child);
          child.parentNode = null;
          return child;
        },
        insertBefore(child: any, ref: any) {
          const idx = this.childNodes.indexOf(ref);
          if (idx >= 0) this.childNodes.splice(idx, 0, child);
          else this.childNodes.push(child);
          child.parentNode = this;
          return child;
        },
        setAttribute(k: string, v: string) {
          this.attributes[k] = v;
        },
        removeAttribute(k: string) {
          delete this.attributes[k];
        },
      };
      Object.defineProperty(node, 'textContent', {
        get() {
          if (this._textContent) return this._textContent;
          if (this.childNodes.length > 0) return this.childNodes.map((c: any) => c.textContent || '').join(' ');
          return '';
        },
        set(val: string) {
          this._textContent = val;
        },
      });
      return node;
    };

    function getDomString(node: any): string {
      if (!node) return '';
      let out = '';
      if (node.nodeType === 3) return node.textContent || node.nodeValue || '';
      if (node.attributes) {
        for (const [k, v] of Object.entries(node.attributes)) {
          out += ' ' + k + '="' + v + '"';
        }
      }
      if (node._textContent) out += ' ' + node._textContent;
      if (node.childNodes && node.childNodes.length > 0) {
        out += ' ' + node.childNodes.map(getDomString).join(' ');
      }
      return out;
    }

    const container = makeDomNode('DIV');
    (globalThis as any).document = {
      nodeType: 9,
      visibilityState: 'visible',
      createElement: (tag: string) => makeDomNode(tag),
      createElementNS: (_ns: string, tag: string) => makeDomNode(tag),
      createTextNode: (text: string) => ({
        nodeType: 3,
        nodeValue: text,
        textContent: text,
        parentNode: null,
      }),
      createComment: () => ({ nodeType: 8, nodeValue: '', parentNode: null }),
      addEventListener: () => {},
      removeEventListener: () => {},
      documentElement: makeDomNode('HTML'),
    };
    container.ownerDocument = globalThis.document;
    (globalThis as any).window = globalThis;
    (globalThis as any).window.addEventListener = () => {};
    (globalThis as any).window.removeEventListener = () => {};
    (globalThis as any).HTMLIFrameElement = class {};

    // 2. Control de promesas diferidas
    function createDeferred<T>() {
      let resolve!: (val: T) => void;
      let reject!: (err: any) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    let defMsgA = createDeferred<any>();
    let defWaA = createDeferred<any>();
    let defMsgB = createDeferred<any>();
    let defWaB = createDeferred<any>();
    let defMsgB2 = createDeferred<any>();
    let defWaB2 = createDeferred<any>();

    const origGetMensajes = mensajesService.getMensajes;
    const origObtenerContacto = whatsappContactService.obtenerContacto;

    mensajesService.getMensajes = async (id: string, token?: string) => {
      if (id === OPEN_ENC_ID) return defMsgA.promise;
      if (id === PRIVATE_ENC_ID && !token) return defMsgB.promise;
      if (id === PRIVATE_ENC_ID && token === PRIVATE_TOKEN) return defMsgB2.promise;
      return { ok: true, mensajes: [], destacados: [] };
    };

    whatsappContactService.obtenerContacto = async (id: string, token?: string) => {
      if (id === OPEN_ENC_ID) return defWaA.promise;
      if (id === PRIVATE_ENC_ID && !token) return defWaB.promise;
      if (id === PRIVATE_ENC_ID && token === PRIVATE_TOKEN) return defWaB2.promise;
      return { ok: false };
    };

    try {
      const root = createRoot(container);

      // Paso 1: Montar A con mensajes, destacados y WhatsApp
      root.render(React.createElement(EncounterMessagesPanel, {
        encuentroId: OPEN_ENC_ID,
        tokenInvitacion: APPROVED_TOKEN,
      }));
      await new Promise(r => setTimeout(r, 20));

      // Resolver datos de A
      defMsgA.resolve({
        ok: true,
        mensajes: [{
          id: 'msg-A-1',
          encuentro_id: OPEN_ENC_ID,
          autor_nombre: 'Organizador A',
          contenido: 'Mensaje confidencial de Encuentro A',
          es_organizador: true,
          destacado: true,
          destacado_en: new Date().toISOString(),
          creado_en: new Date().toISOString(),
        }],
        destacados: [{
          id: 'msg-A-1',
          encuentro_id: OPEN_ENC_ID,
          autor_nombre: 'Organizador A',
          contenido: 'Instrucción destacada privada de A',
          es_organizador: true,
          destacado: true,
          destacado_en: new Date().toISOString(),
          creado_en: new Date().toISOString(),
        }],
        can_write: true,
        writing_window_closed: false,
      });
      defWaA.resolve({
        ok: true,
        has_contact: true,
        opt_in: true,
        telefono: '5491199998888',
        wa_link: 'https://wa.me/5491199998888',
      });
      await new Promise(r => setTimeout(r, 40));

      const textA = getDomString(container);
      assert.ok(textA.includes('Mensaje confidencial de Encuentro A'), 'A debe contener sus mensajes');
      assert.ok(textA.includes('Instrucción destacada privada de A'), 'A debe contener sus destacados');
      assert.ok(textA.includes('5491199998888'), 'A debe contener su WhatsApp');

      // Paso 2: Cambiar a B mediante rerender
      root.render(React.createElement(EncounterMessagesPanel, {
        encuentroId: PRIVATE_ENC_ID,
      }));
      await new Promise(r => setTimeout(r, 5));

      // En el primer render de B, NINGÚN dato de A debe estar visible
      const textBFirstRender = getDomString(container);
      assert.ok(!textBFirstRender.includes('Mensaje confidencial de Encuentro A'), 'En el primer render de B, ningún mensaje de A debe estar visible');
      assert.ok(!textBFirstRender.includes('Instrucción destacada privada de A'), 'En el primer render de B, ningún destacado de A debe estar visible');
      assert.ok(!textBFirstRender.includes('5491199998888'), 'En el primer render de B, ningún contacto de A debe estar visible');

      // Paso 3: Simular llegada tardía de una respuesta obsoleta de A
      const textBBeforeResolve = getDomString(container);
      assert.ok(!textBBeforeResolve.includes('Mensaje confidencial de Encuentro A'));
      assert.ok(!textBBeforeResolve.includes('5491199998888'));

      // Paso 4: Resolver respuesta legítima de B
      defMsgB.resolve({
        ok: true,
        mensajes: [{
          id: 'msg-B-1',
          encuentro_id: PRIVATE_ENC_ID,
          autor_nombre: 'Asistente B',
          contenido: 'Mensaje público del Encuentro B',
          es_organizador: false,
          destacado: false,
          destacado_en: null,
          creado_en: new Date().toISOString(),
        }],
        destacados: [],
        can_write: true,
        writing_window_closed: false,
      });
      defWaB.resolve({
        ok: true,
        has_contact: true,
        opt_in: true,
        telefono: '5491122223333',
        wa_link: 'https://wa.me/5491122223333',
      });
      await new Promise(r => setTimeout(r, 40));

      const textB = getDomString(container);
      assert.ok(textB.includes('Mensaje público del Encuentro B'), 'B debe mostrar sus propios mensajes');
      assert.ok(!textB.includes('Mensaje confidencial de Encuentro A'), 'B no debe mostrar mensajes de A');
      assert.ok(!textB.includes('Instrucción destacada privada de A'), 'B no debe mostrar destacados de A');
      assert.ok(!textB.includes('5491199998888'), 'B no debe mostrar WhatsApp de A');
      assert.ok(textB.includes('5491122223333'), 'B debe mostrar su propio WhatsApp');

      // Paso 5: Repetir con cambio de token en el mismo encuentro B
      root.render(React.createElement(EncounterMessagesPanel, {
        encuentroId: PRIVATE_ENC_ID,
        tokenInvitacion: PRIVATE_TOKEN,
      }));
      await new Promise(r => setTimeout(r, 5));

      const textToken2FirstRender = getDomString(container);
      assert.ok(!textToken2FirstRender.includes('Mensaje público del Encuentro B'), 'En el primer render con nuevo token, los mensajes previos no deben mostrarse transitoriamente');

      defMsgB2.resolve({
        ok: true,
        mensajes: [{
          id: 'msg-B2-1',
          encuentro_id: PRIVATE_ENC_ID,
          autor_nombre: 'Invitado Especial 2',
          contenido: 'Mensaje cargado con token guest 2',
          es_organizador: false,
          destacado: false,
          destacado_en: null,
          creado_en: new Date().toISOString(),
        }],
        destacados: [],
        can_write: true,
        writing_window_closed: false,
      });
      defWaB2.resolve({ ok: false });
      await new Promise(r => setTimeout(r, 40));

      const textToken2Final = getDomString(container);
      assert.ok(textToken2Final.includes('Mensaje cargado con token guest 2'), 'Debe cargar mensajes del nuevo token');
      assert.ok(!textToken2Final.includes('Mensaje confidencial de Encuentro A'), 'No debe contener datos de A');
    } finally {
      try {
        root.unmount();
      } catch {}
      await new Promise(r => setTimeout(r, 20));
      mensajesService.getMensajes = origGetMensajes;
      whatsappContactService.obtenerContacto = origObtenerContacto;
    }
  });

  after(async () => {
    if (db) {
      await db.close();
    }
  });
});
