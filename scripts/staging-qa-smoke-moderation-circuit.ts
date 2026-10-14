/**
 * Staging Smoke QA — Circuito Operativo de Moderación Humana
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

async function runStagingCircuitSmoke() {
  console.log('========================================================');
  console.log('STAGING SMOKE QA: CIRCUITO DE MODERACIÓN HUMANA');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('========================================================\n');

  const timestamp = Date.now();
  const createdEncounterIds: string[] = [];
  const createdUserIds: string[] = [];

  try {
    // 1. Crear usuarios de prueba temporales
    console.log('[1/6] Creando cuentas de prueba en Staging...');
    const adminEmail = `qa-mod-admin-${timestamp}@puntoencuentro.test`;
    const modEmail = `qa-mod-user-${timestamp}@puntoencuentro.test`;
    const hostEmail = `qa-host-${timestamp}@puntoencuentro.test`;

    const { data: uAdmin, error: eAdmin } = await admin.auth.admin.createUser({
      email: adminEmail,
      password: 'SmokePassword123!',
      email_confirm: true,
    });
    if (eAdmin || !uAdmin.user) throw new Error(`Error admin: ${eAdmin?.message}`);
    createdUserIds.push(uAdmin.user.id);

    const { data: uMod, error: eMod } = await admin.auth.admin.createUser({
      email: modEmail,
      password: 'SmokePassword123!',
      email_confirm: true,
    });
    if (eMod || !uMod.user) throw new Error(`Error mod: ${eMod?.message}`);
    createdUserIds.push(uMod.user.id);

    const { data: uHost, error: eHost } = await admin.auth.admin.createUser({
      email: hostEmail,
      password: 'SmokePassword123!',
      email_confirm: true,
    });
    if (eHost || !uHost.user) throw new Error(`Error host: ${eHost?.message}`);
    createdUserIds.push(uHost.user.id);

    // Asignar admin a moderation_authorized_users
    await admin.from('moderation_authorized_users').insert({
      user_id: uAdmin.user.id,
      role: 'admin',
      active: true,
    });

    // Clientes autenticados
    const adminClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await adminClient.auth.signInWithPassword({ email: adminEmail, password: 'SmokePassword123!' });

    const modClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await modClient.auth.signInWithPassword({ email: modEmail, password: 'SmokePassword123!' });

    const hostClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await hostClient.auth.signInWithPassword({ email: hostEmail, password: 'SmokePassword123!' });

    console.log('  ✔ Usuarios y clientes inicializados.');

    // 2. Gestión de moderadores: listar y agregar por email exacto
    console.log('\n[2/6] Probando gestión de moderadores por email exacto...');
    const { data: listBefore } = await adminClient.rpc('listar_moderadores_seguro');
    assert.equal((listBefore as any)?.ok, true);

    const { data: addModRes } = await adminClient.rpc('agregar_moderador_por_email_seguro', {
      p_email: modEmail,
      p_role: 'moderator',
    });
    assert.equal((addModRes as any)?.ok, true);
    assert.equal((addModRes as any)?.user_id, uMod.user.id);
    assert.equal((addModRes as any)?.role, 'moderator');
    console.log('  ✔ Moderador agregado por email exacto exitosamente.');

    // 3. Fallos esperados en alta: usuario inexistente
    console.log('\n[3/6] Probando validaciones defensivas de email...');
    const { data: addNonExistent } = await adminClient.rpc('agregar_moderador_por_email_seguro', {
      p_email: 'inexistente_total_12345@puntoencuentro.test',
      p_role: 'moderator',
    });
    assert.equal((addNonExistent as any)?.ok, false);
    assert.equal((addNonExistent as any)?.error, 'user_not_found');
    console.log('  ✔ Email inexistente rechazado con user_not_found.');

    // 4. Modificación de rol y revocación lógica
    console.log('\n[4/6] Probando actualización de rol y revocación lógica...');
    const { data: roleUpd } = await adminClient.rpc('actualizar_rol_moderador_seguro', {
      p_user_id: uMod.user.id,
      p_role: 'admin',
    });
    assert.equal((roleUpd as any)?.ok, true);
    assert.equal((roleUpd as any)?.role, 'admin');

    const { data: revokeRes } = await adminClient.rpc('revocar_moderador_seguro', {
      p_user_id: uMod.user.id,
    });
    assert.equal((revokeRes as any)?.ok, true);
    assert.equal((revokeRes as any)?.active, false);

    // Verificar en BD que la fila permanece con active = false
    const { data: rowCheck } = await admin
      .from('moderation_authorized_users')
      .select('active')
      .eq('user_id', uMod.user.id)
      .single();
    assert.equal(rowCheck?.active, false, 'La revocación debe ser lógica (active = false)');
    console.log('  ✔ Rol actualizado y revocación lógica verificada (active = false preservado).');

    // Reactivar para siguientes pruebas
    await adminClient.rpc('agregar_moderador_por_email_seguro', {
      p_email: modEmail,
      p_role: 'moderator',
    });

    // 5. Creación de encuentro en review_pending y consulta de cola
    console.log('\n[5/6] Creando encuentro en review y consultando cola de moderación...');
    const { data: enc, error: encErr } = await admin
      .from('encuentros')
      .insert({
        titulo: 'Título Privado Smoke',
        open_public_title: 'Encuentro de Prueba Moderación Staging',
        descripcion: 'Privado',
        open_description: 'Descripción pública de prueba controlada',
        modalidad: 'presencial',
        tipo_invitacion: 'individual',
        fecha: '2026-11-20',
        hora: '19:00',
        lugar_texto: 'Lugar Privado Secreto',
        link_virtual: 'https://secreto.test',
        host_id: uHost.user.id,
        estado: 'activo',
        locality_id: 'guemes',
        open_public_zone: 'Güemes / Playa Grande',
        max_participants: 6,
        is_open: false,
        moderation_status: 'review_pending',
        moderation_reason: 'contains_link',
      })
      .select('id')
      .single();
    if (encErr || !enc) throw new Error(`Error creando encuentro: ${encErr?.message}`);
    createdEncounterIds.push(enc.id);

    // Consultar cola como moderador
    const { data: queueData } = await modClient.rpc('get_moderation_queue_seguro');
    assert.equal((queueData as any)?.ok, true);
    const item = (queueData as any)?.queue?.find((q: any) => q.id === enc.id);
    assert.ok(item, 'El encuentro en review_pending debe figurar en la cola');
    assert.equal(item.open_public_title, 'Encuentro de Prueba Moderación Staging');
    assert.equal(item.open_description, 'Descripción pública de prueba controlada');
    assert.equal(item.modalidad, 'presencial');
    assert.equal(item.open_public_zone, 'Güemes / Playa Grande');
    assert.ok(item.content_hash, 'Debe incluir content_hash');
    // Invariante de privacidad: ningún campo privado expuesto
    assert.equal((item as any).lugar_texto, undefined);
    assert.equal((item as any).link_virtual, undefined);
    console.log('  ✔ Cola proyecta datos públicos correctamente con hash y cero datos privados.');

    // 6. Resolución de moderación y auditoría
    console.log('\n[6/6] Resolviendo moderación (Aprobar) y comprobando efectos...');
    const { data: resolveRes } = await modClient.rpc('resolver_moderacion_encuentro_seguro', {
      p_encuentro_id: enc.id,
      p_action: 'approve',
      p_note: 'Aprobado smoke test staging',
      p_expected_content_hash: item.content_hash,
    });
    assert.equal((resolveRes as any)?.ok, true);
    assert.equal((resolveRes as any)?.is_open, true);
    assert.equal((resolveRes as any)?.moderation_status, 'approved');

    // Comprobar notificación al host en inbox_notifications
    const { data: notif } = await admin
      .from('inbox_notifications')
      .select('notification_type, title, body')
      .eq('recipient_user_id', uHost.user.id)
      .eq('target_id', enc.id)
      .maybeSingle();
    assert.ok(notif, 'El anfitrión debe recibir la notificación en el inbox');
    assert.equal(notif?.notification_type, 'moderation_approved');
    assert.equal(notif?.title, 'Tu encuentro fue aprobado');

    // Comprobar auditoría
    const { data: audit } = await admin
      .from('public_content_moderation_audit')
      .select('action, new_status, metadata')
      .eq('encuentro_id', enc.id)
      .eq('action', 'approve')
      .maybeSingle();
    assert.ok(audit, 'La decisión debe quedar registrada en la auditoría');
    assert.equal(audit?.new_status, 'approved');
    assert.equal(audit?.metadata?.content_hash, item.content_hash);

    console.log('  ✔ Encuentro aprobado, is_open=true, notificación enviada y auditoría registrada.');
    console.log('\n========================================================');
    console.log('SMOKE TEST CIRCUITO DE MODERACIÓN EN STAGING: EXITOSO ✔');
    console.log('========================================================\n');
  } finally {
    console.log('Limpiando datos temporales de Staging...');
    for (const eid of createdEncounterIds) {
      await admin.from('public_content_reports').delete().eq('encuentro_id', eid);
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

runStagingCircuitSmoke().catch((err) => {
  console.error('Error en smoke circuit:', err);
  process.exit(1);
});
