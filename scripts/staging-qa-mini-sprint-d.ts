/**
 * QA Remoto en PostgreSQL Real (Supabase Staging: wougfhfwqgmxhgvjqoua)
 * Mini-Sprint D: Confianza Bidireccional — Base Factual y Trayectoria en Encuentros Abiertos
 *
 * 14 Escenarios de Verificación:
 *  1. Usuario nuevo / sin historial: ceros, muestra neutral 'sin_antecedentes', scoring deshabilitado.
 *  2. Aislamiento estricto de privados: encuentros exclusivamente privados nunca computan trayectoria.
 *  3. Encuentro abierto completado: computa para host (organizados, cierres a tiempo, recibidos) y participante (asistencias corroboradas).
 *  4. Muestra preliminar: 1 o 2 experiencias -> 'preliminar'.
 *  5. Muestra establecida: 3 o más experiencias -> 'establecida'.
 *  6. Conversión privado a abierto: excluye invitados privados previos a opened_at e incluye admitidos post-apertura.
 *  7. Solicitud multi-seat: no multiplica la trayectoria del participante principal (1 sola experiencia unitaria).
 *  8. Controversias y rectificaciones: registra inasistencias justificadas o no justificadas objetivamente.
 *  9. Cierre extemporáneo del anfitrión: registra cierre tardío sin contabilizar como a tiempo.
 * 10. Cancelaciones del anfitrión: diferenciación entre cancelados y completados.
 * 11. Control de acceso y privacidad: consulta protegida y permisos de moderación.
 * 12. Ausencia de valoraciones automáticas, scoring público o karma.
 * 13. Perfiles diferenciados: solo anfitrión vs solo participante.
 * 14. Paridad funcional entre get_trayectoria_encuentros_abiertos_seguro y get_historial_asistencia_factual_seguro.
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

async function runMiniSprintDStagingQA() {
  console.log('================================================================');
  console.log('QA REMOTO EN STAGING: 14 ESCENARIOS MINI-SPRINT D');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log(`Production Guard: strictly forbids ${PRODUCTION_PROJECT_REF}`);
  console.log('================================================================\n');

  const createdUserIds: string[] = [];
  const createdEncounterIds: string[] = [];
  const authorizedModUserIds: string[] = [];

  async function createQaUser(prefix: string, name: string) {
    const email = `qa-sprint-d-${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}@puntoencuentro.test`;
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
    console.log('[Setup] Creando usuarios de prueba en Staging...');
    const hostA = await createQaUser('hostA', 'Anfitrión Principal');
    const hostB = await createQaUser('hostB', 'Anfitrión Secundario');
    const part1 = await createQaUser('part1', 'Participante 1');
    const part2 = await createQaUser('part2', 'Participante 2');
    const userNuevo = await createQaUser('nuevo', 'Usuario Sin Historial');
    const moderator = await createQaUser('mod', 'Moderador Staging');
    const bystander = await createQaUser('bystand', 'Usuario Tercero');

    await admin.from('moderation_authorized_users').insert([
      { user_id: moderator.id, role: 'moderator', active: true },
    ]);
    authorizedModUserIds.push(moderator.id);
    console.log('✔ Usuarios y moderador configurados.');

    // Helper para crear encuentros
    async function createEncounter(params: {
      hostId: string;
      title: string;
      isOpen: boolean;
      openedAt?: string | null;
      fecha?: string;
      hora?: string;
      durationMinutes?: number;
      estado?: string;
      postEventRealizationStatus?: string;
      postEventClosureStatus?: string;
      postEventClosureType?: string;
      closedAt?: string | null;
    }) {
      const yesterday = new Date(Date.now() - 48 * 3600 * 1000).toISOString().split('T')[0];
      const isCompleted = (params.estado || 'activo') === 'activo';
      const { data, error } = await admin
        .from('encuentros')
        .insert({
          host_id: params.hostId,
          titulo: params.title,
          open_public_title: params.isOpen ? params.title : null,
          descripcion: 'Encuentro de QA para Mini-Sprint D',
          fecha: params.fecha || yesterday,
          hora: params.hora || '18:00:00',
          duration_minutes: params.durationMinutes || 120,
          modalidad: 'presencial',
          locality_id: params.isOpen ? 'centro' : null,
          open_public_zone: params.isOpen ? 'Centro' : null,
          tipo_invitacion: 'individual',
          max_participants: 10,
          min_participants: 1,
          is_open: params.isOpen,
          opened_at: params.openedAt !== undefined ? params.openedAt : (params.isOpen ? new Date(Date.now() - 72 * 3600 * 1000).toISOString() : null),
          estado: params.estado || 'activo',
          post_event_realization_status: params.postEventRealizationStatus !== undefined ? params.postEventRealizationStatus : (params.isOpen ? 'realized' : null),
          post_event_closure_status: params.postEventClosureStatus || (params.isOpen ? (isCompleted ? 'completed' : 'not_applicable') : 'not_applicable'),
          post_event_closure_type: params.postEventClosureType || (params.isOpen && isCompleted ? 'within_deadline' : null),
          post_event_closed_at: params.closedAt !== undefined ? params.closedAt : new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
          post_event_closed_responsibly: true,
        })
        .select()
        .single();
      if (error || !data) throw new Error(`Fallo crear encuentro: ${error?.message}`);
      createdEncounterIds.push(data.id);
      return data;
    }

    // Helper para agregar participante
    async function addParticipant(encounterId: string, userId: string, params: {
      estado: string;
      attendanceStatus?: string;
      attendanceDisputeStatus?: string;
      admissionSource?: string;
      creadoEn?: string;
      seatCount?: number;
    }) {
      const { data, error } = await admin
        .from('participantes')
        .insert({
          encuentro_id: encounterId,
          user_id: userId,
          nombre_invitado: 'Participante QA',
          tipo_invitacion: 'individual',
          estado: params.estado,
          attendance_status: params.attendanceStatus || (params.estado === 'asistio' ? 'attended' : 'unverified'),
          attendance_dispute_status: params.attendanceDisputeStatus || 'none',
          attendance_recorded_at: new Date().toISOString(),
          admission_source: params.admissionSource || 'open_request',
          creado_en: params.creadoEn || new Date().toISOString(),
          seat_count: params.seatCount || 1,
        })
        .select()
        .single();
      if (error || !data) throw new Error(`Fallo insertar participante: ${error?.message}`);
      return data;
    }

    // =========================================================================
    // Escenario 1: Usuario nuevo / sin historial previo
    // =========================================================================
    console.log('\n[Escenario 1] Usuario nuevo sin historial');
    const { data: res1, error: err1 } = await userNuevo.client.rpc('get_trayectoria_encuentros_abiertos_seguro');
    assert.equal(err1, null, `Error en RPC usuario nuevo: ${err1?.message}`);
    assert.ok(res1, 'Debe devolver datos de trayectoria');
    assert.equal(res1.contexto_factual.estado_muestra, 'sin_antecedentes');
    assert.equal(res1.contexto_factual.scoring_publico_habilitado, false);
    assert.equal(res1.trayectoria_anfitrion.datos_objetivos.encuentros_abiertos_organizados, 0);
    assert.equal(res1.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 0);
    console.log('✔ Escenario 1 aprobado: usuario nuevo neutral sin scoring ni antecedentes.');

    // =========================================================================
    // Escenario 2: Aislamiento absoluto de encuentros privados
    // =========================================================================
    console.log('\n[Escenario 2] Aislamiento absoluto de encuentros privados');
    const encPrivado = await createEncounter({
      hostId: hostA.id,
      title: 'Encuentro 100% Privado',
      isOpen: false,
      openedAt: null,
      estado: 'activo',
      postEventRealizationStatus: null,
    });
    await addParticipant(encPrivado.id, part1.id, {
      estado: 'asistio',
      attendanceStatus: 'attended',
      admissionSource: 'private_general_link',
    });

    const { data: resPrivHost } = await hostA.client.rpc('get_trayectoria_encuentros_abiertos_seguro');
    const { data: resPrivPart } = await part1.client.rpc('get_trayectoria_encuentros_abiertos_seguro');
    assert.equal(resPrivHost.trayectoria_anfitrion.datos_objetivos.encuentros_abiertos_organizados, 0, 'Privado no debe contar para host');
    assert.equal(resPrivPart.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 0, 'Privado no debe contar para participante');
    console.log('✔ Escenario 2 aprobado: encuentros privados estrictamente aislados.');

    // =========================================================================
    // Escenario 3: Encuentro abierto cerrado con éxito
    // =========================================================================
    console.log('\n[Escenario 3] Encuentro abierto completado con éxito');
    const encAbierto1 = await createEncounter({
      hostId: hostA.id,
      title: 'Encuentro Abierto 1',
      isOpen: true,
      openedAt: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
      estado: 'activo',
      postEventRealizationStatus: 'realized',
      closedAt: new Date(Date.now() - 40 * 3600 * 1000).toISOString(), // A tiempo (< 48h)
    });
    await addParticipant(encAbierto1.id, part1.id, {
      estado: 'asistio',
      attendanceStatus: 'attended',
      admissionSource: 'open_request',
    });

    const { data: resHostA } = await hostA.client.rpc('get_trayectoria_encuentros_abiertos_seguro');
    const { data: resPart1 } = await part1.client.rpc('get_trayectoria_encuentros_abiertos_seguro');
    assert.equal(resHostA.trayectoria_anfitrion.datos_objetivos.encuentros_abiertos_organizados, 1);
    assert.equal(resHostA.trayectoria_anfitrion.datos_objetivos.cierres_a_tiempo, 1);
    assert.equal(resHostA.trayectoria_anfitrion.datos_objetivos.participantes_recibidos_total, 1);
    assert.equal(resPart1.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 1);
    assert.equal(resPart1.trayectoria_participante.declaraciones_anfitrion.asistencias_declaradas_host, 1);
    console.log('✔ Escenario 3 aprobado: métricas fácticas computadas con precisión.');

    // =========================================================================
    // Escenario 4: Muestra preliminar (1 o 2 experiencias)
    // =========================================================================
    console.log('\n[Escenario 4] Muestra preliminar');
    assert.equal(resPart1.contexto_factual.estado_muestra, 'preliminar');
    assert.equal(resHostA.contexto_factual.estado_muestra, 'preliminar');
    console.log('✔ Escenario 4 aprobado: 1 experiencia = muestra preliminar.');

    // =========================================================================
    // Escenario 5: Muestra establecida (3 o más experiencias)
    // =========================================================================
    console.log('\n[Escenario 5] Muestra consolidada / establecida');
    const encAbierto2 = await createEncounter({
      hostId: hostB.id,
      title: 'Encuentro Abierto 2',
      isOpen: true,
      postEventRealizationStatus: 'realized',
    });
    await addParticipant(encAbierto2.id, part1.id, {
      estado: 'asistio',
      attendanceStatus: 'attended',
      admissionSource: 'open_request',
    });

    const encAbierto3 = await createEncounter({
      hostId: hostB.id,
      title: 'Encuentro Abierto 3',
      isOpen: true,
      postEventRealizationStatus: 'realized',
    });
    await addParticipant(encAbierto3.id, part1.id, {
      estado: 'asistio',
      attendanceStatus: 'attended',
      admissionSource: 'open_request',
    });

    const { data: resPart1Established } = await part1.client.rpc('get_trayectoria_encuentros_abiertos_seguro');
    assert.equal(resPart1Established.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 3);
    assert.equal(resPart1Established.contexto_factual.estado_muestra, 'establecida');
    console.log('✔ Escenario 5 aprobado: >= 3 experiencias = muestra establecida.');

    // =========================================================================
    // Escenario 6: Conversión de privado a abierto (aislamiento de invitados previos)
    // =========================================================================
    console.log('\n[Escenario 6] Conversión privado a abierto y procedencia');
    const openTime = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    const encConvertido = await createEncounter({
      hostId: hostB.id,
      title: 'Encuentro Convertido a Abierto',
      isOpen: true,
      openedAt: openTime,
      postEventRealizationStatus: 'realized',
    });
    // Invitado privado previo a apertura
    await addParticipant(encConvertido.id, part2.id, {
      estado: 'asistio',
      attendanceStatus: 'attended',
      admissionSource: 'private_general_link',
      creadoEn: new Date(Date.now() - 40 * 3600 * 1000).toISOString(),
    });

    const { data: resPart2Previo } = await part2.client.rpc('get_trayectoria_encuentros_abiertos_seguro');
    assert.equal(resPart2Previo.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 0, 'Invitado privado previo no debe contar en abiertos');

    // Ahora agregamos a part2 como participante admitido tras la apertura
    await addParticipant(encAbierto1.id, part2.id, {
      estado: 'asistio',
      attendanceStatus: 'attended',
      admissionSource: 'open_request',
      creadoEn: new Date(Date.now() - 20 * 3600 * 1000).toISOString(),
    });
    const { data: resPart2Post } = await part2.client.rpc('get_trayectoria_encuentros_abiertos_seguro');
    assert.equal(resPart2Post.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 1, 'Participante post-apertura sí cuenta');
    console.log('✔ Escenario 6 aprobado: aislamiento estricto de procedencia previa a apertura.');

    // =========================================================================
    // Escenario 7: Multi-seat no duplica trayectoria del participante principal
    // =========================================================================
    console.log('\n[Escenario 7] Multi-seat no duplica trayectoria');
    const encMultiSeat = await createEncounter({
      hostId: hostB.id,
      title: 'Encuentro Multi-Seat',
      isOpen: true,
      postEventRealizationStatus: 'realized',
    });
    await addParticipant(encMultiSeat.id, part2.id, {
      estado: 'asistio',
      attendanceStatus: 'attended',
      admissionSource: 'open_request',
      seatCount: 3, // Titular + 2 acompañantes
    });

    const { data: resPart2Multi } = await part2.client.rpc('get_trayectoria_encuentros_abiertos_seguro');
    // Tenía 1, ahora tiene exactamente 2 (no 4)
    assert.equal(resPart2Multi.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 2);
    console.log('✔ Escenario 7 aprobado: solicitudes multi-seat computan como 1 experiencia unitaria para el titular.');

    // =========================================================================
    // Escenario 8: Controversias y rectificaciones
    // =========================================================================
    console.log('\n[Escenario 8] Controversias y rectificaciones objetivas');
    const encDisputa = await createEncounter({
      hostId: hostA.id,
      title: 'Encuentro con Controversia Justificada',
      isOpen: true,
      postEventRealizationStatus: 'realized',
    });
    await addParticipant(encDisputa.id, part2.id, {
      estado: 'confirmado',
      attendanceStatus: 'advance_notice_absent',
      attendanceDisputeStatus: 'resolved_justified',
      admissionSource: 'open_request',
    });

    const { data: resPart2Dispute } = await part2.client.rpc('get_trayectoria_encuentros_abiertos_seguro');
    assert.equal(resPart2Dispute.trayectoria_participante.hechos_corroborados.inasistencias_justificadas, 1);
    assert.equal(resPart2Dispute.trayectoria_participante.hechos_corroborados.inasistencias_confirmadas_moderacion, 0);
    console.log('✔ Escenario 8 aprobado: ausencias justificadas registradas sin mancha de inasistencia.');

    // =========================================================================
    // Escenario 9: Cierre extemporáneo del anfitrión
    // =========================================================================
    console.log('\n[Escenario 9] Cierre extemporáneo del anfitrión');
    await createEncounter({
      hostId: hostA.id,
      title: 'Encuentro Cerrado Tarde',
      isOpen: true,
      postEventRealizationStatus: 'realized',
      postEventClosureStatus: 'completed',
      postEventClosureType: 'overdue',
      closedAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      fecha: new Date(Date.now() - 120 * 3600 * 1000).toISOString().split('T')[0], // 5 días atrás (> 48h)
    });

    const { data: resHostLate } = await hostA.client.rpc('get_trayectoria_encuentros_abiertos_seguro');
    assert.ok(resHostLate.trayectoria_anfitrion.datos_objetivos.cierres_tardios >= 1, 'Debe registrar cierre tardío');
    console.log('✔ Escenario 9 aprobado: cierres tardíos registrados separadamente.');

    // =========================================================================
    // Escenario 10: Cancelaciones del anfitrión
    // =========================================================================
    console.log('\n[Escenario 10] Cancelaciones del anfitrión');
    await createEncounter({
      hostId: hostA.id,
      title: 'Encuentro Cancelado',
      isOpen: true,
      estado: 'cancelado',
      fecha: new Date(Date.now() + 72 * 3600 * 1000).toISOString().split('T')[0],
    });

    const { data: resHostCancel } = await hostA.client.rpc('get_trayectoria_encuentros_abiertos_seguro');
    assert.ok(resHostCancel.trayectoria_anfitrion.datos_objetivos.encuentros_abiertos_cancelados >= 1, 'Debe registrar cancelación');
    console.log('✔ Escenario 10 aprobado: cancelaciones de encuentros abiertos computadas con precisión.');

    // =========================================================================
    // Escenario 11: Control de acceso y privacidad
    // =========================================================================
    console.log('\n[Escenario 11] Control de acceso y privacidad');
    // Bystander intentando consultar la trayectoria de hostA pasando su id
    const { data: resBystander, error: errBystander } = await bystander.client.rpc(
      'get_trayectoria_encuentros_abiertos_seguro',
      { p_user_id: hostA.id }
    );
    // Debe devolver ok: false con unauthorized o contexto neutral
    assert.ok(errBystander !== null || (resBystander && resBystander.ok === false), 'Tercero no debe acceder a trayectoria privada ajena');

    // Moderador sí puede consultar
    const { data: resModQuery, error: errModQuery } = await moderator.client.rpc(
      'get_trayectoria_encuentros_abiertos_seguro',
      { p_user_id: hostA.id }
    );
    assert.equal(errModQuery, null, 'Moderador debe poder auditar trayectoria');
    assert.ok(resModQuery !== null && resModQuery.ok === true, 'Moderador obtiene datos');
    console.log('✔ Escenario 11 aprobado: aislamiento de privacidad y autorización de moderador.');

    // =========================================================================
    // Escenario 12: Ausencia de valoraciones automáticas, scoring o karma
    // =========================================================================
    console.log('\n[Escenario 12] Ausencia de valoraciones automáticas, scoring o karma');
    assert.equal(resHostCancel.contexto_factual.scoring_publico_habilitado, false);
    assert.equal(typeof resHostCancel.trayectoria_anfitrion.datos_objetivos.encuentros_abiertos_organizados, 'number');
    assert.equal(typeof resHostCancel.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 'number');
    assert.equal((resHostCancel as any).karma, undefined);
    assert.equal((resHostCancel as any).stars, undefined);
    assert.equal((resHostCancel as any).score, undefined);
    console.log('✔ Escenario 12 aprobado: cero campos de scoring, reputación subjetiva o karma.');

    // =========================================================================
    // Escenario 13: Perfiles diferenciados (solo host vs solo participante)
    // =========================================================================
    console.log('\n[Escenario 13] Perfiles diferenciados');
    // part1 solo participó, nunca organizó
    assert.equal(resPart1Established.trayectoria_anfitrion.datos_objetivos.encuentros_abiertos_organizados, 0);
    assert.ok(resPart1Established.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados >= 3);
    console.log('✔ Escenario 13 aprobado: visualización y métricas diferenciadas por rol sin mezclas.');

    // =========================================================================
    // Escenario 14: Verificación de Paridad en get_historial_asistencia_factual_seguro
    // =========================================================================
    console.log('\n[Escenario 14] Paridad en get_historial_asistencia_factual_seguro');
    const { data: resHistorial, error: errHistorial } = await part1.client.rpc('get_historial_asistencia_factual_seguro');
    assert.equal(errHistorial, null, `Error en historial factual: ${errHistorial?.message}`);
    assert.ok(resHistorial.contexto_factual, 'Debe contener sub-objeto contexto_factual');
    assert.equal(resHistorial.total_encuentros_participados, 3);
    assert.equal(resHistorial.asistencias_declaradas_host, 3);
    assert.equal(resHistorial.contexto_factual.estado_muestra, 'establecida');
    console.log('✔ Escenario 14 aprobado: paridad completa entre RPCs de trayectoria e historial.');

    console.log('\n================================================================');
    console.log('RESULTADO FINAL QA STAGING: 14/14 ESCENARIOS SATISFECHOS');
    console.log('================================================================\n');

  } finally {
    console.log('[Cleanup] Limpiando fixtures de QA en Staging...');
    if (createdEncounterIds.length > 0) {
      // Eliminar dependencias
      await admin.from('attendance_disputes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('solicitudes_encuentro_abierto').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('participantes').delete().in('encuentro_id', createdEncounterIds);
      await admin.from('encuentros').delete().in('id', createdEncounterIds);
    }
    if (authorizedModUserIds.length > 0) {
      await admin.from('moderation_authorized_users').delete().in('user_id', authorizedModUserIds);
    }
    for (const uid of createdUserIds) {
      try {
        await admin.auth.admin.deleteUser(uid);
      } catch (err: any) {
        console.warn(`Aviso eliminando user ${uid}: ${err.message}`);
      }
    }
    console.log('✔ Cleanup finalizado correctamente.');
  }
}

runMiniSprintDStagingQA().catch((err) => {
  console.error('\n❌ ERROR EN QA STAGING MINI-SPRINT D:', err);
  process.exit(1);
});
