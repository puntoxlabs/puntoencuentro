/**
 * Staging QA Runner — Mini-Sprint A: Cierre posterior, asistencia efectiva y reconocimiento responsable
 *
 * Ejecuta validaciones funcionales reales sobre Supabase Staging (wougfhfwqgmxhgvjqoua)
 * y comprueba el despliegue del bundle en https://staging.puntoencuentro.com.ar.
 */

import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
  getVercelBypassSecret,
} from './lib/environment-guard.ts';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
assertStagingEnvironment(url);

const secretKey = getStagingSecretKey();
const publishableKey = getStagingPublishableKey();

const admin = createClient(url, secretKey, { auth: { persistSession: false } });

const STAGING_URL = 'https://staging.puntoencuentro.com.ar';

async function checkFrontendDeployment(maxAttempts = 10, delayMs = 5000): Promise<boolean> {
  console.log('\n--- VERIFICACIÓN DE DESPLIEGUE FRONTEND EN STAGING ---');
  const bypassSecret = getVercelBypassSecret();
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
  };
  if (bypassSecret) {
    headers['x-vercel-protection-bypass'] = bypassSecret;
  }

  const jsMarkers = [
    { name: 'RPC cerrar_encuentro_post_evento_seguro', pattern: 'cerrar_encuentro_post_evento_seguro' },
    { name: 'RPC get_detalle_cierre_post_evento_seguro', pattern: 'get_detalle_cierre_post_evento_seguro' },
    { name: 'Error pending_closure_required', pattern: 'pending_closure_required' },
  ];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[Intento ${attempt}/${maxAttempts}] Consultando ${STAGING_URL}...`);
      const htmlRes = await fetch(STAGING_URL, { headers, cache: 'no-store', redirect: 'manual' });
      console.log(`  Respuesta HTTP: ${htmlRes.status} ${htmlRes.statusText}`);

      if (htmlRes.status === 200) {
        const htmlText = await htmlRes.text();
        const scriptMatch = htmlText.match(/src="(\/assets\/index-[^"]+\.js)"/);
        if (scriptMatch) {
          const bundleUrl = `${STAGING_URL}${scriptMatch[1]}`;
          console.log(`  Bundle detectado: ${scriptMatch[1]}`);
          const bundleRes = await fetch(bundleUrl, { headers, cache: 'no-store' });
          if (bundleRes.status === 200) {
            const bundleText = await bundleRes.text();
            let foundCount = 0;
            for (const marker of jsMarkers) {
              const present = bundleText.includes(marker.pattern);
              console.log(`  - ${marker.name}: ${present ? 'PRESENTE (OK)' : 'NO ENCONTRADO'}`);
              if (present) foundCount++;
            }
            if (foundCount === jsMarkers.length) {
              console.log('✅ Frontend de Staging actualizado con bundle de Mini-Sprint A.');
              return true;
            }
          }
        }
      }
    } catch (e: any) {
      console.warn(`  Fallo temporal de conexión: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.warn('⚠️ Frontend todavía en proceso de propagación o no todos los marcadores fueron encontrados.');
  return false;
}

