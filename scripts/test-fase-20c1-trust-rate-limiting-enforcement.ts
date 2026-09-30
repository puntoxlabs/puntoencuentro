/**
 * T5-B2 — Enforcement of Generic Rate Limiting on Core Social Actions
 *
 * Covers:
 * 1. create_encounter (crear_encuentro_seguro & crear_encuentro_con_opciones_seguro)
 * 2. create_intention (crear_intencion_segura)
 * 3. join_open_encounter (solicitar_sumarse_encuentro_abierto)
 * 4. Cooldown exacto post-rechazo (6 horas) & Legacy fallback COALESCE(resolved_at, updated_at, created_at)
 * 5. Invariante futura de rechazar_solicitud_encuentro_abierto
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('T5-B2 — Rate Limiting Enforcement on Core Social Actions', () => {
  let db: PGlite;
  const userHost = '11111111-1111-1111-1111-111111111111';
  const userApplicantA = '22222222-2222-2222-2222-222222222222';
  const userApplicantB = '33333333-3333-3333-3333-333333333333';
  const userAnon = '44444444-4444-4444-4444-444444444444';

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
        ('${userHost}', 'host@test.com'),
        ('${userApplicantA}', 'appA@test.com'),
        ('${userApplicantB}', 'appB@test.com'),
        ('${userAnon}', 'anon@test.com')
      ON CONFLICT DO NOTHING;
    `);

    // Helper function to execute migrations in order
    const runMigration = async (relPath: string) => {
      const fullPath = path.resolve(process.cwd(), relPath);
      const sql = fs.readFileSync(fullPath, 'utf-8');
      await db.exec(sql);
    };

    // Load prerequisites schema migrations
    await runMigration('supabase/migrations/20260424000000_initial_schema.sql');
    await runMigration('supabase/migrations/20260627000000_add_guest_response_visibility.sql');
    await runMigration('supabase/migrations/20260701000000_add_invitation_template.sql');
    await runMigration('supabase/migrations/20260710000001_custom_invitation_templates.sql');
    await runMigration('supabase/migrations/20260713114500_add_encounter_date_coordination_schema.sql');
    await runMigration('supabase/migrations/20260714165000_add_coordination_backend_read_contracts.sql');
    await runMigration('supabase/migrations/20260720000000_add_coordination_response_visibility_mode.sql');
    await runMigration('supabase/migrations/20260721000000_add_post_event_minutes_and_options_meta.sql');
    await runMigration('supabase/migrations/20260927120000_open_encounters_and_localities.sql');
    await runMigration('supabase/migrations/20260928150000_harden_open_encounters_identity.sql');
    await runMigration('supabase/migrations/20260929170000_fase_20a_intenciones_core.sql');
    await runMigration('supabase/migrations/20260930160000_fase_20c1_trust_user_blocking_core.sql');
    await runMigration('supabase/migrations/20260930163000_fase_20c1_trust_enforce_bilateral_blocking.sql');

    // Load T5-B1 & T5-B1.1 (Rate limit infra)
    await runMigration('supabase/migrations/20260930200000_fase_20c1_trust_generic_rate_limiting.sql');
    await runMigration('supabase/migrations/20260930203000_fix_generic_rate_limiter_hardening.sql');

    // Load T5-B2 (Enforcement on core actions)
    await runMigration('supabase/migrations/20260930210000_fase_20c1_trust_enforce_rate_limits_core_actions.sql');
  });

  // Helper to set authenticated user session
  const setSession = async (userId: string, isAnon = false) => {
    await db.exec(`
      SELECT set_config('request.jwt.claim.sub', '${userId}', false);
      SELECT set_config('request.jwt.claims', '{"is_anonymous": ${isAnon}}', false);
    `);
  };

  test('1. CREATE ENCOUNTER: Anonymous user creates within limit without permanent account requirement', async () => {
    await setSession(userAnon, true);

    const payload = JSON.stringify({
      titulo: 'Encuentro Privado Anónimo',
      fecha: '2026-10-15',
      hora: '20:00',
      modalidad: 'presencial',
      lugar_texto: 'Parque Patricios',
      tipo_invitacion: 'link_general',
    });

    const res = await db.query(`SELECT public.crear_encuentro_seguro('${payload}'::jsonb) AS result;`);
    const result = (res.rows[0] as any).result;

    assert.equal(result.ok, true);
    assert.ok(result.id);
    assert.ok(result.public_token);

    // Verify rate limit bucket incremented for userAnon
    const bucket = await db.query(`
      SELECT request_count FROM public.rate_limit_buckets
      WHERE action = 'create_encounter' AND user_id = '${userAnon}';
    `);
    assert.equal((bucket.rows[0] as any).request_count, 1);
  });

  test('2. CREATE ENCOUNTER: Simple and With Options share the same bucket and alternation counts correctly', async () => {
    // Setup test policy with max_requests = 3
    await db.query(`
      UPDATE public.rate_limit_policies
      SET max_requests = 3
      WHERE action = 'create_encounter';
    `);

    await setSession(userHost, false);

    // Call 1: Simple
    const pSimple1 = JSON.stringify({
      titulo: 'Encuentro Simple 1',
      fecha: '2026-10-20',
      hora: '19:00',
      modalidad: 'presencial',
      lugar_texto: 'Palermo',
      tipo_invitacion: 'link_general',
    });
    const r1 = await db.query(`SELECT public.crear_encuentro_seguro('${pSimple1}'::jsonb) AS result;`);
    assert.equal((r1.rows[0] as any).result.ok, true);

    // Call 2: With Options
    const pOptData = JSON.stringify({
      titulo: 'Encuentro Coordinación 2',
      modalidad: 'presencial',
      lugar_texto: 'Belgrano',
      tipo_invitacion: 'link_general',
      response_deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    const pOpciones = JSON.stringify([
      { fecha: '2026-10-22', hora_inicio: '18:00' },
      { fecha: '2026-10-23', hora_inicio: '18:00' },
    ]);
    const r2 = await db.query(`SELECT public.crear_encuentro_con_opciones_seguro('${pOptData}'::jsonb, '${pOpciones}'::jsonb) AS result;`);
    assert.equal((r2.rows[0] as any).result.ok, true);

    // Call 3: Simple again (reaches limit 3)
    const pSimple2 = JSON.stringify({
      titulo: 'Encuentro Simple 3',
      fecha: '2026-10-25',
      hora: '19:00',
      modalidad: 'presencial',
      lugar_texto: 'Recoleta',
      tipo_invitacion: 'link_general',
    });
    const r3 = await db.query(`SELECT public.crear_encuentro_seguro('${pSimple2}'::jsonb) AS result;`);
    assert.equal((r3.rows[0] as any).result.ok, true);

    // Verify bucket count is exactly 3 (shared between both)
    const bCheck = await db.query(`
      SELECT request_count FROM public.rate_limit_buckets
      WHERE action = 'create_encounter' AND user_id = '${userHost}';
    `);
    assert.equal((bCheck.rows[0] as any).request_count, 3);

    // Call 4: Exceeded on simple -> rejected with rate_limit_exceeded
    const r4 = await db.query(`SELECT public.crear_encuentro_seguro('${pSimple2}'::jsonb) AS result;`);
    assert.equal((r4.rows[0] as any).result.ok, false);
    assert.equal((r4.rows[0] as any).result.error, 'rate_limit_exceeded');

    // Call 5: Exceeded on with options -> rejected with rate_limit_exceeded
    const r5 = await db.query(`SELECT public.crear_encuentro_con_opciones_seguro('${pOptData}'::jsonb, '${pOpciones}'::jsonb) AS result;`);
    assert.equal((r5.rows[0] as any).result.ok, false);
    assert.equal((r5.rows[0] as any).result.error, 'rate_limit_exceeded');

    // Restore policy to default
    await db.query(`UPDATE public.rate_limit_policies SET max_requests = 20 WHERE action = 'create_encounter';`);
  });

  test('3. CREATE INTENTION: Permanent user within limit succeeds, limit exceeded rejects without inserting, anonymous rejects before limiter', async () => {
    await db.query(`
      UPDATE public.rate_limit_policies
      SET max_requests = 2
      WHERE action = 'create_intention';
    `);

    // A. Anonymous rejects by permanent_account_required before rate limit check
    await setSession(userAnon, true);
    const anonRes = await db.query(`
      SELECT public.crear_intencion_segura('Intención Anon') AS result;
    `);
    assert.equal((anonRes.rows[0] as any).result.ok, false);
    assert.equal((anonRes.rows[0] as any).result.error, 'permanent_account_required');

    // B. Permanent user within limit
    await setSession(userApplicantA, false);
    const i1 = await db.query(`SELECT public.crear_intencion_segura('Intención 1') AS result;`);
    assert.equal((i1.rows[0] as any).result.ok, true);

    const i2 = await db.query(`SELECT public.crear_intencion_segura('Intención 2') AS result;`);
    assert.equal((i2.rows[0] as any).result.ok, true);

    // C. Exceeded limit
    const i3 = await db.query(`SELECT public.crear_intencion_segura('Intención 3') AS result;`);
    assert.equal((i3.rows[0] as any).result.ok, false);
    assert.equal((i3.rows[0] as any).result.error, 'rate_limit_exceeded');

    // Confirm only 2 rows inserted in intenciones
    const countRes = await db.query(`
      SELECT COUNT(*)::int AS count FROM public.intenciones WHERE user_id = '${userApplicantA}';
    `);
    assert.equal((countRes.rows[0] as any).count, 2);

    // Restore policy
    await db.query(`UPDATE public.rate_limit_policies SET max_requests = 6 WHERE action = 'create_intention';`);
  });

  test('4. JOIN OPEN ENCOUNTER: Global rate limit shared across different encounters', async () => {
    // Setup test open encounters
    const enc1Id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const enc2Id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const enc3Id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    await db.exec(`
      INSERT INTO public.localidades (id, nombre, ciudad, zona, activo) VALUES ('palermo', 'Palermo', 'CABA', 'Norte', true) ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.encuentros (id, titulo, host_id, estado, is_open, max_participants, modalidad, locality_id, tipo_invitacion, fecha, hora)
      VALUES
        ('${enc1Id}', 'Encuentro 1', '${userHost}', 'activo', true, 10, 'presencial', 'palermo', 'link_general', '2026-10-25', '19:00'),
        ('${enc2Id}', 'Encuentro 2', '${userHost}', 'activo', true, 10, 'presencial', 'palermo', 'link_general', '2026-10-25', '19:00'),
        ('${enc3Id}', 'Encuentro 3', '${userHost}', 'activo', true, 10, 'presencial', 'palermo', 'link_general', '2026-10-25', '19:00')
      ON CONFLICT (id) DO UPDATE SET is_open = true, estado = 'activo', max_participants = 10;
    `);

    // Set join policy max = 2
    await db.query(`UPDATE public.rate_limit_policies SET max_requests = 2 WHERE action = 'join_open_encounter';`);

    await setSession(userApplicantB, false);

    // Join encounter 1
    const j1 = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${enc1Id}', 'Applicant B') AS result;`);
    assert.equal((j1.rows[0] as any).result.ok, true);

    // Duplicate pending check does NOT consume rate limit
    const j1Dup = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${enc1Id}', 'Applicant B') AS result;`);
    assert.equal((j1Dup.rows[0] as any).result.ok, false);
    assert.equal((j1Dup.rows[0] as any).result.error, 'duplicate_pending_request');

    // Bucket count still 1
    const b1 = await db.query(`
      SELECT request_count FROM public.rate_limit_buckets
      WHERE action = 'join_open_encounter' AND user_id = '${userApplicantB}';
    `);
    assert.equal((b1.rows[0] as any).request_count, 1);

    // Join encounter 2 (reaches limit 2)
    const j2 = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${enc2Id}', 'Applicant B') AS result;`);
    assert.equal((j2.rows[0] as any).result.ok, true);

    // Join encounter 3 (exceeded global limit)
    const j3 = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${enc3Id}', 'Applicant B') AS result;`);
    assert.equal((j3.rows[0] as any).result.ok, false);
    assert.equal((j3.rows[0] as any).result.error, 'rate_limit_exceeded');

    // Restore policy
    await db.query(`UPDATE public.rate_limit_policies SET max_requests = 12 WHERE action = 'join_open_encounter';`);
  });

  test('5. COOLDOWN POST-RECHAZO: 6-hour exact cooldown on same encounter, does not affect other encounters', async () => {
    const encAId = 'aaaaaaaa-1111-aaaa-aaaa-aaaaaaaaaaaa';
    const encBId = 'bbbbbbbb-2222-bbbb-bbbb-bbbbbbbbbbbb';

    await db.exec(`
      INSERT INTO public.encuentros (id, titulo, host_id, estado, is_open, max_participants, modalidad, locality_id, tipo_invitacion, fecha, hora)
      VALUES
        ('${encAId}', 'Encuentro A', '${userHost}', 'activo', true, 10, 'presencial', 'palermo', 'link_general', '2026-10-25', '19:00'),
        ('${encBId}', 'Encuentro B', '${userHost}', 'activo', true, 10, 'presencial', 'palermo', 'link_general', '2026-10-25', '19:00')
      ON CONFLICT (id) DO UPDATE SET is_open = true, estado = 'activo', max_participants = 10;
    `);

    await setSession(userApplicantA, false);

    // A. Insert a recent rejection (< 6 hours, e.g. 2 hours ago)
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, resolved_at)
      VALUES ('${encAId}', '${userApplicantA}', 'Applicant A', 'rejected', '${twoHoursAgo}'::timestamptz);
    `);

    // B. New request to Encounter A is blocked by cooldown
    const rA = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${encAId}', 'Applicant A') AS result;`);
    assert.equal((rA.rows[0] as any).result.ok, false);
    assert.equal((rA.rows[0] as any).result.error, 'request_not_available');

    // C. Cooldown on Encounter A does NOT affect Encounter B
    const rB = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${encBId}', 'Applicant A') AS result;`);
    assert.equal((rB.rows[0] as any).result.ok, true);

    // D. Rejection from 7 hours ago has expired -> allowed
    const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    await db.query(`
      UPDATE public.solicitudes_encuentro_abierto
      SET resolved_at = '${sevenHoursAgo}'::timestamptz
      WHERE encuentro_id = '${encAId}' AND usuario_id = '${userApplicantA}';
    `);

    const rAAfterExpiry = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${encAId}', 'Applicant A') AS result;`);
    assert.equal((rAAfterExpiry.rows[0] as any).result.ok, true);
  });

  test('6. COOLDOWN LEGACY TOLERANCE: resolved_at NULL falls back to updated_at and created_at without backfill', async () => {
    const encLegacyId = 'cccccccc-3333-cccc-cccc-cccccccccccc';
    await db.exec(`
      INSERT INTO public.encuentros (id, titulo, host_id, estado, is_open, max_participants, modalidad, locality_id, tipo_invitacion, fecha, hora)
      VALUES ('${encLegacyId}', 'Encuentro Legacy', '${userHost}', 'activo', true, 10, 'presencial', 'palermo', 'link_general', '2026-10-25', '19:00')
      ON CONFLICT (id) DO NOTHING;
    `);

    await setSession(userApplicantA, false);

    // A. Rejected with resolved_at NULL, updated_at 2 hours ago -> active cooldown
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const req1Id = '99999999-1111-9999-9999-999999999999';
    await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (id, encuentro_id, usuario_id, nombre_solicitante, estado, resolved_at, updated_at, created_at)
      VALUES ('${req1Id}', '${encLegacyId}', '${userApplicantA}', 'Applicant A', 'rejected', NULL, '${twoHoursAgo}'::timestamptz, '${twoHoursAgo}'::timestamptz);
    `);

    const res1 = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${encLegacyId}', 'Applicant A') AS result;`);
    assert.equal((res1.rows[0] as any).result.ok, false);
    assert.equal((res1.rows[0] as any).result.error, 'request_not_available');

    // Confirm resolved_at was NOT backfilled
    const check1 = await db.query(`SELECT resolved_at FROM public.solicitudes_encuentro_abierto WHERE id = '${req1Id}';`);
    assert.equal((check1.rows[0] as any).resolved_at, null);

    // B. Legacy row older than 6 hours (e.g. 10 hours ago) -> cooldown expired
    const tenHoursAgo = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
    await db.query(`
      UPDATE public.solicitudes_encuentro_abierto
      SET updated_at = '${tenHoursAgo}'::timestamptz, created_at = '${tenHoursAgo}'::timestamptz
      WHERE id = '${req1Id}';
    `);

    const res2 = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${encLegacyId}', 'Applicant A') AS result;`);
    assert.equal((res2.rows[0] as any).result.ok, true);
  });

  test('7. INVARIANTE: rechazar_solicitud_encuentro_abierto sets resolved_at = now() for normal rejections', async () => {
    const encRejId = 'dddddddd-4444-dddd-dddd-dddddddddddd';
    await db.exec(`
      INSERT INTO public.encuentros (id, titulo, host_id, estado, is_open, max_participants, modalidad, locality_id, tipo_invitacion, fecha, hora)
      VALUES ('${encRejId}', 'Encuentro Reject Invariant', '${userHost}', 'activo', true, 10, 'presencial', 'palermo', 'link_general', '2026-10-25', '19:00')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Create pending request as Applicant B
    await setSession(userApplicantB, false);
    const joinRes = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${encRejId}', 'Applicant B') AS result;`);
    const requestId = (joinRes.rows[0] as any).result.request_id;
    assert.ok(requestId);

    // Host rejects request
    await setSession(userHost, false);
    const rejRes = await db.query(`
      SELECT public.rechazar_solicitud_encuentro_abierto('${requestId}'::uuid, '${userHost}'::uuid) AS result;
    `);
    assert.equal((rejRes.rows[0] as any).result.ok, true);

    // Verify resolved_at was populated
    const checkRej = await db.query(`
      SELECT estado, resolved_at FROM public.solicitudes_encuentro_abierto WHERE id = '${requestId}';
    `);
    const row = checkRej.rows[0] as any;
    assert.equal(row.estado, 'rejected');
    assert.ok(row.resolved_at !== null, 'Normal rejections MUST write resolved_at');
  });
});
