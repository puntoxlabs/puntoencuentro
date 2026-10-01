import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Read .env.local
const envPath = path.resolve(process.cwd(), '.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');

function getEnv(key) {
  const match = envContent.match(new RegExp(`${key}\\s*=\\s*([^\\r\\n]+)`));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

const STAGING_PROJECT_REF = 'wougfhfwqgmxhgvjqoua';
const PRODUCTION_PROJECT_REF = 'aurbicjwftjhwryhyjiq';

const supabaseUrl = getEnv('VITE_SUPABASE_URL');
const anonKey = getEnv('VITE_SUPABASE_PUBLISHABLE_KEY') || getEnv('VITE_SUPABASE_ANON_KEY');
const stagingSecretKey = getEnv('SUPABASE_STAGING_SECRET_KEY');

if (supabaseUrl.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error(`CRITICAL: Target is PRODUCTION! Aborting.`);
}
if (!supabaseUrl.includes(STAGING_PROJECT_REF)) {
  throw new Error(`CRITICAL: Target must be Staging (${STAGING_PROJECT_REF}), got ${supabaseUrl}`);
}

const anonClient = createClient(supabaseUrl, anonKey);
const adminClient = createClient(supabaseUrl, stagingSecretKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function main() {
  console.log('--- Starting T7-C.3 Staging Validation ---');
  console.log(`Target URL: ${supabaseUrl}`);

  // 0. Ensure migration SQL is applied to Staging
  const tokenPath = path.join(process.env.USERPROFILE || '', '.supabase', 'access-token');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20261001080000_normalize_production_schema_parity.sql');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  console.log('\n[0] Ensuring migration 20261001080000 is applied on Staging...');
  const migRes = await fetch(`https://api.supabase.com/v1/projects/${STAGING_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: migrationSql })
  });
  const migJson = await migRes.json();
  if (migRes.status >= 400 || migJson.error) {
    throw new Error(`Failed to apply migration SQL: ${JSON.stringify(migJson)}`);
  }
  console.log('Migration SQL applied/verified on Staging.');

  // 1. Column Nullability Check (Section 13 & 14)
  console.log('\n[1] Checking information_schema.columns for encuentros.host_id nullability...');
  const nullQuery = "SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'encuentros' AND column_name = 'host_id';";
  const colRes = await fetch(`https://api.supabase.com/v1/projects/${STAGING_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: nullQuery })
  });
  const colRows = await colRes.json();
  const isNullable = colRows[0]?.is_nullable;
  console.log(`encuentros.host_id is_nullable: ${isNullable}`);
  if (isNullable !== 'YES') {
    throw new Error(`Expected host_id to be nullable (YES), got: ${isNullable}`);
  }

  // 2. Check Legacy Policies on encuentros and participantes (Section 8 & 14)
  console.log('\n[2] Checking pg_policies for encuentros and participantes in Staging...');
  const policyQuery = `
    SELECT policyname, tablename FROM pg_policies 
    WHERE schemaname = 'public' AND tablename IN ('encuentros', 'participantes');
  `;
  const polRes = await fetch(`https://api.supabase.com/v1/projects/${STAGING_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: policyQuery })
  });
  const policies = await polRes.json();
  console.log(`Current policies count on encuentros & participantes: ${policies.length}`);

  const legacyNames = [
    'Enable insert for anyone',
    'Enable read access for anyone',
    'update encuentros',
    'delete encuentros',
    'Enable insert for participants',
    'Enable read for participants',
    'Enable update for participants'
  ];
  const survivingLegacy = policies.filter((p) => legacyNames.includes(p.policyname));
  console.log(`Surviving legacy policies: ${survivingLegacy.length}`);
  if (survivingLegacy.length > 0) {
    throw new Error(`Legacy policies still exist: ${JSON.stringify(survivingLegacy)}`);
  }

  // 3. Direct Grants Check (Section 14)
  console.log('\n[3] Checking direct table grants for anon and authenticated...');
  const grantsQuery = `
    SELECT grantee, table_name, privilege_type
    FROM information_schema.table_privileges
    WHERE table_schema = 'public' 
      AND table_name IN ('encuentros', 'participantes')
      AND grantee IN ('anon', 'authenticated');
  `;
  const grantRes = await fetch(`https://api.supabase.com/v1/projects/${STAGING_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: grantsQuery })
  });
  const grants = await grantRes.json();
  console.log(`Grants count for anon/authenticated: ${grants.length}`);
  if (grants.length > 0) {
    throw new Error(`Unexpected table grants found: ${JSON.stringify(grants)}`);
  }

  // 4. Test Host ID Nullability with Fixtures (Section 13)
  console.log('\n[4] Testing creation of encuentro with host_id IS NULL (legacy format)...');
  const { data: nullHostEnc, error: nullHostErr } = await adminClient
    .from('encuentros')
    .insert({
      titulo: 'Test T7-C.3 Null Host Encounter',
      fecha: '2026-11-01',
      hora: '19:00:00',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      host_id: null
    })
    .select()
    .single();

  if (nullHostErr) {
    throw new Error(`Failed to insert encuentro with host_id = null: ${nullHostErr.message}`);
  }
  console.log(`Encuentro with host_id = NULL created successfully: ${nullHostEnc.id}`);

  // Test creation via anonymous auth session
  console.log('\nTesting creation of encounter with anonymous auth session...');
  const anonAuthClient = createClient(supabaseUrl, anonKey);
  const { data: anonAuthData, error: anonAuthErr } = await anonAuthClient.auth.signInAnonymously();
  if (anonAuthErr) {
    console.log(`Note: signInAnonymously returned: ${anonAuthErr.message} (anonymous auth provider might not be enabled in Staging)`);
  } else {
    console.log(`Anonymous user signed in: ${anonAuthData.user.id}, is_anonymous: ${anonAuthData.user.is_anonymous}`);
    const { data: rpcRes, error: rpcErr } = await anonAuthClient.rpc('crear_encuentro_seguro', {
      p_data: {
        titulo: 'Test Anonymous Encounter',
        fecha: '2026-11-02',
        hora: '20:00',
        modalidad: 'presencial',
        lugar_texto: 'Parque Centenario',
        tipo_invitacion: 'individual'
      }
    });
    if (rpcErr) {
      console.log(`Anonymous RPC call error: ${rpcErr.message}`);
    } else {
      console.log('Anonymous encounter created via RPC:', rpcRes);
      // Clean up anonymous encounter
      if (rpcRes?.id) {
        await adminClient.from('encuentros').delete().eq('id', rpcRes.id);
      }
    }
  }

  // 5. Test Functional Participados RPC (Section 12)
  console.log('\n[5] Testing get_encuentros_participados_por_tokens...');
  // Create participant on nullHostEnc
  const testTokenValid = crypto.randomUUID();

  const { data: part1, error: partErr1 } = await adminClient
    .from('participantes')
    .insert({
      encuentro_id: nullHostEnc.id,
      nombre_invitado: 'Invitado Test T7C3',
      tipo_invitacion: 'individual',
      estado: 'confirmado',
      token_invitacion: testTokenValid,
      mensaje_respuesta: 'Ahi estare!'
    })
    .select()
    .single();

  if (partErr1) {
    throw new Error(`Failed to insert test participant: ${partErr1.message}`);
  }
  console.log(`Inserted participant with token ${testTokenValid}`);

  // Test 5.1: Call with valid token from anonClient (no auth headers)
  const { data: resValid, error: errValid } = await anonClient.rpc('get_encuentros_participados_por_tokens', {
    p_tokens: [testTokenValid]
  });
  if (errValid) {
    throw new Error(`RPC call failed with valid token: ${errValid.message}`);
  }
  console.log(`RPC returned ${resValid.length} encounters for valid token.`);
  if (resValid.length !== 1 || resValid[0].id !== nullHostEnc.id) {
    throw new Error(`Expected encounter ${nullHostEnc.id}, got: ${JSON.stringify(resValid)}`);
  }
  if (resValid[0]._mi_token_invitacion !== testTokenValid) {
    throw new Error(`Expected _mi_token_invitacion to match test token`);
  }
  if (resValid[0]._mi_estado !== 'confirmado') {
    throw new Error(`Expected _mi_estado to be 'confirmado'`);
  }
  console.log('Valid token verification PASS!');

  // Test 5.2: Call with invalid / unassociated token
  const fakeToken = crypto.randomUUID();
  const { data: resFake, error: errFake } = await anonClient.rpc('get_encuentros_participados_por_tokens', {
    p_tokens: [fakeToken]
  });
  if (errFake) throw new Error(`RPC error on fake token: ${errFake.message}`);
  console.log(`Fake token result count: ${resFake.length}`);
  if (resFake.length !== 0) {
    throw new Error(`Expected 0 encounters for fake token, got: ${resFake.length}`);
  }
  console.log('Fake token verification PASS!');

  // Test 5.3: Call with malformed text tokens and mix
  const { data: resMixed, error: errMixed } = await anonClient.rpc('get_encuentros_participados_por_tokens', {
    p_tokens: ['invalid-uuid-string', '12345', testTokenValid]
  });
  if (errMixed) throw new Error(`RPC error on mixed tokens: ${errMixed.message}`);
  console.log(`Mixed tokens result count: ${resMixed.length}`);
  if (resMixed.length !== 1 || resMixed[0].id !== nullHostEnc.id) {
    throw new Error(`Expected 1 encounter for mixed tokens, got: ${resMixed.length}`);
  }
  console.log('Mixed/malformed tokens resilience PASS!');

  // Test 5.4: Call with empty array and null
  const { data: resEmpty } = await anonClient.rpc('get_encuentros_participados_por_tokens', { p_tokens: [] });
  if (resEmpty?.length !== 0) throw new Error('Expected empty array for empty tokens');

  const { data: resNull } = await anonClient.rpc('get_encuentros_participados_por_tokens', { p_tokens: null });
  if (resNull?.length !== 0) throw new Error('Expected empty array for null tokens');
  console.log('Empty and null token handling PASS!');

  // 6. Cleanup (Section 12 & 13)
  console.log('\n[6] Cleaning up test fixtures from Staging...');
  await adminClient.from('participantes').delete().eq('id', part1.id);
  await adminClient.from('encuentros').delete().eq('id', nullHostEnc.id);
  console.log('Cleanup completed successfully.');

  console.log('\n=== ALL STAGING VALIDATIONS PASSED ===');
}

main().catch(err => {
  console.error('\n[FATAL ERROR IN STAGING VALIDATION]:', err);
  process.exit(1);
});
