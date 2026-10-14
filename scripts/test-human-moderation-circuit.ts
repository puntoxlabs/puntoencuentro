import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Circuito Operativo de Moderación Humana (Tests Exhaustivos)', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const normalUser = '22222222-2222-2222-2222-222222222222';
  const anonUser = '33333333-3333-3333-3333-333333333333';
  const qaAdminUser = '44444444-4444-4444-4444-444444444444';
  const qaOnlyUser = '55555555-5555-5555-5555-555555555555';
  const modAdminUser = '66666666-6666-6666-6666-666666666666';
  const moderatorUser = '77777777-7777-7777-7777-777777777777';
  const targetNewUser = '88888888-8888-8888-8888-888888888888';
  const anotherUser = '99999999-9999-9999-9999-999999999999';

  const setAuthContext = async (userId: string | null, isAnon: boolean = false, role: string = 'authenticated') => {
    await db.query(`SELECT set_config('request.jwt.claim.role', '${role}', false);`);
    if (!userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": ${isAnon}, "role": "${role}"}', false);`);
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
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT,
        is_anonymous BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now()
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

      INSERT INTO auth.users (id, email, is_anonymous) VALUES
        ('${hostUser}', 'host@test.com', false),
        ('${normalUser}', 'normal@test.com', false),
        ('${anonUser}', 'anon@test.com', true),
        ('${qaAdminUser}', 'qa_admin@test.com', false),
        ('${qaOnlyUser}', 'qa_only@test.com', false),
        ('${modAdminUser}', 'mod_admin@test.com', false),
        ('${moderatorUser}', 'moderator@test.com', false),
        ('${targetNewUser}', 'new_target@test.com', false),
        ('${anotherUser}', 'another@test.com', false)
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
        ('guemes', 'Güemes / Playa Grande', 'Mar del Plata', 'Costa Atlántica', true)
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
        open_public_title TEXT,
        open_public_zone TEXT,
        max_participants INT,
        locality_id TEXT REFERENCES public.localidades(id),
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        cancelled_by UUID REFERENCES auth.users(id),
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL,
        moderation_status TEXT NOT NULL DEFAULT 'review_pending',
        moderation_reason TEXT,
        moderation_categories TEXT[],
        moderation_decision_source TEXT,
        moderated_at TIMESTAMPTZ
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
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ
      );

      CREATE OR REPLACE FUNCTION public.emitir_alertas_intencion_convertida_outbox(
        p_intencion_id UUID,
        p_encuentro_id UUID
      ) RETURNS VOID AS $$
      BEGIN
      END;
      $$ LANGUAGE plpgsql;

      -- Tablas de autorización
      CREATE TABLE IF NOT EXISTS public.qa_authorized_users (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id),
        role TEXT NOT NULL CHECK (role IN ('admin', 'qa')),
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.moderation_authorized_users (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'moderator')),
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS public.public_content_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL,
        comment TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        reviewed_at TIMESTAMPTZ,
        reviewed_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
        resolution_note TEXT
      );

      CREATE TABLE IF NOT EXISTS public.public_content_moderation_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        moderator_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        previous_status TEXT NULL,
        new_status TEXT NOT NULL,
        reason TEXT NULL,
        categories TEXT[] NULL,
        source TEXT NOT NULL,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
        payload JSONB DEFAULT '{}'::jsonb,
        dedup_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        read_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
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

      -- Función canónica de content hash
      CREATE OR REPLACE FUNCTION public.calcular_content_hash_moderacion(
        p_title TEXT,
        p_open_description TEXT,
        p_modalidad TEXT,
        p_open_public_zone TEXT
      )
      RETURNS TEXT
      LANGUAGE sql
      IMMUTABLE
      SET search_path = ''
      AS $$
        SELECT pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(
              pg_catalog.concat_ws('|',
                pg_catalog.btrim(COALESCE(p_title, '')),
                pg_catalog.btrim(COALESCE(p_open_description, '')),
                pg_catalog.btrim(COALESCE(p_modalidad, 'presencial')),
                pg_catalog.btrim(COALESCE(p_open_public_zone, ''))
              ),
              'UTF8'
            )
          ),
          'hex'
        );
      $$;

      -- Helper is_moderation_authorized()
      CREATE OR REPLACE FUNCTION public.is_moderation_authorized()
      RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $$
      DECLARE
        v_uid uuid := auth.uid();
      BEGIN
        IF v_uid IS NULL THEN RETURN false; END IF;
        RETURN EXISTS (
          SELECT 1
          FROM public.moderation_authorized_users
          WHERE user_id = v_uid
            AND active = true
            AND role IN ('admin', 'moderator')
        );
      END;
      $$;

      -- Helper is_qa_authorized()
      CREATE OR REPLACE FUNCTION public.is_qa_authorized()
      RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $$
      DECLARE
        v_uid uuid := auth.uid();
      BEGIN
        IF v_uid IS NULL THEN RETURN false; END IF;
        RETURN EXISTS (
          SELECT 1
          FROM public.qa_authorized_users
          WHERE user_id = v_uid
            AND role IN ('admin', 'qa')
        );
      END;
      $$;

      -- Poblado inicial de roles de prueba
      INSERT INTO public.qa_authorized_users (user_id, role) VALUES
        ('${qaAdminUser}', 'admin'),
        ('${qaOnlyUser}', 'qa');

      INSERT INTO public.moderation_authorized_users (user_id, role, active) VALUES
        ('${modAdminUser}', 'admin', true),
        ('${moderatorUser}', 'moderator', true);
    `);

    // 2. Ejecutar la migración aditiva bajo prueba
    const migrationPath = path.resolve(
      __dirname,
      '../supabase/migrations/20261014200000_human_moderation_operational_circuit.sql'
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
    await db.exec(migrationSql);
  });

  // ============================================================================
  // BLOQUE 1: Permisos y Autorización
  // ============================================================================

  test('1.1 Usuario normal sin rol es rechazado de ver cola y moderar contenido', async () => {
    await setAuthContext(normalUser);

    const qRes = await db.query<{ get_moderation_queue_seguro: any }>(
      `SELECT public.get_moderation_queue_seguro();`
    );
    assert.equal(qRes.rows[0].get_moderation_queue_seguro.ok, false);
    assert.equal(qRes.rows[0].get_moderation_queue_seguro.error, 'unauthorized');

    const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(
      `SELECT public.resolver_moderacion_encuentro_seguro('00000000-0000-0000-0000-000000000000', 'approve');`
    );
    assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.ok, false);
    assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.error, 'unauthorized');
  });

  test('1.2 Usuario normal sin rol no puede administrar moderadores', async () => {
    await setAuthContext(normalUser);

    const listRes = await db.query<{ listar_moderadores_seguro: any }>(
      `SELECT public.listar_moderadores_seguro();`
    );
    assert.equal(listRes.rows[0].listar_moderadores_seguro.ok, false);
    assert.equal(listRes.rows[0].listar_moderadores_seguro.error, 'unauthorized');

    const addRes = await db.query<{ agregar_moderador_por_email_seguro: any }>(
      `SELECT public.agregar_moderador_por_email_seguro('someone@test.com', 'moderator');`
    );
    assert.equal(addRes.rows[0].agregar_moderador_por_email_seguro.ok, false);
    assert.equal(addRes.rows[0].agregar_moderador_por_email_seguro.error, 'unauthorized');
  });

  test('1.3 Moderator accede a la cola y puede moderar, pero NO puede administrar roles', async () => {
    await setAuthContext(moderatorUser);

    // Acceso a cola permitido
    const qRes = await db.query<{ get_moderation_queue_seguro: any }>(
      `SELECT public.get_moderation_queue_seguro();`
    );
    assert.equal(qRes.rows[0].get_moderation_queue_seguro.ok, true);

    // Gestión de moderadores denegada
    const listRes = await db.query<{ listar_moderadores_seguro: any }>(
      `SELECT public.listar_moderadores_seguro();`
    );
    assert.equal(listRes.rows[0].listar_moderadores_seguro.ok, false);
    assert.equal(listRes.rows[0].listar_moderadores_seguro.error, 'unauthorized');

    const addRes = await db.query<{ agregar_moderador_por_email_seguro: any }>(
      `SELECT public.agregar_moderador_por_email_seguro('someone@test.com', 'moderator');`
    );
    assert.equal(addRes.rows[0].agregar_moderador_por_email_seguro.ok, false);
    assert.equal(addRes.rows[0].agregar_moderador_por_email_seguro.error, 'unauthorized');
  });

  test('1.4 QA Admin puede administrar moderadores, pero ser QA Admin NO lo autoriza a moderar contenido', async () => {
    await setAuthContext(qaAdminUser);

    // Puede listar y administrar moderadores desde /internal/qa
    const listRes = await db.query<{ listar_moderadores_seguro: any }>(
      `SELECT public.listar_moderadores_seguro();`
    );
    assert.equal(listRes.rows[0].listar_moderadores_seguro.ok, true);

    // NO puede listar cola de moderación ni resolver
    const qRes = await db.query<{ get_moderation_queue_seguro: any }>(
      `SELECT public.get_moderation_queue_seguro();`
    );
    assert.equal(qRes.rows[0].get_moderation_queue_seguro.ok, false);
    assert.equal(qRes.rows[0].get_moderation_queue_seguro.error, 'unauthorized');

    const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(
      `SELECT public.resolver_moderacion_encuentro_seguro('00000000-0000-0000-0000-000000000000', 'approve');`
    );
    assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.ok, false);
    assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.error, 'unauthorized');
  });

  test('1.5 Moderation Admin puede gestionar moderadores Y moderar contenido', async () => {
    await setAuthContext(modAdminUser);

    const listRes = await db.query<{ listar_moderadores_seguro: any }>(
      `SELECT public.listar_moderadores_seguro();`
    );
    assert.equal(listRes.rows[0].listar_moderadores_seguro.ok, true);

    const qRes = await db.query<{ get_moderation_queue_seguro: any }>(
      `SELECT public.get_moderation_queue_seguro();`
    );
    assert.equal(qRes.rows[0].get_moderation_queue_seguro.ok, true);
  });

  // ============================================================================
  // BLOQUE 2: Gestión de Moderadores (Alta, Roles, Revocación Lógica, Anti-Lockout)
  // ============================================================================

  test('2.1 Agregar moderador por email exacto existente', async () => {
    await setAuthContext(modAdminUser);

    const addRes = await db.query<{ agregar_moderador_por_email_seguro: any }>(
      `SELECT public.agregar_moderador_por_email_seguro('new_target@test.com', 'moderator');`
    );
    const r = addRes.rows[0].agregar_moderador_por_email_seguro;
    assert.equal(r.ok, true);
    assert.equal(r.user_id, targetNewUser);
    assert.equal(r.role, 'moderator');
    assert.equal(r.active, true);

    // Verificar en BD
    const checkDb = await db.query<{ role: string; active: boolean }>(
      `SELECT role, active FROM public.moderation_authorized_users WHERE user_id = '${targetNewUser}';`
    );
    assert.equal(checkDb.rows[0].role, 'moderator');
    assert.equal(checkDb.rows[0].active, true);
  });

  test('2.2 Agregar moderador con email inexistente devuelve error humano claro', async () => {
    await setAuthContext(modAdminUser);

    const addRes = await db.query<{ agregar_moderador_por_email_seguro: any }>(
      `SELECT public.agregar_moderador_por_email_seguro('no_existe@test.com', 'moderator');`
    );
    const r = addRes.rows[0].agregar_moderador_por_email_seguro;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'user_not_found');
    assert.match(r.message, /No se encontró ninguna cuenta/);
  });

  test('2.3 Agregar moderador con cuenta anónima devuelve error humano claro', async () => {
    await setAuthContext(modAdminUser);

    const addRes = await db.query<{ agregar_moderador_por_email_seguro: any }>(
      `SELECT public.agregar_moderador_por_email_seguro('anon@test.com', 'moderator');`
    );
    const r = addRes.rows[0].agregar_moderador_por_email_seguro;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'user_is_anonymous');
    assert.match(r.message, /temporal o no permanente/);
  });

  test('2.4 Actualizar rol de moderador a admin y viceversa', async () => {
    await setAuthContext(modAdminUser);

    const updRes = await db.query<{ actualizar_rol_moderador_seguro: any }>(
      `SELECT public.actualizar_rol_moderador_seguro('${targetNewUser}', 'admin');`
    );
    assert.equal(updRes.rows[0].actualizar_rol_moderador_seguro.ok, true);
    assert.equal(updRes.rows[0].actualizar_rol_moderador_seguro.role, 'admin');

    const updBack = await db.query<{ actualizar_rol_moderador_seguro: any }>(
      `SELECT public.actualizar_rol_moderador_seguro('${targetNewUser}', 'moderator');`
    );
    assert.equal(updBack.rows[0].actualizar_rol_moderador_seguro.ok, true);
    assert.equal(updBack.rows[0].actualizar_rol_moderador_seguro.role, 'moderator');
  });

  test('2.5 Revocar moderador usa active = false (no borra físicamente fila) y reactivar funciona', async () => {
    await setAuthContext(modAdminUser);

    // Revocar
    const revRes = await db.query<{ revocar_moderador_seguro: any }>(
      `SELECT public.revocar_moderador_seguro('${targetNewUser}');`
    );
    assert.equal(revRes.rows[0].revocar_moderador_seguro.ok, true);
    assert.equal(revRes.rows[0].revocar_moderador_seguro.active, false);

    // Verificar en BD que la fila SIGUE existiendo con active = false
    const checkDb = await db.query<{ active: boolean }>(
      `SELECT active FROM public.moderation_authorized_users WHERE user_id = '${targetNewUser}';`
    );
    assert.equal(checkDb.rows.length, 1);
    assert.equal(checkDb.rows[0].active, false);

    // Reactivar ingresando el mismo email
    const reAdd = await db.query<{ agregar_moderador_por_email_seguro: any }>(
      `SELECT public.agregar_moderador_por_email_seguro('new_target@test.com', 'admin');`
    );
    assert.equal(reAdd.rows[0].agregar_moderador_por_email_seguro.ok, true);
    assert.equal(reAdd.rows[0].agregar_moderador_por_email_seguro.active, true);
    assert.equal(reAdd.rows[0].agregar_moderador_por_email_seguro.role, 'admin');

    const checkReactivated = await db.query<{ active: boolean; role: string }>(
      `SELECT active, role FROM public.moderation_authorized_users WHERE user_id = '${targetNewUser}';`
    );
    assert.equal(checkReactivated.rows[0].active, true);
    assert.equal(checkReactivated.rows[0].role, 'admin');
  });

  test('2.6 Protección Anti-Lockout: no permite degradar o revocar al último admin disponible', async () => {
    await setAuthContext(modAdminUser);

    // 1. Degradamos al target de vuelta a moderator para que modAdminUser sea el único mod admin
    await db.query(`SELECT public.actualizar_rol_moderador_seguro('${targetNewUser}', 'moderator');`);

    // 2. Quitamos temporalmente a QA admin para simular escenario extremo donde solo queda modAdminUser
    await db.query(`DELETE FROM public.qa_authorized_users WHERE user_id = '${qaAdminUser}';`);

    // 3. Intentar revocar al único admin restante debe fallar cerrado
    const failRevoke = await db.query<{ revocar_moderador_seguro: any }>(
      `SELECT public.revocar_moderador_seguro('${modAdminUser}');`
    );
    assert.equal(failRevoke.rows[0].revocar_moderador_seguro.ok, false);
    assert.equal(failRevoke.rows[0].revocar_moderador_seguro.error, 'cannot_remove_last_admin');

    // 4. Intentar degradar al único admin restante a moderator debe fallar cerrado
    const failDemote = await db.query<{ actualizar_rol_moderador_seguro: any }>(
      `SELECT public.actualizar_rol_moderador_seguro('${modAdminUser}', 'moderator');`
    );
    assert.equal(failDemote.rows[0].actualizar_rol_moderador_seguro.ok, false);
    assert.equal(failDemote.rows[0].actualizar_rol_moderador_seguro.error, 'cannot_remove_last_admin');

    // Restaurar qaAdminUser
    await db.query(`INSERT INTO public.qa_authorized_users (user_id, role) VALUES ('${qaAdminUser}', 'admin');`);
  });

  // ============================================================================
  // BLOQUE 3: Cola de Moderación y Privacidad de Datos
  // ============================================================================

  test('3.1 Encuentro en review_pending aparece en cola ordenado más antiguos primero con datos públicos completos', async () => {
    // Insertamos dos encuentros con distintas fechas
    const encOlderId = 'a1111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const encNewerId = 'b2222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    await db.query(`
      INSERT INTO public.encuentros (
        id, titulo, open_public_title, open_description, modalidad, open_public_zone,
        fecha, hora, lugar_texto, link_virtual, public_token, host_id,
        moderation_status, moderation_reason, opened_at, creado_en
      ) VALUES
        ('${encOlderId}', 'Título Privado Viejo', 'Charla de Ajedrez', 'Descripción pública ajedrez', 'presencial', 'Plaza Mitre', '2026-11-01', '18:00:00', 'Dirección Secreta Calle 123', 'https://secreto.com', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '${hostUser}', 'review_pending', 'contains_link', now() - INTERVAL '2 hours', now() - INTERVAL '2 hours'),
        ('${encNewerId}', 'Título Privado Nuevo', 'Taller de Cerámica', 'Descripción pública cerámica', 'virtual', 'Online', '2026-11-02', '19:00:00', 'Lugar Privado 456', 'https://zoom.privado.com', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '${hostUser}', 'review_pending', 'contains_personal_contact_data', now() - INTERVAL '1 hour', now() - INTERVAL '1 hour');
    `);

    await setAuthContext(moderatorUser);
    const qRes = await db.query<{ get_moderation_queue_seguro: any }>(
      `SELECT public.get_moderation_queue_seguro();`
    );
    const queue = qRes.rows[0].get_moderation_queue_seguro.queue;
    assert.ok(Array.isArray(queue));

    // El más antiguo debe estar antes en la cola
    const idxOlder = queue.findIndex((item: any) => item.id === encOlderId);
    const idxNewer = queue.findIndex((item: any) => item.id === encNewerId);
    assert.ok(idxOlder >= 0 && idxNewer >= 0);
    assert.ok(idxOlder < idxNewer, 'Los casos más antiguos deben aparecer primero');

    const olderItem = queue[idxOlder];
    // Datos públicos presentes
    assert.equal(olderItem.open_public_title, 'Charla de Ajedrez');
    assert.equal(olderItem.titulo, 'Charla de Ajedrez');
    assert.equal(olderItem.open_description, 'Descripción pública ajedrez');
    assert.equal(olderItem.modalidad, 'presencial');
    assert.equal(olderItem.open_public_zone, 'Plaza Mitre');
    assert.equal(olderItem.fecha, '2026-11-01');
    assert.equal(olderItem.moderation_reason, 'contains_link');
    assert.ok(olderItem.content_hash, 'Debe incluir content_hash');

    // INVARIANTE ESTRICTO DE PRIVACIDAD: Datos privados NUNCA se exponen
    assert.equal((olderItem as any).lugar_texto, undefined);
    assert.equal((olderItem as any).link_virtual, undefined);
    assert.equal((olderItem as any).public_token, undefined);
    assert.ok(!JSON.stringify(olderItem).includes('Dirección Secreta'));
    assert.ok(!JSON.stringify(olderItem).includes('https://secreto.com'));
    assert.ok(!JSON.stringify(olderItem).includes('Título Privado Viejo'));
  });

  // ============================================================================
  // BLOQUE 4: Aprobación y Rechazo Atómicos, Notificaciones y Concurrencia
  // ============================================================================

  test('4.1 Aprobar REVIEW válido: actualiza a approved, is_open = true, audita y notifica al host', async () => {
    const encId = 'c3333333-cccc-cccc-cccc-cccccccccccc';
    await db.query(`
      INSERT INTO public.encuentros (
        id, titulo, open_public_title, open_description, modalidad, open_public_zone,
        host_id, is_open, moderation_status
      ) VALUES (
        '${encId}', 'Privado', 'Ajedrez en la Plaza', 'Jugamos partidas rápidas', 'presencial', 'Güemes',
        '${hostUser}', false, 'review_pending'
      );
    `);

    // Calcular hash esperado
    const hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion('Ajedrez en la Plaza', 'Jugamos partidas rápidas', 'presencial', 'Güemes');
    `);
    const expectedHash = hashRes.rows[0].calcular_content_hash_moderacion;

    await setAuthContext(moderatorUser);
    const resolveRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'Contenido legítimo', '${expectedHash}');
    `);
    const r = resolveRes.rows[0].resolver_moderacion_encuentro_seguro;
    assert.equal(r.ok, true);
    assert.equal(r.moderation_status, 'approved');
    assert.equal(r.is_open, true);

    // Verificar en BD
    const encRow = await db.query<{ moderation_status: string; is_open: boolean }>(`
      SELECT moderation_status, is_open FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(encRow.rows[0].moderation_status, 'approved');
    assert.equal(encRow.rows[0].is_open, true);

    // Verificar Notificación al Host en inbox_notifications
    const inboxRow = await db.query<{ notification_type: string; title: string; body: string }>(`
      SELECT notification_type, title, body
      FROM public.inbox_notifications
      WHERE recipient_user_id = '${hostUser}' AND target_id = '${encId}';
    `);
    assert.equal(inboxRow.rows.length, 1);
    assert.equal(inboxRow.rows[0].notification_type, 'moderation_approved');
    assert.equal(inboxRow.rows[0].title, 'Tu encuentro fue aprobado');
    assert.equal(inboxRow.rows[0].body, 'Ya puede aparecer públicamente en PuntoEncuentro.');

    // Verificar Auditoría
    const auditRow = await db.query<{ action: string; new_status: string; metadata: any }>(`
      SELECT action, new_status, metadata
      FROM public.public_content_moderation_audit
      WHERE encuentro_id = '${encId}' AND action = 'approve';
    `);
    assert.equal(auditRow.rows.length, 1);
    assert.equal(auditRow.rows[0].action, 'approve');
    assert.equal(auditRow.rows[0].new_status, 'approved');
    assert.equal(auditRow.rows[0].metadata.content_hash, expectedHash);
  });

  test('4.2 Rechazar REVIEW: actualiza a rejected, is_open = false, audita y notifica al host con motivo', async () => {
    const encId = 'd4444444-dddd-dddd-dddd-dddddddddddd';
    await db.query(`
      INSERT INTO public.encuentros (
        id, titulo, open_public_title, open_description, modalidad, open_public_zone,
        host_id, is_open, moderation_status
      ) VALUES (
        '${encId}', 'Privado', 'Encuentro con teléfono', 'Llamar al 123456789 para anotarse', 'presencial', 'Güemes',
        '${hostUser}', false, 'review_pending'
      );
    `);

    const hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion('Encuentro con teléfono', 'Llamar al 123456789 para anotarse', 'presencial', 'Güemes');
    `);
    const expectedHash = hashRes.rows[0].calcular_content_hash_moderacion;

    await setAuthContext(moderatorUser);
    const resolveRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro(
        '${encId}', 'reject', 'Por favor no incluyas teléfonos en la descripción pública.', '${expectedHash}'
      );
    `);
    const r = resolveRes.rows[0].resolver_moderacion_encuentro_seguro;
    assert.equal(r.ok, true);
    assert.equal(r.moderation_status, 'rejected');
    assert.equal(r.is_open, false);

    // Verificar notificación con motivo
    const inboxRow = await db.query<{ notification_type: string; title: string; body: string }>(`
      SELECT notification_type, title, body
      FROM public.inbox_notifications
      WHERE recipient_user_id = '${hostUser}' AND target_id = '${encId}' AND notification_type = 'moderation_rejected';
    `);
    assert.equal(inboxRow.rows.length, 1);
    assert.equal(inboxRow.rows[0].title, 'Tu publicación necesita cambios');
    assert.match(inboxRow.rows[0].body, /Por favor no incluyas teléfonos/);
  });

  test('4.3 Encuentro cancelado durante review NO revive al ser aprobado', async () => {
    const encId = 'e5555555-eeee-eeee-eeee-eeeeeeeeeeee';
    await db.query(`
      INSERT INTO public.encuentros (
        id, titulo, open_public_title, open_description, modalidad, open_public_zone,
        host_id, is_open, moderation_status, cancelled_at
      ) VALUES (
        '${encId}', 'Privado', 'Encuentro que el host canceló', 'Texto', 'presencial', 'Güemes',
        '${hostUser}', false, 'review_pending', now() - INTERVAL '10 minutes'
      );
    `);

    await setAuthContext(moderatorUser);
    const resolveRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'Aprobado pero estaba cancelado');
    `);
    const r = resolveRes.rows[0].resolver_moderacion_encuentro_seguro;
    assert.equal(r.ok, true);
    assert.equal(r.moderation_status, 'approved');
    assert.equal(r.is_open, false, 'Un encuentro cancelado NO debe revivir con is_open=true');
  });

  test('4.4 Concurrencia entre moderadores: si dos abren el mismo caso, el segundo recibe already_resolved', async () => {
    const encId = 'f6666666-ffff-ffff-ffff-ffffffffffff';
    await db.query(`
      INSERT INTO public.encuentros (
        id, titulo, open_public_title, open_description, modalidad, open_public_zone,
        host_id, is_open, moderation_status
      ) VALUES (
        '${encId}', 'Privado', 'Caso en disputa concurrente', 'Texto', 'presencial', 'Güemes',
        '${hostUser}', false, 'review_pending'
      );
    `);

    // Moderador 1 resuelve primero
    await setAuthContext(moderatorUser);
    const res1 = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'Resolución mod 1');
    `);
    assert.equal(res1.rows[0].resolver_moderacion_encuentro_seguro.ok, true);

    // Moderador 2 intenta resolver inmediatamente después
    await setAuthContext(modAdminUser);
    const res2 = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'reject', 'Resolución mod 2');
    `);
    const r2 = res2.rows[0].resolver_moderacion_encuentro_seguro;
    assert.equal(r2.ok, false);
    assert.equal(r2.error, 'already_resolved');
    assert.match(r2.message, /ya fue resuelto/);
  });

  test('4.5 Contenido modificado por el host invalida resolución por content_hash_mismatch (TOCTOU)', async () => {
    const encId = '10101010-1010-1010-1010-101010101010';
    await db.query(`
      INSERT INTO public.encuentros (
        id, titulo, open_public_title, open_description, modalidad, open_public_zone,
        host_id, is_open, moderation_status
      ) VALUES (
        '${encId}', 'Privado', 'Título Original', 'Descripción original', 'presencial', 'Güemes',
        '${hostUser}', false, 'review_pending'
      );
    `);

    const oldHash = '0000000000000000000000000000000000000000000000000000000000000000';

    await setAuthContext(moderatorUser);
    const resolveRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'Aprobado', '${oldHash}');
    `);
    const r = resolveRes.rows[0].resolver_moderacion_encuentro_seguro;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'content_hash_mismatch');
    assert.match(r.message, /El contenido fue modificado durante la evaluación/);
  });
});
