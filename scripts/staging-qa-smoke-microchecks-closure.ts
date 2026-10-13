import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  getStagingSecretKey,
  getStagingPublishableKey,
} from './lib/environment-guard.ts';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
assertStagingEnvironment(url);

const admin = createClient(url, getStagingSecretKey(), { auth: { persistSession: false } });
const publishableKey = getStagingPublishableKey();

async function main() {
  console.log('====================================================');
  console.log('STAGING QA SMOKE: MICROCHECKS A, B Y C CLOSURE TEST');
  console.log('====================================================\n');

  const ts = Date.now();
  const hostEmail = `test-host-closure-${ts}@test.com`;
  const applicantEmail = `test-applicant-closure-${ts}@test.com`;
  const strangerEmail = `test-stranger-closure-${ts}@test.com`;
  const password = 'Password123!SecureClosure';

  let hostId = '';
  let applicantId = '';
  let strangerId = '';
  let encuentroId = '';

  try {
    // 1. Crear usuarios de prueba
    console.log('1. Creando usuarios de prueba en Auth...');
    const { data: hostUser, error: errHost } = await admin.auth.admin.createUser({
      email: hostEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'Host Usuario A' },
    });
    assert.ifError(errHost);
    hostId = hostUser.user!.id;

    const { data: appUser, error: errApp } = await admin.auth.admin.createUser({
      email: applicantEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'Solicitante Usuario B' },
    });
    assert.ifError(errApp);
    applicantId = appUser.user!.id;

    const { data: strUser, error: errStr } = await admin.auth.admin.createUser({
      email: strangerEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'Tercero Ajeno C' },
    });
    assert.ifError(errStr);
    strangerId = strUser.user!.id;

    // Crear clientes Supabase para cada rol
    const hostClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await hostClient.auth.signInWithPassword({ email: hostEmail, password });

    const applicantClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await applicantClient.auth.signInWithPassword({ email: applicantEmail, password });

    const strangerClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await strangerClient.auth.signInWithPassword({ email: strangerEmail, password });

    const anonClient = createClient(url, publishableKey, { auth: { persistSession: false } });

    console.log('   Usuarios creados: Host A, Solicitante B, Tercero C.\n');

    // 2. Crear encuentro de prueba con títulos y descripciones estrictamente separados
    console.log('2. Creando encuentro de prueba con títulos y logística privada...');
    const privateTitle = 'CUMPLE_PRIVADO_SECRETO_HOST_A';
    const privateDesc = 'DESCRIPCION_PRIVADA_SECRETA_HOST_A_CONFIDENCIAL';
    const publicTitle = 'Cena y Juegos de Mesa Sábado';
    const publicDesc = 'Vení a compartir una noche de pizzas y juegos de mesa en Palermo.';
    const privateAddress = 'Humboldt 1940 3ro B timbre 12, Palermo';

    const { data: enc, error: encErr } = await admin
      .from('encuentros')
      .insert({
        host_id: hostId,
        titulo: privateTitle,
        descripcion: privateDesc,
        open_public_title: publicTitle,
        open_description: publicDesc,
        modalidad: 'presencial',
        tipo_invitacion: 'link_general',
        lugar_texto: privateAddress,
        locality_id: 'palermo',
        open_public_zone: 'Palermo Hollywood',
        fecha: new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0],
        hora: '21:00:00',
        max_participants: 6,
        allow_multi_seat_requests: true,
        max_seats_per_request: 3,
        is_open: true,
        opened_at: new Date().toISOString(),
        moderation_status: 'approved',
        estado: 'activo',
      })
      .select()
      .single();

    assert.ifError(encErr);
    assert.ok(enc, 'Encuentro debe crearse');
    encuentroId = enc.id;
    console.log(`   Encuentro creado con ID: ${encuentroId}\n`);

    // =========================================================
    // MICROCHECK A — Auto-join del Host y Exclusión en Discovery
    // =========================================================
    console.log('========================================================');
    console.log('MICROCHECK A: AUTO-JOIN DEL HOST Y EXCLUSIÓN EN DISCOVERY');
    console.log('========================================================');

    // A.1 Host A consulta Discovery
    const { data: discHost, error: discHostErr } = await hostClient.rpc('get_discovery_encuentros_abiertos');
    assert.ifError(discHostErr);
    const hostSeesOwn = (discHost as any[] || []).filter((e) => e && e.id).some((e) => e.id === encuentroId);
    console.log(`[A.1] ¿Host A ve su propio encuentro en Discovery?: ${hostSeesOwn}`);
    assert.equal(hostSeesOwn, false, 'Host A NO debe ver su propio encuentro en Discovery');

    // A.2 Usuario anónimo consulta Discovery
    const { data: discAnon, error: discAnonErr } = await anonClient.rpc('get_discovery_encuentros_abiertos');
    assert.ifError(discAnonErr);
    const anonSeesEnc = (discAnon as any[] || []).filter((e) => e && e.id).some((e) => e.id === encuentroId);
    console.log(`[A.2] ¿Usuario anónimo ve el encuentro en Discovery?: ${anonSeesEnc}`);
    assert.equal(anonSeesEnc, true, 'Usuario anónimo DEBE ver el encuentro en Discovery');

    // A.3 Host A intenta auto-join
    const { data: hostJoinRes, error: hostJoinErr } = await hostClient.rpc(
      'solicitar_sumarse_encuentro_abierto',
      {
        p_encuentro_id: encuentroId,
        p_nombre: 'Host Auto-Join',
        p_seat_count: 1,
      }
    );
    console.log('[A.3] Resultado intento auto-join del Host:', hostJoinRes);
    assert.ifError(hostJoinErr);
    assert.equal(hostJoinRes?.ok, false, 'Auto-join debe retornar ok: false');
    assert.equal(
      hostJoinRes?.error,
      'cannot_join_own_encounter',
      'Auto-join debe retornar error cannot_join_own_encounter'
    );

    // A.4 Host A accede por deep link / detalle autorizado directo
    const { data: hostAuthDetail, error: hostAuthErr } = await hostClient.rpc(
      'get_encuentro_participante_autorizado',
      { p_encuentro_id: encuentroId }
    );
    assert.ifError(hostAuthErr);
    console.log('[A.4] Detalle autorizado para Host A:', hostAuthDetail);
    assert.equal(hostAuthDetail?.ok, true, 'Host A debe estar autorizado para ver su encuentro');
    assert.equal(hostAuthDetail?.is_host, true, 'Host A debe tener is_host: true');
    console.log('>>> MICROCHECK A: PASS\n');

    // =========================================================
    // MICROCHECK B — Realtime y RLS de Solicitudes
    // =========================================================
    console.log('========================================================');
    console.log('MICROCHECK B: RLS Y PRIVACIDAD EN SOLICITUDES');
    console.log('========================================================');

    // B.1 Solicitante B solicita sumarse con 2 lugares
    console.log('[B.1] Solicitante B solicita sumarse con 2 lugares...');
    const { data: joinBRes, error: joinBErr } = await applicantClient.rpc(
      'solicitar_sumarse_encuentro_abierto',
      {
        p_encuentro_id: encuentroId,
        p_nombre: 'Solicitante B',
        p_mensaje: 'Hola! Queremos sumarnos 2 amigos.',
        p_seat_count: 2,
      }
    );
    assert.ifError(joinBErr);
    assert.equal(joinBRes?.ok, true, 'Solicitud de B debe ser exitosa');
    assert.equal(joinBRes?.seat_count, 2, 'Cupos solicitados deben ser 2');
    const requestId = joinBRes.request_id;
    assert.ok(requestId, 'Debe retornar request_id');
    console.log(`      Solicitud creada con ID: ${requestId}`);

    // B.2 RLS Check: Solicitante B puede consultar su propia solicitud
    const { data: rlsBRows, error: rlsBErr } = await applicantClient
      .from('solicitudes_encuentro_abierto')
      .select('id, encuentro_id, usuario_id, nombre_solicitante, seat_count, estado')
      .eq('id', requestId);
    assert.ifError(rlsBErr);
    console.log('[B.2] Filas visibles para Solicitante B:', rlsBRows?.length);
    assert.equal(rlsBRows?.length, 1, 'Solicitante B DEBE poder ver su solicitud');
    assert.equal(rlsBRows![0].usuario_id, applicantId);

    // B.3 RLS Check: Host A puede consultar la solicitud del encuentro
    const { data: rlsARows, error: rlsAErr } = await hostClient
      .from('solicitudes_encuentro_abierto')
      .select('id, encuentro_id, usuario_id, nombre_solicitante, seat_count, estado')
      .eq('id', requestId);
    assert.ifError(rlsAErr);
    console.log('[B.3] Filas visibles para Host A:', rlsARows?.length);
    assert.equal(rlsARows?.length, 1, 'Host A DEBE poder ver la solicitud de su encuentro');

    // B.4 RLS Check: Tercero C ajeno NO ve la solicitud
    const { data: rlsCRows, error: rlsCErr } = await strangerClient
      .from('solicitudes_encuentro_abierto')
      .select('id, encuentro_id, usuario_id, nombre_solicitante, seat_count, estado')
      .eq('id', requestId);
    assert.ifError(rlsCErr);
    console.log('[B.4] Filas visibles para Tercero C:', rlsCRows?.length);
    assert.equal(rlsCRows?.length, 0, 'Tercero C NO debe ver solicitudes ajenas');

    // B.5 RLS Check: Anónimo NO ve la solicitud (bloqueado por permisos o RLS)
    const { data: rlsAnonRows, error: rlsAnonErr } = await anonClient
      .from('solicitudes_encuentro_abierto')
      .select('id, encuentro_id, usuario_id, nombre_solicitante, seat_count, estado')
      .eq('id', requestId);
    console.log('[B.5] Acceso para Anónimo bloqueado:', rlsAnonErr ? rlsAnonErr.message : `filas: ${rlsAnonRows?.length}`);
    assert.ok(
      rlsAnonErr || rlsAnonRows?.length === 0,
      'Anónimo NO debe tener acceso a solicitudes'
    );

    // B.6 Verificación de no fuga en payload de solicitud
    const { data: directReqRow } = await admin
      .from('solicitudes_encuentro_abierto')
      .select('*')
      .eq('id', requestId)
      .single();
    assert.equal(directReqRow.lugar_texto, undefined, 'solicitudes no contiene lugar_texto');
    assert.equal(directReqRow.exact_address, undefined, 'solicitudes no contiene exact_address');
    assert.equal(directReqRow.link_virtual, undefined, 'solicitudes no contiene link_virtual');

    // B.7 Host aprueba la solicitud
    console.log('[B.7] Host A aprueba la solicitud de B...');
    const { data: approveRes, error: approveErr } = await hostClient.rpc(
      'aprobar_solicitud_encuentro_abierto',
      {
        p_request_id: requestId,
        p_host_id: hostId,
      }
    );
    assert.ifError(approveErr);
    assert.equal(approveRes?.ok, true, 'Aprobación debe ser ok: true');
    console.log('      Aprobada exitosamente. Participante creado con ID:', approveRes?.participante_id);

    console.log('>>> MICROCHECK B: PASS\n');

    // =========================================================
    // MICROCHECK C — Deep link de aprobación y Logística Autorizada
    // =========================================================
    console.log('========================================================');
    console.log('MICROCHECK C: LOGÍSTICA PRIVADA Y PRIVACIDAD DEL HOST');
    console.log('========================================================');

    // C.1 Solicitante B (aprobado) consulta detalle autorizado
    const { data: appAuthDetail, error: appAuthErr } = await applicantClient.rpc(
      'get_encuentro_participante_autorizado',
      { p_encuentro_id: encuentroId }
    );
    assert.ifError(appAuthErr);
    console.log('[C.1] Detalle autorizado para Solicitante B aprobado:', appAuthDetail);
    assert.equal(appAuthDetail?.ok, true, 'Participante B aprobado debe estar autorizado');
    assert.equal(appAuthDetail?.is_host, false, 'Participante B debe tener is_host: false');

    // Verificación estricta de títulos y descripciones
    assert.equal(
      appAuthDetail?.open_public_title,
      publicTitle,
      'Participante B debe ver open_public_title'
    );
    assert.notEqual(
      appAuthDetail?.open_public_title,
      privateTitle,
      'Participante B NUNCA debe ver el título privado del host'
    );

    assert.equal(
      appAuthDetail?.open_description,
      publicDesc,
      'Participante B debe ver open_description'
    );
    assert.notEqual(
      appAuthDetail?.open_description,
      privateDesc,
      'Participante B NUNCA debe ver la descripción privada del host'
    );

    // Logística privada autorizada
    assert.equal(
      appAuthDetail?.lugar_texto,
      privateAddress,
      'Participante B debe recibir la dirección física privada autorizada'
    );
    assert.equal(
      appAuthDetail?.seat_count,
      2,
      'Participante B debe ver sus 2 lugares confirmados'
    );

    // C.2 Solicitante B consulta get_mis_solicitudes_seguro
    const { data: misSols, error: misSolsErr } = await applicantClient.rpc('get_mis_solicitudes_seguro');
    assert.ifError(misSolsErr);
    const myItem = (misSols as any[] || []).find((s) => s.request_id === requestId);
    console.log('[C.2] Item en get_mis_solicitudes_seguro:', myItem);
    assert.ok(myItem, 'Solicitud aprobada debe aparecer en Mis Solicitudes');
    assert.equal(myItem.estado, 'approved');
    assert.equal(myItem.seat_count, 2);
    assert.equal(myItem.open_public_title, publicTitle);
    assert.equal(myItem.lugar_texto, undefined, 'Mis solicitudes NO debe exponer lugar_texto');
    assert.equal(myItem.exact_address, undefined, 'Mis solicitudes NO debe exponer exact_address');

    // C.3 Verificación negativa: Tercero C intenta acceder a logística autorizada
    const { data: strangerAuthDetail, error: strangerAuthErr } = await strangerClient.rpc(
      'get_encuentro_participante_autorizado',
      { p_encuentro_id: encuentroId }
    );
    assert.ifError(strangerAuthErr);
    console.log('[C.3] Detalle autorizado para Tercero C:', strangerAuthDetail);
    assert.equal(strangerAuthDetail?.ok, false);
    assert.equal(strangerAuthDetail?.error, 'unauthorized');

    // C.4 Verificación negativa: Anónimo intenta acceder a logística autorizada
    const { data: anonAuthDetail, error: anonAuthErr } = await anonClient.rpc(
      'get_encuentro_participante_autorizado',
      { p_encuentro_id: encuentroId }
    );
    console.log('[C.4] Acceso de Anónimo a logística privada bloqueado:', anonAuthErr ? anonAuthErr.message : anonAuthDetail);
    assert.ok(
      anonAuthErr || anonAuthDetail?.ok === false,
      'Anónimo debe ser bloqueado de acceder a logística autorizada'
    );

    // C.5 Simulación: Encuentro cerrado / fuera de discovery
    console.log('[C.5] Cerrando encuentro para Discovery...');
    const { data: closeRes } = await hostClient.rpc('cerrar_encuentro_abierto_seguro', {
      p_encuentro_id: encuentroId,
      p_host_id: hostId,
    });
    assert.equal(closeRes?.ok, true);

    // Tras el cierre, el participante confirmado B aún puede acceder por deep link a su logística
    const { data: appAfterClose } = await applicantClient.rpc('get_encuentro_participante_autorizado', {
      p_encuentro_id: encuentroId,
    });
    console.log('      Acceso de B tras cierre de encuentro:', appAfterClose?.ok);
    assert.equal(appAfterClose?.ok, true, 'Participante confirmado B mantiene acceso tras cierre de Discovery');
    assert.equal(appAfterClose?.lugar_texto, privateAddress);

    console.log('>>> MICROCHECK C: PASS\n');

    console.log('====================================================');
    console.log('TODAS LAS COMPUERTAS DE LOS MICROCHECKS A, B Y C: PASS');
    console.log('====================================================\n');
  } finally {
    // Limpieza estricta de fixtures en Staging
    console.log('Limpiando fixtures de prueba en Staging...');
    if (encuentroId) {
      await admin.from('domain_events_outbox').delete().eq('aggregate_id', encuentroId);
      await admin.from('solicitudes_encuentro_abierto').delete().eq('encuentro_id', encuentroId);
      await admin.from('participantes').delete().eq('encuentro_id', encuentroId);
      await admin.from('encuentros').delete().eq('id', encuentroId);
    }
    if (hostId) await admin.auth.admin.deleteUser(hostId);
    if (applicantId) await admin.auth.admin.deleteUser(applicantId);
    if (strangerId) await admin.auth.admin.deleteUser(strangerId);
    console.log('Fixtures limpiados correctamente.');
  }
}

main().catch((err) => {
  console.error('ERROR EN TEST DE CIERRE:', err);
  process.exit(1);
});
