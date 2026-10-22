/**
 * Staging QA — Logística privada de encuentros abiertos condicionada a reconfirmación.
 *
 * Target: wougfhfwqgmxhgvjqoua (Staging) — guard assertStagingEnvironment().
 *
 * Circuito funcional ejecutado con usuarios reales de Supabase Auth y RPC reales
 * (solicitar / aprobar / cerrar / reabrir / reconfirmar / desistir / actualizar / cancelar).
 * El service key se usa únicamente para: crear usuarios QA, sembrar el encuentro base
 * (equivalente a la aprobación de moderación) y leer estado para contrastar payloads.
 *
 * Verifica PAYLOADS de cada RPC de lectura, no el DOM. No toca el piloto QA-E2E001.
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

const RUN = `QAV1-${Date.now().toString(36)}`;
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
  const email = `qa-v1-${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}@puntoencuentro.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: `QA ${prefix}` },
  });
  if (error || !data.user) throw new Error(`createUser ${prefix}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const client = createClient(url, publishableKey, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw new Error(`signIn ${prefix}: ${sErr.message}`);
  return { id: data.user.id, email, client };
}

async function freshSession(a: Actor): Promise<SupabaseClient> {
  const client = createClient(url, publishableKey, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: a.email, password: PASSWORD });
  if (error) throw new Error(`freshSession: ${error.message}`);
  return client;
}

interface EncOpts {
  label: string;
  hostId: string;
  modalidad?: 'presencial' | 'virtual';
  min?: number | null;
  max?: number;
  open?: boolean;
  secretPlace?: string;
  secretLink?: string;
  description?: string;
}
async function seedEncounter(o: EncOpts) {
  const isOpen = o.open ?? true;
  const { data, error } = await admin.from('encuentros').insert({
    host_id: o.hostId,
    titulo: `${RUN} ${o.label}`,
    open_public_title: isOpen ? `${RUN} ${o.label}` : null,
    descripcion: 'Fixture de verificación V1',
    open_description: isOpen ? (o.description ?? 'Zona Plaza Colón. Plan tranquilo.') : null,
    fecha: '2026-10-23',
    hora: '19:00:00',
    modalidad: o.modalidad ?? 'presencial',
    lugar_texto: (o.modalidad ?? 'presencial') === 'presencial' ? (o.secretPlace ?? null) : null,
    link_virtual: o.modalidad === 'virtual' ? (o.secretLink ?? null) : null,
    tipo_invitacion: 'individual',
    locality_id: o.modalidad === 'virtual' ? null : 'centro',
    open_public_zone: o.modalidad === 'virtual' ? 'Virtual' : 'Centro',
    is_open: isOpen,
    opened_at: isOpen ? new Date().toISOString() : null,
    estado: 'activo',
    max_participants: o.max ?? 6,
    min_participants: o.min ?? null,
    realization_status: 'pending',
    allow_multi_seat_requests: false,
    max_seats_per_request: 1,
    min_seats_per_request: 1,
    moderation_status: isOpen ? 'approved' : 'draft',
  }).select('id, public_token').single();
  if (error || !data) throw new Error(`seed ${o.label}: ${error?.message}`);
  createdEncounterIds.push(data.id);
  return { id: data.id as string, publicToken: data.public_token as string };
}

async function encRow(id: string) {
  const { data } = await admin.from('encuentros')
    .select('realization_status, inscriptions_closed, inscriptions_cycle_id, estado, fecha, lugar_texto, link_virtual, modalidad')
    .eq('id', id).single();
  return data as any;
}
async function partRow(id: string) {
  const { data } = await admin.from('participantes')
    .select('*').eq('id', id).single();
  return data as any;
}

/** Devuelve las rutas de lectura cuyo payload contiene alguno de los secretos. */
async function leakRoutes(
  who: { client: SupabaseClient; token?: string | null },
  enc: { id: string; publicToken: string },
  secrets: string[],
): Promise<string[]> {
  const found: string[] = [];
  const has = (p: unknown) => {
    const s = JSON.stringify(p ?? null);
    return secrets.some((x) => s.includes(x));
  };
  const probe = async (name: string, fn: () => PromiseLike<{ data: unknown }>) => {
    try { const r = await fn(); if (has(r.data)) found.push(name); } catch { /* ruta denegada */ }
  };
  const token = who.token ?? null;
  await probe('get_encuentro_participante_autorizado', () => who.client.rpc('get_encuentro_participante_autorizado', { p_encuentro_id: enc.id }));
  await probe('get_encuentros_participados_seguro', () => who.client.rpc('get_encuentros_participados_seguro'));
  await probe('get_encuentro_por_public_token', () => anon.rpc('get_encuentro_por_public_token', { p_public_token: enc.publicToken }));
  await probe('get_mensajes_encuentro_seguro', () => who.client.rpc('get_mensajes_encuentro_seguro', { p_encuentro_id: enc.id, p_token_invitacion: token }));
  await probe('obtener_contacto_whatsapp_seguro', () => who.client.rpc('obtener_contacto_whatsapp_seguro', { p_encuentro_id: enc.id, p_token_invitacion: token }));
  await probe('get_discovery_encuentros_abiertos', () => who.client.rpc('get_discovery_encuentros_abiertos', { p_locality_ids: null, p_only_available: false }));
  await probe('tabla encuentros (SELECT directo)', () => who.client.from('encuentros').select('*').eq('id', enc.id));
  await probe('tabla participantes (SELECT directo)', () => who.client.from('participantes').select('*').eq('encuentro_id', enc.id));
  if (token) {
    await probe('get_participante_seguro', () => anon.rpc('get_participante_seguro', { p_token: token }));
    await probe('get_encuentros_participados_por_tokens', () => anon.rpc('get_encuentros_participados_por_tokens', { p_tokens: [token] }));
    await probe('get_coordinacion_participante_seguro', () => anon.rpc('get_coordinacion_participante_seguro', { p_token: token }));
    await probe('obtener_contacto_whatsapp_seguro(anon+token)', () => anon.rpc('obtener_contacto_whatsapp_seguro', { p_encuentro_id: enc.id, p_token_invitacion: token }));
    await probe('get_mensajes_encuentro_seguro(anon+token)', () => anon.rpc('get_mensajes_encuentro_seguro', { p_encuentro_id: enc.id, p_token_invitacion: token }));
  }
  await probe('get_coordinacion_publica_seguro', () => anon.rpc('get_coordinacion_publica_seguro', { p_public_token: enc.publicToken }));
  return found;
}

