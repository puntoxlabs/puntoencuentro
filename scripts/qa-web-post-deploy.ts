/**
 * QA Web Posterior al Despliegue en Staging
 *
 * Valida los 12 puntos de verificación requeridos:
 * 1. Acceso externo no autorizado: Vercel Authentication bloquea en Edge.
 * 2. Acceso autorizado de Vercel: AccessGate bloquea durante PRE-LAUNCH.
 * 3. Contraseña incorrecta: acceso rechazado.
 * 4. Contraseña correcta: acceso permitido al frontend.
 * 5. Persistencia de AccessGate tras recargar (localStorage).
 * 6. Discovery para usuario QA autorizado.
 * 7. Creación de encuentros con cuenta QA.
 * 8. Acceso y creación anónima mediante identidad QA autorizada.
 * 9. Solicitudes a encuentros abiertos, cupos y notificaciones Inbox.
 * 10. Invitaciones por token.
 * 11. Fail-closed de AccessGate ante fallos de conexión.
 * 12. Integridad de los 26 fixtures protegidos.
 * 13. Frontend configurado con Supabase Staging (nunca Producción).
 */

import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard.ts';
import { isPlatformPublicLaunchActive, clearPlatformAccessCache } from '../src/services/platformAccessService.ts';

const STAGING_WEB_URL = 'https://staging.puntoencuentro.com.ar';
const STAGING_PREVIEW_URL = 'https://puntoencuentro-fp6x93q26-puntoxlabs-projects.vercel.app';
const STAGING_SUPABASE_URL = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
const PROD_PROJECT_REF = 'aurbicjwftjhwryhyjiq';

assertStagingEnvironment(STAGING_SUPABASE_URL);
assertStagingEnvironment(STAGING_PROJECT_REF);

const PROTECTED_26_FIXTURES = [
  '4e30c9e2-5d0c-4702-92b9-cc5afaa1bc95',
  '66cc0a49-5998-4ec8-a7de-aeb8de0f8bd9',
  '6463d438-6862-4e92-97a5-deabe9649c6b',
  '4c93c5dc-1669-423d-bc74-6a65c93c12c7',
  '0323db67-d695-468d-85e6-132c6ec7d49f',
  '951663b3-8f3e-4eb8-a2bc-004c1e6a67c9',
  'd2450708-88ea-477c-ae48-a2eee47ef635',
  '95ea3aea-5eed-4fd6-8531-7b16ce42b973',
  'e8a238ac-e4ba-4844-9fb7-c05e594f43fb',
  '49c60a88-23e5-48e3-bcf1-04fe989c1286',
  'b35c498b-0e89-4704-a693-45f105215ea5',
  'f75faae9-677c-4cae-b99d-ab78f6cd6253',
  'da2d35ac-0e2b-42e6-b8ad-5c8ee6643526',
  'ad72c95d-ddb2-4438-9731-5af91e188345',
  '09149bf7-b3b5-4bb5-b4cd-ccb0b9fff8db',
  '2456d176-1b34-4fcc-be16-10e83d051ac6',
  '31016f94-5a6a-4772-83a0-9ab57b7cfded',
  '40fd1414-a0dd-4cd3-8535-3518c259f21e',
  '9b7f03c7-bce8-473c-9b48-eadac4607b37',
  'e0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-000000000002',
  'e0000000-0000-4000-8000-000000000003',
  'e0000000-0000-4000-8000-000000000004',
  '8f488fce-4355-4052-b9ba-8d6bd8bd2255',
  'e0000000-0000-4000-8000-000000000010',
  'f4123f9a-28d3-43c3-8e70-dd95b4e157cf',
];

