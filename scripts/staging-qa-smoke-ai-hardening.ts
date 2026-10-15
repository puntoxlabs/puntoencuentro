/**
 * Staging Smoke QA — Hardening Pre-Freeze: AI Input Abuse Gate & Short-Burst Rate Limit
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 */

import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard.ts';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
assertStagingEnvironment(url);

const secretKey = getStagingSecretKey();
const publishableKey = getStagingPublishableKey();

const admin = createClient(url, secretKey, { auth: { persistSession: false } });

async function runStagingSmokeAiHardening() {
  console.log('========================================================');
  console.log('STAGING SMOKE QA: AI INPUT ABUSE GATE & SHORT-BURST RATE LIMIT');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('========================================================\n');

  let testUserId: string | null = null;
  const createdEncounterIds: string[] = [];

  try {
    // 1. Crear usuario permanente temporal de QA
    const email = `qa-ai-hardening-${Date.now()}@puntoencuentro.test`;
    const password = 'QaPassword123!Secure';

    const { data: createData, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'QA Hardening User' },
    });

    if (createErr || !createData.user) {
      throw new Error(`Failed to create QA test user: ${createErr?.message}`);
    }
    testUserId = createData.user.id;
    console.log(`[1/5] Usuario permanente QA creado: ${testUserId}`);

    // Iniciar sesión con publishable key
    const userClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: authData, error: authErr } = await userClient.auth.signInWithPassword({
      email,
      password,
    });
    if (authErr || !authData.session) {
      throw new Error(`Failed to sign in as QA test user: ${authErr?.message}`);
    }
    console.log('[1/5] Sesión permanente iniciada con éxito en Staging.');

    // 2. SMOKE: Payload basura bloqueado pre-LLM (HTTP 400)
    console.log('\n[2/5] Smoke: Enviando payload malicioso <script> a ai-interpret...');
    const { data: trashData, error: trashErr } = await userClient.functions.invoke('ai-interpret', {
      body: {
        message: '<script>alert("xss")</script>',
        sessionId: crypto.randomUUID(),
      },
    });

    assert.ok(trashErr, 'El payload con script debe retornar error');
    let trashJson: any = null;
    try {
      if (typeof (trashErr as any).context?.json === 'function') {
        trashJson = await (trashErr as any).context.json();
      }
    } catch (_) {}
    console.log('  -> Respuesta obtenida:', trashJson || trashErr.message);
    assert.equal(trashJson?.ok, false);
    assert.equal(trashJson?.error, 'malicious_payload');
    assert.equal(trashJson?.message, 'El mensaje contiene caracteres o código no permitidos.');
    console.log('  -> Payload malicioso bloqueado pre-LLM con éxito.');

    // 3. SMOKE: Prompt normal llega a la IA y responde con patch (HTTP 200)
    console.log('\n[3/5] Smoke: Enviando prompt legítimo a ai-interpret...');
    const legitSessionId = crypto.randomUUID();
    const { data: legitData, error: legitErr } = await userClient.functions.invoke('ai-interpret', {
      body: {
        message: 'Pádel este sábado a las 18 en Palermo con 4 amigos',
        sessionId: legitSessionId,
      },
    });

    if (legitErr) {
      console.warn('  -> legitErr context:', (legitErr as any).context);
      throw new Error(`Prompt normal falló: ${legitErr.message}`);
    }
    assert.equal(legitData?.ok, true, 'Prompt normal debe procesarse con éxito');
    assert.ok(legitData?.patch, 'Debe devolver un patch interpretado');
    console.log('  -> Prompt legítimo procesado por IA:', {
      scope: legitData.scope,
      title: legitData.patch?.title,
      location: legitData.patch?.location,
      provider: legitData.provider,
    });

    // 4. SMOKE: Rate limit / short-burst activado (HTTP 429)
    console.log('\n[4/5] Smoke: Probando activación de short burst rate limit con ráfaga...');
    let hitRateLimit = false;
    let rateLimitMessage = '';
    // Disparamos ráfaga rápida
    for (let i = 0; i < 15; i++) {
      const { data, error } = await userClient.functions.invoke('ai-interpret', {
        body: {
          message: `Mensaje de ráfaga número ${i}`,
          sessionId: crypto.randomUUID(),
        },
      });

      if (error) {
        let errBody: any = null;
        try {
          if (typeof (error as any).context?.json === 'function') {
            errBody = await (error as any).context.json();
          }
        } catch (_) {}
        if (errBody?.error === 'rate_limit_exceeded') {
          hitRateLimit = true;
          rateLimitMessage = errBody.message;
          console.log(`  -> Ráfaga bloqueada exitosamente en el intento ${i + 1}: ${errBody.message}`);
          break;
        }
      }
    }
    assert.ok(hitRateLimit, 'La ráfaga de consultas debe activar el límite de burst HTTP 429');
    assert.equal(rateLimitMessage, 'Hubo demasiados intentos en poco tiempo. Probá nuevamente en unos minutos.');

    // 5. SMOKE: Confirmar que la creación anónima normal (manual sin IA) NO se rompe
    console.log('\n[5/5] Smoke: Verificando que creación anónima manual tradicional funciona...');
    const anonClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: anonData, error: anonErr } = await anonClient.auth.signInAnonymously();
    if (anonErr || !anonData.user) {
      throw new Error(`Fallo al autenticar usuario anónimo: ${anonErr?.message}`);
    }
    const anonUserId = anonData.user.id;
    console.log(`  -> Usuario anónimo creado: ${anonUserId}`);

    const { data: encRes, error: encErr } = await anonClient.rpc('crear_encuentro_seguro', {
      p_data: {
        titulo: 'Encuentro Manual Anónimo Smoke',
        fecha: '2026-10-25',
        hora: '19:00',
        modalidad: 'presencial',
        tipo_invitacion: 'link_general',
        host_id: anonUserId,
        post_event_active_minutes: 60,
      },
    });

    if (encErr) {
      throw new Error(`Creación de encuentro anónimo manual falló: ${encErr.message}`);
    }
    const encId = encRes?.encuentro?.id || encRes?.id;
    if (encId) {
      createdEncounterIds.push(encId);
    }
    console.log(`  -> Encuentro anónimo manual creado con éxito: ${encId}`);

    console.log('\n========================================================');
    console.log('✅ STAGING SMOKE QA COMPLETADO CON ÉXITO (4/4 CASOS APROBADOS)');
    console.log('========================================================');
  } finally {
    console.log('\n[Limpieza] Eliminando registros temporales de QA en Staging...');
    for (const encId of createdEncounterIds) {
      await admin.from('encuentros').delete().eq('id', encId);
    }
    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
      console.log(`  -> Usuario permanente QA ${testUserId} eliminado.`);
    }
  }
}

runStagingSmokeAiHardening().catch((err) => {
  console.error('\n❌ ERROR FATAL EN STAGING SMOKE:', err);
  process.exit(1);
});
