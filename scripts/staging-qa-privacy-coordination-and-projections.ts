/**
 * Staging QA — Verificación de cierre de exposiciones en coordinación y separación de proyecciones (Mini-sprint P0)
 * Target: wougfhfwqgmxhgvjqoua (Staging) — guard assertStagingEnvironment().
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard.ts';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
assertStagingEnvironment(url);

const admin = createClient(url, getStagingSecretKey(), { auth: { persistSession: false } });
const publishableKey = getStagingPublishableKey();
const anon = createClient(url, publishableKey, { auth: { persistSession: false } });

const RUN = `P5QA-${Date.now().toString(36)}`;
const createdUserIds: string[] = [];
const createdEncounterIds: string[] = [];

interface CheckResult { name: string; ok: boolean; detail?: string }
const results: CheckResult[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        -> ${detail}` : ''}`);
}

interface Actor { id: string; email: string; client: SupabaseClient }
const PASSWORD = 'QaPassword123!Secure';

async function makeUser(prefix: string): Promise<Actor> {
  const email = `qa-p5-${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@puntoencuentro.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: `QA P5 ${prefix}` },
  });
  if (error || !data.user) throw new Error(`createUser ${prefix}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const client = createClient(url, publishableKey, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw new Error(`signIn ${prefix}: ${sErr.message}`);
  return { id: data.user.id, email, client };
}

async function main() {
  console.log(`== Mini-sprint P0 Phase 5 Suite — run ${RUN} — Staging ==\n`);

  const host = await makeUser('host');
  const userA = await makeUser('userA'); // Open participant
  const stranger = await makeUser('stranger');

  const SECRET_PLACE = `Calle Real Confidencial ${RUN} 999`;
  const PRIVATE_DESC = `Notas privadas del anfitrion ${RUN} - no exponer`;
  const OPEN_DESC = `Zona Guemes, mate y libros ${RUN}`;
  const OPEN_TITLE = `Encuentro Publico ${RUN}`;
  const PRIVATE_TITLE = `Encuentro Titulo Privado ${RUN}`;

  // =========================================================================
  // 1. Coordinación privada mediante enlace general y con fecha pendiente vs resuelta
  // =========================================================================
  console.log('\n[1] Coordinación privada (is_open=false)');
  const { data: encCoordPriv } = await admin.from('encuentros').insert({
    host_id: host.id,
    titulo: PRIVATE_TITLE,
    open_public_title: null,
    descripcion: PRIVATE_DESC,
    open_description: null,
    date_mode: 'coordination',
    coordination_status: 'open',
    modalidad: 'presencial',
    lugar_texto: SECRET_PLACE,
    tipo_invitacion: 'individual',
    is_open: false,
    estado: 'activo',
    max_participants: 6,
    realization_status: 'pending'
  }).select('id, public_token').single();
  createdEncounterIds.push(encCoordPriv.id);

  // Add date option
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const { data: opt1 } = await admin.from('encuentro_opciones_fecha').insert({
    encuentro_id: encCoordPriv.id, fecha: tomorrow, hora_inicio: '19:00:00', orden: 1
  }).select('id').single();

  const coordPub1 = (await anon.rpc('get_coordinacion_publica_seguro', { p_public_token: encCoordPriv.public_token })).data;
  check('1.1 Coordinación privada general expone lugar al ser privado legítimo', coordPub1?.encuentro?.lugar_texto === SECRET_PLACE, JSON.stringify(coordPub1?.encuentro));
  check('1.2 Coordinación privada expone descripcion privada', coordPub1?.encuentro?.descripcion === PRIVATE_DESC);

  // =========================================================================
  // 2. Coordinación abierta a Discovery: visitante, fecha resuelta
  // =========================================================================
  console.log('\n[2] Coordinación abierta a Discovery');
  await admin.from('encuentros').update({
    is_open: true,
    opened_at: new Date().toISOString(),
    moderation_status: 'approved',
    open_public_title: OPEN_TITLE,
    open_description: OPEN_DESC,
    open_public_zone: 'Güemes',
    locality_id: 'guemes'
  }).eq('id', encCoordPriv.id);

  const coordPubOpen = (await anon.rpc('get_coordinacion_publica_seguro', { p_public_token: encCoordPriv.public_token })).data;
  check('2.1 Coordinación abierta: lugar_texto oculto (null)', coordPubOpen?.encuentro?.lugar_texto === null, JSON.stringify(coordPubOpen?.encuentro));
  check('2.2 Coordinación abierta: link_virtual nulo', coordPubOpen?.encuentro?.link_virtual === null);
  check('2.3 Coordinación abierta: titulo público, no privado', coordPubOpen?.encuentro?.titulo === OPEN_TITLE);
  check('2.4 Coordinación abierta: descripcion pública, no privada', coordPubOpen?.encuentro?.descripcion === OPEN_DESC);

  // Resolver fecha de coordinación
  await admin.from('encuentros').update({
    coordination_status: 'closed',
    selected_option_id: opt1.id,
    fecha: tomorrow,
    hora: '19:00:00'
  }).eq('id', encCoordPriv.id);

  const coordPubResolved = (await anon.rpc('get_coordinacion_publica_seguro', { p_public_token: encCoordPriv.public_token })).data;
  check('2.5 Coordinación abierta con fecha resuelta: lugar_texto sigue oculto para visitante', coordPubResolved?.encuentro?.lugar_texto === null);

  // =========================================================================
  // 3. Invitación privada individual creada ANTES y DESPUÉS de abrir Discovery
  // =========================================================================
  console.log('\n[3] Invitaciones individuales privadas legítimas');
  // Invitado creado DESPUÉS de abrir Discovery
  const invPost = (await host.client.rpc('crear_participante_individual_seguro', {
    p_encuentro_id: encCoordPriv.id, p_host_id: host.id, p_nombre: 'Invitado Privado Post'
  })).data;
  const tokPrivPost = invPost.token_invitacion;

  const partPrivPost = (await anon.rpc('get_coordinacion_participante_seguro', { p_token: tokPrivPost })).data;
  check('3.1 Invitado privado creado tras apertura: ve lugar_texto legítimo', partPrivPost?.encuentro?.lugar_texto === SECRET_PLACE, JSON.stringify(partPrivPost?.encuentro));
  check('3.2 Invitado privado creado tras apertura: ve descripcion privada legítima', partPrivPost?.encuentro?.descripcion === PRIVATE_DESC);

  const partSegPost = (await anon.rpc('get_participante_seguro', { p_token: tokPrivPost })).data;
  check('3.3 get_participante_seguro para invitado privado post-apertura ve lugar', partSegPost?.encuentros?.lugar_texto === SECRET_PLACE);
  check('3.4 get_participante_seguro para invitado privado post-apertura ve descripcion privada', partSegPost?.encuentros?.descripcion === PRIVATE_DESC);

  // Confirmar al invitado privado individual (mediante actualizacion directa de estado legítimo)
  await admin.from('participantes').update({ estado: 'confirmado' }).eq('token_invitacion', tokPrivPost);
  const partPrivPostConf = (await anon.rpc('get_participante_seguro', { p_token: tokPrivPost })).data;
  check('3.5 Invitado privado confirmado conserva lugar', partPrivPostConf?.encuentros?.lugar_texto === SECRET_PLACE);

  // Rechazar a otro invitado privado (estado = 'rechazado')
  const invRech = (await host.client.rpc('crear_participante_individual_seguro', {
    p_encuentro_id: encCoordPriv.id, p_host_id: host.id, p_nombre: 'Invitado Rechazado'
  })).data;
  await admin.from('participantes').update({ estado: 'rechazado' }).eq('token_invitacion', invRech.token_invitacion);
  const partRech = (await anon.rpc('get_participante_seguro', { p_token: invRech.token_invitacion })).data;
  check('3.6 Invitado privado rechazado: sin lugar_texto', !partRech?.encuentros?.lugar_texto);

  // =========================================================================
  // 4. Participante abierto: solicitud, aprobación, reconfirmación en encuentro abierto
  // =========================================================================
  console.log('\n[4] Participante abierto: ciclo completo de reconfirmación');
  const reqRes = await userA.client.rpc('solicitar_sumarse_encuentro_abierto', {
    p_encuentro_id: encCoordPriv.id, p_nombre: 'Ana Open', p_mensaje: 'Quiero ir', p_seat_count: 1
  });
  const reqId = reqRes.data?.request_id;
  check('4.1 Solicitud abierta creada', reqRes.data?.ok === true);

  const apRes = await host.client.rpc('aprobar_solicitud_encuentro_abierto', { p_request_id: reqId });
  const tokOpenA = apRes.data?.token_invitacion;
  check('4.2 Solicitud aprobada', apRes.data?.ok === true);

  // Consulta antes de reconfirmar (inscripciones abiertas)
  const partOpenA_Coord = (await anon.rpc('get_coordinacion_participante_seguro', { p_token: tokOpenA })).data;
  check('4.3 Participante abierto aprobado (coordinacion): lugar_texto oculto', partOpenA_Coord?.encuentro?.lugar_texto === null);
  check('4.4 Participante abierto aprobado (coordinacion): descripcion publica', partOpenA_Coord?.encuentro?.descripcion === OPEN_DESC);
  check('4.5 Participante abierto aprobado (coordinacion): titulo publico', partOpenA_Coord?.encuentro?.titulo === OPEN_TITLE);

  const partOpenA_Part = (await anon.rpc('get_participante_seguro', { p_token: tokOpenA })).data;
  check('4.6 Participante abierto aprobado (get_participante_seguro): lugar_texto oculto', partOpenA_Part?.encuentros?.lugar_texto === null);
  check('4.7 Participante abierto aprobado (get_participante_seguro): descripcion publica', partOpenA_Part?.encuentros?.descripcion === OPEN_DESC);

  const misOpenA = (await userA.client.rpc('get_encuentros_participados_seguro')).data as any[];
  const itemA = misOpenA?.find(e => e.id === encCoordPriv.id);
  check('4.8 get_encuentros_participados_seguro: lugar_texto oculto antes de reconfirmar', itemA?.lugar_texto === null);
  check('4.9 get_encuentros_participados_seguro: descripcion publica', itemA?.descripcion === OPEN_DESC);
  check('4.10 get_encuentros_participados_seguro: titulo publico', itemA?.titulo === OPEN_TITLE);

  // Host confirma realización y cierra inscripciones
  await host.client.rpc('hacerlo_igual_seguro', { p_encuentro_id: encCoordPriv.id, p_host_id: host.id });
  await host.client.rpc('cerrar_inscripciones_seguro', { p_encuentro_id: encCoordPriv.id, p_host_id: host.id });

  // Reconfirmar
  const recRes = await userA.client.rpc('reconfirmar_asistencia_seguro', {
    p_encuentro_id: encCoordPriv.id, p_decision: 'confirm', p_motivo: null
  });
  check('4.11 Reconfirmación exitosa', recRes.data?.ok === true);

  const partOpenA_Reconf = (await anon.rpc('get_coordinacion_participante_seguro', { p_token: tokOpenA })).data;
  check('4.12 Participante abierto reconfirmado (coordinacion): recibe lugar_texto', partOpenA_Reconf?.encuentro?.lugar_texto === SECRET_PLACE);

  const partSegA_Reconf = (await anon.rpc('get_participante_seguro', { p_token: tokOpenA })).data;
  check('4.13 Participante abierto reconfirmado (get_participante_seguro): recibe lugar_texto', partSegA_Reconf?.encuentros?.lugar_texto === SECRET_PLACE);

  const misA_Reconf = (await userA.client.rpc('get_encuentros_participados_seguro')).data as any[];
  const itemA_Reconf = misA_Reconf?.find(e => e.id === encCoordPriv.id);
  check('4.14 get_encuentros_participados_seguro tras reconfirmar: recibe lugar_texto', itemA_Reconf?.lugar_texto === SECRET_PLACE);

  // Retiro voluntario del participante abierto
  await userA.client.rpc('desistir_encuentro_abierto_seguro', { p_encuentro_id: encCoordPriv.id, p_motivo: null });
  const partOpenA_Desist = (await anon.rpc('get_participante_seguro', { p_token: tokOpenA })).data;
  check('4.15 Participante abierto que desistió: token rotado y sin logística', partOpenA_Desist === null || partOpenA_Desist?.encuentros?.lugar_texto === null);

  // =========================================================================
  // 5. Enlace virtual y encuentro cancelado
  // =========================================================================
  console.log('\n[5] Enlace virtual y cancelación');
  const SECRET_LINK = `https://meet.example.test/${RUN}-suite-room`;
  const { data: encVirt } = await admin.from('encuentros').insert({
    host_id: host.id,
    titulo: `${RUN} Virtual Abierto`,
    open_public_title: `${RUN} Virtual Titulo Publico`,
    descripcion: 'Desc privada virtual',
    open_description: 'Desc publica virtual',
    modalidad: 'virtual',
    link_virtual: SECRET_LINK,
    tipo_invitacion: 'individual',
    is_open: true,
    opened_at: new Date().toISOString(),
    moderation_status: 'approved',
    fecha: tomorrow,
    hora: '20:00:00',
    estado: 'activo',
    max_participants: 6,
    min_participants: 1
  }).select('id, public_token').single();
  createdEncounterIds.push(encVirt.id);

  // Invitado individual privado virtual creado tras apertura
  const invVirtPriv = (await host.client.rpc('crear_participante_individual_seguro', {
    p_encuentro_id: encVirt.id, p_host_id: host.id, p_nombre: 'Privado Virtual'
  })).data;
  const pVirtPrivPend = (await anon.rpc('get_participante_seguro', { p_token: invVirtPriv.token_invitacion })).data;
  check('5.1 Invitado privado virtual pendiente: link_virtual nulo', pVirtPrivPend?.encuentros?.link_virtual === null);

  // Confirmar participante virtual legítimo
  await admin.from('participantes').update({ estado: 'confirmado' }).eq('token_invitacion', invVirtPriv.token_invitacion);
  const pVirtPrivConf = (await anon.rpc('get_participante_seguro', { p_token: invVirtPriv.token_invitacion })).data;
  check('5.2 Invitado privado virtual confirmado: link_virtual visible', pVirtPrivConf?.encuentros?.link_virtual === SECRET_LINK);

  // Cancelar encuentro virtual
  await host.client.rpc('cancelar_encuentro_seguro', {
    p_encuentro_id: encVirt.id, p_host_id: host.id, p_cancellation_reason: 'QA Cancelacion'
  });
  const pVirtCancel = (await anon.rpc('get_participante_seguro', { p_token: invVirtPriv.token_invitacion })).data;
  check('5.3 Encuentro cancelado: link_virtual nulo para todos', pVirtCancel?.encuentros?.link_virtual === null);

  // Acceso desde sesión ajena
  const pubCanc = (await anon.rpc('get_encuentro_por_public_token', { p_public_token: encVirt.public_token })).data;
  check('5.4 Encuentro cancelado no se devuelve en get_encuentro_por_public_token', pubCanc === null);

  // =========================================================================
  // 6. Encuentro históricamente abierto con Discovery cerrado
  // =========================================================================
  console.log('\n[6] Encuentro históricamente abierto con Discovery cerrado');
  const { data: encHist } = await admin.from('encuentros').insert({
    host_id: host.id,
    titulo: `${RUN} Histórico Titulo Privado`,
    open_public_title: `${RUN} Histórico Titulo Publico`,
    descripcion: 'Privada historica',
    open_description: 'Publica historica',
    modalidad: 'presencial',
    lugar_texto: `Historico Lugar ${RUN}`,
    tipo_invitacion: 'individual',
    is_open: false, // Ahora cerrado
    opened_at: new Date(Date.now() - 3600000).toISOString(), // pero fue abierto
    closed_at: new Date().toISOString(),
    moderation_status: 'approved',
    fecha: tomorrow,
    hora: '21:00:00',
    estado: 'activo',
    max_participants: 6
  }).select('id, public_token').single();
  createdEncounterIds.push(encHist.id);

  const histPub = (await anon.rpc('get_encuentro_por_public_token', { p_public_token: encHist.public_token })).data;
  check('6.1 Históricamente abierto con Discovery cerrado: no filtra lugar_texto (null)', histPub?.lugar_texto === null);
  check('6.2 Históricamente abierto con Discovery cerrado: proyecta titulo publico', histPub?.titulo === `${RUN} Histórico Titulo Publico`);
  check('6.3 Históricamente abierto con Discovery cerrado: proyecta descripcion publica', histPub?.descripcion === 'Publica historica');

  console.log('\n== RESUMEN DE COMPROBACIONES FASE 5 ==');
  const failed = results.filter((x) => !x.ok);
  console.log(`${results.length - failed.length}/${results.length} verificaciones OK`);
  if (failed.length) {
    console.log('FALLAS:');
    failed.forEach((f) => console.log(` - ${f.name} -> ${f.detail}`));
  }
  return failed.length;
}

async function cleanup() {
  console.log('\n-- Limpieza de fixtures de verificación Fase 5 --');
  try {
    if (createdEncounterIds.length) {
      await admin.from('encuentros_contacto_whatsapp').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('mensajes_encuentro').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('solicitudes_encuentro_abierto').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('participante_disponibilidades').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentro_opciones_fecha').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('participantes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('inbox_notifications').delete().in('target_id', createdEncounterIds);
      await admin.from('domain_events_outbox').delete().in('aggregate_id', createdEncounterIds);
      await admin.from('public_content_moderation_audit').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    for (const uid of createdUserIds) await admin.auth.admin.deleteUser(uid);
    console.log(`Eliminados ${createdEncounterIds.length} encuentros y ${createdUserIds.length} usuarios QA.`);
  } catch (e: any) {
    console.warn(`Limpieza parcial: ${e?.message}`);
  }
}

main()
  .then(async (failures) => { await cleanup(); process.exit(failures ? 1 : 0); })
  .catch(async (e) => { console.error('FATAL', e); await cleanup(); process.exit(2); });
