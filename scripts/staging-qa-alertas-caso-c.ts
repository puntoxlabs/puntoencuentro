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
  console.log('STAGING SMOKE: FASE 2.0-C1 ALERTAS CASO C (MICRO-FIX)');
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
    console.log(`[1/9] Usuario Autor creado: ${authorId}`);

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
    console.log(`[2/9] Usuario Interesado creado: ${interestedId}`);

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
    console.log(`[3/9] Intención creada: ${intencionId}`);

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
    console.log(`[4/9] Interés registrado para usuario ${interestedId}`);

    // 5. Autor crea encuentro PRIVADO (is_open = false)
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
        is_open: false,
      })
      .select('id')
      .single();

    if (encErr || !encData) {
      throw new Error(`Error creando encuentro: ${encErr?.message}`);
    }
    createdEncuentroId = encData.id;
    console.log(`[5/9] Encuentro privado creado (is_open=false): ${createdEncuentroId}`);

    // 6. Autor convierte intención en encuentro privado -> Confirmar 0 alertas generadas
    const { data: convRes, error: convErr } = await authorClient.rpc('convertir_intencion_a_encuentro', {
      p_intencion_id: intencionId,
      p_encuentro_id: createdEncuentroId,
    });
    if (convErr || !convRes?.ok) {
      throw new Error(`convertir_intencion_a_encuentro falló: ${convErr?.message || convRes?.error}`);
    }
    console.log(`[6/9] Intención convertida: estado = ${convRes.estado}`);

    const { data: checkPrivateAlerts, error: checkPrivErr } = await interestedClient.rpc('get_mis_alertas_seguro');
    if (checkPrivErr || !checkPrivateAlerts?.ok) {
      throw new Error(`get_mis_alertas_seguro check falló: ${checkPrivErr?.message}`);
    }
    const privateAlertsList = checkPrivateAlerts.alertas || checkPrivateAlerts.data || [];
    if (privateAlertsList.length !== 0) {
      throw new Error(`ALERTA PREMATURA DETECTADA: Se esperaba 0 alertas para encuentro privado, pero se encontraron ${privateAlertsList.length}`);
    }
    console.log('[6/9] Confirmado: 0 alertas generadas mientras el encuentro es privado.');

    // 7. Autor publica/abre el encuentro mediante abrir_encuentro_seguro -> Confirmar exactamente 1 alerta
    const { data: openRes, error: openErr } = await authorClient.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: createdEncuentroId,
      p_host_id: authorId,
      p_open_description: 'Abierto a la comunidad',
      p_max_participants: 4,
      p_locality_id: 'palermo',
      p_open_public_zone: 'Palermo Soho',
    });
    if (openErr || !openRes?.ok) {
      throw new Error(`abrir_encuentro_seguro falló: ${openErr?.message || JSON.stringify(openRes)}`);
    }
    console.log('[7/9] Encuentro abierto a la comunidad exitosamente.');

    const { data: alertasB1, error: getErr1 } = await interestedClient.rpc('get_mis_alertas_seguro');
    if (getErr1 || !alertasB1?.ok) {
      throw new Error(`get_mis_alertas_seguro falló: ${getErr1?.message || alertasB1?.error}`);
    }
    const alertas = alertasB1.alertas || alertasB1.data;
    if (!Array.isArray(alertas) || alertas.length !== 1) {
      throw new Error(`Se esperaba exactamente 1 alerta para el interesado tras abrir encuentro, se obtuvo: ${JSON.stringify(alertas)}`);
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

    // 8. Validar privacidad del DTO: ausencia de public_token, host_id, etc.
    if (alerta.public_token !== undefined || alerta.encuentro?.public_token !== undefined) {
      throw new Error(`Vulnerabilidad: public_token presente en DTO: ${JSON.stringify(alerta)}`);
    }
    if (alerta.host_id !== undefined || alerta.encuentro?.host_id !== undefined) {
      throw new Error(`Vulnerabilidad: host_id presente en DTO: ${JSON.stringify(alerta)}`);
    }
    console.log(`[8/9] Alerta recibida con DTO sanitizado (sin public_token ni host_id). ID = ${alerta.id}`);

    // 9. Reapertura / retry idempotente -> verificar que sigue habiendo exactamente 1 alerta
    const { data: openRetry } = await authorClient.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: createdEncuentroId,
      p_host_id: authorId,
      p_open_description: 'Abierto a la comunidad modificado',
      p_max_participants: 6,
      p_locality_id: 'palermo',
      p_open_public_zone: 'Palermo Soho',
    });
    if (!openRetry?.ok) {
      throw new Error(`abrir_encuentro_seguro (reintento) falló: ${JSON.stringify(openRetry)}`);
    }

    const { data: alertasB2 } = await interestedClient.rpc('get_mis_alertas_seguro');
    const alertasAfterRetry = alertasB2.alertas || alertasB2.data;
    if (alertasAfterRetry.length !== 1) {
      throw new Error(`Se duplicó la alerta en reapertura: ${alertasAfterRetry.length} alertas`);
    }
    console.log('[9/9] Idempotencia verificada: continúa exactamente 1 alerta tras reapertura.');

    // 10. Marcar alerta como leída
    const { data: markRes, error: markErr } = await interestedClient.rpc('marcar_alerta_leida_seguro', {
      p_alerta_id: alerta.id,
    });
    if (markErr || !markRes?.ok || markRes.leida !== true) {
      throw new Error(`marcar_alerta_leida_seguro falló: ${markErr?.message || JSON.stringify(markRes)}`);
    }
    console.log(`[Extra] Alerta marcada como leída exitosamente.`);

    console.log('\n========================================================');
    console.log('✅ STAGING SMOKE EXITOSO: FASE 2.0-C1 MICRO-FIX VALIDADO');
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
