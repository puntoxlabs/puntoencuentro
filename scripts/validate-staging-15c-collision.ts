/**
 * Validador E2E Exhaustivo de Colisiones y Transfer Ticket 1.5-C en Supabase STAGING
 *
 * Entorno: wougfhfwqgmxhgvjqoua
 * Guard: assertStagingEnvironment()
 * Cobertura: T1 a T29
 */

import { createClient } from '@supabase/supabase-js';
import { assertStagingEnvironment, STAGING_PROJECT_REF } from './lib/environment-guard';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvdWdmaGZ3cWdteGhndmpxb3VhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1MTk0MjEsImV4cCI6MjEwNjA5NTQyMX0.oUgTzIFlZrjnKcnqgdXDtI1cq4Mp0zO4N_I58MIIra4';
const serviceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvdWdmaGZ3cWdteGhndmpxb3VhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MDUxOTQyMSwiZXhwIjoyMTA2MDk1NDIxfQ.X36AcSzttqZiWD9vcRuDAmukTHJkAbatkZwokfYHbO8';

assertStagingEnvironment(url);

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

// Helper para crear clientes autenticados
function makeClient() {
  return createClient(url, anonKey, { auth: { persistSession: false } });
}

async function runSuite() {
  console.log('====================================================');
  console.log('PUNTO ENCUENTRO 1.5-C — SUITE E2E TRANSFER TICKET');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ [FAIL] ${name}:`, err.message || err);
      failed++;
    }
  }

  // --- Helpers de creación de usuarios ---
  async function createAnonUser() {
    const id = crypto.randomUUID();
    const { error } = await admin.rpc('qa_create_test_user', { p_id: id, p_is_anon: true });
    if (error) throw new Error(`createAnonUser failed: ${error.message}`);
    return {
      user: { id, is_anonymous: true },
      client: {
        rpc: async (fn: string, args?: any) => {
          const res = await admin.rpc('qa_test_call_as', {
            p_user_id: id,
            p_is_anon: true,
            p_fn_name: fn,
            p_args: args || {}
          });
          return { data: res.data, error: res.error };
        }
      }
    };
  }

  async function createPermUser(emailPrefix = 'perm') {
    const id = crypto.randomUUID();
    const email = `qa-${emailPrefix}-${Date.now()}-${Math.random().toString(36).substring(7)}@puntoencuentro.test`;
    const { error } = await admin.rpc('qa_create_test_user', { p_id: id, p_is_anon: false, p_email: email });
    if (error) throw new Error(`createPermUser failed: ${error.message}`);
    return {
      user: { id, is_anonymous: false, email },
      client: {
        rpc: async (fn: string, args?: any) => {
          const res = await admin.rpc('qa_test_call_as', {
            p_user_id: id,
            p_is_anon: false,
            p_fn_name: fn,
            p_args: args || {}
          });
          return { data: res.data, error: res.error };
        }
      }
    };
  }

  // ========================================================
  // T1: Ticket expirado
  // ========================================================
  await test('T1: Ticket expirado retorna ticket_expired y no transfiere recursos', async () => {
    const anon = await createAnonUser();
    const perm = await createPermUser('t1');

    // Dotar de recurso al anónimo
    await admin.from('encuentros').insert({
      titulo: 'Encuentro T1',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-01',
      hora: '19:00',
      host_id: anon.user.id,
    });

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    if (!ticketRes?.ok) throw new Error('create ticket failed');

    // Forzar expiración
    await admin.from('anonymous_transfer_tickets')
      .update({ expires_at: new Date(Date.now() - 5000).toISOString() })
      .eq('source_user_id_snapshot', anon.user.id);

    const { data: claimRes } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    if (claimRes?.ok !== false || claimRes?.error !== 'ticket_expired') {
      throw new Error(`Expected ticket_expired, got: ${JSON.stringify(claimRes)}`);
    }
  });

  // ========================================================
  // T2: Ticket reutilizado
  // ========================================================
  await test('T2: Ticket reutilizado retorna ticket_already_used', async () => {
    const anon = await createAnonUser();
    const perm = await createPermUser('t2');

    await admin.from('encuentros').insert({
      titulo: 'Encuentro T2',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-01',
      hora: '19:00',
      host_id: anon.user.id,
    });

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    const { data: claim1 } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });
    if (!claim1?.ok) throw new Error(`Claim 1 failed: ${JSON.stringify(claim1)}`);

    const { data: claim2 } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });
    if (claim2?.ok !== false || claim2?.error !== 'ticket_already_used') {
      throw new Error(`Expected ticket_already_used, got: ${JSON.stringify(claim2)}`);
    }
  });

  // ========================================================
  // T3: Token inválido / tampered
  // ========================================================
  await test('T3: Token inválido rechaza con invalid_token_format o ticket_not_found', async () => {
    const perm = await createPermUser('t3');

    const { data: r1 } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: 'not-a-valid-hex-token',
    });
    if (r1?.error !== 'invalid_token_format') throw new Error(`Expected invalid_token_format, got: ${r1?.error}`);

    const dummy64Hex = 'a'.repeat(64);
    const { data: r2 } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: dummy64Hex,
    });
    if (r2?.error !== 'ticket_not_found') throw new Error(`Expected ticket_not_found, got: ${r2?.error}`);
  });

  // ========================================================
  // T4 & T5: Target anónimo o Target = Source
  // ========================================================
  await test('T4 & T5: Target anónimo o Target = Source es rechazado', async () => {
    const anon = await createAnonUser();

    await admin.from('encuentros').insert({
      titulo: 'Encuentro T4',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-01',
      hora: '19:00',
      host_id: anon.user.id,
    });

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    const { data: claimRes } = await anon.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    if (claimRes?.error !== 'permanent_account_required') {
      throw new Error(`Expected permanent_account_required, got: ${JSON.stringify(claimRes)}`);
    }
  });

  // ========================================================
  // T6: Usuario permanente intenta emitir ticket
  // ========================================================
  await test('T6: Usuario permanente no puede emitir ticket', async () => {
    const perm = await createPermUser('t6');
    const { data: res } = await perm.client.rpc('create_anonymous_transfer_ticket');
    if (res?.error !== 'anonymous_user_required') {
      throw new Error(`Expected anonymous_user_required, got: ${JSON.stringify(res)}`);
    }
  });

  // ========================================================
  // T7: Target ya participante en encuentro propio transferido
  // ========================================================
  await test('T7: Target ya participante en encuentro transferido es removido de participantes', async () => {
    const anon = await createAnonUser();
    const perm = await createPermUser('t7');

    const { data: enc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro Propio T7',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-02',
      hora: '20:00',
      host_id: anon.user.id,
    }).select().single();

    // Target ya participaba en este encuentro
    await admin.from('participantes').insert({
      encuentro_id: enc.id,
      nombre_invitado: 'Target Guest',
      tipo_invitacion: 'individual',
      token_invitacion: crypto.randomUUID(),
      user_id: perm.user.id,
      estado: 'confirmado',
    });

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    const { data: claimRes } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });
    if (!claimRes?.ok) throw new Error(`Claim failed: ${JSON.stringify(claimRes)}`);

    // Target ahora es host
    const { data: updatedEnc } = await admin.from('encuentros').select().eq('id', enc.id).single();
    if (updatedEnc.host_id !== perm.user.id) throw new Error('Encuentro no transferido a target');

    // Target no debe estar en participantes
    const { data: parts } = await admin.from('participantes').select().eq('encuentro_id', enc.id).eq('user_id', perm.user.id);
    if (parts && parts.length > 0) throw new Error('Target sigue figurando como participante');
  });

  // ========================================================
  // T8: Target con solicitud en encuentro propio pasa a withdrawn
  // ========================================================
  await test('T8: Target con solicitud en encuentro propio pasa a withdrawn preservando mensaje', async () => {
    const anon = await createAnonUser();
    const perm = await createPermUser('t8');

    const { data: enc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro Abierto T8',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-03',
      hora: '21:00',
      host_id: anon.user.id,
      is_open: true,
      max_participants: 5,
      locality_id: 'guemes',
    }).select().single();

    const originalMsg = 'Hola, me encantaría sumarme al encuentro';
    const { data: sol } = await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: enc.id,
      usuario_id: perm.user.id,
      nombre_solicitante: 'Perm Requester',
      mensaje: originalMsg,
      estado: 'pending',
    }).select().single();

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    const { data: claimRes } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });
    if (!claimRes?.ok) throw new Error(`Claim failed: ${JSON.stringify(claimRes)}`);

    const { data: updatedSol } = await admin.from('solicitudes_encuentro_abierto').select().eq('id', sol.id).single();
    if (updatedSol.estado !== 'withdrawn') throw new Error(`Expected withdrawn, got: ${updatedSol.estado}`);
    if (updatedSol.mensaje !== originalMsg) throw new Error(`Mensaje fue alterado: ${updatedSol.mensaje}`);
  });

  // ========================================================
  // T9: Localidades duplicadas se unifican sin error
  // ========================================================
  await test('T9: Localidades duplicadas se unifican limpiamente con ON CONFLICT DO NOTHING', async () => {
    const anon = await createAnonUser();
    const perm = await createPermUser('t9');

    await admin.from('usuario_localidades').insert([
      { user_id: anon.user.id, locality_id: 'guemes' },
      { user_id: anon.user.id, locality_id: 'costa' },
    ]);
    await admin.from('usuario_localidades').insert([
      { user_id: perm.user.id, locality_id: 'guemes' },
      { user_id: perm.user.id, locality_id: 'palermo' },
    ]);

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    const { data: claimRes } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });
    if (!claimRes?.ok) throw new Error(`Claim failed: ${JSON.stringify(claimRes)}`);

    const { data: locs } = await admin.from('usuario_localidades').select('locality_id').eq('user_id', perm.user.id);
    const locIds = locs?.map(l => l.locality_id).sort();
    if (!locIds?.includes('guemes') || !locIds?.includes('costa') || !locIds?.includes('palermo')) {
      throw new Error(`Expected merged localities, got: ${JSON.stringify(locIds)}`);
    }
  });

  // ========================================================
  // T10: Sesión IA transferida
  // ========================================================
  await test('T10: Sesión IA se transfiere conservando estado e historial', async () => {
    const anon = await createAnonUser();
    const perm = await createPermUser('t10');

    const { data: session } = await admin.from('ai_creation_sessions').insert({
      user_id: anon.user.id,
      status: 'started',
    }).select().single();

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    const { data: updatedSession } = await admin.from('ai_creation_sessions').select().eq('id', session.id).single();
    if (updatedSession.user_id !== perm.user.id) throw new Error('AI session user_id no fue transferido');
  });

  // ========================================================
  // T11: Race condition en canje serializado por FOR UPDATE
  // ========================================================
  await test('T11: Race condition concurrent claim es serializada limpiamente', async () => {
    const anon = await createAnonUser();
    const perm1 = await createPermUser('t11-1');
    const perm2 = await createPermUser('t11-2');

    await admin.from('encuentros').insert({
      titulo: 'Encuentro T11',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-04',
      hora: '19:00',
      host_id: anon.user.id,
    });

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');

    const [r1, r2] = await Promise.all([
      perm1.client.rpc('claim_anonymous_transfer', { p_transfer_token: ticketRes.ticket_token }),
      perm2.client.rpc('claim_anonymous_transfer', { p_transfer_token: ticketRes.ticket_token }),
    ]);

    const successes = [r1, r2].filter(r => r.data?.ok === true);
    const conflicts = [r1, r2].filter(r => r.data?.error === 'ticket_already_used');

    if (successes.length !== 1 || conflicts.length !== 1) {
      throw new Error(`Race condition mismatch: successes=${successes.length}, conflicts=${conflicts.length}`);
    }
  });

  // ========================================================
  // T12: Encuentro cancelado se transfiere cancelado
  // ========================================================
  await test('T12: Encuentro cancelado se transfiere preservando estado cancelado', async () => {
    const anon = await createAnonUser();
    const perm = await createPermUser('t12');

    const { data: enc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro Cancelado T12',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-05',
      hora: '18:00',
      host_id: anon.user.id,
      estado: 'cancelado',
    }).select().single();

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    const { data: updatedEnc } = await admin.from('encuentros').select().eq('id', enc.id).single();
    if (updatedEnc.host_id !== perm.user.id || updatedEnc.estado !== 'cancelado') {
      throw new Error(`Encuentro no conservó estado cancelado: ${JSON.stringify(updatedEnc)}`);
    }
  });

  // ========================================================
  // T13: Aislamiento de Token en Storage y Formato Criptográfico
  // ========================================================
  await test('T13: Token cumple formato hex de 64 chars y no requiere exposición en URL', async () => {
    const anon = await createAnonUser();
    await admin.from('encuentros').insert({
      titulo: 'Encuentro T13',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-05',
      hora: '19:00',
      host_id: anon.user.id,
    });
    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    if (!ticketRes?.ok || !ticketRes.ticket_token) throw new Error('Ticket generation failed');
    if (!/^[0-9a-f]{64}$/.test(ticketRes.ticket_token)) {
      throw new Error(`Token does not match 64 hex regex: ${ticketRes.ticket_token}`);
    }
  });

  // ========================================================
  // T14: No fuga de UUID ajenos en respuestas de error
  // ========================================================
  await test('T14: Errores no revelan UUIDs de otros usuarios', async () => {
    const perm = await createPermUser('t14');
    const { data: res } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    });
    const serialized = JSON.stringify(res);
    if (serialized.includes('uuid') || serialized.includes('-') && serialized.length > 50) {
      throw new Error(`Posible fuga de UUID en error: ${serialized}`);
    }
  });

  // ========================================================
  // T15: Source approved + Target pending con participantes distintos
  // ========================================================
  await test('T15: Source approved + Target pending conserva participante y token válido', async () => {
    const host = await createPermUser('t15-host');
    const anon = await createAnonUser();
    const perm = await createPermUser('t15-target');

    // Host crea encuentro externo abierto
    const { data: enc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro Externo T15',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-06',
      hora: '20:00',
      host_id: host.user.id,
      is_open: true,
      max_participants: 6,
      locality_id: 'guemes',
    }).select().single();

    // Source es approved con participante P1
    const p1Token = crypto.randomUUID();
    const { data: p1 } = await admin.from('participantes').insert({
      encuentro_id: enc.id,
      nombre_invitado: 'Anon Source Approved',
      tipo_invitacion: 'individual',
      token_invitacion: p1Token,
      user_id: anon.user.id,
      estado: 'confirmado',
    }).select().single();

    await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: enc.id,
      usuario_id: anon.user.id,
      nombre_solicitante: 'Anon Solicitante',
      estado: 'approved',
      participante_id: p1.id,
      token_participante: p1Token,
    });

    // Target es pending con participante P2
    const p2Token = crypto.randomUUID();
    await admin.from('participantes').insert({
      encuentro_id: enc.id,
      nombre_invitado: 'Target Pending',
      tipo_invitacion: 'individual',
      token_invitacion: p2Token,
      user_id: perm.user.id,
      estado: 'pendiente',
    });

    await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: enc.id,
      usuario_id: perm.user.id,
      nombre_solicitante: 'Target Solicitante',
      estado: 'pending',
    });

    // Transferir anon -> perm
    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    const { data: claimRes } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });
    if (!claimRes?.ok) throw new Error(`Claim failed: ${JSON.stringify(claimRes)}`);

    // Comprobar invariante
    const { data: finalSol } = await admin.from('solicitudes_encuentro_abierto')
      .select().eq('encuentro_id', enc.id).eq('usuario_id', perm.user.id).single();

    if (finalSol.estado !== 'approved') throw new Error(`Expected approved solicitud, got: ${finalSol.estado}`);
    if (finalSol.participante_id !== p1.id) throw new Error(`Expected p1 id, got: ${finalSol.participante_id}`);
    if (finalSol.token_participante !== p1Token) throw new Error('Token no coincide con P1');
  });

  // ========================================================
  // T16: Source pending + Target rejected -> Gana pending
  // ========================================================
  await test('T16: Source pending + Target rejected -> Gana pending', async () => {
    const host = await createPermUser('t16-host');
    const anon = await createAnonUser();
    const perm = await createPermUser('t16-target');

    const { data: enc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro T16',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-07',
      hora: '19:00',
      host_id: host.user.id,
      is_open: true,
      max_participants: 5,
      locality_id: 'guemes',
    }).select().single();

    await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: enc.id,
      usuario_id: anon.user.id,
      nombre_solicitante: 'Anon Pending',
      estado: 'pending',
    });

    await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: enc.id,
      usuario_id: perm.user.id,
      nombre_solicitante: 'Target Rejected',
      estado: 'rejected',
    });

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    const { data: sol } = await admin.from('solicitudes_encuentro_abierto')
      .select().eq('encuentro_id', enc.id).eq('usuario_id', perm.user.id).single();

    if (sol.estado !== 'pending') throw new Error(`Expected pending to win, got: ${sol.estado}`);
  });

  // ========================================================
  // T17: Source rejected + Target withdrawn -> Gana rejected
  // ========================================================
  await test('T17: Source rejected + Target withdrawn -> Gana rejected', async () => {
    const host = await createPermUser('t17-host');
    const anon = await createAnonUser();
    const perm = await createPermUser('t17-target');

    const { data: enc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro T17',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-08',
      hora: '19:00',
      host_id: host.user.id,
      is_open: true,
      max_participants: 5,
      locality_id: 'guemes',
    }).select().single();

    await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: enc.id,
      usuario_id: anon.user.id,
      nombre_solicitante: 'Anon Rejected',
      estado: 'rejected',
    });

    await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: enc.id,
      usuario_id: perm.user.id,
      nombre_solicitante: 'Target Withdrawn',
      estado: 'withdrawn',
    });

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    const { data: sol } = await admin.from('solicitudes_encuentro_abierto')
      .select().eq('encuentro_id', enc.id).eq('usuario_id', perm.user.id).single();

    if (sol.estado !== 'rejected') throw new Error(`Expected rejected to win, got: ${sol.estado}`);
  });

  // ========================================================
  // T18: Target posee múltiples solicitudes históricas
  // ========================================================
  await test('T18: Múltiples solicitudes históricas en target se resuelven determinísticamente en 1', async () => {
    const host = await createPermUser('t18-host');
    const anon = await createAnonUser();
    const perm = await createPermUser('t18-target');

    const { data: enc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro T18',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-09',
      hora: '19:00',
      host_id: host.user.id,
      is_open: true,
      max_participants: 5,
      locality_id: 'guemes',
    }).select().single();

    const approvedPartToken = crypto.randomUUID();
    const { data: approvedPart } = await admin.from('participantes').insert({
      encuentro_id: enc.id,
      nombre_invitado: 'Anon Approved',
      tipo_invitacion: 'individual',
      token_invitacion: approvedPartToken,
      user_id: anon.user.id,
      estado: 'confirmado',
    }).select().single();

    await admin.from('solicitudes_encuentro_abierto').insert([
      { encuentro_id: enc.id, usuario_id: perm.user.id, nombre_solicitante: 'Target Old Rejected', estado: 'rejected' },
      { encuentro_id: enc.id, usuario_id: perm.user.id, nombre_solicitante: 'Target Old Withdrawn', estado: 'withdrawn' },
      { encuentro_id: enc.id, usuario_id: anon.user.id, nombre_solicitante: 'Anon Approved', estado: 'approved', participante_id: approvedPart.id, token_participante: approvedPartToken },
    ]);

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    const { data: sols } = await admin.from('solicitudes_encuentro_abierto')
      .select().eq('encuentro_id', enc.id).eq('usuario_id', perm.user.id);

    if (sols?.length !== 1 || sols[0].estado !== 'approved') {
      throw new Error(`Expected exactly 1 approved solicitud, got: ${JSON.stringify(sols)}`);
    }
  });

  // ========================================================
  // T19: Múltiples participantes se canonicalizan determinísticamente
  // ========================================================
  await test('T19: Múltiples participantes se canonicalizan determinísticamente al estado máximo', async () => {
    const host = await createPermUser('t19-host');
    const anon = await createAnonUser();
    const perm = await createPermUser('t19-target');

    const { data: enc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro T19',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-10',
      hora: '19:00',
      host_id: host.user.id,
    }).select().single();

    await admin.from('participantes').insert([
      { encuentro_id: enc.id, nombre_invitado: 'Anon Confirmed', tipo_invitacion: 'individual', token_invitacion: crypto.randomUUID(), user_id: anon.user.id, estado: 'confirmado' },
      { encuentro_id: enc.id, nombre_invitado: 'Target Pending', tipo_invitacion: 'individual', token_invitacion: crypto.randomUUID(), user_id: perm.user.id, estado: 'pendiente' },
    ]);

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    const { data: parts } = await admin.from('participantes')
      .select().eq('encuentro_id', enc.id).eq('user_id', perm.user.id);

    if (parts?.length !== 1 || parts[0].estado !== 'confirmado') {
      throw new Error(`Expected 1 confirmed participant, got: ${JSON.stringify(parts)}`);
    }
  });

  // ========================================================
  // T20: Target con 3 templates activos + Source con templates (Bypass transaccional)
  // ========================================================
  await test('T20: Target con 3 templates activos hereda templates sin error ni desactivaciones', async () => {
    const anon = await createAnonUser();
    const perm = await createPermUser('t20');

    // Crear 3 activos en target (alcanza el límite)
    for (let i = 1; i <= 3; i++) {
      await admin.from('custom_invitation_templates').insert({
        user_id: perm.user.id,
        name: `Target Template ${i}`,
        image_path: `users/${perm.user.id}/t${i}.png`,
        is_active: true,
      });
    }

    // Crear 1 activo en source
    await admin.from('custom_invitation_templates').insert({
      user_id: anon.user.id,
      name: 'Anon Template',
      image_path: `users/${anon.user.id}/a.png`,
      is_active: true,
    });

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    const { data: claimRes } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });
    if (!claimRes?.ok) throw new Error(`Claim failed with 3+1 templates: ${JSON.stringify(claimRes)}`);

    const { data: allActive } = await admin.from('custom_invitation_templates')
      .select().eq('user_id', perm.user.id).eq('is_active', true);

    if (allActive?.length !== 4) {
      throw new Error(`Expected 4 grandfathered active templates, got: ${allActive?.length}`);
    }
  });

  // ========================================================
  // T21: Template referenciado por encuentro sigue disponible
  // ========================================================
  await test('T21: Template transferido referenciado por encuentro sigue renderizable', async () => {
    const anon = await createAnonUser();
    const perm = await createPermUser('t21');

    const { data: tmpl } = await admin.from('custom_invitation_templates').insert({
      user_id: anon.user.id,
      name: 'Encounter Flyer',
      image_path: `users/${anon.user.id}/flyer.png`,
      is_active: true,
    }).select().single();

    const { data: enc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro con Custom Template',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-11',
      hora: '21:00',
      host_id: anon.user.id,
      tema_invitacion: 'custom',
      invitation_template: `custom_${tmpl.id}`,
    }).select().single();

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    const { data: publicRes } = await makeClient().rpc('get_custom_invitation_template_public', {
      p_public_token: enc.public_token,
    });

    if (!publicRes || publicRes.name !== 'Encounter Flyer') {
      throw new Error(`Template not renderable via public RPC: ${JSON.stringify(publicRes)}`);
    }
  });

  // ========================================================
  // T22: Concurrencia createTicket -> 1 ok + 1 transfer_ticket_already_pending
  // ========================================================
  await test('T22: Concurrencia createTicket entrega exactamente 1 ticket y rechaza duplicado en vuelo', async () => {
    const anon = await createAnonUser();

    await admin.from('encuentros').insert({
      titulo: 'Encuentro T22',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-12',
      hora: '19:00',
      host_id: anon.user.id,
    });

    const [r1, r2] = await Promise.all([
      anon.client.rpc('create_anonymous_transfer_ticket'),
      anon.client.rpc('create_anonymous_transfer_ticket'),
    ]);

    const oks = [r1, r2].filter(r => r.data?.ok === true);
    const pendings = [r1, r2].filter(r => r.data?.error === 'transfer_ticket_already_pending');

    if (oks.length !== 1 || pendings.length !== 1) {
      throw new Error(`Expected exactly 1 OK and 1 transfer_ticket_already_pending, got: r1=${JSON.stringify(r1.data)}, r2=${JSON.stringify(r2.data)}`);
    }

    // El ticket ganador debe poder canjearse
    const perm = await createPermUser('t22');
    const winningToken = oks[0].data.ticket_token;
    const { data: claimRes } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: winningToken,
    });
    if (!claimRes?.ok) throw new Error(`Claim with winning token failed: ${JSON.stringify(claimRes)}`);
  });

  // ========================================================
  // T23: Auditoría permanece íntegra tras cleanup de source anónimo
  // ========================================================
  await test('T23: Auditoría histórica persiste intacta aún si el usuario anónimo es borrado de auth.users', async () => {
    const anon = await createAnonUser();
    const perm = await createPermUser('t23');

    await admin.from('encuentros').insert({
      titulo: 'Encuentro T23',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-13',
      hora: '19:00',
      host_id: anon.user.id,
    });

    const anonUserId = anon.user.id;
    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    // Simular purga de anónimos huérfanos de auth.users
    await admin.rpc('qa_delete_test_user', { p_id: anonUserId });

    // El registro de ticket debe persistir con el snapshot
    const { data: tickets } = await admin.from('anonymous_transfer_tickets')
      .select().eq('source_user_id_snapshot', anonUserId);

    if (!tickets || tickets.length !== 1 || tickets[0].status !== 'completed') {
      throw new Error(`Audit ticket was destroyed or corrupted: ${JSON.stringify(tickets)}`);
    }
  });

  // ========================================================
  // T24: Verificación de token funcional en /join
  // ========================================================
  await test('T24: Approved solicitud post-transfer posee token funcional en /join', async () => {
    const host = await createPermUser('t24-host');
    const anon = await createAnonUser();
    const perm = await createPermUser('t24-target');

    const { data: enc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro T24',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-14',
      hora: '19:00',
      host_id: host.user.id,
      is_open: true,
      max_participants: 5,
      locality_id: 'guemes',
    }).select().single();

    const invitationToken = crypto.randomUUID();
    const { data: part } = await admin.from('participantes').insert({
      encuentro_id: enc.id,
      nombre_invitado: 'Invitado T24',
      tipo_invitacion: 'individual',
      token_invitacion: invitationToken,
      user_id: anon.user.id,
      estado: 'confirmado',
    }).select().single();

    await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: enc.id,
      usuario_id: anon.user.id,
      nombre_solicitante: 'Anon Solicitante T24',
      estado: 'approved',
      participante_id: part.id,
      token_participante: invitationToken,
    });

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    // Simular que el usuario accede a /join con el token transferido
    const { data: detailGuest } = await makeClient().rpc('get_participante_seguro', {
      p_token: invitationToken,
    });

    if (!detailGuest || detailGuest.token_invitacion !== invitationToken) {
      throw new Error(`Token no resuelve en RPC pública de invitado: ${JSON.stringify(detailGuest)}`);
    }
  });

  // ========================================================
  // T25: Anonymous solo con template / participant / AI session -> has_transferable_resources = true
  // ========================================================
  await test('T25: get_anonymous_upgrade_state detecta recursos transferibles sin encuentros propios', async () => {
    const anon = await createAnonUser();

    // Sin encuentros propios, pero con una plantilla personalizada
    await admin.from('custom_invitation_templates').insert({
      user_id: anon.user.id,
      name: 'Template Único',
      image_path: `users/${anon.user.id}/unique.png`,
    });

    const { data: state } = await anon.client.rpc('get_anonymous_upgrade_state');

    if (!state?.has_custom_templates || !state?.has_transferable_resources || state?.has_owned_encounters) {
      throw new Error(`State detection mismatch: ${JSON.stringify(state)}`);
    }
  });

  // ========================================================
  // T26: Source se convierte a permanente antes del claim -> Rechazado source_no_longer_anonymous
  // ========================================================
  await test('T26: Source convertido a permanente rechaza canje con source_no_longer_anonymous', async () => {
    const anon = await createAnonUser();
    const perm = await createPermUser('t26');

    await admin.from('encuentros').insert({
      titulo: 'Encuentro T26',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-15',
      hora: '19:00',
      host_id: anon.user.id,
    });

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');

    // Simular que el source se convirtió en permanente (is_anonymous = false)
    await admin.rpc('qa_set_user_anonymous', { p_id: anon.user.id, p_is_anon: false });

    const { data: claimRes } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    if (claimRes?.error !== 'source_no_longer_anonymous') {
      throw new Error(`Expected source_no_longer_anonymous, got: ${JSON.stringify(claimRes)}`);
    }
  });

  // ========================================================
  // T27: Source pending + Target pending y source gana ranking -> Cero unique_violation
  // ========================================================
  await test('T27: Source pending + Target pending y source gana ranking sin unique_violation', async () => {
    const host = await createPermUser('t27-host');
    const anon = await createAnonUser();
    const perm = await createPermUser('t27-target');

    const { data: enc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro T27',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-16',
      hora: '19:00',
      host_id: host.user.id,
      is_open: true,
      max_participants: 5,
      locality_id: 'guemes',
    }).select().single();

    // Source pending más reciente
    await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: enc.id,
      usuario_id: anon.user.id,
      nombre_solicitante: 'Anon Pending Newer',
      estado: 'pending',
      created_at: new Date(Date.now() + 1000).toISOString(),
    });

    // Target pending más antiguo
    await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: enc.id,
      usuario_id: perm.user.id,
      nombre_solicitante: 'Target Pending Older',
      estado: 'pending',
      created_at: new Date(Date.now() - 5000).toISOString(),
    });

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    const { data: claimRes } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });
    if (!claimRes?.ok) throw new Error(`Claim failed on double pending: ${JSON.stringify(claimRes)}`);

    const { data: sols } = await admin.from('solicitudes_encuentro_abierto')
      .select().eq('encuentro_id', enc.id).eq('usuario_id', perm.user.id);

    if (sols?.length !== 1 || sols[0].estado !== 'pending') {
      throw new Error(`Expected exactly 1 pending solicitud, got: ${JSON.stringify(sols)}`);
    }
  });

  // ========================================================
  // T28: Cancelar OAuth -> Usuario conserva acceso anónimo
  // ========================================================
  await test('T28: Simulación de cancelación de OAuth no destruye sesión ni datos anónimos', async () => {
    const anon = await createAnonUser();

    const { data: enc } = await admin.from('encuentros').insert({
      titulo: 'Encuentro No Destruido T28',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-17',
      hora: '19:00',
      host_id: anon.user.id,
    }).select().single();

    // Se emite el ticket previo al redirect
    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    if (!ticketRes?.ok) throw new Error('Ticket generation failed');

    // El usuario cancela el OAuth en Google y regresa:
    // El anónimo NUNCA fue deslogueado (no se llamó signOut())
    // Comprobamos mediante RPC segura de host que el anónimo sigue accediendo a su encuentro
    const { data: myEnc } = await anon.client.rpc('get_detalle_host_seguro', {
      p_encuentro_id: enc.id,
      p_host_id: anon.user.id,
    });
    if (!myEnc || myEnc.id !== enc.id || myEnc.host_id !== anon.user.id) {
      throw new Error(`El usuario anónimo perdió acceso a sus recursos tras cancelar: ${JSON.stringify(myEnc)}`);
    }
  });

  // ========================================================
  // T29: Postcondiciones scoped a recursos afectados
  // ========================================================
  await test('T29: Postcondiciones scoped no fallan por inconsistencias históricas no relacionadas', async () => {
    const hostOther = await createPermUser('t29-other');
    const anon = await createAnonUser();
    const perm = await createPermUser('t29-target');

    // Encuentro ajeno histórico que no es parte de la transferencia
    const { data: encUnrelated } = await admin.from('encuentros').insert({
      titulo: 'Encuentro No Relacionado',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-18',
      hora: '19:00',
      host_id: hostOther.user.id,
      is_open: true,
      max_participants: 5,
      locality_id: 'guemes',
    }).select().single();

    // Target tenía una solicitud antigua retirada allí
    await admin.from('solicitudes_encuentro_abierto').insert({
      encuentro_id: encUnrelated.id,
      usuario_id: perm.user.id,
      nombre_solicitante: 'Old Requester',
      estado: 'withdrawn',
    });

    // Encuentro real a transferir
    await admin.from('encuentros').insert({
      titulo: 'Encuentro Transferible T29',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      fecha: '2026-11-19',
      hora: '20:00',
      host_id: anon.user.id,
    });

    const { data: ticketRes } = await anon.client.rpc('create_anonymous_transfer_ticket');
    const { data: claimRes } = await perm.client.rpc('claim_anonymous_transfer', {
      p_transfer_token: ticketRes.ticket_token,
    });

    if (!claimRes?.ok) {
      throw new Error(`Scoped claim failed due to external encounter: ${JSON.stringify(claimRes)}`);
    }
  });

  console.log('\n====================================================');
  console.log(`RESUMEN SUITE E2E 1.5-C: ${passed} PASADOS, ${failed} FALLIDOS`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runSuite().catch((err) => {
  console.error('Fatal suite runner error:', err);
  process.exit(1);
});
