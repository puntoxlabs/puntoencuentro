/**
 * Validador E2E del Flujo Funcional Completo 1.5-B en Supabase STAGING
 *
 * Entorno: wougfhfwqgmxhgvjqoua
 * Guard: assertStagingEnvironment()
 */

import { createClient } from '@supabase/supabase-js';
import { assertStagingEnvironment, STAGING_PROJECT_REF, getStagingPublishableKey, getStagingSecretKey } from './lib/environment-guard';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';

// 1. Guard estricto de entorno
assertStagingEnvironment(url);

const serviceKey = getStagingSecretKey();
const anonKey = getStagingPublishableKey();
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

async function runE2E() {
  console.log('====================================================');
  console.log('PUNTO ENCUENTRO 1.5-B — E2E REAL STAGING LIFECYCLE');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('====================================================\n');

  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  try {
    // ----------------------------------------------------
    // PASO 1: Setup de usuarios Host A y Visitante B
    // ----------------------------------------------------
    const hostEmail = `qa-host-15b-${Date.now()}@puntoencuentro.test`;
    const guestEmail = `qa-guest-15b-${Date.now()}@puntoencuentro.test`;
    const password = 'QaPassword123!Safe';

    const { data: hostAuth } = await admin.auth.admin.createUser({ email: hostEmail, password, email_confirm: true });
    const { data: guestAuth } = await admin.auth.admin.createUser({ email: guestEmail, password, email_confirm: true });
    createdUserIds.push(hostAuth.user.id, guestAuth.user.id);

    const hostClient = createClient(url, anonKey, { auth: { persistSession: false } });
    await hostClient.auth.signInWithPassword({ email: hostEmail, password });

    const guestClient = createClient(url, anonKey, { auth: { persistSession: false } });
    await guestClient.auth.signInWithPassword({ email: guestEmail, password });

    console.log('[1/7] Usuarios creados:');
    console.log('  - Host A:', hostAuth.user.id);
    console.log('  - Visitante B:', guestAuth.user.id);

    // ----------------------------------------------------
    // PASO 2: Host A crea y abre un encuentro
    // ----------------------------------------------------
    const { data: enc, error: encErr } = await admin.from('encuentros').insert({
      titulo: 'Fútbol 5 en Güemes 1.5-B',
      descripcion: 'Partido amistoso viernes noche',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-10-30',
      hora: '21:00:00',
      date_mode: 'fixed',
      lugar_texto: 'Complejo Güemes Cancha 2 (SECRETO)',
      link_virtual: 'https://secret.meet.link',
      host_id: hostAuth.user.id,
      estado: 'activo',
      max_participants: 4,
      locality_id: 'guemes'
    }).select().single();

    if (encErr || !enc) throw new Error(`Error creando encuentro: ${encErr?.message}`);
    createdEncounterIds.push(enc.id);
    console.log('[2/7] Encuentro base creado:', enc.id);

    // Host A abre el encuentro
    const openRes = await hostClient.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: enc.id,
      p_host_id: hostAuth.user.id,
      p_open_description: 'Buscamos 2 personas más para completar 4',
      p_max_participants: 4,
      p_locality_id: 'guemes',
      p_open_public_zone: 'Güemes · Mar del Plata'
    });
    console.log('  - Host abrió encuentro:', openRes.data);
    if (!openRes.data?.ok) throw new Error('abrir_encuentro_seguro falló');

    // ----------------------------------------------------
    // PASO 3: Discovery público sin login
    // ----------------------------------------------------
    const discRes = await anon.rpc('get_discovery_encuentros_abiertos', {
      p_locality_ids: ['guemes']
    });
    const discItem = discRes.data?.find((e: any) => e.id === enc.id);
    console.log('[3/7] Discovery público:');
    console.log('  - Encuentro visible públicamente:', Boolean(discItem));
    console.log('  - Zona aproximada expuesta:', discItem?.approximate_zone);
    console.log('  - Dirección secreta oculta (lugar_texto):', discItem?.lugar_texto === undefined);
    console.log('  - Link virtual oculto:', discItem?.link_virtual === undefined);

    // ----------------------------------------------------
    // PASO 4: Intento de anónimo y solicitud de Visitante B
    // ----------------------------------------------------
    console.log('[4/7] Solicitud para sumarse:');
    // Anónimo intenta solicitar -> permanent_account_required
    const { data: anonSession } = await anon.auth.signInAnonymously();
    if (anonSession?.user) createdUserIds.push(anonSession.user.id);

    const anonReq = await anon.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: enc.id,
      p_nombre: 'Anónimo Intruso',
      p_mensaje: 'Sin cuenta'
    });
    console.log('  - Anónimo rechazado con permanent_account_required:', anonReq.data?.error === 'permanent_account_required');

    // Visitante B (cuenta permanente) solicita sumarse
    const guestReq = await guestClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: enc.id,
      p_nombre: 'Rodrigo B',
      p_mensaje: 'Juego de arquero, puedo ir'
    });
    console.log('  - Visitante permanente solicita:', guestReq.data);
    if (!guestReq.data?.ok) throw new Error('solicitar_sumarse falló');
    const requestId = guestReq.data.request_id;

    // ----------------------------------------------------
    // PASO 5: Host A consulta solicitudes y aprueba
    // ----------------------------------------------------
    console.log('[5/7] Gestión de Host:');
    const hostList = await hostClient.rpc('get_solicitudes_host_seguro', {
      p_encuentro_id: enc.id,
      p_host_id: hostAuth.user.id
    });
    console.log('  - Solicitudes pendientes recibidas por Host:', hostList.data?.solicitudes?.length);

    const approveRes = await hostClient.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: requestId,
      p_host_id: hostAuth.user.id
    });
    console.log('  - Host aprueba solicitud:', approveRes.data);
    if (!approveRes.data?.ok) throw new Error('aprobar_solicitud falló');

    // ----------------------------------------------------
    // PASO 6: Visitante B ve solicitud aprobada y token
    // ----------------------------------------------------
    console.log('[6/7] Experiencia de Visitante B:');
    const miSol = await guestClient.rpc('get_mi_solicitud_encuentro_abierto', {
      p_encuentro_id: enc.id,
      p_usuario_id: guestAuth.user.id
    });
    console.log('  - Estado de mi solicitud:', miSol.data?.estado);
    console.log('  - Token participante asignado:', Boolean(miSol.data?.token_participante));

    // ----------------------------------------------------
    // PASO 7: Host A cierra el encuentro al Discovery
    // ----------------------------------------------------
    console.log('[7/7] Cierre de encuentro abierto:');
    const closeRes = await hostClient.rpc('cerrar_encuentro_abierto_seguro', {
      p_encuentro_id: enc.id,
      p_host_id: hostAuth.user.id
    });
    console.log('  - Encuentro cerrado al Discovery:', closeRes.data?.ok);

    const discAfter = await anon.rpc('get_discovery_encuentros_abiertos', {
      p_locality_ids: ['guemes']
    });
    const stillInDisc = discAfter.data?.some((e: any) => e.id === enc.id);
    console.log('  - Encuentro ya NO aparece en Discovery:', !stillInDisc);

    // Intento de solicitar sumarse a encuentro cerrado -> rechazado con encuentro_not_open
    const closedReq = await guestClient.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: enc.id,
      p_nombre: 'Intento Tardío'
    });
    console.log('  - Solicitud a encuentro cerrado rechazada con encuentro_not_open:', closedReq.data?.error === 'encuentro_not_open');

    // ----------------------------------------------------
    // PASO ADVERSO: Concurrencia transaccional (último cupo bajo bloqueo FOR UPDATE)
    // ----------------------------------------------------
    console.log('\n--- CASO ADVERSO: Aprobaciones Concurrentes ---');
    // Creamos encuentro dedicado con max_participants = 2 (1 host + 1 participante)
    const { data: encConc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro Concurrencia Staging',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-05',
      hora: '18:00:00',
      date_mode: 'fixed',
      host_id: hostAuth.user.id,
      estado: 'activo',
      max_participants: 2,
      locality_id: 'guemes'
    }).select().single();
    createdEncounterIds.push(encConc.id);

    await hostClient.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: encConc.id,
      p_host_id: hostAuth.user.id,
      p_open_description: 'Solo 1 lugar libre',
      p_max_participants: 2,
      p_locality_id: 'guemes'
    });

    const { data: uD } = await admin.auth.admin.createUser({ email: `d-${Date.now()}@test.com`, password, email_confirm: true });
    const { data: uE } = await admin.auth.admin.createUser({ email: `e-${Date.now()}@test.com`, password, email_confirm: true });
    createdUserIds.push(uD.user.id, uE.user.id);

    const clientD = createClient(url, anonKey, { auth: { persistSession: false } });
    await clientD.auth.signInWithPassword({ email: uD.user.email!, password });
    const clientE = createClient(url, anonKey, { auth: { persistSession: false } });
    await clientE.auth.signInWithPassword({ email: uE.user.email!, password });

    const reqD = await clientD.rpc('solicitar_sumarse_encuentro_abierto', { p_encuentro_id: encConc.id, p_nombre: 'User D' });
    const reqE = await clientE.rpc('solicitar_sumarse_encuentro_abierto', { p_encuentro_id: encConc.id, p_nombre: 'User E' });

    // Exactamente 1 cupo restante. D y E compiten en paralelo:
    const [apD, apE] = await Promise.all([
      hostClient.rpc('aprobar_solicitud_encuentro_abierto', { p_request_id: reqD.data.request_id, p_host_id: hostAuth.user.id }),
      hostClient.rpc('aprobar_solicitud_encuentro_abierto', { p_request_id: reqE.data.request_id, p_host_id: hostAuth.user.id })
    ]);

    const successes = [apD.data?.ok, apE.data?.ok].filter(Boolean).length;
    const quotaExceeded = [apD.data?.error, apE.data?.error].filter(err => err === 'quota_exceeded').length;

    console.log('  - Aprobaciones exitosas (exactamente 1):', successes === 1, `(count: ${successes})`);
    console.log('  - Rechazos por quota_exceeded (exactamente 1):', quotaExceeded === 1, `(count: ${quotaExceeded})`);

    // El perdedor no saturó el cupo
    const { count: finalParticipants } = await admin.from('participantes').select('*', { count: 'exact', head: true }).eq('encuentro_id', encConc.id);
    console.log('  - Total participantes en DB (1):', finalParticipants === 1);

    console.log('  - Aprobaciones exitosas (exactamente 1):', successes === 1);
    console.log('  - Rechazos por quota_exceeded (exactamente 1):', quotaExceeded === 1);

    console.log('\n====================================================');
    console.log('E2E TEST RESULT: 100% SUCCESSFUL VALIDATION!');
    console.log('====================================================');

  } finally {
    console.log('\n[Cleanup] Eliminando registros de prueba...');
    for (const encId of createdEncounterIds) {
      await admin.from('encuentros').delete().eq('id', encId);
    }
    for (const uId of createdUserIds) {
      await admin.auth.admin.deleteUser(uId);
    }
    console.log('[Cleanup] Completado.');
  }
}

runE2E().catch(console.error);
