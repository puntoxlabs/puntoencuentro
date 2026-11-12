/**
 * Validación Integral Post-Migración de Acceso PRE-LAUNCH en Supabase Staging Real
 *
 * Entorno Obligatorio: Staging (wougfhfwqgmxhgvjqoua)
 * Invariante: assertStagingEnvironment()
 *
 * Ejecuta validaciones de caja negra contra la API real de Staging:
 * 1. Sin JWT: Discovery [] y creación rechazada.
 * 2. Anónimo externo: Discovery [] y creación rechazada.
 * 3. Permanente externo: Discovery [] y creación rechazada.
 * 4. Permanente QA: Discovery y creación operativos.
 * 5. Anónimo QA: Discovery y creación operativos.
 * 6. Invitación por public_token: comportamiento documentado sin exposición adicional.
 * 7. Estado en DB: public_launch_active = false.
 * 8. Integridad: 26/26 fixtures protegidos intactos.
 *
 * Cero mutaciones destructivas. Cero toque a Producción.
 */

import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard.ts';

const STAGING_URL = 'https://wougfhfwqgmxhgvjqoua.supabase.co';

// 1. Guardias de seguridad de entorno
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

// Lista de los 26 fixtures protegidos e inviolables
const PROTECTED_26_FIXTURES = [
  // 1. 8 Legítimos Leandro Vega
  '4e30c9e2-5d0c-4702-92b9-cc5afaa1bc95',
  '66cc0a49-5998-4ec8-a7de-aeb8de0f8bd9',
  '6463d438-6862-4e92-97a5-deabe9649c6b',
  '4c93c5dc-1669-423d-bc74-6a65c93c12c7',
  '0323db67-d695-468d-85e6-132c6ec7d49f',
  '951663b3-8f3e-4eb8-a2bc-004c1e6a67c9',
  'd2450708-88ea-477c-ae48-a2eee47ef635',
  '95ea3aea-5eed-4fd6-8531-7b16ce42b973',
  // 2. 6 Inciertos
  'e8a238ac-e4ba-4844-9fb7-c05e594f43fb',
  '49c60a88-23e5-48e3-bcf1-04fe989c1286',
  'b35c498b-0e89-4704-a693-45f105215ea5',
  'f75faae9-677c-4cae-b99d-ab78f6cd6253',
  'da2d35ac-0e2b-42e6-b8ad-5c8ee6643526',
  'ad72c95d-ddb2-4438-9731-5af91e188345',
  // 3. 5 Moderación con reportes
  '09149bf7-b3b5-4bb5-b4cd-ccb0b9fff8db',
  '2456d176-1b34-4fcc-be16-10e83d051ac6',
  '31016f94-5a6a-4772-83a0-9ab57b7cfded',
  '40fd1414-a0dd-4cd3-8535-3518c259f21e',
  '9b7f03c7-bce8-473c-9b48-eadac4607b37',
  // 4. 6 Funcionales Sprint QA
  'e0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-000000000002',
  'e0000000-0000-4000-8000-000000000003',
  'e0000000-0000-4000-8000-000000000004',
  '8f488fce-4355-4052-b9ba-8d6bd8bd2255',
  'e0000000-0000-4000-8000-000000000010',
  // 5. 1 Fixture E2E Futuro
  'f4123f9a-28d3-43c3-8e70-dd95b4e157cf',
];

