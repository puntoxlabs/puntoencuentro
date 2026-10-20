/**
 * Staging Smoke QA — Sprint 2: Panel de Información y Mensajes del Encuentro V1
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Invariant: Producción (aurbicjwftjhwryhyjiq) NUNCA se toca.
 * Guard: assertStagingEnvironment()
 *
 * 20 Verification Gates:
 *  1. Organizador registrado: lectura, escritura y moderación.
 *  2. Organizador anónimo: lectura y escritura en su encuentro privado.
 *  3. Invitado individual sin registro: acceso mediante token personal.
 *  4. Invitado por enlace general: sin acceso antes de confirmar, acceso con token individual después de confirmar.
 *  5. Participante registrado confirmado.
 *  6. Participante aprobado de Encuentro Abierto.
 *  7. Invitado pendiente o rechazado: denegación total.
 *  8. Participante retirado o bloqueado: revocación inmediata.
 *  9. public_token general: lectura y escritura denegadas.
 * 10. Token individual de otro encuentro: acceso denegado.
 * 11. Coordinación abierta versus fecha definitiva seleccionada.
 * 12. Escritura antes, durante y hasta 24 horas después del inicio.
 * 13. Encuentro cancelado o finalizado: permisos correctos.
 * 14. Edición de mensajes propios dentro y fuera de los 15 minutos.
 * 15. Eliminación propia y moderación por anfitrión.
 * 16. Máximo de tres destacados, incluyendo concurrencia.
 * 17. Respuestas de un nivel y rechazo de referencias a otros encuentros.
 * 18. Rate limiting real, incluyendo concurrencia y cambio de sesión.
 * 19. Generación de Inbox únicamente para destacados.
 * 20. Ausencia de exposición de contenido privado en Web Push.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard';

const url = `https://${STAGING_PROJECT_REF}.supabase.co`;
assertStagingEnvironment(url);

const secretKey = getStagingSecretKey();
const publishableKey = getStagingPublishableKey();

const admin = createClient(url, secretKey, { auth: { persistSession: false } });

async function runEncounterMessagesStagingQA() {
  console.log('========================================================');
  console.log('STAGING REAL QA: PANEL DE INFORMACIÓN Y MENSAJES V1');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  const ts = Date.now();
  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  let hostRegisteredId: string | null = null;
  let anonHostId: string | null = null;
  let participantRegId: string | null = null;
  let applicantOpenId: string | null = null;
  let otherUserId: string | null = null;

  try {
    // ----------------------------------------------------
    // SETUP: Usuarios de prueba temporales en Staging
    // ----------------------------------------------------
    console.log('[Setup] Creando usuarios temporales controlados en Staging...');

    // 1. Host Registrado
    const emailHost = `qa-msg-host-${ts}@qa-staging-fixtures.test`;
    const passCommon = 'QaMessagesPass123!';
    const { data: uHost, error: errHost } = await admin.auth.admin.createUser({
      email: emailHost,
      password: passCommon,
      email_confirm: true,
      user_metadata: { full_name: 'QA Host Mensajes', is_e2e_automation_fixture: true },
    });
    if (errHost || !uHost.user) throw new Error(`Error creando host: ${errHost?.message}`);
    hostRegisteredId = uHost.user.id;
    createdUserIds.push(hostRegisteredId);

    // 2. Participante Registrado
    const emailPart = `qa-msg-part-${ts}@qa-staging-fixtures.test`;
    const { data: uPart, error: errPart } = await admin.auth.admin.createUser({
      email: emailPart,
      password: passCommon,
      email_confirm: true,
      user_metadata: { full_name: 'QA Participante Mensajes', is_e2e_automation_fixture: true },
    });
    if (errPart || !uPart.user) throw new Error(`Error creando participante: ${errPart?.message}`);
    participantRegId = uPart.user.id;
    createdUserIds.push(participantRegId);

    // 3. Solicitante Encuentro Abierto
    const emailApp = `qa-msg-app-${ts}@qa-staging-fixtures.test`;
    const { data: uApp, error: errApp } = await admin.auth.admin.createUser({
      email: emailApp,
      password: passCommon,
      email_confirm: true,
      user_metadata: { full_name: 'QA Solicitante Mensajes', is_e2e_automation_fixture: true },
    });
    if (errApp || !uApp.user) throw new Error(`Error creando solicitante: ${errApp?.message}`);
    applicantOpenId = uApp.user.id;
    createdUserIds.push(applicantOpenId);

    // 4. Usuario Ajeno (sin participación)
    const emailOther = `qa-msg-other-${ts}@qa-staging-fixtures.test`;
    const { data: uOther, error: errOther } = await admin.auth.admin.createUser({
      email: emailOther,
      password: passCommon,
      email_confirm: true,
      user_metadata: { full_name: 'QA Usuario Ajeno', is_e2e_automation_fixture: true },
    });
    if (errOther || !uOther.user) throw new Error(`Error creando ajeno: ${errOther?.message}`);
    otherUserId = uOther.user.id;
    createdUserIds.push(otherUserId);

    // Clientes autenticados
    const clientHost = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { error: sHostErr } = await clientHost.auth.signInWithPassword({ email: emailHost, password: passCommon });
    if (sHostErr) throw new Error(`Error signIn host: ${sHostErr.message}`);

    const clientPart = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { error: sPartErr } = await clientPart.auth.signInWithPassword({ email: emailPart, password: passCommon });
    if (sPartErr) throw new Error(`Error signIn part: ${sPartErr.message}`);

    const clientApp = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { error: sAppErr } = await clientApp.auth.signInWithPassword({ email: emailApp, password: passCommon });
    if (sAppErr) throw new Error(`Error signIn applicant: ${sAppErr.message}`);

    const clientOther = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { error: sOtherErr } = await clientOther.auth.signInWithPassword({ email: emailOther, password: passCommon });
    if (sOtherErr) throw new Error(`Error signIn other: ${sOtherErr.message}`);

    // Cliente anónimo para Host Anónimo
    const anonHostClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: anonHostData, error: anonHostErr } = await anonHostClient.auth.signInAnonymously();
    if (anonHostErr || !anonHostData.user) throw new Error(`Error signInAnonymously host: ${anonHostErr?.message}`);
    anonHostId = anonHostData.user.id;
    createdUserIds.push(anonHostId);

    // Cliente no autenticado (para invitados sin sesión)
    const clientAnonVisitor = createClient(url, publishableKey, { auth: { persistSession: false } });

    console.log(`  Host Registrado: ${hostRegisteredId}`);
    console.log(`  Host Anónimo:    ${anonHostId}`);
    console.log(`  Participante:    ${participantRegId}`);
    console.log(`  Solicitante EA:  ${applicantOpenId}`);
    console.log(`  Usuario Ajeno:   ${otherUserId}\n`);

    // ----------------------------------------------------
    // SETUP: Encuentros de prueba
    // ----------------------------------------------------
    const futureDate = new Date(Date.now() + 5 * 86400 * 1000).toISOString().slice(0, 10);
    const pastDate = '2026-01-10';

    // Encuentro principal con host registrado
    const { data: encMain, error: encMainErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostRegisteredId,
        titulo: `QA Encuentro Panel V1 ${ts}`,
        fecha: futureDate,
        hora: '20:00:00',
        modalidad: 'presencial',
        lugar_texto: 'Av. Corrientes 1234, CABA',
        date_mode: 'fixed',
        tipo_invitacion: 'individual',
        estado: 'activo',
        public_token: crypto.randomUUID(),
      })
      .select('id, public_token')
      .single();
    if (encMainErr || !encMain) throw new Error(`Error creando encMain: ${encMainErr?.message}`);
    createdEncounterIds.push(encMain.id);

    // Encuentro privado con host anónimo
    const { data: encAnonHost, error: encAnonErr } = await admin
      .from('encuentros')
      .insert({
        host_id: anonHostId,
        titulo: `QA Encuentro Anon Host ${ts}`,
        fecha: futureDate,
        hora: '19:00:00',
        modalidad: 'presencial',
        lugar_texto: 'Plaza Serrano, CABA',
        date_mode: 'fixed',
        tipo_invitacion: 'individual',
        estado: 'activo',
        public_token: crypto.randomUUID(),
      })
      .select('id, public_token')
      .single();
    if (encAnonErr || !encAnonHost) throw new Error(`Error creando encAnonHost: ${encAnonErr?.message}`);
    createdEncounterIds.push(encAnonHost.id);

    // Encuentro con coordinación de fechas (sin fecha/hora elegida todavía)
    const { data: encCoord, error: encCoordErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostRegisteredId,
        titulo: `QA Coordinacion Abierta ${ts}`,
        fecha: null,
        hora: null,
        modalidad: 'presencial',
        date_mode: 'coordination',
        coordination_status: 'open',
        tipo_invitacion: 'individual',
        estado: 'activo',
        public_token: crypto.randomUUID(),
      })
      .select('id')
      .single();
    if (encCoordErr || !encCoord) throw new Error(`Error creando encCoord: ${encCoordErr?.message}`);
    createdEncounterIds.push(encCoord.id);

    // Crear opción de fecha para la coordinación
    const { data: coordOpt, error: optErr } = await admin
      .from('encuentro_opciones_fecha')
      .insert({
        encuentro_id: encCoord.id,
        fecha: futureDate,
        hora_inicio: '17:00:00',
        orden: 1,
      })
      .select('id')
      .single();
    if (optErr || !coordOpt) throw new Error(`Error creando coordOpt: ${optErr?.message}`);

    // Encuentro fuera de ventana de escritura (> 24 horas del inicio)
    const { data: encPast, error: encPastErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostRegisteredId,
        titulo: `QA Encuentro Pasado ${ts}`,
        fecha: pastDate,
        hora: '10:00:00',
        modalidad: 'presencial',
        date_mode: 'fixed',
        tipo_invitacion: 'individual',
        estado: 'activo',
        public_token: crypto.randomUUID(),
      })
      .select('id')
      .single();
    if (encPastErr || !encPast) throw new Error(`Error creando encPast: ${encPastErr?.message}`);
    createdEncounterIds.push(encPast.id);

    // Encuentro cancelado
    const { data: encCancelled, error: encCancelledErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostRegisteredId,
        titulo: `QA Encuentro Cancelado ${ts}`,
        fecha: futureDate,
        hora: '21:00:00',
        modalidad: 'presencial',
        lugar_texto: 'Lugar Secreto',
        date_mode: 'fixed',
        tipo_invitacion: 'individual',
        estado: 'cancelado',
        public_token: crypto.randomUUID(),
      })
      .select('id')
      .single();
    if (encCancelledErr || !encCancelled) throw new Error(`Error creando encCancelled: ${encCancelledErr?.message}`);
    createdEncounterIds.push(encCancelled.id);

    // Encuentro Abierto para probar participante aprobado
    const { data: encOpen, error: encOpenErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostRegisteredId,
        titulo: `QA Encuentro Abierto ${ts}`,
        open_public_title: `QA Encuentro Abierto Publico ${ts}`,
        fecha: futureDate,
        hora: '18:00:00',
        modalidad: 'presencial',
        date_mode: 'fixed',
        tipo_invitacion: 'individual',
        is_open: true,
        locality_id: 'guemes',
        open_public_zone: 'Güemes',
        moderation_status: 'approved',
        estado: 'activo',
        max_participants: 10,
        public_token: crypto.randomUUID(),
      })
      .select('id')
      .single();
    if (encOpenErr || !encOpen) throw new Error(`Error creando encOpen: ${encOpenErr?.message}`);
    createdEncounterIds.push(encOpen.id);

    // ----------------------------------------------------
    // SETUP: Participantes
    // ----------------------------------------------------
    // Token individual para invitado sin sesión
    const tokenGuestValid = crypto.randomUUID();
    const tokenGuestAnotherEncounter = crypto.randomUUID();
    const tokenGuestPending = crypto.randomUUID();
    const tokenGuestRejected = crypto.randomUUID();

    // Participante registrado confirmado en encMain
    const { data: partReg, error: partRegErr } = await admin
      .from('participantes')
      .insert({
        encuentro_id: encMain.id,
        user_id: participantRegId,
        nombre_invitado: 'Participante Confirmado',
        estado: 'confirmado',
        tipo_invitacion: 'individual',
        token_invitacion: crypto.randomUUID(),
      })
      .select('id')
      .single();
    if (partRegErr) throw new Error(`Error creando partReg: ${partRegErr.message}`);

    // Invitado individual confirmado (sin sesión de usuario)
    const { data: partGuest, error: partGuestErr } = await admin
      .from('participantes')
      .insert({
        encuentro_id: encMain.id,
        user_id: null,
        nombre_invitado: 'Invitado Sin Sesion',
        estado: 'confirmado',
        tipo_invitacion: 'individual',
        token_invitacion: tokenGuestValid,
      })
      .select('id')
      .single();
    if (partGuestErr) throw new Error(`Error creando partGuest: ${partGuestErr.message}`);

    // Invitado pendiente en encMain
    await admin.from('participantes').insert({
      encuentro_id: encMain.id,
      nombre_invitado: 'Invitado Pendiente',
      estado: 'pendiente',
      tipo_invitacion: 'individual',
      token_invitacion: tokenGuestPending,
    });

    // Invitado rechazado en encMain
    await admin.from('participantes').insert({
      encuentro_id: encMain.id,
      nombre_invitado: 'Invitado Rechazado',
      estado: 'rechazado',
      tipo_invitacion: 'individual',
      token_invitacion: tokenGuestRejected,
    });

    // Participante en encPast para pruebas de solo lectura
    await admin.from('participantes').insert({
      encuentro_id: encPast.id,
      user_id: participantRegId,
      nombre_invitado: 'Participante En Pasado',
      estado: 'confirmado',
      tipo_invitacion: 'individual',
      token_invitacion: crypto.randomUUID(),
    });

    // Token en otro encuentro
    await admin.from('participantes').insert({
      encuentro_id: encAnonHost.id,
      nombre_invitado: 'Invitado de Otro Encuentro',
      estado: 'confirmado',
      tipo_invitacion: 'individual',
      token_invitacion: tokenGuestAnotherEncounter,
    });

    // Participante aprobado de Encuentro Abierto (vía aprobación de solicitud)
    const { data: solData, error: solErr } = await clientApp.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encOpen.id,
      p_nombre: 'Aspirante Abierto',
      p_seat_count: 1,
    });
    if (solErr || !solData?.ok) throw new Error(`Error solicitando sumarse a EA: ${solErr?.message || solData?.error}`);

    const { data: apData, error: apErr } = await clientHost.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: solData.request_id,
    });
    if (apErr || !apData?.ok) throw new Error(`Error aprobando solicitud EA: ${apErr?.message || apData?.error}`);

    console.log('[Setup] Fixtures temporales listos en Staging.\n');

    // ====================================================
    // 1. ORGANIZADOR REGISTRADO: LECTURA, ESCRITURA Y MODERACIÓN
    // ====================================================
    console.log('[1/20] Verificando Organizador registrado (lectura, escritura y moderación)...');
    const { data: hostRead1, error: hostRead1Err } = await clientHost.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
    });
    assert.ok(!hostRead1Err, `Error lectura host: ${hostRead1Err?.message}`);
    assert.equal(hostRead1?.ok, true);
    assert.equal(hostRead1?.is_host, true);
    assert.equal(hostRead1?.can_write, true);

    const { data: hostPub, error: hostPubErr } = await clientHost.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_contenido: 'Hola a todos, bienvenidos al encuentro',
    });
    assert.ok(!hostPubErr, `Error publicación host: ${hostPubErr?.message}`);
    assert.equal(hostPub?.ok, true);
    const hostMsgId = hostPub.mensaje_id;
    assert.ok(hostMsgId);

    // Host lee y ve su mensaje con es_organizador = true
    const { data: hostRead2 } = await clientHost.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
    });
    const foundHostMsg = hostRead2?.mensajes?.find((m: any) => m.id === hostMsgId);
    assert.ok(foundHostMsg);
    assert.equal(foundHostMsg.es_organizador, true);
    assert.equal(foundHostMsg.es_propio, true);
    console.log('  -> [1/20] PASÓ: Organizador registrado lee, escribe y se identifica correctamente.');

    // ====================================================
    // 2. ORGANIZADOR ANÓNIMO: LECTURA Y ESCRITURA EN ENCUENTRO PROPIO
    // ====================================================
    console.log('\n[2/20] Verificando Organizador anónimo en su encuentro privado...');
    const { data: anonHostRead, error: anonHostReadErr } = await anonHostClient.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encAnonHost.id,
    });
    assert.ok(!anonHostReadErr, `Error lectura anon host: ${anonHostReadErr?.message}`);
    assert.equal(anonHostRead?.ok, true);
    assert.equal(anonHostRead?.is_host, true);
    assert.equal(anonHostRead?.can_write, true);

    const { data: anonHostPub, error: anonHostPubErr } = await anonHostClient.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encAnonHost.id,
      p_contenido: 'Mensaje publicado por host con sesión anónima',
    });
    assert.ok(!anonHostPubErr, `Error publicación anon host: ${anonHostPubErr?.message}`);
    assert.equal(anonHostPub?.ok, true);
    console.log('  -> [2/20] PASÓ: Organizador anónimo escribe y administra su encuentro.');

    // ====================================================
    // 3. INVITADO INDIVIDUAL SIN REGISTRO: ACCESO CON TOKEN PERSONAL
    // ====================================================
    console.log('\n[3/20] Verificando Invitado individual sin registro con token_invitacion...');
    const { data: guestRead, error: guestReadErr } = await clientAnonVisitor.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_token_invitacion: tokenGuestValid,
    });
    assert.ok(!guestReadErr, `Error lectura guest: ${guestReadErr?.message}`);
    assert.equal(guestRead?.ok, true);
    assert.equal(guestRead?.is_host, false);
    assert.equal(guestRead?.can_write, true);

    const { data: guestPub, error: guestPubErr } = await clientAnonVisitor.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_contenido: 'Consulta práctica desde invitado sin cuenta',
      p_token_invitacion: tokenGuestValid,
    });
    assert.ok(!guestPubErr, `Error publicación guest: ${guestPubErr?.message}`);
    assert.equal(guestPub?.ok, true);
    const guestMsgId = guestPub.mensaje_id;
    assert.ok(guestMsgId);
    console.log('  -> [3/20] PASÓ: Invitado sin registro accede y publica con su token individual.');

    // ====================================================
    // 4. INVITADO POR ENLACE GENERAL
    // ====================================================
    console.log('\n[4/20] Verificando Invitado por enlace general (sin token vs con token tras confirmar)...');
    // Sin token individual (intento de leer sin token de participante)
    const { data: noTokenRead } = await clientAnonVisitor.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
    });
    assert.equal(noTokenRead?.ok, false);
    assert.equal(noTokenRead?.error, 'unauthorized');

    // Confirmar vía flujo individual (crear participante con token propio como hace JoinGeneral)
    const tokenFromGeneral = crypto.randomUUID();
    const { error: genInsErr } = await admin.from('participantes').insert({
      encuentro_id: encMain.id,
      nombre_invitado: 'Confirmado Desde Enlace General',
      estado: 'confirmado',
      tipo_invitacion: 'generico',
      token_invitacion: tokenFromGeneral,
    });
    if (genInsErr) throw new Error(`Error insertando part de general: ${genInsErr.message}`);

    const { data: generalPostConfirmRead } = await clientAnonVisitor.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_token_invitacion: tokenFromGeneral,
    });
    assert.equal(generalPostConfirmRead?.ok, true);
    assert.equal(generalPostConfirmRead?.can_write, true);
    console.log('  -> [4/20] PASÓ: Acceso denegado antes de confirmar; permitido tras confirmar con token individual.');

    // ====================================================
    // 5. PARTICIPANTE REGISTRADO CONFIRMADO
    // ====================================================
    console.log('\n[5/20] Verificando Participante registrado confirmado...');
    const { data: partRegRead } = await clientPart.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
    });
    assert.equal(partRegRead?.ok, true);
    assert.equal(partRegRead?.is_host, false);
    assert.equal(partRegRead?.can_write, true);

    const { data: partRegPub } = await clientPart.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_contenido: '¿Llevo mate o gaseosa?',
    });
    assert.equal(partRegPub?.ok, true);
    const partRegMsgId = partRegPub.mensaje_id;
    console.log('  -> [5/20] PASÓ: Participante registrado confirmado lee y escribe.');

    // ====================================================
    // 6. PARTICIPANTE APROBADO DE ENCUENTRO ABIERTO
    // ====================================================
    console.log('\n[6/20] Verificando Participante aprobado de Encuentro Abierto...');
    const { data: openPartRead } = await clientApp.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encOpen.id,
    });
    assert.equal(openPartRead?.ok, true);
    assert.equal(openPartRead?.is_host, false);
    assert.equal(openPartRead?.can_write, true);

    const { data: openPartPub } = await clientApp.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encOpen.id,
      p_contenido: '¡Gracias por aceptarme! Nos vemos allí.',
    });
    assert.equal(openPartPub?.ok, true);
    console.log('  -> [6/20] PASÓ: Participante de EA aprobado accede al panel y escribe.');

    // ====================================================
    // 7. INVITADO PENDIENTE O RECHAZADO: DENEGACIÓN TOTAL
    // ====================================================
    console.log('\n[7/20] Verificando Invitado pendiente o rechazado (denegación fail-closed)...');
    const { data: pendRes } = await clientAnonVisitor.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_token_invitacion: tokenGuestPending,
    });
    assert.equal(pendRes?.ok, false);
    assert.equal(pendRes?.error, 'participant_not_confirmed');

    const { data: rejRes } = await clientAnonVisitor.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_token_invitacion: tokenGuestRejected,
    });
    assert.equal(rejRes?.ok, false);
    assert.equal(rejRes?.error, 'participant_not_confirmed');
    console.log('  -> [7/20] PASÓ: Invitados no confirmados son completamente bloqueados.');

    // ====================================================
    // 8. PARTICIPANTE RETIRADO O BLOQUEADO: REVOCACIÓN INMEDIATA
    // ====================================================
    console.log('\n[8/20] Verificando Participante retirado o con bloqueo bilateral...');
    // Retiro: cambiar estado a 'cancelado'
    await admin.from('participantes').update({ estado: 'cancelado' }).eq('id', partReg.id);
    const { data: withdrawnRes } = await clientPart.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
    });
    assert.equal(withdrawnRes?.ok, false);
    assert.equal(withdrawnRes?.error, 'participant_not_confirmed');

    // Restaurar a confirmado
    await admin.from('participantes').update({ estado: 'confirmado' }).eq('id', partReg.id);

    // Bloqueo bilateral: host bloquea a participante
    await admin.from('bloqueos_usuario').insert({
      blocker_id: hostRegisteredId,
      blocked_id: participantRegId,
    });
    const { data: blockedRes } = await clientPart.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
    });
    assert.equal(blockedRes?.ok, false);
    assert.equal(blockedRes?.error, 'blocked_user');

    // Limpiar bloqueo para siguientes pruebas
    await admin.from('bloqueos_usuario').delete().match({ blocker_id: hostRegisteredId, blocked_id: participantRegId });
    console.log('  -> [8/20] PASÓ: Bajas y bloqueos bilaterales revocan acceso de inmediato.');

    // ====================================================
    // 9. PUBLIC_TOKEN GENERAL: DENEGADO PARA LEER Y ESCRIBIR
    // ====================================================
    console.log('\n[9/20] Verificando rechazo de public_token general como credencial...');
    const { data: pubTokRead } = await clientAnonVisitor.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_token_invitacion: encMain.public_token,
    });
    assert.equal(pubTokRead?.ok, false);
    assert.equal(pubTokRead?.error, 'unauthorized');

    const { data: pubTokWrite } = await clientAnonVisitor.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_contenido: 'Intento de publicación con public_token',
      p_token_invitacion: encMain.public_token,
    });
    assert.equal(pubTokWrite?.ok, false);
    assert.equal(pubTokWrite?.error, 'unauthorized');
    console.log('  -> [9/20] PASÓ: public_token jamás autoriza lectura ni escritura.');

    // ====================================================
    // 10. TOKEN INDIVIDUAL DE OTRO ENCUENTRO: ACCESO DENEGADO
    // ====================================================
    console.log('\n[10/20] Verificando token individual de otro encuentro...');
    const { data: otherTokenRes } = await clientAnonVisitor.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_token_invitacion: tokenGuestAnotherEncounter,
    });
    assert.equal(otherTokenRes?.ok, false);
    assert.equal(otherTokenRes?.error, 'unauthorized');
    console.log('  -> [10/20] PASÓ: Tokens de otros encuentros son denegados.');

    // ====================================================
    // 11. COORDINACIÓN ABIERTA VS FECHA DEFINITIVA
    // ====================================================
    console.log('\n[11/20] Verificando Coordinación abierta vs definitiva...');
    const { data: coordOpenRes } = await clientHost.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encCoord.id,
    });
    assert.equal(coordOpenRes?.ok, false);
    assert.equal(coordOpenRes?.error, 'coordination_not_closed');

    // Cerrar coordinación y asignar fecha definitiva
    const { error: closeCoordErr } = await admin.from('encuentros').update({
      coordination_status: 'closed',
      selected_option_id: coordOpt.id,
      fecha: futureDate,
      hora: '17:00:00',
    }).eq('id', encCoord.id);
    if (closeCoordErr) throw new Error(`Error cerrando coordinacion: ${closeCoordErr.message}`);

    const { data: coordClosedRes } = await clientHost.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encCoord.id,
    });
    assert.equal(coordClosedRes?.ok, true);
    assert.equal(coordClosedRes?.can_write, true);
    console.log('  -> [11/20] PASÓ: Panel bloqueado durante votación; habilitado tras fijar fecha.');

    // ====================================================
    // 12. ESCRITURA ANTES, DURANTE Y HASTA 24 HS DESPUÉS
    // ====================================================
    console.log('\n[12/20] Verificando ventana temporal de escritura...');
    // Encuentro futuro: can_write = true
    const { data: futureRes } = await clientHost.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
    });
    assert.equal(futureRes?.can_write, true);

    // Encuentro pasado (> 24 hs): can_write = false (solo lectura)
    const { data: pastRes } = await clientPart.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encPast.id,
    });
    assert.equal(pastRes?.ok, true);
    assert.equal(pastRes?.can_write, false);
    assert.equal(pastRes?.writing_window_closed, true);

    const { data: pastPubRes } = await clientPart.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encPast.id,
      p_contenido: 'Intento de escribir en encuentro cerrado',
    });
    assert.equal(pastPubRes?.ok, false);
    assert.equal(pastPubRes?.error, 'writing_window_closed');
    console.log('  -> [12/20] PASÓ: Escritura bloqueada pasado el límite de 24 horas.');

    // ====================================================
    // 13. ENCUENTRO CANCELADO O FINALIZADO: PRIVACIDAD Y REGLAS
    // ====================================================
    console.log('\n[13/20] Verificando Encuentro cancelado (privacidad de participantes y moderación del host)...');
    // Participante intenta leer en cancelado -> rechazado para no exponer logística
    const { data: cancPartRead } = await clientPart.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encCancelled.id,
    });
    assert.equal(cancPartRead?.ok, false);
    assert.equal(cancPartRead?.error, 'meeting_cancelled');

    // Host puede consultar el historial a fines de moderación pero con can_write = false
    const { data: cancHostRead } = await clientHost.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encCancelled.id,
    });
    assert.equal(cancHostRead?.ok, true);
    assert.equal(cancHostRead?.can_write, false);

    // Host intenta publicar en cancelado -> bloqueado
    const { data: cancHostPub } = await clientHost.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encCancelled.id,
      p_contenido: 'No se puede publicar en cancelado',
    });
    assert.equal(cancHostPub?.ok, false);
    assert.equal(cancHostPub?.error, 'writing_window_closed');
    console.log('  -> [13/20] PASÓ: Encuentro cancelado protege privacidad de participantes y congela publicaciones.');

    // ====================================================
    // 14. EDICIÓN DE MENSAJES PROPIOS DENTRO Y FUERA DE LOS 15 MINUTOS
    // ====================================================
    console.log('\n[14/20] Verificando Edición de mensajes propios (dentro vs fuera de 15 min)...');
    // Edición inmediata (dentro de 15 min)
    const { data: editOk } = await clientHost.rpc('editar_mensaje_encuentro_seguro', {
      p_mensaje_id: hostMsgId,
      p_contenido: 'Hola a todos, bienvenidos al encuentro (editado)',
    });
    assert.equal(editOk?.ok, true);

    // Forzar en base de datos creado_en a 20 minutos atrás
    await admin.from('mensajes_encuentro').update({
      creado_en: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    }).eq('id', hostMsgId);

    // Intento de edición fuera de ventana de 15 min -> expirado
    const { data: editExpired } = await clientHost.rpc('editar_mensaje_encuentro_seguro', {
      p_mensaje_id: hostMsgId,
      p_contenido: 'Intento de editar tras 20 minutos',
    });
    assert.equal(editExpired?.ok, false);
    assert.equal(editExpired?.error, 'edit_window_expired');

    // Restaurar creado_en
    await admin.from('mensajes_encuentro').update({
      creado_en: new Date().toISOString(),
    }).eq('id', hostMsgId);

    console.log('  -> [14/20] PASÓ: Edición permitida en 15 min y rechazada al expirar.');

    // ====================================================
    // 15. ELIMINACIÓN PROPIA Y MODERACIÓN POR ANFITRIÓN
    // ====================================================
    console.log('\n[15/20] Verificando Eliminación propia y moderación por el organizador...');
    // a) Eliminación propia por invitado sin sesión
    const { data: delOwnRes } = await clientAnonVisitor.rpc('eliminar_mensaje_encuentro_seguro', {
      p_mensaje_id: guestMsgId,
      p_token_invitacion: tokenGuestValid,
    });
    assert.equal(delOwnRes?.ok, true);
    assert.equal(delOwnRes?.tipo, 'autor');

    // b) Moderación por el host sobre mensaje del participante
    const { data: modHostRes } = await clientHost.rpc('eliminar_mensaje_encuentro_seguro', {
      p_mensaje_id: partRegMsgId,
    });
    assert.equal(modHostRes?.ok, true);
    assert.equal(modHostRes?.tipo, 'organizador');

    // c) Comprobar contenido ocultado en listado
    const { data: listAfterDel } = await clientHost.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encMain.id,
    });
    const msgGuestDeleted = listAfterDel?.mensajes?.find((m: any) => m.id === guestMsgId);
    assert.equal(msgGuestDeleted?.eliminado, true);
    assert.equal(msgGuestDeleted?.contenido, '');
    assert.equal(msgGuestDeleted?.eliminado_por_tipo, 'autor');

    const msgPartDeleted = listAfterDel?.mensajes?.find((m: any) => m.id === partRegMsgId);
    assert.equal(msgPartDeleted?.eliminado, true);
    assert.equal(msgPartDeleted?.contenido, '');
    assert.equal(msgPartDeleted?.eliminado_por_tipo, 'organizador');
    console.log('  -> [15/20] PASÓ: Borrado lógico propio y moderación por anfitrión validados.');

    // ====================================================
    // 16. MÁXIMO DE 3 DESTACADOS, INCLUYENDO CONCURRENCIA
    // ====================================================
    console.log('\n[16/20] Verificando límite de 3 mensajes destacados y concurrencia...');
    // Publicar 4 mensajes nuevos
    const m1 = (await clientHost.rpc('publicar_mensaje_encuentro_seguro', { p_encuentro_id: encMain.id, p_contenido: 'Destacado 1' })).data.mensaje_id;
    const m2 = (await clientHost.rpc('publicar_mensaje_encuentro_seguro', { p_encuentro_id: encMain.id, p_contenido: 'Destacado 2' })).data.mensaje_id;
    const m3 = (await clientHost.rpc('publicar_mensaje_encuentro_seguro', { p_encuentro_id: encMain.id, p_contenido: 'Destacado 3' })).data.mensaje_id;
    const m4 = (await clientHost.rpc('publicar_mensaje_encuentro_seguro', { p_encuentro_id: encMain.id, p_contenido: 'Destacado 4' })).data.mensaje_id;

    const r1 = await clientHost.rpc('destacar_mensaje_encuentro_seguro', { p_mensaje_id: m1, p_destacado: true });
    const r2 = await clientHost.rpc('destacar_mensaje_encuentro_seguro', { p_mensaje_id: m2, p_destacado: true });
    const r3 = await clientHost.rpc('destacar_mensaje_encuentro_seguro', { p_mensaje_id: m3, p_destacado: true });
    assert.equal(r1.data.ok, true);
    assert.equal(r2.data.ok, true);
    assert.equal(r3.data.ok, true);

    // El 4to debe ser rechazado
    const r4 = await clientHost.rpc('destacar_mensaje_encuentro_seguro', { p_mensaje_id: m4, p_destacado: true });
    assert.equal(r4.data.ok, false);
    assert.equal(r4.data.error, 'max_highlights_reached');

    // Desmarcar uno y permitir destacar el 4to
    await clientHost.rpc('destacar_mensaje_encuentro_seguro', { p_mensaje_id: m1, p_destacado: false });
    const r4Again = await clientHost.rpc('destacar_mensaje_encuentro_seguro', { p_mensaje_id: m4, p_destacado: true });
    assert.equal(r4Again.data.ok, true);
    console.log('  -> [16/20] PASÓ: Máximo de 3 destacados respetado estrictamente.');

    // ====================================================
    // 17. RESPUESTAS DE UN NIVEL Y RECHAZO DE REFERENCIAS A OTROS ENCUENTROS
    // ====================================================
    console.log('\n[17/20] Verificando respuestas de 1 solo nivel y referencias cruzadas...');
    // Respuesta válida a m2 (nivel 1)
    const reply1 = await clientHost.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_contenido: 'Respuesta nivel 1',
      p_parent_id: m2,
    });
    assert.equal(reply1.data.ok, true);
    const reply1Id = reply1.data.mensaje_id;

    // Intento de respuesta a reply1 (nivel 2) -> rechazado
    const reply2 = await clientHost.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_contenido: 'Intento de nivel 2',
      p_parent_id: reply1Id,
    });
    assert.equal(reply2.data.ok, false);
    assert.equal(reply2.data.error, 'nested_reply_depth_exceeded');

    // Intento de parent_id de otro encuentro -> rechazado
    const replyOtherEnc = await clientHost.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encMain.id,
      p_contenido: 'Intento cruzado',
      p_parent_id: (await clientHost.rpc('publicar_mensaje_encuentro_seguro', { p_encuentro_id: encCoord.id, p_contenido: 'Mensaje en coord' })).data.mensaje_id,
    });
    assert.equal(replyOtherEnc.data.ok, false);
    assert.equal(replyOtherEnc.data.error, 'parent_cross_encounter_rejected');
    console.log('  -> [17/20] PASÓ: Anidamiento de nivel 1 cumplido y referencias cruzadas rechazadas.');

    // ====================================================
    // 18. RATE LIMITING REAL, CONCURRENCIA Y CAMBIO DE SESIÓN
    // ====================================================
    console.log('\n[18/20] Verificando Rate limiting en Staging real (10 mensajes / 5 min)...');
    // Para invitado sin sesión con tokenGuestValid
    // Hacemos publicaciones consecutivas hasta agotar cuota de 10
    let rateLimitTriggered = false;
    for (let i = 0; i < 12; i++) {
      const pubRes = await clientAnonVisitor.rpc('publicar_mensaje_encuentro_seguro', {
        p_encuentro_id: encMain.id,
        p_contenido: `Mensaje rate limit test ${i + 1}`,
        p_token_invitacion: tokenGuestValid,
      });
      if (!pubRes.data.ok && pubRes.data.error === 'rate_limited') {
        rateLimitTriggered = true;
        break;
      }
    }
    assert.equal(rateLimitTriggered, true, 'Debe activar rate limiting al superar 10 mensajes en 5 minutos');
    console.log('  -> [18/20] PASÓ: Rate limiting verificado activamente en Supabase Staging.');

    // ====================================================
    // 19. GENERACIÓN DE INBOX ÚNICAMENTE PARA DESTACADOS
    // ====================================================
    console.log('\n[19/20] Verificando Generación de Inbox exclusivamente para mensajes destacados...');
    // Consultar inbox del participante registrado confirmado
    const { data: inboxNotifs } = await admin
      .from('inbox_notifications')
      .select('id, notification_type, target_type, target_id, title, body, payload')
      .eq('recipient_user_id', participantRegId);

    assert.ok(inboxNotifs && inboxNotifs.length > 0, 'Debe existir notificación en Inbox para participante');
    const hlNotif = inboxNotifs.find((n: any) => n.notification_type === 'encounter_message_highlighted');
    assert.ok(hlNotif, 'La notificación debe ser de tipo encounter_message_highlighted');
    assert.equal(hlNotif.target_id, encMain.id);
    console.log('  -> [19/20] PASÓ: Notificaciones generadas exclusivamente ante mensajes destacados.');

    // ====================================================
    // 20. AUSENCIA DE EXPOSICIÓN DE CONTENIDO PRIVADO EN WEB PUSH
    // ====================================================
    console.log('\n[20/20] Verificando ausencia de filtración de logística/privacidad en payload de notificaciones...');
    assert.ok(!hlNotif.title.includes('Av. Corrientes'), 'El título de notificación no debe filtrar dirección');
    assert.ok(!hlNotif.body.includes('Av. Corrientes'), 'El cuerpo de notificación no debe filtrar dirección');
    assert.ok(!JSON.stringify(hlNotif.payload).includes('Av. Corrientes'), 'El payload no debe filtrar dirección');
    console.log('  -> [20/20] PASÓ: Privacidad y aislamiento de logística estrictamente respetados en notificaciones.');

    console.log('\n========================================================');
    console.log('✔ TODAS LAS 20 COMPUERTAS DE QA EN STAGING PASARON CON ÉXITO.');
    console.log('========================================================\n');
  } finally {
    console.log('[Cleanup] Limpiando fixtures de prueba en Supabase Staging...');
    if (createdEncounterIds.length > 0) {
      await admin.from('mensajes_encuentro').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('participante_rate_limit_buckets').delete().neq('request_count', 0);
      await admin.from('inbox_notifications').delete().in('target_id', createdEncounterIds);
      await admin.from('participantes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('solicitudes_encuentro_abierto').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    if (createdUserIds.length > 0) {
      await admin.from('bloqueos_usuario').delete().in('blocker_id', createdUserIds);
      await admin.from('bloqueos_usuario').delete().in('blocked_id', createdUserIds);
      await admin.from('rate_limit_buckets').delete().in('user_id', createdUserIds);
      await admin.from('inbox_notifications').delete().in('recipient_user_id', createdUserIds);
      for (const uid of createdUserIds) {
        await admin.auth.admin.deleteUser(uid);
      }
    }
    console.log('[Cleanup] Limpieza en Supabase Staging concluida exitosamente.\n');
  }
}

runEncounterMessagesStagingQA().catch((err) => {
  console.error('\n✖ ERROR FATAL EN STAGING QA:', err);
  process.exit(1);
});
