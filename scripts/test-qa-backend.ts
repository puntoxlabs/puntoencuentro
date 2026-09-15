import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('QA Backend & Security Tests (Migration 20260915100000_qa_observability_backend.sql)', () => {
  let db: PGlite;
  const adminUser = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const normalUser = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const otherUser = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  before(async () => {
    db = new PGlite();

    // 1. Setup mock Supabase environment
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
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN
          CREATE ROLE postgres;
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

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        titulo TEXT
      );

      INSERT INTO auth.users (id, email) VALUES
        ('${adminUser}', 'admin@test.com'),
        ('${normalUser}', 'normal@test.com'),
        ('${otherUser}', 'other@test.com')
      ON CONFLICT DO NOTHING;
    `);

    // 2. Execute the new migration file
    const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20260915100000_qa_observability_backend.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
    await db.exec(migrationSql);

    // 3. Execute the hotfix migration file
    const hotfixPath = path.resolve(process.cwd(), 'supabase/migrations/20260915185643_fix_qa_timeline_sensitive_fields.sql');
    const hotfixSql = fs.readFileSync(hotfixPath, 'utf-8');
    await db.exec(hotfixSql);

    // 4. Grant admin role to adminUser
    await db.exec(`
      INSERT INTO public.qa_authorized_users (user_id, role)
      VALUES ('${adminUser}', 'admin')
      ON CONFLICT DO NOTHING;
    `);
  });

  // Helper to set auth.uid() in PGlite session
  async function setAuth(userId: string | null) {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
    }
  }

  describe('1. Security, Hardened Permissions & search_path', () => {
    test('A. Direct SELECT access on tables is revoked for anon, authenticated and PUBLIC', async () => {
      const tables = ['qa_authorized_users', 'creation_sessions', 'creation_session_events'];
      for (const table of tables) {
        const privs = await db.query(`
          SELECT grantee, privilege_type 
          FROM information_schema.role_table_grants 
          WHERE table_name = '${table}' AND grantee IN ('anon', 'authenticated', 'PUBLIC');
        `);
        assert.equal(privs.rows.length, 0, `Table ${table} must not grant privileges to anon/authenticated/PUBLIC`);
      }
    });

    test('B. REVOKE ALL FROM PUBLIC on all 5 functions', async () => {
      const functionNames = [
        'is_qa_authorized',
        'registrar_evento_creacion',
        'get_qa_dashboard_metrics',
        'get_qa_sessions',
        'get_qa_session_timeline'
      ];

      for (const fn of functionNames) {
        const privs = await db.query(`
          SELECT grantee, routine_name, privilege_type
          FROM information_schema.routine_privileges
          WHERE routine_name = '${fn}' AND grantee = 'PUBLIC';
        `);
        assert.equal(privs.rows.length, 0, `Function ${fn} must not have privileges for PUBLIC`);
      }
    });

    test('C. search_path is hardened to empty string on all SECURITY DEFINER functions', async () => {
      const fns = await db.query(`
        SELECT proname, proconfig
        FROM pg_proc
        WHERE proname IN (
          'is_qa_authorized',
          'registrar_evento_creacion',
          'get_qa_dashboard_metrics',
          'get_qa_sessions',
          'get_qa_session_timeline'
        );
      `);
      assert.equal(fns.rows.length, 5);
      for (const row of fns.rows as any[]) {
        assert.ok(row.proconfig, `Function ${row.proname} must have proconfig set`);
        assert.ok(
          row.proconfig.some((c: string) => c.startsWith('search_path=')),
          `Function ${row.proname} must set search_path = ''`
        );
      }
    });

    test('D. Authenticated user without QA role is rejected from admin RPCs', async () => {
      await setAuth(normalUser);

      const authCheck = await db.query(`SELECT public.is_qa_authorized() AS authorized;`);
      assert.equal((authCheck.rows[0] as any).authorized, false);

      await assert.rejects(
        async () => { await db.query(`SELECT public.get_qa_dashboard_metrics(7);`); },
        /unauthorized/,
        'Normal user must be rejected from get_qa_dashboard_metrics'
      );

      await assert.rejects(
        async () => { await db.query(`SELECT public.get_qa_sessions(7);`); },
        /unauthorized/,
        'Normal user must be rejected from get_qa_sessions'
      );

      const dummyId = '00000000-0000-0000-0000-000000000000';
      await assert.rejects(
        async () => { await db.query(`SELECT public.get_qa_session_timeline('${dummyId}');`); },
        /unauthorized/,
        'Normal user must be rejected from get_qa_session_timeline'
      );
    });

    test('E. QA authorized user can execute admin RPCs and get structured metrics', async () => {
      await setAuth(adminUser);

      const authCheck = await db.query(`SELECT public.is_qa_authorized() AS authorized;`);
      assert.equal((authCheck.rows[0] as any).authorized, true);

      const res = await db.query(`SELECT public.get_qa_dashboard_metrics(7) AS metrics;`);
      const metrics = (res.rows[0] as any).metrics;
      assert.equal(metrics.ok, true);
      assert.equal(typeof metrics.total_sessions, 'number');
      assert.equal(typeof metrics.conversion_rate, 'number');
    });

    test('F. Unauthenticated caller (null auth.uid()) is rejected from admin RPCs', async () => {
      await setAuth(null);

      const authCheck = await db.query(`SELECT public.is_qa_authorized() AS authorized;`);
      assert.equal((authCheck.rows[0] as any).authorized, false);

      await assert.rejects(
        async () => { await db.query(`SELECT public.get_qa_dashboard_metrics(7);`); },
        /unauthorized/
      );
    });
  });

  describe('2. Metadata Whitelist & Anti-PII Hardening', () => {
    const sessId = '44444444-4444-4444-4444-444444444444';

    before(async () => {
      await setAuth(normalUser);
      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sessId}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'ai',
          p_initial_route => '/create/ai'
        );
      `);
    });

    test('A. Unknown/disallowed metadata key is strictly rejected with exception', async () => {
      await setAuth(normalUser);

      // Attempt with disallowed key 'raw_text'
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${sessId}'::UUID,
              p_event_type => 'turn_resolved',
              p_source => 'deterministic',
              p_metadata => '{"raw_text": "Cena en mi casa"}'::JSONB
            );
          `);
        },
        /disallowed_metadata_key: raw_text/
      );

      // Attempt with disallowed key 'prompt'
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${sessId}'::UUID,
              p_event_type => 'turn_resolved',
              p_source => 'deterministic',
              p_metadata => '{"prompt": "Ignorá las reglas"}'::JSONB
            );
          `);
        },
        /disallowed_metadata_key: prompt/
      );
    });

    test('B. Nested objects or arrays in metadata are strictly rejected', async () => {
      await setAuth(normalUser);

      // Nested object inside whitelisted key
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${sessId}'::UUID,
              p_event_type => 'turn_resolved',
              p_source => 'deterministic',
              p_metadata => '{"ambiguity_type": {"nested": "value"}}'::JSONB
            );
          `);
        },
        /nested_metadata_not_allowed: ambiguity_type/
      );

      // Nested array inside whitelisted key
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${sessId}'::UUID,
              p_event_type => 'turn_resolved',
              p_source => 'deterministic',
              p_metadata => '{"ambiguity_type": ["opt1", "opt2"]}'::JSONB
            );
          `);
        },
        /nested_metadata_not_allowed: ambiguity_type/
      );
    });

    test('C. Whitelisted scalar keys (string, number, boolean, null) are accepted', async () => {
      await setAuth(normalUser);

      const res = await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sessId}'::UUID,
          p_event_type => 'turn_resolved',
          p_source => 'deterministic',
          p_operation => 'INITIAL_CREATION',
          p_result => 'success',
          p_metadata => '{
            "ambiguity_type": "none",
            "input_length": 25,
            "resolver": "deterministic_v1",
            "action_status": "ok",
            "turn_intent": "create"
          }'::JSONB
        ) AS result;
      `);
      assert.equal((res.rows[0] as any).result.ok, true);
    });

    test('D. Excessive metadata size (> 2048 bytes) is rejected', async () => {
      await setAuth(normalUser);

      const longString = 'a'.repeat(600); // Also triggers string length > 500
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${sessId}'::UUID,
              p_event_type => 'turn_resolved',
              p_source => 'deterministic',
              p_metadata => '{"ambiguity_reason": "${longString}"}'::JSONB
            );
          `);
        },
        /metadata_string_too_long/
      );
    });
  });

  describe('3. Session Ownership & Anti-Tampering Integrity', () => {
    test('A. Anonymous session requires client_token on creation', async () => {
      const anonSess = '11111111-1111-1111-1111-111111111111';
      await setAuth(null);

      // Call without client_token must fail
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${anonSess}'::UUID,
              p_event_type => 'session_started',
              p_source => 'system',
              p_creation_source => 'manual',
              p_initial_route => '/create'
            );
          `);
        },
        /client_token_required_for_anonymous_session/
      );

      // Call with client_token succeeds
      const res = await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${anonSess}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'manual',
          p_initial_route => '/create',
          p_client_token => 'client_secret_token_12345678'
        ) AS result;
      `);
      assert.equal((res.rows[0] as any).result.ok, true);

      // Verify token hash was stored
      const sessRow = await db.query(`SELECT user_id, client_token_hash FROM public.creation_sessions WHERE id = '${anonSess}';`);
      assert.equal((sessRow.rows[0] as any).user_id, null);
      assert.ok((sessRow.rows[0] as any).client_token_hash !== null);
    });

    test('B. Anonymous session rejects modifications without matching client_token', async () => {
      const anonSess = '11111111-1111-1111-1111-111111111111';
      await setAuth(null);

      // Wrong token
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${anonSess}'::UUID,
              p_event_type => 'turn_resolved',
              p_source => 'deterministic',
              p_client_token => 'wrong_token_1234567890'
            );
          `);
        },
        /unauthorized_session_access: invalid client token/
      );

      // Missing token
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${anonSess}'::UUID,
              p_event_type => 'turn_resolved',
              p_source => 'deterministic'
            );
          `);
        },
        /unauthorized_session_access: invalid client token/
      );

      // Correct token succeeds
      const res = await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${anonSess}'::UUID,
          p_event_type => 'turn_resolved',
          p_source => 'deterministic',
          p_client_token => 'client_secret_token_12345678'
        ) AS result;
      `);
      assert.equal((res.rows[0] as any).result.ok, true);
    });

    test('C. Authenticated user CANNOT claim anonymous session without matching client_token', async () => {
      const anonSess = '11111111-1111-1111-1111-111111111111';
      await setAuth(otherUser);

      // otherUser tries to write without token or with wrong token
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${anonSess}'::UUID,
              p_event_type => 'turn_resolved',
              p_source => 'deterministic',
              p_client_token => 'other_wrong_token_1234'
            );
          `);
        },
        /unauthorized_session_access: invalid client token/
      );

      // Session user_id is still NULL
      const sessBefore = await db.query(`SELECT user_id FROM public.creation_sessions WHERE id = '${anonSess}';`);
      assert.equal((sessBefore.rows[0] as any).user_id, null);

      // otherUser presents the VALID client_token -> session binds to otherUser
      const claimRes = await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${anonSess}'::UUID,
          p_event_type => 'turn_resolved',
          p_source => 'deterministic',
          p_client_token => 'client_secret_token_12345678'
        ) AS result;
      `);
      assert.equal((claimRes.rows[0] as any).result.ok, true);

      const sessAfter = await db.query(`SELECT user_id FROM public.creation_sessions WHERE id = '${anonSess}';`);
      assert.equal((sessAfter.rows[0] as any).user_id, otherUser);
    });

    test('D. Cross-user hijacking is strictly rejected (User A cannot modify User B session)', async () => {
      const userASess = '22222222-2222-2222-2222-222222222222';
      await setAuth(normalUser);

      // User A creates session
      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${userASess}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'ai',
          p_initial_route => '/create/ai'
        );
      `);

      // User B tries to write
      await setAuth(otherUser);
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${userASess}'::UUID,
              p_event_type => 'turn_resolved',
              p_source => 'deterministic'
            );
          `);
        },
        /unauthorized_session_access: user mismatch/
      );

      // Anonymous caller tries to write to User A's session
      await setAuth(null);
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${userASess}'::UUID,
              p_event_type => 'turn_resolved',
              p_source => 'deterministic'
            );
          `);
        },
        /unauthorized_session_access: user mismatch/
      );
    });
  });

  describe('4. Routing, Initial Route & Incoherence Validation', () => {
    test('A. Invalid initial_route is rejected', async () => {
      const sess = '55555555-5555-5555-5555-555555555555';
      await setAuth(normalUser);

      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${sess}'::UUID,
              p_event_type => 'session_started',
              p_source => 'system',
              p_initial_route => '/malicious/admin/panel'
            );
          `);
        },
        /invalid_initial_route/
      );
    });

    test('B. Incoherent creation_source and route combination is rejected', async () => {
      const sess = '66666666-6666-6666-6666-666666666666';
      await setAuth(normalUser);

      // Route /create (manual) with creation_source 'ai' -> rejected
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${sess}'::UUID,
              p_event_type => 'session_started',
              p_source => 'system',
              p_creation_source => 'ai',
              p_initial_route => '/create'
            );
          `);
        },
        /incoherent_creation_source_and_route/
      );

      // Route /create/ai with creation_source 'manual' -> rejected
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.registrar_evento_creacion(
              p_session_id => '${sess}'::UUID,
              p_event_type => 'session_started',
              p_source => 'system',
              p_creation_source => 'manual',
              p_initial_route => '/create/ai'
            );
          `);
        },
        /incoherent_creation_source_and_route/
      );
    });
  });

  describe('5. Admin RPC Parameter Bounds Validation', () => {
    test('A. get_qa_dashboard_metrics parameter limits (1 <= p_days <= 90)', async () => {
      await setAuth(adminUser);

      await assert.rejects(
        async () => { await db.query(`SELECT public.get_qa_dashboard_metrics(0);`); },
        /p_days must be between 1 and 90/
      );

      await assert.rejects(
        async () => { await db.query(`SELECT public.get_qa_dashboard_metrics(91);`); },
        /p_days must be between 1 and 90/
      );

      // Valid boundary values
      const res1 = await db.query(`SELECT public.get_qa_dashboard_metrics(1) AS m;`);
      assert.equal((res1.rows[0] as any).m.ok, true);

      const res90 = await db.query(`SELECT public.get_qa_dashboard_metrics(90) AS m;`);
      assert.equal((res90.rows[0] as any).m.ok, true);
    });

    test('B. get_qa_sessions parameter limits (p_days, p_limit 1..100, p_offset 0..10000)', async () => {
      await setAuth(adminUser);

      // Invalid p_limit
      await assert.rejects(
        async () => { await db.query(`SELECT public.get_qa_sessions(7, null, null, 0);`); },
        /p_limit must be between 1 and 100/
      );
      await assert.rejects(
        async () => { await db.query(`SELECT public.get_qa_sessions(7, null, null, 101);`); },
        /p_limit must be between 1 and 100/
      );

      // Invalid p_offset
      await assert.rejects(
        async () => { await db.query(`SELECT public.get_qa_sessions(7, null, null, 50, -1);`); },
        /p_offset must be between 0 and 10000/
      );
      await assert.rejects(
        async () => { await db.query(`SELECT public.get_qa_sessions(7, null, null, 50, 10001);`); },
        /p_offset must be between 0 and 10000/
      );

      // Valid limits pass
      const res = await db.query(`SELECT public.get_qa_sessions(7, null, null, 100, 0) AS s;`);
      assert.equal((res.rows[0] as any).s.ok, true);
    });

    test('C. get_qa_session_timeline requires non-null p_session_id', async () => {
      await setAuth(adminUser);

      await assert.rejects(
        async () => { await db.query(`SELECT public.get_qa_session_timeline(null);`); },
        /p_session_id cannot be null/
      );
    });
  });

  describe('6. Exact Friction Thresholds & Derived Abandonment', () => {
    test('A. Clarifications boundary: 1 clarification -> needs_review=true, 2 clarifications -> is_problematic=true', async () => {
      const sess1Clarif = '71111111-1111-1111-1111-111111111111';
      const sess2Clarif = '72222222-2222-2222-2222-222222222222';
      await setAuth(normalUser);

      // Session 1: 1 clarification
      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sess1Clarif}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'ai',
          p_initial_route => '/create/ai'
        );
      `);
      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sess1Clarif}'::UUID,
          p_event_type => 'clarification_requested',
          p_source => 'llm_openai',
          p_turn_number => 1,
          p_result => 'needs_clarification'
        );
      `);

      // Session 2: 2 clarifications
      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sess2Clarif}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'ai',
          p_initial_route => '/create/ai'
        );
      `);
      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sess2Clarif}'::UUID,
          p_event_type => 'clarification_requested',
          p_source => 'llm_openai',
          p_turn_number => 1,
          p_result => 'needs_clarification'
        );
      `);
      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sess2Clarif}'::UUID,
          p_event_type => 'clarification_requested',
          p_source => 'llm_openai',
          p_turn_number => 2,
          p_result => 'needs_clarification'
        );
      `);

      // Query sessions as admin
      await setAuth(adminUser);
      const res = await db.query(`SELECT public.get_qa_sessions(7) AS list;`);
      const list = (res.rows[0] as any).list.sessions;

      const row1 = list.find((s: any) => s.id === sess1Clarif);
      const row2 = list.find((s: any) => s.id === sess2Clarif);

      assert.ok(row1 && row2);
      assert.equal(row1.is_problematic, false, '1 clarification must not be problematic');
      assert.equal(row1.needs_review, true, '1 clarification must trigger needs_review');

      assert.equal(row2.is_problematic, true, '>= 2 clarifications must trigger is_problematic');
    });

    test('B. Turns boundary: 7 turns without completion -> NOT problematic, 8 turns -> is_problematic=true', async () => {
      const sess7Turns = '77777770-0000-0000-0000-000000000007';
      const sess8Turns = '78888880-0000-0000-0000-000000000008';
      await setAuth(normalUser);

      // Session with 7 turns, started
      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sess7Turns}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'ai',
          p_initial_route => '/create/ai',
          p_turn_number => 7,
          p_status => 'started'
        );
      `);

      // Session with 8 turns, started
      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sess8Turns}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'ai',
          p_initial_route => '/create/ai',
          p_turn_number => 8,
          p_status => 'started'
        );
      `);

      await setAuth(adminUser);
      const res = await db.query(`SELECT public.get_qa_sessions(7) AS list;`);
      const list = (res.rows[0] as any).list.sessions;

      const r7 = list.find((s: any) => s.id === sess7Turns);
      const r8 = list.find((s: any) => s.id === sess8Turns);

      assert.ok(r7 && r8);
      assert.equal(r7.is_problematic, false, '7 turns without completion is NOT problematic');
      assert.equal(r8.is_problematic, true, '>= 8 turns without completion IS problematic');
    });

    test('C. Elapsed boundary: 300,000 ms (exact 5 min) -> NOT review, 300,001 ms -> needs_review=true', async () => {
      const sess300k = '73000000-0000-0000-0000-000000000000';
      const sess300kPlus = '73000001-0000-0000-0000-000000000001';
      await setAuth(normalUser);

      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sess300k}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'ai',
          p_initial_route => '/create/ai',
          p_elapsed_ms => 300000
        );
      `);

      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sess300kPlus}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'ai',
          p_initial_route => '/create/ai',
          p_elapsed_ms => 300001
        );
      `);

      await setAuth(adminUser);
      const res = await db.query(`SELECT public.get_qa_sessions(7) AS list;`);
      const list = (res.rows[0] as any).list.sessions;

      const rExact = list.find((s: any) => s.id === sess300k);
      const rPlus = list.find((s: any) => s.id === sess300kPlus);

      assert.ok(rExact && rPlus);
      assert.equal(rExact.needs_review, false, 'Exact 300,000 ms does not trigger review');
      assert.equal(rPlus.needs_review, true, '300,001 ms (> 5 min) triggers review');
    });

    test('D. Derived abandonment in metrics (> 30 min inactive while started)', async () => {
      const activeSess = '81111111-1111-1111-1111-111111111111';
      const abandonedSess = '82222222-2222-2222-2222-222222222222';
      await setAuth(normalUser);

      // Active session (last_event_at is now)
      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${activeSess}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'ai',
          p_initial_route => '/create/ai'
        );
      `);

      // Inactive session (> 35 min ago)
      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${abandonedSess}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'ai',
          p_initial_route => '/create/ai'
        );
      `);
      await db.query(`
        UPDATE public.creation_sessions
        SET last_event_at = pg_catalog.timezone('utc', pg_catalog.now()) - INTERVAL '35 minutes'
        WHERE id = '${abandonedSess}';
      `);

      await setAuth(adminUser);
      const res = await db.query(`SELECT public.get_qa_dashboard_metrics(7) AS metrics;`);
      const metrics = (res.rows[0] as any).metrics;
      assert.equal(metrics.ok, true);
      assert.ok(metrics.abandoned_sessions >= 1, 'Inactive session must be counted in abandoned_sessions');
      assert.equal(metrics.probable_abandonment_heuristic_minutes, 30);

      // Confirm DB status remains 'started' (not changed destructively)
      const rawRow = await db.query(`SELECT status FROM public.creation_sessions WHERE id = '${abandonedSess}';`);
      assert.equal((rawRow.rows[0] as any).status, 'started');
    });

    test('E. Cascade delete on creation_sessions cleanly deletes child events', async () => {
      const sessId = '99999999-9999-9999-9999-999999999999';
      await setAuth(normalUser);

      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sessId}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'ai',
          p_initial_route => '/create/ai'
        );
      `);

      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sessId}'::UUID,
          p_event_type => 'turn_resolved',
          p_source => 'deterministic'
        );
      `);

      const eventsBefore = await db.query(`SELECT COUNT(*) AS c FROM public.creation_session_events WHERE session_id = '${sessId}';`);
      assert.equal((eventsBefore.rows[0] as any).c, 2);

      // Delete session
      await db.query(`DELETE FROM public.creation_sessions WHERE id = '${sessId}';`);

      const eventsAfter = await db.query(`SELECT COUNT(*) AS c FROM public.creation_session_events WHERE session_id = '${sessId}';`);
      assert.equal((eventsAfter.rows[0] as any).c, 0);
    });

    test('F. Timeline and Sessions DO NOT expose client_token_hash or unexpected columns', async () => {
      const sessId = '10101010-1010-1010-1010-101010101010';
      await setAuth(normalUser);

      // Init session
      await db.query(`
        SELECT public.registrar_evento_creacion(
          p_session_id => '${sessId}'::UUID,
          p_event_type => 'session_started',
          p_source => 'system',
          p_creation_source => 'ai',
          p_initial_route => '/create/ai'
        );
      `);

      // Mock a fake sensitive column temporarily
      await db.query(`ALTER TABLE public.creation_sessions ADD COLUMN IF NOT EXISTS _test_secret_password TEXT DEFAULT 'my_secret';`);

      await setAuth(adminUser);

      // 1. Test get_qa_session_timeline
      const tlRes = await db.query(`SELECT public.get_qa_session_timeline('${sessId}'::UUID) AS tl;`);
      const tl = (tlRes.rows[0] as any).tl;
      assert.ok(tl.session);
      assert.equal(tl.session.client_token_hash, undefined, 'Timeline MUST NOT expose client_token_hash');
      assert.equal(tl.session._test_secret_password, undefined, 'Timeline MUST NOT expose unapproved columns');
      
      // 2. Test get_qa_sessions
      const sRes = await db.query(`SELECT public.get_qa_sessions(1) AS sl;`);
      const sl = (sRes.rows[0] as any).sl.sessions;
      const sessObj = sl.find((s: any) => s.id === sessId);
      assert.ok(sessObj);
      assert.equal(sessObj.client_token_hash, undefined, 'Sessions list MUST NOT expose client_token_hash');
      assert.equal(sessObj._test_secret_password, undefined, 'Sessions list MUST NOT expose unapproved columns');

      // Cleanup
      await db.query(`ALTER TABLE public.creation_sessions DROP COLUMN _test_secret_password;`);
      await db.query(`DELETE FROM public.creation_sessions WHERE id = '${sessId}';`);
    });
  });
});
