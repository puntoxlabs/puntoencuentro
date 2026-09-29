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

async function runStagingValidation() {
  console.log('========================================================');
  console.log('STAGING VALIDATION: FASE 2.0-A INTENCIONES BLOQUE 1');
  console.log(`Target: ${url} (Project: ${STAGING_PROJECT_REF})`);
  console.log('========================================================\n');

  let testUserId: string | null = null;

  try {
    // 1. Crear usuario permanente temporal de QA
    const email = `qa-intencion-${Date.now()}@puntoencuentro.test`;
    const password = 'QaPassword123!Safe';

    const { data: createData, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'QA Intenciones Test' },
    });

    if (createErr || !createData.user) {
      throw new Error(`Failed to create test user: ${createErr?.message}`);
    }
    testUserId = createData.user.id;
    console.log(`[1/5] Usuario permanente creado: ${testUserId}`);

    // 2. Iniciar sesión cliente
    const userClient = createClient(url, publishableKey, { auth: { persistSession: false } });
    await userClient.auth.signInWithPassword({ email, password });
    console.log('[2/5] Sesión iniciada con éxito en Staging.');

    // 3. Crear intención
    const { data: createRes, error: rpcErr1 } = await userClient.rpc('crear_intencion_segura', {
      p_titulo: 'Salir a correr por Palermo',
      p_descripcion: 'Ritmo suave, 5k',
      p_temporalidad_texto: 'este finde',
      p_fecha_desde: '2026-10-03',
      p_fecha_hasta: '2026-10-04',
      p_modalidad: 'presencial',
      p_locality_id: 'palermo',
    });

    if (rpcErr1 || !createRes?.ok) {
      throw new Error(`crear_intencion_segura falló: ${rpcErr1?.message || createRes?.error}`);
    }
    const intencionId = createRes.id;
    console.log(`[3/5] Intención creada exitosamente: ${intencionId}`);

    // 4. Listar mis intenciones
    const { data: listRes, error: rpcErr2 } = await userClient.rpc('get_mis_intenciones_seguro');
    if (rpcErr2 || !listRes?.ok) {
      throw new Error(`get_mis_intenciones_seguro falló: ${rpcErr2?.message || listRes?.error}`);
    }
    console.log(`[4/5] Listado obtenido: ${listRes.intenciones.length} intenciones.`);
    const item = listRes.intenciones[0];
    if (item.id !== intencionId || item.localidad_nombre !== 'Palermo' || item.estado !== 'activa') {
      throw new Error(`Datos inconsistentes en listado: ${JSON.stringify(item)}`);
    }

    // 5. Cambiar estado a pausada y luego a cerrada (soft-delete)
    const { data: pauseRes } = await userClient.rpc('cambiar_estado_intencion_segura', {
      p_id: intencionId,
      p_nuevo_estado: 'pausada',
    });
    if (!pauseRes?.ok || pauseRes.estado !== 'pausada') {
      throw new Error(`Error al pausar intención: ${JSON.stringify(pauseRes)}`);
    }

    const { data: closeRes } = await userClient.rpc('cambiar_estado_intencion_segura', {
      p_id: intencionId,
      p_nuevo_estado: 'cerrada',
    });
    if (!closeRes?.ok || closeRes.estado !== 'cerrada') {
      throw new Error(`Error al cerrar intención: ${JSON.stringify(closeRes)}`);
    }

    // Confirmar que la fila sigue en base de datos (soft-delete)
    const { data: rowCheck } = await admin
      .from('intenciones')
      .select('id, estado')
      .eq('id', intencionId)
      .single();

    if (!rowCheck || rowCheck.estado !== 'cerrada') {
      throw new Error(`Fila no encontrada o estado incorrecto en base de datos: ${JSON.stringify(rowCheck)}`);
    }
    console.log('[5/5] Ciclo de vida completo validado: activa -> pausada -> cerrada (soft-delete confirmado).');

    console.log('\n========================================================');
    console.log('✅ VALIDACIÓN STAGING EXITOSA: BLOQUE 1 BACKEND CORE OK');
    console.log('========================================================\n');
  } finally {
    if (testUserId) {
      await admin.auth.admin.deleteUser(testUserId);
      console.log('[Cleanup] Usuario de prueba eliminado de Staging.');
    }
  }
}

runStagingValidation().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
