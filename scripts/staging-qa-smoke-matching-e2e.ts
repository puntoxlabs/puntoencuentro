/**
 * Staging Smoke QA E2E — Matching "Mis Ganas" con Relevancia de Actividad
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 *
 * Cobertura E2E Real en Staging:
 * 1. Caso Principal: Host crea encuentro abierto aprobado + Usuario B crea intención 'Jugar al pádel'.
 *    - Clasificación, matching inmediato, match_discoveries, domain_events_outbox (match.detected.v1).
 *    - Invocación de domain-events-worker en Staging -> inbox_notifications creado con copy tipado.
 * 2. Idempotencia & Deduplicación canónica:
 *    - Reintento de matching, reactivación, deduplicación durable.
 * 3. Consolidación Avisame + Mis ganas:
 *    - Misma persona con alerta manual + intención activa -> dedup identidad única.
 * 4. Casos Negativos Reales:
 *    - Pádel vs Café, multi-activity, genérica, pausada, host self-match, moderation pending, bloqueo bilateral.
 * 5. Multilingüe Real:
 *    - EN (Walking) ↔ ES (Caminata), PT (Trilha) ↔ ES (Senderismo).
 * 6. Limpieza exhaustiva de fixtures temporales.
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

async function runStagingSmokeMatchingE2E() {
  console.log('========================================================');
  console.log('STAGING SMOKE E2E REAL: MATCHING MIS GANAS V1');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('========================================================\n');

  const timestamp = Date.now();
  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];
  const createdIntentionIds: string[] = [];
  const createdSubscriptionIds: string[] = [];
  const createdDedupKeys: string[] = [];

  const qaPass = 'QaMatchingPass123!Safe';

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

  const createAuthClient = async (userId: string) => {
    const userObj = await admin.auth.admin.getUserById(userId);
    const email = userObj.data.user?.email || '';
    const client = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data, error } = await client.auth.signInWithPassword({ email, password: qaPass });
    if (error || !data.session) throw new Error(`Error login ${email}: ${error?.message}`);
    return client;
  };

  const createOpenEncounter = async (params: {
    hostId: string;
    titulo: string;
    descripcion?: string;
    modalidad?: string;
    localityId?: string | null;
    moderationStatus?: string;
    fecha?: string;
  }) => {
    const modalidad = params.modalidad || 'presencial';
    const isVirtual = modalidad === 'virtual';
    const locality_id = isVirtual ? null : (params.localityId || 'guemes');
    const open_public_zone = isVirtual ? 'Virtual' : 'Güemes';
    const fecha = params.fecha || new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0];

    const { data, error } = await admin
      .from('encuentros')
      .insert({
        host_id: params.hostId,
        titulo: params.titulo,
        descripcion: params.descripcion || null,
        modalidad,
        locality_id,
        open_public_zone,
        tipo_invitacion: 'link_general',
        max_participants: 4,
        fecha,
        hora: '18:00:00',
        is_open: true,
        opened_at: new Date().toISOString(),
        estado: 'activo',
        moderation_status: params.moderationStatus || 'approved',
      })
      .select('id, open_activity_canonical, open_activity_matching_eligible')
      .single();

    if (error || !data) throw new Error(`Error creando encuentro abierto "${params.titulo}": ${error?.message}`);
    createdEncounterIds.push(data.id);
    return data;
  };

  const callWorker = async () => {
    const res = await fetch(`${url}/functions/v1/domain-events-worker`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Worker HTTP ${res.status}: ${txt}`);
    }
    return await res.json();
  };

  try {
    // ------------------------------------------------------------------------
    // FASE 1: CASO PRINCIPAL CONTROLADO (Pádel)
    // ------------------------------------------------------------------------
    console.log('[1/5] Caso Principal: Host publica encuentro de pádel + Usuario B crea intención...');

    const hostAId = await createQAUser(`qa-host-a-${timestamp}@puntoencuentro.test`, 'QA Host A');
    const userBId = await createQAUser(`qa-user-b-${timestamp}@puntoencuentro.test`, 'QA User B');

    const clientB = await createAuthClient(userBId);

    // 1. Host A crea encuentro abierto aprobado de pádel
    const encA = await createOpenEncounter({
      hostId: hostAId,
      titulo: 'Partido de pádel sábado',
      descripcion: 'Jugamos partido en pareja en Güemes',
      modalidad: 'presencial',
      localityId: 'guemes',
    });

    console.log(`  -> Encuentro creado: ${encA.id}`);
    console.log(`  -> Clasificación encuentro: canonical = ${encA.open_activity_canonical}, eligible = ${encA.open_activity_matching_eligible}`);
    assert.equal(encA.open_activity_canonical, 'padel');
    assert.equal(encA.open_activity_matching_eligible, true);

    // 2. Usuario B crea intención activa 'Jugar al pádel'
    const { data: intRes, error: intErr } = await clientB.rpc('crear_intencion_segura', {
      p_titulo: 'Jugar al pádel',
      p_descripcion: 'Busco gente para jugar el finde',
      p_temporalidad_texto: 'fin de semana',
      p_fecha_desde: null,
      p_fecha_hasta: null,
      p_modalidad: 'presencial',
      p_locality_id: 'guemes',
    });

    assert.ok(!intErr, `Error RPC crear_intencion_segura: ${intErr?.message}`);
    const intResult = intRes as { ok: boolean; id: string; matches_found_count: number; matched_encounter_ids: string[] };
    assert.equal(intResult.ok, true);
    assert.ok(intResult.id, 'Intención no devolvió ID');
    createdIntentionIds.push(intResult.id);

    console.log(`  -> Intención creada: ${intResult.id}`);
    console.log(`  -> Feedback inmediato: count = ${intResult.matches_found_count}, matched_ids = ${JSON.stringify(intResult.matched_encounter_ids)}`);
    assert.equal(intResult.matches_found_count, 1);
    assert.deepEqual(intResult.matched_encounter_ids, [encA.id]);

    // 3. Verificar persistencia en intenciones
    const { data: intRow } = await admin
      .from('intenciones')
      .select('activity_canonical, activity_matching_eligible, match_ineligible_reason')
      .eq('id', intResult.id)
      .single();

    assert.equal(intRow?.activity_canonical, 'padel');
    assert.equal(intRow?.activity_matching_eligible, true);
    assert.equal(intRow?.match_ineligible_reason, null);

    // 4. Verificar fila en match_discoveries
    const { data: discoveryRow, error: discErr } = await admin
      .from('match_discoveries')
      .select('*')
      .eq('user_id', userBId)
      .eq('encounter_id', encA.id)
      .single();

    assert.ok(!discErr, `Error consultando match_discoveries: ${discErr?.message}`);
    assert.ok(discoveryRow, 'No se encontró fila en match_discoveries');
    assert.equal(discoveryRow.activity_canonical, 'padel');
    assert.equal(discoveryRow.primary_source, 'intention');
    console.log(`  -> match_discoveries registrado: discovery_id = ${discoveryRow.id}`);

    // 5. Verificar evento en Transactional Outbox
    const expectedDedupKey = `match:${userBId}:${encA.id}:v1`;
    createdDedupKeys.push(expectedDedupKey);

    const { data: outboxRow, error: outErr } = await admin
      .from('domain_events_outbox')
      .select('*')
      .eq('dedup_key', expectedDedupKey)
      .single();

    assert.ok(!outErr, `Error consultando outbox: ${outErr?.message}`);
    assert.ok(outboxRow, 'No se encontró evento en domain_events_outbox');
    assert.equal(outboxRow.event_type, 'match.detected.v1');
    assert.equal(outboxRow.payload.title, 'Encontramos algo para vos');
    assert.equal(outboxRow.payload.body, 'Hay un encuentro que coincide con algo que tenés ganas de hacer.');
    console.log(`  -> domain_events_outbox: event_id = ${outboxRow.id}, status = ${outboxRow.status}`);

    // 6. Ejecutar domain-events-worker en Staging o esperar su procesamiento asíncrono automático
    console.log('  -> Despachando/verificando lote en domain-events-worker de Staging...');
    try {
      const workerRes = await callWorker();
      console.log(`  -> Worker response: claimed = ${workerRes.claimed}, processed = ${workerRes.processed}`);
    } catch (e: any) {
      console.log(`  -> Worker invocación directa nota: ${e.message}`);
    }

    // 7. Esperar a que el worker asíncrono o la invocación marque 'processed' (hasta 6 segundos)
    let outboxProcessed: any = null;
    for (let i = 0; i < 12; i++) {
      const { data } = await admin
        .from('domain_events_outbox')
        .select('status')
        .eq('dedup_key', expectedDedupKey)
        .single();
      if (data?.status === 'processed') {
        outboxProcessed = data;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    assert.equal(outboxProcessed?.status, 'processed');

    const { data: inboxRow, error: inbErr } = await admin
      .from('inbox_notifications')
      .select('*')
      .eq('dedup_key', expectedDedupKey)
      .single();

    assert.ok(!inbErr, `Error consultando inbox: ${inbErr?.message}`);
    assert.ok(inboxRow, 'No se encontró notificación en inbox_notifications');
    assert.equal(inboxRow.recipient_user_id, userBId);
    assert.equal(inboxRow.notification_type, 'match_found');
    assert.equal(inboxRow.target_type, 'encounter');
    assert.equal(inboxRow.target_id, encA.id);
    assert.equal(inboxRow.title, 'Encontramos algo para vos');
    assert.equal(inboxRow.body, 'Hay un encuentro que coincide con algo que tenés ganas de hacer.');
    assert.equal(inboxRow.deep_link, `/?open_encounter=${encA.id}`);
    console.log(`  -> inbox_notifications creada: id = ${inboxRow.id}, deep_link = ${inboxRow.deep_link}`);

    // 8. Verificar notification_delivery_outbox / Web Push trigger
    const { data: deliveryRows } = await admin
      .from('notification_delivery_outbox')
      .select('*')
      .eq('notification_id', inboxRow.id);

    console.log(`  -> notification_delivery_outbox disparado: ${deliveryRows?.length || 0} entregas preparadas`);

    console.log('  ✔ Caso Principal E2E PASS.\n');

    // ------------------------------------------------------------------------
    // FASE 2: IDEMPOTENCIA & DEDUPE REAL
    // ------------------------------------------------------------------------
    console.log('[2/5] Probando Idempotencia & Deduplicación durable...');

    // A. Reintentar evaluación sobre la misma intención
    const evalSameInt = await admin.rpc('evaluar_matching_intencion_activa', { p_intencion_id: intResult.id });
    assert.equal((evalSameInt.data as any)?.matches_found_count, 0);

    // B. Reintentar inserción del mismo inbox notification
    const { data: retryInbox } = await admin.rpc('insertar_inbox_notification_seguro', {
      p_recipient_user_id: userBId,
      p_notification_type: 'match_found',
      p_target_type: 'encounter',
      p_target_id: encA.id,
      p_deep_link: `/?open_encounter=${encA.id}`,
      p_title: 'Encontramos algo para vos',
      p_body: 'Hay un encuentro que coincide con algo que tenés ganas de hacer.',
      p_payload: {},
      p_dedup_key: expectedDedupKey,
      p_expires_at: null,
    });
    assert.equal((retryInbox as any)?.inserted, false);

    // C. Pausar y reactivar la intención
    await clientB.rpc('cambiar_estado_intencion_segura', { p_id: intResult.id, p_nuevo_estado: 'pausada' });
    const { data: reactivateRes } = await clientB.rpc('cambiar_estado_intencion_segura', {
      p_id: intResult.id,
      p_nuevo_estado: 'activa',
    });
    assert.equal((reactivateRes as any)?.matches_found_count, 0);

    // D. Contar filas totales en match_discoveries e inbox para este par
    const { count: discoCount } = await admin
      .from('match_discoveries')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userBId)
      .eq('encounter_id', encA.id);
    assert.equal(discoCount, 1);

    const { count: inboxCount } = await admin
      .from('inbox_notifications')
      .select('*', { count: 'exact', head: true })
      .eq('dedup_key', expectedDedupKey);
    assert.equal(inboxCount, 1);

    console.log('  ✔ Idempotencia y Dedupe PASS (exactamente 1 discovery y 1 inbox notification).\n');

    // ------------------------------------------------------------------------
    // FASE 3: AVISAME + MIS GANAS CONSOLIDADOS
    // ------------------------------------------------------------------------
    console.log('[3/5] Probando coexistencia Avisame + Mis ganas para el mismo usuario...');

    // Host A crea un segundo encuentro de pádel
    const encA2 = await createOpenEncounter({
      hostId: hostAId,
      titulo: 'Segundo torneo de pádel',
      descripcion: 'Torneo relámpago',
      modalidad: 'presencial',
      localityId: 'guemes',
      fecha: new Date(Date.now() + 86400000 * 5).toISOString().split('T')[0],
    });

    // Usuario B crea suscripción manual Avisame
    const { data: subRow } = await admin
      .from('match_alert_subscriptions')
      .insert({
        user_id: userBId,
        status: 'active',
        modalidad: 'presencial',
        locality_id: 'guemes',
      })
      .select('id')
      .single();

    assert.ok(subRow?.id);
    createdSubscriptionIds.push(subRow.id);

    // Evaluar matching del encuentro abierto encA2 (tiene candidata intención activa + candidata suscripción)
    const { data: evalEnc2 } = await admin.rpc('evaluar_matching_encuentro_abierto', { p_encuentro_id: encA2.id });
    assert.equal((evalEnc2 as any)?.matches_count, 1);

    const { count: discoEnc2Count } = await admin
      .from('match_discoveries')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userBId)
      .eq('encounter_id', encA2.id);
    assert.equal(discoEnc2Count, 1);

    const expectedDedup2 = `match:${userBId}:${encA2.id}:v1`;
    createdDedupKeys.push(expectedDedup2);

    const { data: discoRow2 } = await admin
      .from('match_discoveries')
      .select('primary_source, matched_intention_id')
      .eq('user_id', userBId)
      .eq('encounter_id', encA2.id)
      .single();

    assert.equal(discoRow2?.primary_source, 'intention');
    assert.equal(discoRow2?.matched_intention_id, intResult.id);

    console.log('  ✔ Avisame + Mis ganas consolidado PASS (una sola fila, priorizó intention).\n');

    // Limpiamos la suscripción manual Avisame para aislar los casos negativos de intención
    await admin.from('match_alert_subscriptions').delete().eq('id', subRow.id);
    const subIdx = createdSubscriptionIds.indexOf(subRow.id);
    if (subIdx !== -1) createdSubscriptionIds.splice(subIdx, 1);

    // ------------------------------------------------------------------------
    // FASE 4: CASOS NEGATIVOS EN STAGING
    // ------------------------------------------------------------------------
    console.log('[4/5] Probando Casos Negativos...');

    // A. Pádel vs Café
    const encCafe = await createOpenEncounter({
      hostId: hostAId,
      titulo: 'Tomar un café de especialidad',
      modalidad: 'presencial',
      localityId: 'guemes',
    });

    const evalCafe = await admin.rpc('evaluar_matching_encuentro_abierto', { p_encuentro_id: encCafe.id });
    assert.equal((evalCafe.data as any)?.matches_count, 0);
    console.log('  ✔ Caso Negativo A (Pádel vs Café) -> 0 matches');

    // B. Multi-activity ('Caminar y tomar café')
    const { data: intMulti } = await clientB.rpc('crear_intencion_segura', {
      p_titulo: 'Caminar y tomar un café',
      p_modalidad: 'presencial',
      p_locality_id: 'guemes',
    });
    createdIntentionIds.push((intMulti as any).id);
    assert.equal((intMulti as any).matches_found_count, 0);
    const { data: rowMulti } = await admin
      .from('intenciones')
      .select('activity_matching_eligible, match_ineligible_reason')
      .eq('id', (intMulti as any).id)
      .single();
    assert.equal(rowMulti?.activity_matching_eligible, false);
    assert.equal(rowMulti?.match_ineligible_reason, 'multiple_activities');
    console.log('  ✔ Caso Negativo B (Multi-activity) -> multiple_activities / eligible=false');

    // C. Genérica ('Hacer algo el sábado')
    const { data: intGeneric } = await clientB.rpc('crear_intencion_segura', {
      p_titulo: 'Hacer algo el sábado',
      p_modalidad: 'presencial',
      p_locality_id: 'guemes',
    });
    createdIntentionIds.push((intGeneric as any).id);
    assert.equal((intGeneric as any).matches_found_count, 0);
    const { data: rowGeneric } = await admin
      .from('intenciones')
      .select('activity_matching_eligible, match_ineligible_reason')
      .eq('id', (intGeneric as any).id)
      .single();
    assert.equal(rowGeneric?.activity_matching_eligible, false);
    assert.equal(rowGeneric?.match_ineligible_reason, 'no_activity_detected');
    console.log('  ✔ Caso Negativo C (Genérica) -> no_activity_detected / eligible=false');

    // D. Intención pausada
    const { data: intPausada } = await clientB.rpc('crear_intencion_segura', {
      p_titulo: 'Taller de cerámica',
      p_modalidad: 'presencial',
      p_locality_id: 'guemes',
    });
    createdIntentionIds.push((intPausada as any).id);
    await clientB.rpc('cambiar_estado_intencion_segura', { p_id: (intPausada as any).id, p_nuevo_estado: 'pausada' });

    const encCeramica = await createOpenEncounter({
      hostId: hostAId,
      titulo: 'Hacer cerámica juntos',
      modalidad: 'presencial',
      localityId: 'guemes',
    });

    const evalCeramicaPausada = await admin.rpc('evaluar_matching_encuentro_abierto', { p_encuentro_id: encCeramica.id });
    assert.equal((evalCeramicaPausada.data as any)?.matches_count, 0);
    console.log('  ✔ Caso Negativo D (Intención pausada) -> 0 matches');

    // E. Host self-match (Usuario B publica encuentro de pádel)
    const encSelf = await createOpenEncounter({
      hostId: userBId,
      titulo: 'Pádel mixto fin de semana',
      modalidad: 'presencial',
      localityId: 'guemes',
    });

    const evalSelf = await admin.rpc('evaluar_matching_encuentro_abierto', { p_encuentro_id: encSelf.id });
    assert.equal((evalSelf.data as any)?.matches_count, 0);
    console.log('  ✔ Caso Negativo E (Host self-match) -> 0 matches');

    // F. Moderation pending
    const encPending = await createOpenEncounter({
      hostId: hostAId,
      titulo: 'Pádel nocturno',
      modalidad: 'presencial',
      localityId: 'guemes',
      moderationStatus: 'review_pending',
    });

    const evalPending = await admin.rpc('evaluar_matching_encuentro_abierto', { p_encuentro_id: encPending.id });
    assert.equal((evalPending.data as any)?.matches_count, 0);
    console.log('  ✔ Caso Negativo F (Moderation pending) -> 0 matches');

    // G. Bloqueo bilateral
    await admin.from('bloqueos_usuario').insert({ blocker_id: hostAId, blocked_id: userBId });
    const encBlocked = await createOpenEncounter({
      hostId: hostAId,
      titulo: 'Pádel amigos',
      modalidad: 'presencial',
      localityId: 'guemes',
    });

    const evalBlocked = await admin.rpc('evaluar_matching_encuentro_abierto', { p_encuentro_id: encBlocked.id });
    assert.equal((evalBlocked.data as any)?.matches_count, 0);
    await admin.from('bloqueos_usuario').delete().eq('blocker_id', hostAId).eq('blocked_id', userBId);
    console.log('  ✔ Caso Negativo G (Bloqueo bilateral) -> 0 matches\n');

    // ------------------------------------------------------------------------
    // FASE 5: MULTILINGÜE REAL EN STAGING
    // ------------------------------------------------------------------------
    console.log('[5/5] Probando matching Multilingüe Real en Staging...');

    // 1. EN: Walking this weekend vs Salir a caminar
    const encCaminata = await createOpenEncounter({
      hostId: hostAId,
      titulo: 'Salir a caminar por la costa',
      modalidad: 'presencial',
      localityId: 'guemes',
    });

    const { data: intEN } = await clientB.rpc('crear_intencion_segura', {
      p_titulo: 'Walking this weekend',
      p_modalidad: 'presencial',
      p_locality_id: 'guemes',
    });
    createdIntentionIds.push((intEN as any).id);
    assert.equal((intEN as any).matches_found_count, 1);
    assert.deepEqual((intEN as any).matched_encounter_ids, [encCaminata.id]);
    console.log('  ✔ Multilingüe EN ("Walking this weekend" ↔ "Salir a caminar") -> MATCH (caminata)');

    // 2. PT: Quero fazer uma trilha vs Senderismo en la sierra
    const encSenderismo = await createOpenEncounter({
      hostId: hostAId,
      titulo: 'Senderismo en la sierra',
      modalidad: 'presencial',
      localityId: 'guemes',
    });

    const { data: intPT } = await clientB.rpc('crear_intencion_segura', {
      p_titulo: 'Quero fazer uma trilha',
      p_modalidad: 'presencial',
      p_locality_id: 'guemes',
    });
    createdIntentionIds.push((intPT as any).id);
    assert.equal((intPT as any).matches_found_count, 1);
    assert.deepEqual((intPT as any).matched_encounter_ids, [encSenderismo.id]);
    console.log('  ✔ Multilingüe PT ("Quero fazer uma trilha" ↔ "Senderismo") -> MATCH (senderismo)\n');

    console.log('========================================================');
    console.log('TODAS LAS PRUEBAS E2E REALES EN STAGING COMPLETADAS CON ÉXITO');
    console.log('========================================================\n');
  } finally {
    // ------------------------------------------------------------------------
    // FASE 6: LIMPIEZA DE DATOS CONTROLADOS EN STAGING
    // ------------------------------------------------------------------------
    console.log('Limpiando fixtures de prueba en Staging...');

    if (createdSubscriptionIds.length > 0) {
      await admin.from('match_alert_subscriptions').delete().in('id', createdSubscriptionIds);
    }
    if (createdIntentionIds.length > 0) {
      await admin.from('intenciones').delete().in('id', createdIntentionIds);
    }
    if (createdEncounterIds.length > 0) {
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    if (createdUserIds.length > 0) {
      await admin.from('match_discoveries').delete().in('user_id', createdUserIds);
      await admin.from('inbox_notifications').delete().in('recipient_user_id', createdUserIds);
      await admin.from('domain_events_outbox').delete().in('actor_user_id', createdUserIds);
      for (const uid of createdUserIds) {
        await admin.auth.admin.deleteUser(uid);
      }
    }
    console.log('Limpieza de fixtures completada.');
  }
}

runStagingSmokeMatchingE2E()
  .then(() => {
    console.log('EXITO TOTAL E2E STAGING');
    process.exit(0);
  })
  .catch((err) => {
    console.error('ERROR E2E STAGING:', err);
    process.exit(1);
  });
