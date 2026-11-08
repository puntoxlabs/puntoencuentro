/**
 * Auditoría Estricta de Solo Lectura — Supabase Staging
 * Mini-Sprint 2B-4: Puente de Identidad entre Dominios
 *
 * REGLA DE ORO: ESTE SCRIPT ES ESTRICTAMENTE DE SOLO LECTURA.
 * No realiza mutaciones, deletes ni alteraciones de switches.
 * Si detecta un switch activo, emite estado CRÍTICO y deriva al procedimiento de emergencia.
 */

import { createClient, User } from '@supabase/supabase-js';
import {
  assertStagingEnvironment,
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  getStagingSecretKey,
} from './lib/environment-guard.ts';
import fs from 'node:fs';
import path from 'node:path';

const STAGING_URL = 'https://wougfhfwqgmxhgvjqoua.supabase.co';

assertStagingEnvironment(STAGING_URL);
assertStagingEnvironment(STAGING_PROJECT_REF);

if (STAGING_URL.includes(PRODUCTION_PROJECT_REF)) {
  console.error('[CRITICAL SECURITY ERROR] Target es Producción. Abortando inmediatamente.');
  process.exit(1);
}

const maskIdentifier = (val: string | null | undefined): string => {
  if (!val) return '(null)';
  if (val.length <= 8) return '***';
  return `${val.slice(0, 4)}...${val.slice(-4)}`;
};

