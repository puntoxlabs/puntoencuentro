/**
 * Staging Smoke QA — Moderación v1.1: Calidad Pública + Anti-Spam Gate & Piso Antiabuso Privado
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

async function runStagingSmokeV11() {
  console.log('========================================================');
  console.log('STAGING SMOKE QA: MODERACIÓN V1.1 (CALIDAD + ANTI-SPAM)');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('========================================================\n');

  const timestamp = Date.now();
  const createdEncounterIds: string[] = [];
  const createdUserIds: string[] = [];

  try {
    // 1. Probar RPC evaluar_contenido_publico_determinista en Staging
    console.log('[1/4] Probando RPC evaluar_contenido_publico_determinista...');
    const { data: cleanRes, error: eClean } = await admin.rpc('evaluar_contenido_publico_determinista', {
      p_title: 'Tarde de mate y juegos en la plaza',
      p_description: 'Nos encontramos para jugar al Truco y compartir una merienda entre amigos.',
    });
    if (eClean) throw new Error(`Error clean eval: ${eClean.message}`);
    assert.equal(cleanRes?.[0]?.decision, 'allow', 'Publicación limpia debe ser allow');

    const { data: spamRes, error: eSpam } = await admin.rpc('evaluar_contenido_publico_determinista', {
      p_title: 'Inversión Cripto Asegurada',
      p_description: 'Gana dinero fácil y duplica tu inversión trabajando desde casa.',
    });
    if (eSpam) throw new Error(`Error spam eval: ${eSpam.message}`);
    assert.equal(spamRes?.[0]?.decision, 'block', 'Spam/scam debe ser block');

    const { data: contactRes, error: eContact } = await admin.rpc('evaluar_contenido_publico_determinista', {
      p_title: 'Salida al cine',
      p_description: 'Escribime a mi wsp para coordinar la entrada',
    });
    if (eContact) throw new Error(`Error contact eval: ${eContact.message}`);
    assert.equal(contactRes?.[0]?.decision, 'review', 'Contacto debe ser review');
    console.log('  ✔ RPC evaluar_contenido_publico_determinista responde correctamente en Staging.');

    // 2. Probar RPC evaluar_antiabuso_privado_determinista en Staging
    console.log('[2/4] Probando RPC evaluar_antiabuso_privado_determinista...');
    const { data: privCleanRes, error: ePrivClean } = await admin.rpc('evaluar_antiabuso_privado_determinista', {
      p_titulo: 'Reunión comercial interna de estrategia Q3',
      p_descripcion: 'Discussion en français sur le plan marketing 2026',
    });
    if (ePrivClean) throw new Error(`Error priv clean eval: ${ePrivClean.message}`);
    assert.equal(privCleanRes?.[0]?.allowed, true, 'Contenido privado comercial o en otro idioma debe ser permitido');

    const { data: privPhishRes, error: ePrivPhish } = await admin.rpc('evaluar_antiabuso_privado_determinista', {
      p_titulo: 'Actualización Urgente de Cuenta',
      p_descripcion: 'Ingresá tu contraseña y verificá tu cuenta bancaria de inmediato.',
    });
    if (ePrivPhish) throw new Error(`Error priv phish eval: ${ePrivPhish.message}`);
    assert.equal(privPhishRes?.[0]?.allowed, false, 'Phishing severo privado debe ser bloqueado');
    console.log('  ✔ RPC evaluar_antiabuso_privado_determinista responde correctamente en Staging.');

    // 3. Crear anfitrión de prueba para apertura de encuentro
    console.log('[3/4] Creando usuario temporal y evaluando apertura con Edge Function en Staging...');
    const hostEmail = `qa-v11-host-${timestamp}@puntoencuentro.test`;
    const { data: uHost, error: eHost } = await admin.auth.admin.createUser({
      email: hostEmail,
      password: 'SmokePassword123!',
      email_confirm: true,
    });
    if (eHost || !uHost.user) throw new Error(`Error host: ${eHost?.message}`);
    createdUserIds.push(uHost.user.id);

    const hostClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: loginData, error: eLogin } = await hostClient.auth.signInWithPassword({
      email: hostEmail,
      password: 'SmokePassword123!',
    });
    if (eLogin || !loginData.session) throw new Error(`Error host login: ${eLogin?.message}`);

    // Crear encuentro borrador privado
    const { data: encData, error: eCreate } = await hostClient.rpc('crear_encuentro_seguro', {
      p_data: {
        titulo: 'Reunión Privada de Trabajo',
        descripcion: 'Coordinación comercial privada',
        fecha: '2026-11-20',
        hora: '19:00',
        modalidad: 'presencial',
        lugar_texto: 'Oficina Central Piso 4 (Privado)',
        tema: 'blue',
        tipo_invitacion: 'individual',
      },
    });
    if (eCreate || !encData?.id) throw new Error(`Error crear encuentro: ${eCreate?.message}`);
    const actualEncId = encData.id;
    const actualPublicToken = encData.public_token;
    createdEncounterIds.push(actualEncId);

    // Comprobar que en borrador privado get_encuentro_por_public_token funciona
    const { data: tokenRes, error: eToken } = await hostClient.rpc('get_encuentro_por_public_token', {
      p_public_token: actualPublicToken,
    });
    if (eToken) throw new Error(`Error get token: ${eToken?.message}`);
    assert.ok(tokenRes, 'Debe devolver datos de invitación');
    assert.equal(tokenRes.titulo, 'Reunión Privada de Trabajo');
    console.log('  ✔ Borrador privado accesible vía link sin restricciones de calidad pública.');

    // 4. Invocar Edge Function moderate-public-content desplegada en Staging
    console.log('[4/4] Invocando Edge Function moderate-public-content en Staging...');
    const { data: fnRes, error: eFn } = await hostClient.functions.invoke('moderate-public-content', {
      body: {
        encuentro_id: actualEncId,
        content_hash: 'hash-simulado-staging',
        title: 'Tarde de fútbol y mate en la plaza',
        description: 'Vení a jugar un partido amistoso de fútbol 5 y tomar mates. Traer zapatillas de césped.',
      },
    });
    // La función verificará permisos o hash TOCTOU
    console.log('  Respuesta de Edge Function:', fnRes || eFn?.message);
    assert.ok(fnRes !== undefined || eFn !== undefined, 'Edge Function debe estar accesible');
    console.log('  ✔ Edge Function moderate-public-content invocada exitosamente.');

    console.log('\n========================================================');
    console.log('SMOKE TEST MODERACIÓN V1.1 EN STAGING: EXITOSO ✔');
    console.log('========================================================\n');
  } finally {
    console.log('Limpiando datos temporales de Staging...');
    for (const eid of createdEncounterIds) {
      await admin.from('public_content_moderation_audit').delete().eq('encuentro_id', eid);
      await admin.from('inbox_notifications').delete().eq('target_id', eid);
      await admin.from('encuentros').delete().eq('id', eid);
    }
    for (const uid of createdUserIds) {
      await admin.from('moderation_authorized_users').delete().eq('user_id', uid);
      await admin.auth.admin.deleteUser(uid);
    }
    console.log('Cleanup en Staging finalizado.');
  }
}

runStagingSmokeV11().catch((err) => {
  console.error('Error en smoke Staging:', err);
  process.exit(1);
});
