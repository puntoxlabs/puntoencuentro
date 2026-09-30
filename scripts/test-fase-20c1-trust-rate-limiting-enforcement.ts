/**
 * T5-B2 / T5-B2.1 — Enforcement of Generic Rate Limiting on Core Social Actions
 *
 * Covers:
 * 1. create_encounter (crear_encuentro_seguro & crear_encuentro_con_opciones_seguro)
 *    - Anonymous user creates simple private encounter within limit.
 *    - Anonymous user rejected on coordination encounters (permanent_account_required preexistente).
 *    - Invalid payload in simple (invalid_post_event_active_minutes) does NOT consume bucket.
 *    - Invalid options/dates in coordination does NOT consume bucket.
 *    - Valid simple and with-options share the same bucket and count atomically (+1).
 * 2. create_intention (crear_intencion_segura)
 *    - Anonymous rejected before limiter (permanent_account_required) without consuming bucket.
 *    - Invalid title, invalid modality, invalid date range do NOT consume bucket.
 *    - Valid intention consumes +1.
 *    - Exceeded limit rejects with rate_limit_exceeded without inserting row.
 * 3. join_open_encounter (solicitar_sumarse_encuentro_abierto)
 *    - Duplicate pending request does NOT consume bucket.
 *    - Bilateral blocking does NOT consume bucket.
 *    - Active cooldown does NOT consume bucket.
 *    - Valid join request consumes +1.
 * 4. Cooldown exacto post-rechazo (6 horas) & Legacy fallback COALESCE(resolved_at, updated_at, created_at)
 * 5. Invariante futura de rechazar_solicitud_encuentro_abierto (sets resolved_at = now())
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('T5-B2.1 — Rate Limiting Enforcement & Validation Order Core Tests', () => {
  let db: PGlite;
  const userHost = '11111111-1111-1111-1111-111111111111';
  const userApplicantA = '22222222-2222-2222-2222-222222222222';
  const userApplicantB = '33333333-3333-3333-3333-333333333333';
  const userBlocked = '55555555-5555-5555-5555-555555555555';
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
        ('${userBlocked}', 'blocked@test.com'),
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

    // Load T5-B2.1 (Microfix: validation order)
    await runMigration('supabase/migrations/20260930213000_fix_rate_limit_validation_order.sql');
  });

  // Helper to set authenticated user session
  const setSession = async (userId: string, isAnon = false) => {
    await db.exec(`
      SELECT set_config('request.jwt.claim.sub', '${userId}', false);
      SELECT set_config('request.jwt.claims', '{"is_anonymous": ${isAnon}}', false);
    `);
  };

  const getBucketCount = async (action: string, userId: string) => {
    const res = await db.query(`
      SELECT request_count FROM public.rate_limit_buckets
      WHERE action = '${action}' AND user_id = '${userId}';
    `);
    if (res.rows.length === 0) return 0;
    return (res.rows[0] as any).request_count;
  };

  test('1. CREATE ENCOUNTER (SIMPLE): Anonymous allowed, invalid payload does NOT consume, valid consumes +1', async () => {
    await setSession(userAnon, true);

    // Initial count
    const count0 = await getBucketCount('create_encounter', userAnon);
    assert.equal(count0, 0);

    // A. Invalid payload: invalid post_event_active_minutes -> returns functional error
    const invalidPayload = JSON.stringify({
      titulo: 'Encuentro Invalido Post Minutes',
      fecha: '2026-10-15',
      hora: '20:00',
      modalidad: 'presencial',
      lugar_texto: 'Parque Patricios',
      tipo_invitacion: 'link_general',
      post_event_active_minutes: -5,
    });
    const rInvalid = await db.query(`SELECT public.crear_encuentro_seguro('${invalidPayload}'::jsonb) AS result;`);
    assert.equal((rInvalid.rows[0] as any).result.ok, false);
    assert.equal((rInvalid.rows[0] as any).result.error, 'invalid_post_event_active_minutes');

    // Verify bucket was NOT incremented on invalid payload
    const countAfterInvalid = await getBucketCount('create_encounter', userAnon);
    assert.equal(countAfterInvalid, 0, 'Invalid payload MUST NOT consume rate limit bucket');

    // B. Valid payload for anonymous user -> succeeds and consumes exactly +1
    const validPayload = JSON.stringify({
      titulo: 'Encuentro Privado Anónimo Válido',
      fecha: '2026-10-15',
      hora: '20:00',
      modalidad: 'presencial',
      lugar_texto: 'Parque Patricios',
      tipo_invitacion: 'link_general',
      post_event_active_minutes: 60,
    });
    const rValid = await db.query(`SELECT public.crear_encuentro_seguro('${validPayload}'::jsonb) AS result;`);
    const resValid = (rValid.rows[0] as any).result;
    assert.equal(resValid.ok, true);
    assert.ok(resValid.id);

    const countAfterValid = await getBucketCount('create_encounter', userAnon);
    assert.equal(countAfterValid, 1, 'Valid creation MUST increment bucket by exactly 1');
  });

  test('2. CREATE ENCOUNTER (OPTIONS): Preexisting permanent check, invalid options do NOT consume, valid consumes +1', async () => {
    // A. Anonymous is rejected with permanent_account_required (preexisting contract) without consuming bucket
    await setSession(userAnon, true);
    const countAnonBefore = await getBucketCount('create_encounter', userAnon);

    const optData = JSON.stringify({
      titulo: 'Encuentro Anon Opciones',
      modalidad: 'presencial',
      lugar_texto: 'Belgrano',
      tipo_invitacion: 'link_general',
      response_deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    const opciones = JSON.stringify([
      { fecha: '2026-10-22', hora_inicio: '18:00' },
      { fecha: '2026-10-23', hora_inicio: '18:00' },
    ]);
    const rAnonOpt = await db.query(`SELECT public.crear_encuentro_con_opciones_seguro('${optData}'::jsonb, '${opciones}'::jsonb) AS result;`);
    assert.equal((rAnonOpt.rows[0] as any).result.ok, false);
    assert.equal((rAnonOpt.rows[0] as any).result.error, 'permanent_account_required');

    const countAnonAfter = await getBucketCount('create_encounter', userAnon);
    assert.equal(countAnonAfter, countAnonBefore, 'Rejected anonymous MUST NOT consume bucket');

    // B. Permanent user with invalid options (< 2 options) -> rejected with minimum_two_options without consuming
    await setSession(userHost, false);
    const countHostBefore = await getBucketCount('create_encounter', userHost);

    const singleOption = JSON.stringify([{ fecha: '2026-10-22', hora_inicio: '18:00' }]);
    const rInvalidOpt = await db.query(`SELECT public.crear_encuentro_con_opciones_seguro('${optData}'::jsonb, '${singleOption}'::jsonb) AS result;`);
    assert.equal((rInvalidOpt.rows[0] as any).result.ok, false);
    assert.equal((rInvalidOpt.rows[0] as any).result.error, 'minimum_two_options');

    const countHostAfterInvalid = await getBucketCount('create_encounter', userHost);
    assert.equal(countHostAfterInvalid, countHostBefore, 'Invalid options MUST NOT consume bucket');

    // C. Valid options encounter -> succeeds and consumes exactly +1
    const rValidOpt = await db.query(`SELECT public.crear_encuentro_con_opciones_seguro('${optData}'::jsonb, '${opciones}'::jsonb) AS result;`);
    assert.equal((rValidOpt.rows[0] as any).result.ok, true);

    const countHostAfterValid = await getBucketCount('create_encounter', userHost);
    assert.equal(countHostAfterValid, countHostBefore + 1, 'Valid options creation MUST consume +1');
  });

  test('3. BUCKET COMPARTIDO: Simple and With Options alternate on the same create_encounter bucket', async () => {
    await setSession(userHost, false);
    const countStart = await getBucketCount('create_encounter', userHost);

    // Call Simple
    const pSimple = JSON.stringify({
      titulo: 'Simple Shared Test',
      fecha: '2026-10-25',
      hora: '19:00',
      modalidad: 'presencial',
      lugar_texto: 'Recoleta',
      tipo_invitacion: 'link_general',
    });
    const r1 = await db.query(`SELECT public.crear_encuentro_seguro('${pSimple}'::jsonb) AS result;`);
    assert.equal((r1.rows[0] as any).result.ok, true);

    const countAfterSimple = await getBucketCount('create_encounter', userHost);
    assert.equal(countAfterSimple, countStart + 1);

    // Call Options
    const optData = JSON.stringify({
      titulo: 'Options Shared Test',
      modalidad: 'presencial',
      lugar_texto: 'Recoleta',
      tipo_invitacion: 'link_general',
      response_deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    const opciones = JSON.stringify([
      { fecha: '2026-10-26', hora_inicio: '18:00' },
      { fecha: '2026-10-27', hora_inicio: '18:00' },
    ]);
    const r2 = await db.query(`SELECT public.crear_encuentro_con_opciones_seguro('${optData}'::jsonb, '${opciones}'::jsonb) AS result;`);
    assert.equal((r2.rows[0] as any).result.ok, true);

    const countAfterOptions = await getBucketCount('create_encounter', userHost);
    assert.equal(countAfterOptions, countStart + 2, 'Both simple and options must increment the same bucket count');
  });

  test('4. CREATE INTENTION: Invalid payloads do NOT consume, valid consumes +1, threshold enforced', async () => {
    await setSession(userApplicantA, false);
    const countBefore = await getBucketCount('create_intention', userApplicantA);

    // A. Invalid title -> invalid_title -> count unchanged
    const rInvTitle = await db.query(`SELECT public.crear_intencion_segura('') AS result;`);
    assert.equal((rInvTitle.rows[0] as any).result.ok, false);
    assert.equal((rInvTitle.rows[0] as any).result.error, 'invalid_title');
    assert.equal(await getBucketCount('create_intention', userApplicantA), countBefore);

    // B. Invalid modality -> invalid_modality -> count unchanged
    const rInvMod = await db.query(`SELECT public.crear_intencion_segura('Titulo Ok', NULL, NULL, NULL, NULL, 'astral') AS result;`);
    assert.equal((rInvMod.rows[0] as any).result.ok, false);
    assert.equal((rInvMod.rows[0] as any).result.error, 'invalid_modality');
    assert.equal(await getBucketCount('create_intention', userApplicantA), countBefore);

    // C. Invalid date range -> invalid_date_range -> count unchanged
    const rInvDate = await db.query(`SELECT public.crear_intencion_segura('Titulo Ok', NULL, NULL, '2026-10-30', '2026-10-20') AS result;`);
    assert.equal((rInvDate.rows[0] as any).result.ok, false);
    assert.equal((rInvDate.rows[0] as any).result.error, 'invalid_date_range');
    assert.equal(await getBucketCount('create_intention', userApplicantA), countBefore);

    // D. Invalid locality -> invalid_locality -> count unchanged
    const rInvLoc = await db.query(`SELECT public.crear_intencion_segura('Titulo Ok', NULL, NULL, NULL, NULL, 'presencial', 'non_existent_loc') AS result;`);
    assert.equal((rInvLoc.rows[0] as any).result.ok, false);
    assert.equal((rInvLoc.rows[0] as any).result.error, 'invalid_locality');
    assert.equal(await getBucketCount('create_intention', userApplicantA), countBefore);

    // E. Valid intention -> consumes exactly +1
    const rValid = await db.query(`SELECT public.crear_intencion_segura('Intención Válida') AS result;`);
    assert.equal((rValid.rows[0] as any).result.ok, true);
    assert.equal(await getBucketCount('create_intention', userApplicantA), countBefore + 1);

    // F. Exceed threshold test with max_requests = 2
    await db.query(`UPDATE public.rate_limit_policies SET max_requests = 2 WHERE action = 'create_intention';`);
    const rValid2 = await db.query(`SELECT public.crear_intencion_segura('Intención Válida 2') AS result;`);
    assert.equal((rValid2.rows[0] as any).result.ok, true);

    // 3rd request exceeds limit 2 -> rate_limit_exceeded and no row inserted
    const rExceeded = await db.query(`SELECT public.crear_intencion_segura('Intención Excedida') AS result;`);
    assert.equal((rExceeded.rows[0] as any).result.ok, false);
    assert.equal((rExceeded.rows[0] as any).result.error, 'rate_limit_exceeded');

    // Confirm only 2 rows in DB for userApplicantA
    const countRows = await db.query(`SELECT COUNT(*)::int AS count FROM public.intenciones WHERE user_id = '${userApplicantA}';`);
    assert.equal((countRows.rows[0] as any).count, 2);

    // Restore policy
    await db.query(`UPDATE public.rate_limit_policies SET max_requests = 6 WHERE action = 'create_intention';`);
  });

  test('5. JOIN OPEN ENCOUNTER: Duplicate, blocked, cooldown do NOT consume, valid consumes +1', async () => {
    const encOpen1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const encOpen2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const encOpen3 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    await db.exec(`
      INSERT INTO public.localidades (id, nombre, ciudad, zona, activo) VALUES ('palermo', 'Palermo', 'CABA', 'Norte', true) ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.encuentros (id, titulo, host_id, estado, is_open, max_participants, modalidad, locality_id, tipo_invitacion, fecha, hora)
      VALUES
        ('${encOpen1}', 'Encuentro Join 1', '${userHost}', 'activo', true, 10, 'presencial', 'palermo', 'link_general', '2026-10-25', '19:00'),
        ('${encOpen2}', 'Encuentro Join 2', '${userHost}', 'activo', true, 10, 'presencial', 'palermo', 'link_general', '2026-10-25', '19:00'),
        ('${encOpen3}', 'Encuentro Join 3', '${userHost}', 'activo', true, 10, 'presencial', 'palermo', 'link_general', '2026-10-25', '19:00')
      ON CONFLICT (id) DO UPDATE SET is_open = true, estado = 'activo', max_participants = 10;
    `);

    // A. Setup bilateral block between userBlocked and userHost
    await db.exec(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${userHost}', '${userBlocked}')
      ON CONFLICT DO NOTHING;
    `);

    await setSession(userBlocked, false);
    const countBlockedBefore = await getBucketCount('join_open_encounter', userBlocked);

    // Blocked user tries to join -> rejected with encuentro_not_open without consuming
    const rBlocked = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${encOpen1}', 'User Blocked') AS result;`);
    assert.equal((rBlocked.rows[0] as any).result.ok, false);
    assert.equal((rBlocked.rows[0] as any).result.error, 'encuentro_not_open');

    const countBlockedAfter = await getBucketCount('join_open_encounter', userBlocked);
    assert.equal(countBlockedAfter, countBlockedBefore, 'Blocked attempt MUST NOT consume rate limit');

    // B. Applicant B makes valid request to encOpen1 -> consumes +1
    await setSession(userApplicantB, false);
    const countB0 = await getBucketCount('join_open_encounter', userApplicantB);

    const rJoin1 = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${encOpen1}', 'Applicant B') AS result;`);
    assert.equal((rJoin1.rows[0] as any).result.ok, true);
    const req1Id = (rJoin1.rows[0] as any).result.request_id;
    assert.ok(req1Id);

    const countB1 = await getBucketCount('join_open_encounter', userApplicantB);
    assert.equal(countB1, countB0 + 1, 'Valid join request MUST consume +1');

    // C. Duplicate pending request -> duplicate_pending_request without consuming
    const rDup = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${encOpen1}', 'Applicant B') AS result;`);
    assert.equal((rDup.rows[0] as any).result.ok, false);
    assert.equal((rDup.rows[0] as any).result.error, 'duplicate_pending_request');

    const countBDup = await getBucketCount('join_open_encounter', userApplicantB);
    assert.equal(countBDup, countB1, 'Duplicate pending request MUST NOT consume rate limit');

    // D. Host rejects request 1
    await setSession(userHost, false);
    const rRej = await db.query(`SELECT public.rechazar_solicitud_encuentro_abierto('${req1Id}'::uuid, '${userHost}'::uuid) AS result;`);
    assert.equal((rRej.rows[0] as any).result.ok, true);

    // E. Applicant B tries to join encOpen1 during cooldown (< 6h) -> rejected without consuming
    await setSession(userApplicantB, false);
    const rCooldown = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${encOpen1}', 'Applicant B') AS result;`);
    assert.equal((rCooldown.rows[0] as any).result.ok, false);
    assert.equal((rCooldown.rows[0] as any).result.error, 'request_not_available');

    const countBCooldown = await getBucketCount('join_open_encounter', userApplicantB);
    assert.equal(countBCooldown, countB1, 'Cooldown-rejected attempt MUST NOT consume rate limit');

    // F. Applicant B joins a DIFFERENT encounter (encOpen2) -> succeeds and consumes +1
    const rJoin2 = await db.query(`SELECT public.solicitar_sumarse_encuentro_abierto('${encOpen2}', 'Applicant B') AS result;`);
    assert.equal((rJoin2.rows[0] as any).result.ok, true);

    const countB2 = await getBucketCount('join_open_encounter', userApplicantB);
    assert.equal(countB2, countB1 + 1, 'Joining different open encounter MUST consume +1');
  });

  test('6. COOLDOWN LEGACY TOLERANCE: resolved_at NULL falls back to updated_at and created_at without backfill', async () => {
    const encLegacyId = 'cccccccc-3333-cccc-cccc-cccccccccccc';
    await db.exec(`
      INSERT INTO public.encuentros (id, titulo, host_id, estado, is_open, max_participants, modalidad, locality_id, tipo_invitacion, fecha, hora)
      VALUES ('${encLegacyId}', 'Encuentro Legacy', '${userHost}', 'activo', true, 10, 'presencial', 'palermo', 'link_general', '2026-10-25', '19:00')
      ON CONFLICT (id) DO NOTHING;
    `);

    await setSession(userApplicantA, false);

    // Rejected with resolved_at NULL, updated_at 2 hours ago -> active cooldown
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

    // Legacy row older than 6 hours (e.g. 10 hours ago) -> cooldown expired
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
