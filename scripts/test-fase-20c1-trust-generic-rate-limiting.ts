import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('T5-B1 — Generic Server-Side Rate Limiter Core Tests', () => {
  let db: PGlite;
  const userA = '11111111-1111-1111-1111-111111111111';
  const userB = '22222222-2222-2222-2222-222222222222';

  before(async () => {
    db = new PGlite();

    // 1. Setup mock Supabase roles & auth environment
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role;
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

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
      $$ LANGUAGE SQL STABLE;

      INSERT INTO auth.users (id, email) VALUES
        ('${userA}', 'userA@test.com'),
        ('${userB}', 'userB@test.com')
      ON CONFLICT DO NOTHING;
    `);

    // 2. Execute T5-B1 migration
    const migrationPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20260930200000_fase_20c1_trust_generic_rate_limiting.sql'
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
    await db.exec(migrationSql);
  });

  test('1. Schema & Initial Seed Policies: rate_limit_policies contains P0 seeds', async () => {
    const res = await db.query(`
      SELECT action, max_requests, window_seconds, enabled
      FROM public.rate_limit_policies
      ORDER BY action ASC;
    `);

    assert.equal(res.rows.length, 4);
    const policies = res.rows as any[];

    const enc = policies.find((p) => p.action === 'create_encounter');
    assert.deepEqual(enc, {
      action: 'create_encounter',
      max_requests: 20,
      window_seconds: 3600,
      enabled: true,
    });

    const int = policies.find((p) => p.action === 'create_intention');
    assert.deepEqual(int, {
      action: 'create_intention',
      max_requests: 6,
      window_seconds: 3600,
      enabled: true,
    });

    const join = policies.find((p) => p.action === 'join_open_encounter');
    assert.deepEqual(join, {
      action: 'join_open_encounter',
      max_requests: 12,
      window_seconds: 3600,
      enabled: true,
    });

    const joinSame = policies.find((p) => p.action === 'join_open_encounter_same_target');
    assert.deepEqual(joinSame, {
      action: 'join_open_encounter_same_target',
      max_requests: 1,
      window_seconds: 21600,
      enabled: true,
    });
  });

  test('2. Authentication Guard: rejects unauthenticated call fail-closed', async () => {
    // Clear user session
    await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);

    const res = await db.query(`SELECT public.check_rate_limit_internal('create_encounter') AS result;`);
    const result = (res.rows[0] as any).result;

    assert.equal(result.allowed, false);
    assert.equal(result.error, 'authentication_required');
  });

  test('3. Parameter Validation: rejects empty/null action or oversized scope_key', async () => {
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userA}', false);`);

    const res1 = await db.query(`SELECT public.check_rate_limit_internal('') AS result;`);
    assert.equal((res1.rows[0] as any).result.allowed, false);
    assert.equal((res1.rows[0] as any).result.error, 'invalid_parameters');

    const res2 = await db.query(`SELECT public.check_rate_limit_internal('create_encounter', '${'x'.repeat(129)}') AS result;`);
    assert.equal((res2.rows[0] as any).result.allowed, false);
    assert.equal((res2.rows[0] as any).result.error, 'invalid_parameters');
  });

  test('4. Fail-Closed on Non-Existent Policy', async () => {
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userA}', false);`);

    const res = await db.query(`SELECT public.check_rate_limit_internal('non_existent_action') AS result;`);
    const result = (res.rows[0] as any).result;

    assert.equal(result.allowed, false);
    assert.equal(result.error, 'rate_limit_policy_not_found');
  });

  test('5. Disabled Policy: enabled=false allows operation with disabled flag', async () => {
    // Insert a disabled policy
    await db.query(`
      INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
      VALUES ('disabled_action', 10, 3600, false)
      ON CONFLICT (action) DO UPDATE SET enabled = false;
    `);

    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userA}', false);`);
    const res = await db.query(`SELECT public.check_rate_limit_internal('disabled_action') AS result;`);
    const result = (res.rows[0] as any).result;

    assert.equal(result.allowed, true);
    assert.equal(result.disabled, true);

    // Verify NO bucket was created for disabled policy
    const bucketRes = await db.query(`
      SELECT COUNT(*)::int AS count FROM public.rate_limit_buckets WHERE action = 'disabled_action';
    `);
    assert.equal((bucketRes.rows[0] as any).count, 0);
  });

  test('6. Basic Bucket Counting & Atomic Limit: request 1 has count=1, strictly rejected at max+1', async () => {
    // Setup test policy with max_requests = 3
    await db.query(`
      INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
      VALUES ('test_limit_3', 3, 3600, true)
      ON CONFLICT (action) DO UPDATE SET max_requests = 3, window_seconds = 3600, enabled = true;
    `);

    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userA}', false);`);

    // Request 1
    const r1 = await db.query(`SELECT public.check_rate_limit_internal('test_limit_3') AS result;`);
    assert.equal((r1.rows[0] as any).result.allowed, true);

    const b1 = await db.query(`
      SELECT request_count FROM public.rate_limit_buckets
      WHERE action = 'test_limit_3' AND user_id = '${userA}';
    `);
    assert.equal((b1.rows[0] as any).request_count, 1, 'Request 1 MUST have request_count = 1 (NOT 2)');

    // Request 2
    const r2 = await db.query(`SELECT public.check_rate_limit_internal('test_limit_3') AS result;`);
    assert.equal((r2.rows[0] as any).result.allowed, true);

    const b2 = await db.query(`
      SELECT request_count FROM public.rate_limit_buckets
      WHERE action = 'test_limit_3' AND user_id = '${userA}';
    `);
    assert.equal((b2.rows[0] as any).request_count, 2);

    // Request 3 (limit reached)
    const r3 = await db.query(`SELECT public.check_rate_limit_internal('test_limit_3') AS result;`);
    assert.equal((r3.rows[0] as any).result.allowed, true);

    const b3 = await db.query(`
      SELECT request_count FROM public.rate_limit_buckets
      WHERE action = 'test_limit_3' AND user_id = '${userA}';
    `);
    assert.equal((b3.rows[0] as any).request_count, 3);

    // Request 4 (exceeded)
    const r4 = await db.query(`SELECT public.check_rate_limit_internal('test_limit_3') AS result;`);
    assert.equal((r4.rows[0] as any).result.allowed, false);
    assert.equal((r4.rows[0] as any).result.error, 'rate_limit_exceeded');

    const b4 = await db.query(`
      SELECT request_count FROM public.rate_limit_buckets
      WHERE action = 'test_limit_3' AND user_id = '${userA}';
    `);
    assert.equal((b4.rows[0] as any).request_count, 3, 'Request count remains 3 after rejection');
  });

  test('7. Separation & Orthogonality: by action, user, scope_key and window', async () => {
    // Setup two policies with limit 1
    await db.query(`
      INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
      VALUES
        ('action_alpha', 1, 3600, true),
        ('action_beta', 1, 3600, true)
      ON CONFLICT (action) DO UPDATE SET max_requests = 1, enabled = true;
    `);

    // A. Separation by action: User A exhausts alpha, but beta is still allowed
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userA}', false);`);
    const a1 = await db.query(`SELECT public.check_rate_limit_internal('action_alpha') AS result;`);
    assert.equal((a1.rows[0] as any).result.allowed, true);
    const a2 = await db.query(`SELECT public.check_rate_limit_internal('action_alpha') AS result;`);
    assert.equal((a2.rows[0] as any).result.allowed, false);

    const b1 = await db.query(`SELECT public.check_rate_limit_internal('action_beta') AS result;`);
    assert.equal((b1.rows[0] as any).result.allowed, true);

    // B. Separation by user: User B is NOT affected by User A exhausting alpha
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userB}', false);`);
    const ub1 = await db.query(`SELECT public.check_rate_limit_internal('action_alpha') AS result;`);
    assert.equal((ub1.rows[0] as any).result.allowed, true, 'User B must not be limited by User A');

    // C. Separation by scope_key: User A on target-1 vs target-2
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userA}', false);`);
    const s1 = await db.query(`SELECT public.check_rate_limit_internal('join_open_encounter_same_target', 'encounter-1') AS result;`);
    assert.equal((s1.rows[0] as any).result.allowed, true);
    const s1_repeat = await db.query(`SELECT public.check_rate_limit_internal('join_open_encounter_same_target', 'encounter-1') AS result;`);
    assert.equal((s1_repeat.rows[0] as any).result.allowed, false);

    const s2 = await db.query(`SELECT public.check_rate_limit_internal('join_open_encounter_same_target', 'encounter-2') AS result;`);
    assert.equal((s2.rows[0] as any).result.allowed, true, 'Different scope_key must have independent bucket');
  });

  test('8. Generic Window Calculation: 3600s and 21600s discrete epoch math', async () => {
    // Verify PostgreSQL epoch discrete window calculation across different window sizes
    const res = await db.query(`
      SELECT
        to_timestamp(floor(extract(epoch from '2026-09-30 15:42:15+00'::timestamptz) / 3600) * 3600) AS w_1h,
        to_timestamp(floor(extract(epoch from '2026-09-30 15:42:15+00'::timestamptz) / 21600) * 21600) AS w_6h,
        to_timestamp(floor(extract(epoch from '2026-09-30 18:00:00+00'::timestamptz) / 21600) * 21600) AS w_6h_next;
    `);

    const row = res.rows[0] as any;
    assert.equal(new Date(row.w_1h).toISOString(), '2026-09-30T15:00:00.000Z');
    assert.equal(new Date(row.w_6h).toISOString(), '2026-09-30T12:00:00.000Z');
    assert.equal(new Date(row.w_6h_next).toISOString(), '2026-09-30T18:00:00.000Z');
  });

  test('9. Concurrency: 15 simultaneous requests at limit 5 result in exactly 5 allowed and 10 rejected', async () => {
    await db.query(`
      INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
      VALUES ('test_concurrency_5', 5, 3600, true)
      ON CONFLICT (action) DO UPDATE SET max_requests = 5, enabled = true;
    `);

    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userB}', false);`);

    const promises = Array.from({ length: 15 }, async () => {
      const res = await db.query(`SELECT public.check_rate_limit_internal('test_concurrency_5') AS result;`);
      return (res.rows[0] as any).result;
    });

    const results = await Promise.all(promises);

    const allowedCount = results.filter((r) => r.allowed === true).length;
    const rejectedCount = results.filter((r) => r.allowed === false && r.error === 'rate_limit_exceeded').length;

    assert.equal(allowedCount, 5, 'Exactly 5 requests must be allowed');
    assert.equal(rejectedCount, 10, 'Exactly 10 requests must be rejected');

    const bucketRes = await db.query(`
      SELECT request_count FROM public.rate_limit_buckets
      WHERE action = 'test_concurrency_5' AND user_id = '${userB}';
    `);
    assert.equal((bucketRes.rows[0] as any).request_count, 5, 'Final request_count must be exactly 5, NEVER 6');
  });

  test('10. Opportunistic Cleanup: deletes buckets older than 48 hours for calling user', async () => {
    await db.query(`
      INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
      VALUES ('test_cleanup', 10, 3600, true)
      ON CONFLICT (action) DO UPDATE SET max_requests = 10, enabled = true;
    `);

    // Manually insert an old bucket (60 hours old) for User A, and an old bucket for User B
    const oldWindow = new Date(Date.now() - 60 * 3600 * 1000).toISOString();
    await db.query(`
      INSERT INTO public.rate_limit_buckets (action, user_id, scope_key, window_start, request_count)
      VALUES
        ('test_cleanup', '${userA}', '', '${oldWindow}'::timestamptz, 2),
        ('test_cleanup', '${userB}', '', '${oldWindow}'::timestamptz, 2)
      ON CONFLICT DO NOTHING;
    `);

    // Verify both exist before call
    const beforeA = await db.query(`
      SELECT COUNT(*)::int AS count FROM public.rate_limit_buckets
      WHERE action = 'test_cleanup' AND user_id = '${userA}' AND window_start = '${oldWindow}'::timestamptz;
    `);
    assert.equal((beforeA.rows[0] as any).count, 1);

    // Call as User A
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userA}', false);`);
    await db.query(`SELECT public.check_rate_limit_internal('test_cleanup') AS result;`);

    // Verify User A old bucket is purged
    const afterA = await db.query(`
      SELECT COUNT(*)::int AS count FROM public.rate_limit_buckets
      WHERE action = 'test_cleanup' AND user_id = '${userA}' AND window_start = '${oldWindow}'::timestamptz;
    `);
    assert.equal((afterA.rows[0] as any).count, 0, 'User A old bucket must be cleaned up');

    // Verify User B old bucket is untouched (cleanup is user-scoped)
    const afterB = await db.query(`
      SELECT COUNT(*)::int AS count FROM public.rate_limit_buckets
      WHERE action = 'test_cleanup' AND user_id = '${userB}' AND window_start = '${oldWindow}'::timestamptz;
    `);
    assert.equal((afterB.rows[0] as any).count, 1, 'User B old bucket must not be deleted by User A operation');
  });

  test('11. Security & Privacy: anon and authenticated cannot access tables or internal helper directly', async () => {
    // Test as authenticated role
    await db.query(`SET ROLE authenticated;`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userA}', false);`);

    // Table rate_limit_policies
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.rate_limit_policies;`);
      },
      /permission denied/i,
      'authenticated role MUST NOT SELECT rate_limit_policies'
    );

    // Table rate_limit_buckets
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.rate_limit_buckets;`);
      },
      /permission denied/i,
      'authenticated role MUST NOT SELECT rate_limit_buckets'
    );

    // Direct execute check_rate_limit_internal
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.check_rate_limit_internal('create_encounter');`);
      },
      /permission denied/i,
      'authenticated role MUST NOT EXECUTE check_rate_limit_internal directly'
    );

    // Direct execute check_rate_limit_admin_inspect
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.check_rate_limit_admin_inspect('${userA}', 'create_encounter');`);
      },
      /permission denied/i,
      'authenticated role MUST NOT EXECUTE check_rate_limit_admin_inspect directly'
    );

    // Reset role to postgres
    await db.query(`RESET ROLE;`);
  });

  test('12. Admin Helper: check_rate_limit_admin_inspect works for service_role/postgres', async () => {
    // Reset to postgres
    await db.query(`RESET ROLE;`);

    const res = await db.query(`
      SELECT public.check_rate_limit_admin_inspect('${userA}', 'create_encounter') AS result;
    `);
    const result = (res.rows[0] as any).result;

    assert.equal(result.allowed, true);
  });
});
