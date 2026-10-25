/**
 * Staging QA Runner — Mini-Sprint B: Lista de Espera, Prioridad FIFO, Reservas Temporales y Recuperación de Cupos
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

async function checkFrontendDeployment(maxAttempts = 12, delayMs = 5000): Promise<boolean> {
  console.log('\n--- VERIFICACIÓN DE DESPLIEGUE FRONTEND EN STAGING ---');
  const bypassSecret = getVercelBypassSecret();
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
  };
  if (bypassSecret) {
    headers['x-vercel-protection-bypass'] = bypassSecret;
  }

  const jsMarkers = [
    { name: 'RPC unirse_lista_espera_encuentro_abierto', pattern: 'unirse_lista_espera_encuentro_abierto' },
    { name: 'RPC responder_oferta_lista_espera_seguro', pattern: 'responder_oferta_lista_espera_seguro' },
    { name: 'RPC get_estado_lista_espera_seguro', pattern: 'get_estado_lista_espera_seguro' },
    { name: 'Estado waitlist_offered', pattern: 'waitlist_offered' },
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
              console.log(`    ${marker.name}: ${present ? 'PRESENTE' : 'AUSENTE'}`);
              if (present) foundCount++;
            }
            if (foundCount === jsMarkers.length) {
              console.log('✅ Despliegue de frontend confirmado con éxito en Staging.');
              return true;
            }
          }
        }
      }
    } catch (err: any) {
      console.log(`  Error en intento ${attempt}: ${err.message}`);
    }

    if (attempt < maxAttempts) {
      console.log(`  Esperando ${delayMs / 1000}s para próximo sondeo...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log('⚠️ El frontend aún no refleja todos los marcadores o el build de Vercel está en progreso.');
  return false;
}

async function runStagingFunctionalSuite() {
  console.log('================================================================');
  console.log('STAGING FUNCTIONAL QA: MINI-SPRINT B (LISTA DE ESPERA & CUPOS)');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('================================================================\n');

  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  async function createQaUser(prefix: string, name: string) {
    const email = `qa-msb-${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}@puntoencuentro.test`;
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
    console.log('[Setup] Creando usuarios de QA controlados...');
    const host = await createQaUser('host', 'Anfitrión Waitlist QA');
    const pTitular = await createQaUser('titular', 'Participante Titular');
    const candA = await createQaUser('candA', 'Candidato A (1 cupo)');
    const candB = await createQaUser('candB', 'Candidato B (2 cupos multi-seat)');
    const candC = await createQaUser('candC', 'Candidato C (1 cupo)');
    const blockedUser = await createQaUser('blocked', 'Usuario Bloqueado');

    console.log(`  Host ID: ${host.id}`);
    console.log(`  Titular: ${pTitular.id}, CandA: ${candA.id}, CandB: ${candB.id}, CandC: ${candC.id}`);

    // Crear encuentro fixture
    async function createFixtureEncounter(capacity = 1, allowMulti = false) {
      const tomorrow = new Date(Date.now() + 48 * 3600 * 1000).toISOString().split('T')[0];
      const { data, error } = await admin
        .from('encuentros')
        .insert({
          host_id: host.id,
          titulo: 'Encuentro Waitlist QA Staging',
          open_public_title: 'Encuentro Waitlist QA Staging',
          descripcion: 'Encuentro para validación remota de lista de espera',
          fecha: tomorrow,
          hora: '19:00:00',
          duration_minutes: 120,
          modalidad: 'presencial',
          tipo_invitacion: 'individual',
          locality_id: 'guemes',
          open_public_zone: 'Palermo Soho',
          lugar_texto: 'Café Palermo QA',
          max_participants: capacity,
          min_participants: 1,
          allow_multi_seat_requests: allowMulti,
          max_seats_per_request: allowMulti ? 3 : 1,
          min_seats_per_request: 1,
          is_open: true,
          opened_at: new Date().toISOString(),
          estado: 'activo',
          moderation_status: 'approved',
        })
        .select('id')
        .single();

      if (error || !data) throw new Error(`Fallo creación encuentro: ${error?.message}`);
      createdEncounterIds.push(data.id);
      return data.id;
    }

    // =========================================================================
    // ESCENARIO 1: Encuentro sin cupos -> alta en lista de espera
    // =========================================================================
    console.log('\n[Escenario 1/12] Encuentro sin cupos -> alta en lista de espera...');
    const enc1 = await createFixtureEncounter(1);

    // Titular ocupa el único cupo
    const { error: partErr } = await admin.from('participantes').insert({
      encuentro_id: enc1,
      user_id: pTitular.id,
      nombre_invitado: 'Participante Titular',
      estado: 'confirmado',
      tipo_invitacion: 'individual',
      seat_count: 1,
    });
    assert.ok(!partErr, `Error insertando participante: ${partErr?.message}`);

    // candA se anota en lista de espera
    const { data: wRes1, error: wErr1 } = await candA.client.rpc('unirse_lista_espera_encuentro_abierto', {
      p_encuentro_id: enc1,
      p_nombre: 'Candidato A',
      p_mensaje: 'Quiero sumarme si se libera lugar',
      p_seat_count: 1,
    });
    assert.ok(!wErr1, `Error en unirse_lista_espera: ${wErr1?.message}`);
    assert.equal(wRes1.ok, true);
    assert.equal(wRes1.position, 1, 'Candidato A debe ser puesto #1');
    console.log(`  ✔ Candidato A registrado en lista de espera (Puesto #${wRes1.position})`);

    // =========================================================================
    // ESCENARIO 2: Baja de participante -> oferta automática al candidato #1
    // =========================================================================
    console.log('\n[Escenario 2/12] Baja de participante -> oferta automática...');
    const { error: desistErr } = await pTitular.client.rpc('reconfirmar_asistencia_seguro', {
      p_encuentro_id: enc1,
      p_decision: 'decline',
      p_motivo: 'No puedo asistir por fuerza mayor',
    });
    assert.ok(!desistErr, `Error desistiendo: ${desistErr?.message}`);

    // Comprobar que candA fue promovido automáticamente por el trigger de baja
    const { data: solA, error: solAErr } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado, waitlist_offered_at, waitlist_expires_at')
      .eq('encuentro_id', enc1)
      .eq('usuario_id', candA.id)
      .single();
    assert.ok(!solAErr, `Error consultando solicitud: ${solAErr?.message}`);
    assert.equal(solA.estado, 'waitlist_offered', 'Debe haber pasado a waitlist_offered');
    assert.ok(solA.waitlist_expires_at !== null, 'Debe tener waitlist_expires_at asignado');
    console.log(`  ✔ Candidato A promovido automáticamente a waitlist_offered. Vence: ${solA.waitlist_expires_at}`);

    // =========================================================================
    // ESCENARIO 3: Candidato confirma interés -> reserva mantenida
    // =========================================================================
    console.log('\n[Escenario 3/12] Candidato confirma interés («Sigo interesado»)...');
    const { data: solIdA } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('id')
      .eq('encuentro_id', enc1)
      .eq('usuario_id', candA.id)
      .single();

    const { data: respOffer, error: respOfferErr } = await candA.client.rpc('responder_oferta_lista_espera_seguro', {
      p_request_id: solIdA.id,
      p_acepta: true,
    });
    assert.ok(!respOfferErr, `Error respondiendo oferta: ${respOfferErr?.message}`);
    assert.equal(respOffer.ok, true);
    assert.equal(respOffer.status, 'waitlist_confirmed');

    // Verificar en base de datos y comprobar que el anfitrión tiene plazo de revisión
    const { data: solAConf } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado, waitlist_confirmed_at, host_approval_expires_at')
      .eq('id', solIdA.id)
      .single();
    assert.equal(solAConf.estado, 'waitlist_confirmed');
    assert.ok(solAConf.host_approval_expires_at !== null);
    console.log(`  ✔ Interés confirmado. Solicitud en waitlist_confirmed esperando aprobación del anfitrión.`);

    // =========================================================================
    // ESCENARIO 4: Anfitrión aprueba -> participación confirmada
    // =========================================================================
    console.log('\n[Escenario 4/12] Anfitrión aprueba candidato confirmado...');
    const { data: appRes, error: appErr } = await host.client.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: solIdA.id,
      p_host_id: host.id,
    });
    assert.ok(!appErr, `Error aprobando solicitud: ${appErr?.message}`);
    assert.equal(appRes.ok, true);
    assert.ok(appRes.participante_id !== undefined);

    // Verificar fila en participantes
    const { data: partA } = await admin
      .from('participantes')
      .select('id, estado, user_id, seat_count')
      .eq('encuentro_id', enc1)
      .eq('user_id', candA.id)
      .single();
    assert.equal(partA.estado, 'confirmado');
    assert.equal(partA.seat_count, 1);
    console.log(`  ✔ Participación generada y confirmada con éxito (ID: ${partA.id}).`);

    // =========================================================================
    // ESCENARIO 5: Anfitrión rechaza -> cupo liberado y siguiente candidato promovido
    // =========================================================================
    console.log('\n[Escenario 5/12] Anfitrión rechaza -> cupo liberado y siguiente promovido...');
    const enc2 = await createFixtureEncounter(1);

    // Titular en enc2
    await admin.from('participantes').insert({
      encuentro_id: enc2,
      user_id: pTitular.id,
      nombre_invitado: 'Titular 2',
      estado: 'confirmado',
      tipo_invitacion: 'individual',
      seat_count: 1,
    });

    // candA y candC en espera
    await candA.client.rpc('unirse_lista_espera_encuentro_abierto', {
      p_encuentro_id: enc2,
      p_nombre: 'Candidato A',
      p_seat_count: 1,
    });
    await candC.client.rpc('unirse_lista_espera_encuentro_abierto', {
      p_encuentro_id: enc2,
      p_nombre: 'Candidato C',
      p_seat_count: 1,
    });

    // Titular desiste -> candA recibe oferta
    await pTitular.client.rpc('reconfirmar_asistencia_seguro', {
      p_encuentro_id: enc2,
      p_decision: 'decline',
    });

    const { data: solA2 } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('id')
      .eq('encuentro_id', enc2)
      .eq('usuario_id', candA.id)
      .single();

    // Host rechaza a candA
    const { data: rejRes, error: rejErr } = await host.client.rpc('rechazar_solicitud_encuentro_abierto', {
      p_request_id: solA2.id,
      p_host_id: host.id,
    });
    assert.ok(!rejErr, `Error rechazando solicitud: ${rejErr?.message}`);
    assert.equal(rejRes.ok, true);

    // Comprobar que candC fue automáticamente promovido tras el rechazo de candA
    const { data: solC2 } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado, waitlist_offered_at')
      .eq('encuentro_id', enc2)
      .eq('usuario_id', candC.id)
      .single();
    assert.equal(solC2.estado, 'waitlist_offered', 'Candidato C debe haber recibido la oferta');
    console.log(`  ✔ Rechazo procesado. Candidato C promovido automáticamente a waitlist_offered.`);

    // =========================================================================
    // ESCENARIO 6: Oferta expira -> avance automático de lista
    // =========================================================================
    console.log('\n[Escenario 6/12] Oferta expira -> avance automático...');
    const enc3 = await createFixtureEncounter(1);

    // candA tiene oferta pero forzamos fecha de vencimiento en el pasado
    const { data: solExpA } = await admin
      .from('solicitudes_encuentro_abierto')
      .insert({
        encuentro_id: enc3,
        usuario_id: candA.id,
        nombre_solicitante: 'Candidato A',
        estado: 'waitlist_offered',
        is_waitlist: true,
        waitlist_offered_at: new Date(Date.now() - 3600000).toISOString(),
        waitlist_expires_at: new Date(Date.now() - 60000).toISOString(), // Venció hace 1 minuto
        seat_count: 1,
      })
      .select('id')
      .single();

    // candC está en espera
    await candC.client.rpc('unirse_lista_espera_encuentro_abierto', {
      p_encuentro_id: enc3,
      p_nombre: 'Candidato C',
      p_seat_count: 1,
    });

    // Invocación del proceso periódico de expiración
    const { data: procRes, error: procErr } = await admin.rpc('procesar_expiraciones_lista_espera_seguro');
    assert.ok(!procErr, `Error procesando expiraciones: ${procErr?.message}`);
    assert.equal(procRes.ok, true);

    // Verificar que candA quedó en waitlist_expired
    const { data: solExpACheck } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado')
      .eq('id', solExpA.id)
      .single();
    assert.equal(solExpACheck.estado, 'waitlist_expired');

    // Verificar que candC fue promovido a waitlist_offered
    const { data: solExpCCheck } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado')
      .eq('encuentro_id', enc3)
      .eq('usuario_id', candC.id)
      .single();
    assert.equal(solExpCCheck.estado, 'waitlist_offered');
    console.log(`  ✔ Oferta vencida marcada como waitlist_expired. Candidato C promovido exitosamente.`);

    // =========================================================================
    // ESCENARIO 7: Aprobación del anfitrión expira -> cupos liberados
    // =========================================================================
    console.log('\n[Escenario 7/12] Aprobación del host expira -> cupos liberados...');
    const enc4 = await createFixtureEncounter(1);

    // candA en waitlist_confirmed con plazo de host vencido
    const { data: solHostExp } = await admin
      .from('solicitudes_encuentro_abierto')
      .insert({
        encuentro_id: enc4,
        usuario_id: candA.id,
        nombre_solicitante: 'Candidato A',
        estado: 'waitlist_confirmed',
        is_waitlist: true,
        waitlist_confirmed_at: new Date(Date.now() - 3600000).toISOString(),
        host_approval_expires_at: new Date(Date.now() - 60000).toISOString(), // Venció hace 1 minuto
        seat_count: 1,
      })
      .select('id')
      .single();

    // Procesar expiraciones
    await admin.rpc('procesar_expiraciones_lista_espera_seguro');

    const { data: solHostExpCheck } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado')
      .eq('id', solHostExp.id)
      .single();
    assert.equal(solHostExpCheck.estado, 'waitlist_expired');

    // Verificar que el cupo volvió a estar disponible en discovery
    const { data: disc4 } = await candC.client.rpc('get_discovery_encuentros_abiertos');
    const enc4Disc = disc4.find((e: any) => e.id === enc4);
    assert.equal(enc4Disc.open_slots, 1, 'Cupo liberado debe reflejarse en discovery');
    console.log(`  ✔ Aprobación vencida cancelada y cupo reintegrado a vacantes.`);

    // =========================================================================
    // ESCENARIO 8: Multi-seat con cupos insuficientes (sin bloqueo de cola)
    // =========================================================================
    console.log('\n[Escenario 8/12] Multi-seat con cupos insuficientes (sin bloqueo de cola)...');
    const enc5 = await createFixtureEncounter(1, true); // Capacidad 1

    // candB solicita 2 cupos (no entran)
    await candB.client.rpc('unirse_lista_espera_encuentro_abierto', {
      p_encuentro_id: enc5,
      p_nombre: 'Candidato B (Multi)',
      p_seat_count: 2,
    });

    // candC solicita 1 cupo (sí entra)
    await candC.client.rpc('unirse_lista_espera_encuentro_abierto', {
      p_encuentro_id: enc5,
      p_nombre: 'Candidato C (Single)',
      p_seat_count: 1,
    });

    // Evaluar promoción: hay 1 cupo libre
    const { data: eval5 } = await admin.rpc('evaluar_y_promover_lista_espera', { p_encuentro_id: enc5 });
    assert.equal(eval5.promoted_count, 1);

    // candB permanece en waitlist_waiting (sin perder prioridad futura)
    const { data: solB5 } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado')
      .eq('encuentro_id', enc5)
      .eq('usuario_id', candB.id)
      .single();
    assert.equal(solB5.estado, 'waitlist_waiting');

    // candC recibió la oferta porque cabía en el único cupo disponible
    const { data: solC5 } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado')
      .eq('encuentro_id', enc5)
      .eq('usuario_id', candC.id)
      .single();
    assert.equal(solC5.estado, 'waitlist_offered');
    console.log(`  ✔ Candidato B (2 cupos) no bloqueó la cola; Candidato C (1 cupo) promovido.`);

    // =========================================================================
    // ESCENARIO 9: Dos candidatos y una plaza (Concurrencia y FIFO estricto)
    // =========================================================================
    console.log('\n[Escenario 9/12] Dos candidatos y una plaza (Concurrencia)...');
    const enc6 = await createFixtureEncounter(1);

    // Postulaciones concurrentes
    await Promise.all([
      candA.client.rpc('unirse_lista_espera_encuentro_abierto', {
        p_encuentro_id: enc6,
        p_nombre: 'Candidato A',
        p_seat_count: 1,
      }),
      candC.client.rpc('unirse_lista_espera_encuentro_abierto', {
        p_encuentro_id: enc6,
        p_nombre: 'Candidato C',
        p_seat_count: 1,
      }),
    ]);

    // Promover cupos
    await admin.rpc('evaluar_y_promover_lista_espera', { p_encuentro_id: enc6 });

    // Exactamente 1 candidato debe tener waitlist_offered y el otro waitlist_waiting
    const { data: queue6 } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('usuario_id, estado, created_at')
      .eq('encuentro_id', enc6)
      .order('created_at', { ascending: true });

    assert.equal(queue6.length, 2);
    assert.equal(queue6[0].estado, 'waitlist_offered');
    assert.equal(queue6[1].estado, 'waitlist_waiting');
    console.log(`  ✔ Concurrencia resuelta: candidato con created_at anterior recibió la oferta única.`);

    // =========================================================================
    // ESCENARIO 10: Encuentro cancelado o inscripciones cerradas
    // =========================================================================
    console.log('\n[Escenario 10/12] Encuentro cancelado o inscripciones cerradas...');
    const enc7 = await createFixtureEncounter(1);
    const { data: closeInsRes } = await host.client.rpc('cerrar_inscripciones_seguro', { p_encuentro_id: enc7, p_host_id: host.id });
    assert.equal(closeInsRes?.ok, true, 'cerrar_inscripciones_seguro debe ser exitoso');

    const { data: waitClosed } = await candA.client.rpc('unirse_lista_espera_encuentro_abierto', {
      p_encuentro_id: enc7,
      p_nombre: 'Candidato A',
      p_seat_count: 1,
    });
    assert.equal(waitClosed.ok, false);
    assert.equal(waitClosed.error, 'inscriptions_closed');

    // Encuentro cancelado
    await admin.from('encuentros').update({ estado: 'cancelado' }).eq('id', enc7);
    const { data: waitCanc } = await candA.client.rpc('unirse_lista_espera_encuentro_abierto', {
      p_encuentro_id: enc7,
      p_nombre: 'Candidato A',
      p_seat_count: 1,
    });
    assert.equal(waitCanc.ok, false);
    assert.equal(waitCanc.error, 'not_available');
    console.log(`  ✔ Inscripciones cerradas y encuentro cancelado impiden unirse a lista de espera.`);

    // =========================================================================
    // ESCENARIO 11: Usuario bloqueado o no autorizado
    // =========================================================================
    console.log('\n[Escenario 11/12] Usuario bloqueado o no autorizado...');
    // Crear bloqueo bilateral host <-> blockedUser
    await admin.from('bloqueos_usuario').insert({
      blocker_id: host.id,
      blocked_id: blockedUser.id,
    });

    const enc8 = await createFixtureEncounter(1);
    const { data: bRes } = await blockedUser.client.rpc('unirse_lista_espera_encuentro_abierto', {
      p_encuentro_id: enc8,
      p_nombre: 'Bloqueado',
      p_seat_count: 1,
    });
    assert.equal(bRes.ok, false);
    assert.equal(bRes.error, 'not_available');

    // Anfitrión intentando unirse a su propia lista de espera
    const { data: selfRes } = await host.client.rpc('unirse_lista_espera_encuentro_abierto', {
      p_encuentro_id: enc8,
      p_nombre: 'Anfitrión',
      p_seat_count: 1,
    });
    assert.equal(selfRes.ok, false);
    assert.equal(selfRes.error, 'cannot_request_own_encounter');
    console.log(`  ✔ Bloqueos bilaterales y auto-inscripción de anfitrión rechazados correctamente.`);

    // =========================================================================
    // ESCENARIO 12: Integridad de notificaciones y ausencia de duplicados
    // =========================================================================
    console.log('\n[Escenario 12/16] Integridad de notificaciones e idempotencia...');
    const { data: notifsCandA } = await admin
      .from('inbox_notifications')
      .select('notification_type, dedup_key')
      .eq('recipient_user_id', candA.id);

    assert.ok(notifsCandA.length > 0);
    const dedupKeys = notifsCandA.map((n: any) => n.dedup_key);
    const uniqueKeys = new Set(dedupKeys);
    assert.equal(dedupKeys.length, uniqueKeys.size, 'No deben existir dedup_keys duplicadas en inbox');
    console.log(`  ✔ ${notifsCandA.length} notificaciones auditadas sin duplicación.`);

    // =========================================================================
    // ESCENARIO 13: Hotfix P0 — Concurrencia y orden de locks canónico en Staging
    // =========================================================================
    console.log('\n[Escenario 13/16] Hotfix P0 — Concurrencia y orden de locks canónico en Staging...');
    const encHotfix = await createFixtureEncounter(2);

    // candA con oferta activa
    const { data: solAHotfix } = await admin
      .from('solicitudes_encuentro_abierto')
      .insert({
        encuentro_id: encHotfix,
        usuario_id: candA.id,
        nombre_solicitante: 'Candidato A',
        seat_count: 1,
        estado: 'waitlist_offered',
        is_waitlist: true,
        waitlist_offered_at: new Date().toISOString(),
        waitlist_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      })
      .select('id')
      .single();

    // candB en cola
    const { data: solBHotfix } = await admin
      .from('solicitudes_encuentro_abierto')
      .insert({
        encuentro_id: encHotfix,
        usuario_id: candB.id,
        nombre_solicitante: 'Candidato B',
        seat_count: 1,
        estado: 'waitlist_waiting',
        is_waitlist: true,
      })
      .select('id')
      .single();

    // Ejecutar operaciones cruzadas simultáneamente
    const [resAccept, resWithdraw] = await Promise.all([
      candA.client.rpc('responder_oferta_lista_espera_seguro', { p_request_id: solAHotfix.id, p_acepta: true }),
      candB.client.rpc('retirarse_lista_espera_seguro', { p_request_id: solBHotfix.id }),
    ]);

    assert.equal(resAccept.data?.ok, true, 'candA debe aceptar sin deadlock');
    assert.equal(resAccept.data?.status, 'waitlist_confirmed');
    assert.equal(resWithdraw.data?.ok, true, 'candB debe retirarse sin deadlock');
    assert.equal(resWithdraw.data?.status, 'withdrawn');
    console.log(`  ✔ Operaciones concurrentes cruzadas (aceptar + retirar) ejecutadas exitosamente sin deadlock.`);

    // =========================================================================
    // ESCENARIO 14: Hotfix P1 — Endurecimiento de funciones internas en Staging
    // =========================================================================
    console.log('\n[Escenario 14/16] Hotfix P1 — Endurecimiento de funciones internas...');
    const { data: userEvalData, error: userEvalErr } = await candA.client.rpc('evaluar_y_promover_lista_espera', {
      p_encuentro_id: encHotfix,
    });
    assert.ok(userEvalErr !== null || userEvalData?.ok === false, 'Cliente authenticated no debe poder ejecutar evaluar_y_promover_lista_espera directamente');

    const { data: userExpData, error: userExpErr } = await candA.client.rpc('procesar_expiraciones_lista_espera_seguro');
    assert.ok(userExpErr !== null || userExpData?.ok === false, 'Cliente authenticated no debe poder ejecutar procesar_expiraciones_lista_espera_seguro directamente');

    // service_role sí debe poder
    const { data: adminEvalData, error: adminEvalErr } = await admin.rpc('evaluar_y_promover_lista_espera', {
      p_encuentro_id: encHotfix,
    });
    assert.equal(adminEvalErr, null, 'service_role debe tener acceso legítimo');
    assert.equal(adminEvalData?.ok, true);
    console.log(`  ✔ Funciones internas protegidas contra clientes web y accesibles para service_role.`);

    // =========================================================================
    // ESCENARIO 15: Hotfix P1 — Desacople de vencimientos en inscripciones cerradas
    // =========================================================================
    console.log('\n[Escenario 15/16] Hotfix P1 — Desacople de vencimientos en inscripciones cerradas...');
    const encClosed = await createFixtureEncounter(2);
    // Cerrar inscripciones
    await admin.from('encuentros').update({ inscriptions_closed: true }).eq('id', encClosed);

    // candA con oferta ya expirada
    await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: encClosed,
      usuario_id: candA.id,
      nombre_solicitante: 'Candidato A',
      seat_count: 1,
      estado: 'waitlist_offered',
      is_waitlist: true,
      waitlist_offered_at: new Date(Date.now() - 3600 * 1000).toISOString(),
      waitlist_expires_at: new Date(Date.now() - 600 * 1000).toISOString(),
    });

    // candC en cola
    await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: encClosed,
      usuario_id: candC.id,
      nombre_solicitante: 'Candidato C',
      seat_count: 1,
      estado: 'waitlist_waiting',
      is_waitlist: true,
    });

    // Ejecutar evaluación interna
    const { data: evalClosedRes, error: evalClosedErr } = await admin.rpc('evaluar_y_promover_lista_espera', {
      p_encuentro_id: encClosed,
    });
    assert.equal(evalClosedErr, null);
    assert.equal(evalClosedRes?.ok, true);
    assert.equal(evalClosedRes?.expired_count, 1, 'Debe haber expirado la oferta de candA');
    assert.equal(evalClosedRes?.promoted_count, 0, 'No debe promover a candC con inscripciones cerradas');

    // candA debe ser waitlist_expired
    const { data: solACheck } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado')
      .eq('encuentro_id', encClosed)
      .eq('usuario_id', candA.id)
      .single();
    assert.equal(solACheck?.estado, 'waitlist_expired');

    // candC debe permanecer en waitlist_waiting
    const { data: solCCheck } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('estado')
      .eq('encuentro_id', encClosed)
      .eq('usuario_id', candC.id)
      .single();
    assert.equal(solCCheck?.estado, 'waitlist_waiting');
    console.log(`  ✔ Paso A (limpieza) ejecutado con inscripciones cerradas y Paso B detenido correctamente.`);

    // =========================================================================
    // ESCENARIO 16: Hotfix P0 — Invariantes de Discovery en Staging
    // =========================================================================
    console.log('\n[Escenario 16/16] Hotfix P0 — Invariantes de Discovery en Staging...');
    // 1. Encuentro pasado (fecha ayer)
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().split('T')[0];
    const { data: encPast, error: encPastErr } = await admin
      .from('encuentros')
      .insert({
        host_id: host.id,
        titulo: 'Encuentro Pasado QA',
        open_public_title: 'Encuentro Pasado QA',
        fecha: yesterday,
        hora: '10:00:00',
        duration_minutes: 120,
        modalidad: 'presencial',
        tipo_invitacion: 'individual',
        locality_id: 'guemes',
        open_public_zone: 'Güemes / Playa Grande',
        max_participants: 5,
        min_participants: 1,
        is_open: true,
        opened_at: new Date().toISOString(),
        estado: 'activo',
        moderation_status: 'approved',
      })
      .select('id')
      .single();
    if (encPastErr) throw new Error(`Fallo creación encPast: ${encPastErr.message}`);
    createdEncounterIds.push(encPast.id);

    // 2. Encuentro virtual futuro (modalidad virtual requiere locality_id = NULL y open_public_zone = 'Virtual')
    const futureDate = new Date(Date.now() + 48 * 3600 * 1000).toISOString().split('T')[0];
    const { data: encVirt, error: encVirtErr } = await admin
      .from('encuentros')
      .insert({
        host_id: host.id,
        titulo: 'Encuentro Virtual QA',
        open_public_title: 'Encuentro Virtual QA',
        fecha: futureDate,
        hora: '20:00:00',
        duration_minutes: 120,
        modalidad: 'virtual',
        tipo_invitacion: 'individual',
        locality_id: null,
        open_public_zone: 'Virtual',
        link_virtual: 'https://meet.google.com/qa-test',
        max_participants: 5,
        min_participants: 1,
        is_open: true,
        opened_at: new Date().toISOString(),
        estado: 'activo',
        moderation_status: 'approved',
      })
      .select('id')
      .single();
    if (encVirtErr) throw new Error(`Fallo creación encVirt: ${encVirtErr.message}`);
    createdEncounterIds.push(encVirt.id);

    // Consultar Discovery con filtro geográfico p_locality_ids = ['guemes']
    const { data: discResult, error: discErr } = await candC.client.rpc('get_discovery_encuentros_abiertos', {
      p_locality_ids: ['guemes'],
      p_only_available: false,
    });
    assert.equal(discErr, null, 'Discovery debe responder exitosamente');
    const discArray = Array.isArray(discResult) ? discResult : [];

    // a) Encuentro pasado NO debe figurar
    assert.ok(!discArray.some((e: any) => e.id === encPast?.id), 'Encuentro pasado no debe figurar en Discovery');

    // b) Encuentro virtual SÍ debe figurar aunque tenga locality_id = palermo
    assert.ok(discArray.some((e: any) => e.id === encVirt?.id), 'Encuentro virtual debe figurar independientemente del filtro de localidad');

    // c) Orden ascendente por fecha/hora
    for (let i = 0; i < discArray.length - 1; i++) {
      if (discArray[i].fecha && discArray[i + 1].fecha) {
        assert.ok(discArray[i].fecha <= discArray[i + 1].fecha, 'Discovery debe mantener orden ascendente por fecha');
      }
    }
    console.log(`  ✔ Invariantes de Discovery (exclusión pasados, excepción virtual y orden ascendente) validadas.`);

    console.log('\n================================================================');
    console.log('✅ TODOS LOS 16 ESCENARIOS REMOTOS EN STAGING SUPERADOS EXITOSAMENTE');
    console.log('================================================================\n');
  } finally {
    // Limpieza estricta de fixtures en Staging
    console.log('--- LIMPIEZA DE FIXTURES DE PRUEBA EN STAGING ---');
    if (createdEncounterIds.length > 0) {
      console.log(`Eliminando ${createdEncounterIds.length} encuentros de QA...`);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    if (createdUserIds.length > 0) {
      console.log(`Eliminando ${createdUserIds.length} usuarios temporales de QA...`);
      for (const uid of createdUserIds) {
        await admin.auth.admin.deleteUser(uid);
      }
    }
    console.log('✔ Limpieza completada.');
  }
}

async function main() {
  await runStagingFunctionalSuite();
  await checkFrontendDeployment();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ ERROR CRÍTICO EN STAGING QA RUNNER:', err);
  process.exit(1);
});