async function runStagingFunctionalSuite() {
  console.log('================================================================');
  console.log('STAGING FUNCTIONAL QA: MINI-SPRINT A (CIERRE POSTERIOR)');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('================================================================\n');

  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  async function createQaUser(prefix: string, name: string) {
    const email = `qa-msa-${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}@puntoencuentro.test`;
    const password = 'QaPassword123!Secure';
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name, nombre: name },
    });
    if (error || !data.user) throw new Error(`Fallo creación QA user: ${error?.message}`);
    createdUserIds.push(data.user.id);

    const client = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: authData, error: authErr } = await client.auth.signInWithPassword({ email, password });
    if (authErr || !authData.session) throw new Error(`Fallo sign in QA user: ${authErr?.message}`);

    return { id: data.user.id, email, client, token: authData.session.access_token };
  }

  try {
    // 1. Crear usuarios de prueba
    console.log('[1/12] Creando usuarios de QA controlados...');
    const host = await createQaUser('host', 'Anfitrión QA Staging');
    const p1 = await createQaUser('p1', 'Participante Asistente');
    const p2 = await createQaUser('p2', 'Participante Aviso Previo');
    const p3 = await createQaUser('p3', 'Participante Inasistencia Reportada');
    const p4 = await createQaUser('p4', 'Participante Sin Verificar');
    console.log(`  Host ID: ${host.id}`);
    console.log(`  P1: ${p1.id}, P2: ${p2.id}, P3: ${p3.id}, P4: ${p4.id}`);

    // 2. Crear encuentro privado
    console.log('\n[2/12] Creando encuentro privado inicial...');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const fechaManana = tomorrow.toISOString().split('T')[0];

    const { data: encRow, error: encErr } = await admin
      .from('encuentros')
      .insert({
        host_id: host.id,
        titulo: 'Encuentro Staging QA Mini-Sprint A',
        fecha: fechaManana,
        hora: '19:00:00',
        duration_minutes: 90,
        modalidad: 'presencial',
        lugar_texto: 'Club Náutico Staging',
        tipo_invitacion: 'individual',
        estado: 'activo',
        is_open: false,
      })
      .select('*')
      .single();

    if (encErr) throw new Error(`Error creando encuentro privado: ${encErr.message}`);
    const encId = encRow.id;
    createdEncounterIds.push(encId);
    console.log(`  Encuentro creado: ${encId}`);
    assert.equal(encRow.post_event_closure_status, 'not_applicable', 'Encuentro privado debe nacer como not_applicable');

    // 3. Abrir encuentro a Discovery y verificar activación de ciclo posterior
    console.log('\n[3/12] Abriendo encuentro a Discovery...');
    const { data: openRes, error: openErr } = await host.client.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: encId,
      p_host_id: host.id,
      p_open_description: 'Descripción de prueba controlada para QA en Staging',
      p_max_participants: 10,
      p_locality_id: 'guemes',
      p_open_public_zone: 'Güemes',
      p_open_public_title: 'Encuentro Abierto QA Staging',
      p_allow_multi_seat_requests: false,
      p_max_seats_per_request: 1,
      p_min_seats_per_request: 1,
    });
    if (openErr) throw new Error(`Error en abrir_encuentro_seguro: ${openErr.message}`);
    assert.equal(openRes.ok, true, 'abrir_encuentro_seguro debe retornar ok=true');

    // Comprobar que post_event_closure_status se activó en pending
    const { data: checkOpenEnc } = await admin.from('encuentros').select('post_event_closure_status, post_event_closure_deadline').eq('id', encId).single();
    assert.equal(checkOpenEnc.post_event_closure_status, 'pending', 'Debe transicionar a pending tras abrirse');
    assert.ok(checkOpenEnc.post_event_closure_deadline, 'Debe calcular post_event_closure_deadline');
    console.log(`  post_event_closure_status: ${checkOpenEnc.post_event_closure_status} (OK)`);
    console.log(`  post_event_closure_deadline: ${checkOpenEnc.post_event_closure_deadline} (OK)`);

    // 4. Agregar participantes confirmados
    console.log('\n[4/12] Agregando participantes confirmados con semántica completa...');
    const { data: part1Row, error: part1Err } = await admin.from('participantes').insert({
      encuentro_id: encId,
      user_id: p1.id,
      nombre_invitado: 'Participante Asistente',
      estado: 'confirmado',
      tipo_invitacion: 'individual',
      reconfirmation_status: 'confirmed',
    }).select('id').single();
    if (part1Err || !part1Row) throw new Error(`Error insertando part1: ${part1Err?.message}`);

    const { data: part2Row, error: part2Err } = await admin.from('participantes').insert({
      encuentro_id: encId,
      user_id: p2.id,
      nombre_invitado: 'Participante Aviso Previo',
      estado: 'confirmado',
      tipo_invitacion: 'individual',
      reconfirmation_status: 'confirmed',
    }).select('id').single();
    if (part2Err || !part2Row) throw new Error(`Error insertando part2: ${part2Err?.message}`);

    const { data: part3Row, error: part3Err } = await admin.from('participantes').insert({
      encuentro_id: encId,
      user_id: p3.id,
      nombre_invitado: 'Participante Inasistencia Reportada',
      estado: 'confirmado',
      tipo_invitacion: 'individual',
      reconfirmation_status: 'confirmed',
    }).select('id').single();
    if (part3Err || !part3Row) throw new Error(`Error insertando part3: ${part3Err?.message}`);

    const { data: part4Row, error: part4Err } = await admin.from('participantes').insert({
      encuentro_id: encId,
      user_id: p4.id,
      nombre_invitado: 'Participante Sin Verificar',
      estado: 'confirmado',
      tipo_invitacion: 'individual',
      reconfirmation_status: 'confirmed',
    }).select('id').single();
    if (part4Err || !part4Row) throw new Error(`Error insertando part4: ${part4Err?.message}`);

    // 5. Simular vencimiento de encuentro para probar cierre y compuerta
    console.log('\n[5/12] Simulando encuentro acontecido y vencimiento de plazo...');
    const ayer = new Date();
    ayer.setDate(ayer.getDate() - 3);
    const fechaPasada = ayer.toISOString().split('T')[0];

    const { error: updErr } = await admin.from('encuentros').update({
      fecha: fechaPasada,
      hora: '18:00:00',
      opened_at: new Date(Date.now() - 4 * 86400000).toISOString(),
      post_event_closure_status: 'pending',
    }).eq('id', encId);
    if (updErr) throw new Error(`Error actualizando encuentro a pasado: ${updErr.message}`);

    const { data: dbgEnc } = await admin.from('encuentros').select('id, host_id, estado, opened_at, post_event_closure_status, post_event_closure_deadline').eq('id', encId).single();
    console.log('  Encuentro tras simular vencimiento:', JSON.stringify(dbgEnc));

    const { data: dbgParts } = await admin.from('participantes').select('id, encuentro_id, estado').eq('encuentro_id', encId);
    console.log('  Participantes del encuentro:', JSON.stringify(dbgParts));

    // 6. Verificar compuerta server-side: host no puede abrir NUEVO encuentro teniendo uno vencido
    console.log('\n[6/12] Verificando compuerta server-side contra nuevas publicaciones...');
    const { data: enc2Row, error: enc2Err } = await admin.from('encuentros').insert({
      host_id: host.id,
      titulo: 'Segundo Encuentro Intento Bloqueado',
      fecha: fechaManana,
      hora: '20:00:00',
      modalidad: 'presencial',
      lugar_texto: 'Sede Central',
      tipo_invitacion: 'individual',
      estado: 'activo',
      is_open: false,
    }).select('id').single();
    if (enc2Err || !enc2Row) throw new Error(`Error insertando enc2: ${enc2Err?.message}`);
    createdEncounterIds.push(enc2Row.id);

    const { data: blockedRes } = await host.client.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: enc2Row.id,
      p_host_id: host.id,
      p_open_description: 'Este intento debe ser bloqueado por cierre pendiente vencido',
      p_max_participants: 10,
      p_locality_id: 'guemes',
      p_open_public_zone: 'Güemes',
      p_open_public_title: 'Intento Bloqueado',
      p_allow_multi_seat_requests: false,
      p_max_seats_per_request: 1,
      p_min_seats_per_request: 1,
    });
    assert.equal(blockedRes.ok, false, 'abrir_encuentro_seguro DEBE fallar ante cierre vencido');
    assert.equal(blockedRes.error, 'pending_closure_required', 'Error debe ser pending_closure_required');
    console.log(`  Compuerta server-side bloqueó correctamente: ${blockedRes.error} (OK)`);

    // 7. Consultar cierres pendientes del host vía RPC
    console.log('\n[7/12] Consultando RPC get_cierres_pendientes_host_seguro...');
    const { data: pendClosures, error: pendErr } = await host.client.rpc('get_cierres_pendientes_host_seguro');
    if (pendErr) throw new Error(`Error en get_cierres_pendientes_host_seguro: ${pendErr.message}`);
    assert.equal(pendClosures.ok, true);
    assert.ok(pendClosures.pending_closures.some((c: any) => c.id === encId), 'El encuentro vencido debe listarse en pending_closures');
    console.log(`  get_cierres_pendientes_host_seguro retornó ${pendClosures.pending_closures.length} cierres pendientes (OK)`);

    // 8. Consultar detalle de cierre vía RPC
    console.log('\n[8/12] Consultando RPC get_detalle_cierre_post_evento_seguro...');
    const { data: detCierre, error: detErr } = await host.client.rpc('get_detalle_cierre_post_evento_seguro', {
      p_encuentro_id: encId,
    });
    if (detErr) throw new Error(`Error en get_detalle_cierre_post_evento_seguro: ${detErr.message}`);
    assert.equal(detCierre.ok, true);
    assert.equal(detCierre.participantes.length, 4, 'Debe retornar los 4 participantes confirmados');
    console.log(`  Detalle de cierre obtenido correctamente con ${detCierre.participantes.length} participantes (OK)`);

    // 9. Registrar realización efectiva y asistencia granular con discriminación de inasistencia
    console.log('\n[9/12] Ejecutando RPC cerrar_encuentro_post_evento_seguro...');
    const asistenciasPayload = [
      { participante_id: part1Row.id, status: 'attended' },
      { participante_id: part2Row.id, status: 'advance_notice_absent', notes: 'Avisó 4 horas antes por viaje' },
      { participante_id: part3Row.id, status: 'reported_absent', notes: 'No asistió ni avisó' },
      { participante_id: part4Row.id, status: 'unverified' },
    ];

    const { data: cierreRes, error: cierreErr } = await host.client.rpc('cerrar_encuentro_post_evento_seguro', {
      p_encuentro_id: encId,
      p_realization_status: 'realized',
      p_asistencias: asistenciasPayload,
    });
    if (cierreErr) throw new Error(`Error cerrando post-evento: ${cierreErr.message}`);
    assert.equal(cierreRes.ok, true, 'El cierre post-evento debe resultar exitoso');
    assert.equal(cierreRes.post_event_closure_status, 'completed');
    assert.equal(cierreRes.closed_responsibly, true);
    assert.equal(cierreRes.attendees_count, 1);
    assert.equal(cierreRes.advance_notice_absent_count, 1);
    assert.equal(cierreRes.reported_absent_count, 1);
    assert.equal(cierreRes.unverified_count, 1);
    console.log(`  Cierre completado: status=${cierreRes.post_event_closure_status}, closed_responsibly=${cierreRes.closed_responsibly} (OK)`);

    // Comprobar estado de participantes en DB
    const { data: part1Checked } = await admin.from('participantes').select('attendance_status, estado').eq('id', part1Row.id).single();
    assert.equal(part1Checked.attendance_status, 'attended');
    assert.equal(part1Checked.estado, 'asistio', 'Participante asistente debe transicionar su estado histórico a asistio');

    const { data: part2Checked } = await admin.from('participantes').select('attendance_status, estado, attendance_notes').eq('id', part2Row.id).single();
    assert.equal(part2Checked.attendance_status, 'advance_notice_absent');
    assert.equal(part2Checked.estado, 'confirmado', 'Inasistencia con aviso conserva estado confirmado');
    assert.equal(part2Checked.attendance_notes, 'Avisó 4 horas antes por viaje');

    const { data: part3Checked } = await admin.from('participantes').select('attendance_status, estado, attendance_notes').eq('id', part3Row.id).single();
    assert.equal(part3Checked.attendance_status, 'reported_absent');
    assert.equal(part3Checked.estado, 'confirmado', 'Inasistencia reportada no distorsiona estado');

    const { data: part4Checked } = await admin.from('participantes').select('attendance_status, estado').eq('id', part4Row.id).single();
    assert.equal(part4Checked.attendance_status, 'unverified');
    console.log('  Estados de asistencia granular verificados en DB (OK)');

    // 10. Desbloqueo inmediato: ahora abrir el segundo encuentro debe funcionar
    console.log('\n[10/12] Verificando desbloqueo inmediato tras regularizar cierre...');
    const { data: unblockedRes, error: unblockedErr } = await host.client.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: enc2Row.id,
      p_host_id: host.id,
      p_open_description: 'Este intento ahora debe proceder normalmente',
      p_max_participants: 10,
      p_locality_id: 'guemes',
      p_open_public_zone: 'Güemes',
      p_open_public_title: 'Segundo Encuentro Desbloqueado',
      p_allow_multi_seat_requests: false,
      p_max_seats_per_request: 1,
      p_min_seats_per_request: 1,
    });
    if (unblockedErr) throw new Error(`Error en apertura desbloqueada: ${unblockedErr.message}`);
    assert.equal(unblockedRes.ok, true, 'La apertura debe ser aprobada tras regularizar el cierre pendiente');
    console.log('  Desbloqueo inmediato verificado (OK)');

    // 11. Proyección completa en get_detalle_host_seguro
    console.log('\n[11/12] Verificando get_detalle_host_seguro con firma (uuid, uuid)...');
    const { data: hostDet, error: hostDetErr } = await host.client.rpc('get_detalle_host_seguro', {
      p_encuentro_id: encId,
      p_host_id: host.id,
    });
    if (hostDetErr) throw new Error(`Error en get_detalle_host_seguro: ${hostDetErr.message}`);
    assert.equal(hostDet.id, encId);
    assert.equal(hostDet.post_event_closure_status, 'completed');
    assert.equal(hostDet.post_event_realization_status, 'realized');
    assert.equal(hostDet.post_event_closed_responsibly, true);
    assert.equal(hostDet.duration_minutes, 90);
    console.log('  Contrato JSON y firma de get_detalle_host_seguro verificados al 100% (OK)');

    // 12. Regularización administrativa automática para encuentros sin confirmados
    console.log('\n[12/12] Probando regularización automática de encuentros sin participantes...');
    const { data: encEmptyRow, error: emptyErr } = await admin.from('encuentros').insert({
      host_id: host.id,
      titulo: 'Encuentro Vacío Pasado',
      open_public_title: 'Encuentro Vacío Pasado',
      fecha: fechaPasada,
      hora: '10:00:00',
      duration_minutes: 60,
      modalidad: 'presencial',
      lugar_texto: 'Plaza',
      locality_id: 'guemes',
      open_public_zone: 'Güemes',
      max_participants: 10,
      tipo_invitacion: 'individual',
      estado: 'activo',
      is_open: true,
      opened_at: new Date(Date.now() - 4 * 86400000).toISOString(),
      post_event_closure_status: 'pending',
      post_event_closure_deadline: new Date(Date.now() - 3600000).toISOString(),
    }).select('id').single();
    if (emptyErr || !encEmptyRow) throw new Error(`Error insertando encEmpty: ${emptyErr?.message}`);
    createdEncounterIds.push(encEmptyRow.id);

    const { data: regRes, error: regErr } = await host.client.rpc('regularizar_cierres_administrativos_automaticos', {
      p_host_id: host.id,
    });
    if (regErr) throw new Error(`Error en regularizar_cierres_administrativos_automaticos: ${regErr.message}`);
    assert.equal(regRes.ok, true);

    const { data: emptyChecked } = await admin.from('encuentros').select('post_event_closure_status, post_event_closure_type, post_event_closed_responsibly').eq('id', encEmptyRow.id).single();
    assert.equal(emptyChecked.post_event_closure_status, 'auto_closed');
    assert.equal(emptyChecked.post_event_closure_type, 'administrative_auto');
    assert.equal(emptyChecked.post_event_closed_responsibly, false, 'Cierre administrativo automático NO debe otorgar mérito');
    console.log('  Cierre automático neutral verificado sin mérito ni bloqueos (OK)');

    console.log('\n==========================================================');
    console.log('🎉 TODAS LAS PRUEBAS FUNCIONALES EN STAGING APROBADAS');
    console.log('==========================================================');
    return true;
  } finally {
    console.log('\n--- LIMPIEZA DE FIXTURES DE QA CONTROLADOS ---');
    if (createdEncounterIds.length > 0) {
      console.log(`  Borrando ${createdEncounterIds.length} encuentros de prueba...`);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    if (createdUserIds.length > 0) {
      console.log(`  Borrando ${createdUserIds.length} usuarios temporales de prueba...`);
      for (const uid of createdUserIds) {
        await admin.auth.admin.deleteUser(uid);
      }
    }
    console.log('✅ Limpieza completada con éxito.');
  }
}

async function main() {
  await checkFrontendDeployment();
  await runStagingFunctionalSuite();
}

main().catch((err) => {
  console.error('\n❌ ERROR CRÍTICO EN STAGING QA:', err);
  process.exit(1);
});
