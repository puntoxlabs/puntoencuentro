import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  getStagingSecretKey,
  getStagingPublishableKey,
} from './lib/environment-guard.ts';
import { checkQAAuthorization, QA_AUTH_TIMEOUT_MS } from '../src/services/qaAdminService.ts';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
assertStagingEnvironment(url);

const admin = createClient(url, getStagingSecretKey(), { auth: { persistSession: false } });
const publishableKey = getStagingPublishableKey();

async function main() {
  console.log('====================================================');
  console.log('STAGING SMOKE TEST: QA AUTHORIZATION & GATE CLOSURE');
  console.log('====================================================\n');

  const ts = Date.now();
  const testUserEmail = `staging-qa-gate-${ts}@test.com`;
  const password = 'Password123!QASmokeSafe';
  let testUserId = '';

  try {
    // 1. Estado actual de qa_authorized_users en Staging
    console.log('1. Auditando tabla qa_authorized_users en Staging...');
    const { data: currentQAUsers, error: errQAUsers } = await admin
      .from('qa_authorized_users')
      .select('user_id, role, created_at');
    assert.ifError(errQAUsers);
    console.log(`   Usuarios autorizados existentes en Staging: ${currentQAUsers?.length || 0}`);
    if (currentQAUsers && currentQAUsers.length > 0) {
      console.log('   Roles encontrados:', currentQAUsers.map(u => ({ role: u.role, user_id: u.user_id })));
    } else {
      console.log('   (qa_authorized_users se encuentra actualmente vacía en Staging)');
    }

    // 2. Comprobación como Anónimo
    console.log('\n2. Verificando is_qa_authorized() como usuario Anónimo...');
    const anonClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: anonResult, error: anonErr } = await anonClient.rpc('is_qa_authorized');
    console.log(`   Resultado RPC anónimo: ${anonResult}, Error: ${anonErr?.message || 'ninguno'}`);
    assert.equal(anonResult, false, 'Usuario anónimo debe recibir is_qa_authorized = false');

    // 3. Crear usuario autenticado normal (NO autorizado)
    console.log('\n3. Creando usuario autenticado estándar (no en qa_authorized_users)...');
    const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
      email: testUserEmail,
      password,
      email_confirm: true,
    });
    assert.ifError(authErr);
    testUserId = authUser.user!.id;
    console.log(`   Usuario creado con UID: ${testUserId}`);

    const userClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { error: signInErr } = await userClient.auth.signInWithPassword({
      email: testUserEmail,
      password,
    });
    assert.ifError(signInErr);

    const { data: normalResult, error: normalErr } = await userClient.rpc('is_qa_authorized');
    console.log(`   Resultado RPC usuario normal: ${normalResult}, Error: ${normalErr?.message || 'ninguno'}`);
    assert.equal(normalResult, false, 'Usuario autenticado sin rol QA debe recibir false');

    // 4. Autorizar temporalmente al usuario con rol 'qa'
    console.log('\n4. Vinculando temporalmente al usuario en qa_authorized_users con rol "qa"...');
    const { error: insertErr } = await admin
      .from('qa_authorized_users')
      .insert({ user_id: testUserId, role: 'qa' });
    assert.ifError(insertErr);

    const { data: authResult, error: authUserErr } = await userClient.rpc('is_qa_authorized');
    console.log(`   Resultado RPC usuario autorizado (rol qa): ${authResult}, Error: ${authUserErr?.message || 'ninguno'}`);
    assert.equal(authResult, true, 'Usuario en qa_authorized_users debe recibir true');

    // 5. Probar rol 'admin'
    console.log('\n5. Actualizando a rol "admin"...');
    await admin.from('qa_authorized_users').update({ role: 'admin' }).eq('user_id', testUserId);
    const { data: adminResult } = await userClient.rpc('is_qa_authorized');
    console.log(`   Resultado RPC usuario autorizado (rol admin): ${adminResult}`);
    assert.equal(adminResult, true, 'Usuario en qa_authorized_users con rol admin debe recibir true');

    // 6. Timeout defensivo
    console.log('\n6. Verificando timeout defensivo de checkQAAuthorization...');
    let timedOut = false;
    try {
      // 10ms garantizan que un timeout defensivo rechaza limpiamente
      await checkQAAuthorization(10);
    } catch (err: any) {
      if (err?.message === 'qa_auth_timeout') {
        timedOut = true;
      }
    }
    console.log(`   Timeout defensivo disparado correctamente: ${timedOut}`);
    assert.equal(timedOut, true, 'Timeout defensivo debe rechazar con qa_auth_timeout');

    console.log('\n====================================================');
    console.log('TODAS LAS COMPUERTAS DE QA GATE & AUTORIZACIÓN: PASS');
    console.log('====================================================\n');
  } finally {
    console.log('Limpiando usuario de prueba en Staging...');
    if (testUserId) {
      await admin.from('qa_authorized_users').delete().eq('user_id', testUserId);
      await admin.auth.admin.deleteUser(testUserId);
    }
    console.log('Limpieza completada.');
  }
}

main().catch((err) => {
  console.error('ERROR EN SMOKE TEST QA:', err);
  process.exit(1);
});
