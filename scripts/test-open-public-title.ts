import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Separación de Título Privado y Público de Encuentros Abiertos (17 Casos Obligatorios)', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const normalUser = '22222222-2222-2222-2222-222222222222';
  const moderatorUser = '33333333-3333-3333-3333-333333333333';

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
        ('${normalUser}', 'normal@test.com'),
        ('${moderatorUser}', 'moderator@test.com')
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
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE OR REPLACE FUNCTION public.set_updated_at()
      RETURNS trigger AS $$
      BEGIN
          NEW.updated_at = pg_catalog.timezone('utc', pg_catalog.now());
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TABLE IF NOT EXISTS public.intenciones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL DEFAULT '',
        descripcion TEXT,
        encuentro_id UUID REFERENCES public.encuentros(id),
        estado TEXT NOT NULL DEFAULT 'activa',
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );


      CREATE OR REPLACE FUNCTION public.emitir_alertas_intencion_convertida_outbox(
        p_intencion_id UUID,
        p_encuentro_id UUID
      ) RETURNS VOID AS $$
      BEGIN
      END;
      $$ LANGUAGE plpgsql;

      CREATE TABLE IF NOT EXISTS public.qa_authorized_users (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id),
        role TEXT NOT NULL CHECK (role IN ('admin', 'qa')),
        created_at TIMESTAMPTZ DEFAULT now()
      );

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
      BEGIN
        RETURN pg_catalog.jsonb_build_object('allowed', true, 'count', 1);
      END;
      $$;
    `);

    // 2. Cargar migraciones base de notificaciones y suscripciones (cronológico)
    const baseMigrations = [
      'supabase/migrations/20261002180000_notifications_inbox_and_outbox_base.sql',
      'supabase/migrations/20261002200000_harden_inbox_rpc_grants.sql',
      'supabase/migrations/20261002210000_fase_2a_match_alert_subscriptions.sql',
    ];
    for (const mig of baseMigrations) {
      const sql = fs.readFileSync(path.join(process.cwd(), mig), 'utf8');
      await db.exec(sql);
    }

    // 2.5 Cargar migraciones de moderación (cronológico)
    const mod1 = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261009160000_public_content_moderation_v1.sql'), 'utf8');
    await db.exec(mod1);

    const mod2 = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261009210000_separate_moderation_roles.sql'), 'utf8');
    await db.exec(mod2);

    // 3. Cargar migraciones de Matching y Taxonomía de Mis Ganas
    const match1 = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261012010000_fase_20d_matching_mis_ganas_activity_relevance.sql'), 'utf8');
    await db.exec(match1);

    const match2 = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261012010500_fix_activity_relevance_coalesce.sql'), 'utf8');
    await db.exec(match2);

    const match3 = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261012011000_fix_activity_relevance_trim.sql'), 'utf8');
    await db.exec(match3);

    const match4 = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261012012000_harden_matching_internal_rpc_grants.sql'), 'utf8');
    await db.exec(match4);

    // Insertar un encuentro histórico abierto antes de aplicar la migración para probar backfill
    await db.exec(`
      INSERT INTO public.encuentros (id, host_id, titulo, modalidad, lugar_texto, is_open, open_description, max_participants, locality_id, open_public_zone, moderation_status)
      VALUES (
        'aaaaaaaa-1111-1111-1111-111111111111',
        '${hostUser}',
        'Encuentro Histórico Abierto',
        'presencial',
        'Café Histórico',
        true,
        'Descripción histórica',
        4,
        'guemes',
        'Güemes',
        'approved'
      );
    `);

    // 4. Cargar la migración de separación de título
    const sepMigration = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261012130000_separate_open_public_title.sql'), 'utf8');
    await db.exec(sepMigration);

    // 4.5 Insertar encuentro histórico cerrado pero con open_description para verificar backfill complementario
    await db.exec(`
      INSERT INTO public.encuentros (id, host_id, titulo, modalidad, lugar_texto, is_open, open_description, max_participants, locality_id, open_public_zone, moderation_status, open_public_title)
      VALUES (
        'bbbbbbbb-2222-2222-2222-222222222222',
        '${hostUser}',
        'Encuentro Histórico En Revisión',
        'presencial',
        'Café Histórico 2',
        false,
        'Descripción histórica pendiente',
        4,
        'guemes',
        'Güemes',
        'review_pending',
        NULL
      );
    `);

    // 5. Cargar la migración de invariantes estrictas de privacidad
    const invMigration = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261012143000_enforce_open_public_title_privacy_invariants.sql'), 'utf8');
    await db.exec(invMigration);

    // Moderador para pruebas de aprobación
    await db.exec(`
      INSERT INTO public.moderation_authorized_users (user_id, role, active)
      VALUES ('${moderatorUser}', 'moderator', true)
      ON CONFLICT (user_id) DO NOTHING;
    `);
  });

  beforeEach(async () => {
    await resetAuthContext();
  });

  test('Caso 1: Encuentro privado con open_public_title -> Discovery muestra open_public_title y NO titulo', async () => {
    // 1. Crear encuentro privado con titulo "Cumple sorpresa Laura"
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, lugar_texto, max_participants, is_open)
      VALUES ('${hostUser}', 'Cumple sorpresa Laura', 'presencial', 'Calle Falsa 123', 6, false)
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // 2. Host abre el encuentro con open_public_title = "Cena y música"
    await setAuthContext(hostUser);
    const abrirRes = await db.query<any>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}'::uuid,
        '${hostUser}'::uuid,
        'Cena y buena música este sábado'::text,
        6::int,
        'guemes'::text,
        'Güemes'::text,
        'Cena y música'::text
      ) as res;
    `);
    const abrirJson = abrirRes.rows[0].res;
    assert.equal(abrirJson.ok, true);
    assert.equal(abrirJson.open_public_title, 'Cena y música');

    // 3. Moderador aprueba
    await resetAuthContext();
    const encRow = await db.query<any>(`SELECT * FROM public.encuentros WHERE id = '${encId}'`);
    const hash = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(
        '${encRow.rows[0].open_public_title}',
        '${encRow.rows[0].open_description}',
        '${encRow.rows[0].modalidad}',
        '${encRow.rows[0].open_public_zone}'
      );
    `);
    await setAuthContext(moderatorUser);
    const approveRes = await db.query<any>(`
      SELECT public.resolver_moderacion_encuentro_seguro(
        '${encId}'::uuid,
        'approve'::text,
        'OK'::text,
        '${hash.rows[0].calcular_content_hash_moderacion}'::text
      ) as res;
    `);
    assert.equal(approveRes.rows[0].res.ok, true);

    // 4. Consulta Discovery como usuario anónimo
    await setAuthContext(null);
    const discRes = await db.query<any>(`
      SELECT public.get_discovery_encuentros_abiertos() as res;
    `);
    const items = discRes.rows[0].res;
    const matchItem = items.find((it: any) => it.id === encId);
    assert.ok(matchItem, 'Debe aparecer en Discovery');
    assert.equal(matchItem.title, 'Cena y música');
    assert.notEqual(matchItem.title, 'Cumple sorpresa Laura');
  });

  test('Caso 2: Detalle público usa open_public_title', async () => {
    // Tomamos el encuentro creado en Caso 1
    await setAuthContext(null);
    const discRes = await db.query<any>(`
      SELECT public.get_discovery_encuentros_abiertos() as res;
    `);
    const items = discRes.rows[0].res;
    const item = items.find((it: any) => it.title === 'Cena y música');
    assert.ok(item);
    assert.equal(item.title, 'Cena y música');
  });

  test('Caso 3: Mi espacio / gestión host sigue usando titulo privado', async () => {
    await resetAuthContext();
    // Buscar el encuentro con titulo "Cumple sorpresa Laura"
    const row = await db.query<any>(`
      SELECT id, titulo, open_public_title FROM public.encuentros WHERE titulo = 'Cumple sorpresa Laura';
    `);
    const enc = row.rows[0];
    assert.ok(enc);
    assert.equal(enc.titulo, 'Cumple sorpresa Laura');
    assert.equal(enc.open_public_title, 'Cena y música');

    // El host consulta su detalle
    await setAuthContext(hostUser);
    const hostDetRes = await db.query<any>(`
      SELECT public.get_detalle_host_seguro('${enc.id}'::uuid, '${hostUser}'::uuid) as res;
    `);
    const hostJson = hostDetRes.rows[0].res;
    assert.equal(hostJson.titulo, 'Cumple sorpresa Laura');
    assert.equal(hostJson.open_public_title, 'Cena y música');
  });

  test('Caso 4: Primera apertura autocompleta título público desde título privado si no se envía', async () => {
    await resetAuthContext();
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, lugar_texto, max_participants, is_open)
      VALUES ('${hostUser}', 'Café de charla libre', 'presencial', 'Café 123', 4, false)
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Llamada con p_open_public_title = NULL
    await setAuthContext(hostUser);
    const abrirRes = await db.query<any>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}'::uuid,
        '${hostUser}'::uuid,
        'Vení a tomar un café y charlar'::text,
        4::int,
        'guemes'::text,
        'Güemes'::text,
        NULL::text
      ) as res;
    `);
    const abrirJson = abrirRes.rows[0].res;
    assert.equal(abrirJson.ok, true);
    assert.equal(abrirJson.open_public_title, 'Café de charla libre');

    await resetAuthContext();
    const dbRow = await db.query<any>(`SELECT open_public_title FROM public.encuentros WHERE id = '${encId}'`);
    assert.equal(dbRow.rows[0].open_public_title, 'Café de charla libre');
  });

  test('Caso 5: Host modifica título público antes de publicar', async () => {
    await resetAuthContext();
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, lugar_texto, max_participants, is_open)
      VALUES ('${hostUser}', 'Cumple Martín', 'presencial', 'Quincho 456', 8, false)
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Host pasa p_open_public_title = "Cena de 5 pasos este sábado"
    await setAuthContext(hostUser);
    const abrirRes = await db.query<any>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}'::uuid,
        '${hostUser}'::uuid,
        'Degustación gourmet y buena charla'::text,
        8::int,
        'guemes'::text,
        'Güemes'::text,
        'Cena de 5 pasos este sábado'::text
      ) as res;
    `);
    const abrirJson = abrirRes.rows[0].res;
    assert.equal(abrirJson.ok, true);
    assert.equal(abrirJson.open_public_title, 'Cena de 5 pasos este sábado');

    await resetAuthContext();
    const dbRow = await db.query<any>(`SELECT titulo, open_public_title FROM public.encuentros WHERE id = '${encId}'`);
    assert.equal(dbRow.rows[0].titulo, 'Cumple Martín');
    assert.equal(dbRow.rows[0].open_public_title, 'Cena de 5 pasos este sábado');
  });

  test('Caso 6: Cambio posterior de titulo privado NO altera open_public_title ni invalida moderación', async () => {
    // Usamos el encuentro del Caso 1 (ya aprobado)
    const row = await db.query<any>(`SELECT id FROM public.encuentros WHERE titulo = 'Cumple sorpresa Laura'`);
    const encId = row.rows[0].id;

    await setAuthContext(hostUser);
    const updateRes = await db.query<any>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}'::uuid,
        '${hostUser}'::uuid,
        '{"titulo": "Cumple sorpresa Laura (privado editado)"}'::jsonb
      ) as res;
    `);
    const updateJson = updateRes.rows[0].res;
    assert.equal(updateJson.ok, true);
    assert.equal(updateJson.moderation_invalidated, false, 'No debe invalidar moderación al cambiar solo título privado');
    assert.equal(updateJson.is_open, true);

    await resetAuthContext();
    const checkRow = await db.query<any>(`SELECT titulo, open_public_title, is_open FROM public.encuentros WHERE id = '${encId}'`);
    assert.equal(checkRow.rows[0].titulo, 'Cumple sorpresa Laura (privado editado)');
    assert.equal(checkRow.rows[0].open_public_title, 'Cena y música');
    assert.equal(checkRow.rows[0].is_open, true);
  });

  test('Caso 7: Cambio posterior de open_public_title NO altera titulo privado', async () => {
    await resetAuthContext();
    const row = await db.query<any>(`SELECT id FROM public.encuentros WHERE open_public_title = 'Cena de 5 pasos este sábado'`);
    const encId = row.rows[0].id;

    await setAuthContext(hostUser);
    const updateRes = await db.query<any>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}'::uuid,
        '${hostUser}'::uuid,
        '{"open_public_title": "Cena gourmet de 5 pasos"}'::jsonb
      ) as res;
    `);
    const updateJson = updateRes.rows[0].res;
    assert.equal(updateJson.ok, true);

    await resetAuthContext();
    const checkRow = await db.query<any>(`SELECT titulo, open_public_title FROM public.encuentros WHERE id = '${encId}'`);
    assert.equal(checkRow.rows[0].titulo, 'Cumple Martín', 'Titulo privado no debe cambiar');
    assert.equal(checkRow.rows[0].open_public_title, 'Cena gourmet de 5 pasos');
  });

  test('Caso 8: Editar publicación permite cambiar open_public_title explícitamente', async () => {
    await resetAuthContext();
    const row = await db.query<any>(`SELECT id FROM public.encuentros WHERE open_public_title = 'Cena gourmet de 5 pasos'`);
    const encId = row.rows[0].id;

    await setAuthContext(hostUser);
    const updateRes = await db.query<any>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}'::uuid,
        '${hostUser}'::uuid,
        '{"open_public_title": "Cena exclusiva de 5 pasos este sábado"}'::jsonb
      ) as res;
    `);
    assert.equal(updateRes.rows[0].res.ok, true);

    await resetAuthContext();
    const checkRow = await db.query<any>(`SELECT open_public_title FROM public.encuentros WHERE id = '${encId}'`);
    assert.equal(checkRow.rows[0].open_public_title, 'Cena exclusiva de 5 pasos este sábado');
  });

  test('Caso 9: Editar open_public_title invalida moderación anterior (review_pending, is_open = false)', async () => {
    await resetAuthContext();
    // Tomamos el encuentro del Caso 1 que estaba aprobado y abierto
    const row = await db.query<any>(`SELECT id, moderation_status, is_open FROM public.encuentros WHERE open_public_title = 'Cena y música'`);
    const encId = row.rows[0].id;
    assert.equal(row.rows[0].is_open, true);

    await setAuthContext(hostUser);
    const updateRes = await db.query<any>(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}'::uuid,
        '${hostUser}'::uuid,
        '{"open_public_title": "Cena, jazz y buena música"}'::jsonb
      ) as res;
    `);
    const res = updateRes.rows[0].res;
    assert.equal(res.ok, true);
    assert.equal(res.moderation_invalidated, true);
    assert.equal(res.moderation_status, 'review_pending');
    assert.equal(res.is_open, false);

    await resetAuthContext();
    const checkRow = await db.query<any>(`SELECT moderation_status, is_open FROM public.encuentros WHERE id = '${encId}'`);
    assert.equal(checkRow.rows[0].moderation_status, 'review_pending');
    assert.equal(checkRow.rows[0].is_open, false);
  });

  test('Caso 10: Matching clasifica desde open_public_title + open_description', async () => {
    await resetAuthContext();
    // Encuentro donde titulo es genérico pero open_public_title menciona pádel
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, open_public_title, open_description, modalidad, lugar_texto, is_open, locality_id)
      VALUES ('${hostUser}', 'Plan fin de semana', 'Partido de pádel en Güemes', 'Buscamos 2 personas para pádel nivel intermedio', 'presencial', 'Cancha Güemes', true, 'guemes')
      RETURNING id, open_activity_canonical, open_activity_matching_eligible;
    `);
    const enc = encRes.rows[0];
    assert.equal(enc.open_activity_canonical, 'padel');
    assert.equal(enc.open_activity_matching_eligible, true);
  });

  test('Caso 11: Título privado NO influye en matching público', async () => {
    await resetAuthContext();
    // Título privado menciona café, pero open_public_title menciona tenis
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, open_public_title, open_description, modalidad, lugar_texto, is_open, locality_id, open_public_zone, moderation_status)
      VALUES ('${hostUser}', 'Tomar un café y medialunas', 'Torneo de tenis dobles', 'Partidos amistosos de tenis fin de semana', 'presencial', 'Club Tenis', false, 'guemes', 'Güemes', 'review_pending')
      RETURNING id, open_activity_canonical, open_activity_matching_eligible;
    `);
    const enc = encRes.rows[0];
    assert.equal(enc.open_activity_canonical, 'tenis');
    assert.notEqual(enc.open_activity_canonical, 'cafe');
  });

  test('Caso 12: Backfill conserva visual de encuentros abiertos existentes', async () => {
    // Verificamos el encuentro histórico 'aaaaaaaa-1111-1111-1111-111111111111'
    const hist = await db.query<any>(`
      SELECT id, titulo, open_public_title, is_open FROM public.encuentros
      WHERE id = 'aaaaaaaa-1111-1111-1111-111111111111';
    `);
    assert.ok(hist.rows[0]);
    assert.equal(hist.rows[0].titulo, 'Encuentro Histórico Abierto');
    assert.equal(hist.rows[0].open_public_title, 'Encuentro Histórico Abierto');
    assert.equal(hist.rows[0].is_open, true);
  });

  test('Caso 13: public RPC no expone titulo privado', async () => {
    // Encuentro abierto con token público
    const row = await db.query<any>(`
      SELECT id, public_token, titulo, open_public_title FROM public.encuentros
      WHERE open_public_title = 'Partido de pádel en Güemes';
    `);
    const enc = row.rows[0];
    assert.notEqual(enc.titulo, enc.open_public_title);

    await setAuthContext(null);
    const pubRes = await db.query<any>(`
      SELECT public.get_encuentro_por_public_token('${enc.public_token}') as res;
    `);
    const pubJson = pubRes.rows[0].res;
    assert.ok(pubJson);
    assert.equal(pubJson.titulo, 'Partido de pádel en Güemes');
    assert.notEqual(pubJson.titulo, 'Plan fin de semana');
    assert.equal(pubJson.open_public_title, 'Partido de pádel en Güemes');
  });

  test('Caso 14: host RPC sigue viendo titulo privado y también open_public_title', async () => {
    const row = await db.query<any>(`
      SELECT id FROM public.encuentros
      WHERE open_public_title = 'Partido de pádel en Güemes';
    `);
    const encId = row.rows[0].id;

    await setAuthContext(hostUser);
    const hostRes = await db.query<any>(`
      SELECT public.get_detalle_host_seguro('${encId}'::uuid, '${hostUser}'::uuid) as res;
    `);
    const hostJson = hostRes.rows[0].res;
    assert.equal(hostJson.titulo, 'Plan fin de semana');
    assert.equal(hostJson.open_public_title, 'Partido de pádel en Güemes');
  });

  test('Caso 15: multi-activity y matching actual no se rompen', async () => {
    // Dos actividades canónicas en el contenido público
    const encRes = await db.query<any>(`
      INSERT INTO public.encuentros (host_id, titulo, open_public_title, open_description, modalidad, lugar_texto, is_open)
      VALUES ('${hostUser}', 'Multi actividad', 'Pádel y tenis de fin de semana', 'Vamos a jugar un rato al pádel y después al tenis', 'presencial', 'Club', true)
      RETURNING open_activity_matching_eligible, open_match_ineligible_reason;
    `);
    assert.equal(encRes.rows[0].open_activity_matching_eligible, false);
    assert.equal(encRes.rows[0].open_match_ineligible_reason, 'multiple_activities');
  });

  test('Caso 16: Home V1 sin regresión', async () => {
    // Comprobar que una consulta de encuentros del host devuelve la columna titulo intacta
    const rows = await db.query<any>(`
      SELECT id, titulo, modalidad, fecha, hora FROM public.encuentros WHERE host_id = '${hostUser}';
    `);
    assert.ok(rows.rows.length >= 3);
    for (const r of rows.rows) {
      assert.ok(r.titulo && r.titulo.length >= 3, 'Titulo privado debe existir para cada encuentro');
    }
  });

  test('Caso 17: Home V2 Discovery sin regresión (cards usan open_public_title)', async () => {
    // Habilitamos un encuentro aprobado para Discovery
    const encRow = await db.query<any>(`
      SELECT id FROM public.encuentros WHERE open_public_title = 'Torneo de tenis dobles';
    `);
    const encId = encRow.rows[0].id;

    // Aprobar moderación
    await setAuthContext(moderatorUser);
    const hash = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion('Torneo de tenis dobles', 'Partidos amistosos de tenis fin de semana', 'presencial', 'Güemes');
    `);
    await db.query(`
      SELECT public.resolver_moderacion_encuentro_seguro(
        '${encId}'::uuid,
        'approve'::text,
        'OK'::text,
        '${hash.rows[0].calcular_content_hash_moderacion}'::text
      );
    `);

    // Discovery retorna title = open_public_title
    await setAuthContext(null);
    const discRes = await db.query<any>(`
      SELECT public.get_discovery_encuentros_abiertos() as res;
    `);
    const items = discRes.rows[0].res;
    const tennisItem = items.find((it: any) => it.id === encId);
    assert.ok(tennisItem, 'Debe aparecer en Discovery');
    assert.equal(tennisItem.title, 'Torneo de tenis dobles');
  });

  test('Caso 18: Discovery nunca usa titulo privado como fallback', async () => {
    // Encuentro abierto donde titulo privado es sensible/distinto
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, open_description, modalidad, lugar_texto,
        is_open, locality_id, open_public_zone, moderation_status
      )
      VALUES (
        '${hostUser}',
        'Reunión interna privada de accionistas',
        'Charla abierta sobre emprendimiento',
        'Conversación sobre negocios y proyectos',
        'presencial',
        'Oficina 402',
        true,
        'guemes',
        'Güemes',
        'approved'
      )
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await setAuthContext(null);
    const discRes = await db.query<any>(`
      SELECT public.get_discovery_encuentros_abiertos() as res;
    `);
    const items = discRes.rows[0].res;
    const found = items.find((it: any) => it.id === encId);
    assert.ok(found, 'Debe aparecer en Discovery');
    assert.equal(found.title, 'Charla abierta sobre emprendimiento');
    assert.notEqual(found.title, 'Reunión interna privada de accionistas');
  });

  test('Caso 19: Moderación nunca recibe ni expone titulo privado', async () => {
    // Cola de moderación no debe proyectar el título interno privado
    await setAuthContext(moderatorUser);
    const qRes = await db.query<any>(`
      SELECT public.get_moderation_queue_seguro() as res;
    `);
    const queue = qRes.rows[0].res.queue;
    for (const item of queue) {
      if (item.open_public_title) {
        assert.equal(item.titulo, item.open_public_title, 'En la cola de moderación el título mostrado debe coincidir con open_public_title');
        assert.notEqual(item.titulo, 'Reunión interna privada de accionistas');
      }
    }
  });

  test('Caso 20: Hash público no usa titulo privado; cambiar titulo privado no altera hash público', async () => {
    const encRes = await db.query<{ id: string; open_public_title: string; open_description: string; modalidad: string; open_public_zone: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, open_description, modalidad, lugar_texto,
        is_open, locality_id, open_public_zone, moderation_status
      )
      VALUES (
        '${hostUser}',
        'Cumple privado de Juan',
        'Música en vivo en la plaza',
        'Acústico abierto en el parque',
        'presencial',
        'Plaza Mitre',
        false,
        'guemes',
        'Güemes',
        'review_pending'
      )
      RETURNING id, open_public_title, open_description, modalidad, open_public_zone;
    `);
    const enc = encRes.rows[0];

    // Hash inicial sobre el contenido público
    const hashRes1 = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(
        '${enc.open_public_title}',
        '${enc.open_description}',
        '${enc.modalidad}',
        '${enc.open_public_zone}'
      );
    `);
    const publicHash1 = hashRes1.rows[0].calcular_content_hash_moderacion;

    // Host modifica su título privado
    await setAuthContext(hostUser);
    await db.query(`
      SELECT public.actualizar_encuentro_seguro(
        '${enc.id}'::uuid,
        '${hostUser}'::uuid,
        '{"titulo": "Cumple súper privado de Juan editado"}'::jsonb
      );
    `);

    // El hash público sigue siendo EXACTAMENTE el mismo
    await resetAuthContext();
    const encRow2 = await db.query<any>(`SELECT * FROM public.encuentros WHERE id = '${enc.id}'`);
    const hashRes2 = await db.query<{ calcular_content_hash_moderacion: string }>(`
      SELECT public.calcular_content_hash_moderacion(
        '${encRow2.rows[0].open_public_title}',
        '${encRow2.rows[0].open_description}',
        '${encRow2.rows[0].modalidad}',
        '${encRow2.rows[0].open_public_zone}'
      );
    `);
    assert.equal(hashRes2.rows[0].calcular_content_hash_moderacion, publicHash1);

    // Moderación con el hash original aprueba exitosamente
    await setAuthContext(moderatorUser);
    const modRes = await db.query<any>(`
      SELECT public.resolver_moderacion_encuentro_seguro(
        '${enc.id}'::uuid,
        'approve'::text,
        'Aprobado'::text,
        '${publicHash1}'::text
      ) as res;
    `);
    assert.equal(modRes.rows[0].res.ok, true);
  });

  test('Caso 21: Matching ignora completamente titulo privado', async () => {
    // Encuentro donde titulo privado menciona café, pero open_public_title menciona ajedrez
    const encRes = await db.query<{ id: string; open_activity_canonical: string; open_activity_matching_eligible: boolean }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, open_description, modalidad, lugar_texto,
        is_open, locality_id, open_public_zone, moderation_status
      )
      VALUES (
        '${hostUser}',
        'Tomar un café y charla de trabajo',
        'Torneo de ajedrez rápido',
        'Partidas rápidas de ajedrez 5 minutos',
        'presencial',
        'Club Ajedrez',
        true,
        'guemes',
        'Güemes',
        'approved'
      )
      RETURNING id, open_activity_canonical, open_activity_matching_eligible;
    `);
    assert.equal(encRes.rows[0].open_activity_canonical, 'ajedrez');
    assert.equal(encRes.rows[0].open_activity_matching_eligible, true);
  });

  test('Caso 22: Cambiar titulo privado no reclasifica actividad pública', async () => {
    // Usamos el encuentro del Caso 21 ('ajedrez')
    const encRes = await db.query<any>(`SELECT id FROM public.encuentros WHERE open_public_title = 'Torneo de ajedrez rápido'`);
    const encId = encRes.rows[0].id;

    // Cambiar titulo a algo con keyword fuerte de otra actividad (yoga)
    await db.query(`
      UPDATE public.encuentros
      SET titulo = 'Clase de Yoga y meditación matutina'
      WHERE id = '${encId}';
    `);

    // La actividad clasificada permanece 'ajedrez', no cambia a 'yoga'
    const checkRow = await db.query<any>(`SELECT open_activity_canonical FROM public.encuentros WHERE id = '${encId}'`);
    assert.equal(checkRow.rows[0].open_activity_canonical, 'ajedrez');
  });

  test('Caso 23: Publicación sin open_public_title falla cerrada', async () => {
    // 1. Constraint impide insertar is_open = true con open_public_title NULL
    await assert.rejects(async () => {
      await db.query(`
        INSERT INTO public.encuentros (
          host_id, titulo, open_public_title, open_description, modalidad, lugar_texto,
          is_open, locality_id, open_public_zone, moderation_status
        )
        VALUES (
          '${hostUser}',
          'Plan sin titulo publico',
          NULL,
          'Descripcion valida',
          'presencial',
          'Lugar',
          true,
          'guemes',
          'Güemes',
          'approved'
        );
      `);
    }, /chk_encuentros_open_public_title/);

    // 2. Constraint impide insertar review_pending con open_public_title NULL
    await assert.rejects(async () => {
      await db.query(`
        INSERT INTO public.encuentros (
          host_id, titulo, open_public_title, open_description, modalidad, lugar_texto,
          is_open, locality_id, open_public_zone, moderation_status
        )
        VALUES (
          '${hostUser}',
          'Plan sin titulo publico en revision',
          NULL,
          'Descripcion valida',
          'presencial',
          'Lugar',
          false,
          'guemes',
          'Güemes',
          'review_pending'
        );
      `);
    }, /chk_encuentros_open_public_title/);
  });

  test('Caso 24: Primera apertura inicializa explícitamente open_public_title desde titulo y son independientes', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, lugar_texto, max_participants, is_open)
      VALUES ('${hostUser}', 'Picnic en la costa', 'presencial', 'Playa Grande', 5, false)
      RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Primera apertura sin open_public_title
    await setAuthContext(hostUser);
    const abrirRes = await db.query<any>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}'::uuid,
        '${hostUser}'::uuid,
        'Picnic y mates mirando el mar'::text,
        5::int,
        'guemes'::text,
        'Güemes'::text,
        NULL::text
      ) as res;
    `);
    assert.equal(abrirRes.rows[0].res.ok, true);
    assert.equal(abrirRes.rows[0].res.open_public_title, 'Picnic en la costa');

    // Cambiar titulo privado posteriormente
    await db.query(`
      SELECT public.actualizar_encuentro_seguro(
        '${encId}'::uuid,
        '${hostUser}'::uuid,
        '{"titulo": "Picnic familiar privado"}'::jsonb
      );
    `);

    // open_public_title permanece 'Picnic en la costa'
    await resetAuthContext();
    const checkRow = await db.query<any>(`SELECT titulo, open_public_title FROM public.encuentros WHERE id = '${encId}'`);
    assert.equal(checkRow.rows[0].titulo, 'Picnic familiar privado');
    assert.equal(checkRow.rows[0].open_public_title, 'Picnic en la costa');
  });

  test('Caso 25: Invitación privada por token conserva titulo privado si is_open = false, y usa open_public_title si is_open = true', async () => {
    // 1. Encuentro privado con token
    const privRes = await db.query<{ id: string; public_token: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, modalidad, lugar_texto, is_open, moderation_status
      )
      VALUES (
        '${hostUser}',
        'Cena secreta de cumpleaños',
        NULL,
        'presencial',
        'Casa de Pedro',
        false,
        'draft'
      )
      RETURNING id, public_token;
    `);
    const privToken = privRes.rows[0].public_token;

    await setAuthContext(null);
    const privQuery = await db.query<any>(`
      SELECT public.get_encuentro_por_public_token('${privToken}') as res;
    `);
    assert.equal(privQuery.rows[0].res.titulo, 'Cena secreta de cumpleaños', 'Invitado autorizado por token privado ve el título privado');

    // 2. Encuentro abierto con token
    await resetAuthContext();
    const openRes = await db.query<{ id: string; public_token: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, open_description, modalidad, lugar_texto, is_open, locality_id, open_public_zone, moderation_status
      )
      VALUES (
        '${hostUser}',
        'Reunión interna privada 99',
        'Festejo Comunitario Abierto',
        'Festejo abierto a todos los vecinos',
        'presencial',
        'Plaza central',
        true,
        'guemes',
        'Güemes',
        'approved'
      )
      RETURNING id, public_token;
    `);
    const openToken = openRes.rows[0].public_token;

    const openQuery = await db.query<any>(`
      SELECT public.get_encuentro_por_public_token('${openToken}') as res;
    `);
    assert.equal(openQuery.rows[0].res.titulo, 'Festejo Comunitario Abierto', 'Encuentro abierto retorna open_public_title en titulo');
    assert.notEqual(openQuery.rows[0].res.titulo, 'Reunión interna privada 99');
  });

  test('Caso 26: Datos históricos en review_pending quedan correctamente backfilleados', async () => {
    // El encuentro 'bbbbbbbb-2222-2222-2222-222222222222' fue insertado antes de la migración de invariantes con open_public_title NULL
    const histRow = await db.query<any>(`
      SELECT id, titulo, open_public_title, moderation_status FROM public.encuentros
      WHERE id = 'bbbbbbbb-2222-2222-2222-222222222222';
    `);
    assert.ok(histRow.rows[0]);
    assert.equal(histRow.rows[0].open_public_title, 'Encuentro Histórico En Revisión', 'El backfill complementario debe haber poblado open_public_title');
    assert.equal(histRow.rows[0].moderation_status, 'review_pending');
  });
});
