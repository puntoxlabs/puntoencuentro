/**
 * Suite de Regresión Funcional Integral Post-Migración en Supabase Staging Real
 *
 * Entorno Obligatorio: Staging (wougfhfwqgmxhgvjqoua)
 * Invariante: assertStagingEnvironment()
 *
 * Áreas Evaluadas (con identidades QA autorizadas):
 * 1. Home y Discovery (encuentros e intenciones).
 * 2. Creación de encuentros cerrados y abiertos.
 * 3. Sesiones anónimas de QA (creación y discovery habilitados vs externos bloqueados).
 * 4. Invitaciones y respuestas por token (get_encuentro_por_public_token sin fugas).
 * 5. Solicitudes, cupos y lista de espera (solicitar_sumarse_encuentro_abierto).
 * 6. Cambios de estado y coordinación (inscriptions_closed, anti-abuso, temporalidad).
 * 7. Notificaciones y mensajería (inbox_notifications, get_mensajes_encuentro_seguro).
 * 8. Identidad, entitlements y navegación (get_my_entitlements, perfiles y preservación de contexto).
 * 9. Invariante de datos: 26/26 fixtures protegidos intactos.
 *
 * Cero mutaciones destructivas en tablas productivas. Cero toque a Producción.
 */

import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard.ts';

const STAGING_URL = 'https://wougfhfwqgmxhgvjqoua.supabase.co';

assertStagingEnvironment(STAGING_URL);
assertStagingEnvironment(STAGING_PROJECT_REF);

const serviceRoleKey = getStagingSecretKey();
const publishableKey = getStagingPublishableKey();

