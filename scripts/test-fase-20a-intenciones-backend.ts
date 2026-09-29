import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-A Intenciones — Bloque 1 Backend Core Tests', () => {
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

      -- Generic updated_at trigger function
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

      INSERT INTO public.localidades (id, nombre, ciudad, zona, pais, orden, activo) VALUES
        ('palermo', 'Palermo', 'Buenos Aires', 'CABA', 'AR', 1, true),
        ('guemes', 'Güemes', 'Mar del Plata', 'Costa Atlántica', 'AR', 2, true)
      ON CONFLICT DO NOTHING;

      -- Base encuentros table
      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL,
        creado_en TIMESTAMPTZ DEFAULT now()
      );
    `);

    // 2. Execute migration under test
    const migPath = path.resolve(process.cwd(), 'supabase/migrations/20260929170000_fase_20a_intenciones_core.sql');
    await db.exec(fs.readFileSync(migPath, 'utf-8'));
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

  const resetAuthContext = async () => {
    await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
    await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    await db.query(`RESET ROLE;`);
  };

  test('1. Permanente crea intención propia exitosamente', async () => {
    await setAuthContext(userA, false);

    const res = await db.query(`
      SELECT public.crear_intencion_segura(
        'Salir a correr por Palermo'::text,
        'Ritmo suave, 5k'::text,
        'mañana por la mañana'::text,
        '2026-10-01'::date,
        '2026-10-01'::date,
        'presencial'::text,
        'palermo'::text
      ) as result;
    `);

    await resetAuthContext();
    const out = (res.rows[0] as any).result;
    assert.equal(out.ok, true);
    assert.ok(out.id);

    // Verificar datos persistidos en tabla
    const rowRes = await db.query(`SELECT * FROM public.intenciones WHERE id = '${out.id}';`);
    const row = rowRes.rows[0] as any;
    assert.equal(row.user_id, userA);
    assert.equal(row.titulo, 'Salir a correr por Palermo');
    assert.equal(row.descripcion, 'Ritmo suave, 5k');
    assert.equal(row.temporalidad_texto, 'mañana por la mañana');
    assert.equal(row.modalidad, 'presencial');
    assert.equal(row.locality_id, 'palermo');
    assert.equal(row.estado, 'activa');
    assert.equal(row.encuentro_id, null);
  });

  test('2. Usuario anónimo no puede crear intención', async () => {
    await setAuthContext(userAnon, true);

    const res = await db.query(`
      SELECT public.crear_intencion_segura('Jugar al pádel'::text) as result;
    `);

    await resetAuthContext();
    const out = (res.rows[0] as any).result;
    assert.equal(out.ok, false);
    assert.equal(out.error, 'permanent_account_required');
  });

  test('3. user_id del cliente no puede suplantar propietario (contrato sin parámetro user_id)', async () => {
    // La RPC ni siquiera acepta un parámetro user_id, deriva siempre de auth.uid()
    await setAuthContext(userA, false);
    const res = await db.query(`
      SELECT public.crear_intencion_segura('Cine el viernes'::text) as result;
    `);
    await resetAuthContext();
    const out = (res.rows[0] as any).result;
    assert.equal(out.ok, true);

    const rowRes = await db.query(`SELECT user_id FROM public.intenciones WHERE id = '${out.id}';`);
    assert.equal((rowRes.rows[0] as any).user_id, userA);
  });

  test('4. Usuario A no puede leer ni modificar la intención de Usuario B', async () => {
    // User B crea intención
    await setAuthContext(userB, false);
    const resB = await db.query(`
      SELECT public.crear_intencion_segura('Tarde de café en Güemes'::text, NULL, NULL, NULL, NULL, 'presencial'::text, 'guemes'::text) as result;
    `);
    const idB = (resB.rows[0] as any).result.id;

    // User A intenta listar mis intenciones
    await setAuthContext(userA, false);
    const listRes = await db.query(`SELECT public.get_mis_intenciones_seguro() as result;`);
    const listOut = (listRes.rows[0] as any).result;
    assert.equal(listOut.ok, true);
    const foundInA = listOut.intenciones.some((i: any) => i.id === idB);
    assert.equal(foundInA, false, 'User A no debe ver la intención de B en get_mis_intenciones_seguro');

    // User A intenta editar la intención de User B
    const editRes = await db.query(`
      SELECT public.editar_intencion_segura('${idB}'::uuid, 'Hackeada por A'::text) as result;
    `);
    const editOut = (editRes.rows[0] as any).result;
    assert.equal(editOut.ok, false);
    assert.equal(editOut.error, 'intencion_not_found');

    // User A intenta cambiar estado de la intención de User B
    const stateRes = await db.query(`
      SELECT public.cambiar_estado_intencion_segura('${idB}'::uuid, 'cerrada'::text) as result;
    `);
    const stateOut = (stateRes.rows[0] as any).result;
    assert.equal(stateOut.ok, false);
    assert.equal(stateOut.error, 'intencion_not_found');

    // RLS directa: User A no puede hacer SELECT directo sobre intención de B
    const rlsSelect = await db.query(`SELECT * FROM public.intenciones WHERE id = '${idB}';`);
    assert.equal(rlsSelect.rows.length, 0, 'RLS debe ocultar la fila de B ante SELECT de A');

    await resetAuthContext();
  });

  test('5. Título vacío o excesivo (>120) es rechazado', async () => {
    await setAuthContext(userA, false);

    // Vacío
    const rEmpty = await db.query(`SELECT public.crear_intencion_segura('   '::text) as result;`);
    assert.equal((rEmpty.rows[0] as any).result.ok, false);
    assert.equal((rEmpty.rows[0] as any).result.error, 'invalid_title');

    // > 120 caracteres
    const tooLong = 'A'.repeat(121);
    const rLong = await db.query(`SELECT public.crear_intencion_segura('${tooLong}'::text) as result;`);
    assert.equal((rLong.rows[0] as any).result.ok, false);
    assert.equal((rLong.rows[0] as any).result.error, 'invalid_title');

    await resetAuthContext();
  });

  test('6. Modalidad inválida es rechazada', async () => {
    await setAuthContext(userA, false);

    const res = await db.query(`
      SELECT public.crear_intencion_segura('Título'::text, NULL, NULL, NULL, NULL, 'invalida'::text) as result;
    `);
    const out = (res.rows[0] as any).result;
    assert.equal(out.ok, false);
    assert.equal(out.error, 'invalid_modality');

    await resetAuthContext();
  });

  test('7. Estado inválido es rechazado', async () => {
    await setAuthContext(userA, false);
    const createRes = await db.query(`SELECT public.crear_intencion_segura('Test estados'::text) as result;`);
    const id = (createRes.rows[0] as any).result.id;

    const res = await db.query(`
      SELECT public.cambiar_estado_intencion_segura('${id}'::uuid, 'estado_falso'::text) as result;
    `);
    const out = (res.rows[0] as any).result;
    assert.equal(out.ok, false);
    assert.equal(out.error, 'invalid_state');

    await resetAuthContext();
  });

  test('8. fecha_desde > fecha_hasta es rechazada', async () => {
    await setAuthContext(userA, false);

    const res = await db.query(`
      SELECT public.crear_intencion_segura(
        'Fecha invertida'::text,
        NULL,
        NULL,
        '2026-10-10'::date,
        '2026-10-05'::date
      ) as result;
    `);
    const out = (res.rows[0] as any).result;
    assert.equal(out.ok, false);
    assert.equal(out.error, 'invalid_date_range');

    await resetAuthContext();
  });

  test('9. Transición activa ↔ pausada ↔ activa', async () => {
    await setAuthContext(userA, false);
    const createRes = await db.query(`SELECT public.crear_intencion_segura('Pausa test'::text) as result;`);
    const id = (createRes.rows[0] as any).result.id;

    // activa -> pausada
    const rPause = await db.query(`SELECT public.cambiar_estado_intencion_segura('${id}'::uuid, 'pausada'::text) as result;`);
    assert.equal((rPause.rows[0] as any).result.ok, true);
    assert.equal((rPause.rows[0] as any).result.estado, 'pausada');

    // pausada -> activa
    const rResume = await db.query(`SELECT public.cambiar_estado_intencion_segura('${id}'::uuid, 'activa'::text) as result;`);
    assert.equal((rResume.rows[0] as any).result.ok, true);
    assert.equal((rResume.rows[0] as any).result.estado, 'activa');

    await resetAuthContext();
  });

  test('10. Transición activa o pausada → cerrada', async () => {
    await setAuthContext(userA, false);

    // activa -> cerrada
    const c1 = await db.query(`SELECT public.crear_intencion_segura('Cerrar activa'::text) as result;`);
    const id1 = (c1.rows[0] as any).result.id;
    const rClose1 = await db.query(`SELECT public.cambiar_estado_intencion_segura('${id1}'::uuid, 'cerrada'::text) as result;`);
    assert.equal((rClose1.rows[0] as any).result.ok, true);
    assert.equal((rClose1.rows[0] as any).result.estado, 'cerrada');

    // pausada -> cerrada
    const c2 = await db.query(`SELECT public.crear_intencion_segura('Cerrar pausada'::text) as result;`);
    const id2 = (c2.rows[0] as any).result.id;
    await db.query(`SELECT public.cambiar_estado_intencion_segura('${id2}'::uuid, 'pausada'::text);`);
    const rClose2 = await db.query(`SELECT public.cambiar_estado_intencion_segura('${id2}'::uuid, 'cerrada'::text) as result;`);
    assert.equal((rClose2.rows[0] as any).result.ok, true);
    assert.equal((rClose2.rows[0] as any).result.estado, 'cerrada');

    await resetAuthContext();
  });

  test('11. Intención cerrada no puede reactivarse (terminal)', async () => {
    await setAuthContext(userA, false);
    const c = await db.query(`SELECT public.crear_intencion_segura('Cerrar irreversible'::text) as result;`);
    const id = (c.rows[0] as any).result.id;
    await db.query(`SELECT public.cambiar_estado_intencion_segura('${id}'::uuid, 'cerrada'::text);`);

    const rReopen = await db.query(`SELECT public.cambiar_estado_intencion_segura('${id}'::uuid, 'activa'::text) as result;`);
    assert.equal((rReopen.rows[0] as any).result.ok, false);
    assert.equal((rReopen.rows[0] as any).result.error, 'intencion_already_closed');

    // Tampoco se puede editar si está cerrada
    const rEdit = await db.query(`SELECT public.editar_intencion_segura('${id}'::uuid, 'Nuevo título'::text) as result;`);
    assert.equal((rEdit.rows[0] as any).result.ok, false);
    assert.equal((rEdit.rows[0] as any).result.error, 'intencion_already_terminal');

    await resetAuthContext();
  });

  test('12. No se puede marcar manualmente como convertida', async () => {
    await setAuthContext(userA, false);
    const c = await db.query(`SELECT public.crear_intencion_segura('Intento convert'::text) as result;`);
    const id = (c.rows[0] as any).result.id;

    const rConvert = await db.query(`SELECT public.cambiar_estado_intencion_segura('${id}'::uuid, 'convertida'::text) as result;`);
    assert.equal((rConvert.rows[0] as any).result.ok, false);
    assert.equal((rConvert.rows[0] as any).result.error, 'manual_conversion_not_allowed');

    await resetAuthContext();
  });

  test('13. Cierre es soft-delete (el registro permanece en base de datos con estado cerrada)', async () => {
    await setAuthContext(userA, false);
    const c = await db.query(`SELECT public.crear_intencion_segura('Soft delete check'::text) as result;`);
    const id = (c.rows[0] as any).result.id;

    await db.query(`SELECT public.cambiar_estado_intencion_segura('${id}'::uuid, 'cerrada'::text);`);

    await resetAuthContext();
    const checkRow = await db.query(`SELECT id, estado FROM public.intenciones WHERE id = '${id}';`);
    assert.equal(checkRow.rows.length, 1, 'La fila DEBE existir en DB tras el cierre');
    assert.equal((checkRow.rows[0] as any).estado, 'cerrada');
  });
});
