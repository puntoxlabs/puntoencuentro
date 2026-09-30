import { createClient } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  getStagingPublishableKey,
  getStagingSecretKey,
} from './lib/environment-guard';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
assertStagingEnvironment(url);

const secretKey = getStagingSecretKey();
const publishableKey = getStagingPublishableKey();

const admin = createClient(url, secretKey, { auth: { persistSession: false } });

async function runStagingSmokeCasoC() {
  console.log('========================================================');
  console.log('STAGING SMOKE: FASE 2.0-C1 ALERTAS CASO C');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  let authorId: string | null = null;
  let interestedId: string | null = null;
  let createdEncuentroId: string | null = null;

  try {
    // 1. Crear usuario autor QA
    const emailAuthor = `qa-c1-author-${Date.now()}@puntoencuentro.test`;
    const passwordAuthor = 'QaPassword123!Author';
    const { data: authorData, error: authorErr } = await admin.auth.admin.createUser({
      email: emailAuthor,
      password: passwordAuthor,
      email_confirm: true,
      user_metadata: { full_name: 'QA C1 Author' },
    });
    if (authorErr || !authorData.user) {
      throw new Error(`Failed to create author user: ${authorErr?.message}`);
    }
    authorId = authorData.user.id;
    console.log(`[1/8] Usuario Autor creado: ${authorId}`);

    // 2. Crear usuario interesado QA
    const emailInterested = `qa-c1-interesado-${Date.now()}@puntoencuentro.test`;
    const passwordInterested = 'QaPassword123!Interested';
    const { data: interestedData, error: interestedErr } = await admin.auth.admin.createUser({
      email: emailInterested,
      password: passwordInterested,
      email_confirm: true,
      user_metadata: { full_name: 'QA C1 Interesado' },
    });
    if (interestedErr || !interestedData.user) {
      throw new Error(`Failed to create interested user: ${interestedErr?.message}`);
    }
    interestedId = interestedData.user.id;
    console.log(`[2/8] Usuario Interesado creado: ${interestedId}`);

    // 3. Autor crea intención activa
    const authorClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await authorClient.auth.signInWithPassword({ email: emailAuthor, password: passwordAuthor });
    const { data: createRes, error: createErr } = await authorClient.rpc('crear_intencion_segura', {
      p_titulo: 'Pádel parejas fin de semana',
      p_descripcion: 'Buscamos completar 4 personas',
      p_temporalidad_texto: 'este sábado',
      p_modalidad: 'presencial',
      p_locality_id: 'palermo',
    });
    if (createErr || !createRes?.ok) {
      throw new Error(`crear_intencion_segura falló: ${createErr?.message || createRes?.error}`);
    }
    const intencionId = createRes.id;
    console.log(`[3/8] Intención creada: ${intencionId}`);

    // 4. Usuario interesado marca interés
    const interestedClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await interestedClient.auth.signInWithPassword({ email: emailInterested, password: passwordInterested });
    const { data: setRes, error: setErr } = await interestedClient.rpc('set_interes_intencion', {
      p_intencion_id: intencionId,
      p_interesado: true,
    });
    if (setErr || !setRes?.ok) {
      throw new Error(`set_interes_intencion falló: ${setErr?.message || setRes?.error}`);
    }
    console.log(`[4/8] Interés registrado para usuario ${interestedId}`);

    // 5. Autor crea encuentro seguro para vincular
    const { data: encData, error: encErr } = await admin
      .from('encuentros')
      .insert({
        host_id: authorId,
        titulo: 'Torneo Pádel Palermo',
        descripcion: 'Detalle encuentro',
        fecha: '2026-10-10',
        hora: '17:00',
        modalidad: 'presencial',
        tipo_invitacion: 'link_general',
        locality_id: 'palermo',
        max_participants: 6,
        is_open: true,
      })
      .select('id')
      .single();

    if (encErr || !encData) {
      throw new Error(`Error creando encuentro: ${encErr?.message}`);
    }
    createdEncuentroId = encData.id;
    console.log(`[5/8] Encuentro creado: ${createdEncuentroId}`);

    // 6. Autor convierte intención en encuentro
    const { data: convRes1, error: convErr1 } = await authorClient.rpc('convertir_intencion_a_encuentro', {
      p_intencion_id: intencionId,
      p_encuentro_id: createdEncuentroId,
    });
    if (convErr1 || !convRes1?.ok) {
      throw new Error(`convertir_intencion_a_encuentro (1) falló: ${convErr1?.message || convRes1?.error}`);
    }
    console.log(`[6/8] Intención convertida exitosamente: estado = ${convRes1.estado}`);

    // 7. Verificar exactamente una alerta para Usuario B
    const { data: alertasB1, error: getErr1 } = await interestedClient.rpc('get_mis_alertas_seguro');
    if (getErr1 || !alertasB1?.ok) {
      throw new Error(`get_mis_alertas_seguro falló: ${getErr1?.message || alertasB1?.error}`);
    }
    const alertas = alertasB1.alertas || alertasB1.data;
    if (!Array.isArray(alertas) || alertas.length !== 1) {
      throw new Error(`Se esperaba exactamente 1 alerta para el interesado, se obtuvo: ${JSON.stringify(alertas)}`);
    }
    const alerta = alertas[0];
    if (
      alerta.tipo !== 'interes_convertido' ||
      alerta.source_intencion_id !== intencionId ||
      alerta.target_encuentro_id !== createdEncuentroId ||
      alerta.leida !== false
    ) {
      throw new Error(`Campos de alerta inesperados: ${JSON.stringify(alerta)}`);
    }
    console.log(`[7/8] Exactamente 1 alerta recibida para usuario B: ID = ${alerta.id}, tipo = ${alerta.tipo}`);

    // 8. Repetir conversión (idempotente) y verificar que continúa habiendo exactamente 1 alerta
    const { data: convRes2, error: convErr2 } = await authorClient.rpc('convertir_intencion_a_encuentro', {
      p_intencion_id: intencionId,
      p_encuentro_id: createdEncuentroId,
    });
    if (convErr2 || !convRes2?.ok) {
      throw new Error(`convertir_intencion_a_encuentro (retry) falló: ${convErr2?.message || convRes2?.error}`);
    }
    if (convRes2.idempotent !== true) {
      throw new Error(`Esperado idempotent: true en retry, se obtuvo: ${JSON.stringify(convRes2)}`);
    }

    const { data: alertasB2 } = await interestedClient.rpc('get_mis_alertas_seguro');
    const alertasAfterRetry = alertasB2.alertas || alertasB2.data;
    if (alertasAfterRetry.length !== 1) {
      throw new Error(`Se duplicó la alerta en retry: ${alertasAfterRetry.length} alertas`);
    }
    console.log(`[8/8] Idempotencia verificada: continúa exactamente 1 alerta tras retry.`);

    // 9. Marcar alerta como leída y verificar
    const { data: markRes, error: markErr } = await interestedClient.rpc('marcar_alerta_leida_seguro', {
      p_alerta_id: alerta.id,
    });
    if (markErr || !markRes?.ok || markRes.leida !== true) {
      throw new Error(`marcar_alerta_leida_seguro falló: ${markErr?.message || JSON.stringify(markRes)}`);
    }
    console.log(`[Extra] Alerta marcada como leída exitosamente.`);

    console.log('\n========================================================');
    console.log('✅ STAGING SMOKE EXITOSO: FASE 2.0-C1 ALERTAS CASO C VALIDADO');
    console.log('========================================================\n');
  } finally {
    if (createdEncuentroId) {
      await admin.from('encuentros').delete().eq('id', createdEncuentroId);
      console.log('[Cleanup] Encuentro QA eliminado.');
    }
    if (interestedId) {
      await admin.auth.admin.deleteUser(interestedId);
      console.log('[Cleanup] Usuario Interesado QA eliminado.');
    }
    if (authorId) {
      await admin.auth.admin.deleteUser(authorId);
      console.log('[Cleanup] Usuario Autor QA eliminado.');
    }
  }
}

runStagingSmokeCasoC().catch((err) => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
