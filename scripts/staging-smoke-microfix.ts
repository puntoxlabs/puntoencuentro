/**
 * Staging Smoke QA — Microfix Post-Integración:
 * 1. Reconfirmación y rotación de token en re-aprobación post-baja voluntaria en PostgreSQL real de Staging.
 * 2. Rate limiting endurecido (fail-closed, aislamiento de identidad y delegación atómica a check_rate_limit_internal).
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

async function runStagingSmokeMicrofix() {
  console.log('================================================================');
  console.log('STAGING SMOKE QA: MICROFIX RECONFIRMACIÓN Y RATE LIMITING');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('================================================================\n');

  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  try {
    // Helper para crear usuarios temporales de QA
    async function createQaUser(prefix: string, name: string) {
      const email = `qa-microfix-${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}@puntoencuentro.test`;
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

    console.log('[1/4] Creando usuarios reales de prueba en Supabase Staging...');
    const host = await createQaUser('host', 'Host QA Microfix');
    const participant = await createQaUser('part', 'Participante QA Microfix');
    const stranger = await createQaUser('stranger', 'Extraño QA Microfix');
    console.log(`   Host: ${host.id}`);
    console.log(`   Participant: ${participant.id}`);
    console.log(`   Stranger: ${stranger.id}\n`);

    // --------------------------------------------------------------------------
    // PARTE 1: VERIFICACIÓN DEL RATE LIMITING ENDURECIDO EN STAGING
    // --------------------------------------------------------------------------
    console.log('[2/4] Verificando Rate Limiting Endurecido (fail-closed y aislamiento de identidad)...');

    // 1. Usuario válido dentro del límite: consume normalmente
    const { data: rlSuccess, error: rlSuccessErr } = await participant.client.rpc('verificar_y_consumir_rate_limit', {
      p_user_id: participant.id,
      p_action: 'join_request',
      p_max: 12,
    });
    assert.ifError(rlSuccessErr);
    assert.equal(rlSuccess.allowed, true, `Usuario legítimo debe ser autorizado: ${JSON.stringify(rlSuccess)}`);

    // 2. Aislamiento de identidad: participante intenta consultar o consumir con ID de stranger -> RECHAZO
    const { data: rlMismatch, error: rlMismatchErr } = await participant.client.rpc('verificar_y_consumir_rate_limit', {
      p_user_id: stranger.id,
      p_action: 'join_request',
      p_max: 12,
    });
    assert.ifError(rlMismatchErr);
    assert.equal(rlMismatch.allowed, false, 'No debe permitir suplantar p_user_id');
    assert.equal(rlMismatch.error, 'user_identity_mismatch');

    // 3. Fail-closed total: acción inexistente sin política persistida -> RECHAZO
    const { data: rlNotFound, error: rlNotFoundErr } = await participant.client.rpc('verificar_y_consumir_rate_limit', {
      p_user_id: participant.id,
      p_action: 'accion_inexistente_total_staging',
      p_max: 5,
    });
    assert.ifError(rlNotFoundErr);
    assert.equal(rlNotFound.allowed, false, 'Acción sin política debe fallar de forma cerrada');
    assert.equal(rlNotFound.error, 'rate_limit_policy_not_found');

    console.log('   -> Rate limiting endurecido validado exitosamente en PostgreSQL real de Staging.\n');

    // --------------------------------------------------------------------------
    // PARTE 2: CICLO COMPLETO DE RECONFIRMACIÓN POST-BAJA
    // --------------------------------------------------------------------------
    console.log('[3/4] Verificando Reconfirmación y Rotación de Token tras Re-Aprobación...');

    // Crear encuentro abierto
    const { data: encData, error: encErr } = await admin
      .from('encuentros')
      .insert({
        host_id: host.id,
        titulo: 'Encuentro QA Microfix Reconf',
        open_public_title: 'Encuentro QA Microfix Reconf',
        descripcion: 'Validación de reconfirmación y rotación de tokens en Staging',
        fecha: '2026-12-10',
        hora: '19:00:00',
        modalidad: 'presencial',
        lugar_texto: 'Av. Libertador 5000, CABA',
        link_virtual: null,
        tipo_invitacion: 'individual',
        invitation_template: 'default',
        locality_id: 'centro',
        open_public_zone: 'Centro',
        estado: 'activo',
        is_open: true,
        max_participants: 6,
        min_participants: 2,
        realization_status: 'pending',
        allow_multi_seat_requests: true,
        max_seats_per_request: 4,
        min_seats_per_request: 1,
        moderation_status: 'approved',
      })
      .select('id')
      .single();
    if (encErr || !encData) {
      throw new Error(`Error creando encuentro en Staging: ${encErr?.message}`);
    }
    const encId = encData.id;
    createdEncounterIds.push(encId);

    // 1. Solicitud inicial del participante (2 cupos)
    const { data: req1Data, error: req1Err } = await participant.client.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encId,
      p_nombre: 'Participante QA',
      p_mensaje: 'Hola, primera solicitud',
      p_seat_count: 2,
    });
    assert.ifError(req1Err);
    assert.equal(req1Data.ok, true, `Fallo en solicitud inicial: ${JSON.stringify(req1Data)}`);
    const req1Id = req1Data.request_id;

    // 2. Primera aprobación por el anfitrión
    const { data: app1Data, error: app1Err } = await host.client.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: req1Id,
    });
    assert.ifError(app1Err);
    assert.equal(app1Data.ok, true, `Fallo en primera aprobación: ${JSON.stringify(app1Data)}`);
    const firstToken = app1Data.token_invitacion;
    const participantRowId = app1Data.participante_id;
    assert.ok(firstToken, 'Debe emitir token');

    // 3. Reconfirmación de asistencia por el participante
    const { data: reconfData, error: reconfErr } = await participant.client.rpc('reconfirmar_asistencia_seguro', {
      p_encuentro_id: encId,
      p_decision: 'confirm',
      p_motivo: null,
    });
    assert.ifError(reconfErr);
    assert.equal(reconfData.ok, true);
    assert.equal(reconfData.reconfirmation_status, 'confirmed');

    // Verificar en BD que el registro quedó confirmed
    const { data: partRow1 } = await admin
      .from('participantes')
      .select('id, estado, reconfirmation_status, reconfirmed_at, token_invitacion')
      .eq('id', participantRowId)
      .single();
    assert.equal(partRow1?.reconfirmation_status, 'confirmed');
    assert.ok(partRow1?.reconfirmed_at !== null, 'reconfirmed_at debe tener fecha tras confirmación');

    // 4. Baja voluntaria del participante con motivo privado
    const { data: declineData, error: declineErr } = await participant.client.rpc('desistir_encuentro_abierto_seguro', {
      p_encuentro_id: encId,
      p_motivo: 'Motivo privado de prueba QA',
    });
    assert.ifError(declineErr);
    assert.equal(declineData.ok, true);
    assert.equal(declineData.reconfirmation_status, 'declined');

    // Verificar en BD que el participante pasó a cancelado/declined y la solicitud guardó motivo_baja
    const { data: partRowDecline } = await admin
      .from('participantes')
      .select('estado, reconfirmation_status')
      .eq('id', participantRowId)
      .single();
    assert.equal(partRowDecline?.estado, 'cancelado');
    assert.equal(partRowDecline?.reconfirmation_status, 'declined');

    const { data: req1Row } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado, motivo_baja')
      .eq('id', req1Id)
      .single();
    assert.equal(req1Row?.estado, 'cancelled');
    assert.equal(req1Row?.motivo_baja, 'Motivo privado de prueba QA');

    // 5. Nueva solicitud de participación (re-postulación con 3 cupos)
    const { data: req2Data, error: req2Err } = await participant.client.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encId,
      p_nombre: 'Participante QA Re',
      p_mensaje: 'Hola nuevamente, re-postulación',
      p_seat_count: 3,
    });
    assert.ifError(req2Err);
    assert.equal(req2Data.ok, true, `Fallo en re-postulación: ${JSON.stringify(req2Data)}`);
    const req2Id = req2Data.request_id;

    // 6. Segunda aprobación por el anfitrión
    const { data: app2Data, error: app2Err } = await host.client.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: req2Id,
    });
    assert.ifError(app2Err);
    assert.equal(app2Data.ok, true, `Fallo en segunda aprobación: ${JSON.stringify(app2Data)}`);
    const secondToken = app2Data.token_invitacion;

    // 7. VERIFICACIÓN CRÍTICA EN BASE DE DATOS REAL DE STAGING:
    // reconfirmation_status = 'pending' y reconfirmed_at IS NULL
    const { data: partRow2 } = await admin
      .from('participantes')
      .select('id, estado, reconfirmation_status, reconfirmed_at, seat_count, token_invitacion')
      .eq('id', participantRowId)
      .single();

    assert.equal(partRow2?.estado, 'confirmado', 'El estado del participante debe ser confirmado');
    assert.equal(
      partRow2?.reconfirmation_status,
      'pending',
      'CRÍTICO: reconfirmation_status DEBE reiniciarse a "pending" en la segunda aprobación'
    );
    assert.equal(
      partRow2?.reconfirmed_at,
      null,
      'CRÍTICO: reconfirmed_at DEBE ser NULL tras una segunda aprobación'
    );
    assert.equal(partRow2?.seat_count, 3, 'seat_count debe estar sincronizado con la nueva solicitud (3 cupos)');

    // 8. Rotación estricta de token: el token de ciclo anterior debe estar invalidado
    assert.notEqual(secondToken, firstToken, 'El token de participación DEBE haberse rotado');
    assert.equal(partRow2?.token_invitacion, secondToken, 'El token en BD debe coincidir con el nuevo token rotado');

    // 9. Historial del ciclo anterior intacto
    const { data: req1RowFinal } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado, motivo_baja')
      .eq('id', req1Id)
      .single();
    assert.equal(req1RowFinal?.estado, 'cancelled');
    assert.equal(req1RowFinal?.motivo_baja, 'Motivo privado de prueba QA', 'El motivo histórico anterior no se perdió');

    // 10. Idempotencia de la segunda aprobación: volver a llamar devuelve already_approved sin regenerar token
    const { data: app2Idemp } = await host.client.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: req2Id,
    });
    assert.equal(app2Idemp.ok, true);
    assert.equal(app2Idemp.already_approved, true);
    assert.equal(app2Idemp.token_invitacion, secondToken);

    console.log('   -> Reconfirmación pendiente y rotación de tokens verificada exitosamente en Staging.\n');

    // --------------------------------------------------------------------------
    // PARTE 3: PARIDAD DE ESQUEMA EN TABLAS FÍSICAS DE STAGING
    // --------------------------------------------------------------------------
    console.log('[4/4] Comprobando paridad de esquema contra PostgreSQL real...');
    const { data: partSample } = await admin.from('participantes').select('*').limit(1);
    if (partSample && partSample.length > 0) {
      const actualCols = Object.keys(partSample[0]);
      assert.ok(!actualCols.includes('rol'), 'public.participantes NO debe tener columna rol');
      assert.ok(!actualCols.includes('created_at'), 'public.participantes NO debe tener columna created_at');
      assert.ok(!actualCols.includes('updated_at'), 'public.participantes NO debe tener columna updated_at');
      assert.ok(actualCols.includes('reconfirmation_status'), 'public.participantes DEBE tener reconfirmation_status');
      assert.ok(actualCols.includes('reconfirmed_at'), 'public.participantes DEBE tener reconfirmed_at');
      assert.ok(actualCols.includes('creado_en'), 'public.participantes DEBE tener creado_en');
    }
    console.log('   -> Paridad de esquema en Staging confirmada al 100%.\n');

    console.log('================================================================');
    console.log('✅ TODAS LAS PRUEBAS DE STAGING SMOKE QA PASARON AL 100%');
    console.log('================================================================\n');
  } finally {
    console.log('Limpiando fixtures de prueba en Supabase Staging...');
    if (createdEncounterIds.length > 0) {
      await admin.from('solicitudes_encuentro_abierto').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('participantes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('inbox_notifications').delete().in('target_id', createdEncounterIds);
      await admin.from('domain_events_outbox').delete().in('aggregate_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    for (const uid of createdUserIds) {
      try {
        await admin.auth.admin.deleteUser(uid);
      } catch (delErr: any) {
        console.warn(`Error eliminando usuario QA ${uid}:`, delErr?.message);
      }
    }
    console.log('Limpieza de fixtures en Staging completada con éxito.\n');
  }
}

runStagingSmokeMicrofix().catch((err) => {
  console.error('\n❌ ERROR EN STAGING SMOKE QA MICROFIX:', err);
  process.exit(1);
});