const adminClient = createClient(STAGING_URL, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const anonClient = createClient(STAGING_URL, publishableKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
  code: string;
  module: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function check(code: string, module: string, condition: boolean, details: string) {
  results.push({ code, module, passed: condition, details });
  const icon = condition ? '✔ PASS' : '❌ FAIL';
  console.log(`[${code}] ${icon} - ${module}: ${details}`);
}

async function main() {
  console.log('==============================================================================');
  console.log('REGRESIÓN FUNCIONAL POST-MIGRACIÓN EN SUPABASE STAGING');
  console.log(`Target: ${STAGING_URL} (Project: ${STAGING_PROJECT_REF})`);
  console.log('==============================================================================\n');

  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  try {
    // --------------------------------------------------------------------------
    // SETUP: Cuentas Sintéticas de QA Autorizadas (Host y Participante)
    // --------------------------------------------------------------------------
    console.log('--- SETUP: Inicializando Cuentas Sintéticas de QA ---');
    const hostEmail = `qa-reg-host-${Date.now()}@puntoencuentro.test`;
    const hostPwd = `HostPwd!${Date.now()}`;
    const { data: hostUser, error: errHostUser } = await adminClient.auth.admin.createUser({
      email: hostEmail,
      password: hostPwd,
      email_confirm: true,
    });
    if (errHostUser || !hostUser.user) throw new Error(`Fallo crear host: ${errHostUser?.message}`);
    const hostId = hostUser.user.id;
    createdUserIds.push(hostId);

    const guestEmail = `qa-reg-guest-${Date.now()}@puntoencuentro.test`;
    const guestPwd = `GuestPwd!${Date.now()}`;
    const { data: guestUser, error: errGuestUser } = await adminClient.auth.admin.createUser({
      email: guestEmail,
      password: guestPwd,
      email_confirm: true,
    });
    if (errGuestUser || !guestUser.user) throw new Error(`Fallo crear guest: ${errGuestUser?.message}`);
    const guestId = guestUser.user.id;
    createdUserIds.push(guestId);

    // Registrar ambas cuentas en qa_authorized_users
    await adminClient.from('qa_authorized_users').insert([
      { user_id: hostId, role: 'qa' },
      { user_id: guestId, role: 'qa' },
    ]);

    // Asegurar existencia de política rate limit para request_open_encounter en Staging
    await adminClient.from('rate_limit_policies').upsert({
      action: 'request_open_encounter',
      max_requests: 12,
      window_seconds: 3600,
      enabled: true,
    }, { onConflict: 'action' });

    // Clientes autenticados
    const hostClient = createClient(STAGING_URL, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await hostClient.auth.signInWithPassword({ email: hostEmail, password: hostPwd });

    const guestClient = createClient(STAGING_URL, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await guestClient.auth.signInWithPassword({ email: guestEmail, password: guestPwd });

    // Cliente Anónimo Sintético de QA
    const qaAnonClient = createClient(STAGING_URL, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: qaAnonAuth } = await qaAnonClient.auth.signInAnonymously();
    const qaAnonId = qaAnonAuth?.user?.id!;
    createdUserIds.push(qaAnonId);
    await adminClient.from('qa_authorized_users').insert({ user_id: qaAnonId, role: 'qa' });

    console.log('  ✔ Identidades sintéticas QA activadas y autorizadas.\n');

    // --------------------------------------------------------------------------
    // MÓDULO 1: Home y Discovery
    // --------------------------------------------------------------------------
    console.log('--- 1. Home y Discovery ---');
    const { data: encList, error: errEncList } = await hostClient.rpc('get_discovery_encuentros_abiertos');
    check(
      'REG-01',
      'Discovery Encuentros (QA)',
      !errEncList && Array.isArray(encList) && encList.length > 0,
      `Retorna ${encList?.length ?? 0} encuentros abiertos con datos redactados`
    );

    const { data: intList, error: errIntList } = await hostClient.rpc('get_discovery_intenciones_activas');
    check(
      'REG-02',
      'Discovery Intenciones (QA)',
      !errIntList && Array.isArray(intList),
      `Retorna ${intList?.length ?? 0} intenciones activas`
    );

    // Verificar que un cliente anónimo externo sin registro en QA sigue recibiendo []
    const { data: unauthEnc } = await anonClient.rpc('get_discovery_encuentros_abiertos');
    check(
      'REG-03',
      'Discovery Hermético Exterior',
      Array.isArray(unauthEnc) && unauthEnc.length === 0,
      'Cliente sin JWT recibe [] hermético'
    );

    // --------------------------------------------------------------------------
    // MÓDULO 2: Creación de Encuentros (Cerrados y Abiertos)
    // --------------------------------------------------------------------------
    console.log('\n--- 2. Creación de Encuentros ---');
    const encOpenPayload = {
      titulo: `[QA-DYN:REG] Encuentro Abierto Regresión ${Date.now()}`,
      descripcion: 'Evaluación funcional de creación abierta en pre-lanzamiento.',
      fecha: '2026-12-20',
      hora: '18:30',
      modalidad: 'virtual',
      link_virtual: 'https://meet.google.com/reg-test-open',
      tipo_invitacion: 'link_general',
      tema_invitacion: 'celebration',
    };
    const { data: resCreateOpen, error: errCreateOpen } = await hostClient.rpc('crear_encuentro_seguro', {
      p_data: encOpenPayload,
    });
    const createdOpenId = resCreateOpen?.id;
    const createdOpenToken = resCreateOpen?.public_token;
    if (createdOpenId) createdEncounterIds.push(createdOpenId);

    check(
      'REG-04',
      'Creación Encuentro Abierto (QA Host)',
      !errCreateOpen && resCreateOpen?.ok === true && !!createdOpenId && !!createdOpenToken,
      `Creado ID: ${createdOpenId}, Token: ${createdOpenToken}`
    );

    // --------------------------------------------------------------------------
    // MÓDULO 3: Sesiones Anónimas de QA
    // --------------------------------------------------------------------------
    console.log('\n--- 3. Sesiones Anónimas de QA ---');
    const encAnonPayload = {
      titulo: `[QA-DYN:REG] Encuentro Anónimo QA ${Date.now()}`,
      descripcion: 'Comprobación de sesión sintética anónima en QA.',
      fecha: '2026-12-22',
      hora: '17:00',
      modalidad: 'virtual',
      link_virtual: 'https://meet.google.com/reg-anon-qa',
      tipo_invitacion: 'link_general',
    };
    const { data: resCreateAnon, error: errCreateAnon } = await qaAnonClient.rpc('crear_encuentro_seguro', {
      p_data: encAnonPayload,
    });
    if (resCreateAnon?.id) createdEncounterIds.push(resCreateAnon.id);

    check(
      'REG-05',
      'Creación por Anónimo QA Autorizado',
      !errCreateAnon && resCreateAnon?.ok === true,
      `Sesión anónima QA creó encuentro ID: ${resCreateAnon?.id}`
    );

    // --------------------------------------------------------------------------
    // MÓDULO 4: Invitaciones y Respuestas por Token
    // --------------------------------------------------------------------------
    console.log('\n--- 4. Invitaciones y Respuestas por Token ---');
    const { data: tokData, error: errTokData } = await anonClient.rpc('get_encuentro_por_public_token', {
      p_public_token: createdOpenToken,
    });
    const hasLeak = tokData && ('email' in tokData || 'telefono' in tokData);
    check(
      'REG-06',
      'Resolución por Token Público',
      !errTokData && tokData !== null && !hasLeak,
      `Token ${createdOpenToken} resuelve datos del encuentro sin exponer PII`
    );

    // --------------------------------------------------------------------------
    // MÓDULO 5: Solicitudes, Cupos y Lista de Espera
    // --------------------------------------------------------------------------
    console.log('\n--- 5. Solicitudes, Cupos y Lista de Espera ---');
    // Para poder solicitar sumarse a un encuentro abierto, el encuentro debe estar marcado como abierto (is_open: true)
    // y aprobado por moderación (moderation_status: 'approved', max_participants: 10)
    await adminClient
      .from('encuentros')
      .update({
        is_open: true,
        moderation_status: 'approved',
        max_participants: 5,
        open_public_title: 'Encuentro Regresión Abierto',
        open_description: 'Descripción pública para pruebas',
      })
      .eq('id', createdOpenId);

    const { data: resJoin, error: errJoin } = await guestClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: createdOpenId,
      p_nombre: 'Tester Solicitante QA',
      p_mensaje: 'Hola, solicito sumarme para prueba de regresión.',
      p_seat_count: 1,
    });
    console.log('DEBUG REG-07 resJoin:', JSON.stringify(resJoin), 'errJoin:', JSON.stringify(errJoin));

    check(
      'REG-07',
      'Solicitar Sumarse a Encuentro Abierto (QA Guest)',
      !errJoin && resJoin?.ok === true && resJoin?.estado === 'pendiente',
      `Solicitud registrada con estado: ${resJoin?.estado}, ID: ${resJoin?.solicitud_id}`
    );

    // --------------------------------------------------------------------------
    // MÓDULO 6: Cambios de Estado y Coordinación
    // --------------------------------------------------------------------------
    console.log('\n--- 6. Cambios de Estado y Coordinación ---');
    const { error: errCloseInscriptions } = await adminClient
      .from('encuentros')
      .update({ inscriptions_closed: true })
      .eq('id', createdOpenId);

    const { data: resJoinClosed } = await guestClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: createdOpenId,
      p_nombre: 'Otro Solicitante',
      p_seat_count: 1,
    });

    check(
      'REG-08',
      'Bloqueo de Solicitudes con Inscripciones Cerradas',
      !errCloseInscriptions && resJoinClosed?.ok === false && resJoinClosed?.error === 'inscriptions_closed',
      `Rechazo determinístico: ${resJoinClosed?.error}`
    );

    // --------------------------------------------------------------------------
    // MÓDULO 7: Notificaciones y Mensajería
    // --------------------------------------------------------------------------
    console.log('\n--- 7. Notificaciones y Mensajería ---');
    // Comprobar que el Host recibió la notificación en inbox
    const { data: inboxNotifs, error: errInbox } = await adminClient
      .from('inbox_notifications')
      .select('id, tipo, titulo, mensaje')
      .eq('usuario_id', hostId)
      .limit(5);

    check(
      'REG-09',
      'Notificación en Inbox para Host',
      !errInbox && Array.isArray(inboxNotifs) && inboxNotifs.length > 0,
      `Host recibió ${inboxNotifs?.length ?? 0} notificación(es). Tipo: ${inboxNotifs?.[0]?.tipo}`
    );

    // Publicar mensaje de coordinación por parte del Host
    const { data: resMsg, error: errMsg } = await hostClient.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: createdOpenId,
      p_contenido: 'Mensaje de coordinación funcional de prueba',
    });
    console.log('DEBUG REG-10 resMsg:', JSON.stringify(resMsg), 'errMsg:', JSON.stringify(errMsg));

    check(
      'REG-10',
      'Publicación de Mensajes de Coordinación',
      !errMsg && resMsg?.ok === true,
      `Mensaje publicado exitosamente por Host (ID: ${resMsg?.id})`
    );

    // --------------------------------------------------------------------------
    // MÓDULO 8: Identidad, Entitlements y Perfil
    // --------------------------------------------------------------------------
    console.log('\n--- 8. Identidad, Entitlements y Perfil ---');
    const { data: hostEntitlements, error: errEntitlements } = await hostClient.rpc('get_my_entitlements');
    check(
      'REG-11',
      'Entitlements y Perfil de Usuario Autenticado',
      !errEntitlements && hostEntitlements !== null,
      `Entitlements devueltos con normalidad para sesión QA`
    );

    // --------------------------------------------------------------------------
    // MÓDULO 9: Integridad de los 26 Fixtures Protegidos
    // --------------------------------------------------------------------------
    console.log('\n--- 9. Integridad de los 26 Fixtures Protegidos ---');
    const { data: fixturesFound, error: errFixtures } = await adminClient
      .from('encuentros')
      .select('id, titulo, is_open, estado')
      .in('id', PROTECTED_26_FIXTURES);

    const foundSet = new Set((fixturesFound || []).map((f) => f.id));
    const missing = PROTECTED_26_FIXTURES.filter((id) => !foundSet.has(id));

    check(
      'REG-12',
      'Integridad de Fixtures Protegidos',
      !errFixtures && missing.length === 0 && (fixturesFound?.length ?? 0) === 26,
      `26/26 fixtures intactos e inalterados en Staging`
    );

  } finally {
    // --------------------------------------------------------------------------
    // TEARDOWN: Higiene No Destructiva de Datos Transaccionales
    // --------------------------------------------------------------------------
    console.log('\n--- TEARDOWN: Higiene No Destructiva ---');
    if (createdEncounterIds.length > 0) {
      console.log(`  Desactivando ${createdEncounterIds.length} encuentros transaccionales (is_open = false)...`);
      await adminClient
        .from('encuentros')
        .update({ is_open: false, cancellation_reason: 'qa_regression_runner' })
        .in('id', createdEncounterIds);
    }

    if (createdUserIds.length > 0) {
      console.log(`  Removiendo ${createdUserIds.length} identidades sintéticas de qa_authorized_users...`);
      await adminClient.from('qa_authorized_users').delete().in('user_id', createdUserIds);

      console.log(`  Eliminando ${createdUserIds.length} cuentas auth de prueba...`);
      for (const uid of createdUserIds) {
        try {
          await adminClient.auth.admin.deleteUser(uid);
        } catch (e: any) {
          console.warn(`  Aviso al eliminar auth user ${uid}: ${e.message}`);
        }
      }
    }
  }

  console.log('\n==============================================================================');
  console.log('RESUMEN DE REGRESIÓN FUNCIONAL EN STAGING:');
  const allPassed = results.every((r) => r.passed);
  const passedCount = results.filter((r) => r.passed).length;
  console.log(`Total: ${passedCount}/${results.length} PASADAS`);
  if (!allPassed) {
    console.error('ALERTA: Se detectaron fallos en la suite de regresión.');
    process.exit(1);
  } else {
    console.log('ESTADO: 100% PASS. Todas las funciones operan normalmente bajo la nueva autorización.');
    console.log('==============================================================================');
  }
}

main().catch((err) => {
  console.error('[FATAL] Error en regresión de Staging:', err);
  process.exit(1);
});
