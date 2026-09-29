import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-B Discovery Unificado — Bloque 1 Backend: Lectura Pública de Intenciones', () => {
  let db: PGlite;
  const userA = '11111111-1111-1111-1111-111111111111';
  const userB = '22222222-2222-2222-2222-222222222222';
  const userC = '33333333-3333-3333-3333-333333333333';
  const userAnon = '44444444-4444-4444-4444-444444444444';

  before(async () => {
    db = new PGlite();

    // 1. Setup Supabase mock environment
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;

      ALTER ROLE service_role BYPASSRLS;

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

      CREATE OR REPLACE FUNCTION public.set_updated_at()
      RETURNS trigger AS $$
      BEGIN
          NEW.updated_at = now();
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      INSERT INTO auth.users (id, email) VALUES
        ('${userA}', 'userA@test.com'),
        ('${userB}', 'userB@test.com'),
        ('${userC}', 'userC@test.com'),
        ('${userAnon}', 'anon@test.com')
      ON CONFLICT DO NOTHING;

      -- Base localidades
      CREATE TABLE IF NOT EXISTS public.localidades (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        ciudad TEXT NOT NULL,
        zona TEXT NOT NULL,
        pais TEXT NOT NULL DEFAULT 'AR',
        orden INT NOT NULL DEFAULT 1,
        activo BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
      );

      INSERT INTO public.localidades (id, nombre, ciudad, zona, pais, orden, activo) VALUES
        ('palermo', 'Palermo', 'CABA', 'Norte', 'AR', 1, true),
        ('guemes', 'Güemes', 'Mar del Plata', 'Costa Atlántica', 'AR', 2, true),
        ('recoleta', 'Recoleta', 'CABA', 'Centro', 'AR', 3, true)
      ON CONFLICT DO NOTHING;

      -- Tabla encuentros dummy para FK
      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      -- Tabla intenciones (Bloque 1 Fase 2.0-A)
      CREATE TABLE IF NOT EXISTS public.intenciones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        titulo TEXT NOT NULL,
        descripcion TEXT,
        temporalidad_texto TEXT,
        fecha_desde DATE,
        fecha_hasta DATE,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        locality_id TEXT REFERENCES public.localidades(id) ON DELETE SET NULL,
        estado TEXT NOT NULL DEFAULT 'activa',
        encuentro_id UUID REFERENCES public.encuentros(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
        CONSTRAINT check_intenciones_titulo CHECK (length(trim(titulo)) > 0 AND length(titulo) <= 120),
        CONSTRAINT check_intenciones_modalidad CHECK (modalidad IN ('presencial', 'virtual', 'indistinto')),
        CONSTRAINT check_intenciones_estado CHECK (estado IN ('activa', 'pausada', 'convertida', 'cerrada'))
      );

      ALTER TABLE public.intenciones ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE public.intenciones FROM PUBLIC, anon;

      -- Aplicar la nueva migración de Fase 2.0-B Bloque 1
      CREATE TABLE IF NOT EXISTS public.intencion_intereses (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          intencion_id UUID NOT NULL REFERENCES public.intenciones(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
          CONSTRAINT uq_intencion_intereses UNIQUE (intencion_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_intencion_intereses_intencion_id 
          ON public.intencion_intereses(intencion_id);

      CREATE INDEX IF NOT EXISTS idx_intencion_intereses_user_id 
          ON public.intencion_intereses(user_id);

      ALTER TABLE public.intencion_intereses ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE public.intencion_intereses FROM PUBLIC, anon;
      GRANT SELECT ON TABLE public.intencion_intereses TO authenticated;

      DROP POLICY IF EXISTS intencion_intereses_select_own ON public.intencion_intereses;
      CREATE POLICY intencion_intereses_select_own ON public.intencion_intereses
          FOR SELECT TO authenticated
          USING (auth.uid() = user_id);

      CREATE OR REPLACE FUNCTION public.get_discovery_intenciones_activas(
          p_locality_ids TEXT[] DEFAULT NULL
      )
      RETURNS JSONB
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $func$
      DECLARE
          v_viewer_id UUID := auth.uid();
          v_is_anon BOOLEAN := (v_viewer_id IS NULL) OR COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
          v_result JSONB;
      BEGIN
          SELECT COALESCE(pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                  'id', i.id,
                  'titulo', i.titulo,
                  'descripcion', i.descripcion,
                  'temporalidad_texto', i.temporalidad_texto,
                  'fecha_desde', i.fecha_desde,
                  'fecha_hasta', i.fecha_hasta,
                  'modalidad', i.modalidad,
                  'locality_id', i.locality_id,
                  'approximate_zone', COALESCE(l.nombre, 'Zona aproximada'),
                  'interested_count', COALESCE((
                      SELECT pg_catalog.count(*)::int
                      FROM public.intencion_intereses ii
                      WHERE ii.intencion_id = i.id
                  ), 0),
                  'created_at', i.created_at,
                  'is_own', CASE WHEN v_is_anon THEN false ELSE (i.user_id = v_viewer_id) END,
                  'viewer_interested', CASE WHEN v_is_anon THEN false ELSE EXISTS(
                      SELECT 1
                      FROM public.intencion_intereses ii
                      WHERE ii.intencion_id = i.id AND ii.user_id = v_viewer_id
                  ) END
              ) ORDER BY i.created_at DESC
          ), '[]'::jsonb)
          INTO v_result
          FROM public.intenciones i
          LEFT JOIN public.localidades l ON l.id = i.locality_id
          WHERE i.estado = 'activa'
            AND (
                i.fecha_hasta IS NULL
                OR i.fecha_hasta >= (pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
            )
            AND (
                p_locality_ids IS NULL
                OR pg_catalog.array_length(p_locality_ids, 1) IS NULL
                OR i.modalidad = 'virtual'
                OR i.locality_id = ANY(p_locality_ids)
            );

          RETURN v_result;
      END;
      $func$;

      REVOKE ALL ON FUNCTION public.get_discovery_intenciones_activas(TEXT[]) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.get_discovery_intenciones_activas(TEXT[]) TO anon, authenticated;
    `);
  });

  const runAsAdmin = async (sql: string) => {
    await db.exec(`SET ROLE postgres;`);
    return await db.exec(sql);
  };

  const setAuthContext = async (userId: string | null, isAnon: boolean = false) => {
    if (!userId) {
      await db.exec(`
        SET ROLE anon;
        SELECT set_config('request.jwt.claim.sub', '', false);
        SELECT set_config('request.jwt.claims', '{}', false);
      `);
    } else {
      await db.exec(`
        SET ROLE authenticated;
        SELECT set_config('request.jwt.claim.sub', '${userId}', false);
        SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": ${isAnon}}', false);
      `);
    }
  };

  test('1. anon y authenticated pueden ejecutar get_discovery_intenciones_activas', async () => {
    // Como anon
    await setAuthContext(null);
    const resAnon = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() as get_discovery_intenciones_activas;`
    );
    assert.ok(Array.isArray(resAnon.rows[0].get_discovery_intenciones_activas));

    // Como authenticated
    await setAuthContext(userA, false);
    const resAuth = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() as get_discovery_intenciones_activas;`
    );
    assert.ok(Array.isArray(resAuth.rows[0].get_discovery_intenciones_activas));
  });

  test('2. Elegibilidad por estado: sólo activa aparece; pausada, convertida y cerrada se excluyen', async () => {
    // Insertar intenciones en distintos estados para userA como admin
    await runAsAdmin(`
      INSERT INTO public.intenciones (id, user_id, titulo, modalidad, locality_id, estado) VALUES
        ('a0000000-0000-0000-0000-000000000001', '${userA}', 'Activa Running', 'presencial', 'palermo', 'activa'),
        ('a0000000-0000-0000-0000-000000000002', '${userA}', 'Pausada Tenis', 'presencial', 'palermo', 'pausada'),
        ('a0000000-0000-0000-0000-000000000003', '${userA}', 'Convertida Padel', 'presencial', 'palermo', 'convertida'),
        ('a0000000-0000-0000-0000-000000000004', '${userA}', 'Cerrada Cine', 'presencial', 'palermo', 'cerrada');
    `);

    await setAuthContext(null);
    const res = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() as get_discovery_intenciones_activas;`
    );
    const items = res.rows[0].get_discovery_intenciones_activas;

    const ids = items.map((i: any) => i.id);
    assert.ok(ids.includes('a0000000-0000-0000-0000-000000000001'), 'Activa debe aparecer');
    assert.ok(!ids.includes('a0000000-0000-0000-0000-000000000002'), 'Pausada NO debe aparecer');
    assert.ok(!ids.includes('a0000000-0000-0000-0000-000000000003'), 'Convertida NO debe aparecer');
    assert.ok(!ids.includes('a0000000-0000-0000-0000-000000000004'), 'Cerrada NO debe aparecer');
  });

  test('3. Elegibilidad temporal: fecha_hasta vencida según Argentina se excluye; flexible sin fecha permanece', async () => {
    // Obtener la fecha actual en Argentina
    const dateQuery = await db.query<{ today_ar: string }>(
      `SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text as today_ar;`
    );
    const todayAr = dateQuery.rows[0].today_ar;

    await runAsAdmin(`
      INSERT INTO public.intenciones (id, user_id, titulo, modalidad, locality_id, estado, fecha_desde, fecha_hasta) VALUES
        ('b0000000-0000-0000-0000-000000000001', '${userB}', 'Vencida Ayer', 'presencial', 'palermo', 'activa', '${todayAr}'::date - 5, '${todayAr}'::date - 1),
        ('b0000000-0000-0000-0000-000000000002', '${userB}', 'Vigente Hoy', 'presencial', 'palermo', 'activa', '${todayAr}'::date, '${todayAr}'::date),
        ('b0000000-0000-0000-0000-000000000003', '${userB}', 'Vigente Futura', 'presencial', 'palermo', 'activa', '${todayAr}'::date, '${todayAr}'::date + 7),
        ('b0000000-0000-0000-0000-000000000004', '${userB}', 'Flexible Sin Fecha', 'presencial', 'palermo', 'activa', NULL, NULL);
    `);

    await setAuthContext(null);
    const res = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() as get_discovery_intenciones_activas;`
    );
    const ids = res.rows[0].get_discovery_intenciones_activas.map((i: any) => i.id);

    assert.ok(!ids.includes('b0000000-0000-0000-0000-000000000001'), 'Intención con fecha_hasta ayer NO debe aparecer');
    assert.ok(ids.includes('b0000000-0000-0000-0000-000000000002'), 'Intención que vence hoy en Argentina DEBE aparecer');
    assert.ok(ids.includes('b0000000-0000-0000-0000-000000000003'), 'Intención futura DEBE aparecer');
    assert.ok(ids.includes('b0000000-0000-0000-0000-000000000004'), 'Intención flexible sin fecha_hasta DEBE permanecer');
  });

  test('4. Filtro geográfico: filtra por localidad pero incluye siempre modalidad virtual', async () => {
    await runAsAdmin(`
      INSERT INTO public.intenciones (id, user_id, titulo, modalidad, locality_id, estado) VALUES
        ('c0000000-0000-0000-0000-000000000001', '${userA}', 'Encuentro en Palermo', 'presencial', 'palermo', 'activa'),
        ('c0000000-0000-0000-0000-000000000002', '${userA}', 'Encuentro en Güemes', 'presencial', 'guemes', 'activa'),
        ('c0000000-0000-0000-0000-000000000003', '${userA}', 'Partida de Ajedrez Online', 'virtual', 'recoleta', 'activa');
    `);

    await setAuthContext(null);
    // Filtrar sólo por 'palermo'
    const res = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas(ARRAY['palermo']::text[]) as get_discovery_intenciones_activas;`
    );
    const ids = res.rows[0].get_discovery_intenciones_activas.map((i: any) => i.id);

    assert.ok(ids.includes('c0000000-0000-0000-0000-000000000001'), 'Palermo debe aparecer');
    assert.ok(!ids.includes('c0000000-0000-0000-0000-000000000002'), 'Güemes NO debe aparecer al filtrar por Palermo');
    assert.ok(ids.includes('c0000000-0000-0000-0000-000000000003'), 'Virtual DEBE aparecer independientemente de localidad');
  });

  test('5. Sanitización del DTO: NUNCA expone user_id, encuentro_id, updated_at ni datos sensibles', async () => {
    await setAuthContext(null);
    const res = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() as get_discovery_intenciones_activas;`
    );
    const items = res.rows[0].get_discovery_intenciones_activas;
    assert.ok(items.length > 0);

    for (const item of items) {
      assert.equal(item.user_id, undefined, 'user_id NUNCA debe estar en el DTO');
      assert.equal(item.encuentro_id, undefined, 'encuentro_id NUNCA debe estar en el DTO');
      assert.equal(item.updated_at, undefined, 'updated_at NUNCA debe estar en el DTO');
      assert.equal(item.email, undefined, 'email NUNCA debe estar en el DTO');
      assert.equal(item.telefono, undefined, 'telefono NUNCA debe estar en el DTO');

      // Campos requeridos presentes
      assert.ok(typeof item.id === 'string');
      assert.ok(typeof item.titulo === 'string');
      assert.ok(typeof item.modalidad === 'string');
      assert.ok(typeof item.approximate_zone === 'string');
      assert.ok(typeof item.interested_count === 'number');
      assert.ok(typeof item.created_at === 'string');
      assert.ok(typeof item.is_own === 'boolean');
      assert.ok(typeof item.viewer_interested === 'boolean');
    }
  });

  test('6. is_own y viewer_interested: usuario anónimo recibe ambos en false', async () => {
    await setAuthContext(null);
    const res = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() as get_discovery_intenciones_activas;`
    );
    const items = res.rows[0].get_discovery_intenciones_activas;
    for (const item of items) {
      assert.equal(item.is_own, false, 'Anon siempre tiene is_own = false');
      assert.equal(item.viewer_interested, false, 'Anon siempre tiene viewer_interested = false');
    }
  });

  test('7. Conteo de intereses y viewer_interested para usuario autenticado', async () => {
    // userB y userC marcan interés en la intención 'a0000000-0000-0000-0000-000000000001' de userA
    await runAsAdmin(`
      INSERT INTO public.intencion_intereses (intencion_id, user_id) VALUES
        ('a0000000-0000-0000-0000-000000000001', '${userB}'),
        ('a0000000-0000-0000-0000-000000000001', '${userC}')
      ON CONFLICT DO NOTHING;
    `);

    // Consultar como userA (propietario)
    await setAuthContext(userA, false);
    const resA = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() as get_discovery_intenciones_activas;`
    );
    const itemA = resA.rows[0].get_discovery_intenciones_activas.find(
      (i: any) => i.id === 'a0000000-0000-0000-0000-000000000001'
    );
    assert.ok(itemA);
    assert.equal(itemA.is_own, true, 'userA es dueño de esta intención');
    assert.equal(itemA.interested_count, 2, 'interested_count debe reflejar 2 filas');
    assert.equal(itemA.viewer_interested, false, 'userA no ha marcado interés en su propia intención');

    // Consultar como userB (interesado, no propietario)
    await setAuthContext(userB, false);
    const resB = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() as get_discovery_intenciones_activas;`
    );
    const itemB = resB.rows[0].get_discovery_intenciones_activas.find(
      (i: any) => i.id === 'a0000000-0000-0000-0000-000000000001'
    );
    assert.ok(itemB);
    assert.equal(itemB.is_own, false, 'userB no es dueño');
    assert.equal(itemB.interested_count, 2, 'interested_count sigue siendo 2');
    assert.equal(itemB.viewer_interested, true, 'userB tiene viewer_interested = true');

    // Consultar intención sin intereses: interested_count debe ser 0
    const itemSinInteres = resB.rows[0].get_discovery_intenciones_activas.find(
      (i: any) => i.id === 'c0000000-0000-0000-0000-000000000001'
    );
    assert.ok(itemSinInteres);
    assert.equal(itemSinInteres.interested_count, 0, 'Debe ser 0 cuando no hay intereses');
    assert.equal(itemSinInteres.viewer_interested, false);
  });

  test('8. Seguridad RLS: intencion_intereses prohíbe acceso a anon y a usuarios ajenos', async () => {
    // Como anon: SELECT directo a intencion_intereses falla por falta de permisos (REVOKE)
    await setAuthContext(null);
    let anonDirectBlocked = false;
    try {
      await db.query(`SELECT * FROM public.intencion_intereses;`);
    } catch (err: any) {
      anonDirectBlocked = true;
    }
    assert.ok(anonDirectBlocked, 'anon no debe tener permisos SELECT sobre intencion_intereses');

    // Como userB: SELECT directo sólo devuelve sus propias filas, NUNCA las de userC
    await setAuthContext(userB, false);
    const resUserB = await db.query<{ user_id: string }>(
      `SELECT user_id FROM public.intencion_intereses;`
    );
    assert.equal(resUserB.rows.length, 1, 'userB solo debe ver su propia fila');
    assert.equal(resUserB.rows[0].user_id, userB);
  });
});
