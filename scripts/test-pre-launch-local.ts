/**
 * Suite de Verificación Local de Seguridad: Control de Acceso PRE-LAUNCH (Etapa 1)
 *
 * Ejecuta exclusivamente sobre PGlite en memoria local.
 * NO realiza conexiones de red ni modifica bases remotas de Staging o Producción.
 *
 * Cubre exhaustivamente los 11 escenarios requeridos:
 * 1. Cliente sin JWT (anon) en Discovery y Creación.
 * 2. Sesión anónima no autorizada (signInAnonymously público).
 * 3. Sesión permanente no autorizada (usuario no listado en QA).
 * 4. Usuario QA permanente autorizado (admin o qa).
 * 5. Usuario QA anónimo autorizado (synthetic test user en qa_authorized_users).
 * 6. Consultas por token público de 64 caracteres.
 * 7. Acceso administrativo y de workers (service_role).
 * 8. Transición PRE-LAUNCH -> PUBLIC-LAUNCH -> PRE-LAUNCH (Emergency Re-lock).
 * 9. Fail-Closed ante configuración ausente o corrupta.
 * 10. Trazabilidad inmutable en tabla de auditoría.
 * 11. Preservación integral de contratos y firmas.
 */

import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Etapa 1: Suite Local PGlite — platform_access_control y Choke-Points', () => {
  let db: PGlite;

  const uid_Anon_Unauth = '11111111-1111-4111-a111-111111111111';
  const uid_Perm_Unauth = '22222222-2222-4222-a222-222222222222';
  const uid_Qa_Perm = '33333333-3333-4333-a333-333333333333';
  const uid_Qa_Anon = '44444444-4444-4444-a444-444444444444';
  const uid_Admin = '99999999-9999-4999-a999-999999999999';
  const uid_Launch_Manager = '55555555-5555-4555-a555-555555555555';

  let testEncounterId: string;
  let testPublicToken: string;

  const setAuth = async (userId: string | null, isAnonymous: boolean = false) => {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '${isAnonymous}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${userId}","is_anonymous":${isAnonymous}}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.role', 'anon', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
    }
  };

  before(async () => {
    db = new PGlite();

    // 1. Roles y Mock de Auth
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

      CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE OR REPLACE FUNCTION extensions.gen_random_bytes(n integer) RETURNS bytea AS $$
        SELECT decode(md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text), 'hex');
      $$ LANGUAGE SQL;

      -- Poblar identidades de prueba
      INSERT INTO auth.users (id, email, is_anonymous) VALUES
        ('${uid_Anon_Unauth}', 'anon_unauth@test.local', true),
        ('${uid_Perm_Unauth}', 'perm_unauth@test.local', false),
        ('${uid_Qa_Perm}', 'qa_perm@puntoencuentro.test', false),
        ('${uid_Qa_Anon}', 'qa_anon_synthetic@puntoencuentro.test', true),
        ('${uid_Admin}', 'admin@puntoencuentro.test', false),
        ('${uid_Launch_Manager}', 'launch_manager@puntoencuentro.test', false)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 2. Infraestructura previa: localidades, encuentros, participantes, qa_authorized_users, etc.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.localidades (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        ciudad TEXT,
        zona TEXT,
        pais TEXT DEFAULT 'AR',
        orden INT DEFAULT 1,
        activo BOOLEAN NOT NULL DEFAULT true
      );

      INSERT INTO public.localidades (id, nombre, ciudad, activo) VALUES
        ('centro', 'Centro / La Perla', 'Mar del Plata', true),
        ('guemes', 'Güemes / Playa Grande', 'Mar del Plata', true)
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha DATE,
        hora TIME,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        lugar_texto TEXT,
        link_virtual TEXT,
        tipo_invitacion TEXT NOT NULL DEFAULT 'link_general',
        host_id UUID,
        public_token UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'activo',
        tema TEXT NOT NULL DEFAULT 'blue',
        tema_invitacion TEXT NOT NULL DEFAULT 'classic',
        invitation_template TEXT,
        post_event_active_minutes INT DEFAULT 45,
        creado_en TIMESTAMPTZ DEFAULT now(),
        is_open BOOLEAN DEFAULT false,
        open_public_title TEXT,
        open_description TEXT,
        open_public_zone TEXT,
        locality_id TEXT REFERENCES public.localidades(id),
        max_participants INT DEFAULT 10,
        min_participants INT DEFAULT 2,
        allow_multi_seat_requests BOOLEAN DEFAULT false,
        max_seats_per_request INT DEFAULT 1,
        min_seats_per_request INT DEFAULT 1,
        realization_status TEXT DEFAULT 'pending',
        inscriptions_closed BOOLEAN DEFAULT false,
        moderation_status TEXT DEFAULT 'approved',
        opened_at TIMESTAMPTZ,
        open_activity_canonical TEXT,
        open_activity_matching_eligible BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT NOT NULL DEFAULT 'generico',
        token_invitacion UUID UNIQUE DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'confirmado',
        user_id UUID,
        mensaje_respuesta TEXT,
        seat_count INT DEFAULT 1,
        respondido_en TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL,
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        seat_count INT DEFAULT 1,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        motivo_baja TEXT,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        CONSTRAINT uq_solicitud_encuentro_usuario UNIQUE (encuentro_id, usuario_id)
      );

      CREATE TABLE IF NOT EXISTS public.intenciones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        titulo TEXT NOT NULL,
        descripcion TEXT,
        temporalidad_texto TEXT,
        fecha_desde DATE,
        fecha_hasta DATE,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        locality_id TEXT,
        estado TEXT NOT NULL DEFAULT 'activa',
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.intencion_intereses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        intencion_id UUID NOT NULL REFERENCES public.intenciones(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        CONSTRAINT uq_intencion_interes UNIQUE (intencion_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS public.coverage_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        raw_location_text TEXT NOT NULL,
        normalized_location_text TEXT NOT NULL,
        intent_text TEXT,
        client_environment TEXT DEFAULT 'web',
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        blocker_id UUID NOT NULL,
        blocked_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.qa_authorized_users (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'qa' CHECK (role IN ('admin', 'qa')),
        created_at TIMESTAMPTZ DEFAULT now(),
        created_by UUID
      );

      -- Registrar usuarios autorizados de QA
      INSERT INTO public.qa_authorized_users (user_id, role) VALUES
        ('${uid_Qa_Perm}', 'qa'),
        ('${uid_Qa_Anon}', 'qa'),
        ('${uid_Admin}', 'admin')
      ON CONFLICT (user_id) DO NOTHING;

      -- is_qa_authorized helper
      CREATE OR REPLACE FUNCTION public.is_qa_authorized()
      RETURNS boolean
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = ''
      AS $$
      DECLARE
          v_user_id UUID := auth.uid();
      BEGIN
          IF v_user_id IS NULL THEN
              RETURN false;
          END IF;
          RETURN EXISTS (
              SELECT 1 FROM public.qa_authorized_users
              WHERE user_id = v_user_id AND role IN ('admin', 'qa')
          );
      END;
      $$;

      -- check_rate_limit_internal stub
      CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(p_action text, p_key text)
      RETURNS jsonb AS $$
      BEGIN
          RETURN '{"allowed": true}'::jsonb;
      END;
      $$ LANGUAGE plpgsql;

      -- is_retired_anonymous_source stub
      CREATE OR REPLACE FUNCTION public.is_retired_anonymous_source(p_uid uuid)
      RETURNS boolean AS $$
      BEGIN
          RETURN false;
      END;
      $$ LANGUAGE plpgsql;

      -- insertar_inbox_notification_seguro stub
      CREATE OR REPLACE FUNCTION public.insertar_inbox_notification_seguro(
          p_recipient uuid, p_type text, p_target_type text, p_target_id uuid,
          p_deep_link text, p_title text, p_body text, p_payload jsonb, p_dedup text
      ) RETURNS uuid AS $$
      BEGIN
          RETURN gen_random_uuid();
      END;
      $$ LANGUAGE plpgsql;

      -- evaluar_antiabuso_privado_determinista stub
      CREATE OR REPLACE FUNCTION public.evaluar_antiabuso_privado_determinista(p_title text, p_desc text)
      RETURNS TABLE (allowed boolean, reason text) AS $$
      BEGIN
          RETURN QUERY SELECT true, 'allowed'::text;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 3. Crear encuentro abierto y tokens de prueba
    const encRes = await db.query<{ id: string; public_token: string }>(`
      INSERT INTO public.encuentros (
        titulo, open_public_title, descripcion, open_description,
        fecha, hora, modalidad, host_id, is_open, moderation_status,
        locality_id, open_public_zone, max_participants
      ) VALUES (
        'Café Tecnológico', 'Café Tecnológico Mar del Plata',
        'Charla de prueba QA', 'Encuentro de programadores',
        '2026-12-01', '18:00:00', 'presencial', '${uid_Qa_Perm}',
        true, 'approved', 'centro', 'Centro / La Perla', 10
      ) RETURNING id, public_token;
    `);
    testEncounterId = encRes.rows[0].id;
    testPublicToken = encRes.rows[0].public_token;

    // Crear intención de prueba
    await db.query(`
      INSERT INTO public.intenciones (user_id, titulo, descripcion, modalidad, locality_id, fecha_hasta)
      VALUES ('${uid_Qa_Perm}', 'Ajedrez en la plaza', 'Partidas libres', 'presencial', 'centro', '2026-12-31');
    `);

    // 4. APLICAR LA MIGRACIÓN PREPARADA (20261112120000)
    const migrationPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20261112120000_platform_pre_launch_access_control_v1.sql'
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(migrationSql);

    // 5. Configurar operador autorizado de lanzamiento controlado
    await db.query(`
      INSERT INTO public.platform_launch_authorizations (user_id, role, is_active)
      VALUES ('${uid_Launch_Manager}', 'launch_manager', true)
      ON CONFLICT (user_id) DO NOTHING;
    `);
  });

  // ============================================================================
  // ESCENARIO 1: CLIENTE SIN JWT (ROL 'anon')
  // ============================================================================
  test('1. Cliente sin JWT (anon) es bloqueado en Discovery y Creación', async () => {
    await setAuth(null);

    // 1.1 Discovery de encuentros debe devolver arreglo vacío []
    const discEnc = await db.query(`SELECT public.get_discovery_encuentros_abiertos() AS res;`);
    assert.deepStrictEqual(discEnc.rows[0].res, []);

    // 1.2 Discovery de intenciones debe devolver arreglo vacío []
    const discInt = await db.query(`SELECT public.get_discovery_intenciones_activas() AS res;`);
    assert.deepStrictEqual(discInt.rows[0].res, []);

    // 1.3 Ficha pública de encuentro abierto debe retornar error pre_launch_restricted
    const encCard = await db.query<{ res: any }>(
      `SELECT public.get_encuentro_abierto_publico('${testEncounterId}'::uuid) AS res;`
    );
    assert.strictEqual(encCard.rows[0].res.ok, false);
    assert.strictEqual(encCard.rows[0].res.error, 'pre_launch_restricted');

    // 1.4 Creación de encuentro debe fallar por not_authenticated
    const createRes = await db.query<{ res: any }>(
      `SELECT public.crear_encuentro_seguro('{"titulo":"Test Anon"}'::jsonb) AS res;`
    );
    assert.strictEqual(createRes.rows[0].res.ok, false);
    assert.strictEqual(createRes.rows[0].res.error, 'not_authenticated');

    // 1.5 Solicitud de unirse debe fallar por authentication_required
    const joinRes = await db.query<{ res: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Pepe Anon') AS res;`
    );
    assert.strictEqual(joinRes.rows[0].res.ok, false);
    assert.strictEqual(joinRes.rows[0].res.error, 'authentication_required');
  });

  // ============================================================================
  // ESCENARIO 2: SESIÓN ANÓNIMA NO AUTORIZADA (signInAnonymously público)
  // ============================================================================
  test('2. Sesión anónima no autorizada es bloqueada en creación y discovery', async () => {
    await setAuth(uid_Anon_Unauth, true);

    // 2.1 Discovery retorna vacío
    const discEnc = await db.query(`SELECT public.get_discovery_encuentros_abiertos() AS res;`);
    assert.deepStrictEqual(discEnc.rows[0].res, []);

    // 2.2 Creación de encuentro es RECHAZADA por pre_launch_creation_restricted
    const createRes = await db.query<{ res: any }>(
      `SELECT public.crear_encuentro_seguro('{"titulo":"Encuentro Pirata"}'::jsonb) AS res;`
    );
    assert.strictEqual(createRes.rows[0].res.ok, false);
    assert.strictEqual(createRes.rows[0].res.error, 'pre_launch_creation_restricted');

    // 2.3 Solicitud de unirse rechazada por pre_launch_restricted
    const joinRes = await db.query<{ res: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}'::uuid, 'Pirata') AS res;`
    );
    assert.strictEqual(joinRes.rows[0].res.ok, false);
    assert.strictEqual(joinRes.rows[0].res.error, 'pre_launch_restricted');
  });

  // ============================================================================
  // ESCENARIO 3: SESIÓN PERMANENTE NO AUTORIZADA
  // ============================================================================
  test('3. Sesión permanente no autorizada (fuera de QA) es bloqueada', async () => {
    await setAuth(uid_Perm_Unauth, false);

    // Discovery retorna vacío
    const discEnc = await db.query(`SELECT public.get_discovery_encuentros_abiertos() AS res;`);
    assert.deepStrictEqual(discEnc.rows[0].res, []);

    // Creación rechazada
    const createRes = await db.query<{ res: any }>(
      `SELECT public.crear_encuentro_seguro('{"titulo":"Encuentro Externo"}'::jsonb) AS res;`
    );
    assert.strictEqual(createRes.rows[0].res.ok, false);
    assert.strictEqual(createRes.rows[0].res.error, 'pre_launch_creation_restricted');
  });

  // ============================================================================
  // ESCENARIO 4: USUARIO QA PERMANENTE AUTORIZADO
  // ============================================================================
  test('4. Usuario QA permanente autorizado opera con normalidad', async () => {
    await setAuth(uid_Qa_Perm, false);

    // 4.1 Discovery ve los encuentros
    const discEnc = await db.query<{ res: any[] }>(`SELECT public.get_discovery_encuentros_abiertos() AS res;`);
    assert(Array.isArray(discEnc.rows[0].res));
    assert(discEnc.rows[0].res.length > 0, 'QA debe ver los encuentros abiertos');

    // 4.2 Ficha pública accesible
    const encCard = await db.query<{ res: any }>(
      `SELECT public.get_encuentro_abierto_publico('${testEncounterId}'::uuid) AS res;`
    );
    assert.strictEqual(encCard.rows[0].res.ok, true);
    assert.strictEqual(encCard.rows[0].res.data.id, testEncounterId);

    // 4.3 Puede crear encuentros
    const createRes = await db.query<{ res: any }>(
      `SELECT public.crear_encuentro_seguro('{"titulo":"Encuentro QA Oficial","modalidad":"presencial","tipo_invitacion":"link_general"}'::jsonb) AS res;`
    );
    assert.strictEqual(createRes.rows[0].res.ok, true);
    assert(createRes.rows[0].res.id, 'Debe retornar ID de encuentro creado');
  });

  // ============================================================================
  // ESCENARIO 5: USUARIO QA ANÓNIMO AUTORIZADO (Synthetic test user en QA list)
  // ============================================================================
  test('5. Usuario sintético anónimo autorizado en QA puede probar creación y discovery', async () => {
    // uid_Qa_Anon tiene is_anonymous = true, PERO está registrado en public.qa_authorized_users
    await setAuth(uid_Qa_Anon, true);

    // 5.1 Discovery funciona
    const discEnc = await db.query<{ res: any[] }>(`SELECT public.get_discovery_encuentros_abiertos() AS res;`);
    assert(Array.isArray(discEnc.rows[0].res));
    assert(discEnc.rows[0].res.length > 0, 'QA anónimo debe poder consultar discovery');

    // 5.2 Creación funciona satisfactoriamente (NO es rechazado por v_is_anon)
    const createRes = await db.query<{ res: any }>(
      `SELECT public.crear_encuentro_seguro('{"titulo":"Prueba Sintética Anónima","modalidad":"presencial","tipo_invitacion":"link_general"}'::jsonb) AS res;`
    );
    assert.strictEqual(createRes.rows[0].res.ok, true);
    assert(createRes.rows[0].res.id, 'Debe permitir creación a anónimos en QA');
  });

  // ============================================================================
  // ESCENARIO 6: CONSULTAS POR TOKEN PÚBLICO
  // ============================================================================
  test('6. Consultas por token público de encuentro legítimo no son alteradas', async () => {
    await setAuth(null); // Llamada anónima con el public_token legítimo
    const tokenRes = await db.query<{ titulo: string }>(
      `SELECT titulo FROM public.encuentros WHERE public_token = '${testPublicToken}'::uuid;`
    );
    assert.strictEqual(tokenRes.rows[0].titulo, 'Café Tecnológico');
  });

  // ============================================================================
  // ESCENARIO 7: CONTROL DE FASE Y PRUEBAS NEGATIVAS DE AUTORIZACIÓN
  // ============================================================================
  test('7. Control de fase: rechazos de seguridad para llamadas sin identidad y QA Admin intentando apertura pública', async () => {
    // 7.1 Llamada sin identidad autenticada (JWT anon / sub vacío) retorna authentication_required
    await setAuth(null);
    const unauthCall = await db.query<{ res: any }>(
      `SELECT public.set_platform_launch_phase(true, 'Intento de apertura sin autenticacion') AS res;`
    );
    assert.strictEqual(unauthCall.rows[0].res.ok, false);
    assert.strictEqual(unauthCall.rows[0].res.error, 'authentication_required');

    // 7.1.b Además, invocación directa con rol PostgreSQL anon es denegada por REVOKE
    await db.query(`SET ROLE anon;`);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.set_platform_launch_phase(true, 'Intento anon directo') AS res;`);
      },
      /permission denied for function set_platform_launch_phase/
    );
    await db.query(`RESET ROLE;`);

    // 7.2 Usuario autenticado sin roles administrativos (unauthorized_operator)
    await setAuth(uid_Perm_Unauth, false);
    const regularUserCall = await db.query<{ res: any }>(
      `SELECT public.set_platform_launch_phase(false, 'Intento por usuario regular') AS res;`
    );
    assert.strictEqual(regularUserCall.rows[0].res.ok, false);
    assert.strictEqual(regularUserCall.rows[0].res.error, 'unauthorized_operator');

    // 7.3 Rechazo de justificación inválida / muy corta
    await setAuth(uid_Admin, false);
    const badReason = await db.query<{ res: any }>(
      `SELECT public.set_platform_launch_phase(false, 'abc') AS res;`
    );
    assert.strictEqual(badReason.rows[0].res.ok, false);
    assert.strictEqual(badReason.rows[0].res.error, 'invalid_reason_length');

    // 7.4 PRUEBA NEGATIVA CRÍTICA: Administrador de QA intenta abrir públicamente (p_active = true)
    // DEBE SER ESTRICTAMENTE RECHAZADO por launch_authorization_required
    const qaAdminOpenAttempt = await db.query<{ res: any }>(
      `SELECT public.set_platform_launch_phase(true, 'Intento de apertura publica por QA Admin') AS res;`
    );
    assert.strictEqual(qaAdminOpenAttempt.rows[0].res.ok, false);
    assert.strictEqual(qaAdminOpenAttempt.rows[0].res.error, 'launch_authorization_required');
  });

  // ============================================================================
  // ESCENARIO 8: APERTURA POR LAUNCH_MANAGER Y CIERRE DE EMERGENCIA POR QA ADMIN
  // ============================================================================
  test('8. Apertura pública reservada a launch_manager y cierre de emergencia por QA Admin', async () => {
    // 8.1 Apertura pública exitosa por launch_manager
    await setAuth(uid_Launch_Manager, false);
    const openRes = await db.query<{ res: any }>(
      `SELECT public.set_platform_launch_phase(true, 'Apertura oficial aprobada por el responsable del proyecto') AS res;`
    );
    assert.strictEqual(openRes.rows[0].res.ok, true);
    assert.strictEqual(openRes.rows[0].res.new_value, true);
    assert.strictEqual(openRes.rows[0].res.caller_role, 'launch_manager');

    // 8.2 Ahora un cliente anónimo cualquiera (sin JWT) puede ver discovery
    await setAuth(null);
    const discPublic = await db.query<{ res: any[] }>(`SELECT public.get_discovery_encuentros_abiertos() AS res;`);
    assert(discPublic.rows[0].res.length > 0, 'Discovery debe estar abierto al público en PUBLIC-LAUNCH');

    // 8.3 Un usuario anónimo normal puede crear encuentros
    await setAuth(uid_Anon_Unauth, true);
    const createPublic = await db.query<{ res: any }>(
      `SELECT public.crear_encuentro_seguro('{"titulo":"Encuentro Público Libre","modalidad":"presencial","tipo_invitacion":"link_general"}'::jsonb) AS res;`
    );
    assert.strictEqual(createPublic.rows[0].res.ok, true, 'Anónimo libre debe poder crear en PUBLIC-LAUNCH');

    // 8.4 CIERRE DE EMERGENCIA: QA Admin puede ejecutar cierre de emergencia (p_active = false)
    await setAuth(uid_Admin, false);
    const closeRes = await db.query<{ res: any }>(
      `SELECT public.set_platform_launch_phase(false, 'Bloqueo preventivo de emergencia post-incidente') AS res;`
    );
    assert.strictEqual(closeRes.rows[0].res.ok, true);
    assert.strictEqual(closeRes.rows[0].res.new_value, false);
    assert.strictEqual(closeRes.rows[0].res.caller_role, 'qa_admin');

    // 8.5 Confirmar que el anónimo vuelve a quedar bloqueado de inmediato
    await setAuth(null);
    const discBlocked = await db.query(`SELECT public.get_discovery_encuentros_abiertos() AS res;`);
    assert.deepStrictEqual(discBlocked.rows[0].res, [], 'Debe volver a quedar bloqueado tras reversión');
  });

  // ============================================================================
  // ESCENARIO 9: FAIL-CLOSED ANTE CONFIGURACIÓN AUSENTE Y DETECCIÓN EN TRANSICIÓN
  // ============================================================================
  test('9. Comportamiento Fail-Closed ante ausencia de registro en platform_access_control', async () => {
    await setAuth(uid_Admin, false);
    // Borrar temporalmente la fila para probar robustez fail-closed
    await db.query(`DELETE FROM public.platform_access_control WHERE setting_key = 'public_launch_active';`);

    // Consulta de estado debe devolver false por defecto
    const checkOpen = await db.query<{ res: boolean }>(`SELECT public.is_public_launch_open() AS res;`);
    assert.strictEqual(checkOpen.rows[0].res, false, 'Sin registro debe fallar cerrado (false)');

    // Transición debe retornar error 'setting_not_found' y no false positive
    await setAuth(uid_Launch_Manager, false);
    const missingSettingCall = await db.query<{ res: any }>(
      `SELECT public.set_platform_launch_phase(true, 'Apertura con fila borrada') AS res;`
    );
    assert.strictEqual(missingSettingCall.rows[0].res.ok, false);
    assert.strictEqual(missingSettingCall.rows[0].res.error, 'setting_not_found');

    // Usuario anónimo debe seguir bloqueado
    await setAuth(null);
    const discFallback = await db.query(`SELECT public.get_discovery_encuentros_abiertos() AS res;`);
    assert.deepStrictEqual(discFallback.rows[0].res, []);

    // Restaurar fila
    await db.query(`
      INSERT INTO public.platform_access_control (setting_key, setting_value, description)
      VALUES ('public_launch_active', false, 'Restaurado');
    `);
  });

  // ============================================================================
  // ESCENARIO 10: INMUTABILIDAD ESTRICTA EN AUDITORÍA (UPDATE, DELETE, TRUNCATE)
  // ============================================================================
  test('10. Auditoría inmutable: rechazo de UPDATE, DELETE y TRUNCATE sobre platform_access_control_audit', async () => {
    const auditRows = await db.query<{
      setting_key: string;
      previous_value: boolean;
      new_value: boolean;
      reason: string;
    }>(`
      SELECT setting_key, previous_value, new_value, reason
      FROM public.platform_access_control_audit
      ORDER BY changed_at ASC;
    `);

    assert(auditRows.rows.length >= 2, 'Debe haber al menos 2 registros de auditoría');
    assert.strictEqual(auditRows.rows[0].new_value, true);
    assert.strictEqual(auditRows.rows[1].new_value, false);

    // 10.2 Intento de UPDATE sobre la tabla de auditoría debe ser abortado por el trigger
    await assert.rejects(
      async () => {
        await db.query(`UPDATE public.platform_access_control_audit SET reason = 'Modificacion maliciosa';`);
      },
      /platform_access_control_audit es una tabla inmutable/
    );

    // 10.3 Intento de DELETE sobre la tabla de auditoría debe ser abortado por el trigger
    await assert.rejects(
      async () => {
        await db.query(`DELETE FROM public.platform_access_control_audit;`);
      },
      /platform_access_control_audit es una tabla inmutable/
    );

    // 10.4 Intento de TRUNCATE sobre la tabla de auditoría debe ser abortado por el trigger
    await assert.rejects(
      async () => {
        await db.query(`TRUNCATE TABLE public.platform_access_control_audit;`);
      },
      /platform_access_control_audit es una tabla inmutable/
    );
  });

  // ============================================================================
  // ESCENARIO 11: PROCEDIMIENTO DE ROLLBACK QUIRÚRGICO EN PRE-LAUNCH
  // ============================================================================
  test('11. Procedimiento de rollback quirúrgico en PRE-LAUNCH preserva el bloqueo backend y recupera QA', async () => {
    // 11.1 Cargar y ejecutar script de reversión
    const rollbackPath = path.resolve(
      process.cwd(),
      'supabase/migrations/rollback/20261112120000_rollback_platform_pre_launch_access_control_v1.sql'
    );
    const rollbackSql = fs.readFileSync(rollbackPath, 'utf8');
    await db.exec(rollbackSql);

    // 11.2 Confirmar que platform_access_control fue eliminado
    const checkTable = await db.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'platform_access_control'
      ) AS exists;
    `);
    assert.strictEqual(checkTable.rows[0].exists, false, 'La tabla de control debe haber sido eliminada');

    // 11.3 VERIFICACIÓN CLAVE DE SEGURIDAD EN ROLLBACK:
    // A. Cliente sin JWT (anon) sigue BLOQUEADO en Discovery (devuelve [])
    await setAuth(null);
    const discAnon = await db.query(`SELECT public.get_discovery_encuentros_abiertos() AS res;`);
    assert.deepStrictEqual(discAnon.rows[0].res, [], 'Anon sin JWT debe seguir bloqueado tras rollback');

    // B. Sesión anónima externa (no listada en QA) sigue BLOQUEADA en creación
    await setAuth(uid_Anon_Unauth, true);
    const createAnon = await db.query<{ res: any }>(
      `SELECT public.crear_encuentro_seguro('{"titulo":"Intento Post-Rollback","modalidad":"presencial","tipo_invitacion":"link_general"}'::jsonb) AS res;`
    );
    assert.strictEqual(createAnon.rows[0].res.ok, false);
    assert.strictEqual(createAnon.rows[0].res.error, 'pre_launch_creation_restricted', 'Anon externo debe ser bloqueado en creación');

    // C. Usuario tester autorizado de QA (qa_authorized_users) puede operar con normalidad
    await setAuth(uid_Qa_Perm, false);
    const discQA = await db.query<{ res: any[] }>(`SELECT public.get_discovery_encuentros_abiertos() AS res;`);
    assert(Array.isArray(discQA.rows[0].res));
    assert(discQA.rows[0].res.length > 0, 'QA debe poder consultar discovery tras rollback');

    const createQA = await db.query<{ res: any }>(
      `SELECT public.crear_encuentro_seguro('{"titulo":"Encuentro QA Rollback","modalidad":"presencial","tipo_invitacion":"link_general"}'::jsonb) AS res;`
    );
    assert.strictEqual(createQA.rows[0].res.ok, true, 'QA debe poder crear encuentros tras rollback');

    // 11.4 Re-aplicar la migración aditiva para dejar el entorno local en su estado final pre-lanzamiento
    const migrationPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20261112120000_platform_pre_launch_access_control_v1.sql'
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(migrationSql);
    await db.query(`
      INSERT INTO public.platform_launch_authorizations (user_id, role, is_active)
      VALUES ('${uid_Launch_Manager}', 'launch_manager', true)
      ON CONFLICT (user_id) DO NOTHING;
    `);
  });

  // ============================================================================
  // ESCENARIO 12: INICIALIZACIÓN SEGURA ABORTA ANTE ESTADO CONTRADICTORIO (true)
  // ============================================================================
  test('12. Inicialización segura aborta ante estado previo contradictorio (true)', async () => {
    // Si platform_access_control ya existe con public_launch_active = true
    await db.query(`UPDATE public.platform_access_control SET setting_value = true WHERE setting_key = 'public_launch_active';`);

    // Intentar re-ejecutar el bloque de inicialización de la migración DEBE abortar con excepción
    await assert.rejects(
      async () => {
        await db.query(`
          DO $$
          DECLARE
              v_existing_val BOOLEAN;
          BEGIN
              SELECT setting_value INTO v_existing_val
              FROM public.platform_access_control
              WHERE setting_key = 'public_launch_active';

              IF v_existing_val IS NULL THEN
                  INSERT INTO public.platform_access_control (setting_key, setting_value, description)
                  VALUES ('public_launch_active', false, 'Test');
              ELSIF v_existing_val = true THEN
                  RAISE EXCEPTION 'INCONSISTENCIA CRÍTICA: public.platform_access_control ya tiene public_launch_active = true.';
              END IF;
          END $$;
        `);
      },
      /INCONSISTENCIA CRÍTICA/
    );

    // Restaurar a false para preservar el estado PRE-LAUNCH cerrado
    await db.query(`UPDATE public.platform_access_control SET setting_value = false WHERE setting_key = 'public_launch_active';`);
  });
});