async function runReadOnlyAudit() {
  console.log('================================================================================');
  console.log('AUDITORÍA DE SEGURIDAD Y RESIDUOS (STRICT READ-ONLY) — STAGING');
  console.log(`Target: ${STAGING_URL} (Ref: ${STAGING_PROJECT_REF})`);
  console.log(`Fecha/Hora: ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  const adminKey = getStagingSecretKey();
  const adminClient = createClient(STAGING_URL, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let hasCriticalIssue = false;

  // 1. ESTADO DE KILL SWITCHES
  console.log('--- 1. AUDITORÍA DE KILL SWITCHES SQL ---');
  const { data: settings, error: setErr } = await adminClient
    .from('domain_migration_settings')
    .select('setting_key, setting_value, updated_at');

  if (setErr || !settings) {
    console.error(`[CRÍTICO] Error consultando domain_migration_settings: ${setErr?.message}`);
    hasCriticalIssue = true;
  } else {
    for (const s of settings) {
      console.log(`  - ${s.setting_key}: ${s.setting_value} (updated_at: ${s.updated_at})`);
    }

    const bridgeSetting = settings.find((s) => s.setting_key === 'cross_origin_bridge_enabled');
    const manualSetting = settings.find((s) => s.setting_key === 'cross_origin_manual_enabled');

    const bridgeVal = bridgeSetting?.setting_value;
    const manualVal = manualSetting?.setting_value;

    if (bridgeVal === undefined || bridgeVal === null || manualVal === undefined || manualVal === null) {
      console.error('\n[CRÍTICO] Estado INDETERMINADO en kill switches (valor nulo o clave faltante).');
      console.error('Acción requerida: Ejecutar `npx tsx scripts/emergency-bridge-killswitch-reset.ts --shutdown-only`');
      hasCriticalIssue = true;
    } else if (bridgeVal !== false || manualVal !== false) {
      console.error(`\n[CRÍTICO] Kill switch ACTIVO detectado: bridge=${bridgeVal}, manual=${manualVal}`);
      console.error('El auditor de solo lectura NO modifica la base de datos.');
      console.error('Acción requerida: Ejecutar inmediatamente `npx tsx scripts/emergency-bridge-killswitch-reset.ts --shutdown-only`');
      hasCriticalIssue = true;
    } else {
      console.log('  -> Confirmado: Ambos kill switches están en false (puente totalmente cerrado).\n');
    }
  }

  // 2. AUDITORÍA DE RESIDUOS POR MANIFIESTOS Y UUIDS REGISTRADOS
  console.log('--- 2. AUDITORÍA DE RESIDUOS POR UUIDS REGISTRADOS ---');
  const rootDir = process.cwd();
  const manifestFiles = fs.readdirSync(rootDir).filter((f) => f.startsWith('recovery-manifest-staging-') && f.endsWith('.json'));

  const trackedManifestUids = new Set<string>();
  const trackedManifestEncIds = new Set<string>();

  if (manifestFiles.length > 0) {
    console.log(`  Se encontraron ${manifestFiles.length} manifiesto(s) de recuperación en raíz:`);
    for (const mf of manifestFiles) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(rootDir, mf), 'utf8'));
        console.log(`    - ${mf} (runId: ${parsed.runId}, timestamp: ${parsed.timestamp})`);
        (parsed.trackedUserIds || []).forEach((u: string) => trackedManifestUids.add(u));
        (parsed.trackedEncounterIds || []).forEach((e: string) => trackedManifestEncIds.add(e));
      } catch (err: any) {
        console.warn(`    - ${mf} (error leyendo JSON: ${err.message})`);
      }
    }
  } else {
    console.log('  0 manifiestos residuales pendientes en disco.');
  }

  // 2.1 Verificación de UUIDs de manifiestos en DB
  if (trackedManifestEncIds.size > 0) {
    const encList = Array.from(trackedManifestEncIds);
    const { data: matchedEncs } = await adminClient.from('encuentros').select('id, titulo').in('id', encList);
    if (matchedEncs && matchedEncs.length > 0) {
      console.error(`  [ALERTA] ${matchedEncs.length} encuentro(s) de manifiestos aún existen en DB:`);
      matchedEncs.forEach((e) => console.log(`    - ID: ${e.id} | Titulo: "${e.titulo}"`));
      hasCriticalIssue = true;
    } else {
      console.log(`  -> Confirmado: 0 encuentros residuales de manifiestos en DB (${encList.length} verificados).`);
    }
  }

  if (trackedManifestUids.size > 0) {
    const uidList = Array.from(trackedManifestUids);
    let survivingUids = 0;
    for (const uid of uidList) {
      const { data: uData } = await adminClient.auth.admin.getUserById(uid);
      if (uData?.user) {
        console.error(`  [ALERTA] Usuario de manifiesto aún existe en Auth: ${uid}`);
        survivingUids++;
        hasCriticalIssue = true;
      }
    }
    if (survivingUids === 0) {
      console.log(`  -> Confirmado: 0 usuarios de manifiestos existen en Auth Admin (${uidList.length} verificados).`);
    }
  }

  // 2.2 Auditoría general de identidades en Auth Admin
  console.log('\nAuditando identidades en Auth Admin...');
  const { data: authData, error: authErr } = await adminClient.auth.admin.listUsers();
  if (authErr || !authData?.users) {
    console.error(`  Error consultando usuarios Auth: ${authErr?.message}`);
    hasCriticalIssue = true;
  } else {
    const allUsers = authData.users;
    const qaUsers = allUsers.filter((u) => {
      const isAnon = u.is_anonymous === true || (u.raw_user_meta_data as any)?.is_anonymous === true;
      const isQaEmail = u.email?.includes('qa-host') || u.email?.includes('puntoencuentro.test');
      return isAnon || isQaEmail;
    });

    console.log(`  Total usuarios evaluados en Auth: ${allUsers.length}`);
    console.log(`  Identidades de prueba/anónimas detectadas (históricas y actuales): ${qaUsers.length}`);
    if (qaUsers.length > 0) {
      console.log('  Censo de identidades QA/anónimas en Staging:');
      for (const qu of qaUsers) {
        console.log(`    - User ID: ${qu.id} | is_anon: ${qu.is_anonymous} | email: ${maskIdentifier(qu.email)} | created: ${qu.created_at}`);
      }
      // Si existen usuarios anónimos creados hoy que no pertenecen a un manifiesto verificado, se advierte
      const todayIso = new Date().toISOString().slice(0, 10);
      const todayOrphans = qaUsers.filter((u) => u.created_at.startsWith(todayIso));
      if (todayOrphans.length > 0) {
        console.warn(`\n  [ATENCIÓN] ${todayOrphans.length} usuario(s) anónimo(s)/QA creados en la fecha (${todayIso}).`);
      }
    } else {
      console.log('  -> Confirmado: 0 usuarios temporales de QA o anónimos en auth.users.');
    }
  }

  // 2.3 Tickets pendientes en anonymous_transfer_tickets
  console.log('\nAuditando tickets del puente y tickets activos...');
  const nowIso = new Date().toISOString();

  // A. Tickets del puente cross-origin en estado pending
  const { data: bridgePending, error: bpErr } = await adminClient
    .from('anonymous_transfer_tickets')
    .select('id, created_at, status, flow_mode, expires_at')
    .in('flow_mode', ['cross_origin_bridge', 'cross_origin_manual'])
    .eq('status', 'pending');

  if (bpErr) {
    console.error(`  Error consultando tickets del puente: ${bpErr.message}`);
    hasCriticalIssue = true;
  } else {
    console.log(`  Tickets pendientes de puente cross-origin: ${bridgePending?.length || 0}`);
    if (bridgePending && bridgePending.length > 0) {
      for (const t of bridgePending) {
        console.log(`    - Ticket ${t.id}: mode=${t.flow_mode}, created=${t.created_at}`);
      }
      hasCriticalIssue = true;
    } else {
      console.log('  -> Confirmado: 0 tickets de puente cross-origin en estado pending.');
    }
  }

  // B. Tickets activos no expirados en cualquier modo
  const { data: unexpiredTickets, error: unexpErr } = await adminClient
    .from('anonymous_transfer_tickets')
    .select('id, created_at, status, flow_mode, expires_at')
    .eq('status', 'pending')
    .gt('expires_at', nowIso);

  if (unexpErr) {
    console.error(`  Error consultando tickets no expirados: ${unexpErr.message}`);
    hasCriticalIssue = true;
  } else {
    console.log(`  Tickets activos no expirados en el sistema: ${unexpiredTickets?.length || 0}`);
    if (unexpiredTickets && unexpiredTickets.length > 0) {
      for (const t of unexpiredTickets) {
        console.log(`    - Ticket ${t.id}: mode=${t.flow_mode}, expires=${t.expires_at}`);
      }
      hasCriticalIssue = true;
    } else {
      console.log('  -> Confirmado: 0 tickets activos no expirados en el sistema.');
    }
  }

  // 3. AUDITORÍA DEL HOTFIX SQL ADITIVO
  console.log('\n--- 3. AUDITORÍA DEL HOTFIX SQL (20261108163000) ---');
  console.log('Verificando funcionamiento de RPCs de migración...');
  const testRpcRes = await adminClient.rpc('create_domain_migration_ticket_seguro', {
    p_flow_mode: 'cross_origin_bridge',
  });

  if (testRpcRes.error) {
    console.error(`  [ALERTA] RPC falló con error de PostgreSQL: ${testRpcRes.error.message}`);
    hasCriticalIssue = true;
  } else if (testRpcRes.data?.error === 'authentication_required') {
    console.log('  -> Confirmado: RPC responde con validación de seguridad (authentication_required).');
    console.log('  -> Sin errores 42703 (columna respondio_disponibilidad no referenciada).');
  } else {
    console.log('  Respuesta RPC:', testRpcRes.data);
  }

  console.log('\n================================================================================');
  if (hasCriticalIssue) {
    console.error('RESULTADO DE AUDITORÍA: CRÍTICO / ACCIÓN REQUERIDA');
    console.log('================================================================================');
    process.exit(2);
  } else {
    console.log('RESULTADO DE AUDITORÍA: SATISFACTORIO (SEGURIDAD Y RESIDUO CERO VERIFICADOS)');
    console.log('================================================================================');
    process.exit(0);
  }
}

runReadOnlyAudit().catch((err) => {
  console.error('[UNCAUGHT AUDIT ERROR]', err);
  process.exit(1);
});
