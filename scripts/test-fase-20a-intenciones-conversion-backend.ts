import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-A Intenciones — Bloque 4 Backend: convertir_intencion_a_encuentro RPC', () => {
  let db: PGlite;
  const userA = '11111111-1111-1111-1111-111111111111';
  const userB = '22222222-2222-2222-2222-222222222222';
  const userAnon = '33333333-3333-3333-3333-333333333333';

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
        ('${userAnon}', 'anon@test.com')
      ON CONFLICT DO NOTHING;

      -- Base encuentros table
      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL,
        creado_en TIMESTAMPTZ DEFAULT now()
      );
      GRANT ALL ON TABLE public.encuentros TO authenticated, anon, service_role;

      -- Base localidades
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
    `);

    // 2. Cargar migración Bloque 1
    const migration1Path = path.join(
      process.cwd(),
      'supabase/migrations/20260929170000_fase_20a_intenciones_core.sql'
    );
    const sql1 = fs.readFileSync(migration1Path, 'utf-8');
    await db.exec(sql1);

    // 3. Cargar migración Bloque 4
    const migration4Path = path.join(
      process.cwd(),
      'supabase/migrations/20260929180000_fase_20a_intenciones_conversion.sql'
    );
    const sql4 = fs.readFileSync(migration4Path, 'utf-8');
    await db.exec(sql4);
  });

  const setAuthContext = async (userId: string | null, isAnonymous: boolean = false) => {
    if (!userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
      await db.query(`SET ROLE anon;`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": ${isAnonymous}}', false);`);
      await db.query(`SET ROLE authenticated;`);
    }
  };

  test('1. Owner convierte intención activa exitosamente a encuentro propio', async () => {
    await setAuthContext(userA, false);

    // Crear intención activa
    const { rows: intRows }: any = await db.query(
      `SELECT public.crear_intencion_segura('Jugar al tenis', 'Singles o dobles') AS res;`
    );
    const intRes = intRows[0].res;
    assert.equal(intRes.ok, true);
    const intencionId = intRes.id;

    // Crear encuentro propio
    const { rows: encRows }: any = await db.query(
      `INSERT INTO public.encuentros (host_id, titulo) VALUES ('${userA}', 'Tenis el sábado') RETURNING id;`
    );
    const encuentroId = encRows[0].id;

    // Convertir
    const { rows: convRows }: any = await db.query(
      `SELECT public.convertir_intencion_a_encuentro('${intencionId}', '${encuentroId}') AS res;`
    );
    const convRes = convRows[0].res;

    assert.equal(convRes.ok, true);
    assert.equal(convRes.id, intencionId);
    assert.equal(convRes.encuentro_id, encuentroId);
    assert.equal(convRes.estado, 'convertida');

    // Verificar en DB
    const { rows: verifyRows }: any = await db.query(
      `SELECT estado, encuentro_id FROM public.intenciones WHERE id = '${intencionId}';`
    );
    assert.equal(verifyRows[0].estado, 'convertida');
    assert.equal(verifyRows[0].encuentro_id, encuentroId);
  });

  test('2. Owner convierte intención pausada exitosamente a encuentro propio', async () => {
    await setAuthContext(userA, false);

    // Crear intención y pausarla
    const { rows: intRows }: any = await db.query(
      `SELECT public.crear_intencion_segura('Ir a caminar', 'Por la costanera') AS res;`
    );
    const intencionId = intRows[0].res.id;
    await db.query(`SELECT public.cambiar_estado_intencion_segura('${intencionId}', 'pausada');`);

    // Crear encuentro propio
    const { rows: encRows }: any = await db.query(
      `INSERT INTO public.encuentros (host_id, titulo) VALUES ('${userA}', 'Caminata grupal') RETURNING id;`
    );
    const encuentroId = encRows[0].id;

    // Convertir
    const { rows: convRows }: any = await db.query(
      `SELECT public.convertir_intencion_a_encuentro('${intencionId}', '${encuentroId}') AS res;`
    );
    const convRes = convRows[0].res;
    assert.equal(convRes.ok, true);
    assert.equal(convRes.estado, 'convertida');

    // Verificar en DB
    const { rows: verifyRows }: any = await db.query(
      `SELECT estado, encuentro_id FROM public.intenciones WHERE id = '${intencionId}';`
    );
    assert.equal(verifyRows[0].estado, 'convertida');
    assert.equal(verifyRows[0].encuentro_id, encuentroId);
  });

  test('3. Usuario A no puede convertir la intención de Usuario B (unauthorized)', async () => {
    // Usuario B crea su intención
    await setAuthContext(userB, false);
    const { rows: intRows }: any = await db.query(
      `SELECT public.crear_intencion_segura('Intención de B', 'Secreta') AS res;`
    );
    const intencionIdB = intRows[0].res.id;

    // Usuario A intenta convertirla a un encuentro de A
    await setAuthContext(userA, false);
    const { rows: encRows }: any = await db.query(
      `INSERT INTO public.encuentros (host_id, titulo) VALUES ('${userA}', 'Encuentro de A') RETURNING id;`
    );
    const encuentroIdA = encRows[0].id;

    const { rows: convRows }: any = await db.query(
      `SELECT public.convertir_intencion_a_encuentro('${intencionIdB}', '${encuentroIdA}') AS res;`
    );
    assert.equal(convRows[0].res.ok, false);
    assert.equal(convRows[0].res.error, 'unauthorized');
  });

  test('4. Usuario A no puede vincular su intención a un encuentro de Usuario B (unauthorized_encounter)', async () => {
    // Usuario A crea su intención
    await setAuthContext(userA, false);
    const { rows: intRows }: any = await db.query(
      `SELECT public.crear_intencion_segura('Intención de A', 'Normal') AS res;`
    );
    const intencionIdA = intRows[0].res.id;

    // Encuentro pertenece a Usuario B
    const { rows: encRows }: any = await db.query(
      `INSERT INTO public.encuentros (host_id, titulo) VALUES ('${userB}', 'Encuentro de B') RETURNING id;`
    );
    const encuentroIdB = encRows[0].id;

    // Usuario A intenta vincular al encuentro de B
    const { rows: convRows }: any = await db.query(
      `SELECT public.convertir_intencion_a_encuentro('${intencionIdA}', '${encuentroIdB}') AS res;`
    );
    assert.equal(convRows[0].res.ok, false);
    assert.equal(convRows[0].res.error, 'unauthorized_encounter');
  });

  test('5. Intención cerrada no puede convertirse (intention_closed)', async () => {
    await setAuthContext(userA, false);
    const { rows: intRows }: any = await db.query(
      `SELECT public.crear_intencion_segura('Cine club', 'Películas') AS res;`
    );
    const intId = intRows[0].res.id;
    await db.query(`SELECT public.cambiar_estado_intencion_segura('${intId}', 'cerrada');`);

    const { rows: encRows }: any = await db.query(
      `INSERT INTO public.encuentros (host_id, titulo) VALUES ('${userA}', 'Noche de cine') RETURNING id;`
    );
    const encId = encRows[0].id;

    const { rows: convRows }: any = await db.query(
      `SELECT public.convertir_intencion_a_encuentro('${intId}', '${encId}') AS res;`
    );
    assert.equal(convRows[0].res.ok, false);
    assert.equal(convRows[0].res.error, 'intention_closed');
  });

  test('6. Intención ya convertida rechaza conversión a OTRO encuentro (already_converted)', async () => {
    await setAuthContext(userA, false);
    const { rows: intRows }: any = await db.query(
      `SELECT public.crear_intencion_segura('Pádel viernes', 'Cancha 2') AS res;`
    );
    const intId = intRows[0].res.id;

    const { rows: encRows1 }: any = await db.query(
      `INSERT INTO public.encuentros (host_id, titulo) VALUES ('${userA}', 'Pádel 1') RETURNING id;`
    );
    const encId1 = encRows1[0].id;

    const { rows: encRows2 }: any = await db.query(
      `INSERT INTO public.encuentros (host_id, titulo) VALUES ('${userA}', 'Pádel 2') RETURNING id;`
    );
    const encId2 = encRows2[0].id;

    // Primera conversión exitosa
    await db.query(`SELECT public.convertir_intencion_a_encuentro('${intId}', '${encId1}');`);

    // Intento de conversión a un segundo encuentro distinto
    const { rows: convRows2 }: any = await db.query(
      `SELECT public.convertir_intencion_a_encuentro('${intId}', '${encId2}') AS res;`
    );
    assert.equal(convRows2[0].res.ok, false);
    assert.equal(convRows2[0].res.error, 'already_converted');
  });

  test('7. Retry con el mismo encuentro es idempotente y devuelve ok: true', async () => {
    await setAuthContext(userA, false);
    const { rows: intRows }: any = await db.query(
      `SELECT public.crear_intencion_segura('Café y charlas', 'Plaza') AS res;`
    );
    const intId = intRows[0].res.id;

    const { rows: encRows }: any = await db.query(
      `INSERT INTO public.encuentros (host_id, titulo) VALUES ('${userA}', 'Charla café') RETURNING id;`
    );
    const encId = encRows[0].id;

    // Llamada 1
    const { rows: res1 }: any = await db.query(
      `SELECT public.convertir_intencion_a_encuentro('${intId}', '${encId}') AS res;`
    );
    assert.equal(res1[0].res.ok, true);

    // Llamada 2 (retry idéntico)
    const { rows: res2 }: any = await db.query(
      `SELECT public.convertir_intencion_a_encuentro('${intId}', '${encId}') AS res;`
    );
    assert.equal(res2[0].res.ok, true);
    assert.equal(res2[0].res.idempotent, true);
    assert.equal(res2[0].res.estado, 'convertida');
  });

  test('8. Encuentro inexistente rechaza con encounter_not_found', async () => {
    await setAuthContext(userA, false);
    const { rows: intRows }: any = await db.query(
      `SELECT public.crear_intencion_segura('Astronomía', 'Mirar estrellas') AS res;`
    );
    const intId = intRows[0].res.id;
    const fakeEncuentroId = '99999999-9999-9999-9999-999999999999';

    const { rows: convRows }: any = await db.query(
      `SELECT public.convertir_intencion_a_encuentro('${intId}', '${fakeEncuentroId}') AS res;`
    );
    assert.equal(convRows[0].res.ok, false);
    assert.equal(convRows[0].res.error, 'encounter_not_found');
  });

  test('9. Usuario anónimo no puede convertir intención (permanent_account_required)', async () => {
    await setAuthContext(userAnon, true);
    const fakeId = '11111111-2222-3333-4444-555555555555';

    const { rows: convRows }: any = await db.query(
      `SELECT public.convertir_intencion_a_encuentro('${fakeId}', '${fakeId}') AS res;`
    );
    assert.equal(convRows[0].res.ok, false);
    assert.equal(convRows[0].res.error, 'permanent_account_required');
  });
});
