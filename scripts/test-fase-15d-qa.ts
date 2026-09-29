import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 1.5-D — QA Especifico de Entitlements & Metering', () => {
  let db: PGlite;
  const userPermA = '11111111-1111-1111-1111-111111111111';
  const userPermB = '22222222-2222-2222-2222-222222222222';
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

      INSERT INTO auth.users (id, email) VALUES
        ('${userPermA}', 'userA@test.com'),
        ('${userPermB}', 'userB@test.com'),
        ('${userAnon}', 'anon@test.com')
      ON CONFLICT DO NOTHING;

      -- Base encounters table
      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL,
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      -- Base ai_creation_sessions table
      CREATE TABLE IF NOT EXISTS public.ai_creation_sessions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'started',
        encounter_id UUID REFERENCES public.encuentros(id) ON DELETE SET NULL,
        turns INT NOT NULL DEFAULT 0,
        input_tokens INT NOT NULL DEFAULT 0,
        output_tokens INT NOT NULL DEFAULT 0,
        total_latency_ms INT NOT NULL DEFAULT 0,
        elapsed_ms INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ
      );
    `);

    // 2. Execute 1.5-D migrations in PostgreSQL
    const mig1Path = path.resolve(process.cwd(), 'supabase/migrations/20260928200000_fase_15d_entitlements_and_metering.sql');
    await db.exec(fs.readFileSync(mig1Path, 'utf-8'));

    const mig2Path = path.resolve(process.cwd(), 'supabase/migrations/20260929141500_harden_complete_ai_creation_session.sql');
    await db.exec(fs.readFileSync(mig2Path, 'utf-8'));

    // 3. Seed plan definitions (Free=3, Premium=20)
    await db.exec(`
      INSERT INTO public.plan_definitions (plan, ai_monthly_sessions_limit, ai_monthly_enforcement_enabled, capabilities)
      VALUES 
        ('free', 3, true, '{"ai_creation": true}'::jsonb),
        ('premium', 20, true, '{"ai_creation": true}'::jsonb)
      ON CONFLICT (plan) DO UPDATE SET
        ai_monthly_sessions_limit = EXCLUDED.ai_monthly_sessions_limit,
        ai_monthly_enforcement_enabled = EXCLUDED.ai_monthly_enforcement_enabled,
        capabilities = EXCLUDED.capabilities;
    `);
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

  test('1. anonymous → permanent_account_required en check_and_reserve_ai_session', async () => {
    await setAuthContext(userAnon, true);
    const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const leaseId = '11111111-2222-3333-4444-555555555555';

    const res = await db.query(
      `SELECT public.check_and_reserve_ai_session('${sessionId}'::uuid, '${leaseId}'::uuid) as result;`
    );
    await resetAuthContext();
    const out = (res.rows[0] as any).result;
    assert.equal(out.allowed, false);
    assert.equal(out.error, 'permanent_account_required');
  });

  test('2. sessionId ajeno → rechazo (unauthorized_session_access)', async () => {
    // Sesión creada por User A
    await setAuthContext(userPermA, false);
    const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const leaseIdA = '22222222-2222-2222-2222-222222222222';
    const resA = await db.query(
      `SELECT public.check_and_reserve_ai_session('${sessionId}'::uuid, '${leaseIdA}'::uuid) as result;`
    );
    assert.equal((resA.rows[0] as any).result.allowed, true);

    // User B intenta acceder con el mismo sessionId
    await setAuthContext(userPermB, false);
    const leaseIdB = '33333333-3333-3333-3333-333333333333';
    const resB = await db.query(
      `SELECT public.check_and_reserve_ai_session('${sessionId}'::uuid, '${leaseIdB}'::uuid) as result;`
    );
    await resetAuthContext();
    const outB = (resB.rows[0] as any).result;
    assert.equal(outB.allowed, false);
    assert.equal(outB.error, 'unauthorized_session_access');
  });

  test('3. provider failure → released + NO turn', async () => {
    await setAuthContext(userPermA, false);
    const sessionId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const leaseId = '44444444-4444-4444-4444-444444444444';

    await db.query(`SELECT public.check_and_reserve_ai_session('${sessionId}'::uuid, '${leaseId}'::uuid);`);

    // Invocado por internalAdminClient (service_role)
    await db.query(`SET ROLE service_role;`);
    await db.query(
      `SELECT public.internal_release_ai_session_reservation('${userPermA}'::uuid, '${sessionId}'::uuid, '${leaseId}'::uuid, 'provider_failure');`
    );

    await resetAuthContext();

    // Verificar en DB: ai_monthly_usage en state = 'released' y turns = 0 en ai_creation_sessions
    const usageRes = await db.query(`SELECT state, release_reason FROM public.ai_monthly_usage WHERE session_id = '${sessionId}';`);
    assert.equal((usageRes.rows[0] as any).state, 'released');
    assert.equal((usageRes.rows[0] as any).release_reason, 'provider_failure');

    const sessionRes = await db.query(`SELECT turns, processing_lease_id FROM public.ai_creation_sessions WHERE id = '${sessionId}';`);
    assert.equal((sessionRes.rows[0] as any).turns, 0);
    assert.equal((sessionRes.rows[0] as any).processing_lease_id, null);
  });

  test('4. off_topic → turn incrementado + NO consumo mensual (released)', async () => {
    await setAuthContext(userPermA, false);
    const sessionId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const leaseId = '55555555-5555-5555-5555-555555555555';

    await db.query(`SELECT public.check_and_reserve_ai_session('${sessionId}'::uuid, '${leaseId}'::uuid);`);

    // Simulando ai-interpret para off_topic: libera reserva y graba turn
    await db.query(`SET ROLE service_role;`);
    await db.query(
      `SELECT public.internal_release_ai_session_reservation('${userPermA}'::uuid, '${sessionId}'::uuid, '${leaseId}'::uuid, 'off_topic');`
    );
    await db.query(
      `SELECT public.internal_record_ai_session_turn('${userPermA}'::uuid, '${sessionId}'::uuid, '${leaseId}'::uuid);`
    );

    await resetAuthContext();

    const usageRes = await db.query(`SELECT state, release_reason FROM public.ai_monthly_usage WHERE session_id = '${sessionId}';`);
    assert.equal((usageRes.rows[0] as any).state, 'released');
    assert.equal((usageRes.rows[0] as any).release_reason, 'off_topic');

    const sessionRes = await db.query(`SELECT turns, processing_lease_id FROM public.ai_creation_sessions WHERE id = '${sessionId}';`);
    assert.equal((sessionRes.rows[0] as any).turns, 1);
    assert.equal((sessionRes.rows[0] as any).processing_lease_id, null);
  });

  test('5. dos requests misma session → un solo provider call (ai_session_busy)', async () => {
    await setAuthContext(userPermA, false);
    const sessionId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const lease1 = '66666666-6666-6666-6666-666666666666';
    const lease2 = '77777777-7777-7777-7777-777777777777';

    // Request 1 adquiere lease
    const res1 = await db.query(`SELECT public.check_and_reserve_ai_session('${sessionId}'::uuid, '${lease1}'::uuid) as result;`);
    assert.equal((res1.rows[0] as any).result.allowed, true);

    // Request 2 concurrente con distinta lease antes de los 60s
    const res2 = await db.query(`SELECT public.check_and_reserve_ai_session('${sessionId}'::uuid, '${lease2}'::uuid) as result;`);
    await resetAuthContext();
    const out2 = (res2.rows[0] as any).result;
    assert.equal(out2.allowed, false);
    assert.equal(out2.error, 'ai_session_busy');
  });

  test('6. dos sesiones con último cupo → sólo una reserva (ai_monthly_limit_reached)', async () => {
    // User B tiene límite 3 en Free. Consumimos 2 previamente.
    await setAuthContext(userPermB, false);
    const s1 = '10000000-0000-0000-0000-000000000001';
    const s2 = '10000000-0000-0000-0000-000000000002';
    const l1 = '20000000-0000-0000-0000-000000000001';
    const l2 = '20000000-0000-0000-0000-000000000002';

    await db.query(`SELECT public.check_and_reserve_ai_session('${s1}'::uuid, '${l1}'::uuid);`);
    await db.query(`SET ROLE service_role;`);
    await db.query(`SELECT public.internal_finalize_ai_session_consumption('${userPermB}'::uuid, '${s1}'::uuid, '${l1}'::uuid);`);

    await setAuthContext(userPermB, false);
    await db.query(`SELECT public.check_and_reserve_ai_session('${s2}'::uuid, '${l2}'::uuid);`);
    await db.query(`SET ROLE service_role;`);
    await db.query(`SELECT public.internal_finalize_ai_session_consumption('${userPermB}'::uuid, '${s2}'::uuid, '${l2}'::uuid);`);

    // Ahora le queda exactamente 1 cupo restante (usó 2 de 3).
    // Sesión 3 y Sesión 4 compiten por el último cupo.
    await setAuthContext(userPermB, false);
    const s3 = '10000000-0000-0000-0000-000000000003';
    const s4 = '10000000-0000-0000-0000-000000000004';
    const l3 = '20000000-0000-0000-0000-000000000003';
    const l4 = '20000000-0000-0000-0000-000000000004';

    const r3 = await db.query(`SELECT public.check_and_reserve_ai_session('${s3}'::uuid, '${l3}'::uuid) as result;`);
    assert.equal((r3.rows[0] as any).result.allowed, true); // Ocupa el cupo restante

    const r4 = await db.query(`SELECT public.check_and_reserve_ai_session('${s4}'::uuid, '${l4}'::uuid) as result;`);
    await resetAuthContext();
    const out4 = (r4.rows[0] as any).result;
    assert.equal(out4.allowed, false);
    assert.equal(out4.error, 'ai_monthly_limit_reached');
    assert.equal(out4.limit, 3);
    assert.equal(out4.used, 3);
  });

  test('7. consumed en mes anterior → refinement nuevo mes sin nuevo consumo', async () => {
    await resetAuthContext();
    const sOld = '88888888-8888-8888-8888-888888888888';
    const lOld = '99999999-9999-9999-9999-999999999999';

    // Insertar como ya consumida en el mes anterior
    await db.exec(`
      INSERT INTO public.ai_creation_sessions (id, user_id, status, turns)
      VALUES ('${sOld}', '${userPermA}', 'started', 1);

      INSERT INTO public.ai_monthly_usage (session_id, user_id, period_start, state, reserved_at, reservation_expires_at, consumed_at)
      VALUES ('${sOld}', '${userPermA}', '2026-08-01', 'consumed', now() - interval '30 days', now() - interval '30 days', now() - interval '30 days');
    `);

    // Refinement en el mes actual
    await setAuthContext(userPermA, false);
    const resRefine = await db.query(
      `SELECT public.check_and_reserve_ai_session('${sOld}'::uuid, '${lOld}'::uuid) as result;`
    );
    const outRefine = (resRefine.rows[0] as any).result;
    assert.equal(outRefine.allowed, true);
    assert.equal(outRefine.already_consumed, true);

    // Simular resolución de refinement (in-domain)
    await db.query(`SET ROLE service_role;`);
    await db.query(
      `SELECT public.internal_finalize_ai_session_consumption('${userPermA}'::uuid, '${sOld}'::uuid, '${lOld}'::uuid);`
    );

    await resetAuthContext();

    // Verificar que period_start sigue siendo el mes anterior y que turns subió a 2
    const usageRes = await db.query(`SELECT period_start, state FROM public.ai_monthly_usage WHERE session_id = '${sOld}';`);
    assert.equal((usageRes.rows[0] as any).state, 'consumed');
    const d = new Date((usageRes.rows[0] as any).period_start);
    assert.equal(d.toISOString().startsWith('2026-08-01'), true);

    const sessionRes = await db.query(`SELECT turns FROM public.ai_creation_sessions WHERE id = '${sOld}';`);
    assert.equal((sessionRes.rows[0] as any).turns, 2);
  });

  test('8. internal finalize/release inaccesibles desde browser authenticated', async () => {
    await setAuthContext(userPermA, false);
    const sessionId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const leaseId = '44444444-4444-4444-4444-444444444444';

    await assert.rejects(async () => {
      await db.query(
        `SELECT public.internal_finalize_ai_session_consumption('${userPermA}'::uuid, '${sessionId}'::uuid, '${leaseId}'::uuid);`
      );
    }, /permission denied/i);

    await assert.rejects(async () => {
      await db.query(
        `SELECT public.internal_release_ai_session_reservation('${userPermA}'::uuid, '${sessionId}'::uuid, '${leaseId}'::uuid);`
      );
    }, /permission denied/i);

    await resetAuthContext();
  });

  test('9. completed sólo para sesión/encounter válidos y rechazo ante encounter_id nulo/ajeno/terminal', async () => {
    await resetAuthContext();
    const sComp = 'faaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const lComp = 'f1111111-1111-1111-1111-111111111111';

    // Iniciar sesión
    await setAuthContext(userPermA, false);
    await db.query(`SELECT public.check_and_reserve_ai_session('${sComp}'::uuid, '${lComp}'::uuid);`);

    // Caso 9a: Encounter id NULL es rechazado
    const rNull = await db.query(
      `SELECT public.complete_ai_creation_session('${sComp}'::uuid, NULL) as result;`
    );
    assert.equal((rNull.rows[0] as any).result.ok, false);
    assert.equal((rNull.rows[0] as any).result.error, 'invalid_encounter_id');

    // Caso 9b: Encounter id ajeno (creado por User B) es rechazado
    await resetAuthContext();
    const encB = 'ebb22222-2222-2222-2222-222222222222';
    await db.exec(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES ('${encB}', '${userPermB}', 'Encuentro de B');`);

    await setAuthContext(userPermA, false);
    const rMismatch = await db.query(
      `SELECT public.complete_ai_creation_session('${sComp}'::uuid, '${encB}'::uuid) as result;`
    );
    assert.equal((rMismatch.rows[0] as any).result.ok, false);
    assert.equal((rMismatch.rows[0] as any).result.error, 'encounter_ownership_mismatch');

    // Caso 9c: Encounter válido perteneciente al usuario completa la sesión exitosamente
    await resetAuthContext();
    const encA = 'eaa11111-1111-1111-1111-111111111111';
    await db.exec(`INSERT INTO public.encuentros (id, host_id, titulo) VALUES ('${encA}', '${userPermA}', 'Encuentro de A');`);

    await setAuthContext(userPermA, false);
    const rOk = await db.query(
      `SELECT public.complete_ai_creation_session('${sComp}'::uuid, '${encA}'::uuid) as result;`
    );
    assert.equal((rOk.rows[0] as any).result.ok, true);

    await resetAuthContext();
    const sCheck = await db.query(`SELECT status, encounter_id FROM public.ai_creation_sessions WHERE id = '${sComp}';`);
    assert.equal((sCheck.rows[0] as any).status, 'completed');
    assert.equal((sCheck.rows[0] as any).encounter_id, encA);

    // Caso 9d: Una sesión ya en estado terminal no puede volver a completarse
    await setAuthContext(userPermA, false);
    const rTerminal = await db.query(
      `SELECT public.complete_ai_creation_session('${sComp}'::uuid, '${encA}'::uuid) as result;`
    );
    await resetAuthContext();
    assert.equal((rTerminal.rows[0] as any).result.ok, false);
    assert.equal((rTerminal.rows[0] as any).result.error, 'session_already_terminal');
  });
});
