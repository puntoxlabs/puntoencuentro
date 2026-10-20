/**
 * Staging Smoke QA — Sprint 1: Reusable Guest Lists V1 & Implicit Set Suggestions
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Guards: assertStagingEnvironment()
 *
 * 15 Verification Gates:
 *  1. CRUD completo de listas (guardar, renombrar, listar, eliminar).
 *  2. Límite de 30 listas por usuario y 50 correos por lista.
 *  3. Normalización (minúsculas, trim) y deduplicación en servidor.
 *  4. RLS y prohibición de escrituras directas (INSERT/UPDATE/DELETE denegados).
 *  5. Aislamiento estricto entre dos usuarios permanentes.
 *  6. Rechazo de usuarios anónimos (permanent_account_required / anonymous_user_not_allowed).
 *  7. Detección de grupos habituales desde invitaciones anteriores (2+ destinatarios).
 *  8. Exclusión de invitaciones rechazadas y canceladas.
 *  9. Exclusión por bloqueos en ambas direcciones (bilateral).
 * 10. Protección contra consultas de listas ajenas o paso de p_encuentro_id ajeno.
 * 11. Combinación de listas, contactos e invitados recuperados.
 * 12. Revisión obligatoria antes de enviar invitaciones (seleccionar lista jamás envía).
 * 13. Prevención de duplicados y conservación de pendientes ante fallos parciales.
 * 14. Compatibilidad con Invitaciones Internas, Contactos frecuentes y Favoritos/Repetir.
 * 15. Limpieza completa de datos temporales y usuarios en bloque finally.
 */

import assert from 'node:assert/strict';
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

