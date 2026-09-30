/**
 * Staging Smoke QA — Fase 2.0-C1 (T5-B1): Generic Server-Side Rate Limiter Core
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 *
 * Verifies live in Staging:
 * 1. Confirmar existencia de tablas rate_limit_policies y rate_limit_buckets con RLS y PRIVACIDAD.
 * 2. Cuentas QA: permanente y anonymous (confirmar auth.uid() válido en ambas).
 * 3. Ejecución controlada del limiter para usuario permanente.
 * 4. Ejecución controlada del limiter para usuario anonymous.
 * 5. Verificación de enforcement de límite (max_requests alcanzado -> rate_limit_exceeded).
 * 6. Verificación de privacidad: anon/authenticated no pueden leer tablas ni llamar funciones internas.
 * 7. Cleanup completo en Staging.
 */

import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
assertStagingEnvironment(url);

const secretKey = getStagingSecretKey();
const publishableKey = getStagingPublishableKey();

const admin = createClient(url, secretKey, { auth: { persistSession: false } });

async function runStagingSmokeT5B1() {
  console.log('========================================================');
  console.log('STAGING SMOKE T5-B1: GENERIC SERVER-SIDE RATE LIMITING');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  let permUserId: string | null = null;
  let anonUserId: string | null = null;
  const timestamp = Date.now();
  const testAction = `qa_test_action_${timestamp}`;

  try {
    // ----------------------------------------------------
    // 1. Confirmar políticas P0 iniciales en Staging
    // ----------------------------------------------------
    console.log('[1/7] Verificando políticas P0 en rate_limit_policies (via admin)...');
    const { data: policies, error: pErr } = await admin
      .from('rate_limit_policies')
      .select('action, max_requests, window_seconds, enabled')
      .order('action', { ascending: true });

    if (pErr || !policies) {
      throw new Error(`Error consultando rate_limit_policies en Staging: ${pErr?.message}`);
    }

    const actions = policies.map((p) => p.action);
    console.log(`  Políticas encontradas: ${actions.join(', ')}`);
    assert.ok(actions.includes('create_encounter'), 'Falta create_encounter');
    assert.ok(actions.includes('create_intention'), 'Falta create_intention');
    assert.ok(actions.includes('join_open_encounter'), 'Falta join_open_encounter');
    assert.ok(actions.includes('join_open_encounter_same_target'), 'Falta join_open_encounter_same_target');

    // ----------------------------------------------------
    // 2. Crear cuenta Permanente QA
    // ----------------------------------------------------
    console.log('\n[2/7] Creando usuario permanente QA...');
    const email = `qa-t5b1-perm-${timestamp}@puntoencuentro.test`;
    const password = 'QaPassword123!Safe';

    const { data: createPerm, error: createPermErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'QA Permanent RateLimit Test' },
    });

    if (createPermErr || !createPerm.user) {
      throw new Error(`Fallo al crear usuario permanente QA: ${createPermErr?.message}`);
    }

    permUserId = createPerm.user.id;
    console.log(`  Usuario permanente creado: ${permUserId} (is_anonymous=${createPerm.user.is_anonymous})`);
    assert.ok(permUserId, 'permUserId debe ser válido');
    assert.equal(createPerm.user.is_anonymous, false);

    // Iniciar sesión permanente
    const permClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: permAuth, error: permAuthErr } = await permClient.auth.signInWithPassword({ email, password });
    if (permAuthErr || !permAuth.user) {
      throw new Error(`Fallo login usuario permanente: ${permAuthErr?.message}`);
    }
    assert.equal(permAuth.user.id, permUserId);

    // ----------------------------------------------------
    // 3. Crear cuenta Anónima QA
    // ----------------------------------------------------
    console.log('\n[3/7] Creando sesión anónima QA...');
    const anonClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: anonAuth, error: anonAuthErr } = await anonClient.auth.signInAnonymously();

    if (anonAuthErr || !anonAuth.user) {
      throw new Error(`Fallo login anónimo QA: ${anonAuthErr?.message}`);
    }

    anonUserId = anonAuth.user.id;
    console.log(`  Usuario anónimo creado: ${anonUserId} (is_anonymous=${anonAuth.user.is_anonymous})`);
    assert.ok(anonUserId, 'anonUserId debe ser válido');
    assert.equal(anonAuth.user.is_anonymous, true);

    // ----------------------------------------------------
    // 4. Crear política de prueba y evaluar usuario permanente
    // ----------------------------------------------------
    console.log('\n[4/7] Evaluando limiter para Usuario Permanente...');
    const { error: insErr } = await admin.from('rate_limit_policies').insert({
      action: testAction,
      max_requests: 2,
      window_seconds: 3600,
      enabled: true,
    });
    if (insErr) {
      throw new Error(`Error creando política temporal de QA: ${insErr.message}`);
    }

    // Request 1 Permanente
    const { data: r1Perm, error: r1Err } = await admin.rpc('check_rate_limit_admin_inspect', {
      p_user_id: permUserId,
      p_action: testAction,
    });
    if (r1Err) throw new Error(`check_rate_limit_admin_inspect r1 falló: ${r1Err.message}`);
    assert.equal(r1Perm?.allowed, true, 'Request 1 permanente debe ser allowed');
    console.log('  Request 1 (Permanente): allowed = true');

    // Verificar bucket en DB
    const { data: b1Perm, error: b1Err } = await admin
      .from('rate_limit_buckets')
      .select('request_count')
      .eq('action', testAction)
      .eq('user_id', permUserId)
      .single();
    if (b1Err) throw new Error(`Error leyendo bucket permanente: ${b1Err.message}`);
    assert.equal(b1Perm.request_count, 1, 'Bucket count permanente debe ser exactamente 1 (NO 2)');
    console.log('  Bucket count verificado en DB: 1');

    // Request 2 Permanente
    const { data: r2Perm } = await admin.rpc('check_rate_limit_admin_inspect', {
      p_user_id: permUserId,
      p_action: testAction,
    });
    assert.equal(r2Perm?.allowed, true, 'Request 2 permanente debe ser allowed');
    console.log('  Request 2 (Permanente): allowed = true');

    // Request 3 Permanente (Límite 2 excedido)
    const { data: r3Perm } = await admin.rpc('check_rate_limit_admin_inspect', {
      p_user_id: permUserId,
      p_action: testAction,
    });
    assert.equal(r3Perm?.allowed, false, 'Request 3 permanente debe ser rechazado');
    assert.equal(r3Perm?.error, 'rate_limit_exceeded');
    console.log('  Request 3 (Permanente): allowed = false, error = rate_limit_exceeded (CORRECTO)');

    // ----------------------------------------------------
    // 5. Evaluar limiter para Usuario Anónimo
    // ----------------------------------------------------
    console.log('\n[5/7] Evaluando limiter para Usuario Anónimo (independiente de permanente)...');
    // Request 1 Anónimo
    const { data: r1Anon, error: r1AnonErr } = await admin.rpc('check_rate_limit_admin_inspect', {
      p_user_id: anonUserId,
      p_action: testAction,
    });
    if (r1AnonErr) throw new Error(`check_rate_limit_admin_inspect anon r1 falló: ${r1AnonErr.message}`);
    assert.equal(r1Anon?.allowed, true, 'Request 1 anónimo debe ser allowed (independiente de permanente)');
    console.log('  Request 1 (Anónimo): allowed = true');

    // Verificar bucket anónimo en DB
    const { data: b1Anon, error: b1AnonErr } = await admin
      .from('rate_limit_buckets')
      .select('request_count')
      .eq('action', testAction)
      .eq('user_id', anonUserId)
      .single();
    if (b1AnonErr) throw new Error(`Error leyendo bucket anónimo: ${b1AnonErr.message}`);
    assert.equal(b1Anon.request_count, 1, 'Bucket count anónimo debe ser exactamente 1');
    console.log('  Bucket anónimo verificado en DB: 1');

    // Request 2 Anónimo
    const { data: r2Anon } = await admin.rpc('check_rate_limit_admin_inspect', {
      p_user_id: anonUserId,
      p_action: testAction,
    });
    assert.equal(r2Anon?.allowed, true, 'Request 2 anónimo debe ser allowed');
    console.log('  Request 2 (Anónimo): allowed = true');

    // Request 3 Anónimo (Límite 2 excedido)
    const { data: r3Anon } = await admin.rpc('check_rate_limit_admin_inspect', {
      p_user_id: anonUserId,
      p_action: testAction,
    });
    assert.equal(r3Anon?.allowed, false, 'Request 3 anónimo debe ser rechazado');
    assert.equal(r3Anon?.error, 'rate_limit_exceeded');
    console.log('  Request 3 (Anónimo): allowed = false, error = rate_limit_exceeded (CORRECTO)');

    // ----------------------------------------------------
    // 6. Verificación de Seguridad y Privacidad
    // ----------------------------------------------------
    console.log('\n[6/7] Verificando bloqueo de acceso directo por RLS / Privilegios...');

    // A. Cliente authenticated intenta leer rate_limit_policies
    const { data: polData, error: polErr } = await permClient.from('rate_limit_policies').select('*');
    assert.ok(polErr !== null || (polData && polData.length === 0), 'Cliente no debe poder leer rate_limit_policies');
    console.log('  RLS: lectura directa de rate_limit_policies bloqueada a cliente authenticated.');

    // B. Cliente authenticated intenta leer rate_limit_buckets
    const { data: bckData, error: bckErr } = await permClient.from('rate_limit_buckets').select('*');
    assert.ok(bckErr !== null || (bckData && bckData.length === 0), 'Cliente no debe poder leer rate_limit_buckets');
    console.log('  RLS: lectura directa de rate_limit_buckets bloqueada a cliente authenticated.');

    // C. Cliente authenticated intenta ejecutar check_rate_limit_internal
    const { error: rpcDirectErr } = await permClient.rpc('check_rate_limit_internal', {
      p_action: 'create_encounter',
    });
    assert.ok(rpcDirectErr !== null, 'Cliente no debe poder ejecutar check_rate_limit_internal directamente');
    console.log(`  RPC: check_rate_limit_internal bloqueada directamente (${rpcDirectErr?.message}).`);

    // D. Cliente authenticated intenta ejecutar check_rate_limit_admin_inspect
    const { error: rpcAdminErr } = await permClient.rpc('check_rate_limit_admin_inspect', {
      p_user_id: permUserId,
      p_action: 'create_encounter',
    });
    assert.ok(rpcAdminErr !== null, 'Cliente no debe poder ejecutar check_rate_limit_admin_inspect');
    console.log(`  RPC: check_rate_limit_admin_inspect bloqueada a clientes (${rpcAdminErr?.message}).`);

    console.log('\n========================================================');
    console.log('STAGING SMOKE T5-B1 COMPLETADO EXITOSAMENTE');
    console.log('========================================================\n');
  } finally {
    // ----------------------------------------------------
    // 7. Cleanup en Staging
    // ----------------------------------------------------
    console.log('[7/7] Limpiando datos QA en Staging...');
    if (testAction) {
      await admin.from('rate_limit_policies').delete().eq('action', testAction);
    }
    if (permUserId) {
      await admin.auth.admin.deleteUser(permUserId);
      console.log(`  Usuario permanente QA eliminado: ${permUserId}`);
    }
    if (anonUserId) {
      await admin.auth.admin.deleteUser(anonUserId);
      console.log(`  Usuario anónimo QA eliminado: ${anonUserId}`);
    }
    console.log('Cleanup finalizado.');
  }
}

runStagingSmokeT5B1().catch((err) => {
  console.error('\n❌ STAGING SMOKE T5-B1 FALLÓ:', err);
  process.exit(1);
});