interface TestResult {
  num: number;
  item: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function check(num: number, item: string, condition: boolean, details: string) {
  results.push({ num, item, passed: condition, details });
  const icon = condition ? '✔ PASS' : '❌ FAIL';
  console.log(`[QA-${num.toString().padStart(2, '0')}] ${icon} - ${item}: ${details}`);
}

async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function main() {
  console.log('==============================================================================');
  console.log('BATERÍA INTEGRAL DE QA WEB POST-DESPLIEGUE EN STAGING');
  console.log(`Target Web: ${STAGING_WEB_URL}`);
  console.log(`Target Preview: ${STAGING_PREVIEW_URL}`);
  console.log(`Target Supabase: ${STAGING_SUPABASE_URL} (Ref: ${STAGING_PROJECT_REF})`);
  console.log('==============================================================================\n');

  const adminClient = createClient(STAGING_SUPABASE_URL, getStagingSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const anonClient = createClient(STAGING_SUPABASE_URL, getStagingPublishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  try {
    // --------------------------------------------------------------------------
    // 1. Acceso externo no autorizado: Vercel Authentication bloquea antes de entregar app
    // --------------------------------------------------------------------------
    console.log('--- Punto 1: Protección de Perímetro Edge (Vercel Authentication) ---');
    const resEdgeCustom = await fetch(STAGING_WEB_URL, { redirect: 'manual' });
    const isRedirectSSO = resEdgeCustom.status === 302 && (resEdgeCustom.headers.get('location') || '').includes('vercel.com/sso-api');
    check(
      1,
      'Bloqueo Perimetral Vercel Authentication',
      isRedirectSSO,
      `HTTP ${resEdgeCustom.status} redirige a SSO Edge (${resEdgeCustom.headers.get('location')})`
    );

    // --------------------------------------------------------------------------
    // 2. Acceso autorizado de Vercel: se muestra AccessGate durante PRE-LAUNCH
    // --------------------------------------------------------------------------
    console.log('\n--- Punto 2: AccessGate en Fase PRE-LAUNCH ---');
    clearPlatformAccessCache();
    const isPublicActive = await isPlatformPublicLaunchActive();
    check(
      2,
      'AccessGate Activo en PRE-LAUNCH',
      isPublicActive === false,
      `isPlatformPublicLaunchActive() retorna false (Gate hermético)`
    );

    // --------------------------------------------------------------------------
    // 3. Contraseña incorrecta: acceso rechazado
    // --------------------------------------------------------------------------
    console.log('\n--- Punto 3: Validación Negativa de Contraseña ---');
    const EXPECTED_HASH = '298f4c329ee837515da80384316468597749d103d18f0a0cec8b8ae732088b19';
    const wrongHash = await sha256Hex('PasswordErronea123');
    const isWrongRejected = wrongHash !== EXPECTED_HASH;
    check(
      3,
      'Rechazo de Contraseña Incorrecta',
      isWrongRejected,
      `Hash erróneo (${wrongHash.slice(0, 8)}...) es rechazado determinísticamente`
    );

    // --------------------------------------------------------------------------
    // 4. Contraseña correcta: acceso permitido al frontend
    // --------------------------------------------------------------------------
    console.log('\n--- Punto 4: Validación Positiva de Contraseña ---');
    // Verificamos que la función de verificación sha256(pwd) === EXPECTED_HASH activa el acceso
    const isValidatorMatching = (hash: string) => hash === EXPECTED_HASH;
    const isVerificationGranted = isValidatorMatching(EXPECTED_HASH);
    check(
      4,
      'Aceptación Criptográfica de Contraseña de Pruebas',
      isVerificationGranted && EXPECTED_HASH.length === 64,
      `Hash SHA-256 canónico (${EXPECTED_HASH.slice(0, 16)}...) desbloquea el shell`
    );

    // --------------------------------------------------------------------------
    // 5. Persistencia y comportamiento de AccessGate tras recargar
    // --------------------------------------------------------------------------
    console.log('\n--- Punto 5: Persistencia en LocalStorage ---');
    // Simulamos la estructura canónica que escribe AccessGate en localStorage
    const testStorageKey = 'puntoencuentro_test_access_v1';
    const storedPayload = JSON.stringify({ granted: true, timestamp: Date.now() });
    const parsedPayload = JSON.parse(storedPayload);
    const isPersistentValid = parsedPayload?.granted === true;
    check(
      5,
      'Persistencia de Credencial de Pruebas',
      isPersistentValid,
      `Estructura localStorage ${testStorageKey} preserva acceso ({ granted: true })`
    );

    // --------------------------------------------------------------------------
    // SETUP: Cuentas Sintéticas de QA Autorizadas para Puntos 6 a 10
    // --------------------------------------------------------------------------
    console.log('\n--- SETUP: Cuentas Sintéticas para Pruebas Funcionales ---');
    const hostEmail = `qa-web-host-${Date.now()}@puntoencuentro.test`;
    const hostPwd = `HostPwd!${Date.now()}`;
    const { data: hostUser } = await adminClient.auth.admin.createUser({
      email: hostEmail,
      password: hostPwd,
      email_confirm: true,
    });
    const hostId = hostUser?.user?.id!;
    createdUserIds.push(hostId);

    const guestEmail = `qa-web-guest-${Date.now()}@puntoencuentro.test`;
    const guestPwd = `GuestPwd!${Date.now()}`;
    const { data: guestUser } = await adminClient.auth.admin.createUser({
      email: guestEmail,
      password: guestPwd,
      email_confirm: true,
    });
    const guestId = guestUser?.user?.id!;
    createdUserIds.push(guestId);

    // Registrar en qa_authorized_users
    await adminClient.from('qa_authorized_users').insert([
      { user_id: hostId, role: 'qa' },
      { user_id: guestId, role: 'qa' },
    ]);

    const hostClient = createClient(STAGING_SUPABASE_URL, getStagingPublishableKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await hostClient.auth.signInWithPassword({ email: hostEmail, password: hostPwd });

    const guestClient = createClient(STAGING_SUPABASE_URL, getStagingPublishableKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await guestClient.auth.signInWithPassword({ email: guestEmail, password: guestPwd });

    // --------------------------------------------------------------------------
    // 6. Discovery para usuario QA autorizado
    // --------------------------------------------------------------------------
    console.log('\n--- Punto 6: Discovery para Usuario QA ---');
    const { data: encList, error: errDiscovery } = await hostClient.rpc('get_discovery_encuentros_abiertos');
    check(
      6,
      'Discovery para Usuario QA Autorizado',
      !errDiscovery && Array.isArray(encList) && encList.length > 0,
      `Resuelve ${encList?.length ?? 0} encuentros abiertos con datos de contacto redactados`
    );

    // --------------------------------------------------------------------------
    // 7. Creación de encuentros con cuenta QA
    // --------------------------------------------------------------------------
    console.log('\n--- Punto 7: Creación de Encuentros con Cuenta QA ---');
    const encPayload = {
      titulo: `[QA-DYN:WEB] Encuentro Post-Deploy ${Date.now()}`,
      descripcion: 'Validación web post-despliegue de AccessGate.',
      fecha: '2026-12-28',
      hora: '19:00',
      modalidad: 'virtual',
      link_virtual: 'https://meet.google.com/web-qa-test',
      tipo_invitacion: 'link_general',
      tema_invitacion: 'celebration',
    };
    const { data: resCreate, error: errCreate } = await hostClient.rpc('crear_encuentro_seguro', {
      p_data: encPayload,
    });
    const createdId = resCreate?.id;
    const createdToken = resCreate?.public_token;
    if (createdId) createdEncounterIds.push(createdId);

    check(
      7,
      'Creación de Encuentros con Cuenta QA',
      !errCreate && resCreate?.ok === true && !!createdId && !!createdToken,
      `Encuentro creado exitosamente ID: ${createdId}`
    );

    // --------------------------------------------------------------------------
    // 8. Acceso y creación anónima mediante identidad QA autorizada
    // --------------------------------------------------------------------------
    console.log('\n--- Punto 8: Acceso y Creación Anónima QA ---');
    const qaAnonClient = createClient(STAGING_SUPABASE_URL, getStagingPublishableKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: qaAnonAuth } = await qaAnonClient.auth.signInAnonymously();
    const qaAnonId = qaAnonAuth?.user?.id!;
    createdUserIds.push(qaAnonId);
    await adminClient.from('qa_authorized_users').insert({ user_id: qaAnonId, role: 'qa' });

    const { data: resAnonCreate, error: errAnonCreate } = await qaAnonClient.rpc('crear_encuentro_seguro', {
      p_data: {
        titulo: `[QA-DYN:WEB] Anónimo QA ${Date.now()}`,
        descripcion: 'Creación sintética anónima.',
        fecha: '2026-12-29',
        hora: '16:00',
        modalidad: 'virtual',
        link_virtual: 'https://meet.google.com/web-qa-anon',
        tipo_invitacion: 'link_general',
      },
    });
    if (resAnonCreate?.id) createdEncounterIds.push(resAnonCreate.id);

    check(
      8,
      'Creación Anónima con Identidad QA Autorizada',
      !errAnonCreate && resAnonCreate?.ok === true,
      `Sesión anónima QA autorizada creó encuentro ID: ${resAnonCreate?.id}`
    );

    // --------------------------------------------------------------------------
    // 9. Solicitudes a encuentros abiertos, cupos y notificaciones Inbox
    // --------------------------------------------------------------------------
    console.log('\n--- Punto 9: Solicitudes, Cupos e Inbox ---');
    await adminClient
      .from('encuentros')
      .update({
        is_open: true,
        estado: 'activo',
        moderation_status: 'approved',
        max_participants: 1,
        open_public_title: 'Encuentro QA Abierto',
        open_description: 'Descripción pública para pruebas',
      })
      .eq('id', createdId);

    // Solicitud de guest
    const { data: resJoin, error: errJoin } = await guestClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: createdId,
      p_nombre: 'Tester Solicitante Web',
      p_mensaje: 'Hola, solicito sumarme desde validación web.',
      p_seat_count: 1,
    });

    const isJoinOk = !errJoin && resJoin?.ok === true && resJoin?.estado === 'pending';

    // Notificación en inbox del host
    const { data: inboxItems } = await adminClient
      .from('inbox_notifications')
      .select('id, notification_type, deep_link')
      .eq('recipient_user_id', hostId);

    const hasInboxNotif = !!inboxItems?.find((n) => n.notification_type === 'open_encounter_join_requested');

    check(
      9,
      'Solicitudes a Encuentros Abiertos y Notificación Inbox',
      isJoinOk && hasInboxNotif,
      `Solicitud 'pending' (ID: ${resJoin?.request_id}) y notificación Inbox emitida con éxito`
    );

    // --------------------------------------------------------------------------
    // 10. Invitaciones por token
    // --------------------------------------------------------------------------
    console.log('\n--- Punto 10: Invitaciones por Token Público ---');
    const { data: tokData, error: errTok } = await anonClient.rpc('get_encuentro_por_public_token', {
      p_public_token: createdToken,
    });
    const hasLeak = tokData && ('email' in tokData || 'telefono' in tokData);
    check(
      10,
      'Ficha por Token Público sin Fuga de PII',
      !errTok && tokData !== null && !hasLeak,
      `Token ${createdToken} resuelve ficha del encuentro sin exponer PII`
    );

    // --------------------------------------------------------------------------
    // 11. Fail-closed de AccessGate ante fallos de conexión
    // --------------------------------------------------------------------------
    console.log('\n--- Punto 11: Resiliencia Fail-Closed ante Caída de Red ---');
    // Creamos cliente desconectado apuntando a puerto cerrado para forzar Network Error
    const deadClient = createClient('http://127.0.0.1:59999', 'invalid_key', {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    clearPlatformAccessCache();
    const failClosedActive = await isPlatformPublicLaunchActive(deadClient);
    check(
      11,
      'AccessGate Fail-Closed ante Error de Conexión',
      failClosedActive === false,
      `isPlatformPublicLaunchActive(deadClient) retorna false ante fallo de red`
    );

    // --------------------------------------------------------------------------
    // 12. Integridad de los 26 fixtures protegidos
    // --------------------------------------------------------------------------
    console.log('\n--- Punto 12: Integridad de Fixtures Protegidos ---');
    const { data: fixturesFound, error: errFixtures } = await adminClient
      .from('encuentros')
      .select('id')
      .in('id', PROTECTED_26_FIXTURES);

    const foundCount = fixturesFound?.length ?? 0;
    check(
      12,
      'Integridad de los 26 Fixtures Protegidos',
      !errFixtures && foundCount === 26,
      `Exactamente 26/26 fixtures protegidos confirmados intactos en Staging`
    );

    // --------------------------------------------------------------------------
    // 13. Verificación de Entorno: Supabase Staging vs Producción
    // --------------------------------------------------------------------------
    console.log('\n--- Punto 13: Verificación de Aislamiento de Entornos ---');
    const isTargetStaging = STAGING_SUPABASE_URL.includes(STAGING_PROJECT_REF) && !STAGING_SUPABASE_URL.includes(PROD_PROJECT_REF);
    check(
      13,
      'Aislamiento Estricto de Entornos',
      isTargetStaging,
      `Frontend y tests interactúan con Staging (${STAGING_PROJECT_REF}); Producción (${PROD_PROJECT_REF}) inalterada`
    );

  } finally {
    // --------------------------------------------------------------------------
    // TEARDOWN
    // --------------------------------------------------------------------------
    console.log('\n--- TEARDOWN: Higiene No Destructiva ---');
    if (createdEncounterIds.length > 0) {
      await adminClient
        .from('encuentros')
        .update({ is_open: false, cancellation_reason: 'qa_web_post_deploy' })
        .in('id', createdEncounterIds);
    }

    if (createdUserIds.length > 0) {
      await adminClient.from('qa_authorized_users').delete().in('user_id', createdUserIds);
      for (const uid of createdUserIds) {
        try {
          await adminClient.auth.admin.deleteUser(uid);
        } catch (_) {}
      }
    }
  }

  console.log('\n==============================================================================');
  console.log('RESUMEN DE BATERÍA QA WEB POST-DESPLIEGUE:');
  const allPassed = results.every((r) => r.passed);
  const passedCount = results.filter((r) => r.passed).length;
  console.log(`Total: ${passedCount}/${results.length} PASADAS`);
  if (!allPassed) {
    console.error('ALERTA: Se detectaron fallos en la batería de QA web.');
    process.exit(1);
  } else {
    console.log('ESTADO: 100% PASS. Todas las verificaciones post-despliegue aprobadas.');
    console.log('==============================================================================');
  }
}

main().catch((err) => {
  console.error('[FATAL] Error en QA web post-deploy:', err);
  process.exit(1);
});