interface TestResult {
  step: string;
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function record(step: string, name: string, passed: boolean, details: string) {
  results.push({ step, name, passed, details });
  const status = passed ? '✔ PASS' : '❌ FAIL';
  console.log(`[${step}] ${status} - ${name}`);
  if (details) {
    console.log(`       Detalle: ${details}`);
  }
}

async function run() {
  console.log('==============================================================================');
  console.log('VALIDACIÓN POST-MIGRACIÓN DE SEGURIDAD PRE-LANZAMIENTO EN STAGING REAL');
  console.log(`Target: ${STAGING_URL} (Ref: ${STAGING_PROJECT_REF})`);
  console.log('==============================================================================\n');

  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  try {
    // --------------------------------------------------------------------------
    // VALIDACIÓN 1: ESTADO EN BASE DE DATOS Y FUNCIÓN RPC DE FASE
    // --------------------------------------------------------------------------
    console.log('--- VALIDACIÓN 1: Estado en Base de Datos ---');
    const { data: dbSetting, error: errSetting } = await adminClient
      .from('platform_access_control')
      .select('setting_key, setting_value, description')
      .eq('setting_key', 'public_launch_active')
      .single();

    record(
      'V1.1',
      'platform_access_control tiene public_launch_active = false',
      !errSetting && dbSetting?.setting_value === false,
      `setting_value: ${dbSetting?.setting_value}`
    );

    const { data: isOpenRpc, error: errIsOpenRpc } = await adminClient.rpc('is_public_launch_open');
    record(
      'V1.2',
      'RPC is_public_launch_open() retorna false (Fail-Closed)',
      !errIsOpenRpc && isOpenRpc === false,
      `retorno: ${isOpenRpc}`
    );

    // --------------------------------------------------------------------------
    // VALIDACIÓN 2: CLIENTE SIN JWT (NO AUTENTICADO)
    // --------------------------------------------------------------------------
    console.log('\n--- VALIDACIÓN 2: Cliente Sin JWT (No Autenticado) ---');
    const { data: unauthDiscEnc, error: errUnauthEnc } = await anonClient.rpc(
      'get_discovery_encuentros_abiertos'
    );
    record(
      'V2.1',
      'get_discovery_encuentros_abiertos retorna lista vacía [] sin JWT',
      !errUnauthEnc && Array.isArray(unauthDiscEnc) && unauthDiscEnc.length === 0,
      `items devueltos: ${unauthDiscEnc?.length ?? 0}`
    );

    const { data: unauthDiscInt, error: errUnauthInt } = await anonClient.rpc(
      'get_discovery_intenciones_activas'
    );
    record(
      'V2.2',
      'get_discovery_intenciones_activas retorna lista vacía [] sin JWT',
      !errUnauthInt && Array.isArray(unauthDiscInt) && unauthDiscInt.length === 0,
      `items devueltos: ${unauthDiscInt?.length ?? 0}`
    );

    const { data: unauthDetail, error: errUnauthDetail } = await anonClient.rpc(
      'get_encuentro_abierto_publico',
      { p_encuentro_id: 'e0000000-0000-4000-8000-000000000001' }
    );
    record(
      'V2.3',
      'get_encuentro_abierto_publico bloqueado sin JWT (pre_launch_restricted)',
      !errUnauthDetail && unauthDetail?.ok === false && unauthDetail?.error === 'pre_launch_restricted',
      `respuesta: ${JSON.stringify(unauthDetail)}`
    );

    const { data: unauthCreate, error: errUnauthCreate } = await anonClient.rpc(
      'crear_encuentro_seguro',
      { p_data: { titulo: 'Intento Sin Auth' } }
    );
    record(
      'V2.4',
      'crear_encuentro_seguro rechazado sin JWT (not_authenticated)',
      !errUnauthCreate && unauthCreate?.ok === false && unauthCreate?.error === 'not_authenticated',
      `respuesta: ${JSON.stringify(unauthCreate)}`
    );

    // --------------------------------------------------------------------------
    // VALIDACIÓN 3: ANÓNIMO EXTERNO (SESIÓN ANÓNIMA NO LISTADA EN QA)
    // --------------------------------------------------------------------------
    console.log('\n--- VALIDACIÓN 3: Anónimo Externo (No registrado en QA) ---');
    const extAnonClient = createClient(STAGING_URL, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: anonAuthData, error: errAnonAuth } = await extAnonClient.auth.signInAnonymously();
    if (errAnonAuth || !anonAuthData.user) {
      throw new Error(`Fallo signInAnonymously: ${errAnonAuth?.message}`);
    }
    const extAnonUserId = anonAuthData.user.id;
    createdUserIds.push(extAnonUserId);

    const { data: extAnonDiscEnc, error: errExtAnonEnc } = await extAnonClient.rpc(
      'get_discovery_encuentros_abiertos'
    );
    record(
      'V3.1',
      'Anónimo externo: Discovery de encuentros retorna []',
      !errExtAnonEnc && Array.isArray(extAnonDiscEnc) && extAnonDiscEnc.length === 0,
      `items devueltos: ${extAnonDiscEnc?.length ?? 0}`
    );

    const { data: extAnonDiscInt, error: errExtAnonInt } = await extAnonClient.rpc(
      'get_discovery_intenciones_activas'
    );
    record(
      'V3.2',
      'Anónimo externo: Discovery de intenciones retorna []',
      !errExtAnonInt && Array.isArray(extAnonDiscInt) && extAnonDiscInt.length === 0,
      `items devueltos: ${extAnonDiscInt?.length ?? 0}`
    );

    const { data: extAnonDetail, error: errExtAnonDetail } = await extAnonClient.rpc(
      'get_encuentro_abierto_publico',
      { p_encuentro_id: 'e0000000-0000-4000-8000-000000000001' }
    );
    record(
      'V3.3',
      'Anónimo externo: Detalle de encuentro público bloqueado (pre_launch_restricted)',
      !errExtAnonDetail && extAnonDetail?.ok === false && extAnonDetail?.error === 'pre_launch_restricted',
      `respuesta: ${JSON.stringify(extAnonDetail)}`
    );

    const { data: extAnonCreate, error: errExtAnonCreate } = await extAnonClient.rpc(
      'crear_encuentro_seguro',
      { p_data: { titulo: 'Intento Anónimo Externo' } }
    );
    record(
      'V3.4',
      'Anónimo externo: Creación de encuentro rechazada (pre_launch_creation_restricted)',
      !errExtAnonCreate && extAnonCreate?.ok === false && extAnonCreate?.error === 'pre_launch_creation_restricted',
      `respuesta: ${JSON.stringify(extAnonCreate)}`
    );

    // --------------------------------------------------------------------------
    // VALIDACIÓN 4: PERMANENTE EXTERNO (CUENTA REGISTRADA PERO NO EN QA)
    // --------------------------------------------------------------------------
    console.log('\n--- VALIDACIÓN 4: Permanente Externo (No registrado en QA) ---');
    const extPermEmail = `test-ext-${Date.now()}@puntoencuentro.test`;
    const extPermPassword = `ExtPwd!${Date.now()}`;
    const { data: extPermUser, error: errExtPermUser } = await adminClient.auth.admin.createUser({
      email: extPermEmail,
      password: extPermPassword,
      email_confirm: true,
    });
    if (errExtPermUser || !extPermUser.user) {
      throw new Error(`Fallo crear usuario externo: ${errExtPermUser?.message}`);
    }
    const extPermUserId = extPermUser.user.id;
    createdUserIds.push(extPermUserId);

    const extPermClient = createClient(STAGING_URL, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: errExtPermSignIn } = await extPermClient.auth.signInWithPassword({
      email: extPermEmail,
      password: extPermPassword,
    });
    if (errExtPermSignIn) {
      throw new Error(`Fallo login permanente externo: ${errExtPermSignIn.message}`);
    }

    const { data: extPermDiscEnc, error: errExtPermEnc } = await extPermClient.rpc(
      'get_discovery_encuentros_abiertos'
    );
    record(
      'V4.1',
      'Permanente externo: Discovery de encuentros retorna []',
      !errExtPermEnc && Array.isArray(extPermDiscEnc) && extPermDiscEnc.length === 0,
      `items devueltos: ${extPermDiscEnc?.length ?? 0}`
    );

    const { data: extPermDiscInt, error: errExtPermInt } = await extPermClient.rpc(
      'get_discovery_intenciones_activas'
    );
    record(
      'V4.2',
      'Permanente externo: Discovery de intenciones retorna []',
      !errExtPermInt && Array.isArray(extPermDiscInt) && extPermDiscInt.length === 0,
      `items devueltos: ${extPermDiscInt?.length ?? 0}`
    );

    const { data: extPermCreate, error: errExtPermCreate } = await extPermClient.rpc(
      'crear_encuentro_seguro',
      { p_data: { titulo: 'Intento Permanente Externo' } }
    );
    record(
      'V4.3',
      'Permanente externo: Creación de encuentro rechazada (pre_launch_creation_restricted)',
      !errExtPermCreate && extPermCreate?.ok === false && extPermCreate?.error === 'pre_launch_creation_restricted',
      `respuesta: ${JSON.stringify(extPermCreate)}`
    );

    // --------------------------------------------------------------------------
    // VALIDACIÓN 5: PERMANENTE QA (CUENTA REGISTRADA EN qa_authorized_users)
    // --------------------------------------------------------------------------
    console.log('\n--- VALIDACIÓN 5: Permanente QA (Autorizado en qa_authorized_users) ---');
    const qaPermEmail = `qa-perm-${Date.now()}@puntoencuentro.test`;
    const qaPermPassword = `QaPwd!${Date.now()}`;
    const { data: qaPermUser, error: errQaPermUser } = await adminClient.auth.admin.createUser({
      email: qaPermEmail,
      password: qaPermPassword,
      email_confirm: true,
    });
    if (errQaPermUser || !qaPermUser.user) {
      throw new Error(`Fallo crear usuario QA permanente: ${errQaPermUser?.message}`);
    }
    const qaPermUserId = qaPermUser.user.id;
    createdUserIds.push(qaPermUserId);

    // Registrar en qa_authorized_users
    const { error: errInsertQaPerm } = await adminClient
      .from('qa_authorized_users')
      .insert({
        user_id: qaPermUserId,
        role: 'qa',
      });
    if (errInsertQaPerm) {
      throw new Error(`Fallo registrar en qa_authorized_users: ${errInsertQaPerm.message}`);
    }

    const qaPermClient = createClient(STAGING_URL, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: errQaPermSignIn } = await qaPermClient.auth.signInWithPassword({
      email: qaPermEmail,
      password: qaPermPassword,
    });
    if (errQaPermSignIn) {
      throw new Error(`Fallo login QA permanente: ${errQaPermSignIn.message}`);
    }

    const { data: qaPermDiscEnc, error: errQaPermEnc } = await qaPermClient.rpc(
      'get_discovery_encuentros_abiertos'
    );
    record(
      'V5.1',
      'Permanente QA: Discovery de encuentros operativo (devuelve encuentros)',
      !errQaPermEnc && Array.isArray(qaPermDiscEnc) && qaPermDiscEnc.length > 0,
      `items devueltos: ${qaPermDiscEnc?.length ?? 0}`
    );

    const { data: qaPermDiscInt, error: errQaPermInt } = await qaPermClient.rpc(
      'get_discovery_intenciones_activas'
    );
    record(
      'V5.2',
      'Permanente QA: Discovery de intenciones operativo',
      !errQaPermInt && Array.isArray(qaPermDiscInt),
      `items devueltos: ${qaPermDiscInt?.length ?? 0}`
    );

    // Creación de encuentro temporal por Permanente QA
    const { data: qaPermCreate, error: errQaPermCreate } = await qaPermClient.rpc(
      'crear_encuentro_seguro',
      {
        p_data: {
          titulo: `[QA-TMP] Test Validación Pre-Launch Perm ${Date.now()}`,
          descripcion: 'Encuentro efímero de comprobación pre-lanzamiento.',
          fecha: '2026-12-15',
          hora: '19:00',
          modalidad: 'virtual',
          link_virtual: 'https://meet.google.com/test-prelaunch',
          tipo_invitacion: 'link_general',
        },
      }
    );
    record(
      'V5.3',
      'Permanente QA: Creación de encuentro segura operativa (ok = true)',
      !errQaPermCreate && qaPermCreate?.ok === true && typeof qaPermCreate?.id === 'string',
      `id creado: ${qaPermCreate?.id}`
    );
    if (qaPermCreate?.id) {
      createdEncounterIds.push(qaPermCreate.id);
    }

    // --------------------------------------------------------------------------
    // VALIDACIÓN 6: ANÓNIMO QA (SESIÓN ANÓNIMA REGISTRADA EN qa_authorized_users)
    // --------------------------------------------------------------------------
    console.log('\n--- VALIDACIÓN 6: Anónimo QA (Sintético registrado en qa_authorized_users) ---');
    const qaAnonClient = createClient(STAGING_URL, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: qaAnonAuthData, error: errQaAnonAuth } = await qaAnonClient.auth.signInAnonymously();
    if (errQaAnonAuth || !qaAnonAuthData.user) {
      throw new Error(`Fallo signInAnonymously QA: ${errQaAnonAuth?.message}`);
    }
    const qaAnonUserId = qaAnonAuthData.user.id;
    createdUserIds.push(qaAnonUserId);

    // Registrar en qa_authorized_users
    const { error: errInsertQaAnon } = await adminClient
      .from('qa_authorized_users')
      .insert({
        user_id: qaAnonUserId,
        role: 'qa',
      });
    if (errInsertQaAnon) {
      throw new Error(`Fallo registrar anónimo en qa_authorized_users: ${errInsertQaAnon.message}`);
    }

    const { data: qaAnonDiscEnc, error: errQaAnonEnc } = await qaAnonClient.rpc(
      'get_discovery_encuentros_abiertos'
    );
    record(
      'V6.1',
      'Anónimo QA: Discovery de encuentros operativo (devuelve encuentros)',
      !errQaAnonEnc && Array.isArray(qaAnonDiscEnc) && qaAnonDiscEnc.length > 0,
      `items devueltos: ${qaAnonDiscEnc?.length ?? 0}`
    );

    // Creación de encuentro temporal por Anónimo QA
    const { data: qaAnonCreate, error: errQaAnonCreate } = await qaAnonClient.rpc(
      'crear_encuentro_seguro',
      {
        p_data: {
          titulo: `[QA-TMP] Test Validación Pre-Launch Anon ${Date.now()}`,
          descripcion: 'Encuentro efímero de comprobación anónimo pre-lanzamiento.',
          fecha: '2026-12-16',
          hora: '20:00',
          modalidad: 'virtual',
          link_virtual: 'https://meet.google.com/test-prelaunch-anon',
          tipo_invitacion: 'link_general',
        },
      }
    );
    record(
      'V6.2',
      'Anónimo QA: Creación de encuentro operativa (ok = true)',
      !errQaAnonCreate && qaAnonCreate?.ok === true && typeof qaAnonCreate?.id === 'string',
      `id creado: ${qaAnonCreate?.id}`
    );
    if (qaAnonCreate?.id) {
      createdEncounterIds.push(qaAnonCreate.id);
    }

    // --------------------------------------------------------------------------
    // VALIDACIÓN 7: INVITACIÓN POR public_token (DIRECCIONAMIENTO PRIVADO)
    // --------------------------------------------------------------------------
    console.log('\n--- VALIDACIÓN 7: Invitación por public_token (Enlace Directo) ---');
    // Consultar el public_token de un fixture estable conocido
    const { data: stableFixture, error: errStable } = await adminClient
      .from('encuentros')
      .select('id, titulo, public_token, host_id')
      .eq('id', 'e0000000-0000-4000-8000-000000000001')
      .single();

    if (!errStable && stableFixture?.public_token) {
      const { data: tokenData, error: errToken } = await anonClient.rpc(
        'get_encuentro_por_public_token',
        { p_public_token: stableFixture.public_token }
      );

      const hasPrivLeak = tokenData && ('email' in tokenData || 'telefono' in tokenData || 'host_email' in tokenData);
      record(
        'V7.1',
        'get_encuentro_por_public_token resuelve invitación sin exposición de Discovery',
        !errToken && tokenData !== null && !hasPrivLeak,
        `resuelto: ${tokenData ? 'Encuentro proyectado' : 'null'}, sin fuga privada: ${!hasPrivLeak}`
      );
    } else {
      record('V7.1', 'Fixture estable no encontrado para token', false, errStable?.message || 'Sin token');
    }

    // --------------------------------------------------------------------------
    // VALIDACIÓN 8: INTEGRIDAD DE LOS 26 FIXTURES PROTEGIDOS
    // --------------------------------------------------------------------------
    console.log('\n--- VALIDACIÓN 8: Integridad de 26/26 Fixtures Protegidos ---');
    const { data: fixturesFound, error: errFixtures } = await adminClient
      .from('encuentros')
      .select('id, titulo, is_open, estado')
      .in('id', PROTECTED_26_FIXTURES);

    const foundIds = new Set((fixturesFound || []).map((f) => f.id));
    const missingIds = PROTECTED_26_FIXTURES.filter((id) => !foundIds.has(id));

    record(
      'V8.1',
      'Exactamente 26/26 fixtures protegidos e inviolables intactos en Staging',
      !errFixtures && missingIds.length === 0 && (fixturesFound?.length ?? 0) === 26,
      `encontrados: ${fixturesFound?.length ?? 0}/26, faltantes: ${missingIds.length === 0 ? 'ninguno' : missingIds.join(', ')}`
    );

  } finally {
    // --------------------------------------------------------------------------
    // HIGIENE NO DESTRUCTIVA: Soft Cleanup de Encuentros Creados y Purga de Users QA
    // --------------------------------------------------------------------------
    console.log('\n--- LIMPIEZA POST-VALIDACIÓN ---');
    if (createdEncounterIds.length > 0) {
      console.log(`Desactivando ${createdEncounterIds.length} encuentros efímeros de validación (is_open = false)...`);
      await adminClient
        .from('encuentros')
        .update({ is_open: false, cancellation_reason: 'qa_pre_launch_validation' })
        .in('id', createdEncounterIds);
    }

    if (createdUserIds.length > 0) {
      console.log(`Removiendo ${createdUserIds.length} usuarios temporales de qa_authorized_users...`);
      await adminClient
        .from('qa_authorized_users')
        .delete()
        .in('user_id', createdUserIds);

      console.log(`Eliminando ${createdUserIds.length} cuentas de autenticación temporales...`);
      for (const uid of createdUserIds) {
        try {
          await adminClient.auth.admin.deleteUser(uid);
        } catch (e: any) {
          console.warn(`Aviso al eliminar usuario ${uid}: ${e.message}`);
        }
      }
    }
  }

  console.log('\n==============================================================================');
  console.log('RESUMEN DE PRUEBAS CONTRA STAGING REAL:');
  const allPassed = results.every((r) => r.passed);
  const passedCount = results.filter((r) => r.passed).length;
  console.log(`Total: ${passedCount}/${results.length} PASADAS`);
  if (!allPassed) {
    console.error('ALERTA: Se detectaron fallos en la validación.');
    process.exit(1);
  } else {
    console.log('ESTADO: 100% EXITOSO. Entorno Staging verificado y cerrado herméticamente.');
    console.log('==============================================================================');
  }
}

run().catch((err) => {
  console.error('[FATAL] Error en validación de Staging:', err);
  process.exit(1);
});
