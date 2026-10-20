/**
 * Staging Real QA — Sprint 2: Microcorrecciones del Panel de Mensajes V1
 *
 * Target: wougfhfwqgmxhgvjqoua (Supabase Staging)
 * Guards: assertStagingEnvironment()
 *
 * Verification Gates:
 * 1. Concurrencia real: 4 destacados simultáneos desde 0 con conexiones independientes -> exactamente 3 quedan destacados.
 * 2. Bloqueo bilateral: usuarios bloqueados no reciben notificaciones de destacados, aun estando confirmados.
 * 3. Encuentro cancelado: no admite nuevos destacados.
 * 4. Encuentro fuera de ventana (>24hs): no admite nuevos destacados.
 * 5. Moderación post-cierre: permite desmarcar destacados tras el cierre / cancelación.
 * 6. Coordinación con fecha/hora pero coordination_status != 'closed' bloquea el panel.
 * 7. Deep links de notificaciones: abre detalle autorizado accesible con el panel tanto para privado como abierto.
 * 8. Privacidad estricta: ningún token privado en deep_links o notificaciones.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard.js';

const url = `https://${STAGING_PROJECT_REF}.supabase.co`;
assertStagingEnvironment(url);

const secretKey = getStagingSecretKey();
const publishableKey = getStagingPublishableKey();

const admin = createClient(url, secretKey, { auth: { persistSession: false } });

async function runStagingMicrocorrectionsQA() {
  console.log('========================================================');
  console.log('STAGING REAL QA: MICROCORRECCIONES PANEL MENSAJES V1');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  const ts = Date.now();
  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  let hostId: string | null = null;
  let partNormalId: string | null = null;
  let partBlockedId: string | null = null;

  try {
    // ----------------------------------------------------
    // SETUP: Usuarios de prueba
    // ----------------------------------------------------
    console.log('[Setup] Creando usuarios temporales de prueba en Staging...');

    const hostEmail = `qa-micro-host-${ts}@qa-staging-fixtures.test`;
    const partNormalEmail = `qa-micro-part-norm-${ts}@qa-staging-fixtures.test`;
    const partBlockedEmail = `qa-micro-part-block-${ts}@qa-staging-fixtures.test`;
    const commonPass = 'QaMicroPass123!Secure';

    const { data: uHost, error: errH } = await admin.auth.admin.createUser({
      email: hostEmail,
      password: commonPass,
      email_confirm: true,
      user_metadata: { full_name: 'QA Host Micro' },
    });
    if (errH || !uHost.user) throw new Error(`Error creando host: ${errH?.message}`);
    hostId = uHost.user.id;
    createdUserIds.push(hostId);

    const { data: uNorm, error: errN } = await admin.auth.admin.createUser({
      email: partNormalEmail,
      password: commonPass,
      email_confirm: true,
      user_metadata: { full_name: 'QA Participante Normal' },
    });
    if (errN || !uNorm.user) throw new Error(`Error creando part normal: ${errN?.message}`);
    partNormalId = uNorm.user.id;
    createdUserIds.push(partNormalId);

    const { data: uBlock, error: errB } = await admin.auth.admin.createUser({
      email: partBlockedEmail,
      password: commonPass,
      email_confirm: true,
      user_metadata: { full_name: 'QA Participante Bloqueado' },
    });
    if (errB || !uBlock.user) throw new Error(`Error creando part bloqueado: ${errB?.message}`);
    partBlockedId = uBlock.user.id;
    createdUserIds.push(partBlockedId);

    // Clientes autenticados
    const clientHost = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientHost.auth.signInWithPassword({ email: hostEmail, password: commonPass });

    const clientPartNorm = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientPartNorm.auth.signInWithPassword({ email: partNormalEmail, password: commonPass });

    const clientPartBlock = createClient(url, publishableKey, { auth: { persistSession: false } });
    await clientPartBlock.auth.signInWithPassword({ email: partBlockedEmail, password: commonPass });

    console.log(`  Host ID:         ${hostId}`);
    console.log(`  Part Normal ID:  ${partNormalId}`);
    console.log(`  Part Blocked ID: ${partBlockedId}\n`);

    // ----------------------------------------------------
    // SETUP: Encuentros
    // ----------------------------------------------------
    const futureDate = new Date(Date.now() + 5 * 86400 * 1000).toISOString().slice(0, 10);

    // 1. Encuentro activo privado
    const { data: encActive, error: encActErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostId,
        titulo: `QA Micro Encuentro Activo ${ts}`,
        fecha: futureDate,
        hora: '20:00:00',
        modalidad: 'presencial',
        lugar_texto: 'Av. Santa Fe 1234, CABA',
        date_mode: 'fixed',
        tipo_invitacion: 'individual',
        estado: 'activo',
        public_token: crypto.randomUUID(),
      })
      .select('id')
      .single();
    if (encActErr || !encActive) throw new Error(`Error creando encActive: ${encActErr?.message}`);
    createdEncounterIds.push(encActive.id);

    // Participantes en encActive
    await admin.from('participantes').insert([
      {
        encuentro_id: encActive.id,
        user_id: partNormalId,
        nombre_invitado: 'Participante Normal',
        estado: 'confirmado',
        tipo_invitacion: 'individual',
        token_invitacion: crypto.randomUUID(),
      },
      {
        encuentro_id: encActive.id,
        user_id: partBlockedId,
        nombre_invitado: 'Participante Bloqueado',
        estado: 'confirmado',
        tipo_invitacion: 'individual',
        token_invitacion: crypto.randomUUID(),
      },
    ]);

    // Establecer bloqueo bilateral entre host y partBlockedId
    await admin.from('bloqueos_usuario').insert({
      blocker_id: hostId,
      blocked_id: partBlockedId,
    });

    // 2. Encuentro cancelado
    const { data: encCancelled, error: encCancErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostId,
        titulo: `QA Micro Encuentro Cancelado ${ts}`,
        fecha: futureDate,
        hora: '21:00:00',
        modalidad: 'presencial',
        date_mode: 'fixed',
        tipo_invitacion: 'individual',
        estado: 'cancelado',
        public_token: crypto.randomUUID(),
      })
      .select('id')
      .single();
    if (encCancErr || !encCancelled) throw new Error(`Error creando encCancelled: ${encCancErr?.message}`);
    createdEncounterIds.push(encCancelled.id);

    // 3. Encuentro expirado (> 24 hs de inicio)
    const { data: encPast, error: encPastErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostId,
        titulo: `QA Micro Encuentro Expirado ${ts}`,
        fecha: '2026-01-01',
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

    // 4. Encuentro coordinación con coordination_status 'open' (fecha/hora null según check_encuentro_coordinacion)
    const { data: encCoordOpen, error: encCoordErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostId,
        titulo: `QA Micro Coordinación Abierta ${ts}`,
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
    if (encCoordErr || !encCoordOpen) throw new Error(`Error creando encCoordOpen: ${encCoordErr?.message}`);
    createdEncounterIds.push(encCoordOpen.id);

    // 5. Encuentro abierto para verificar deep link
    const { data: encOpen, error: encOpenErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostId,
        titulo: `QA Micro Encuentro Abierto ${ts}`,
        open_public_title: `QA Micro Encuentro Abierto Publico ${ts}`,
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

    await admin.from('participantes').insert({
      encuentro_id: encOpen.id,
      user_id: partNormalId,
      nombre_invitado: 'Participante EA Confirmado',
      estado: 'confirmado',
      tipo_invitacion: 'individual',
      token_invitacion: crypto.randomUUID(),
    });

    console.log('[Setup] Fixtures temporales listos en Supabase Staging.\n');

    // ====================================================
    // 1. CONCURRENCIA REAL: 4 DESTACADOS SIMULTÁNEOS DESDE CERO
    // ====================================================
    console.log('[1/8] Verificando concurrencia real partiendo de 0 destacados (4 solicitudes simultáneas)...');

    // Insertar 4 mensajes directos en encActive con 0 destacados
    const { data: newMsgs, error: insErr } = await admin
      .from('mensajes_encuentro')
      .insert([
        { encuentro_id: encActive.id, autor_user_id: hostId, autor_nombre: 'Host', es_organizador: true, contenido: 'Mensaje Concurrente 1' },
        { encuentro_id: encActive.id, autor_user_id: hostId, autor_nombre: 'Host', es_organizador: true, contenido: 'Mensaje Concurrente 2' },
        { encuentro_id: encActive.id, autor_user_id: hostId, autor_nombre: 'Host', es_organizador: true, contenido: 'Mensaje Concurrente 3' },
        { encuentro_id: encActive.id, autor_user_id: hostId, autor_nombre: 'Host', es_organizador: true, contenido: 'Mensaje Concurrente 4' },
      ])
      .select('id');
    if (insErr || !newMsgs || newMsgs.length < 4) throw new Error(`Error insertando mensajes: ${insErr?.message}`);

    const [m1, m2, m3, m4] = newMsgs.map((m) => m.id);

    // Crear 4 clientes independientes con conexiones HTTP separadas
    const c1 = createClient(url, publishableKey, { auth: { persistSession: false } });
    const c2 = createClient(url, publishableKey, { auth: { persistSession: false } });
    const c3 = createClient(url, publishableKey, { auth: { persistSession: false } });
    const c4 = createClient(url, publishableKey, { auth: { persistSession: false } });

    await Promise.all([
      c1.auth.signInWithPassword({ email: hostEmail, password: commonPass }),
      c2.auth.signInWithPassword({ email: hostEmail, password: commonPass }),
      c3.auth.signInWithPassword({ email: hostEmail, password: commonPass }),
      c4.auth.signInWithPassword({ email: hostEmail, password: commonPass }),
    ]);

    // Disparar las 4 solicitudes concurrentes simultáneamente
    const results = await Promise.all([
      c1.rpc('destacar_mensaje_encuentro_seguro', { p_mensaje_id: m1, p_destacado: true }),
      c2.rpc('destacar_mensaje_encuentro_seguro', { p_mensaje_id: m2, p_destacado: true }),
      c3.rpc('destacar_mensaje_encuentro_seguro', { p_mensaje_id: m3, p_destacado: true }),
      c4.rpc('destacar_mensaje_encuentro_seguro', { p_mensaje_id: m4, p_destacado: true }),
    ]);

    const successes = results.filter((r) => r.data?.ok === true);
    const failures = results.filter((r) => r.data?.ok === false && r.data?.error === 'max_highlights_reached');

    console.log(`  Resultados concurrentes: ${successes.length} éxitos, ${failures.length} rechazados con max_highlights_reached`);
    assert.equal(successes.length, 3, 'Exactamente 3 solicitudes deben ganar la carrera y destacarse');
    assert.equal(failures.length, 1, 'Exactamente 1 solicitud debe ser rechazada con max_highlights_reached');

    // Comprobar conteo físico en PostgreSQL
    const { count: realCount, error: cntErr } = await admin
      .from('mensajes_encuentro')
      .select('id', { count: 'exact', head: true })
      .eq('encuentro_id', encActive.id)
      .eq('destacado', true)
      .is('eliminado_en', null);
    if (cntErr) throw new Error(`Error consultando conteo de destacados: ${cntErr.message}`);
    assert.equal(realCount, 3, 'El conteo persistido en PostgreSQL debe ser exactamente 3');
    console.log('  -> [1/8] PASÓ: Lock FOR UPDATE en public.encuentros garantizó exactamente 3 destacados bajo concurrencia real.');

    // ====================================================
    // 2. EXCLUSIÓN DE USUARIOS BLOQUEADOS BILATERALMENTE
    // ====================================================
    console.log('\n[2/8] Verificando exclusión de notificaciones a participantes con bloqueo bilateral...');
    // Consultar alertas generadas en Inbox durante el paso 1
    const { data: notifsNormal } = await admin
      .from('inbox_notifications')
      .select('id, recipient_user_id, deep_link')
      .eq('recipient_user_id', partNormalId);

    const { data: notifsBlocked } = await admin
      .from('inbox_notifications')
      .select('id, recipient_user_id')
      .eq('recipient_user_id', partBlockedId);

    assert.ok(notifsNormal && notifsNormal.length > 0, 'Participante normal debe haber recibido notificaciones de destacados');
    assert.equal(notifsBlocked?.length, 0, 'Participante con bloqueo bilateral NO debe recibir ninguna notificación');
    console.log('  -> [2/8] PASÓ: Participante con bloqueo bilateral excluido estrictamente de las notificaciones.');

    // ====================================================
    // 3. ENCUENTRO CANCELADO: NO ADMITE NUEVOS DESTACADOS
    // ====================================================
    console.log('\n[3/8] Verificando bloqueo de destacados en encuentro cancelado...');
    const { data: msgCanc } = await admin
      .from('mensajes_encuentro')
      .insert({
        encuentro_id: encCancelled.id,
        autor_user_id: hostId,
        autor_nombre: 'Host',
        es_organizador: true,
        contenido: 'Mensaje en encuentro cancelado',
        destacado: false,
      })
      .select('id')
      .single();
    assert.ok(msgCanc);

    const { data: resCanc } = await clientHost.rpc('destacar_mensaje_encuentro_seguro', {
      p_mensaje_id: msgCanc.id,
      p_destacado: true,
    });
    assert.equal(resCanc?.ok, false);
    assert.equal(resCanc?.error, 'meeting_cancelled');
    console.log('  -> [3/8] PASÓ: Rechazado con meeting_cancelled al intentar destacar en encuentro cancelado.');

    // ====================================================
    // 4. ENCUENTRO FUERA DE VENTANA (>24HS): NO ADMITE NUEVOS DESTACADOS
    // ====================================================
    console.log('\n[4/8] Verificando bloqueo de destacados fuera de la ventana de 24 horas...');
    const { data: msgPast } = await admin
      .from('mensajes_encuentro')
      .insert({
        encuentro_id: encPast.id,
        autor_user_id: hostId,
        autor_nombre: 'Host',
        es_organizador: true,
        contenido: 'Mensaje en encuentro pasado',
        destacado: false,
      })
      .select('id')
      .single();
    assert.ok(msgPast);

    const { data: resPast } = await clientHost.rpc('destacar_mensaje_encuentro_seguro', {
      p_mensaje_id: msgPast.id,
      p_destacado: true,
    });
    assert.equal(resPast?.ok, false);
    assert.equal(resPast?.error, 'writing_window_closed');
    console.log('  -> [4/8] PASÓ: Rechazado con writing_window_closed en encuentro expirado.');

    // ====================================================
    // 5. PERMITIR DESMARCAR DESTACADOS TRAS CIERRE COMO MODERACIÓN
    // ====================================================
    console.log('\n[5/8] Verificando desmarcado de destacados tras cierre como moderación...');
    // Marcamos previamente en base de datos para simular un mensaje que fue destacado antes de cancelar
    await admin.from('mensajes_encuentro').update({ destacado: true }).eq('id', msgCanc.id);

    // Host desmarca el destacado (p_destacado = false)
    const { data: resUnpin } = await clientHost.rpc('destacar_mensaje_encuentro_seguro', {
      p_mensaje_id: msgCanc.id,
      p_destacado: false,
    });
    assert.equal(resUnpin?.ok, true);
    assert.equal(resUnpin?.destacado, false);
    console.log('  -> [5/8] PASÓ: Desmarcar destacados permitido como acción de moderación en encuentro cancelado.');

    // ====================================================
    // 6. COORDINACIÓN CON coordination_status != 'closed'
    // ====================================================
    console.log('\n[6/8] Verificando coordinación con coordination_status = "open"...');
    const { data: readCoordOpen } = await clientHost.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encCoordOpen.id,
    });
    assert.equal(readCoordOpen?.ok, false);
    assert.equal(readCoordOpen?.error, 'coordination_not_closed');

    const { data: writeCoordOpen } = await clientHost.rpc('publicar_mensaje_encuentro_seguro', {
      p_encuentro_id: encCoordOpen.id,
      p_contenido: 'Intento de escribir con coordinación no cerrada',
    });
    assert.equal(writeCoordOpen?.ok, false);
    assert.equal(writeCoordOpen?.error, 'coordination_not_closed');

    // Ahora creamos la opción de fecha y cerramos la coordinación para comprobar que pasa a estar habilitado
    const { data: opt, error: optErr } = await admin
      .from('encuentro_opciones_fecha')
      .insert({
        encuentro_id: encCoordOpen.id,
        fecha: futureDate,
        hora_inicio: '19:00:00',
        orden: 1,
      })
      .select('id')
      .single();
    assert.ok(!optErr && opt, `Error creando opción de fecha: ${optErr?.message}`);

    const { error: closeErr } = await admin
      .from('encuentros')
      .update({
        coordination_status: 'closed',
        fecha: futureDate,
        hora: '19:00:00',
        selected_option_id: opt.id,
      })
      .eq('id', encCoordOpen.id);
    assert.ok(!closeErr, `Error cerrando coordinación: ${closeErr?.message}`);

    const { data: readCoordClosed } = await clientHost.rpc('get_mensajes_encuentro_seguro', {
      p_encuentro_id: encCoordOpen.id,
    });
    assert.equal(readCoordClosed?.ok, true);
    assert.equal(readCoordClosed?.can_write, true);
    console.log('  -> [6/8] PASÓ: Panel bloqueado con coordination_not_closed mientras coordination_status sea open; se habilita al pasar a closed.');

    // ====================================================
    // 7. DEEP LINK SEGURO ACCESIBLE PARA PARTICIPANTES (PRIVADO Y ABIERTO)
    // ====================================================
    console.log('\n[7/8] Verificando deep links de notificaciones para participante autorizado (privado y abierto)...');
    // Para encuentro privado:
    const privateDeepLink = notifsNormal?.[0]?.deep_link;
    assert.equal(privateDeepLink, `/?tab=encuentros&open_detail=${encActive.id}`);

    // Comprobar que el participante puede abrir el detalle autorizado con RPC get_encuentro_participante_autorizado
    const { data: privAuthRes, error: privAuthErr } = await clientPartNorm.rpc('get_encuentro_participante_autorizado', {
      p_encuentro_id: encActive.id,
    });
    assert.ok(!privAuthErr, `Error RPC participante autorizado privado: ${privAuthErr?.message}`);
    assert.equal(privAuthRes?.ok, true);
    assert.equal(privAuthRes?.id, encActive.id);

    // Para encuentro abierto:
    // Destacamos un mensaje en encOpen con clientHost
    const { data: msgOpen } = await admin
      .from('mensajes_encuentro')
      .insert({
        encuentro_id: encOpen.id,
        autor_user_id: hostId,
        autor_nombre: 'Host',
        es_organizador: true,
        contenido: 'Aviso importante en encuentro abierto',
      })
      .select('id')
      .single();
    assert.ok(msgOpen);

    const { data: hlOpenRes } = await clientHost.rpc('destacar_mensaje_encuentro_seguro', {
      p_mensaje_id: msgOpen.id,
      p_destacado: true,
    });
    assert.equal(hlOpenRes?.ok, true);

    const { data: notifsOpen } = await admin
      .from('inbox_notifications')
      .select('id, deep_link')
      .eq('recipient_user_id', partNormalId)
      .eq('target_id', encOpen.id);

    assert.ok(notifsOpen && notifsOpen.length > 0);
    assert.equal(notifsOpen[0].deep_link, `/?tab=encuentros&open_detail=${encOpen.id}`);

    const { data: openAuthRes, error: openAuthErr } = await clientPartNorm.rpc('get_encuentro_participante_autorizado', {
      p_encuentro_id: encOpen.id,
    });
    assert.ok(!openAuthErr, `Error RPC participante autorizado abierto: ${openAuthErr?.message}`);
    assert.equal(openAuthRes?.ok, true);
    assert.equal(openAuthRes?.id, encOpen.id);
    console.log('  -> [7/8] PASÓ: Deep link /?tab=encuentros&open_detail=:id resuelve y autoriza acceso para ambos tipos de encuentro.');

    // ====================================================
    // 8. PRIVACIDAD: NINGÚN TOKEN PRIVADO EN DEEP LINKS O NOTIFICACIONES
    // ====================================================
    console.log('\n[8/8] Verificando ausencia de tokens privados en deep links y notificaciones...');
    const { data: allNotifs } = await admin
      .from('inbox_notifications')
      .select('id, deep_link, title, body, payload')
      .in('target_id', createdEncounterIds);

    assert.ok(allNotifs && allNotifs.length > 0);
    for (const n of allNotifs) {
      assert.ok(!n.deep_link.includes('token='), `deep_link no debe contener token: ${n.deep_link}`);
      assert.ok(!n.deep_link.includes('/invite/'), `deep_link no debe exponer ruta de token individual: ${n.deep_link}`);
      assert.ok(!JSON.stringify(n.payload).includes('token_invitacion'), 'payload no debe contener token_invitacion');
      assert.ok(!JSON.stringify(n.payload).includes('public_token'), 'payload no debe contener public_token');
      assert.ok(!n.body.includes('Santa Fe 1234'), 'body no debe filtrar dirección privada');
    }
    console.log('  -> [8/8] PASÓ: Cero tokens privados y cero datos de logística sensible en notificaciones.');

    console.log('\n========================================================');
    console.log('✔ TODAS LAS 8 COMPUERTAS DE QA EN STAGING PASARON CON ÉXITO.');
    console.log('========================================================\n');
  } finally {
    console.log('[Cleanup] Limpiando fixtures de prueba en Supabase Staging...');
    if (createdEncounterIds.length > 0) {
      await admin.from('mensajes_encuentro').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('inbox_notifications').delete().in('target_id', createdEncounterIds);
      await admin.from('participantes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    if (createdUserIds.length > 0) {
      await admin.from('bloqueos_usuario').delete().in('blocker_id', createdUserIds);
      await admin.from('bloqueos_usuario').delete().in('blocked_id', createdUserIds);
      await admin.from('inbox_notifications').delete().in('recipient_user_id', createdUserIds);
      for (const uid of createdUserIds) {
        await admin.auth.admin.deleteUser(uid);
      }
    }
    console.log('[Cleanup] Limpieza en Supabase Staging concluida exitosamente.\n');
  }
}

runStagingMicrocorrectionsQA().catch((err) => {
  console.error('\n✖ ERROR FATAL EN STAGING QA:', err);
  process.exit(1);
});
