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

async function runStagingSmokeB2() {
  console.log('========================================================');
  console.log('STAGING SMOKE: FASE 2.0-B DISCOVERY BLOQUE 2');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  let authorId: string | null = null;
  let interestedId: string | null = null;

  try {
    // 1. Crear usuario autor QA
    const emailAuthor = `qa-author-${Date.now()}@puntoencuentro.test`;
    const passwordAuthor = 'QaPassword123!Author';
    const { data: authorData, error: authorErr } = await admin.auth.admin.createUser({
      email: emailAuthor,
      password: passwordAuthor,
      email_confirm: true,
      user_metadata: { full_name: 'QA Author' },
    });
    if (authorErr || !authorData.user) {
      throw new Error(`Failed to create author user: ${authorErr?.message}`);
    }
    authorId = authorData.user.id;
    console.log(`[1/6] Usuario Autor creado: ${authorId}`);

    // 2. Crear usuario interesado QA
    const emailInterested = `qa-interesado-${Date.now()}@puntoencuentro.test`;
    const passwordInterested = 'QaPassword123!Interested';
    const { data: interestedData, error: interestedErr } = await admin.auth.admin.createUser({
      email: emailInterested,
      password: passwordInterested,
      email_confirm: true,
      user_metadata: { full_name: 'QA Interesado' },
    });
    if (interestedErr || !interestedData.user) {
      throw new Error(`Failed to create interested user: ${interestedErr?.message}`);
    }
    interestedId = interestedData.user.id;
    console.log(`[2/6] Usuario Interesado creado: ${interestedId}`);

    // 3. Autor crea intención activa
    const authorClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await authorClient.auth.signInWithPassword({ email: emailAuthor, password: passwordAuthor });
    const { data: createRes, error: createErr } = await authorClient.rpc('crear_intencion_segura', {
      p_titulo: 'Tenis fin de semana',
      p_descripcion: 'Nivel intermedio',
      p_temporalidad_texto: 'proximo sabado',
      p_modalidad: 'presencial',
      p_locality_id: 'palermo',
    });
    if (createErr || !createRes?.ok) {
      throw new Error(`crear_intencion_segura falló: ${createErr?.message || createRes?.error}`);
    }
    const intencionId = createRes.id;
    console.log(`[3/6] Intención activa creada: ${intencionId}`);

    // 4. Usuario interesado inicia sesión y marca interés (true)
    const interestedClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await interestedClient.auth.signInWithPassword({ email: emailInterested, password: passwordInterested });

    const { data: setRes1, error: setErr1 } = await interestedClient.rpc('set_interes_intencion', {
      p_intencion_id: intencionId,
      p_interesado: true,
    });
    if (setErr1 || !setRes1?.ok) {
      throw new Error(`set_interes_intencion (1) falló: ${setErr1?.message || setRes1?.error}`);
    }
    console.log('[4/6] Primer alta: interesado =', setRes1.interesado, ', count =', setRes1.interested_count);
    if (setRes1.interesado !== true || setRes1.interested_count !== 1) {
      throw new Error(`Resultado inesperado en alta: ${JSON.stringify(setRes1)}`);
    }

    // 5. Usuario interesado repite llamada idéntica (idempotencia true -> true)
    const { data: setRes2, error: setErr2 } = await interestedClient.rpc('set_interes_intencion', {
      p_intencion_id: intencionId,
      p_interesado: true,
    });
    if (setErr2 || !setRes2?.ok) {
      throw new Error(`set_interes_intencion (2) falló: ${setErr2?.message || setRes2?.error}`);
    }
    console.log('[5/6] Idempotencia (true -> true): interesado =', setRes2.interesado, ', count =', setRes2.interested_count);
    if (setRes2.interesado !== true || setRes2.interested_count !== 1) {
      throw new Error(`Resultado inesperado en idempotencia: ${JSON.stringify(setRes2)}`);
    }

    // 6. Usuario interesado retira interés (false)
    const { data: setRes3, error: setErr3 } = await interestedClient.rpc('set_interes_intencion', {
      p_intencion_id: intencionId,
      p_interesado: false,
    });
    if (setErr3 || !setRes3?.ok) {
      throw new Error(`set_interes_intencion (3) falló: ${setErr3?.message || setRes3?.error}`);
    }
    console.log('[6/6] Baja: interesado =', setRes3.interesado, ', count =', setRes3.interested_count);
    if (setRes3.interesado !== false || setRes3.interested_count !== 0) {
      throw new Error(`Resultado inesperado en baja: ${JSON.stringify(setRes3)}`);
    }

    console.log('\n========================================================');
    console.log('✅ STAGING SMOKE EXITOSO: B2 INTERÉS IDEMPOTENTE VALIDADO');
    console.log('========================================================\n');
  } finally {
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

runStagingSmokeB2().catch((err) => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