async function notificationsLeak(encId: string, secrets: string[]) {
  const { data } = await admin.from('inbox_notifications').select('*').eq('target_id', encId);
  const rows = data ?? [];
  const leaked = rows.filter((r) => secrets.some((s) => JSON.stringify(r).includes(s)));
  return { total: rows.length, leaked: leaked.length };
}

async function notifCount(encId: string, type: string, userId?: string) {
  let q = admin.from('inbox_notifications').select('id', { count: 'exact', head: true })
    .eq('target_id', encId).eq('notification_type', type);
  if (userId) q = q.eq('recipient_user_id', userId);
  const { count } = await q;
  return count ?? 0;
}

async function request(a: Actor, encId: string, name = 'QA') {
  const { data, error } = await a.client.rpc('solicitar_sumarse_encuentro_abierto', {
    p_encuentro_id: encId, p_nombre: name, p_mensaje: 'QA', p_seat_count: 1,
  });
  if (error || !data?.ok) throw new Error(`solicitar: ${error?.message ?? JSON.stringify(data)}`);
  return data.request_id as string;
}
async function approve(host: Actor, requestId: string) {
  const { data, error } = await host.client.rpc('aprobar_solicitud_encuentro_abierto', { p_request_id: requestId });
  if (error || !data?.ok) throw new Error(`aprobar: ${error?.message ?? JSON.stringify(data)}`);
  return data as { participante_id: string; token_invitacion: string };
}
const closeInsc = (h: Actor, id: string) => h.client.rpc('cerrar_inscripciones_seguro', { p_encuentro_id: id, p_host_id: h.id });
const reopenInsc = (h: Actor, id: string) => h.client.rpc('reabrir_inscripciones_seguro', { p_encuentro_id: id, p_host_id: h.id });
const reconfirm = (a: Actor | { client: SupabaseClient }, id: string, d: 'confirm' | 'decline') =>
  a.client.rpc('reconfirmar_asistencia_seguro', { p_encuentro_id: id, p_decision: d, p_motivo: null });

