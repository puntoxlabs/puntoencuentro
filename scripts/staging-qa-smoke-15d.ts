/**
 * Smoke Test Real en Supabase STAGING: Fase 1.5-D (Entitlements + Metering + AI-Interpret)
 *
 * Proyecto: wougfhfwqgmxhgvjqoua
 * Guard: assertStagingEnvironment()
 */

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

async function runStagingSmoke() {
  console.log('========================================================');
  console.log('STAGING SMOKE 1.5-D: REAL LIVE AI & METERING VALIDATION');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  let testUserId: string | null = null;
  const sessionId = crypto.randomUUID();

  try {
    // 1. Crear usuario permanente temporal de QA
    const email = `qa-smoke-15d-${Date.now()}@puntoencuentro.test`;
    const password = 'QaPassword123!Safe';

    const { data: createData, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'QA Smoke 15D' },
    });

    if (createErr || !createData.user) {
      throw new Error(`Failed to create QA test user: ${createErr?.message}`);
    }
    testUserId = createData.user.id;
    console.log(`[1/5] Usuario permanente QA creado: ${testUserId} (${email})`);

    // 2. Iniciar sesión como usuario permanente con la publishable key
    const userClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: authData, error: authErr } = await userClient.auth.signInWithPassword({
      email,
      password,
    });

    if (authErr || !authData.session) {
      throw new Error(`Failed to login as QA test user: ${authErr?.message}`);
    }
    console.log('[2/5] Sesión iniciada con éxito en Staging.');

    // 3. Invocar Edge Function ai-interpret
    console.log('[3/5] Invocando Edge Function ai-interpret con prompt real...');
    const { data: aiData, error: aiErr } = await userClient.functions.invoke('ai-interpret', {
      body: {
        message: 'Cena con amigos el viernes a las 21 en Palermo',
        sessionId,
      },
    });

    if (aiErr) {
      let errDetails = '';
      try {
        if (typeof (aiErr as any).context?.json === 'function') {
          errDetails = JSON.stringify(await (aiErr as any).context.json());
        } else if (typeof (aiErr as any).context?.text === 'function') {
          errDetails = await (aiErr as any).context.text();
        }
      } catch {}
      throw new Error(`Edge Function failed: ${aiErr.message} | Context: ${errDetails} | Status: ${(aiErr as any).context?.status}`);
    }

    console.log('      AI Response:', {
      ok: aiData?.ok,
      scope: aiData?.scope,
      provider: aiData?.provider,
      model: aiData?.model,
      turns: aiData?.usage,
    });

    if (!aiData?.ok || aiData?.scope !== 'encounter') {
      throw new Error(`Unexpected AI response: ${JSON.stringify(aiData)}`);
    }

    // 4. Verificar ai_creation_sessions & ai_monthly_usage en base de datos
    console.log('[4/5] Verificando estado en tablas ai_creation_sessions y ai_monthly_usage...');
    const { data: sessionRows, error: sErr } = await admin
      .from('ai_creation_sessions')
      .select('*')
      .eq('id', sessionId);

    if (sErr || !sessionRows || sessionRows.length === 0) {
      throw new Error(`Session not found in DB: ${sErr?.message}`);
    }

    const session = sessionRows[0];
    console.log('      ai_creation_sessions:', {
      id: session.id,
      status: session.status,
      turns: session.turns,
      processing_lease_id: session.processing_lease_id,
    });

    if (session.turns !== 1 || session.status !== 'started' || session.processing_lease_id !== null) {
      throw new Error(`Invalid session state: turns=${session.turns}, lease=${session.processing_lease_id}`);
    }

    const { data: usageRows, error: uErr } = await admin
      .from('ai_monthly_usage')
      .select('*')
      .eq('session_id', sessionId);

    if (uErr || !usageRows || usageRows.length === 0) {
      throw new Error(`Usage ledger row not found in DB: ${uErr?.message}`);
    }

    const usage = usageRows[0];
    console.log('      ai_monthly_usage:', {
      session_id: usage.session_id,
      state: usage.state,
      consumed_at: usage.consumed_at,
    });

    if (usage.state !== 'consumed' || !usage.consumed_at) {
      throw new Error(`Invalid usage ledger state: state=${usage.state}`);
    }

    // 5. Verificar RPC get_my_entitlements desde el cliente autenticado
    console.log('[5/5] Verificando RPC get_my_entitlements...');
    const { data: entitlements, error: entErr } = await userClient.rpc('get_my_entitlements');

    if (entErr) {
      throw new Error(`get_my_entitlements RPC error: ${entErr.message}`);
    }

    console.log('      Entitlements:', {
      plan: entitlements.plan,
      is_anonymous: entitlements.is_anonymous,
      consumed: entitlements.usage?.consumed,
      remaining_effective: entitlements.usage?.remaining_effective,
    });

    if (entitlements.usage?.consumed !== 1 || entitlements.usage?.remaining_effective !== 2) {
      throw new Error(`Inconsistent entitlements usage: ${JSON.stringify(entitlements.usage)}`);
    }

    console.log('\n========================================================');
    console.log('SMOKE STAGING EXITOSO: AI, METERING Y ENTITLEMENTS OK');
    console.log('========================================================\n');
  } finally {
    if (testUserId) {
      console.log(`[Cleanup] Eliminando usuario de prueba: ${testUserId}`);
      await admin.auth.admin.deleteUser(testUserId);
      console.log('[Cleanup] Usuario de prueba eliminado.');
    }
  }
}

runStagingSmoke().catch((err) => {
  console.error('\n❌ Smoke Staging falló:', err);
  process.exit(1);
});
