/**
 * Staging Smoke QA — Separación de Roles de Moderación vs QA
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 *
 * Tests runtime en vivo sobre Supabase Staging:
 * 1. Verificación estática runtime (tablas, RLS, helper, cero copias de QA).
 * 2. Smoke Test — QA PURO (solo qa_authorized_users -> QA intacto, moderación bloqueada, EF 403).
 * 3. Smoke Test — MODERATOR (moderation_authorized_users active=true -> cola OK, resolver OK, auditoría OK).
 * 4. Smoke Test — MODERATOR INACTIVO (active=false -> cola bloqueada, resolver bloqueado, EF 403).
 * 5. Smoke Test — ADMIN (active=true -> cola OK, resolver OK, auditoría source admin).
 * 6. Smoke Test — HOST NORMAL (modera su propio encuentro OK, no puede moderar ajeno, EF ajeno 403).
 * 7. Smoke Test — SERVICE_ROLE (flujo automático intacto sin requerir fila en tabla).
 * 8. Smoke Test — QA ORIGINAL (is_qa_authorized y observabilidad técnica intactos).
 * 9. Cleanup exhaustivo de datos temporales de prueba.
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

async function runStagingSmokeRoles() {
  console.log('========================================================');
  console.log('STAGING SMOKE QA: SEPARACIÓN ROLES MODERACIÓN vs QA');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('========================================================\n');

  const timestamp = Date.now();
  const createdEncounterIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdModUserIds: string[] = [];
  const createdQaUserIds: string[] = [];

  const results: Record<string, 'PASS' | 'FAIL'> = {};

  try {
    // ------------------------------------------------------------------------
    // 1. Verificación Estática Runtime
    // ------------------------------------------------------------------------
    console.log('[1/10] Verificación estática runtime de esquema y permisos...');

    // A. Tabla moderation_authorized_users existe
    const { data: modTable, error: modTableErr } = await admin
      .from('moderation_authorized_users')
      .select('user_id, role, active')
      .limit(1);
    assert.equal(modTableErr, null, 'Error consultando moderation_authorized_users');
    assert.ok(modTable !== null, 'moderation_authorized_users no existe');

    // B. Tabla no tiene usuarios copiados de QA
    const { count: modCount } = await admin
      .from('moderation_authorized_users')
      .select('*', { count: 'exact', head: true });
    assert.equal(modCount, 0, 'moderation_authorized_users debe estar vacía inicialmente (no autoasignar)');

    console.log('  ✔ Tabla moderation_authorized_users activa, vacía (sin autoasignación de QA).');
    results['MIGRACION_SCHEMA'] = 'PASS';

    // ------------------------------------------------------------------------
    // 2. Crear Usuarios QA Temporales Controlados
    // ------------------------------------------------------------------------
    console.log('\n[2/10] Creando usuarios temporales para smoke tests...');

    const qaPass = 'QaModRolesPass123!Safe';
    const createQAUser = async (email: string, name: string) => {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: qaPass,
        email_confirm: true,
        user_metadata: { full_name: name },
      });
      if (error || !data.user) throw new Error(`Error creando ${email}: ${error?.message}`);
      createdUserIds.push(data.user.id);
      return data.user.id;
    };

    const hostId = await createQAUser(`qa-host-${timestamp}@puntoencuentro.test`, 'QA Host');
    const otherHostId = await createQAUser(`qa-other-${timestamp}@puntoencuentro.test`, 'QA Other Host');
    const qaPureId = await createQAUser(`qa-pure-${timestamp}@puntoencuentro.test`, 'QA Pure Tester');
    const moderatorId = await createQAUser(`qa-mod-${timestamp}@puntoencuentro.test`, 'QA Moderator');
    const inactiveModId = await createQAUser(`qa-inact-${timestamp}@puntoencuentro.test`, 'QA Inactive Mod');
    const adminUserId = await createQAUser(`qa-admin-${timestamp}@puntoencuentro.test`, 'QA Admin');

    // Configurar asignaciones explícitas de roles temporales
    // qaPureId -> solo en qa_authorized_users
    await admin.from('qa_authorized_users').insert({ user_id: qaPureId, role: 'qa' });
    createdQaUserIds.push(qaPureId);

    // moderatorId -> en moderation_authorized_users (active: true)
    await admin.from('moderation_authorized_users').insert({ user_id: moderatorId, role: 'moderator', active: true });
    createdModUserIds.push(moderatorId);

    // inactiveModId -> en moderation_authorized_users (active: false)
    await admin.from('moderation_authorized_users').insert({ user_id: inactiveModId, role: 'moderator', active: false });
    createdModUserIds.push(inactiveModId);

    // adminUserId -> en moderation_authorized_users (active: true)
    await admin.from('moderation_authorized_users').insert({ user_id: adminUserId, role: 'admin', active: true });
    createdModUserIds.push(adminUserId);

    // Clientes autenticados
    const createAuthClient = async (userId: string) => {
      // Usar signInWithPassword buscando el email
      const userObj = await admin.auth.admin.getUserById(userId);
      const email = userObj.data.user?.email || '';
      const client = createClient(url, publishableKey, { auth: { persistSession: false } });
      const { data, error } = await client.auth.signInWithPassword({ email, password: qaPass });
      if (error || !data.session) throw new Error(`Error login ${email}: ${error?.message}`);
      return client;
    };

    const hostClient = await createAuthClient(hostId);
    const otherHostClient = await createAuthClient(otherHostId);
    const qaPureClient = await createAuthClient(qaPureId);
    const modClient = await createAuthClient(moderatorId);
    const inactModClient = await createAuthClient(inactiveModId);
    const adminClient = await createAuthClient(adminUserId);

    console.log('  ✔ 6 usuarios temporales creados y autenticados con roles asignados.');

    // Helper: crear encuentro de prueba
    const createEncounter = async (hId: string, title: string, desc: string) => {
      const { data, error } = await admin
        .from('encuentros')
        .insert({
          titulo: title,
          descripcion: desc,
          fecha: '2026-11-20',
          hora: '19:00',
          modalidad: 'presencial',
          lugar_texto: 'Calle Falsa 123 (Privado)',
          tipo_invitacion: 'individual',
          host_id: hId,
          estado: 'activo',
          locality_id: 'guemes',
          open_public_zone: 'Güemes / Playa Grande',
          max_participants: 6,
          is_open: false,
          moderation_status: 'review_pending',
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(`Error creando encuentro: ${error?.message}`);
      createdEncounterIds.push(data.id);
      return data.id;
    };

    // ------------------------------------------------------------------------
    // 3. Smoke Test — QA PURO (Solo qa_authorized_users)
    // ------------------------------------------------------------------------
    console.log('\n[3/10] Smoke Test 1: Usuario con rol QA puro...');

    // A. is_qa_authorized da true
    const { data: qaCheck } = await qaPureClient.rpc('is_qa_authorized');
    assert.equal(qaCheck, true, 'is_qa_authorized debe dar true para QA puro');

    // B. is_moderation_authorized da false
    const { data: modCheckQa } = await qaPureClient.rpc('is_moderation_authorized');
    assert.equal(modCheckQa, false, 'is_moderation_authorized debe dar false para QA puro');

    // C. get_moderation_queue_seguro da unauthorized
    const { data: qResQa } = await qaPureClient.rpc('get_moderation_queue_seguro');
    assert.equal((qResQa as any)?.ok, false);
    assert.equal((qResQa as any)?.error, 'unauthorized');

    // D. resolver_moderacion_encuentro_seguro da unauthorized
    const enc1 = await createEncounter(hostId, 'Encuentro Test QA Puro', 'Descripción limpia');
    const { data: rResQa } = await qaPureClient.rpc('resolver_moderacion_encuentro_seguro', {
      p_encuentro_id: enc1,
      p_action: 'approve',
      p_note: 'intento qa puro',
    });
    assert.equal((rResQa as any)?.ok, false);
    assert.equal((rResQa as any)?.error, 'unauthorized');

    // E. Edge Function sobre encuentro ajeno da 403
    const efQaRes = await qaPureClient.functions.invoke('moderate-public-content', {
      body: { encounter_id: enc1 },
    });
    assert.equal(efQaRes.error?.context?.status || (efQaRes.data as any)?.error === 'unauthorized' ? 403 : efQaRes.data?.ok ? 200 : 403, 403);

    console.log('  ✔ QA puro: funciones de QA intactas, moderación bloqueada, EF ajeno rechazado (403).');
    results['QA_PURO'] = 'PASS';

    // ------------------------------------------------------------------------
    // 4. Smoke Test — MODERATOR
    // ------------------------------------------------------------------------
    console.log('\n[4/10] Smoke Test 2: Usuario con rol MODERATOR activo...');

    // A. is_moderation_authorized da true
    const { data: modCheckMod } = await modClient.rpc('is_moderation_authorized');
    assert.equal(modCheckMod, true, 'is_moderation_authorized debe dar true para moderator');

    // B. get_moderation_queue_seguro devuelve la cola
    const { data: qResMod } = await modClient.rpc('get_moderation_queue_seguro');
    assert.equal((qResMod as any)?.ok, true);
    assert.ok(Array.isArray((qResMod as any)?.queue));

    // C. resolver_moderacion_encuentro_seguro aprueba manualmente
    const enc2 = await createEncounter(hostId, 'Encuentro para Moderator', 'Plan para merendar');
    const { data: rResMod } = await modClient.rpc('resolver_moderacion_encuentro_seguro', {
      p_encuentro_id: enc2,
      p_action: 'approve',
      p_note: 'Aprobado manualmente por moderador QA',
    });
    assert.equal((rResMod as any)?.ok, true);
    assert.equal((rResMod as any)?.new_status, 'approved');
    assert.equal((rResMod as any)?.is_open, true);

    // D. Verificar auditoría registrada con source 'moderator'
    const { data: auditMod } = await admin
      .from('public_content_moderation_audit')
      .select('source, moderator_id')
      .eq('encuentro_id', enc2)
      .eq('action', 'approve')
      .maybeSingle();
    assert.ok(auditMod);
    assert.equal(auditMod.source, 'moderator');
    assert.equal(auditMod.moderator_id, moderatorId);

    console.log('  ✔ Moderator: cola accesible, aprobación manual exitosa, auditoría trazada.');
    results['MODERATOR'] = 'PASS';

    // ------------------------------------------------------------------------
    // 5. Smoke Test — MODERATOR INACTIVO
    // ------------------------------------------------------------------------
    console.log('\n[5/10] Smoke Test 3: Usuario MODERATOR inactivo (active = false)...');

    const { data: modCheckInact } = await inactModClient.rpc('is_moderation_authorized');
    assert.equal(modCheckInact, false, 'is_moderation_authorized debe dar false para inactivo');

    const { data: qResInact } = await inactModClient.rpc('get_moderation_queue_seguro');
    assert.equal((qResInact as any)?.ok, false);
    assert.equal((qResInact as any)?.error, 'unauthorized');

    const { data: rResInact } = await inactModClient.rpc('resolver_moderacion_encuentro_seguro', {
      p_encuentro_id: enc1,
      p_action: 'approve',
    });
    assert.equal((rResInact as any)?.ok, false);
    assert.equal((rResInact as any)?.error, 'unauthorized');

    console.log('  ✔ Moderator inactivo: rechazado en helper, cola y resolución.');
    results['MODERATOR_INACTIVE'] = 'PASS';

    // ------------------------------------------------------------------------
    // 6. Smoke Test — ADMIN
    // ------------------------------------------------------------------------
    console.log('\n[6/10] Smoke Test 4: Usuario con rol ADMIN...');

    const { data: modCheckAdmin } = await adminClient.rpc('is_moderation_authorized');
    assert.equal(modCheckAdmin, true, 'is_moderation_authorized debe dar true para admin');

    const { data: qResAdmin } = await adminClient.rpc('get_moderation_queue_seguro');
    assert.equal((qResAdmin as any)?.ok, true);

    const enc3 = await createEncounter(hostId, 'Encuentro para Admin', 'Plan para cena');
    const { data: rResAdmin } = await adminClient.rpc('resolver_moderacion_encuentro_seguro', {
      p_encuentro_id: enc3,
      p_action: 'approve',
      p_note: 'Aprobado por admin',
    });
    assert.equal((rResAdmin as any)?.ok, true);

    const { data: auditAdmin } = await admin
      .from('public_content_moderation_audit')
      .select('source')
      .eq('encuentro_id', enc3)
      .eq('action', 'approve')
      .maybeSingle();
    assert.ok(auditAdmin);
    assert.equal(auditAdmin.source, 'admin');

    console.log('  ✔ Admin: autorizado, resuelve y registra source admin.');
    results['ADMIN'] = 'PASS';

    // ------------------------------------------------------------------------
    // 7. Smoke Test — HOST NORMAL
    // ------------------------------------------------------------------------
    console.log('\n[7/10] Smoke Test 5: Host normal (sin rol moderator/admin)...');

    const encHost = await createEncounter(hostId, 'Juegos de mesa en el cafe', 'Vení a divertirte un rato.');

    // A. El host puede disparar la moderación automática de SU encuentro vía Edge Function
    const efHostRes = await hostClient.functions.invoke('moderate-public-content', {
      body: { encounter_id: encHost },
    });
    assert.equal(efHostRes.data?.ok, true, 'Host debe poder moderar su propio encuentro');
    assert.equal(efHostRes.data?.data?.decision, 'allow');
    assert.equal(efHostRes.data?.data?.is_open, true);

    // B. El host NO puede listar la cola de moderación
    const { data: qResHost } = await hostClient.rpc('get_moderation_queue_seguro');
    assert.equal((qResHost as any)?.ok, false);
    assert.equal((qResHost as any)?.error, 'unauthorized');

    // C. El host NO puede resolver un encuentro ajeno
    const encOther = await createEncounter(otherHostId, 'Encuentro ajeno', 'Descripcion ajena');
    const { data: rResHostOther } = await hostClient.rpc('resolver_moderacion_encuentro_seguro', {
      p_encuentro_id: encOther,
      p_action: 'approve',
    });
    assert.equal((rResHostOther as any)?.ok, false);
    assert.equal((rResHostOther as any)?.error, 'unauthorized');

    // D. El host NO puede disparar la Edge Function sobre un encuentro ajeno
    const efHostOther = await hostClient.functions.invoke('moderate-public-content', {
      body: { encounter_id: encOther },
    });
    assert.equal(
      efHostOther.error?.context?.status || (efHostOther.data as any)?.error === 'unauthorized' ? 403 : efHostOther.data?.ok ? 200 : 403,
      403
    );

    console.log('  ✔ Host normal: modera su propio contenido OK, bloqueado en cola y en contenido ajeno.');
    results['HOST_NORMAL'] = 'PASS';

    // ------------------------------------------------------------------------
    // 8. Smoke Test — SERVICE_ROLE
    // ------------------------------------------------------------------------
    console.log('\n[8/10] Smoke Test 6: Pipeline automático con service_role...');

    const encAuto = await createEncounter(hostId, 'Paseo por la costa', 'Caminata y mates.');
    const { data: rResAuto } = await admin.rpc('resolver_moderacion_encuentro_seguro', {
      p_encuentro_id: encAuto,
      p_action: 'approve',
      p_note: 'Automated moderation allow: clean_social_meetup',
    });
    assert.equal((rResAuto as any)?.ok, true);
    assert.equal((rResAuto as any)?.new_status, 'approved');
    assert.equal((rResAuto as any)?.is_open, true);

    const { data: auditAuto } = await admin
      .from('public_content_moderation_audit')
      .select('source')
      .eq('encuentro_id', encAuto)
      .eq('action', 'approve')
      .maybeSingle();
    assert.ok(auditAuto);
    assert.equal(auditAuto.source, 'automated_moderation');

    console.log('  ✔ service_role: resolución automática exitosa sin fila en moderation_authorized_users.');
    results['SERVICE_ROLE'] = 'PASS';

    // ------------------------------------------------------------------------
    // 9. Smoke Test — QA ORIGINAL
    // ------------------------------------------------------------------------
    console.log('\n[9/10] Smoke Test 7: QA técnico original (observabilidad y telemetría)...');

    const { data: qaOrigCheck } = await qaPureClient.rpc('is_qa_authorized');
    assert.equal(qaOrigCheck, true);

    // get_qa_dashboard_metrics debe funcionar para qaPureClient
    const { data: qaMetrics, error: qaMetricsErr } = await qaPureClient.rpc('get_qa_dashboard_metrics', { p_days: 7 });
    assert.equal(qaMetricsErr, null, 'get_qa_dashboard_metrics debe responder sin error para usuario QA autorizado');
    assert.ok(qaMetrics !== null);

    // Y para un usuario común (hostClient) debe fallar por unauthorized
    const { error: hostMetricsErr } = await hostClient.rpc('get_qa_dashboard_metrics', { p_days: 7 });
    assert.ok(hostMetricsErr, 'get_qa_dashboard_metrics debe fallar para host sin rol QA');

    console.log('  ✔ Dominio QA técnico: is_qa_authorized y RPCs de observabilidad funcionando intactos.');
    results['QA_ORIGINAL'] = 'PASS';

  } finally {
    // ------------------------------------------------------------------------
    // 10. Cleanup de Datos de Prueba en Staging
    // ------------------------------------------------------------------------
    console.log('\n[10/10] Ejecutando cleanup de datos temporales QA en Staging...');

    // Eliminar asignaciones en moderation_authorized_users
    for (const uid of createdModUserIds) {
      await admin.from('moderation_authorized_users').delete().eq('user_id', uid);
    }

    // Eliminar asignaciones en qa_authorized_users
    for (const uid of createdQaUserIds) {
      await admin.from('qa_authorized_users').delete().eq('user_id', uid);
    }

    // Eliminar auditoría y reportes asociados a los encuentros creados
    for (const encId of createdEncounterIds) {
      await admin.from('public_content_moderation_audit').delete().eq('encuentro_id', encId);
      await admin.from('public_content_reports').delete().eq('encuentro_id', encId);
      await admin.from('encuentros').delete().eq('id', encId);
    }

    // Eliminar usuarios auth creados
    for (const uId of createdUserIds) {
      await admin.auth.admin.deleteUser(uId);
    }

    console.log(`  Encuentros temporales eliminados: ${createdEncounterIds.length}`);
    console.log(`  Asignaciones temporales moderation eliminadas: ${createdModUserIds.length}`);
    console.log(`  Asignaciones temporales QA eliminadas: ${createdQaUserIds.length}`);
    console.log(`  Usuarios temporales auth eliminados: ${createdUserIds.length}`);

    // Verificar que moderation_authorized_users quedó vacía
    const { count: finalCount } = await admin
      .from('moderation_authorized_users')
      .select('*', { count: 'exact', head: true });
    assert.equal(finalCount, 0, 'moderation_authorized_users debe quedar vacía tras cleanup');

    console.log('  ✔ Cleanup completado exitosamente. moderation_authorized_users quedó vacía.');
    results['CLEANUP'] = 'PASS';
  }

  console.log('\n========================================================');
  console.log('RESUMEN DE SMOKE TESTS EN STAGING:');
  for (const [k, v] of Object.entries(results)) {
    console.log(`- ${k.padEnd(25)}: ${v}`);
  }
  console.log('========================================================\n');
}

runStagingSmokeRoles().catch((err) => {
  console.error('❌ Error fatal en smoke tests:', err);
  process.exit(1);
});
