/**
 * Staging Smoke QA — Bloque P0: Comunicaciones Críticas e Integridad de Estados (H1, H5, H8)
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

async function runStagingSmokeP0() {
  console.log('========================================================');
  console.log('STAGING SMOKE QA: COMUNICACIONES CRÍTICAS E INTEGRIDAD P0');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('========================================================\n');

  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  try {
    // Helper para crear usuarios temporales de QA
    async function createQaUser(prefix: string, name: string) {
      const email = `qa-p0-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}@puntoencuentro.test`;
      const password = 'QaPassword123!Secure';
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name },
      });
      if (error || !data.user) {
        throw new Error(`Error creando usuario QA (${prefix}): ${error?.message}`);
      }
      createdUserIds.push(data.user.id);

      const client = createClient(url, publishableKey, { auth: { persistSession: false } });
      const { data: authData, error: authErr } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (authErr || !authData.session) {
        throw new Error(`Error autenticando usuario QA (${prefix}): ${authErr?.message}`);
      }

      return {
        id: data.user.id,
        email,
        client,
      };
    }

    console.log('[1/10] Creando usuarios reales de prueba en Staging...');
    const host = await createQaUser('host', 'Organizador QA P0');
    const participant = await createQaUser('part', 'Participante QA P0');
    const applicant = await createQaUser('appl', 'Solicitante QA P0');
    const outsider = await createQaUser('out', 'Usuario Ajeno QA P0');
    console.log(`   Host: ${host.id}`);
    console.log(`   Participante: ${participant.id}`);
    console.log(`   Solicitante: ${applicant.id}`);
    console.log(`   Ajeno: ${outsider.id}\n`);

    // Helper para crear un encuentro de prueba
    async function createEncounter(titulo: string, isOpen: boolean = true) {
      const { data, error } = await admin
        .from('encuentros')
        .insert({
          host_id: host.id,
          titulo,
          open_public_title: titulo,
          descripcion: 'Descripción QA',
          fecha: '2026-11-20',
          hora: '18:00:00',
          modalidad: 'presencial',
          lugar_texto: 'Av. Corrientes 1234, Piso 2 (Privado)',
          tipo_invitacion: 'individual',
          invitation_template: 'default',
          locality_id: 'centro',
          open_public_zone: 'Centro / La Perla',
          is_open: isOpen,
          estado: 'activo',
          max_participants: 6,
        })
        .select('id')
        .single();
      if (error || !data) {
        throw new Error(`Error creando encuentro QA: ${error?.message}`);
      }
      createdEncounterIds.push(data.id);
      return data.id;
    }

    const encId = await createEncounter('Encuentro QA P0 Comunicaciones');
    console.log(`[2/10] Encuentro creado: ${encId}`);

    // Agregar participante confirmado
    const { error: partErr } = await admin.from('participantes').insert({
      encuentro_id: encId,
      user_id: participant.id,
      nombre_invitado: 'Participante QA',
      estado: 'confirmado',
      tipo_invitacion: 'individual',
      seat_count: 1,
    });
    if (partErr) throw new Error(`Error insertando participante: ${partErr.message}`);

    // Agregar solicitante pendiente
    const { error: solErr } = await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: encId,
      usuario_id: applicant.id,
      nombre_solicitante: 'Solicitante QA',
      estado: 'pending',
    });
    if (solErr) throw new Error(`Error insertando solicitante: ${solErr.message}`);
    console.log('   Participante confirmado y solicitante pendiente vinculados con éxito.\n');

    // --------------------------------------------------------------------------
    // Test 1: Intento de bypass cancelando vía actualizar_encuentro_seguro (H1)
    // --------------------------------------------------------------------------
    console.log('[3/10] H1: Verificando que actualizar_encuentro_seguro rechaza cambios de estado...');
    const { data: bypassRes, error: bypassErr } = await host.client.rpc('actualizar_encuentro_seguro', {
      p_encuentro_id: encId,
      p_host_id: host.id,
      p_data: { estado: 'cancelado' },
    });
    assert.equal(bypassErr, null);
    assert.equal(bypassRes.ok, false);
    assert.equal(bypassRes.error, 'state_transition_not_allowed');
    console.log('   -> Rechazado correctamente con "state_transition_not_allowed".');

    // Comprobar que el encuentro sigue activo
    const { data: checkActive } = await admin.from('encuentros').select('estado').eq('id', encId).single();
    assert.equal(checkActive?.estado, 'activo');
    console.log('   -> Invariante de estado preservada: el encuentro continúa activo.\n');

    // --------------------------------------------------------------------------
    // Test 2: Cambio de fecha y horario notifica a confirmados y solicitantes (H5)
    // --------------------------------------------------------------------------
    console.log('[4/10] H5: Modificando fecha y horario legítimamente...');
    const { data: schedRes, error: schedErr } = await host.client.rpc('actualizar_encuentro_seguro', {
      p_encuentro_id: encId,
      p_host_id: host.id,
      p_data: { fecha: '2026-11-25', hora: '20:00:00' },
    });
    assert.equal(schedErr, null);
    assert.equal(schedRes.ok, true);

    // Confirmado debe recibir notificación crítica
    const { data: notifPartSched } = await admin
      .from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', participant.id)
      .eq('target_id', encId)
      .eq('notification_type', 'encounter_schedule_changed');
    assert.equal(notifPartSched?.length, 1);
    assert.equal(notifPartSched![0].payload.priority, 'critical');
    assert.ok(notifPartSched![0].body.includes('25/11/2026 20:00'));
    console.log('   -> Participante confirmado recibió aviso crítico de reprogramación.');

    // Solicitante pendiente debe recibir aviso público sin dirección privada
    const { data: notifSolSched } = await admin
      .from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', applicant.id)
      .eq('target_id', encId)
      .eq('notification_type', 'encounter_schedule_changed');
    assert.equal(notifSolSched?.length, 1);
    assert.equal(notifSolSched![0].payload.is_applicant, true);
    assert.equal(notifSolSched![0].payload.lugar_texto, undefined);
    console.log('   -> Solicitante pendiente recibió aviso con zona pública y sin datos privados.\n');

    // --------------------------------------------------------------------------
    // Test 3: Cambio de logística (dirección / enlace virtual) (H5)
    // --------------------------------------------------------------------------
    console.log('[5/10] H5: Modificando dirección exacta y enlace virtual...');
    const { data: logRes, error: logErr } = await host.client.rpc('actualizar_encuentro_seguro', {
      p_encuentro_id: encId,
      p_host_id: host.id,
      p_data: {
        lugar_texto: 'Club Social Palermo, Salón B (Nueva Dirección Privada)',
        link_virtual: 'https://meet.jit.si/punto-qa-123',
      },
    });
    assert.equal(logErr, null);
    assert.equal(logRes.ok, true);

    // Confirmado debe recibir notificación de logística
    const { data: notifPartLog } = await admin
      .from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', participant.id)
      .eq('target_id', encId)
      .eq('notification_type', 'encounter_logistics_changed');
    assert.equal(notifPartLog?.length, 1);
    // Privacidad: el payload no expone la dirección innecesariamente
    assert.equal(notifPartLog![0].payload.lugar_texto, undefined);
    console.log('   -> Participante confirmado recibió aviso de actualización de punto de encuentro.');

    // Solicitante NO debe recibir aviso de logística
    const { data: notifSolLog } = await admin
      .from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', applicant.id)
      .eq('target_id', encId)
      .eq('notification_type', 'encounter_logistics_changed');
    assert.equal(notifSolLog?.length, 0);
    console.log('   -> Solicitante pendiente recibió CERO avisos de logística (privacidad garantizada).\n');

    // --------------------------------------------------------------------------
    // Test 4: Ciclos sucesivos A -> B -> A sin colisión de deduplicación (H5)
    // --------------------------------------------------------------------------
    console.log('[6/10] H5: Probando secuencia cíclica A -> B -> A para horario y dirección...');
    // B -> B (mismo horario): NO debe emitir
    await host.client.rpc('actualizar_encuentro_seguro', {
      p_encuentro_id: encId,
      p_host_id: host.id,
      p_data: { hora: '20:00:00' },
    });
    // B -> A (retorno a 18:00:00): DEBE emitir aviso nuevo
    await host.client.rpc('actualizar_encuentro_seguro', {
      p_encuentro_id: encId,
      p_host_id: host.id,
      p_data: { hora: '18:00:00' },
    });

    const { data: cycleSchedNotifs } = await admin
      .from('inbox_notifications')
      .select('body')
      .eq('recipient_user_id', participant.id)
      .eq('target_id', encId)
      .eq('notification_type', 'encounter_schedule_changed')
      .order('created_at', { ascending: true });
    assert.equal(cycleSchedNotifs?.length, 2, 'Debe haber exactamente 2 avisos (inicial + retorno)');
    assert.ok(cycleSchedNotifs![0].body.includes('20:00'));
    assert.ok(cycleSchedNotifs![1].body.includes('18:00'));
    console.log('   -> Ciclo A -> B -> A completado exitosamente: sin colisión de deduplicación.\n');

    // --------------------------------------------------------------------------
    // Test 5: Cancelación canónica con motivo obligatorio (H1)
    // --------------------------------------------------------------------------
    console.log('[7/10] H1: Ejecutando cancelar_encuentro_seguro con motivo obligatorio...');
    // Sin motivo debe fallar
    const { data: cancelFail, error: cancelFailErr } = await host.client.rpc('cancelar_encuentro_seguro', {
      p_encuentro_id: encId,
      p_host_id: host.id,
      p_cancellation_reason: '',
    });
    assert.equal(cancelFailErr, null);
    assert.equal(cancelFail.ok, false);
    assert.equal(cancelFail.error, 'cancellation_reason_required');
    console.log('   -> Cancelación sin motivo rechazada por regla de negocio.');

    // Con motivo debe pasar
    const cancellationReason = 'Tormenta eléctrica y corte de luz en la zona';
    const { data: cancelOk, error: cancelOkErr } = await host.client.rpc('cancelar_encuentro_seguro', {
      p_encuentro_id: encId,
      p_host_id: host.id,
      p_cancellation_reason: cancellationReason,
    });
    assert.equal(cancelOkErr, null);
    assert.equal(cancelOk.ok, true);

    // Participante confirmado recibe aviso de cancelación con motivo
    const { data: cancelNotifs } = await admin
      .from('inbox_notifications')
      .select('*')
      .eq('recipient_user_id', participant.id)
      .eq('target_id', encId)
      .eq('notification_type', 'encounter_cancelled_for_participant');
    assert.equal(cancelNotifs?.length, 1);
    assert.equal(cancelNotifs![0].payload.cancellation_reason, cancellationReason);
    console.log(`   -> Participante recibió notificación crítica de cancelación con motivo: "${cancellationReason}".\n`);

    // --------------------------------------------------------------------------
    // Test 6: get_notificaciones_criticas_no_leidas_seguro y consumo secuencial (H8)
    // --------------------------------------------------------------------------
    console.log('[8/10] H8: Consultando RPC get_notificaciones_criticas_no_leidas_seguro...');
    const { data: critData, error: critErr } = await participant.client.rpc(
      'get_notificaciones_criticas_no_leidas_seguro'
    );
    assert.equal(critErr, null);
    assert.equal(critData.ok, true);
    assert.ok(Array.isArray(critData.data));
    assert.ok(critData.data.length >= 2, `Se esperaban al menos 2 críticas no leídas, obtuvo ${critData.data.length}`);

    // Verificar que todas tienen read_at = null
    assert.ok(critData.data.every((n: any) => n.read_at === null));
    console.log(`   -> Recuperadas ${critData.data.length} notificaciones críticas no leídas.`);

    // Reconocer la primera
    const firstCriticalId = critData.data[0].id;
    const { data: markRes, error: markErr } = await participant.client.rpc('marcar_notificacion_leida_seguro', {
      p_notification_id: firstCriticalId,
    });
    assert.equal(markErr, null);
    assert.equal(markRes.ok, true);

    // Consulta subsecuente devuelve las restantes
    const { data: critAfter } = await participant.client.rpc('get_notificaciones_criticas_no_leidas_seguro');
    assert.equal(critAfter.ok, true);
    assert.equal(critAfter.data.length, critData.data.length - 1);
    assert.equal(critAfter.data.some((n: any) => n.id === firstCriticalId), false);
    console.log('   -> Consumo secuencial verificado: al reconocer una crítica se pasa a la siguiente.\n');

    // --------------------------------------------------------------------------
    // Test 7: Aislamiento estricto de usuario (Seguridad)
    // --------------------------------------------------------------------------
    console.log('[9/10] Seguridad: Verificando aislamiento total entre usuarios...');
    const { data: outsiderCrit, error: outsiderCritErr } = await outsider.client.rpc(
      'get_notificaciones_criticas_no_leidas_seguro'
    );
    assert.equal(outsiderCritErr, null);
    assert.equal(outsiderCrit.ok, true);
    assert.equal(outsiderCrit.data.length, 0);

    // Anónimo sin sesión
    const anonClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: anonCrit, error: anonErr } = await anonClient.rpc('get_notificaciones_criticas_no_leidas_seguro');
    assert.ok(anonErr !== null || anonCrit?.ok === false, 'Debe rechazar al usuario anónimo sin sesión');
    console.log('   -> Usuario ajeno recibe 0 críticas de terceros y anónimo es rechazado por control de acceso.\n');

    // --------------------------------------------------------------------------
    // Test 8: Web Push Outbox y privacidad de carga útil
    // --------------------------------------------------------------------------
    console.log('[10/10] Web Push & Outbox: Verificando que eventos de notificación preservan privacidad...');
    const { data: outboxEvents } = await admin
      .from('domain_events_outbox')
      .select('*')
      .eq('aggregate_id', encId)
      .limit(5);

    if (outboxEvents && outboxEvents.length > 0) {
      for (const evt of outboxEvents) {
        const payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
        // La dirección privada completa nunca debe filtrarse como texto plano en el evento genérico
        assert.equal(payload.lugar_texto, undefined);
      }
      console.log('   -> Eventos outbox validados: Cero filtración de datos privados de logística.');
    } else {
      console.log('   -> Cero eventos residuales en outbox (sistema opera de forma transaccional limpia).');
    }

    console.log('\n========================================================');
    console.log('✅ TODAS LAS PRUEBAS DE STAGING SMOKE P0 FUERON EXITOSAS');
    console.log('========================================================\n');
  } finally {
    // Limpieza de datos temporales de prueba en Staging
    console.log('Limpiando fixtures de prueba en Staging...');
    if (createdEncounterIds.length > 0) {
      await admin.from('solicitudes_encuentro_abierto').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('participantes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('inbox_notifications').delete().in('target_id', createdEncounterIds);
      await admin.from('domain_events_outbox').delete().in('aggregate_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    for (const uid of createdUserIds) {
      await admin.auth.admin.deleteUser(uid);
    }
    console.log('Limpieza completada.\n');
  }
}

runStagingSmokeP0().catch((err) => {
  console.error('\n❌ ERROR CRÍTICO EN STAGING SMOKE QA P0:', err);
  process.exit(1);
});