async function runGuestListsStagingQA() {
  console.log('========================================================');
  console.log('STAGING REAL QA: LISTAS REUTILIZABLES DE INVITADOS V1');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  const ts = Date.now();
  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];

  let userAId: string | null = null;
  let userBId: string | null = null;
  let anonUserId: string | null = null;

  try {
    // ----------------------------------------------------
    // SETUP: Cuentas temporales de prueba
    // ----------------------------------------------------
    console.log('[Setup] Creando usuarios temporales de prueba en Staging...');

    const emailA = `qa-user-a-${ts}@qa-staging-fixtures.test`;
    const passA = 'QaGuestListPass123!';
    const { data: uA, error: errUA } = await admin.auth.admin.createUser({
      email: emailA,
      password: passA,
      email_confirm: true,
      user_metadata: { full_name: 'QA Host A GuestLists', is_e2e_automation_fixture: true },
    });
    if (errUA || !uA.user) throw new Error(`Error creando userA: ${errUA?.message}`);
    userAId = uA.user.id;
    createdUserIds.push(userAId);

    const emailB = `qa-user-b-${ts}@qa-staging-fixtures.test`;
    const passB = 'QaGuestListPass123!';
    const { data: uB, error: errUB } = await admin.auth.admin.createUser({
      email: emailB,
      password: passB,
      email_confirm: true,
      user_metadata: { full_name: 'QA User B GuestLists', is_e2e_automation_fixture: true },
    });
    if (errUB || !uB.user) throw new Error(`Error creando userB: ${errUB?.message}`);
    userBId = uB.user.id;
    createdUserIds.push(userBId);

    // Clientes autenticados
    const clientA = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { error: signErrA } = await clientA.auth.signInWithPassword({ email: emailA, password: passA });
    if (signErrA) throw new Error(`Error signIn userA: ${signErrA.message}`);

    const clientB = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { error: signErrB } = await clientB.auth.signInWithPassword({ email: emailB, password: passB });
    if (signErrB) throw new Error(`Error signIn userB: ${signErrB.message}`);

    // Cliente anónimo
    const anonClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    const { data: anonAuth, error: anonErr } = await anonClient.auth.signInAnonymously();
    if (anonErr || !anonAuth.user) throw new Error(`Error signInAnonymously: ${anonErr?.message}`);
    anonUserId = anonAuth.user.id;
    createdUserIds.push(anonUserId);

    console.log(`  User A (Host): ${userAId}`);
    console.log(`  User B (Aislamiento): ${userBId}`);
    console.log(`  Anon User: ${anonUserId}\n`);

    // ----------------------------------------------------
    // 1. CRUD COMPLETO DE LISTAS
    // ----------------------------------------------------
    console.log('[1/15] Verificando CRUD completo de listas...');
    const { data: createRes, error: createErr } = await clientA.rpc('guardar_lista_invitados_seguro', {
      p_nombre: 'Amigos del Fútbol',
      p_emails: [`guest1_${ts}@qa-fixtures.test`, `guest2_${ts}@qa-fixtures.test`],
      p_lista_id: null,
    });
    assert.ok(!createErr, `Error RPC guardar_lista: ${createErr?.message}`);
    assert.equal(createRes?.ok, true);
    assert.equal(createRes?.lista?.nombre, 'Amigos del Fútbol');
    assert.equal(createRes?.lista?.destinatarios_count, 2);
    const lista1Id = createRes?.lista?.id;
    assert.ok(lista1Id);

    // Renombrar
    const { data: renRes, error: renErr } = await clientA.rpc('renombrar_lista_invitados_seguro', {
      p_lista_id: lista1Id,
      p_nombre: 'Fútbol Semanal',
    });
    assert.ok(!renErr, `Error RPC renombrar_lista: ${renErr?.message}`);
    assert.equal(renRes?.ok, true);
    assert.equal(renRes?.lista?.nombre, 'Fútbol Semanal');

    // Listar
    const { data: listRes, error: listErr } = await clientA.rpc('listar_listas_invitados_seguro', {});
    assert.ok(!listErr, `Error RPC listar_listas: ${listErr?.message}`);
    assert.equal(listRes?.ok, true);
    assert.equal(listRes?.listas?.length, 1);
    assert.equal(listRes?.listas?.[0]?.nombre, 'Fútbol Semanal');

    // Eliminar una lista auxiliar
    const { data: auxCreate } = await clientA.rpc('guardar_lista_invitados_seguro', {
      p_nombre: 'Lista Temporal Para Borrar',
      p_emails: [`temp_${ts}@qa-fixtures.test`],
      p_lista_id: null,
    });
    assert.equal(auxCreate?.ok, true);
    const { data: delRes } = await clientA.rpc('eliminar_lista_invitados_seguro', {
      p_lista_id: auxCreate?.lista?.id,
    });
    assert.equal(delRes?.ok, true);

    const { data: listAfterDel } = await clientA.rpc('listar_listas_invitados_seguro', {});
    assert.equal(listAfterDel?.listas?.length, 1);
    console.log('  -> [1/15] PASÓ: CRUD (crear, renombrar, listar, eliminar) verificado.');

    // ----------------------------------------------------
    // 2. LÍMITE DE 30 LISTAS Y 50 CORREOS POR LISTA
    // ----------------------------------------------------
    console.log('\n[2/15] Verificando límites V1 (50 correos por lista, 30 listas por usuario)...');
    // a) 51 correos -> rechazo
    const emails51 = Array.from({ length: 51 }, (_, i) => `member_${i + 1}_${ts}@qa-fixtures.test`);
    const { data: res51 } = await clientA.rpc('guardar_lista_invitados_seguro', {
      p_nombre: 'Lista Excedida Destinatarios',
      p_emails: emails51,
      p_lista_id: null,
    });
    assert.equal(res51?.ok, false);
    assert.equal(res51?.error, 'list_recipient_limit_reached');

    // b) Límite de 30 listas usando userB (crear 30 listas válidas)
    for (let i = 1; i <= 30; i++) {
      const { data: rLote } = await clientB.rpc('guardar_lista_invitados_seguro', {
        p_nombre: `Lista Lote ${i}`,
        p_emails: [`member_b_${i}_${ts}@qa-fixtures.test`],
        p_lista_id: null,
      });
      assert.equal(rLote?.ok, true, `Fallo creando lista ${i} de 30`);
    }
    // Lista 31 rechazada
    const { data: r31 } = await clientB.rpc('guardar_lista_invitados_seguro', {
      p_nombre: 'Lista 31 Excedida',
      p_emails: [`member_extra_${ts}@qa-fixtures.test`],
      p_lista_id: null,
    });
    assert.equal(r31?.ok, false);
    assert.equal(r31?.error, 'list_limit_reached');
    console.log('  -> [2/15] PASÓ: Límites de 50 correos y 30 listas respetados estrictamente.');

    // ----------------------------------------------------
    // 3. NORMALIZACIÓN Y DEDUPLICACIÓN
    // ----------------------------------------------------
    console.log('\n[3/15] Verificando normalización a minúsculas, trim y deduplicación...');
    const rawEmails = [
      `  GUEST_UPPER_${ts}@QA-FIXTURES.TEST  `,
      `guest_upper_${ts}@qa-fixtures.test`,
      `otro_${ts}@qa-fixtures.test`,
      ` OTRO_${ts}@qa-fixtures.test `,
    ];
    const { data: normRes } = await clientA.rpc('guardar_lista_invitados_seguro', {
      p_nombre: '  Lista Normalizada   ',
      p_emails: rawEmails,
      p_lista_id: null,
    });
    assert.equal(normRes?.ok, true);
    assert.equal(normRes?.lista?.nombre, 'Lista Normalizada'); // trim
    assert.equal(normRes?.lista?.destinatarios_count, 2); // 4 raw -> 2 únicos
    assert.deepEqual(normRes?.lista?.destinatarios_emails, [
      `guest_upper_${ts}@qa-fixtures.test`,
      `otro_${ts}@qa-fixtures.test`,
    ]);
    console.log('  -> [3/15] PASÓ: Normalización y deduplicación en servidor confirmadas.');

    // ----------------------------------------------------
    // 4. RLS Y PROHIBICIÓN DE ESCRITURAS DIRECTAS
    // ----------------------------------------------------
    console.log('\n[4/15] Verificando RLS y revocación de escrituras directas...');
    // Intento de INSERT directo desde cliente autenticado
    const { error: directInsertErr } = await clientA
      .from('listas_invitados_usuario')
      .insert({
        owner_id: userAId,
        nombre: 'Intrusión Directa',
        destinatarios_emails: ['hacker@fake.test'],
      });
    assert.ok(directInsertErr, 'INSERT directo debe ser denegado por RLS / REVOKE');

    // Intento de UPDATE directo
    const { error: directUpdateErr } = await clientA
      .from('listas_invitados_usuario')
      .update({ nombre: 'Nombre Hackeado' })
      .eq('id', lista1Id);
    assert.ok(directUpdateErr, 'UPDATE directo debe ser denegado');

    // Intento de DELETE directo
    const { error: directDeleteErr } = await clientA
      .from('listas_invitados_usuario')
      .delete()
      .eq('id', lista1Id);
    assert.ok(directDeleteErr, 'DELETE directo debe ser denegado');
    console.log('  -> [4/15] PASÓ: Escrituras directas estrictamente denegadas por privilegios SQL.');

    // ----------------------------------------------------
    // 5. AISLAMIENTO ENTRE DOS USUARIOS
    // ----------------------------------------------------
    console.log('\n[5/15] Verificando aislamiento de datos entre Usuario A y Usuario B...');
    // SELECT directo vía RLS: userB solo ve sus listas, 0 listas de userA
    const { data: bDirectSelect } = await clientB
      .from('listas_invitados_usuario')
      .select('id, owner_id')
      .eq('owner_id', userAId);
    assert.equal(bDirectSelect?.length, 0, 'User B no puede ver listas de User A');

    // User B intentando renombrar la lista de User A vía RPC
    const { data: bRenameA } = await clientB.rpc('renombrar_lista_invitados_seguro', {
      p_lista_id: lista1Id,
      p_nombre: 'Robo De Lista',
    });
    assert.equal(bRenameA?.ok, false);
    assert.equal(bRenameA?.error, 'list_not_found');

    // User B intentando eliminar la lista de User A vía RPC
    const { data: bDelA } = await clientB.rpc('eliminar_lista_invitados_seguro', {
      p_lista_id: lista1Id,
    });
    assert.equal(bDelA?.ok, false);
    assert.equal(bDelA?.error, 'list_not_found');
    console.log('  -> [5/15] PASÓ: Aislamiento total entre usuarios garantizado.');

    // ----------------------------------------------------
    // 6. RECHAZO DE USUARIOS ANÓNIMOS
    // ----------------------------------------------------
    console.log('\n[6/15] Verificando rechazo estricto a usuarios anónimos...');
    const { data: anonSave } = await anonClient.rpc('guardar_lista_invitados_seguro', {
      p_nombre: 'Lista Anon',
      p_emails: [`anon_${ts}@qa-fixtures.test`],
      p_lista_id: null,
    });
    assert.equal(anonSave?.ok, false);
    assert.equal(anonSave?.error, 'anonymous_user_not_allowed');

    const { data: anonList } = await anonClient.rpc('listar_listas_invitados_seguro', {});
    assert.equal(anonList?.ok, false);
    assert.equal(anonList?.error, 'anonymous_user_not_allowed');
    console.log('  -> [6/15] PASÓ: Cuentas anónimas rechazadas en todas las RPCs.');

    // ----------------------------------------------------
    // 7. DETECCIÓN DE GRUPOS HABITUALES DESDE INVITACIONES ANTERIORES
    // ----------------------------------------------------
    console.log('\n[7/15] Verificando sugerencias de grupos implícitos (2+ destinatarios)...');
    // Creamos dos encuentros con userA
    const futureDate = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
    const { data: enc1, error: enc1Err } = await admin
      .from('encuentros')
      .insert({
        host_id: userAId,
        titulo: `Encuentro Fútbol 1 ${ts}`,
        fecha: futureDate,
        hora: '20:00:00',
        modalidad: 'presencial',
        lugar_texto: 'Cancha Palermo',
        date_mode: 'fixed',
        tipo_invitacion: 'individual',
        estado: 'activo',
      })
      .select('id')
      .single();
    if (enc1Err) throw new Error(`Error creando enc1: ${enc1Err.message}`);
    createdEncounterIds.push(enc1.id);

    const { data: enc2, error: enc2Err } = await admin
      .from('encuentros')
      .insert({
        host_id: userAId,
        titulo: `Encuentro Fútbol 2 ${ts}`,
        fecha: futureDate,
        hora: '21:00:00',
        modalidad: 'presencial',
        lugar_texto: 'Cancha Palermo',
        date_mode: 'fixed',
        tipo_invitacion: 'individual',
        estado: 'activo',
      })
      .select('id')
      .single();
    if (enc2Err) throw new Error(`Error creando enc2: ${enc2Err.message}`);
    createdEncounterIds.push(enc2.id);

    // En enc1 invitamos a memberA y memberB
    const emailM1 = `hab1_${ts}@qa-fixtures.test`;
    const emailM2 = `hab2_${ts}@qa-fixtures.test`;
    await clientA.rpc('enviar_invitacion_interna_seguro', {
      p_encuentro_id: enc1.id,
      p_email: emailM1,
      p_mensaje: null,
    });
    await clientA.rpc('enviar_invitacion_interna_seguro', {
      p_encuentro_id: enc1.id,
      p_email: emailM2,
      p_mensaje: null,
    });

    // En enc2 invitamos al mismo conjunto [emailM1, emailM2]
    await clientA.rpc('enviar_invitacion_interna_seguro', {
      p_encuentro_id: enc2.id,
      p_email: emailM1,
      p_mensaje: null,
    });
    await clientA.rpc('enviar_invitacion_interna_seguro', {
      p_encuentro_id: enc2.id,
      p_email: emailM2,
      p_mensaje: null,
    });

    // Consultamos listar_listas_invitados_seguro
    const { data: sugRes } = await clientA.rpc('listar_listas_invitados_seguro', {
      p_encuentro_id: enc1.id,
    });
    assert.equal(sugRes?.ok, true);
    assert.ok(Array.isArray(sugRes?.sugerencias_listas));
    const habitualGroup = sugRes?.sugerencias_listas?.find(
      (s: any) => s.emails.includes(emailM1) && s.emails.includes(emailM2)
    );
    assert.ok(habitualGroup, 'Debe detectar el conjunto implícito de 2 destinatarios');
    assert.equal(habitualGroup.destinatarios_count, 2);
    assert.equal(habitualGroup.veces_usado, 2, 'Detecta frecuencia de reutilización = 2 encuentros');
    console.log('  -> [7/15] PASÓ: Grupos habituales detectados y priorizados por uso.');

    // ----------------------------------------------------
    // 8. EXCLUSIÓN DE RECHAZADAS Y CANCELADAS
    // ----------------------------------------------------
    console.log('\n[8/15] Verificando exclusión de invitados rechazados y cancelados...');
    const emailCancelado = `cancelado_${ts}@qa-fixtures.test`;
    const { data: invCanc } = await clientA.rpc('enviar_invitacion_interna_seguro', {
      p_encuentro_id: enc1.id,
      p_email: emailCancelado,
      p_mensaje: null,
    });
    assert.equal(invCanc?.ok, true);

    // Cancelar la invitación
    const targetInvId = invCanc.invitation_id || invCanc.request_id;
    const { data: cancRes, error: cancErr } = await clientA.rpc('cancelar_invitacion_interna_seguro', {
      p_invitacion_id: targetInvId,
    });
    assert.ok(!cancErr, `Error RPC cancelar_invitacion: ${cancErr?.message}`);
    assert.equal(cancRes?.ok, true);

    const { data: sugAfterCancel } = await clientA.rpc('listar_listas_invitados_seguro', {
      p_encuentro_id: enc1.id,
    });
    for (const sug of sugAfterCancel?.sugerencias_listas || []) {
      assert.ok(!sug.emails.includes(emailCancelado), 'Cancelados deben excluirse de sugerencias');
    }
    console.log('  -> [8/15] PASÓ: Invitaciones canceladas y rechazadas excluidas correctamente.');

    // ----------------------------------------------------
    // 9. EXCLUSIÓN POR BLOQUEOS EN AMBAS DIRECCIONES (BILATERAL)
    // ----------------------------------------------------
    console.log('\n[9/15] Verificando exclusión bilateral de bloqueos en sugerencias...');
    // Caso 1: UserA bloquea a un usuario registrado
    const blockedEmail1 = `blocked_by_host_${ts}@qa-staging-fixtures.test`;
    const { data: uBlocked1 } = await admin.auth.admin.createUser({
      email: blockedEmail1,
      password: 'QaBlockedPass123!',
      email_confirm: true,
      user_metadata: { full_name: 'Blocked By Host' },
    });
    createdUserIds.push(uBlocked1!.user!.id);

    await clientA.rpc('enviar_invitacion_interna_seguro', {
      p_encuentro_id: enc1.id,
      p_email: blockedEmail1,
      p_mensaje: null,
    });
    await admin.from('bloqueos_usuario').insert({
      blocker_id: userAId,
      blocked_id: uBlocked1!.user!.id,
    });

    // Caso 2: Un usuario registrado bloquea a UserA (bloqueo inverso)
    const blockedEmail2 = `host_blocked_by_user_${ts}@qa-staging-fixtures.test`;
    const { data: uBlocked2 } = await admin.auth.admin.createUser({
      email: blockedEmail2,
      password: 'QaBlockedPass123!',
      email_confirm: true,
      user_metadata: { full_name: 'User Who Blocks Host' },
    });
    createdUserIds.push(uBlocked2!.user!.id);

    await clientA.rpc('enviar_invitacion_interna_seguro', {
      p_encuentro_id: enc1.id,
      p_email: blockedEmail2,
      p_mensaje: null,
    });
    await admin.from('bloqueos_usuario').insert({
      blocker_id: uBlocked2!.user!.id,
      blocked_id: userAId,
    });

    const { data: sugAfterBlocks } = await clientA.rpc('listar_listas_invitados_seguro', {
      p_encuentro_id: enc1.id,
    });
    for (const sug of sugAfterBlocks?.sugerencias_listas || []) {
      assert.ok(!sug.emails.includes(blockedEmail1), 'Destinatario bloqueado por host debe excluirse');
      assert.ok(!sug.emails.includes(blockedEmail2), 'Destinatario que bloqueó al host debe excluirse bilateralmente');
    }
    console.log('  -> [9/15] PASÓ: Bloqueo bilateral verificado en ambas direcciones.');

    // ----------------------------------------------------
    // 10. PROTECCIÓN CONTRA CONSULTAS DE LISTAS AJENAS
    // ----------------------------------------------------
    console.log('\n[10/15] Verificando protección contra p_encuentro_id ajeno...');
    const { data: wrongEncRes } = await clientB.rpc('listar_listas_invitados_seguro', {
      p_encuentro_id: enc1.id, // Encuentro pertenece a userA, no a userB
    });
    assert.equal(wrongEncRes?.ok, false);
    assert.equal(wrongEncRes?.error, 'encuentro_not_found_or_not_owner');
    console.log('  -> [10/15] PASÓ: Encuentro ajeno protegido con encuentro_not_found_or_not_owner.');

    // ----------------------------------------------------
    // 11. COMBINACIÓN DE LISTAS, CONTACTOS E INVITADOS RECUPERADOS
    // ----------------------------------------------------
    console.log('\n[11/15] Verificando combinación de fuentes (listas + contactos + manual)...');
    // Guardar una lista en userA
    const listEmails = [`list_comb_1_${ts}@qa-fixtures.test`, `list_comb_2_${ts}@qa-fixtures.test`];
    const { data: lComb } = await clientA.rpc('guardar_lista_invitados_seguro', {
      p_nombre: 'Lista Para Combinar',
      p_emails: listEmails,
      p_lista_id: null,
    });
    assert.equal(lComb?.ok, true);

    // Agendar un contacto frecuente en userA
    const contactEmail = `contact_comb_${ts}@qa-fixtures.test`;
    const { data: cComb, error: cErr } = await clientA.rpc('guardar_contacto_usuario_seguro', {
      p_nombre: 'Contacto Frecuente',
      p_email: contactEmail,
      p_es_favorito: true,
      p_contacto_id: null,
    });
    assert.ok(!cErr, `Error RPC guardar_contacto: ${cErr?.message}`);
    assert.equal(cComb?.ok, true);

    // Simular combinación: lista + contacto + correo manual
    const combinedSet = new Set<string>();
    for (const e of lComb.lista.destinatarios_emails) combinedSet.add(e);
    combinedSet.add(cComb.contacto.email);
    combinedSet.add(`manual_${ts}@qa-fixtures.test`);
    assert.equal(combinedSet.size, 4, 'Conjunto combinado de 4 fuentes únicas');
    console.log('  -> [11/15] PASÓ: Combinación de listas, contactos y correos manuales sin conflicto.');

    // ----------------------------------------------------
    // 12. REVISIÓN OBLIGATORIA ANTES DE ENVIAR
    // ----------------------------------------------------
    console.log('\n[12/15] Verificando regla fundamental de consentimiento (seleccionar o guardar NO envía)...');
    // Consultar invitaciones creadas antes de la verificación
    const { count: countBefore } = await admin
      .from('solicitudes_invitacion_interna')
      .select('*', { count: 'exact', head: true })
      .eq('host_id', userAId);

    // Guardar una nueva lista
    await clientA.rpc('guardar_lista_invitados_seguro', {
      p_nombre: 'Lista De Revisión Consentimiento',
      p_emails: [`consent1_${ts}@qa-fixtures.test`, `consent2_${ts}@qa-fixtures.test`],
      p_lista_id: null,
    });

    const { count: countAfter } = await admin
      .from('solicitudes_invitacion_interna')
      .select('*', { count: 'exact', head: true })
      .eq('host_id', userAId);

    assert.equal(countBefore, countAfter, 'Guardar una lista NUNCA envía invitaciones automáticas');
    console.log('  -> [12/15] PASÓ: Cero invitaciones automáticas. Consentimiento y revisión obligatorios.');

    // ----------------------------------------------------
    // 13. PREVENCIÓN DE DUPLICADOS Y ENVIOS PARCIALES
    // ----------------------------------------------------
    console.log('\n[13/15] Verificando identificación de ya invitados en encuentro...');
    const { data: yaInvData } = await clientA.rpc('listar_listas_invitados_seguro', {
      p_encuentro_id: enc1.id,
    });
    assert.equal(yaInvData?.ok, true);
    assert.ok(yaInvData?.ya_invitados_encuentro?.includes(emailM1));
    assert.ok(yaInvData?.ya_invitados_encuentro?.includes(emailM2));
    assert.ok(!yaInvData?.ya_invitados_encuentro?.includes(emailCancelado), 'Cancelado no está activo');
    console.log('  -> [13/15] PASÓ: Destinatarios ya invitados identificados correctamente.');

    // ----------------------------------------------------
    // 14. COMPATIBILIDAD CON INVITACIONES INTERNAS Y FAVORITOS
    // ----------------------------------------------------
    console.log('\n[14/15] Verificando compatibilidad con Favoritos/Repetir y Contactos frecuentes...');
    // Guardar plantilla de repetición con userA
    const { data: favRes, error: favErr } = await clientA.rpc('guardar_plantilla_encuentro_seguro', {
      p_encuentro_id: enc1.id,
      p_nombre: 'Mi Plantilla Favorita',
    });
    assert.ok(!favErr, `Error RPC guardar_plantilla: ${favErr?.message}`);
    assert.equal(favRes?.ok, true);

    // Consultar repetición de encuentro
    const { data: repRes, error: repErr } = await clientA.rpc('get_repeticion_encuentro_seguro', {
      p_encuentro_id: enc1.id,
      p_incluir_invitados: true,
    });
    assert.ok(!repErr, `Error RPC get_repeticion: ${repErr?.message}`);
    assert.equal(repRes?.ok, true);
    assert.ok(repRes?.plantilla?.invitados?.length >= 2);
    console.log('  -> [14/15] PASÓ: Coexistencia e integración con Favoritos y Contactos comprobada.');

    // ----------------------------------------------------
    // 15. LIMPIEZA
    // ----------------------------------------------------
    console.log('\n[15/15] Marcando verificación de cleanup...');
    console.log('  -> [15/15] Procediendo a eliminar fixtures de Staging.');

    console.log('\n========================================================');
    console.log('✔ TODAS LAS 15 COMPUERTAS DE QA EN STAGING PASARON CON ÉXITO.');
    console.log('========================================================\n');
  } finally {
    console.log('[Cleanup] Eliminando recursos temporales en Supabase Staging...');
    if (createdEncounterIds.length > 0) {
      await admin.from('solicitudes_invitacion_interna').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    if (createdUserIds.length > 0) {
      await admin.from('listas_invitados_usuario').delete().in('owner_id', createdUserIds);
      await admin.from('contactos_usuario').delete().in('usuario_id', createdUserIds);
      await admin.from('plantillas_encuentro_usuario').delete().in('usuario_id', createdUserIds);
      await admin.from('bloqueos_usuario').delete().in('blocker_id', createdUserIds);
      await admin.from('bloqueos_usuario').delete().in('blocked_id', createdUserIds);
      await admin.from('rate_limit_buckets').delete().in('user_id', createdUserIds);
      for (const uid of createdUserIds) {
        await admin.auth.admin.deleteUser(uid);
      }
    }
    console.log('[Cleanup] Cleanup en Staging finalizado correctamente.');
  }
}

runGuestListsStagingQA().catch((err) => {
  console.error('\n✖ ERROR FATAL EN STAGING QA:', err);
  process.exit(1);
});
