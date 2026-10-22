/**
 * Verification Script: V1 Privacy and Logistics by Encounter Type
 * Target: wougfhfwqgmxhgvjqoua (Staging)
 * Tests all 10 matrix points against the deployed database.
 */

import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard.ts';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
assertStagingEnvironment(url);

const secretKey = getStagingSecretKey();
const publishableKey = getStagingPublishableKey();

// Admin client for test fixture setup & cleanup
const admin = createClient(url, secretKey, { auth: { persistSession: false } });

// Anon client for public RPC invocation (unauthenticated guest/visitor)
const anon = createClient(url, publishableKey, { auth: { persistSession: false } });

async function runVerification() {
  console.log('================================================================');
  console.log('FASE C: VERIFICACIÓN TÉCNICA DE REGLAS DE PRIVACIDAD V1 EN STAGING');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('================================================================\n');

  const runId = `VERIF-V1-${Date.now()}`;
  const createdEncounterIds: string[] = [];
  const matrixResults: { point: number; title: string; ok: boolean; details: any }[] = [];

  try {
    // 0. Crear un usuario host de prueba en auth.users si no hay uno
    const { data: hostUser, error: hostUserErr } = await admin.auth.admin.createUser({
      email: `${runId.toLowerCase()}@test-qa-staging.local`,
      password: 'TestPassword123!',
      email_confirm: true,
    });
    if (hostUserErr || !hostUser?.user) {
      throw new Error(`Error creando host de prueba: ${hostUserErr?.message}`);
    }
    const hostId = hostUser.user.id;

    // Helper para crear encuentros
    async function createEncounter(params: {
      titulo: string;
      modalidad: 'presencial' | 'virtual';
      lugar_texto?: string | null;
      link_virtual?: string | null;
      is_open?: boolean;
      open_public_zone?: string | null;
      open_public_title?: string | null;
      estado?: string;
    }) {
      const { data, error } = await admin.from('encuentros').insert({
        host_id: hostId,
        titulo: params.titulo,
        descripcion: 'Descripción de prueba para verificación técnica V1',
        fecha: '2026-11-20',
        hora: '19:00',
        modalidad: params.modalidad,
        tipo_invitacion: 'individual',
        lugar_texto: params.lugar_texto || null,
        link_virtual: params.link_virtual || null,
        is_open: params.is_open ?? false,
        open_public_zone: params.open_public_zone || null,
        open_public_title: params.open_public_title || null,
        max_participants: params.is_open ? 5 : null,
        locality_id: params.is_open ? 'centro' : null,
        moderation_status: params.is_open ? 'approved' : 'draft',
        opened_at: params.is_open ? new Date().toISOString() : null,
        estado: params.estado || 'activo',
      }).select().single();

      if (error || !data) throw new Error(`Error creando encuentro: ${error?.message}`);
      createdEncounterIds.push(data.id);
      return data;
    }

    // Helper para crear participantes
    async function createParticipant(params: {
      encuentro_id: string;
      nombre: string;
      estado: 'pendiente' | 'confirmado' | 'rechazado' | 'cancelado' | 'asistio';
      userId?: string | null;
    }) {
      const generatedToken = crypto.randomUUID();
      const { data, error } = await admin.from('participantes').insert({
        encuentro_id: params.encuentro_id,
        nombre_invitado: params.nombre,
        tipo_invitacion: 'individual',
        token_invitacion: generatedToken,
        estado: params.estado,
        user_id: params.userId || null,
      }).select().single();

      if (error || !data) throw new Error(`Error creando participante: ${error?.message}`);
      return data;
    }

    console.log('--- Configurando fixtures de prueba ---');

    // Fixture 1: Encuentro privado presencial
    const privPres = await createEncounter({
      titulo: `${runId} Privado Presencial`,
      modalidad: 'presencial',
      lugar_texto: 'Calle Falsa 123, Depto 4B',
      is_open: false,
    });
    const partPrivPending = await createParticipant({
      encuentro_id: privPres.id,
      nombre: 'Invitado Pendiente Privado',
      estado: 'pendiente',
    });
    const partPrivConfirmed = await createParticipant({
      encuentro_id: privPres.id,
      nombre: 'Invitado Confirmado Privado',
      estado: 'confirmado',
    });
    const partPrivRejected = await createParticipant({
      encuentro_id: privPres.id,
      nombre: 'Invitado Rechazado Privado',
      estado: 'rechazado',
    });
    const partPrivCancelled = await createParticipant({
      encuentro_id: privPres.id,
      nombre: 'Invitado Cancelado Privado',
      estado: 'cancelado',
    });

    // Fixture 2: Encuentro cancelado presencial
    const cancPres = await createEncounter({
      titulo: `${runId} Cancelado Presencial`,
      modalidad: 'presencial',
      lugar_texto: 'Av. Siempre Viva 742',
      is_open: false,
      estado: 'cancelado',
    });
    const partCancConf = await createParticipant({
      encuentro_id: cancPres.id,
      nombre: 'Invitado en Encuentro Cancelado',
      estado: 'confirmado',
    });

    // Fixture 3: Encuentro abierto presencial
    const openPres = await createEncounter({
      titulo: `${runId} Privado Detalle Abierto`,
      modalidad: 'presencial',
      lugar_texto: 'Pasaje Secreto 999 (Privado)',
      is_open: true,
      open_public_title: `${runId} Título Público Abierto`,
      open_public_zone: 'Palermo Soho',
    });
    const partOpenPending = await createParticipant({
      encuentro_id: openPres.id,
      nombre: 'Postulante Pendiente Abierto',
      estado: 'pendiente',
    });
    const partOpenConfirmed = await createParticipant({
      encuentro_id: openPres.id,
      nombre: 'Participante Aprobado Abierto',
      estado: 'confirmado',
    });

    // Fixture 4: Encuentro privado virtual
    const privVirt = await createEncounter({
      titulo: `${runId} Privado Virtual`,
      modalidad: 'virtual',
      link_virtual: 'https://meet.jit.si/puntoencuentro-secret-virtual-call',
      is_open: false,
    });
    const partVirtPending = await createParticipant({
      encuentro_id: privVirt.id,
      nombre: 'Invitado Virtual Pendiente',
      estado: 'pendiente',
    });
    const partVirtConfirmed = await createParticipant({
      encuentro_id: privVirt.id,
      nombre: 'Invitado Virtual Confirmado',
      estado: 'confirmado',
    });

    console.log('Fixtures creados exitosamente.\n');

    // -------------------------------------------------------------
    // PRUEBA 1: Invitación privada individual pendiente
    // Regla 1: Visualizar dirección presencial al abrir el enlace sin exigir confirmación previa.
    // -------------------------------------------------------------
    {
      const { data, error } = await anon.rpc('get_participante_seguro', {
        p_token: partPrivPending.token_invitacion,
      });
      const ok = !error && data?.encuentros?.lugar_texto === 'Calle Falsa 123, Depto 4B' && data?.encuentros?.link_virtual === null;
      matrixResults.push({
        point: 1,
        title: 'Invitación privada individual pendiente',
        ok,
        details: { estado: data?.estado, lugar_texto: data?.encuentros?.lugar_texto, link_virtual: data?.encuentros?.link_virtual },
      });
      console.log(`[PUNTO 1] Invitación privada individual pendiente: ${ok ? 'OK' : 'FAIL'} -> lugar_texto="${data?.encuentros?.lugar_texto}"`);
    }

    // -------------------------------------------------------------
    // PRUEBA 2: Invitación privada general antes de responder
    // Regla 2: Visualizar dirección presencial al abrir enlace general sin exigir confirmación.
    // -------------------------------------------------------------
    {
      const { data, error } = await anon.rpc('get_encuentro_por_public_token', {
        p_public_token: privPres.public_token,
      });
      const ok = !error && data?.lugar_texto === 'Calle Falsa 123, Depto 4B';
      matrixResults.push({
        point: 2,
        title: 'Invitación privada general antes de responder',
        ok,
        details: { is_open: data?.is_open, lugar_texto: data?.lugar_texto },
      });
      console.log(`[PUNTO 2] Invitación privada general antes de responder: ${ok ? 'OK' : 'FAIL'} -> lugar_texto="${data?.lugar_texto}"`);
    }

    // -------------------------------------------------------------
    // PRUEBA 3: Invitación privada individual confirmada
    // -------------------------------------------------------------
    {
      const { data, error } = await anon.rpc('get_participante_seguro', {
        p_token: partPrivConfirmed.token_invitacion,
      });
      const ok = !error && data?.encuentros?.lugar_texto === 'Calle Falsa 123, Depto 4B';
      matrixResults.push({
        point: 3,
        title: 'Invitación privada individual confirmada',
        ok,
        details: { estado: data?.estado, lugar_texto: data?.encuentros?.lugar_texto },
      });
      console.log(`[PUNTO 3] Invitación privada individual confirmada: ${ok ? 'OK' : 'FAIL'} -> lugar_texto="${data?.encuentros?.lugar_texto}"`);
    }

    // -------------------------------------------------------------
    // PRUEBA 4: Invitación rechazada o cancelada
    // Regla 5: Jamás exponer logística privada a rechazados o cancelados.
    // -------------------------------------------------------------
    {
      const { data: dRech } = await anon.rpc('get_participante_seguro', { p_token: partPrivRejected.token_invitacion });
      const { data: dCanc } = await anon.rpc('get_participante_seguro', { p_token: partPrivCancelled.token_invitacion });
      const ok = dRech?.encuentros?.lugar_texto === null && dCanc?.encuentros?.lugar_texto === null &&
                 dRech?.encuentros?.link_virtual === null && dCanc?.encuentros?.link_virtual === null;
      matrixResults.push({
        point: 4,
        title: 'Invitación rechazada o cancelada',
        ok,
        details: { rech_lugar: dRech?.encuentros?.lugar_texto, canc_lugar: dCanc?.encuentros?.lugar_texto },
      });
      console.log(`[PUNTO 4] Invitación rechazada o cancelada: ${ok ? 'OK' : 'FAIL'} -> rech_lugar=${dRech?.encuentros?.lugar_texto}, canc_lugar=${dCanc?.encuentros?.lugar_texto}`);
    }

    // -------------------------------------------------------------
    // PRUEBA 5: Encuentro cancelado
    // Regla 5: Jamás exponer logística privada en encuentros inactivos/cancelados.
    // -------------------------------------------------------------
    {
      const { data: dPartCanc } = await anon.rpc('get_participante_seguro', { p_token: partCancConf.token_invitacion });
      const { data: dPubCanc } = await anon.rpc('get_encuentro_por_public_token', { p_public_token: cancPres.public_token });
      const ok = dPartCanc?.encuentros?.lugar_texto === null && dPubCanc === null;
      matrixResults.push({
        point: 5,
        title: 'Encuentro cancelado',
        ok,
        details: { participante_seguro_lugar: dPartCanc?.encuentros?.lugar_texto, rpc_public_token: dPubCanc },
      });
      console.log(`[PUNTO 5] Encuentro cancelado: ${ok ? 'OK' : 'FAIL'} -> part_lugar=${dPartCanc?.encuentros?.lugar_texto}, pub_result=${dPubCanc}`);
    }

    // -------------------------------------------------------------
    // PRUEBA 6: Encuentro abierto en Discovery
    // Regla 3: Discovery solo expone zona pública aproximada, nunca lugar_texto.
    // -------------------------------------------------------------
    {
      const { data, error } = await anon.rpc('get_discovery_encuentros_abiertos', {
        p_locality_ids: ['centro'],
        p_only_available: false,
      });
      const encInDiscovery = (data || []).find((e: any) => e.id === openPres.id);
      const hasLugarTexto = encInDiscovery && ('lugar_texto' in encInDiscovery && encInDiscovery.lugar_texto !== null);
      const hasPublicZone = encInDiscovery && (encInDiscovery.open_public_zone === 'Palermo Soho' || encInDiscovery.approximate_zone === 'Palermo Soho');
      const ok = !error && Boolean(encInDiscovery) && !hasLugarTexto && hasPublicZone;
      matrixResults.push({
        point: 6,
        title: 'Encuentro abierto en Discovery',
        ok,
        details: { found: Boolean(encInDiscovery), open_public_zone: encInDiscovery?.open_public_zone, hasLugarTexto },
      });
      console.log(`[PUNTO 6] Encuentro abierto en Discovery: ${ok ? 'OK' : 'FAIL'} -> hasLugarTexto=${hasLugarTexto}, zone=${encInDiscovery?.open_public_zone}`);
    }

    // -------------------------------------------------------------
    // PRUEBA 7: Encuentro abierto para postulante pendiente / público
    // Regla 3: Postulantes pendientes y visitantes solo acceden a open_public_zone; lugar_texto = NULL.
    // -------------------------------------------------------------
    {
      const { data: dPub } = await anon.rpc('get_encuentro_por_public_token', { p_public_token: openPres.public_token });
      const { data: dPart } = await anon.rpc('get_participante_seguro', { p_token: partOpenPending.token_invitacion });
      const ok = dPub?.lugar_texto === null && dPub?.open_public_zone === 'Palermo Soho' &&
                 dPart?.encuentros?.lugar_texto === null && dPart?.encuentros?.open_public_zone === 'Palermo Soho';
      matrixResults.push({
        point: 7,
        title: 'Encuentro abierto para postulante pendiente / público',
        ok,
        details: { pub_lugar: dPub?.lugar_texto, pub_zone: dPub?.open_public_zone, part_lugar: dPart?.encuentros?.lugar_texto, part_zone: dPart?.encuentros?.open_public_zone },
      });
      console.log(`[PUNTO 7] Encuentro abierto para postulante pendiente / público: ${ok ? 'OK' : 'FAIL'} -> pub_lugar=${dPub?.lugar_texto}, part_lugar=${dPart?.encuentros?.lugar_texto}`);
    }

    // -------------------------------------------------------------
    // PRUEBA 8: Encuentro abierto para participante aprobado
    // Regla 3: Aprobados / confirmados SÍ acceden a lugar_texto.
    // -------------------------------------------------------------
    {
      const { data: dPart } = await anon.rpc('get_participante_seguro', { p_token: partOpenConfirmed.token_invitacion });
      const ok = dPart?.encuentros?.lugar_texto === 'Pasaje Secreto 999 (Privado)';
      matrixResults.push({
        point: 8,
        title: 'Encuentro abierto para participante aprobado',
        ok,
        details: { estado: dPart?.estado, lugar_texto: dPart?.encuentros?.lugar_texto },
      });
      console.log(`[PUNTO 8] Encuentro abierto para participante aprobado: ${ok ? 'OK' : 'FAIL'} -> lugar_texto="${dPart?.encuentros?.lugar_texto}"`);
    }

    // -------------------------------------------------------------
    // PRUEBA 9: Encuentros virtuales privados: pendiente vs. confirmado
    // Regla 4: Control estricto de confirmación previa para link_virtual.
    // -------------------------------------------------------------
    {
      const { data: dVirtPend } = await anon.rpc('get_participante_seguro', { p_token: partVirtPending.token_invitacion });
      const { data: dVirtConf } = await anon.rpc('get_participante_seguro', { p_token: partVirtConfirmed.token_invitacion });
      const ok = dVirtPend?.encuentros?.link_virtual === null &&
                 dVirtConf?.encuentros?.link_virtual === 'https://meet.jit.si/puntoencuentro-secret-virtual-call';
      matrixResults.push({
        point: 9,
        title: 'Encuentros virtuales privados: pendiente vs. confirmado',
        ok,
        details: { pend_link: dVirtPend?.encuentros?.link_virtual, conf_link: dVirtConf?.encuentros?.link_virtual },
      });
      console.log(`[PUNTO 9] Encuentros virtuales privados: ${ok ? 'OK' : 'FAIL'} -> pend_link=${dVirtPend?.encuentros?.link_virtual}, conf_link=${dVirtConf?.encuentros?.link_virtual}`);
    }

    // -------------------------------------------------------------
    // PRUEBA 10: Comprobación de que ninguna ruta alternativa expone dirección exacta en encuentros abiertos
    // -------------------------------------------------------------
    {
      // A) RLS directa como anon en tabla encuentros
      const { data: dRls } = await anon.from('encuentros').select('id, titulo, lugar_texto').eq('id', openPres.id);
      // RLS restringe o filtra lugar_texto si no es host
      const rlsLeaked = dRls && dRls.length > 0 && dRls[0].lugar_texto !== null;

      // B) RPC get_encuentro_participante_autorizado sin auth
      const { data: dAutorizadoAnon, error: errAuth } = await anon.rpc('get_encuentro_participante_autorizado', {
        p_encuentro_id: openPres.id,
      });
      const autorizadoLeaked = Boolean(dAutorizadoAnon && dAutorizadoAnon.lugar_texto);

      const ok = !rlsLeaked && !autorizadoLeaked;
      matrixResults.push({
        point: 10,
        title: 'Comprobación de que ninguna ruta alternativa expone dirección exacta en abiertos',
        ok,
        details: { rlsLeaked, autorizadoLeaked, dRls, dAutorizadoAnon, errAuth: errAuth?.message },
      });
      console.log(`[PUNTO 10] Sin fuga en rutas alternativas: ${ok ? 'OK' : 'FAIL'} -> rlsLeaked=${rlsLeaked}, authLeaked=${autorizadoLeaked}`);
    }

  } finally {
    console.log('\n--- Limpieza de fixtures de prueba ---');
    for (const encId of createdEncounterIds) {
      await admin.from('participantes').delete().eq('encuentro_id', encId);
      await admin.from('encuentros').delete().eq('id', encId);
    }
    console.log(`Limpieza completada (${createdEncounterIds.length} encuentros removidos).`);
    console.log('NOTA: Los registros del piloto E2E-001 (ad72c95d-ddb2-4438-9731-5af91e188345) fueron conservados intactos.');
  }

  console.log('\n================================================================');
  console.log('RESUMEN DE LA MATRIZ DE VERIFICACIÓN (10/10):');
  console.log('================================================================');
  let allPassed = true;
  for (const m of matrixResults) {
    const status = m.ok ? 'CUMPLE' : 'NO CUMPLE';
    if (!m.ok) allPassed = false;
    console.log(`[${status}] Punto ${m.point}: ${m.title}`);
  }
  console.log(`Resultado global: ${allPassed ? 'TODOS LOS CRITERIOS SATISFECHOS' : 'FALLAS DETECTADAS'}`);
}

runVerification().catch((err) => {
  console.error('Fatal error en verificación:', err);
  process.exit(1);
});
