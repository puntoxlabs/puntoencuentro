import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-B Discovery Unificado — Bloque 2 Backend: Interés Social Idempotente', () => {
  let db: PGlite;
  const userAuthor = '11111111-1111-1111-1111-111111111111';
  const userInteresadoA = '22222222-2222-2222-2222-222222222222';
  const userInteresadoB = '33333333-3333-3333-3333-333333333333';
  const userAnon = '44444444-4444-4444-4444-444444444444';

  let todayAr: string;

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
        ('${userAuthor}', 'author@test.com'),
        ('${userInteresadoA}', 'interesadoA@test.com'),
        ('${userInteresadoB}', 'interesadoB@test.com'),
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
        ('recoleta', 'Recoleta', 'CABA', 'Centro', 'AR', 2, true)
      ON CONFLICT DO NOTHING;

      -- Tabla intenciones
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
        encuentro_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
        CONSTRAINT check_intenciones_titulo CHECK (length(trim(titulo)) > 0 AND length(titulo) <= 120),
        CONSTRAINT check_intenciones_modalidad CHECK (modalidad IN ('presencial', 'virtual', 'indistinto')),
        CONSTRAINT check_intenciones_estado CHECK (estado IN ('activa', 'pausada', 'convertida', 'cerrada'))
      );

      ALTER TABLE public.intenciones ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE public.intenciones FROM PUBLIC, anon;

      -- B1: Tabla intencion_intereses
      CREATE TABLE IF NOT EXISTS public.intencion_intereses (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          intencion_id UUID NOT NULL REFERENCES public.intenciones(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
          CONSTRAINT uq_intencion_intereses UNIQUE (intencion_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_intencion_intereses_intencion_id ON public.intencion_intereses(intencion_id);
      CREATE INDEX IF NOT EXISTS idx_intencion_intereses_user_id ON public.intencion_intereses(user_id);

      ALTER TABLE public.intencion_intereses ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE public.intencion_intereses FROM PUBLIC, anon;
      GRANT SELECT ON TABLE public.intencion_intereses TO authenticated;

      DROP POLICY IF EXISTS intencion_intereses_select_own ON public.intencion_intereses;
      CREATE POLICY intencion_intereses_select_own ON public.intencion_intereses
          FOR SELECT TO authenticated
          USING (auth.uid() = user_id);

      -- B1: RPC get_discovery_intenciones_activas
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

      -- B2: RPC set_interes_intencion
      CREATE OR REPLACE FUNCTION public.set_interes_intencion(
          p_intencion_id UUID,
          p_interesado BOOLEAN
      )
      RETURNS JSONB
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $func$
      DECLARE
          v_user_id UUID := auth.uid();
          v_is_anon BOOLEAN;
          v_intencion RECORD;
          v_count INT;
      BEGIN
          -- 1. Validar autenticación
          IF v_user_id IS NULL THEN
              RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
          END IF;

          -- 2. Rechazar cuentas anónimas
          v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
          IF v_is_anon THEN
              RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
          END IF;

          -- 3. Validar parámetros requeridos
          IF p_intencion_id IS NULL OR p_interesado IS NULL THEN
              RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
          END IF;

          -- 4. Verificar intención objetivo (existencia, estado y vigencia temporal según Argentina)
          SELECT id, user_id, estado, fecha_hasta
          INTO v_intencion
          FROM public.intenciones
          WHERE id = p_intencion_id;

          IF NOT FOUND 
             OR v_intencion.estado <> 'activa'
             OR NOT (
                 v_intencion.fecha_hasta IS NULL 
                 OR v_intencion.fecha_hasta >= (pg_catalog.now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
             ) THEN
              RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intention_not_found_or_inactive');
          END IF;

          -- 5. Interés propio: El autor no puede marcar interés en su propia intención
          IF v_intencion.user_id = v_user_id THEN
              RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_interest_own_intention');
          END IF;

          -- 6. Operación idempotente
          IF p_interesado = true THEN
              INSERT INTO public.intencion_intereses (
                  intencion_id,
                  user_id
              )
              VALUES (
                  p_intencion_id,
                  v_user_id
              )
              ON CONFLICT (intencion_id, user_id)
              DO NOTHING;
          ELSE
              DELETE FROM public.intencion_intereses
              WHERE intencion_id = p_intencion_id
                AND user_id = v_user_id;
          END IF;

          -- 7. Calcular conteo final posterior a la operación
          SELECT COALESCE(pg_catalog.count(*)::int, 0)
          INTO v_count
          FROM public.intencion_intereses
          WHERE intencion_id = p_intencion_id;

          -- 8. Retorno estructurado
          RETURN pg_catalog.jsonb_build_object(
              'ok', true,
              'interesado', p_interesado,
              'interested_count', v_count
          );
      END;
      $func$;

      REVOKE ALL ON FUNCTION public.set_interes_intencion(UUID, BOOLEAN) FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.set_interes_intencion(UUID, BOOLEAN) TO authenticated;
    `);

    // Obtener fecha actual en Argentina
    const dateQuery = await db.query<{ today_ar: string }>(
      `SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text as today_ar;`
    );
    todayAr = dateQuery.rows[0].today_ar;

    // Insertar intenciones de prueba como superusuario
    await runAsAdmin(`
      INSERT INTO public.intenciones (id, user_id, titulo, modalidad, locality_id, estado, fecha_desde, fecha_hasta) VALUES
        ('10000000-0000-0000-0000-000000000001', '${userAuthor}', 'Activa Flexible', 'presencial', 'palermo', 'activa', NULL, NULL),
        ('10000000-0000-0000-0000-000000000002', '${userAuthor}', 'Activa Vigente Hoy', 'presencial', 'palermo', 'activa', '${todayAr}'::date, '${todayAr}'::date),
        ('10000000-0000-0000-0000-000000000003', '${userAuthor}', 'Vencida Ayer', 'presencial', 'palermo', 'activa', '${todayAr}'::date - 5, '${todayAr}'::date - 1),
        ('10000000-0000-0000-0000-000000000004', '${userAuthor}', 'Pausada', 'presencial', 'palermo', 'pausada', NULL, NULL),
        ('10000000-0000-0000-0000-000000000005', '${userAuthor}', 'Convertida', 'presencial', 'palermo', 'convertida', NULL, NULL),
        ('10000000-0000-0000-0000-000000000006', '${userAuthor}', 'Cerrada', 'presencial', 'palermo', 'cerrada', NULL, NULL);
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

  test('1. Permisos: anónimo y sin autenticación no pueden ejecutar set_interes_intencion', async () => {
    // Sin autenticación (rol anon)
    await setAuthContext(null);
    let anonExecFailed = false;
    try {
      await db.query(
        `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000001'::uuid, true);`
      );
    } catch {
      anonExecFailed = true;
    }
    assert.ok(anonExecFailed, 'anon no debe tener permisos de EXECUTE sobre set_interes_intencion');

    // Cuenta anónima con rol authenticated pero claim is_anonymous = true
    await setAuthContext(userAnon, true);
    const resAnon = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000001'::uuid, true);`
    );
    assert.deepEqual(resAnon.rows[0].set_interes_intencion, {
      ok: false,
      error: 'permanent_account_required'
    });
  });

  test('2. Autor no puede marcar interés en su propia intención', async () => {
    await setAuthContext(userAuthor, false);
    const res = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000001'::uuid, true);`
    );
    assert.deepEqual(res.rows[0].set_interes_intencion, {
      ok: false,
      error: 'cannot_interest_own_intention'
    });
  });

  test('3. Intenciones no elegibles son rechazadas (pausada, convertida, cerrada, vencida, inexistente)', async () => {
    await setAuthContext(userInteresadoA, false);

    // Inexistente
    const resInexistente = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('99999999-9999-9999-9999-999999999999'::uuid, true);`
    );
    assert.equal(resInexistente.rows[0].set_interes_intencion.error, 'intention_not_found_or_inactive');

    // Pausada
    const resPausada = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000004'::uuid, true);`
    );
    assert.equal(resPausada.rows[0].set_interes_intencion.error, 'intention_not_found_or_inactive');

    // Convertida
    const resConvertida = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000005'::uuid, true);`
    );
    assert.equal(resConvertida.rows[0].set_interes_intencion.error, 'intention_not_found_or_inactive');

    // Cerrada
    const resCerrada = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000006'::uuid, true);`
    );
    assert.equal(resCerrada.rows[0].set_interes_intencion.error, 'intention_not_found_or_inactive');

    // Vencida ayer según timezone Argentina
    const resVencida = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000003'::uuid, true);`
    );
    assert.equal(resVencida.rows[0].set_interes_intencion.error, 'intention_not_found_or_inactive');
  });

  test('4. Usuario permanente marca interés en intención flexible y vigente: éxito, idempotencia y conteo exacto', async () => {
    await setAuthContext(userInteresadoA, false);

    // Primer alta
    const res1 = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000001'::uuid, true);`
    );
    assert.deepEqual(res1.rows[0].set_interes_intencion, {
      ok: true,
      interesado: true,
      interested_count: 1
    });

    // Segunda alta idéntica (idempotencia true -> true)
    const res2 = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000001'::uuid, true);`
    );
    assert.deepEqual(res2.rows[0].set_interes_intencion, {
      ok: true,
      interesado: true,
      interested_count: 1
    });

    // Verificar en tabla que sólo existe 1 fila
    const countQuery = await runAsAdmin(`
      SELECT count(*)::int as cnt FROM public.intencion_intereses 
      WHERE intencion_id = '10000000-0000-0000-0000-000000000001' AND user_id = '${userInteresadoA}';
    `);
    assert.equal((countQuery as any)[0].rows[0].cnt, 1);
  });

  test('5. Múltiples usuarios pueden interesarse independientemente', async () => {
    // userInteresadoB marca interés en la misma intención
    await setAuthContext(userInteresadoB, false);
    const resB = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000001'::uuid, true);`
    );
    assert.deepEqual(resB.rows[0].set_interes_intencion, {
      ok: true,
      interesado: true,
      interested_count: 2
    });

    // Verificar total en tabla
    const totalQuery = await runAsAdmin(`
      SELECT count(*)::int as cnt FROM public.intencion_intereses 
      WHERE intencion_id = '10000000-0000-0000-0000-000000000001';
    `);
    assert.equal((totalQuery as any)[0].rows[0].cnt, 2);
  });

  test('5b. Concurrencia: dos altas simultáneas del mismo usuario no duplican fila', async () => {
    await setAuthContext(userInteresadoA, false);
    // Ejecutar dos altas concurrentes
    const [res1, res2] = await Promise.all([
      db.query<{ set_interes_intencion: any }>(
        `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000002'::uuid, true);`
      ),
      db.query<{ set_interes_intencion: any }>(
        `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000002'::uuid, true);`
      )
    ]);

    assert.equal(res1.rows[0].set_interes_intencion.ok, true);
    assert.equal(res2.rows[0].set_interes_intencion.ok, true);

    const countQuery = await runAsAdmin(`
      SELECT count(*)::int as cnt FROM public.intencion_intereses 
      WHERE intencion_id = '10000000-0000-0000-0000-000000000002' AND user_id = '${userInteresadoA}';
    `);
    assert.equal((countQuery as any)[0].rows[0].cnt, 1, 'Debe haber exactamente 1 fila');
  });

  test('6. Usuario permanente retira interés: éxito, idempotencia y decremento exacto', async () => {
    await setAuthContext(userInteresadoA, false);

    // Primera baja
    const res1 = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000001'::uuid, false);`
    );
    assert.deepEqual(res1.rows[0].set_interes_intencion, {
      ok: true,
      interesado: false,
      interested_count: 1 // Queda todavía userInteresadoB
    });

    // Segunda baja idéntica (idempotencia false -> false)
    const res2 = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000001'::uuid, false);`
    );
    assert.deepEqual(res2.rows[0].set_interes_intencion, {
      ok: true,
      interesado: false,
      interested_count: 1
    });

    // userInteresadoB también se retira
    await setAuthContext(userInteresadoB, false);
    const resB = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000001'::uuid, false);`
    );
    assert.deepEqual(resB.rows[0].set_interes_intencion, {
      ok: true,
      interesado: false,
      interested_count: 0
    });

    // Verificar en tabla que quedaron 0 filas
    const countQuery = await runAsAdmin(`
      SELECT count(*)::int as cnt FROM public.intencion_intereses 
      WHERE intencion_id = '10000000-0000-0000-0000-000000000001';
    `);
    assert.equal((countQuery as any)[0].rows[0].cnt, 0);
  });

  test('7. Integración con B1: get_discovery_intenciones_activas refleja viewer_interested y count tras alta y baja', async () => {
    // Estado inicial: 0 intereses
    await setAuthContext(userInteresadoA, false);
    let feed = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() as get_discovery_intenciones_activas;`
    );
    let item = feed.rows[0].get_discovery_intenciones_activas.find(
      (i: any) => i.id === '10000000-0000-0000-0000-000000000001'
    );
    assert.ok(item);
    assert.equal(item.interested_count, 0);
    assert.equal(item.viewer_interested, false);

    // Alta de interés
    await db.query(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000001'::uuid, true);`
    );

    // Consultar feed nuevamente como userInteresadoA
    feed = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() as get_discovery_intenciones_activas;`
    );
    item = feed.rows[0].get_discovery_intenciones_activas.find(
      (i: any) => i.id === '10000000-0000-0000-0000-000000000001'
    );
    assert.equal(item.interested_count, 1);
    assert.equal(item.viewer_interested, true);

    // Consultar feed como otro usuario (userInteresadoB)
    await setAuthContext(userInteresadoB, false);
    feed = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() as get_discovery_intenciones_activas;`
    );
    item = feed.rows[0].get_discovery_intenciones_activas.find(
      (i: any) => i.id === '10000000-0000-0000-0000-000000000001'
    );
    assert.equal(item.interested_count, 1, 'Otro usuario ve el contador incrementado');
    assert.equal(item.viewer_interested, false, 'Otro usuario NO tiene viewer_interested = true');

    // Baja de interés por userInteresadoA
    await setAuthContext(userInteresadoA, false);
    await db.query(
      `SELECT public.set_interes_intencion('10000000-0000-0000-0000-000000000001'::uuid, false);`
    );

    // Consultar feed post-baja
    feed = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() as get_discovery_intenciones_activas;`
    );
    item = feed.rows[0].get_discovery_intenciones_activas.find(
      (i: any) => i.id === '10000000-0000-0000-0000-000000000001'
    );
    assert.equal(item.interested_count, 0);
    assert.equal(item.viewer_interested, false);
  });
});
