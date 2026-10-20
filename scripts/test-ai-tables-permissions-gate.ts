/**
 * AI Internal Tables Minimum Privilege Guard (Supabase 30/10/2026 Readiness)
 * 
 * Verifica:
 * 1. Que las tablas internas de IA (ai_creation_sessions, ai_rate_limit_buckets, ai_burst_rate_limit_buckets)
 *    tengan REVOKE explícito de permisos directos para PUBLIC, anon y authenticated.
 * 2. Que un intento de SELECT / INSERT / UPDATE directo desde los roles anon o authenticated
 *    sea bloqueado con "permission denied for table ...".
 * 3. Que las RPCs SECURITY DEFINER asociadas sigan funcionando correctamente bajo autenticación.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('AI Internal Tables Minimum Privilege Guard (Supabase 30/10/2026 Readiness)', () => {
  let db: PGlite;
  const testUserId = '11111111-1111-1111-1111-111111111111';

  before(async () => {
    db = new PGlite();

    // 1. Roles estándar de Supabase y esquema auth
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
        email TEXT,
        is_anonymous BOOLEAN DEFAULT false
      );
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT json_build_object(
          'sub', current_setting('request.jwt.claim.sub', true),
          'is_anonymous', false
        )::jsonb;
      $$ LANGUAGE SQL STABLE;

      INSERT INTO auth.users (id, email, is_anonymous) VALUES
        ('${testUserId}', 'user@test.com', false)
      ON CONFLICT DO NOTHING;
    `);

    // 2. Aplicar migraciones base requeridas
    const migrationFiles = [
      '20260424000000_initial_schema.sql',
      '20260907000000_ai_creation_sessions.sql',
      '20260909140000_ai_rate_limit_buckets.sql',
      '20261015190000_ai_short_burst_rate_limit.sql',
      '20261020133000_revoke_ai_internal_tables_public_privileges.sql'
    ];

    for (const relFile of migrationFiles) {
      const fullPath = path.resolve(process.cwd(), 'supabase/migrations', relFile);
      const sql = fs.readFileSync(fullPath, 'utf-8');
      await db.exec(sql);
    }
  });

  test('1. Acceso directo a public.ai_creation_sessions como authenticated es denegado', async () => {
    await db.exec(`SET ROLE authenticated;`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${testUserId}', false);`);

    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.ai_creation_sessions;`);
      },
      (err: any) => {
        assert.match(err.message, /permission denied for table ai_creation_sessions/i);
        return true;
      }
    );

    await db.exec(`RESET ROLE;`);
  });

  test('2. Acceso directo a public.ai_rate_limit_buckets como authenticated es denegado', async () => {
    await db.exec(`SET ROLE authenticated;`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${testUserId}', false);`);

    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.ai_rate_limit_buckets;`);
      },
      (err: any) => {
        assert.match(err.message, /permission denied for table ai_rate_limit_buckets/i);
        return true;
      }
    );

    await db.exec(`RESET ROLE;`);
  });

  test('3. Acceso directo a public.ai_burst_rate_limit_buckets como authenticated es denegado', async () => {
    await db.exec(`SET ROLE authenticated;`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${testUserId}', false);`);

    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.ai_burst_rate_limit_buckets;`);
      },
      (err: any) => {
        assert.match(err.message, /permission denied for table ai_burst_rate_limit_buckets/i);
        return true;
      }
    );

    await db.exec(`RESET ROLE;`);
  });

  test('4. Acceso directo a las 3 tablas como anon es denegado', async () => {
    await db.exec(`SET ROLE anon;`);

    for (const table of ['ai_creation_sessions', 'ai_rate_limit_buckets', 'ai_burst_rate_limit_buckets']) {
      await assert.rejects(
        async () => {
          await db.query(`SELECT * FROM public.${table};`);
        },
        (err: any) => {
          assert.match(err.message, new RegExp(`permission denied for table ${table}`, 'i'));
          return true;
        }
      );
    }

    await db.exec(`RESET ROLE;`);
  });

  test('5. RPCs SECURITY DEFINER funcionan correctamente para usuarios autenticados', async () => {
    // authenticated ejecuta las RPCs
    await db.exec(`SET ROLE authenticated;`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${testUserId}', false);`);

    // Probar check_and_increment_ai_burst_limit
    const resBurst = await db.query(`SELECT public.check_and_increment_ai_burst_limit(10) AS res;`);
    const burstResult = (resBurst.rows[0] as any).res;
    assert.equal(burstResult.allowed, true);
    assert.equal(burstResult.current_count, 1);

    // Probar check_and_increment_ai_rate_limit
    const resHourly = await db.query(`SELECT public.check_and_increment_ai_rate_limit(40) AS res;`);
    const hourlyResult = (resHourly.rows[0] as any).res;
    assert.equal(hourlyResult.allowed, true);
    assert.equal(hourlyResult.current_count, 1);

    // Probar registrar_sesion_ai_inicio
    const resInicio = await db.query(`SELECT public.registrar_sesion_ai_inicio(gen_random_uuid(), 'test_prov', 'test_model') AS res;`);
    const inicioResult = (resInicio.rows[0] as any).res;
    assert.equal(inicioResult.ok, true);

    await db.exec(`RESET ROLE;`);
  });
});
