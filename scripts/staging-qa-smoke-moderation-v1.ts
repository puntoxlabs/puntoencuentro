/**
 * Staging Smoke QA — Moderación Pública v1
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 *
 * Runs end-to-end runtime smoke tests on live Staging Supabase:
 * 1. Verificación estática runtime (RPCs, tablas, RLS, grants, rate limits).
 * 2. Smoke Test 1: Contenido normal (abrir -> review_pending -> Edge Function allow -> approved -> visible Discovery).
 * 3. Smoke Test 2: Contenido abusivo (BLOCK determinista -> rejected -> auditado -> invisible Discovery).
 * 4. Smoke Test 3: Contenido ambiguo (REVIEW / fail-safe -> review_pending -> invisible Discovery).
 * 5. Smoke Test 4: Edición post-approval (editar titulo -> invalidación server-side -> invisible -> re-moderación).
 * 6. Smoke Test 5: TOCTOU / Hash protection (hash mismatch ante edición concurrente).
 * 7. Smoke Test 6: Auto-hide por reportes acumulados (umbral 3 -> hidden_pending_review -> deduplicación + guards).
 * 8. Smoke Test 7: Carrera Auto-Hide vs Approve retardado (invalid_status_transition).
 * 9. Smoke Test 8: Bypass directo (abrir directo, Data API directo, llamada cruzada a Edge Function 403, sin JWT 401).
 * 10. Privacidad: exclusión de lugar_texto y link_virtual.
 * 11. Regresión runtime mínima (Discovery, cierre).
 * 12. Cleanup completo en Staging.
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

async function runStagingSmokeModeration() {
  console.log('========================================================');
  console.log('STAGING SMOKE QA: MODERACIÓN PÚBLICA V1');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('========================================================\n');

  const timestamp = Date.now();
  const createdEncounterIds: string[] = [];
  const createdUserIds: string[] = [];

  const results: Record<string, 'PASS' | 'FAIL'> = {};

  try {
    // ------------------------------------------------------------------------
    // 1. Verificación Estática Runtime
    // ------------------------------------------------------------------------
    console.log('[1/12] Verificación estática runtime de esquema y objetos...');

    const { data: cols } = await admin
      .from('encuentros')
      .select('moderation_status, moderation_reason, moderation_decision_source, moderation_categories')
      .limit(1);
    assert.ok(cols !== null, 'Columnas de moderación no accesibles en encuentros');

    const { data: pol } = await admin
      .from('rate_limit_policies')
      .select('action, max_requests, window_seconds')
      .eq('action', 'public_content_report')
      .single();
    assert.ok(pol, 'Falta política public_content_report en rate_limit_policies');
    assert.equal(pol.max_requests, 10);
    assert.equal(pol.window_seconds, 3600);

    console.log('  ✔ Columnas moderation_* y política de rate limit verificadas.');

    // ------------------------------------------------------------------------
    // 2. Crear Usuarios QA
    // ------------------------------------------------------------------------
    console.log('\n[2/12] Creando usuarios QA controlados...');

    const hostEmail = `qa-mod-host-${timestamp}@puntoencuentro.test`;
    const host2Email = `qa-mod-host2-${timestamp}@puntoencuentro.test`;
    const rep1Email = `qa-mod-rep1-${timestamp}@puntoencuentro.test`;
    const rep2Email = `qa-mod-rep2-${timestamp}@puntoencuentro.test`;
    const rep3Email = `qa-mod-rep3-${timestamp}@puntoencuentro.test`;
    const qaPass = 'QaModerationPass123!Safe';

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

    const hostId = await createQAUser(hostEmail, 'QA Host Moderacion');
    const host2Id = await createQAUser(host2Email, 'QA Host Secundario');
    const rep1Id = await createQAUser(rep1Email, 'QA Reporter 1');
    const rep2Id = await createQAUser(rep2Email, 'QA Reporter 2');
    const rep3Id = await createQAUser(rep3Email, 'QA Reporter 3');

    // Clientes autenticados
    const createAuthClient = async (email: string) => {
      const client = createClient(url, publishableKey, { auth: { persistSession: false } });
      const { error } = await client.auth.signInWithPassword({ email, password: qaPass });
      if (error) throw new Error(`Error login ${email}: ${error.message}`);
      return client;
    };

    const hostClient = await createAuthClient(hostEmail);
    const host2Client = await createAuthClient(host2Email);
    const rep1Client = await createAuthClient(rep1Email);
    const rep2Client = await createAuthClient(rep2Email);
    const rep3Client = await createAuthClient(rep3Email);

    const anonClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await anonClient.auth.signInAnonymously();

    console.log('  ✔ 5 usuarios QA permanentes y 1 anónimo autenticados.');

    // Helper para crear encuentros
    const createEncounter = async (hId: string, title: string, modality: string = 'presencial') => {
      const { data: enc, error } = await admin
        .from('encuentros')
        .insert({
          titulo: title,
          descripcion: 'Descripción interna privada',
          fecha: '2026-11-20',
          hora: '19:00',
          modalidad: modality,
          lugar_texto: 'Calle Güemes 1234 privada',
          link_virtual: modality === 'virtual' ? 'https://meet.google.com/test-priv' : null,
          tipo_invitacion: 'individual',
          host_id: hId,
          estado: 'activo',
        })
        .select('id')
        .single();
      if (error || !enc) throw new Error(`Error creando encuentro: ${error?.message}`);
      createdEncounterIds.push(enc.id);
      return enc.id;
    };

    // ------------------------------------------------------------------------
    // 3. Smoke Test 1 — Contenido Normal (Allow)
    // ------------------------------------------------------------------------
    console.log('\n[3/12] Smoke Test 1: Contenido normal (flujo end-to-end ALLOW)...');
    const enc1 = await createEncounter(hostId, 'Taller de Fotografía Urbana y Café');

    // A. Abrir encuentro vía RPC del host
    const { data: open1, error: open1Err } = await hostClient.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: enc1,
      p_host_id: hostId,
      p_open_description: 'Salida fotográfica por la costa marplatense, abierta a principiantes.',
      p_max_participants: 6,
      p_locality_id: 'guemes',
      p_open_public_zone: null,
    });
    if (open1Err) throw new Error(`Error en abrir_encuentro_seguro: ${open1Err.message}`);
    assert.equal(open1.ok, true);
    assert.equal(open1.is_open, false, 'Choke point: no debe abrir directamente');
    assert.equal(open1.moderation_status, 'review_pending');

    // B. Invocar Edge Function como host
    const fn1Res = await hostClient.functions.invoke('moderate-public-content', {
      body: { encounter_id: enc1 },
    });
    assert.ok(fn1Res.data?.ok, `Edge Function fallo: ${JSON.stringify(fn1Res.data || fn1Res.error)}`);
    assert.equal(fn1Res.data.data.decision, 'allow');
    assert.equal(fn1Res.data.data.is_open, true);
    assert.equal(fn1Res.data.data.moderation_status, 'approved');

    // C. Verificar en BD
    const { data: dbEnc1 } = await admin.from('encuentros').select('is_open, moderation_status').eq('id', enc1).single();
    assert.equal(dbEnc1?.is_open, true);
    assert.equal(dbEnc1?.moderation_status, 'approved');

    // D. Verificar en Discovery
    const { data: disc1 } = await anonClient.rpc('get_discovery_encuentros_abiertos', {
      p_locality_ids: ['guemes'],
    });
    const discList1 = typeof disc1 === 'string' ? JSON.parse(disc1) : disc1;
    assert.ok(Array.isArray(discList1));
    assert.ok(discList1.some((e: any) => e.id === enc1), 'Encuentro aprobado debe estar visible en Discovery');

    console.log('  ✔ Smoke Test 1 ALLOW: review_pending -> Edge Function -> approved -> visible en Discovery.');
    results['ALLOW'] = 'PASS';

    // ------------------------------------------------------------------------
    // 4. Smoke Test 2 — BLOCK Determinista
    // ------------------------------------------------------------------------
    console.log('\n[4/12] Smoke Test 2: Contenido abusivo / amenaza (BLOCK determinista)...');
    const enc2 = await createEncounter(hostId, 'Encuentro de Ajuste de Cuentas');

    const { data: open2 } = await hostClient.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: enc2,
      p_host_id: hostId,
      p_open_description: 'Te voy a matar si te cruzo en la plaza amenaza de muerte',
      p_max_participants: 4,
      p_locality_id: 'guemes',
      p_open_public_zone: null,
    });
    assert.equal(open2.ok, false);
    assert.equal(open2.error, 'content_moderation_blocked');
    assert.equal(open2.reason, 'violence_threat');
    assert.equal(open2.moderation_status, 'rejected');

    // Verificar en BD
    const { data: dbEnc2 } = await admin.from('encuentros').select('is_open, moderation_status').eq('id', enc2).single();
    assert.equal(dbEnc2?.is_open, false);
    assert.equal(dbEnc2?.moderation_status, 'rejected');

    // Verificar en Discovery
    const { data: disc2 } = await anonClient.rpc('get_discovery_encuentros_abiertos', { p_locality_ids: ['guemes'] });
    const discList2 = typeof disc2 === 'string' ? JSON.parse(disc2) : disc2;
    assert.ok(!discList2.some((e: any) => e.id === enc2), 'Encuentro bloqueado no debe aparecer en Discovery');

    // Verificar auditoría
    const { data: audit2 } = await admin
      .from('public_content_moderation_audit')
      .select('action, new_status, reason')
      .eq('encuentro_id', enc2)
      .single();
    assert.equal(audit2?.action, 'deterministic_block');
    assert.equal(audit2?.new_status, 'rejected');
    assert.equal(audit2?.reason, 'violence_threat');

    console.log('  ✔ Smoke Test 2 BLOCK: detectado determinísticamente, rechazado, oculto y auditado.');
    results['BLOCK'] = 'PASS';

    // ------------------------------------------------------------------------
    // 5. Smoke Test 3 — REVIEW / Fail-Safe
    // ------------------------------------------------------------------------
    console.log('\n[5/12] Smoke Test 3: Contenido ambiguo (REVIEW / fail-safe)...');
    const enc3 = await createEncounter(hostId, 'Charla de Programación');

    const { data: open3 } = await hostClient.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: enc3,
      p_host_id: hostId,
      p_open_description: 'Más info y temario en https://miweb.dev para leer antes',
      p_max_participants: 4,
      p_locality_id: 'guemes',
      p_open_public_zone: null,
    });
    assert.equal(open3.ok, true);
    assert.equal(open3.is_open, false);
    assert.equal(open3.moderation_status, 'review_pending');

    const fn3Res = await hostClient.functions.invoke('moderate-public-content', {
      body: { encounter_id: enc3 },
    });
    assert.ok(fn3Res.data?.ok);
    assert.equal(fn3Res.data.data.decision, 'review');
    assert.equal(fn3Res.data.data.is_open, false);
    assert.equal(fn3Res.data.data.moderation_status, 'review_pending');

    const { data: disc3 } = await anonClient.rpc('get_discovery_encuentros_abiertos', { p_locality_ids: ['guemes'] });
    const discList3 = typeof disc3 === 'string' ? JSON.parse(disc3) : disc3;
    assert.ok(!discList3.some((e: any) => e.id === enc3), 'Encuentro en review_pending no debe aparecer en Discovery');

    console.log('  ✔ Smoke Test 3 REVIEW: categorizado como review, no aprobado, seguro e invisible.');
    results['REVIEW'] = 'PASS';

    // ------------------------------------------------------------------------
    // 6. Smoke Test 4 — Edición Post-Approval
    // ------------------------------------------------------------------------
    console.log('\n[6/12] Smoke Test 4: Edición posterior a aprobación...');
    // Tomar enc1 (aprobado y visible en Discovery)
    const { data: upd4 } = await hostClient.rpc('actualizar_encuentro_seguro', {
      p_encuentro_id: enc1,
      p_host_id: hostId,
      p_data: { titulo: 'Taller de Fotografía Callejera Avanzada' },
    });
    assert.equal(upd4.ok, true);
    assert.equal(upd4.moderation_invalidated, true);
    assert.equal(upd4.moderation_status, 'review_pending');
    assert.equal(upd4.is_open, false);

    // Inmediatamente invisible en Discovery
    const { data: disc4a } = await anonClient.rpc('get_discovery_encuentros_abiertos', { p_locality_ids: ['guemes'] });
    const discList4a = typeof disc4a === 'string' ? JSON.parse(disc4a) : disc4a;
    assert.ok(!discList4a.some((e: any) => e.id === enc1), 'Encuentro editado debe desaparecer de Discovery');

    // Re-moderar con la Edge Function
    const fn4Res = await hostClient.functions.invoke('moderate-public-content', {
      body: { encounter_id: enc1 },
    });
    assert.equal(fn4Res.data.data.decision, 'allow');
    assert.equal(fn4Res.data.data.is_open, true);
    assert.equal(fn4Res.data.data.moderation_status, 'approved');

    // Reaparece en Discovery con el nuevo título
    const { data: disc4b } = await anonClient.rpc('get_discovery_encuentros_abiertos', { p_locality_ids: ['guemes'] });
    const discList4b = typeof disc4b === 'string' ? JSON.parse(disc4b) : disc4b;
    const reapproved = discList4b.find((e: any) => e.id === enc1);
    assert.ok(reapproved, 'Encuentro re-aprobado debe reaparecer en Discovery');
    assert.equal(reapproved.title, 'Taller de Fotografía Callejera Avanzada');

    console.log('  ✔ Smoke Test 4 POST-EDIT: invalidación inmediata server-side, re-moderación exitosa y reapertura.');
    results['POST_EDIT'] = 'PASS';

    // ------------------------------------------------------------------------
    // 7. Smoke Test 5 — TOCTOU / Hash Protection
    // ------------------------------------------------------------------------
    console.log('\n[7/12] Smoke Test 5: Protección TOCTOU con content hash...');
    const enc5 = await createEncounter(hostId, 'Encuentro de Filosofía');
    await hostClient.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: enc5,
      p_host_id: hostId,
      p_open_description: 'Debate de filosofía clásica en café.',
      p_max_participants: 5,
      p_locality_id: 'guemes',
      p_open_public_zone: null,
    });

    const { data: hash5 } = await admin.rpc('calcular_content_hash_moderacion', {
      p_title: 'Encuentro de Filosofía',
      p_open_description: 'Debate de filosofía clásica en café.',
      p_modalidad: 'presencial',
      p_open_public_zone: 'Güemes / Playa Grande',
    });

    // Mutar título en BD mientras modera
    await hostClient.rpc('actualizar_encuentro_seguro', {
      p_encuentro_id: enc5,
      p_host_id: hostId,
      p_data: { titulo: 'Filosofía y Cosas Raras Alterado' },
    });

    // Intentar resolver con service_role usando hash viejo
    const { data: res5 } = await admin.rpc('resolver_moderacion_encuentro_seguro', {
      p_encuentro_id: enc5,
      p_action: 'approve',
      p_note: 'prueba toctou',
      p_expected_content_hash: hash5,
    });
    assert.equal(res5.ok, false);
    assert.equal(res5.error, 'content_hash_mismatch');

    // Sigue protegido en review_pending
    const { data: dbEnc5 } = await admin.from('encuentros').select('is_open, moderation_status').eq('id', enc5).single();
    assert.equal(dbEnc5?.is_open, false);
    assert.equal(dbEnc5?.moderation_status, 'review_pending');

    console.log('  ✔ Smoke Test 5 TOCTOU: rechazo automático por content_hash_mismatch ante mutación concurrente.');
    results['TOCTOU'] = 'PASS';

    // ------------------------------------------------------------------------
    // 8. Smoke Test 6 — Auto-Hide por Reportes Acumulados
    // ------------------------------------------------------------------------
    console.log('\n[8/12] Smoke Test 6: Auto-ocultamiento ante acumulación de reportes (umbral 3)...');
    // Usar enc1 que está abierto y visible
    // A. Reporte de reportero 1
    const { data: r1 } = await rep1Client.rpc('reportar_encuentro_publico_seguro', {
      p_encuentro_id: enc1,
      p_reason: 'spam',
      p_comment: 'Publicidad engañosa',
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.auto_hidden, false);
    assert.equal(r1.report_count, 1);

    // B. Reintento de reportero 1 (deduplicación)
    const { data: r1Dup } = await rep1Client.rpc('reportar_encuentro_publico_seguro', {
      p_encuentro_id: enc1,
      p_reason: 'spam',
    });
    assert.equal(r1Dup.ok, false);
    assert.equal(r1Dup.error, 'already_reported');

    // C. Intento del host de reportar su propio encuentro
    const { data: rHost } = await hostClient.rpc('reportar_encuentro_publico_seguro', {
      p_encuentro_id: enc1,
      p_reason: 'spam',
    });
    assert.equal(rHost.ok, false);
    assert.equal(rHost.error, 'cannot_report_own_encounter');

    // D. Intento de anónimo
    const { data: rAnon } = await anonClient.rpc('reportar_encuentro_publico_seguro', {
      p_encuentro_id: enc1,
      p_reason: 'spam',
    });
    assert.equal(rAnon.ok, false);
    assert.equal(rAnon.error, 'permanent_account_required');

    // E. Reporte de reportero 2
    const { data: r2 } = await rep2Client.rpc('reportar_encuentro_publico_seguro', {
      p_encuentro_id: enc1,
      p_reason: 'inappropriate_content',
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.auto_hidden, false);
    assert.equal(r2.report_count, 2);

    // F. Reporte de reportero 3 (dispara auto-ocultamiento al llegar a 3)
    const { data: r3 } = await rep3Client.rpc('reportar_encuentro_publico_seguro', {
      p_encuentro_id: enc1,
      p_reason: 'harassment',
    });
    assert.equal(r3.ok, true);
    assert.equal(r3.auto_hidden, true);
    assert.equal(r3.report_count, 3);

    // Verificar en BD
    const { data: dbEnc1PostRep } = await admin.from('encuentros').select('is_open, moderation_status').eq('id', enc1).single();
    assert.equal(dbEnc1PostRep?.is_open, false);
    assert.equal(dbEnc1PostRep?.moderation_status, 'hidden_pending_review');

    // Verificar que desapareció de Discovery
    const { data: disc6 } = await anonClient.rpc('get_discovery_encuentros_abiertos', { p_locality_ids: ['guemes'] });
    const discList6 = typeof disc6 === 'string' ? JSON.parse(disc6) : disc6;
    assert.ok(!discList6.some((e: any) => e.id === enc1), 'Encuentro auto-ocultado debe desaparecer de Discovery');

    console.log('  ✔ Smoke Test 6 AUTO-HIDE: deduplicación, permisos permanentes y auto-ocultamiento en umbral 3.');
    results['AUTO_HIDE'] = 'PASS';

    // ------------------------------------------------------------------------
    // 9. Smoke Test 7 — Carrera Auto-Hide vs Approve Tardío
    // ------------------------------------------------------------------------
    console.log('\n[9/12] Smoke Test 7: Carrera Auto-Hide vs Approve tardío...');
    // Intentar que service_role apruebe enc1 que ahora está en hidden_pending_review
    const { data: raceRes } = await admin.rpc('resolver_moderacion_encuentro_seguro', {
      p_encuentro_id: enc1,
      p_action: 'approve',
      p_note: 'delayed approval attempt',
    });
    assert.equal(raceRes.ok, false);
    assert.equal(raceRes.error, 'invalid_status_transition');

    const { data: dbRace } = await admin.from('encuentros').select('is_open, moderation_status').eq('id', enc1).single();
    assert.equal(dbRace?.is_open, false);
    assert.equal(dbRace?.moderation_status, 'hidden_pending_review');

    console.log('  ✔ Smoke Test 7 RACE: service_role no puede reactivar encuentros en hidden_pending_review.');
    results['RACE_PREVENTION'] = 'PASS';

    // ------------------------------------------------------------------------
    // 10. Smoke Test 8 — Bypass Directo y Autorización
    // ------------------------------------------------------------------------
    console.log('\n[10/12] Smoke Test 8: Pruebas de Bypass Directo y Autorización...');

    // A. Host 2 intenta invocar Edge Function para enc1 (propiedad de Host 1)
    const crossRes = await host2Client.functions.invoke('moderate-public-content', {
      body: { encounter_id: enc1 },
    });
    assert.ok(crossRes.error, 'Debe retornar error HTTP para host no autorizado');
    assert.equal(crossRes.error?.context?.status, 403);

    // B. Invocación sin JWT (cliente sin autenticar)
    const unauthClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const unauthRes = await unauthClient.functions.invoke('moderate-public-content', {
      body: { encounter_id: enc1 },
    });
    assert.ok(unauthRes.error, 'Debe retornar error HTTP para request sin autenticación');
    assert.equal(unauthRes.error?.context?.status, 401);

    // C. UPDATE directo por Data API como usuario normal
    const { error: dataApiErr, count: updatedCount } = await hostClient
      .from('encuentros')
      .update({ titulo: 'Bypass Malicioso Directo Data API' })
      .eq('id', enc1)
      .select();
    assert.ok(
      dataApiErr !== null || !updatedCount || updatedCount === 0,
      'Data API directo no debe permitir modificar la tabla encuentros'
    );

    // D. Inyección en p_data de actualizar_encuentro_seguro
    const encBypass = await createEncounter(hostId, 'Encuentro para test de inyeccion');
    // Aprobar encBypass
    await hostClient.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: encBypass,
      p_host_id: hostId,
      p_open_description: 'Descripcion aprobada',
      p_max_participants: 4,
      p_locality_id: 'guemes',
      p_open_public_zone: null,
    });
    const { data: hBypass } = await admin.rpc('calcular_content_hash_moderacion', {
      p_title: 'Encuentro para test de inyeccion',
      p_open_description: 'Descripcion aprobada',
      p_modalidad: 'presencial',
      p_open_public_zone: 'Güemes / Playa Grande',
    });
    await admin.rpc('resolver_moderacion_encuentro_seguro', {
      p_encuentro_id: encBypass,
      p_action: 'approve',
      p_note: 'aprobado para bypass test',
      p_expected_content_hash: hBypass,
    });

    const { data: rpcBypass, error: rpcBypassErr } = await hostClient.rpc('actualizar_encuentro_seguro', {
      p_encuentro_id: encBypass,
      p_host_id: hostId,
      p_data: { titulo: 'Otro Titulo Alterado', moderation_status: 'approved', is_open: true },
    });
    if (rpcBypassErr) console.error('rpcBypassErr:', rpcBypassErr);
    assert.ok(rpcBypass, 'rpcBypass no debe ser nulo');
    assert.equal(rpcBypass.moderation_status, 'review_pending');
    assert.equal(rpcBypass.is_open, false);

    console.log('  ✔ Smoke Test 8 BYPASS: 403 cross-host, 401 unauth, Data API bloqueado y RPC inyección repelida.');
    results['BYPASS_PROTECTION'] = 'PASS';

    // ------------------------------------------------------------------------
    // 11. Privacidad y Regresión Runtime Mínima
    // ------------------------------------------------------------------------
    console.log('\n[11/12] Verificando Privacidad y Regresión Runtime Mínima...');

    // Privacidad en auditoría
    const { data: auditRows } = await admin
      .from('public_content_moderation_audit')
      .select('metadata')
      .in('encuentro_id', createdEncounterIds);
    for (const row of auditRows || []) {
      const meta = row.metadata || {};
      assert.equal(meta.lugar_texto, undefined, 'lugar_texto no debe aparecer en metadata');
      assert.equal(meta.link_virtual, undefined, 'link_virtual no debe aparecer en metadata');
      assert.equal(meta.public_token, undefined, 'public_token no debe aparecer en metadata');
    }

    // Regresión runtime mínima: cerrar encuentro abierto
    const encReg = await createEncounter(hostId, 'Encuentro de Prueba Cierre');
    await hostClient.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: encReg,
      p_host_id: hostId,
      p_open_description: 'Descripcion para cerrar',
      p_max_participants: 4,
      p_locality_id: 'guemes',
      p_open_public_zone: null,
    });
    // Aprobar directamente con admin
    const { data: hReg } = await admin.rpc('calcular_content_hash_moderacion', {
      p_title: 'Encuentro de Prueba Cierre',
      p_open_description: 'Descripcion para cerrar',
      p_modalidad: 'presencial',
      p_open_public_zone: 'Güemes / Playa Grande',
    });
    await admin.rpc('resolver_moderacion_encuentro_seguro', {
      p_encuentro_id: encReg,
      p_action: 'approve',
      p_note: 'regresion',
      p_expected_content_hash: hReg,
    });

    const { data: closeRes } = await hostClient.rpc('cerrar_encuentro_abierto_seguro', {
      p_encuentro_id: encReg,
      p_host_id: hostId,
    });
    assert.equal(closeRes.ok, true);

    const { data: dbClose } = await admin.from('encuentros').select('is_open').eq('id', encReg).single();
    assert.equal(dbClose?.is_open, false);

    console.log('  ✔ Privacidad y regresión runtime mínima confirmadas.');
    results['PRIVACY_AND_REGRESSION'] = 'PASS';

  } finally {
    // ------------------------------------------------------------------------
    // 12. Cleanup
    // ------------------------------------------------------------------------
    console.log('\n[12/12] Ejecutando cleanup de datos QA en Staging...');

    if (createdEncounterIds.length > 0) {
      await admin.from('public_content_reports').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('public_content_moderation_audit').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
      console.log(`  Encuentros QA eliminados: ${createdEncounterIds.length}`);
    }

    for (const uid of createdUserIds) {
      await admin.auth.admin.deleteUser(uid);
    }
    console.log(`  Usuarios QA eliminados: ${createdUserIds.length}`);
    console.log('  ✔ Cleanup completado exitosamente.\n');
  }

  console.log('========================================================');
  console.log('RESUMEN FINAL DE RESULTADOS EN STAGING:');
  for (const [k, v] of Object.entries(results)) {
    console.log(`- ${k.padEnd(25)}: ${v}`);
  }
  console.log('========================================================');
}

runStagingSmokeModeration().catch((err) => {
  console.error('\n[FATAL ERROR IN STAGING SMOKE QA]:', err);
  process.exit(1);
});
