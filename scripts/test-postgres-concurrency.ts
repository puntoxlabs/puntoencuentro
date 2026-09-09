import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { checkAbuseLimits, resetLimiterStateForTesting } from '../supabase/functions/ai-interpret/limiter.ts';

describe('Real PostgreSQL Concurrency & Security Tests (RPC: check_and_increment_ai_rate_limit)', () => {
  let db: PGlite;
  const userA = '11111111-1111-1111-1111-111111111111';
  const userB = '22222222-2222-2222-2222-222222222222';

  before(async () => {
    db = new PGlite();

    // 1. Setup Supabase auth mock environment in real PostgreSQL
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT
      );
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      INSERT INTO auth.users (id, email) VALUES
        ('${userA}', 'userA@test.com'),
        ('${userB}', 'userB@test.com')
      ON CONFLICT DO NOTHING;
    `);

    // 2. Execute the actual migration SQL file in PostgreSQL
    const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20260909140000_ai_rate_limit_buckets.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
    await db.exec(migrationSql);
  });

  test('1. Real PostgreSQL Concurrency: 10 concurrent requests at limit 5 result in exactly 5 allowed and 5 rejected', async () => {
    // Authenticate session as userA
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userA}', false);`);

    // Dispatch 10 concurrent calls to the real PL/pgSQL function
    const promises = Array.from({ length: 10 }, async () => {
      const res = await db.query(`SELECT check_and_increment_ai_rate_limit(5) AS result;`);
      return (res.rows[0] as any).result;
    });

    const results = await Promise.all(promises);

    const allowed = results.filter((r) => r.allowed === true);
    const rejected = results.filter((r) => r.allowed === false);

    assert.equal(allowed.length, 5, 'Exactly 5 requests must be allowed by Postgres atomic UPDATE');
    assert.equal(rejected.length, 5, 'Exactly 5 requests must be rejected');

    for (const rej of rejected) {
      assert.equal(rej.error, 'rate_limit_exceeded');
      assert.equal(rej.current_count, 5);
      assert.equal(rej.max_requests, 5);
    }

    // Verify row in database is exactly 5
    const rowRes = await db.query(
      `SELECT request_count FROM public.ai_rate_limit_buckets WHERE user_id = '${userA}';`
    );
    assert.equal(rowRes.rows.length, 1);
    assert.equal((rowRes.rows[0] as any).request_count, 5, 'Postgres row request_count must be exactly 5');
  });

  test('2. Cross-User Security: User A cannot tamper with User B bucket and contract exposes NO user parameter', async () => {
    // Authenticate as User A
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userA}', false);`);

    // A: Attempting to call RPC with 2 arguments (trying to pass userB's id) must fail at SQL level
    let sqlError: any = null;
    try {
      await db.query(`SELECT check_and_increment_ai_rate_limit(5, '${userB}'::uuid);`);
    } catch (err) {
      sqlError = err;
    }
    assert.ok(sqlError, 'Calling RPC with a user_id parameter must fail because the parameter does not exist');

    // B: Authenticate as User B and verify independent bucket
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userB}', false);`);
    const resB = await db.query(`SELECT check_and_increment_ai_rate_limit(5) AS result;`);
    const resultB = (resB.rows[0] as any).result;

    assert.equal(resultB.allowed, true);
    assert.equal(resultB.current_count, 1, 'User B must start at count 1 independently of User A');

    // C: Verify User A bucket count is unchanged (still 5)
    const rowA = await db.query(
      `SELECT request_count FROM public.ai_rate_limit_buckets WHERE user_id = '${userA}';`
    );
    assert.equal((rowA.rows[0] as any).request_count, 5);
  });

  test('3. Unauthenticated Execution: RPC rejects if auth.uid() is null', async () => {
    // Clear session auth
    await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);

    const res = await db.query(`SELECT check_and_increment_ai_rate_limit(5) AS result;`);
    const result = (res.rows[0] as any).result;

    assert.equal(result.allowed, false);
    assert.equal(result.error, 'not_authenticated');
  });

  test('4. FAIL-CLOSED: checkAbuseLimits denies access if Postgres/RPC is unavailable or fails', async () => {
    resetLimiterStateForTesting();
    const config = {
      maxTurnsPerSession: 20,
      maxRequestsPerHour: 40,
      maxConsecutiveOffTopic: 3,
    };

    // A: Missing supabaseClient -> FAIL-CLOSED (rate_limit_unavailable)
    const resMissing = await checkAbuseLimits(userA, 'session-test-1', config, undefined);
    assert.equal(resMissing.allowed, false);
    assert.equal(resMissing.error, 'rate_limit_unavailable');
    assert.match(resMissing.message!, /No pudimos validar temporalmente/);

    // B: Database error in RPC -> FAIL-CLOSED (rate_limit_unavailable)
    const brokenClient = {
      rpc: async () => {
        return { data: null, error: { message: 'connection timeout' } };
      },
    };
    const resError = await checkAbuseLimits(userA, 'session-test-2', config, brokenClient);
    assert.equal(resError.allowed, false);
    assert.equal(resError.error, 'rate_limit_unavailable');

    // C: RPC throws unexpected exception -> FAIL-CLOSED (rate_limit_unavailable)
    const throwingClient = {
      rpc: async () => {
        throw new Error('Postgres connection severed');
      },
    };
    const resThrow = await checkAbuseLimits(userA, 'session-test-3', config, throwingClient);
    assert.equal(resThrow.allowed, false);
    assert.equal(resThrow.error, 'rate_limit_unavailable');
  });

  test('5. Real Supabase Client Adapter bridge: checkAbuseLimits calls real Postgres RPC via client adapter', async () => {
    resetLimiterStateForTesting();
    const config = {
      maxTurnsPerSession: 20,
      maxRequestsPerHour: 2,
      maxConsecutiveOffTopic: 3,
    };

    const userBridge = '33333333-3333-3333-3333-333333333333';
    await db.query(`INSERT INTO auth.users (id, email) VALUES ('${userBridge}', 'bridge@test.com') ON CONFLICT DO NOTHING;`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userBridge}', false);`);

    // Create a real-bridge adapter simulating Supabase client calling the real Postgres DB
    const realPgSupabaseAdapter = {
      rpc: async (fnName: string, args: { p_max_requests: number }) => {
        const queryRes = await db.query(
          `SELECT ${fnName}($1) AS result;`,
          [args.p_max_requests]
        );
        return { data: (queryRes.rows[0] as any).result, error: null };
      },
    };

    // Call 1 -> allowed (count 1)
    const check1 = await checkAbuseLimits(userBridge, 'session-bridge-1', config, realPgSupabaseAdapter);
    assert.equal(check1.allowed, true);

    // Call 2 -> allowed (count 2)
    const check2 = await checkAbuseLimits(userBridge, 'session-bridge-1', config, realPgSupabaseAdapter);
    assert.equal(check2.allowed, true);

    // Call 3 -> rejected by real PostgreSQL RPC (limit 2 reached)
    const check3 = await checkAbuseLimits(userBridge, 'session-bridge-1', config, realPgSupabaseAdapter);
    assert.equal(check3.allowed, false);
    assert.equal(check3.error, 'rate_limit_exceeded');
  });
});