async function main() {
  console.log(`== QA V1 reconfirmación — run ${RUN} — Staging wougfhfwqgmxhgvjqoua ==\n`);

  const host = await makeUser('host');
  const A = await makeUser('a');
  const B = await makeUser('b');
  const C = await makeUser('c');
  const stranger = await makeUser('stranger');

  const PLACE = `Calle Secreta ${RUN} 4321 Piso 9`;
  const PHONE = '+5492230001111';
  const MSG = `Instrucciones: timbre ${RUN}-Z9 puerta azul`;
  const secrets = [PLACE, MSG];

  // =====================================================================
  // ESCENARIO 1 — Presencial con mínimo 2 (ciclo completo)
  // =====================================================================
  console.log('\n[ESC-1] Presencial con mínimo=2: solicitud → aprobación → mínimo → cierre → reconfirmación');
  const e1 = await seedEncounter({ label: 'E1 min2', hostId: host.id, min: 2, secretPlace: PLACE });
  const reqA = await request(A, e1.id, 'Ana');
  check('1.01 Solicitud pendiente: sin fuga en ninguna ruta', (await leakRoutes({ client: A.client }, e1, secrets)).length === 0,
    (await leakRoutes({ client: A.client }, e1, secrets)).join(', '));

  const apA = await approve(host, reqA);
  const tokA = apA.token_invitacion;
  let leaks = await leakRoutes({ client: A.client, token: tokA }, e1, secrets);
  check('1.02 Aprobada, realización pendiente: sin fuga', leaks.length === 0, leaks.join(', '));
  let r = await reconfirm(A, e1.id, 'confirm');
  check('1.03 Reconfirmar por RPC directa con realización pendiente es rechazado', r.data?.ok === false, JSON.stringify(r.data));

  const reqB = await request(B, e1.id, 'Beto');
  const apB = await approve(host, reqB);
  const tokB = apB.token_invitacion;
  let row = await encRow(e1.id);
  check('1.04 Mínimo alcanzado ⇒ realization_status=confirmed (inscripciones abiertas)', row.realization_status === 'confirmed' && row.inscriptions_closed === false, JSON.stringify(row));
  leaks = await leakRoutes({ client: A.client, token: tokA }, e1, secrets);
  check('1.05 Realización confirmada con inscripciones abiertas: sin fuga', leaks.length === 0, leaks.join(', '));
  r = await reconfirm(A, e1.id, 'confirm');
  check('1.06 Reconfirmar con inscripciones abiertas es rechazado', r.data?.ok === false, JSON.stringify(r.data));
  const authA0 = (await A.client.rpc('get_encuentro_participante_autorizado', { p_encuentro_id: e1.id })).data;
  check('1.07 Detalle autorizado aprobado: info pública sí, logística no',
    authA0?.ok === true && !authA0.lugar_texto && !authA0.link_virtual && authA0.open_public_zone === 'Centro' && String(authA0.open_description).includes('Plaza Colón'),
    JSON.stringify(authA0));

  // Mensaje del anfitrión con instrucciones (se prueba gating del panel)
  await host.client.rpc('publicar_mensaje_encuentro_seguro', { p_encuentro_id: e1.id, p_contenido: MSG, p_parent_id: null, p_token_invitacion: null });
  await host.client.rpc('guardar_contacto_whatsapp_host_seguro', { p_encuentro_id: e1.id, p_telefono: PHONE, p_opt_in: true });
  const waA0 = (await A.client.rpc('obtener_contacto_whatsapp_seguro', { p_encuentro_id: e1.id, p_token_invitacion: null })).data;
  check('1.08 WhatsApp del anfitrión no se entrega antes de reconfirmar', !JSON.stringify(waA0).includes('2230001111'), JSON.stringify(waA0));

  const closeRes = await closeInsc(host, e1.id);
  check('1.09 Cierre de inscripciones OK', closeRes.data?.ok === true && closeRes.data?.final_confirmation_sent === true, JSON.stringify(closeRes.data));
  const nA = await notifCount(e1.id, 'encounter_final_confirmation', A.id);
  const nB = await notifCount(e1.id, 'encounter_final_confirmation', B.id);
  check('1.10 Aviso de reconfirmación a cada aprobado (1 c/u)', nA === 1 && nB === 1, `A=${nA} B=${nB}`);
  const closeAgain = await closeInsc(host, e1.id);
  check('1.11 Cierre idempotente: sin duplicar avisos', closeAgain.data?.no_change === true && (await notifCount(e1.id, 'encounter_final_confirmation', A.id)) === 1);
  let nl = await notificationsLeak(e1.id, [PLACE, PHONE, MSG, 'meet.example']);
  check('1.12 Notificaciones sin dirección/enlace/teléfono', nl.leaked === 0, JSON.stringify(nl));

  leaks = await leakRoutes({ client: A.client, token: tokA }, e1, [PLACE, MSG, '2230001111']);
  check('1.13 Cerradas y sin reconfirmar: sin fuga en ninguna ruta (A)', leaks.length === 0, leaks.join(', '));
  const authA1 = (await A.client.rpc('get_encuentro_participante_autorizado', { p_encuentro_id: e1.id })).data;
  check('1.14 Estado de reconfirmación visible y pendiente', authA1?.reconfirmation_status === 'pending' && authA1?.inscriptions_closed === true && authA1?.realization_status === 'confirmed', JSON.stringify(authA1));

  // Sesión no autorizada
  const strangerLeaks = await leakRoutes({ client: stranger.client }, e1, [PLACE, MSG]);
  const anonLeaks = await leakRoutes({ client: anon }, e1, [PLACE, MSG]);
  check('1.15 Sesión ajena y anónima: sin fuga', strangerLeaks.length === 0 && anonLeaks.length === 0, `stranger=${strangerLeaks} anon=${anonLeaks}`);
  const rStranger = await reconfirm(stranger, e1.id, 'confirm');
  check('1.16 Reconfirmar sin ser participante es rechazado', rStranger.data?.ok === false, JSON.stringify(rStranger.data));

  // Reconfirmación positiva
  r = await reconfirm(A, e1.id, 'confirm');
  check('1.17 Reconfirmación positiva en ciclo vigente', r.data?.ok === true && r.data?.reconfirmation_status === 'confirmed', JSON.stringify(r.data));
  const authA2 = (await A.client.rpc('get_encuentro_participante_autorizado', { p_encuentro_id: e1.id })).data;
  check('1.18 Tras reconfirmar: lectura autorizada entrega dirección', authA2?.ok === true && authA2.lugar_texto === PLACE, JSON.stringify(authA2));
  const mis = (await A.client.rpc('get_encuentros_participados_seguro')).data as any[];
  check('1.19 «Mis encuentros» entrega dirección solo tras reconfirmar', Array.isArray(mis) && mis.some((e) => e.id === e1.id && e.lugar_texto === PLACE));
  const part = (await anon.rpc('get_participante_seguro', { p_token: tokA })).data;
  check('1.20 Enlace del participante (token) entrega dirección tras reconfirmar', part?.encuentros?.lugar_texto === PLACE, JSON.stringify(part?.encuentros));
  const porTok = (await anon.rpc('get_encuentros_participados_por_tokens', { p_tokens: [tokA] })).data as any[];
  check('1.21 Lectura por tokens entrega dirección tras reconfirmar', porTok?.some((e) => e.id === e1.id && e.lugar_texto === PLACE));
  const waA = (await A.client.rpc('obtener_contacto_whatsapp_seguro', { p_encuentro_id: e1.id, p_token_invitacion: null })).data;
  check('1.22 WhatsApp del anfitrión disponible tras reconfirmar', waA?.has_contact === true, JSON.stringify(waA));
  const msgsA = (await A.client.rpc('get_mensajes_encuentro_seguro', { p_encuentro_id: e1.id, p_token_invitacion: null })).data;
  check('1.23 Panel de mensajes/instrucciones disponible tras reconfirmar', JSON.stringify(msgsA).includes(RUN), JSON.stringify(msgsA).slice(0, 200));

  // Persistencia
  const A2 = await freshSession(A);
  const authA3 = (await A2.rpc('get_encuentro_participante_autorizado', { p_encuentro_id: e1.id })).data;
  check('1.24 Persistencia: nueva sesión conserva el acceso', authA3?.lugar_texto === PLACE);

  // B no reconfirmó
  leaks = await leakRoutes({ client: B.client, token: tokB }, e1, [PLACE, MSG, '2230001111']);
  check('1.25 B (sin reconfirmar) sigue sin acceso aunque A sí', leaks.length === 0, leaks.join(', '));
  const pubLeak = await leakRoutes({ client: anon }, e1, [PLACE]);
  check('1.26 Detalle público/enlace general nunca exponen la dirección', pubLeak.length === 0, pubLeak.join(', '));

  // Reconfirmación negativa de B → pierde mínimo
  r = await reconfirm(B, e1.id, 'decline');
  check('1.27 Reconfirmación negativa libera lugar', r.data?.ok === true && r.data?.decision === 'decline', JSON.stringify(r.data));
  row = await encRow(e1.id);
  check('1.28 Pérdida de mínimo revierte realización a pending', row.realization_status === 'pending', JSON.stringify(row));
  leaks = await leakRoutes({ client: B.client, token: tokB }, e1, [PLACE, MSG]);
  check('1.29 Participante que desistió: sin logística', leaks.length === 0, leaks.join(', '));
  leaks = await leakRoutes({ client: A.client, token: tokA }, e1, [PLACE, MSG]);
  check('1.30 Reversión por pérdida de mínimo revoca el acceso de A (no hay realización confirmada)', leaks.length === 0, leaks.join(', '));
  r = await reconfirm(A, e1.id, 'confirm');
  check('1.31 No se puede reconfirmar mientras la realización no está confirmada', r.data?.ok === false, JSON.stringify(r.data));

  // Segundo ciclo: C completa el mínimo otra vez
  // Las inscripciones siguen cerradas: el anfitrión las reabre para recibir a C
  await reopenInsc(host, e1.id);
  const reqC = await request(C, e1.id, 'Cami');
  const apC = await approve(host, reqC);
  const tokC = apC.token_invitacion;
  row = await encRow(e1.id);
  check('1.32 Con C se alcanza de nuevo el mínimo', row.realization_status === 'confirmed' && row.inscriptions_closed === false, JSON.stringify(row));
  r = await closeInsc(host, e1.id);
  check('1.33 Segundo cierre genera nuevo ciclo y avisos', r.data?.ok === true && r.data?.final_confirmation_sent === true);
  leaks = await leakRoutes({ client: A.client, token: tokA }, e1, [PLACE, MSG]);
  check('1.34 Reconfirmación de ciclo anterior NO habilita acceso en el ciclo nuevo', leaks.length === 0, leaks.join(', '));
  const pA = await partRow(apA.participante_id);
  check('1.35 La reconfirmación previa quedó invalidada', pA.reconfirmation_status !== 'confirmed', JSON.stringify({ s: pA.reconfirmation_status, c: pA.reconfirmed_cycle_id }));
  r = await reconfirm(A, e1.id, 'confirm');
  check('1.36 A reconfirma en el ciclo nuevo y recupera acceso', r.data?.ok === true && (await A.client.rpc('get_encuentro_participante_autorizado', { p_encuentro_id: e1.id })).data?.lugar_texto === PLACE);
  await reconfirm(C, e1.id, 'confirm');
  check('1.37 C reconfirmado accede', (await C.client.rpc('get_encuentro_participante_autorizado', { p_encuentro_id: e1.id })).data?.lugar_texto === PLACE);

  // Reapertura revoca
  await reopenInsc(host, e1.id);
  leaks = await leakRoutes({ client: A.client, token: tokA }, e1, [PLACE, MSG]);
  check('1.38 Reapertura de inscripciones revoca el acceso a logística', leaks.length === 0, leaks.join(', '));
  r = await reconfirm(A, e1.id, 'confirm');
  check('1.39 Con inscripciones reabiertas no se puede reconfirmar', r.data?.ok === false, JSON.stringify(r.data));
  await closeInsc(host, e1.id);
  leaks = await leakRoutes({ client: A.client, token: tokA }, e1, [PLACE, MSG]);
  check('1.40 Cierre posterior exige nueva reconfirmación', leaks.length === 0, leaks.join(', '));
  await reconfirm(A, e1.id, 'confirm');

  // Cambios críticos
  const upd1 = await host.client.rpc('actualizar_encuentro_seguro', { p_encuentro_id: e1.id, p_host_id: host.id, p_data: { fecha: '2026-10-24' } });
  check('1.41 Cambio de fecha aceptado', upd1.data?.ok === true, JSON.stringify(upd1.data));
  leaks = await leakRoutes({ client: A.client, token: tokA }, e1, [PLACE, MSG]);
  check('1.42 Cambio crítico de fecha exige nueva reconfirmación', leaks.length === 0, leaks.join(', '));
  await reconfirm(A, e1.id, 'confirm');
  const NEWPLACE = `Otra Direccion ${RUN} 777`;
  const upd2 = await host.client.rpc('actualizar_encuentro_seguro', { p_encuentro_id: e1.id, p_host_id: host.id, p_data: { lugar_texto: NEWPLACE } });
  check('1.43 Cambio de lugar aceptado', upd2.data?.ok === true, JSON.stringify(upd2.data));
  const authA4 = (await A.client.rpc('get_encuentro_participante_autorizado', { p_encuentro_id: e1.id })).data;
  check('1.44 Cambio de lugar: lectura autorizada fresca entrega la dirección nueva (sin reinicio por cambio menor)', authA4?.lugar_texto === NEWPLACE, JSON.stringify(authA4));
  nl = await notificationsLeak(e1.id, [PLACE, NEWPLACE, PHONE, MSG]);
  check('1.45 Notificaciones de cambios no incluyen dirección', nl.leaked === 0, JSON.stringify(nl));

  // Retiro voluntario de A
  const des = await A.client.rpc('desistir_encuentro_abierto_seguro', { p_encuentro_id: e1.id, p_motivo: null });
  check('1.46 Retiro voluntario', des.data?.ok === true);
  const stillA = await leakRoutes({ client: A.client, token: tokA }, e1, [PLACE, NEWPLACE, MSG]);
  check('1.47 Tras retiro voluntario no hay acceso', stillA.length === 0, stillA.join(', '));

  // Cancelación
  await reconfirm(C, e1.id, 'confirm');
  const can = await host.client.rpc('cancelar_encuentro_seguro', { p_encuentro_id: e1.id, p_host_id: host.id, p_cancellation_reason: 'Motivo QA de cancelacion' });
  check('1.48 Cancelación aceptada', can.data?.ok === true, JSON.stringify(can.data));
  leaks = await leakRoutes({ client: C.client, token: tokC }, e1, [PLACE, NEWPLACE, MSG]);
  check('1.49 Encuentro cancelado: sin logística para participantes', leaks.length === 0, leaks.join(', '));
  r = await reconfirm(C, e1.id, 'confirm');
  check('1.50 No se reconfirma un encuentro cancelado', r.data?.ok === false);
  const hostDet = (await host.client.rpc('get_detalle_host_seguro', { p_encuentro_id: e1.id, p_host_id: host.id })).data;
  check('1.51 El anfitrión conserva su información completa', hostDet?.lugar_texto === NEWPLACE, JSON.stringify(hostDet)?.slice(0, 200));

  // =====================================================================
  // ESCENARIO 2 — Sin mínimo: confirmación explícita del anfitrión
  // =====================================================================
  console.log('\n[ESC-2] Sin mínimo: «confirmar que se hace» + cierre en cualquier orden');
  const PLACE2 = `Sin Minimo ${RUN} 100`;
  const e2 = await seedEncounter({ label: 'E2 sin minimo', hostId: host.id, min: null, secretPlace: PLACE2 });
  const reqA2 = await request(A, e2.id, 'Ana');
  const apA2 = await approve(host, reqA2);
  row = await encRow(e2.id);
  check('2.01 Sin mínimo: queda pending (no se auto-confirma)', row.realization_status === 'pending', JSON.stringify(row));
  await closeInsc(host, e2.id);
  check('2.02 Cierre sin realización confirmada no envía reconfirmación', (await notifCount(e2.id, 'encounter_final_confirmation', A.id)) === 0);
  r = await reconfirm(A, e2.id, 'confirm');
  check('2.03 Sin confirmar realización no se puede reconfirmar', r.data?.ok === false, JSON.stringify(r.data));
  const hi = await host.client.rpc('hacerlo_igual_seguro', { p_encuentro_id: e2.id, p_host_id: host.id });
  check('2.04 El anfitrión confirma explícitamente (sin mínimo)', hi.data?.ok === true && hi.data?.realization_status === 'forced', JSON.stringify(hi.data));
  check('2.05 Ya cerrado: se notifica reconfirmación (1 aviso, con ciclo)', (await notifCount(e2.id, 'encounter_final_confirmation', A.id)) === 1);
  await host.client.rpc('hacerlo_igual_seguro', { p_encuentro_id: e2.id, p_host_id: host.id });
  check('2.06 Idempotencia de «hacerlo igual»', (await notifCount(e2.id, 'encounter_final_confirmation', A.id)) === 1);
  leaks = await leakRoutes({ client: A.client, token: apA2.token_invitacion }, e2, [PLACE2]);
  check('2.07 Forzado + cerrado + sin reconfirmar: sin fuga', leaks.length === 0, leaks.join(', '));
  r = await reconfirm(A, e2.id, 'confirm');
  check('2.08 Reconfirmación habilita la dirección', r.data?.ok === true && (await A.client.rpc('get_encuentro_participante_autorizado', { p_encuentro_id: e2.id })).data?.lugar_texto === PLACE2);

  // =====================================================================
  // ESCENARIO 3 — Virtual
  // =====================================================================
  console.log('\n[ESC-3] Virtual: enlace privado');
  const LINK = `https://meet.example.test/${RUN}-private-room`;
  const e3 = await seedEncounter({ label: 'E3 virtual', hostId: host.id, modalidad: 'virtual', min: 1, secretLink: LINK });
  const reqA3 = await request(A, e3.id, 'Ana');
  const apA3 = await approve(host, reqA3);
  leaks = await leakRoutes({ client: A.client, token: apA3.token_invitacion }, e3, [LINK]);
  check('3.01 Virtual aprobado/confirmado sin cierre: sin enlace', leaks.length === 0, leaks.join(', '));
  await closeInsc(host, e3.id);
  leaks = await leakRoutes({ client: A.client, token: apA3.token_invitacion }, e3, [LINK]);
  check('3.02 Virtual cerrado sin reconfirmar: sin enlace', leaks.length === 0, leaks.join(', '));
  await reconfirm(A, e3.id, 'confirm');
  const a3 = (await A.client.rpc('get_encuentro_participante_autorizado', { p_encuentro_id: e3.id })).data;
  const p3 = (await anon.rpc('get_participante_seguro', { p_token: apA3.token_invitacion })).data;
  check('3.03 Virtual reconfirmado: enlace en lectura autorizada y por token', a3?.link_virtual === LINK && p3?.encuentros?.link_virtual === LINK, JSON.stringify(a3)?.slice(0, 160));
  check('3.04 Enlace general público no expone el enlace virtual', (await leakRoutes({ client: anon }, e3, [LINK])).length === 0);

  // =====================================================================
  // ESCENARIO 4 — Regresión de privados + coexistencia
  // =====================================================================
  console.log('\n[ESC-4] Privados: invitación individual / general / virtual / coexistencia');
  const PPLACE = `Privado ${RUN} 55`;
  const e4 = await seedEncounter({ label: 'E4 privado', hostId: host.id, open: false, secretPlace: PPLACE });
  const inv = (await host.client.rpc('crear_participante_individual_seguro', { p_encuentro_id: e4.id, p_host_id: host.id, p_nombre: 'Invitado Privado' })).data;
  const invTok = inv.token_invitacion as string;
  let pv = (await anon.rpc('get_participante_seguro', { p_token: invTok })).data;
  check('4.01 Invitación individual pendiente: dirección visible antes de confirmar', pv?.encuentros?.lugar_texto === PPLACE, JSON.stringify(pv?.encuentros));
  const gen = (await anon.rpc('get_encuentro_por_public_token', { p_public_token: e4.publicToken })).data;
  check('4.02 Invitación general: dirección visible antes de responder', gen?.lugar_texto === PPLACE, JSON.stringify(gen));
  const resp = (await anon.rpc('responder_participante_seguro', { p_token: invTok, p_estado: 'confirmado', p_nombre: null, p_mensaje: null })).data;
  check('4.03 Invitación individual confirmada', resp?.ok === true, JSON.stringify(resp));
  pv = (await anon.rpc('get_participante_seguro', { p_token: invTok })).data;
  check('4.04 Confirmado: dirección visible', pv?.encuentros?.lugar_texto === PPLACE);
  const inv2 = (await host.client.rpc('crear_participante_individual_seguro', { p_encuentro_id: e4.id, p_host_id: host.id, p_nombre: 'Rechaza' })).data;
  await anon.rpc('responder_participante_seguro', { p_token: inv2.token_invitacion, p_estado: 'rechazado', p_nombre: null, p_mensaje: null });
  const pvR = (await anon.rpc('get_participante_seguro', { p_token: inv2.token_invitacion })).data;
  check('4.05 Invitación rechazada: sin dirección', !JSON.stringify(pvR).includes(PPLACE), JSON.stringify(pvR?.encuentros));
  const porTokR = (await anon.rpc('get_encuentros_participados_por_tokens', { p_tokens: [inv2.token_invitacion] })).data;
  check('4.06 Invitación rechazada (lectura por tokens): sin dirección', !JSON.stringify(porTokR).includes(PPLACE), JSON.stringify(porTokR)?.slice(0, 200));

  const PLINK = `https://meet.example.test/${RUN}-private-virtual`;
  const e4v = await seedEncounter({ label: 'E4v privado virtual', hostId: host.id, open: false, modalidad: 'virtual', secretLink: PLINK });
  const iv = (await host.client.rpc('crear_participante_individual_seguro', { p_encuentro_id: e4v.id, p_host_id: host.id, p_nombre: 'Virtual' })).data;
  let pvv = (await anon.rpc('get_participante_seguro', { p_token: iv.token_invitacion })).data;
  check('4.07 Virtual privado pendiente: sin enlace', !JSON.stringify(pvv).includes(PLINK));
  await anon.rpc('responder_participante_seguro', { p_token: iv.token_invitacion, p_estado: 'confirmado', p_nombre: null, p_mensaje: null });
  pvv = (await anon.rpc('get_participante_seguro', { p_token: iv.token_invitacion })).data;
  check('4.08 Virtual privado confirmado: enlace visible', pvv?.encuentros?.link_virtual === PLINK);

  // Coexistencia: privado con invitado pendiente que luego se abre
  const CPLACE = `Coexiste ${RUN} 909`;
  const e5 = await seedEncounter({ label: 'E5 coexistencia', hostId: host.id, open: false, secretPlace: CPLACE });
  const ci = (await host.client.rpc('crear_participante_individual_seguro', { p_encuentro_id: e5.id, p_host_id: host.id, p_nombre: 'Invitado previo' })).data;
  // El anfitrión publica por la RPC real; la aprobación de moderación se siembra como fixture
  const pub = await host.client.rpc('abrir_encuentro_seguro', {
    p_encuentro_id: e5.id, p_host_id: host.id, p_open_description: 'Cerca de Luro y España', p_max_participants: 5,
    p_locality_id: 'centro', p_open_public_zone: null, p_open_public_title: `${RUN} Coexistencia`,
    p_allow_multi_seat_requests: false, p_max_seats_per_request: 1, p_min_seats_per_request: 1,
  });
  check('4.09 Publicación con referencia «cerca de Luro y España»', pub.data?.ok === true && pub.data?.moderation_status === 'review_pending', JSON.stringify(pub.data));
  await admin.from('encuentros').update({ is_open: true, moderation_status: 'approved' }).eq('id', e5.id);
  const pc = (await anon.rpc('get_participante_seguro', { p_token: ci.token_invitacion })).data;
  check('4.10 Coexistencia: el invitado privado conserva su contrato (ve la dirección)', pc?.encuentros?.lugar_texto === CPLACE, JSON.stringify(pc?.encuentros));
  const pubTok = (await anon.rpc('get_encuentro_por_public_token', { p_public_token: e5.publicToken })).data;
  check('4.11 Coexistencia: el enlace general ya no expone la dirección', !JSON.stringify(pubTok).includes(CPLACE), JSON.stringify(pubTok));
  const reqX = await request(stranger, e5.id, 'Solicitante');
  const apX = await approve(host, reqX);
  leaks = await leakRoutes({ client: stranger.client, token: apX.token_invitacion }, e5, [CPLACE]);
  check('4.12 Coexistencia: solicitante abierto aprobado no obtiene la dirección', leaks.length === 0, leaks.join(', '));
  const disc = (await anon.rpc('get_discovery_encuentros_abiertos', { p_locality_ids: null, p_only_available: false })).data as any[];
  const dItem = disc?.find((x) => x.id === e5.id);
  check('4.13 Discovery muestra la referencia pública y no la dirección', dItem?.description === 'Cerca de Luro y España' && !JSON.stringify(dItem).includes(CPLACE), JSON.stringify(dItem)?.slice(0, 200));

  // =====================================================================
  // ESCENARIO 5 — Referencias geográficas aproximadas
  // =====================================================================
  console.log('\n[ESC-5] Ubicación orientativa: publicación con distintas referencias');
  const refs: Array<[string, string]> = [
    ['plaza', 'Plan de mate y juegos. Zona Plaza Colón.'],
    ['esquina', 'Charla de libros, cerca de Luro y España.'],
    ['costa', 'Caminata por la costa, a la altura de Playa Grande.'],
    ['sin referencia', 'Charla de libros y té.'],
  ];
  for (const [label, desc] of refs) {
    const ex = await seedEncounter({ label: `E6 ${label}`, hostId: host.id, open: false, secretPlace: `Direccion exacta ${RUN} ${label} 321` });
    const out = await host.client.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: ex.id, p_host_id: host.id, p_open_description: desc, p_max_participants: 4,
      p_locality_id: 'centro', p_open_public_zone: null, p_open_public_title: `${RUN} Ref ${label}`,
      p_allow_multi_seat_requests: false, p_max_seats_per_request: 1, p_min_seats_per_request: 1,
    });
    check(`5.${label} Publicación aceptada por la moderación (${label})`, out.data?.ok === true && out.data?.moderation_status === 'review_pending', JSON.stringify(out.data));
    await admin.from('encuentros').update({ is_open: true, moderation_status: 'approved' }).eq('id', ex.id);
    const dd = (await anon.rpc('get_discovery_encuentros_abiertos', { p_locality_ids: null, p_only_available: false })).data as any[];
    const it = dd?.find((x) => x.id === ex.id);
    check(`5.${label}.pub Discovery: descripción visible, zona conservada, sin dirección exacta (${label})`,
      it?.description === desc && it?.approximate_zone && !JSON.stringify(it).includes(`Direccion exacta ${RUN}`), JSON.stringify(it)?.slice(0, 220));
  }
  const longDesc = 'x'.repeat(10);
  void longDesc;

  console.log('\n== RESUMEN ==');
  const failed = results.filter((x) => !x.ok);
  console.log(`${results.length - failed.length}/${results.length} verificaciones OK`);
  if (failed.length) {
    console.log('FALLAS:');
    failed.forEach((f) => console.log(` - ${f.name}`));
  }
  return failed.length;
}

async function cleanup() {
  console.log('\n-- Limpieza de fixtures (solo los creados en esta corrida) --');
  try {
    if (createdEncounterIds.length) {
      await admin.from('encuentros_contacto_whatsapp').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('mensajes_encuentro').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('solicitudes_encuentro_abierto').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('participantes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('inbox_notifications').delete().in('target_id', createdEncounterIds);
      await admin.from('domain_events_outbox').delete().in('aggregate_id', createdEncounterIds);
      await admin.from('public_content_moderation_audit').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    for (const uid of createdUserIds) await admin.auth.admin.deleteUser(uid);
    console.log(`Eliminados ${createdEncounterIds.length} encuentros y ${createdUserIds.length} usuarios QA de la corrida ${RUN}.`);
  } catch (e: any) {
    console.warn(`Limpieza parcial: ${e?.message}`);
  }
}

main()
  .then(async (failures) => { await cleanup(); process.exit(failures ? 1 : 0); })
  .catch(async (e) => { console.error('FATAL', e); await cleanup(); process.exit(2); });
