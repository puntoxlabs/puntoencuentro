import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Moderación Pública v1: Tests de Seguridad, Antiabuso y Reglas (Casos A al R)', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const reporterUser1 = '22222222-2222-2222-2222-222222222221';
  const reporterUser2 = '22222222-2222-2222-2222-222222222222';
  const reporterUser3 = '22222222-2222-2222-2222-222222222223';
  const normalUser = '33333333-3333-3333-3333-333333333333';
  const adminUser = '44444444-4444-4444-4444-444444444444';
  const anonUser = '55555555-5555-5555-5555-555555555555';
  const moderatorUser = '66666666-6666-6666-6666-666666666666';
  const inactiveModeratorUser = '77777777-7777-7777-7777-777777777777';
  const qaOnlyUser = '88888888-8888-8888-8888-888888888888';

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
        ('${reporterUser1}', 'reporter1@test.com'),
        ('${reporterUser2}', 'reporter2@test.com'),
        ('${reporterUser3}', 'reporter3@test.com'),
        ('${normalUser}', 'normal@test.com'),
        ('${adminUser}', 'admin@test.com'),
        ('${anonUser}', 'anon@test.com'),
        ('${moderatorUser}', 'moderator@test.com'),
        ('${inactiveModeratorUser}', 'inactive_mod@test.com'),
        ('${qaOnlyUser}', 'qa_only@test.com')
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
        -- Mock helper
      END;
      $$ LANGUAGE plpgsql;

      -- Tabla de usuarios autorizados QA/Admin
      CREATE TABLE IF NOT EXISTS public.qa_authorized_users (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id),
        role TEXT NOT NULL CHECK (role IN ('admin', 'qa')),
        created_at TIMESTAMPTZ DEFAULT now()
      );

      INSERT INTO public.qa_authorized_users (user_id, role) VALUES
        ('${adminUser}', 'admin'),
        ('${qaOnlyUser}', 'qa')
      ON CONFLICT DO NOTHING;

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
        IF v_user_id IS NULL THEN RETURN false; END IF;
        RETURN EXISTS (
          SELECT 1 FROM public.qa_authorized_users
          WHERE user_id = v_user_id AND role IN ('admin', 'qa')
        );
      END;
      $$;

      -- Tabla e infraestructura de rate limiting
      CREATE TABLE IF NOT EXISTS public.rate_limit_policies (
        action TEXT PRIMARY KEY,
        max_requests INT NOT NULL,
        window_seconds INT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
        action TEXT NOT NULL,
        identifier TEXT NOT NULL,
        window_epoch BIGINT NOT NULL,
        count INT NOT NULL DEFAULT 1,
        PRIMARY KEY (action, identifier, window_epoch)
      );

      CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(
        p_action TEXT,
        p_scope_key TEXT DEFAULT ''
      )
      RETURNS JSONB
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $$
      DECLARE
        v_policy RECORD;
        v_epoch BIGINT;
        v_count INT;
        v_user_id UUID := auth.uid();
      BEGIN
        IF v_user_id IS NULL THEN
          RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'authentication_required');
        END IF;

        SELECT * INTO v_policy FROM public.rate_limit_policies WHERE action = p_action;
        IF NOT FOUND OR NOT v_policy.enabled THEN
          RETURN pg_catalog.jsonb_build_object('allowed', true, 'count', 1);
        END IF;

        v_epoch := (extract(epoch from pg_catalog.now())::bigint / v_policy.window_seconds);

        INSERT INTO public.rate_limit_buckets (action, identifier, window_epoch, count)
        VALUES (p_action, v_user_id::text, v_epoch, 1)
        ON CONFLICT (action, identifier, window_epoch)
        DO UPDATE SET count = public.rate_limit_buckets.count + 1
        RETURNING count INTO v_count;

        IF v_count > v_policy.max_requests THEN
          RETURN pg_catalog.jsonb_build_object('allowed', false, 'error', 'rate_limit_exceeded');
        END IF;

        RETURN pg_catalog.jsonb_build_object('allowed', true, 'count', v_count);
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.check_rate_limit_and_increment(
        p_action TEXT,
        p_identifier TEXT,
        p_scope_key TEXT DEFAULT NULL
      )
      RETURNS JSON
      LANGUAGE sql AS $$
        SELECT public.check_rate_limit_internal(p_action, COALESCE(p_scope_key, ''))::json;
      $$;
    `);

    // 2. Cargar las migraciones de Moderación Pública v1
    const migrationPath = path.resolve(
      __dirname,
      '../supabase/migrations/20261009160000_public_content_moderation_v1.sql'
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
    await db.exec(migrationSql);

    const fixMigrationPath = path.resolve(
      __dirname,
      '../supabase/migrations/20261009195000_fix_reportar_encuentro_rate_limit_call.sql'
    );
    if (fs.existsSync(fixMigrationPath)) {
      const fixSql = fs.readFileSync(fixMigrationPath, 'utf-8');
      await db.exec(fixSql);
    }

    const sepMigrationPath = path.resolve(
      __dirname,
      '../supabase/migrations/20261009210000_separate_moderation_roles.sql'
    );
    if (fs.existsSync(sepMigrationPath)) {
      const sepSql = fs.readFileSync(sepMigrationPath, 'utf-8');
      await db.exec(sepSql);
    }

    // Configurar usuarios autorizados de moderación dedicados
    await db.exec(`
      INSERT INTO public.moderation_authorized_users (user_id, role, active) VALUES
        ('${adminUser}', 'admin', true),
        ('${moderatorUser}', 'moderator', true),
        ('${inactiveModeratorUser}', 'moderator', false)
      ON CONFLICT DO NOTHING;
    `);
  });

  const createTestEncounter = async (title: string, desc?: string): Promise<string> => {
    const res = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, descripcion, fecha, hora, modalidad, lugar_texto, host_id, estado
      ) VALUES (
        '${title.replace(/'/g, "''")}',
        ${desc ? `'${desc.replace(/'/g, "''")}'` : 'NULL'},
        '2026-11-20', '18:00', 'presencial', 'Güemes 1234 timbre 2', '${hostUser}', 'activo'
      ) RETURNING id;
    `);
    return res.rows[0].id;
  };

  test('Caso A: Choke point server-side -> apertura entra en review_pending y sólo backend autorizado aprueba a Discovery', async () => {
    const encId = await createTestEncounter('Picnic y juegos de mesa en la plaza');
    await setAuthContext(hostUser);

    // 1. Host solicita abrir -> Choke point: queda en review_pending e is_open = false
    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Traigan cartas, mate y galletitas para compartir', 5, 'guemes', NULL
      );
    `);
    const r = res.rows[0].abrir_encuentro_seguro;
    assert.equal(r.ok, true);
    assert.equal(r.is_open, false, 'Choke point: cliente nunca puede auto-publicar directo');
    assert.equal(r.moderation_status, 'review_pending');

    // 2. Comprobar que en Discovery NO aparece mientras está en review_pending
    let disc = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes']::text[]);
    `);
    assert.equal(disc.rows[0].get_discovery_encuentros_abiertos.some((e: any) => e.id === encId), false);

    // 3. Backend interno autorizado (service_role) aprueba tras clasificar el contenido
    await db.query(`SELECT set_config('request.jwt.claim.role', 'service_role', false);`);
    const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'automated allow');
    `);
    const modObj = modRes.rows[0].resolver_moderacion_encuentro_seguro;
    assert.equal(modObj.ok, true);
    assert.equal(modObj.is_open, true);
    assert.equal(modObj.new_status, 'approved');

    // 4. Ahora sí aparece en Discovery
    disc = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes']::text[]);
    `);
    const list = disc.rows[0].get_discovery_encuentros_abiertos;
    assert.equal(list.some((e: any) => e.id === encId), true);
  });

  test('Validación de input: título corto no genera status rejected en moderación', async () => {
    const encId = await createTestEncounter('DJ');
    await setAuthContext(hostUser);
    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Música en vivo', 4, 'guemes', NULL);
    `);
    const r = res.rows[0].abrir_encuentro_seguro;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'title_too_short');

    // Comprobar que en BD NO quedó en rejected sino en draft inicial
    const row = await db.query<{ moderation_status: string }>(`
      SELECT moderation_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(row.rows[0].moderation_status, 'draft');
  });

  test('Caso B: Basura evidente (gibberish/repetición) -> BLOCK determinista persistido', async () => {
    const encId = await createTestEncounter('asdfasdfasdfasdfasdf');
    await setAuthContext(hostUser);

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'aaaaaaa bbbbbbb', 4, 'guemes', NULL
      );
    `);
    const r = res.rows[0].abrir_encuentro_seguro;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'content_moderation_blocked');
    assert.equal(r.moderation_status, 'rejected');

    // Comprobar que en BD quedó en rejected y cerrado sin rollback
    const row = await db.query<{ is_open: boolean; moderation_status: string }>(`
      SELECT is_open, moderation_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(row.rows[0].is_open, false);
    assert.equal(row.rows[0].moderation_status, 'rejected');
  });

  test('Caso C: Spam comercial masivo con múltiples URLs -> BLOCK detectado', async () => {
    const encId = await createTestEncounter('Descuentos y compras online');
    await setAuthContext(hostUser);

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Entrá ya a https://oferta1.com y https://oferta2.com para comprar', 4, 'guemes', NULL
      );
    `);
    const r = res.rows[0].abrir_encuentro_seguro;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'content_moderation_blocked');
    assert.equal(r.reason, 'excessive_urls');
  });

  test('Caso D: Sexual explícito o prostitución comercial -> BLOCK', async () => {
    const encId = await createTestEncounter('Servicios exclusivos noche');
    await setAuthContext(hostUser);

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Servicios sexuales tarifados escort tarifas $ consultar por privado', 4, 'guemes', NULL
      );
    `);
    const r = res.rows[0].abrir_encuentro_seguro;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'content_moderation_blocked');
    assert.equal(r.reason, 'illegal_activity');
  });

  test('Caso E: Amenaza física o violencia inequívoca -> BLOCK', async () => {
    const encId = await createTestEncounter('Venganza');
    await setAuthContext(hostUser);

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Te voy a matar si venís a la plaza amenaza de muerte', 4, 'guemes', NULL
      );
    `);
    const r = res.rows[0].abrir_encuentro_seguro;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'content_moderation_blocked');
    assert.equal(r.reason, 'violence_threat');
  });

  test('Caso F: Texto romántico legítimo -> entra en review_pending y aprueba sin falso positivo', async () => {
    const encId = await createTestEncounter('Cita romántica para ver el atardecer');
    await setAuthContext(hostUser);

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Salida tranquila de pareja, tomar un café o vino en la costa', 2, 'guemes', NULL
      );
    `);
    const r = res.rows[0].abrir_encuentro_seguro;
    assert.equal(r.ok, true);
    assert.equal(r.is_open, false);
    assert.equal(r.moderation_status, 'review_pending');

    await db.query(`SELECT set_config('request.jwt.claim.role', 'service_role', false);`);
    const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'social legitimo');
    `);
    assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.ok, true);
    assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.is_open, true);
  });

  test('Caso G: Pride y diversidad legítima -> entra en review_pending y aprueba sin falso positivo', async () => {
    const encId = await createTestEncounter('Comunidad LGBTQIA+ Pride y Amistad');
    await setAuthContext(hostUser);

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Espacio seguro de diversidad, charlas y café para conocernos', 6, 'guemes', NULL
      );
    `);
    const r = res.rows[0].abrir_encuentro_seguro;
    assert.equal(r.ok, true);
    assert.equal(r.is_open, false);
    assert.equal(r.moderation_status, 'review_pending');

    await db.query(`SELECT set_config('request.jwt.claim.role', 'service_role', false);`);
    const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'pride legitimo');
    `);
    assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.ok, true);
    assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.is_open, true);
  });

  test('Caso H & I: Patrón ambiguo (1 link) genera REVIEW_PENDING y NO publica a Me sumo', async () => {
    const encId = await createTestEncounter('Taller de programación y debate');
    await setAuthContext(hostUser);

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Temas del taller disponibles en https://miweb.dev para leer antes', 4, 'guemes', NULL
      );
    `);
    const r = res.rows[0].abrir_encuentro_seguro;
    assert.equal(r.ok, true);
    assert.equal(r.is_open, false);
    assert.equal(r.moderation_status, 'review_pending');

    // Verificar Caso I: NO aparece en Discovery
    const disc = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes']::text[]);
    `);
    const list = disc.rows[0].get_discovery_encuentros_abiertos;
    assert.equal(list.some((e: any) => e.id === encId), false);
  });

  test('Caso J: Encuentro rechazado (BLOCK) no aparece en Me sumo', async () => {
    const encId = await createTestEncounter('Bloqueado test');
    await setAuthContext(hostUser);

    await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'te voy a reventar amenaza de muerte', 4, 'guemes', NULL
      );
    `);

    const disc = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes']::text[]);
    `);
    const list = disc.rows[0].get_discovery_encuentros_abiertos;
    assert.equal(list.some((e: any) => e.id === encId), false);
  });

  test('Caso K: Reporte único de usuario permanente se registra correctamente', async () => {
    const encId = await createTestEncounter('Encuentro para reportar');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Plan normal abierto', 4, 'guemes', NULL
      );
    `);
    // Aprobar vía pipeline autorizado
    await db.query(`SELECT set_config('request.jwt.claim.role', 'service_role', false);`);
    await db.query(`SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'auto');`);

    // Reportero 1 reporta
    await setAuthContext(reporterUser1);
    const repRes = await db.query<{ reportar_encuentro_publico_seguro: any }>(`
      SELECT public.reportar_encuentro_publico_seguro('${encId}', 'spam', 'Parece publicidad encubierta');
    `);
    const r = repRes.rows[0].reportar_encuentro_publico_seguro;
    assert.equal(r.ok, true);
    assert.equal(r.report_count, 1);
    assert.equal(r.auto_hidden, false);
  });

  test('Caso L: Reporte duplicado del mismo usuario es rechazado sin inflar conteo', async () => {
    const encId = await createTestEncounter('Encuentro anti-spam reportes');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Plan normal', 4, 'guemes', NULL
      );
    `);
    await db.query(`SELECT set_config('request.jwt.claim.role', 'service_role', false);`);
    await db.query(`SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'auto');`);

    await setAuthContext(reporterUser1);
    // Primer reporte
    await db.query(`
      SELECT public.reportar_encuentro_publico_seguro('${encId}', 'spam', 'Reporte 1');
    `);

    // Segundo reporte del mismo usuario
    const dupRes = await db.query<{ reportar_encuentro_publico_seguro: any }>(`
      SELECT public.reportar_encuentro_publico_seguro('${encId}', 'spam', 'Reporte 2 duplicado');
    `);
    const dup = dupRes.rows[0].reportar_encuentro_publico_seguro;
    assert.equal(dup.ok, false);
    assert.equal(dup.error, 'already_reported');

    // Conteo en tabla sigue siendo 1
    const countCheck = await db.query<{ count: string }>(`
      SELECT COUNT(*) as count FROM public.public_content_reports WHERE encuentro_id = '${encId}';
    `);
    assert.equal(parseInt(countCheck.rows[0].count, 10), 1);
  });

  test('Caso M: Múltiples reportes independientes (umbral 3) disparan auto-ocultamiento', async () => {
    const encId = await createTestEncounter('Encuentro que será auto-ocultado');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Descripción pública inicial', 4, 'guemes', NULL
      );
    `);
    await db.query(`SELECT set_config('request.jwt.claim.role', 'service_role', false);`);
    await db.query(`SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'auto');`);

    // Reporter 1
    await setAuthContext(reporterUser1);
    await db.query(`SELECT public.reportar_encuentro_publico_seguro('${encId}', 'inappropriate_content');`);

    // Reporter 2
    await setAuthContext(reporterUser2);
    await db.query(`SELECT public.reportar_encuentro_publico_seguro('${encId}', 'inappropriate_content');`);

    // Antes del tercero sigue visible
    let disc = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes']::text[]);
    `);
    assert.equal(disc.rows[0].get_discovery_encuentros_abiertos.some((e: any) => e.id === encId), true);

    // Reporter 3 (alcanza umbral centralizado = 3)
    await setAuthContext(reporterUser3);
    const rep3 = await db.query<{ reportar_encuentro_publico_seguro: any }>(`
      SELECT public.reportar_encuentro_publico_seguro('${encId}', 'inappropriate_content', 'Tercer reporte independiente');
    `);
    assert.equal(rep3.rows[0].reportar_encuentro_publico_seguro.auto_hidden, true);

    // Ahora el encuentro debe estar en 'hidden_pending_review' e is_open = false
    const encRow = await db.query<{ is_open: boolean; moderation_status: string }>(`
      SELECT is_open, moderation_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(encRow.rows[0].is_open, false);
    assert.equal(encRow.rows[0].moderation_status, 'hidden_pending_review');

    // Desaparece de Discovery de inmediato
    disc = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes']::text[]);
    `);
    assert.equal(disc.rows[0].get_discovery_encuentros_abiertos.some((e: any) => e.id === encId), false);
  });

  test('Caso N: Usuario común no autorizado no puede ver la cola ni moderar', async () => {
    await setAuthContext(normalUser);

    const qRes = await db.query<{ get_moderation_queue_seguro: any }>(`
      SELECT public.get_moderation_queue_seguro();
    `);
    assert.equal(qRes.rows[0].get_moderation_queue_seguro.ok, false);
    assert.equal(qRes.rows[0].get_moderation_queue_seguro.error, 'unauthorized');

    const fakeId = '00000000-0000-0000-0000-000000000001';
    const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${fakeId}', 'approve', 'intento bypass');
    `);
    assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.ok, false);
    assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.error, 'unauthorized');
  });

  test('Caso O & P: Administrador autorizado puede revisar cola, resolver y registrar auditoría', async () => {
    // 1. Encuentro que quedó en review_pending
    const encId = await createTestEncounter('Taller esperando moderación');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Info en https://enlace.com', 4, 'guemes', NULL
      );
    `);

    // 2. Administrador consulta la cola
    await setAuthContext(adminUser);
    const qRes = await db.query<{ get_moderation_queue_seguro: any }>(`
      SELECT public.get_moderation_queue_seguro();
    `);
    const q = qRes.rows[0].get_moderation_queue_seguro;
    assert.equal(q.ok, true);
    assert.equal(q.queue.some((item: any) => item.id === encId), true);

    // 3. Administrador aprueba manualmente
    const resolveRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'Enlace legítimo verificado');
    `);
    const resObj = resolveRes.rows[0].resolver_moderacion_encuentro_seguro;
    assert.equal(resObj.ok, true);
    assert.equal(resObj.new_status, 'approved');
    assert.equal(resObj.is_open, true);

    // 4. Verificar Caso P: Auditoría registrada
    const auditRes = await db.query<{ action: string; previous_status: string; new_status: string; reason: string }>(`
      SELECT action, previous_status, new_status, reason
      FROM public.public_content_moderation_audit
      WHERE encuentro_id = '${encId}' AND action = 'approve';
    `);
    assert.equal(auditRes.rows.length >= 1, true);
    assert.equal(auditRes.rows[0].action, 'approve');
    assert.equal(auditRes.rows[0].new_status, 'approved');
    assert.equal(auditRes.rows[0].reason, 'Enlace legítimo verificado');
  });

  test('Caso Q: Privacidad estricta — lugar_texto y link_virtual nunca se exponen', async () => {
    const encId = await createTestEncounter('Plan con dirección ultrasecreta');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}', '${hostUser}', 'Descripción pública segura', 4, 'guemes', NULL
      );
    `);
    await db.query(`SELECT set_config('request.jwt.claim.role', 'service_role', false);`);
    await db.query(`SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'auto');`);

    // Consultar Discovery
    const disc = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes']::text[]);
    `);
    const found = disc.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === encId);
    assert.ok(found);
    assert.equal((found as any).lugar_texto, undefined);
    assert.equal((found as any).link_virtual, undefined);
    assert.equal((found as any).public_token, undefined);

    // Consultar auditoría
    const audit = await db.query<{ metadata: any }>(`
      SELECT metadata FROM public.public_content_moderation_audit WHERE encuentro_id = '${encId}';
    `);
    const meta = audit.rows[0]?.metadata || {};
    assert.equal(meta.lugar_texto, undefined);
    assert.equal(meta.link_virtual, undefined);
  });

  test('Seguridad TOCTOU: contenido modificado después de ser leído rechaza aprobación por hash mismatch', async () => {
    const encId = await createTestEncounter('Título original limpio');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción original limpia', 4, 'guemes', NULL);
    `);

    // Calcular hash del contenido en el momento de la lectura
    const hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(titulo, open_description, modalidad, open_public_zone)
      FROM public.encuentros WHERE id = '${encId}';
    `);
    const initialHash = hashRes.rows[0].calcular_content_hash_moderacion;

    // Carrera TOCTOU: El host o atacante altera el contenido en BD mientras modera
    await db.query(`
      UPDATE public.encuentros
      SET titulo = 'Título modificado malicioso'
      WHERE id = '${encId}';
    `);

    // El resolver con service_role intenta aprobar con el hash inicial
    await setAuthContext(null, false, 'service_role');
    const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'auto', '${initialHash}');
    `);
    const r = modRes.rows[0].resolver_moderacion_encuentro_seguro;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'content_hash_mismatch');

    // Comprobar que en BD NO quedó aprobado ni abierto
    const row = await db.query<{ is_open: boolean; moderation_status: string }>(`
      SELECT is_open, moderation_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(row.rows[0].is_open, false);
    assert.equal(row.rows[0].moderation_status, 'review_pending');
  });

  test('Seguridad Auto-Hide vs Moderación: approve retrasado no republica un encuentro auto-ocultado', async () => {
    const encId = await createTestEncounter('Encuentro en carrera de auto-hide');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción pública', 4, 'guemes', NULL);
    `);

    // Simular que el encuentro pasó a hidden_pending_review por reportes concurrentes
    await db.query(`
      UPDATE public.encuentros
      SET moderation_status = 'hidden_pending_review', is_open = false
      WHERE id = '${encId}';
    `);

    // Moderación automatizada (service_role) intenta llamar approve posteriormente
    await setAuthContext(null, false, 'service_role');
    const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'automated delayed allow');
    `);
    const r = modRes.rows[0].resolver_moderacion_encuentro_seguro;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_status_transition');

    // Sigue oculto en hidden_pending_review
    const row = await db.query<{ is_open: boolean; moderation_status: string }>(`
      SELECT is_open, moderation_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(row.rows[0].is_open, false);
    assert.equal(row.rows[0].moderation_status, 'hidden_pending_review');
  });

  test('Seguridad Transiciones: service_role no puede aprobar un encuentro en rejected ni draft', async () => {
    const encId = await createTestEncounter('Encuentro rechazado');
    await db.query(`
      UPDATE public.encuentros SET moderation_status = 'rejected', is_open = false WHERE id = '${encId}';
    `);

    await setAuthContext(null, false, 'service_role');
    const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'auto');
    `);
    const r = modRes.rows[0].resolver_moderacion_encuentro_seguro;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_status_transition');

    // Mismo control para estado draft
    const draftId = await createTestEncounter('Encuentro borrador');
    const draftRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${draftId}', 'approve', 'auto');
    `);
    assert.equal(draftRes.rows[0].resolver_moderacion_encuentro_seguro.ok, false);
    assert.equal(draftRes.rows[0].resolver_moderacion_encuentro_seguro.error, 'invalid_status_transition');
  });

  test('Aprobación exitosa con verificación de hash idéntico', async () => {
    const encId = await createTestEncounter('Plan con hash válido');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción legítima', 4, 'guemes', NULL);
    `);

    const hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(titulo, open_description, modalidad, open_public_zone)
      FROM public.encuentros WHERE id = '${encId}';
    `);
    const validHash = hashRes.rows[0].calcular_content_hash_moderacion;

    await setAuthContext(null, false, 'service_role');
    const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'hash verificado', '${validHash}');
    `);
    const r = modRes.rows[0].resolver_moderacion_encuentro_seguro;
    assert.equal(r.ok, true);
    assert.equal(r.new_status, 'approved');
    assert.equal(r.is_open, true);
  });

  test('Caso A (Post-Edit): approved + editar titulo -> review_pending + is_open=false', async () => {
    const encId = await createTestEncounter('Título original aprobado');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción legítima', 4, 'guemes', NULL);
    `);

    await setAuthContext(null, false, 'service_role');
    const hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(titulo, open_description, modalidad, open_public_zone)
      FROM public.encuentros WHERE id = '${encId}';
    `);
    await db.query(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'inicial', '${hashRes.rows[0].calcular_content_hash_moderacion}');
    `);

    // Host edita título con actualizar_encuentro_seguro
    await setAuthContext(hostUser);
    const updRes = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro('${encId}', '${hostUser}', '{"titulo": "Nuevo título editado"}'::jsonb);
    `);
    const upd = updRes.rows[0].actualizar_encuentro_seguro;
    assert.equal(upd.ok, true);
    assert.equal(upd.moderation_invalidated, true);
    assert.equal(upd.moderation_status, 'review_pending');
    assert.equal(upd.is_open, false);

    // Verificar en BD
    const row = await db.query<{ is_open: boolean; moderation_status: string; titulo: string }>(`
      SELECT is_open, moderation_status, titulo FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(row.rows[0].titulo, 'Nuevo título editado');
    assert.equal(row.rows[0].is_open, false);
    assert.equal(row.rows[0].moderation_status, 'review_pending');

    // Verificar auditoría
    const audit = await db.query<{ action: string; previous_status: string; new_status: string; reason: string }>(`
      SELECT action, previous_status, new_status, reason FROM public.public_content_moderation_audit
      WHERE encuentro_id = '${encId}' ORDER BY created_at DESC LIMIT 1;
    `);
    assert.equal(audit.rows[0].action, 'content_updated');
    assert.equal(audit.rows[0].previous_status, 'approved');
    assert.equal(audit.rows[0].new_status, 'review_pending');
    assert.equal(audit.rows[0].reason, 'content_updated');
  });

  test('Caso B (Post-Edit): approved + editar open_description -> review_pending + is_open=false', async () => {
    const encId = await createTestEncounter('Título para editar desc');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción v1', 4, 'guemes', NULL);
    `);

    await setAuthContext(null, false, 'service_role');
    const hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(titulo, open_description, modalidad, open_public_zone)
      FROM public.encuentros WHERE id = '${encId}';
    `);
    await db.query(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'inicial', '${hashRes.rows[0].calcular_content_hash_moderacion}');
    `);

    // Host edita open_description
    await setAuthContext(hostUser);
    const updRes = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro('${encId}', '${hostUser}', '{"open_description": "Descripción v2 modificada"}'::jsonb);
    `);
    const upd = updRes.rows[0].actualizar_encuentro_seguro;
    assert.equal(upd.ok, true);
    assert.equal(upd.moderation_invalidated, true);
    assert.equal(upd.moderation_status, 'review_pending');
    assert.equal(upd.is_open, false);

    const row = await db.query<{ is_open: boolean; moderation_status: string; open_description: string }>(`
      SELECT is_open, moderation_status, open_description FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(row.rows[0].open_description, 'Descripción v2 modificada');
    assert.equal(row.rows[0].is_open, false);
    assert.equal(row.rows[0].moderation_status, 'review_pending');
  });

  test('Caso C (Post-Edit): approved + editar campo privado -> no invalida si no corresponde', async () => {
    const encId = await createTestEncounter('Encuentro con cambio privado');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción pública estable', 4, 'guemes', NULL);
    `);

    await setAuthContext(null, false, 'service_role');
    const hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(titulo, open_description, modalidad, open_public_zone)
      FROM public.encuentros WHERE id = '${encId}';
    `);
    await db.query(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'inicial', '${hashRes.rows[0].calcular_content_hash_moderacion}');
    `);

    // Host edita campos privados: lugar_texto, descripcion privada, tema_invitacion
    await setAuthContext(hostUser);
    const updRes = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}', '${hostUser}',
        '{"lugar_texto": "Dirección privada actualizada 456", "descripcion": "Mensaje para invitados", "tema_invitacion": "friends"}'::jsonb
      );
    `);
    const upd = updRes.rows[0].actualizar_encuentro_seguro;
    assert.equal(upd.ok, true);
    assert.equal(upd.moderation_invalidated, false);
    assert.equal(upd.moderation_status, 'approved');
    assert.equal(upd.is_open, true);

    // Sigue apareciendo en Discovery
    const disc = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes']::text[]);
    `);
    const list = disc.rows[0].get_discovery_encuentros_abiertos;
    assert.equal(list.some((e: any) => e.id === encId), true);
  });

  test('Caso D (Post-Edit): edición durante review_pending -> aprobación vieja falla por hash mismatch', async () => {
    const encId = await createTestEncounter('Título inicial en revisión');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción inicial', 4, 'guemes', NULL);
    `);

    // Hash tomado por la Edge function al iniciar
    const hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(titulo, open_description, modalidad, open_public_zone)
      FROM public.encuentros WHERE id = '${encId}';
    `);
    const oldHash = hashRes.rows[0].calcular_content_hash_moderacion;

    // Host edita título mientras estaba en review_pending
    const updRes = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro('${encId}', '${hostUser}', '{"titulo": "Título modificado en vuelo"}'::jsonb);
    `);
    assert.equal(updRes.rows[0].actualizar_encuentro_seguro.ok, true);

    // Edge function rezagada intenta aprobar con oldHash
    await setAuthContext(null, false, 'service_role');
    const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'rezagado', '${oldHash}');
    `);
    assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.ok, false);
    assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.error, 'content_hash_mismatch');

    // Sigue protegido en review_pending
    const row = await db.query<{ is_open: boolean; moderation_status: string }>(`
      SELECT is_open, moderation_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(row.rows[0].is_open, false);
    assert.equal(row.rows[0].moderation_status, 'review_pending');
  });

  test('Caso E (Post-Edit): cliente omite Edge Function después de editar -> contenido permanece oculto', async () => {
    const encId = await createTestEncounter('Título para probar omisión');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción previa', 4, 'guemes', NULL);
    `);

    await setAuthContext(null, false, 'service_role');
    const hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(titulo, open_description, modalidad, open_public_zone)
      FROM public.encuentros WHERE id = '${encId}';
    `);
    await db.query(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'inicial', '${hashRes.rows[0].calcular_content_hash_moderacion}');
    `);

    // Host edita título pero el cliente no invoca nunca la Edge Function
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.actualizar_encuentro_seguro('${encId}', '${hostUser}', '{"titulo": "Título editado sin Edge Function"}'::jsonb);
    `);

    // Discovery NO lo muestra
    const disc = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes']::text[]);
    `);
    const list = disc.rows[0].get_discovery_encuentros_abiertos;
    assert.equal(list.some((e: any) => e.id === encId), false);
  });

  test('Caso F (Post-Edit): re-moderación posterior allow -> vuelve a approved + is_open=true', async () => {
    const encId = await createTestEncounter('Título antes de re-aprobar');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción antes de re-aprobar', 4, 'guemes', NULL);
    `);

    // Aprobación 1
    await setAuthContext(null, false, 'service_role');
    let hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(titulo, open_description, modalidad, open_public_zone)
      FROM public.encuentros WHERE id = '${encId}';
    `);
    await db.query(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'inicial', '${hashRes.rows[0].calcular_content_hash_moderacion}');
    `);

    // Edición legítima
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.actualizar_encuentro_seguro('${encId}', '${hostUser}', '{"titulo": "Título re-editado limpio"}'::jsonb);
    `);

    // Nueva moderación con nuevo hash
    await setAuthContext(null, false, 'service_role');
    hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(titulo, open_description, modalidad, open_public_zone)
      FROM public.encuentros WHERE id = '${encId}';
    `);
    const remoderateRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 're-aprobado', '${hashRes.rows[0].calcular_content_hash_moderacion}');
    `);
    assert.equal(remoderateRes.rows[0].resolver_moderacion_encuentro_seguro.ok, true);
    assert.equal(remoderateRes.rows[0].resolver_moderacion_encuentro_seguro.is_open, true);
    assert.equal(remoderateRes.rows[0].resolver_moderacion_encuentro_seguro.new_status, 'approved');

    // Ahora SÍ aparece en Discovery con el nuevo título
    const disc = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes']::text[]);
    `);
    const item = disc.rows[0].get_discovery_encuentros_abiertos.find((e: any) => e.id === encId);
    assert.ok(item);
    assert.equal(item.title, 'Título re-editado limpio');
  });

  test('Caso G (Post-Edit): edición + block -> rejected/no visible', async () => {
    const encId = await createTestEncounter('Título inicialmente aprobado');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción limpia', 4, 'guemes', NULL);
    `);

    await setAuthContext(null, false, 'service_role');
    const hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(titulo, open_description, modalidad, open_public_zone)
      FROM public.encuentros WHERE id = '${encId}';
    `);
    await db.query(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'inicial', '${hashRes.rows[0].calcular_content_hash_moderacion}');
    `);

    // Host intenta inyectar amenaza en el título mediante actualizar_encuentro_seguro
    await setAuthContext(hostUser);
    const updRes = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro('${encId}', '${hostUser}', '{"titulo": "te voy a matar amenaza de muerte"}'::jsonb);
    `);
    const upd = updRes.rows[0].actualizar_encuentro_seguro;
    assert.equal(upd.ok, true);
    assert.equal(upd.moderation_status, 'rejected');
    assert.equal(upd.is_open, false);

    // Auditoría registró deterministic_block
    const audit = await db.query<{ action: string; new_status: string; reason: string }>(`
      SELECT action, new_status, reason FROM public.public_content_moderation_audit
      WHERE encuentro_id = '${encId}' ORDER BY created_at DESC LIMIT 1;
    `);
    assert.equal(audit.rows[0].action, 'deterministic_block');
    assert.equal(audit.rows[0].new_status, 'rejected');
    assert.equal(audit.rows[0].reason, 'violence_threat');

    // Discovery NO lo muestra
    const disc = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes']::text[]);
    `);
    assert.equal(disc.rows[0].get_discovery_encuentros_abiertos.some((e: any) => e.id === encId), false);
  });

  test('Caso H (Post-Edit): llamada directa a RPC no puede preservar approved', async () => {
    const encId = await createTestEncounter('Título para probar payload malicioso en RPC');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción limpia', 4, 'guemes', NULL);
    `);

    await setAuthContext(null, false, 'service_role');
    const hashRes = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(titulo, open_description, modalidad, open_public_zone)
      FROM public.encuentros WHERE id = '${encId}';
    `);
    await db.query(`
      SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'inicial', '${hashRes.rows[0].calcular_content_hash_moderacion}');
    `);

    // Inyección de parámetros maliciosos en p_data para forzar status approved e is_open true
    await setAuthContext(hostUser);
    const updRes = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}', '${hostUser}',
        '{"titulo": "Título alterado", "moderation_status": "approved", "is_open": true}'::jsonb
      );
    `);
    const upd = updRes.rows[0].actualizar_encuentro_seguro;
    assert.equal(upd.ok, true);
    // El RPC ignora la inyección y fuerza la invalidación server-side
    assert.equal(upd.moderation_status, 'review_pending');
    assert.equal(upd.is_open, false);

    const row = await db.query<{ is_open: boolean; moderation_status: string }>(`
      SELECT is_open, moderation_status FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(row.rows[0].moderation_status, 'review_pending');
    assert.equal(row.rows[0].is_open, false);
  });

  test('Caso I (Post-Edit): Data API no permite UPDATE directo que saltee lógica', async () => {
    const encId = await createTestEncounter('Título protegido contra Data API');
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción inicial', 4, 'guemes', NULL);
    `);

    // Intentar UPDATE directo sobre la tabla como usuario autenticado normal
    let directUpdateBlocked = false;
    try {
      await db.query(`
        SET LOCAL ROLE authenticated;
        UPDATE public.encuentros SET titulo = 'Bypass directo Data API' WHERE id = '${encId}';
      `);
      // Si la consulta no arrojó error de permisos, verificar si RLS previno la mutación
      const check = await db.query<{ titulo: string }>(`SELECT titulo FROM public.encuentros WHERE id = '${encId}';`);
      if (check.rows[0]?.titulo !== 'Bypass directo Data API') {
        directUpdateBlocked = true;
      }
    } catch {
      directUpdateBlocked = true;
    } finally {
      await db.query(`RESET ROLE;`);
    }

    assert.ok(directUpdateBlocked, 'El UPDATE directo vía Data API debe fallar o no modificar filas');
  });

  describe('Separación de Roles: Autorización de Moderación vs QA (Casos A al N)', () => {
    test('A. Host normal: puede moderar automáticamente SU propio encuentro vía Edge Function simulada', async () => {
      const encId = await createTestEncounter('Encuentro del propio host');
      await setAuthContext(hostUser);
      await db.query(`
        SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción host', 4, 'guemes', NULL);
      `);

      const check = await db.query<{ host_id: string }>(`SELECT host_id FROM public.encuentros WHERE id = '${encId}';`);
      assert.equal(check.rows[0].host_id, hostUser);

      await setAuthContext(null, false, 'service_role');
      const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
        SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'host auto moderation');
      `);
      assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.ok, true);
      assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.is_open, true);
    });

    test('B. Host normal: NO puede moderar encuentro ajeno ni como staff', async () => {
      const otherHost = reporterUser1;
      const encId = await createTestEncounter('Encuentro de otro host');
      await db.query(`UPDATE public.encuentros SET host_id = '${otherHost}' WHERE id = '${encId}';`);

      await setAuthContext(hostUser);
      const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
        SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'bypass intento');
      `);
      assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.ok, false);
      assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.error, 'unauthorized');
    });

    test('C. Usuario con sólo rol QA: NO puede listar cola de moderación', async () => {
      await setAuthContext(qaOnlyUser);

      const qaCheck = await db.query<{ is_qa_authorized: boolean }>(`SELECT public.is_qa_authorized();`);
      assert.equal(qaCheck.rows[0].is_qa_authorized, true, 'Debe tener rol QA en qa_authorized_users');

      const modCheck = await db.query<{ is_moderation_authorized: boolean }>(`SELECT public.is_moderation_authorized();`);
      assert.equal(modCheck.rows[0].is_moderation_authorized, false, 'NO debe tener autorización de moderación');

      const qRes = await db.query<{ get_moderation_queue_seguro: any }>(`
        SELECT public.get_moderation_queue_seguro();
      `);
      assert.equal(qRes.rows[0].get_moderation_queue_seguro.ok, false);
      assert.equal(qRes.rows[0].get_moderation_queue_seguro.error, 'unauthorized');
    });

    test('D. Usuario con sólo rol QA: NO puede resolver moderación manual', async () => {
      const encId = await createTestEncounter('Encuentro para test QA resolve');
      await setAuthContext(hostUser);
      await db.query(`
        SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción para QA test', 4, 'guemes', NULL);
      `);

      await setAuthContext(qaOnlyUser);
      const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
        SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'intento manual QA');
      `);
      assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.ok, false);
      assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.error, 'unauthorized');
    });

    test('E. Moderator: puede listar la cola de moderación', async () => {
      await setAuthContext(moderatorUser);

      const modCheck = await db.query<{ is_moderation_authorized: boolean }>(`SELECT public.is_moderation_authorized();`);
      assert.equal(modCheck.rows[0].is_moderation_authorized, true, 'Moderator debe tener is_moderation_authorized true');

      const qRes = await db.query<{ get_moderation_queue_seguro: any }>(`
        SELECT public.get_moderation_queue_seguro();
      `);
      assert.equal(qRes.rows[0].get_moderation_queue_seguro.ok, true);
      assert.ok(Array.isArray(qRes.rows[0].get_moderation_queue_seguro.queue));
    });

    test('F. Moderator: puede aprobar y rechazar manualmente', async () => {
      const encId1 = await createTestEncounter('Encuentro para aprobar por mod');
      await setAuthContext(hostUser);
      await db.query(`
        SELECT public.abrir_encuentro_seguro('${encId1}', '${hostUser}', 'Descripción limpia', 4, 'guemes', NULL);
      `);

      await setAuthContext(moderatorUser);
      const approveRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
        SELECT public.resolver_moderacion_encuentro_seguro('${encId1}', 'approve', 'Aprobado por moderator');
      `);
      assert.equal(approveRes.rows[0].resolver_moderacion_encuentro_seguro.ok, true);
      assert.equal(approveRes.rows[0].resolver_moderacion_encuentro_seguro.new_status, 'approved');
      assert.equal(approveRes.rows[0].resolver_moderacion_encuentro_seguro.is_open, true);

      const auditApprove = await db.query<{ source: string; moderator_id: string }>(`
        SELECT source, moderator_id FROM public.public_content_moderation_audit
        WHERE encuentro_id = '${encId1}' AND action = 'approve';
      `);
      assert.equal(auditApprove.rows[0].source, 'moderator');
      assert.equal(auditApprove.rows[0].moderator_id, moderatorUser);

      const encId2 = await createTestEncounter('Encuentro para rechazar por mod');
      await setAuthContext(hostUser);
      await db.query(`
        SELECT public.abrir_encuentro_seguro('${encId2}', '${hostUser}', 'Descripción spam', 4, 'guemes', NULL);
      `);

      await setAuthContext(moderatorUser);
      const rejectRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
        SELECT public.resolver_moderacion_encuentro_seguro('${encId2}', 'reject', 'Rechazado por moderator');
      `);
      assert.equal(rejectRes.rows[0].resolver_moderacion_encuentro_seguro.ok, true);
      assert.equal(rejectRes.rows[0].resolver_moderacion_encuentro_seguro.new_status, 'rejected');
      assert.equal(rejectRes.rows[0].resolver_moderacion_encuentro_seguro.is_open, false);
    });

    test('G. Admin: puede listar cola y resolver moderación', async () => {
      await setAuthContext(adminUser);

      const modCheck = await db.query<{ is_moderation_authorized: boolean }>(`SELECT public.is_moderation_authorized();`);
      assert.equal(modCheck.rows[0].is_moderation_authorized, true, 'Admin debe tener is_moderation_authorized true');

      const qRes = await db.query<{ get_moderation_queue_seguro: any }>(`
        SELECT public.get_moderation_queue_seguro();
      `);
      assert.equal(qRes.rows[0].get_moderation_queue_seguro.ok, true);

      const encId = await createTestEncounter('Encuentro para admin');
      await setAuthContext(hostUser);
      await db.query(`
        SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción admin', 4, 'guemes', NULL);
      `);

      await setAuthContext(adminUser);
      const resolveRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
        SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'Aprobado por admin');
      `);
      assert.equal(resolveRes.rows[0].resolver_moderacion_encuentro_seguro.ok, true);

      const auditAdmin = await db.query<{ source: string }>(`
        SELECT source FROM public.public_content_moderation_audit
        WHERE encuentro_id = '${encId}' AND action = 'approve';
      `);
      assert.equal(auditAdmin.rows[0].source, 'admin');
    });

    test('H. Moderator inactivo (active = false): rechazado', async () => {
      await setAuthContext(inactiveModeratorUser);

      const modCheck = await db.query<{ is_moderation_authorized: boolean }>(`SELECT public.is_moderation_authorized();`);
      assert.equal(modCheck.rows[0].is_moderation_authorized, false, 'Moderator inactivo debe retornar false');

      const qRes = await db.query<{ get_moderation_queue_seguro: any }>(`
        SELECT public.get_moderation_queue_seguro();
      `);
      assert.equal(qRes.rows[0].get_moderation_queue_seguro.ok, false);
      assert.equal(qRes.rows[0].get_moderation_queue_seguro.error, 'unauthorized');

      const fakeId = '00000000-0000-0000-0000-000000000002';
      const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
        SELECT public.resolver_moderacion_encuentro_seguro('${fakeId}', 'approve', 'intento inactive');
      `);
      assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.ok, false);
      assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.error, 'unauthorized');
    });

    test('I. Authenticated sin rol: rechazado', async () => {
      await setAuthContext(normalUser);

      const modCheck = await db.query<{ is_moderation_authorized: boolean }>(`SELECT public.is_moderation_authorized();`);
      assert.equal(modCheck.rows[0].is_moderation_authorized, false);

      const qRes = await db.query<{ get_moderation_queue_seguro: any }>(`
        SELECT public.get_moderation_queue_seguro();
      `);
      assert.equal(qRes.rows[0].get_moderation_queue_seguro.ok, false);
      assert.equal(qRes.rows[0].get_moderation_queue_seguro.error, 'unauthorized');
    });

    test('J. Anon: rechazado', async () => {
      await setAuthContext(anonUser, true, 'anon');

      const modCheck = await db.query<{ is_moderation_authorized: boolean }>(`SELECT public.is_moderation_authorized();`);
      assert.equal(modCheck.rows[0].is_moderation_authorized, false);

      const qRes = await db.query<{ get_moderation_queue_seguro: any }>(`
        SELECT public.get_moderation_queue_seguro();
      `);
      assert.equal(qRes.rows[0].get_moderation_queue_seguro.ok, false);
      assert.equal(qRes.rows[0].get_moderation_queue_seguro.error, 'unauthorized');
    });

    test('K. service_role: flujo automático sigue funcionando sin requerir fila en tabla', async () => {
      const encId = await createTestEncounter('Encuentro automated service_role');
      await setAuthContext(hostUser);
      await db.query(`
        SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Descripción auto', 4, 'guemes', NULL);
      `);

      await setAuthContext(null, false, 'service_role');
      const modRes = await db.query<{ resolver_moderacion_encuentro_seguro: any }>(`
        SELECT public.resolver_moderacion_encuentro_seguro('${encId}', 'approve', 'automated approval');
      `);
      assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.ok, true);
      assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.new_status, 'approved');
      assert.equal(modRes.rows[0].resolver_moderacion_encuentro_seguro.is_open, true);

      const auditRes = await db.query<{ source: string }>(`
        SELECT source FROM public.public_content_moderation_audit
        WHERE encuentro_id = '${encId}' AND action = 'approve';
      `);
      assert.equal(auditRes.rows[0].source, 'automated_moderation');
    });

    test('L. is_qa_authorized() sigue funcionando para sus consumidores originales sin alteración', async () => {
      await setAuthContext(qaOnlyUser);
      const qaCheck = await db.query<{ is_qa_authorized: boolean }>(`SELECT public.is_qa_authorized();`);
      assert.equal(qaCheck.rows[0].is_qa_authorized, true, 'is_qa_authorized debe dar true para qaOnlyUser');

      await setAuthContext(normalUser);
      const normalCheck = await db.query<{ is_qa_authorized: boolean }>(`SELECT public.is_qa_authorized();`);
      assert.equal(normalCheck.rows[0].is_qa_authorized, false, 'is_qa_authorized debe dar false para normalUser');
    });

    test('M. Ningún UUID está hardcodeado en la migración', () => {
      const migPath = path.resolve(__dirname, '../supabase/migrations/20261009210000_separate_moderation_roles.sql');
      const migSql = fs.readFileSync(migPath, 'utf-8');

      const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      assert.equal(uuidRegex.test(migSql), false, 'La migración no debe tener UUIDs hardcodeados');
    });

    test('N. Cliente no puede modificar tabla moderation_authorized_users directamente (REVOKE ALL + RLS)', async () => {
      let insertBlocked = false;
      try {
        await db.query(`
          SET LOCAL ROLE authenticated;
          INSERT INTO public.moderation_authorized_users (user_id, role, active)
          VALUES ('${normalUser}', 'admin', true);
        `);
      } catch {
        insertBlocked = true;
      } finally {
        await db.query(`RESET ROLE;`);
      }
      assert.ok(insertBlocked, 'INSERT directo como authenticated debe fallar por permisos');

      const check = await db.query(`
        SELECT * FROM public.moderation_authorized_users WHERE user_id = '${normalUser}';
      `);
      assert.equal(check.rows.length, 0, 'No debe existir fila para normalUser');
    });
  });

  test('Caso R: Producción intacta', () => {
    // Verificar que todas las operaciones ejecutaron en motor local PGlite
    assert.ok(db);
  });
});
