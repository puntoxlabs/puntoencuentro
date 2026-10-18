/**
 * Suite E2E Playwright: Flujo Completo de Invitaciones Internas V1
 *
 * 10 Escenarios comprobados de punta a punta:
 *  1. Creación de encuentro privado en Supabase Staging.
 *  2. Envío de invitación interna desde la UI del organizador.
 *  3. Recepción de notificación en Inbox del invitado.
 *  4. Acceso al detalle desde la notificación en navegador.
 *  5. Aceptación y reflejo en tiempo real en la gestión del organizador.
 *  6. Rechazo de otra invitación y limpieza del participante.
 *  7. Cancelación de una solicitud pendiente por el organizador.
 *  8. Protección de dirección privada antes de aceptar (y revelación posterior).
 *  9. Compatibilidad con coordinación de fechas (token emitido sin fecha fija).
 * 10. Ausencia de enumeración observable ante correos inexistentes.
 */

import { chromium, type Browser } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertStagingEnvironment,
  getStagingSecretKey,
  getStagingPublishableKey,
  getVercelBypassSecret,
} from './lib/environment-guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = 5173;
const LOCAL_URL = `http://localhost:${PORT}`;
const TARGET_URL = (process.env.BASE_URL || LOCAL_URL).replace(/\/$/, '');
const isLocalTarget = TARGET_URL.includes('localhost') || TARGET_URL.includes('127.0.0.1');

const SUPABASE_STAGING_URL = 'https://wougfhfwqgmxhgvjqoua.supabase.co';
const STAGING_REF = 'wougfhfwqgmxhgvjqoua';

// Fail-closed si target no es Staging ni Local
assertStagingEnvironment(SUPABASE_STAGING_URL);
assertStagingEnvironment(STAGING_REF);

const bypassSecret = getVercelBypassSecret();

const admin = createClient(SUPABASE_STAGING_URL, getStagingSecretKey(), {
  auth: { persistSession: false },
});
const publishableKey = getStagingPublishableKey();

const runId = Math.random().toString(36).substring(2, 10);
const createdUserIds: string[] = [];
const createdEncounterIds: string[] = [];
let browser: Browser | null = null;
let viteProcess: ChildProcess | null = null;

function waitForServer(url: string, timeoutMs: number = 25000): Promise<void> {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        if (res.statusCode && res.statusCode < 500) {
          resolve();
        } else {
          retry();
        }
      });
      req.on('error', () => retry());
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`Timeout esperando frontend en ${url}`));
      } else {
        setTimeout(check, 500);
      }
    };

    check();
  });
}

async function cleanup() {
  console.log('\n[Cleanup] Iniciando limpieza de fixtures QA en Staging...');
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }

  // Eliminar encuentros creados (ON DELETE CASCADE limpia solicitudes, invitaciones y participantes)
  for (const id of createdEncounterIds) {
    try {
      await admin.from('encuentros').delete().eq('id', id);
    } catch {
      /* ignore */
    }
  }

  // Eliminar usuarios creados
  for (const id of createdUserIds) {
    try {
      await admin.auth.admin.deleteUser(id);
    } catch {
      /* ignore */
    }
  }

  // Detener servidor local Vite si fue iniciado por el script
  if (viteProcess && !viteProcess.killed) {
    console.log('[Cleanup] Deteniendo servidor local de Vite...');
    try {
      if (process.platform === 'win32' && viteProcess.pid) {
        const { execSync } = await import('child_process');
        execSync(`taskkill /pid ${viteProcess.pid} /T /F`, { stdio: 'ignore' });
      } else {
        viteProcess.kill('SIGTERM');
      }
    } catch {}
  }

  console.log('[Cleanup] Fixtures QA eliminados exitosamente.');
}

process.once('SIGINT', async () => {
  await cleanup();
  process.exit(1);
});
process.once('SIGTERM', async () => {
  await cleanup();
  process.exit(1);
});

async function runInternalInvitationsE2E() {
  console.log('================================================================');
  console.log('E2E PLAYWRIGHT: INVITACIONES INTERNAS V1 — SUITE COMPLETA 10 ESCENARIOS');
  console.log(`Frontend Target: ${TARGET_URL}`);
  console.log(`Backend Target:  ${SUPABASE_STAGING_URL} (Staging)`);
  console.log(`Run ID:          ${runId}`);
  console.log('================================================================\n');

  try {
    // 0. Comprobar que la migración está efectivamente aplicada en Staging
    const { error: rpcCheckError } = await admin.rpc('enviar_invitacion_interna_seguro', {
      p_encuentro_id: '00000000-0000-0000-0000-000000000000',
      p_email: 'preflight@puntoencuentro.test',
      p_mensaje: null,
    });

    if (rpcCheckError && rpcCheckError.message.includes('Could not find the function public.enviar_invitacion_interna_seguro')) {
      throw new Error('FALLO CRÍTICO: La migración 20261018180000_internal_invitations_v1.sql no está aplicada en Staging.');
    }
    console.log('[Preflight] Backend de Staging verificado: RPCs de invitaciones internas activas y disponibles.\n');

    // Iniciar Vite local si se apunta a localhost y no está respondiendo
    if (isLocalTarget) {
      let isUp = false;
      try {
        await waitForServer(TARGET_URL, 1500);
        isUp = true;
      } catch {
        isUp = false;
      }

      if (!isUp) {
        console.log('[Frontend] Iniciando servidor Vite local conectado a Staging...');
        viteProcess = spawn('npx', ['--workspaces=false', 'vite', '--port', String(PORT)], {
          cwd: rootDir,
          stdio: 'pipe',
          shell: true,
          env: {
            ...process.env,
            VITE_APP_ENV: 'staging',
          },
        });
        await waitForServer(TARGET_URL, 30000);
        console.log(`   -> Servidor local listo en ${TARGET_URL}\n`);
      }
    }

    // 1. Creación de dos cuentas permanentes en Staging
    console.log('[1/10] Creando 2 cuentas permanentes de prueba en Supabase Staging...');
    async function createPermanentUser(role: string, name: string) {
      const email = `qa-inv-run-${runId}-${role}@puntoencuentro.test`;
      const password = 'QaPassword123!Secure';
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: name,
          is_e2e_automation_fixture: true,
          e2e_run_id: runId,
          created_at: Date.now(),
        },
      });
      if (error || !data.user) {
        throw new Error(`Error creando usuario ${role}: ${error?.message}`);
      }
      createdUserIds.push(data.user.id);

      const client = createClient(SUPABASE_STAGING_URL, publishableKey, {
        auth: { persistSession: false },
      });
      const { data: authData, error: authErr } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (authErr || !authData.session) {
        throw new Error(`Error autenticando usuario ${role}: ${authErr?.message}`);
      }

      return {
        id: data.user.id,
        email,
        session: authData.session,
      };
    }

    const hostUser = await createPermanentUser('host', 'Organizador E2E Invitaciones');
    const guestUser = await createPermanentUser('guest', 'Invitado E2E Permanente');

    console.log(`   Host:  ${hostUser.email} (${hostUser.id})`);
    console.log(`   Guest: ${guestUser.email} (${guestUser.id})\n`);

    function createAuthClient(session: any) {
      return createClient(SUPABASE_STAGING_URL, publishableKey, {
        auth: { persistSession: false },
        global: {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        },
      });
    }

    const hostClient = createAuthClient(hostUser.session);
    const guestClient = createAuthClient(guestUser.session);

    // Iniciar browser Playwright
    browser = await chromium.launch({ headless: true });

    async function createContext(sessionData: any) {
      const context = await browser!.newContext({
        viewport: { width: 1280, height: 800 },
      });

      if (!isLocalTarget && bypassSecret) {
        try {
          await context.request.get(TARGET_URL, {
            headers: {
              'x-vercel-protection-bypass': bypassSecret,
              'x-vercel-set-bypass-cookie': 'true',
            },
          });
        } catch {
          /* ignore */
        }
      }

      const page = await context.newPage();
      await page.addInitScript(({ session, storageKey }) => {
        window.localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({
          granted: true,
          at: Date.now(),
        }));
        if (session && storageKey) {
          window.localStorage.setItem(storageKey, JSON.stringify(session));
        }
      }, {
        session: sessionData,
        storageKey: `sb-${STAGING_REF}-auth-token`,
      });
      return { context, page };
    }

    // =========================================================================
    // ESCENARIO 1: Creación de encuentro privado
    // =========================================================================
    console.log('[2/10] Escenario 1: Creando encuentro privado con logística confidencial...');
    const privateLocation = `Calle Secreta ${runId}, Depto 7B (Privado)`;
    const { data: encData, error: encErr } = await admin.from('encuentros').insert({
      titulo: `[QA-E2E:${runId}] Cena Privada de Primavera`,
      descripcion: `[AUTOMATED_QA_FIXTURE:${runId}] Encuentro de prueba para invitaciones internas`,
      host_id: hostUser.id,
      fecha: new Date(Date.now() + 86400000 * 4).toISOString().split('T')[0],
      hora: '21:00:00',
      modalidad: 'presencial',
      lugar_texto: privateLocation,
      date_mode: 'fixed',
      max_participants: 6,
      tipo_invitacion: 'individual',
      estado: 'activo',
    }).select().single();

    if (encErr || !encData) {
      throw new Error(`Error creando encuentro privado: ${encErr?.message}`);
    }
    createdEncounterIds.push(encData.id);
    console.log(`   ✓ Encuentro creado en Staging: ${encData.id}`);

    // =========================================================================
    // ESCENARIO 2: Envío de invitación interna desde la interfaz
    // =========================================================================
    console.log('[3/10] Escenario 2: Host envía invitación interna a la cuenta del invitado...');
    const { page: hostPage } = await createContext(hostUser.session);
    await hostPage.goto(`${TARGET_URL}/meet/${encData.id}`, { waitUntil: 'networkidle' });

    const emailInput = hostPage.locator('#internal-invite-email');
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.fill(guestUser.email);

    const msgInput = hostPage.locator('#internal-invite-msg');
    if (await msgInput.isVisible()) {
      await msgInput.fill('¡Hola! Te invito a cenar este fin de semana.');
    }

    const sendBtn = hostPage.locator('.pe-internal-invites-submit-btn');
    await sendBtn.click();

    // Esperar feedback visual de éxito
    const feedbackEl = hostPage.locator('.pe-internal-invites-feedback--success');
    await feedbackEl.waitFor({ state: 'visible', timeout: 10000 });
    console.log('   ✓ Confirmación visual de envío recibida en UI del host.');

    // Verificar en base de datos de Staging
    const { data: solDb } = await admin
      .from('solicitudes_invitacion_interna')
      .select('id, estado, invitacion_id')
      .eq('encuentro_id', encData.id)
      .eq('destinatario_email', guestUser.email)
      .single();

    if (!solDb || solDb.estado !== 'pendiente' || !solDb.invitacion_id) {
      throw new Error('FALLO DB: La solicitud de invitación no se persistió en solicitudes_invitacion_interna.');
    }

    const { data: invDb } = await admin
      .from('invitaciones_internas')
      .select('id, estado, destinatario_id, participante_id')
      .eq('id', solDb.invitacion_id)
      .single();

    if (!invDb || invDb.estado !== 'pendiente' || invDb.destinatario_id !== guestUser.id) {
      throw new Error('FALLO DB: La invitación real no se persistió en invitaciones_internas.');
    }
    console.log(`   ✓ Persistencia verificada en Staging: Solicitud ${solDb.id} -> Invitación ${invDb.id}`);

    // =========================================================================
    // ESCENARIO 3: Recepción de notificación en Inbox
    // =========================================================================
    console.log('[4/10] Escenario 3: Invitado comprueba recepción en su Inbox...');
    const { data: inboxNotif } = await admin
      .from('inbox_notifications')
      .select('id, notification_type, target_id, deep_link, title')
      .eq('recipient_user_id', guestUser.id)
      .eq('target_id', invDb.id)
      .single();

    if (!inboxNotif || inboxNotif.notification_type !== 'internal_invitation') {
      throw new Error('FALLO INBOX: No se insertó la notificación atómica en Inbox para el invitado.');
    }
    console.log(`   ✓ Notificación en Inbox confirmada: ${inboxNotif.title} -> Deep link: ${inboxNotif.deep_link}`);

    // =========================================================================
    // ESCENARIO 4 y 8: Acceso al detalle & Protección de logística privada
    // =========================================================================
    console.log('[5/10] Escenario 4 & 8: Invitado accede al detalle y se verifica privacidad...');
    const { page: guestPage } = await createContext(guestUser.session);
    await guestPage.goto(`${TARGET_URL}/invitation/${invDb.id}`, { waitUntil: 'networkidle' });

    // Verificar renderizado del detalle
    const guestTitleEl = guestPage.locator('.pe-inv-guest-title');
    await guestTitleEl.waitFor({ state: 'visible', timeout: 10000 });
    const renderedTitle = await guestTitleEl.textContent();
    if (!renderedTitle?.includes(encData.titulo)) {
      throw new Error(`Detalle no muestra el título esperado. Mostrado: ${renderedTitle}`);
    }

    // Comprobar invariante de privacidad ANTES de aceptar
    const pageHtmlBefore = await guestPage.content();
    if (pageHtmlBefore.includes(privateLocation)) {
      throw new Error(`FALLO CRÍTICO DE PRIVACIDAD: La dirección privada "${privateLocation}" fue expuesta antes de aceptar.`);
    }
    console.log('   ✓ Invariante de privacidad comprobada: la dirección privada NO se expone mientras está pendiente.');

    // =========================================================================
    // ESCENARIO 5: Aceptación y reflejo en gestión del organizador
    // =========================================================================
    console.log('[6/10] Escenario 5: Invitado acepta la invitación desde la interfaz...');
    const acceptBtn = guestPage.locator('button:has-text("Aceptar invitación")');
    await acceptBtn.waitFor({ state: 'visible', timeout: 10000 });
    await acceptBtn.click();

    // Comprobar banner de aceptación en el invitado
    const acceptedBanner = guestPage.locator('.pe-inv-guest-banner--aceptada');
    await acceptedBanner.waitFor({ state: 'visible', timeout: 10000 });

    // Ahora que fue aceptada, la dirección privada DEBE revelarse al participante
    const pageHtmlAfter = await guestPage.content();
    if (!pageHtmlAfter.includes(privateLocation)) {
      throw new Error('FALLO FUNCIONAL: La dirección privada no se reveló tras aceptar la invitación.');
    }
    console.log('   ✓ Logística revelada exitosamente al invitado tras la aceptación.');

    // Verificar en Staging DB
    const { data: invDbAccepted } = await admin.from('invitaciones_internas').select('estado').eq('id', invDb.id).single();
    const { data: solDbAccepted } = await admin.from('solicitudes_invitacion_interna').select('estado').eq('id', solDb.id).single();
    const { data: partDbAccepted } = await admin.from('participantes').select('estado').eq('id', invDb.participante_id).single();

    if (invDbAccepted?.estado !== 'aceptada' || solDbAccepted?.estado !== 'aceptada' || partDbAccepted?.estado !== 'confirmado') {
      throw new Error(`FALLO DB: Estados tras aceptación incorrectos. Inv: ${invDbAccepted?.estado}, Sol: ${solDbAccepted?.estado}, Part: ${partDbAccepted?.estado}`);
    }
    console.log('   ✓ Estados en DB verificados: Invitación=aceptada, Solicitud=aceptada, Participante=confirmado.');

    // Host actualiza y ve al invitado confirmado
    await hostPage.reload({ waitUntil: 'networkidle' });
    const hostHtml = await hostPage.content();
    if (!hostHtml.includes('Aceptada') && !hostHtml.includes('aceptada')) {
      throw new Error('FALLO UI HOST: La vista del organizador no refleja el badge de aceptación.');
    }
    console.log('   ✓ Organizador visualiza la respuesta aceptada en su listado.');

    // =========================================================================
    // ESCENARIO 6: Rechazo de otra invitación
    // =========================================================================
    console.log('[7/10] Escenario 6: Rechazo voluntario de otra invitación...');
    const { data: enc2 } = await admin.from('encuentros').insert({
      titulo: `[QA-E2E:${runId}] Cena para Probar Rechazo`,
      host_id: hostUser.id,
      fecha: new Date(Date.now() + 86400000 * 5).toISOString().split('T')[0],
      hora: '20:00:00',
      modalidad: 'presencial',
      tipo_invitacion: 'individual',
      estado: 'activo',
    }).select().single();
    createdEncounterIds.push(enc2.id);

    // Host envía invitación con su cliente autenticado
    const { data: sendRes2, error: sendErr2 } = await hostClient.rpc('enviar_invitacion_interna_seguro', {
      p_encuentro_id: enc2.id,
      p_email: guestUser.email,
    });
    if (sendErr2 || !(sendRes2 as any)?.ok) {
      throw new Error(`Error enviando invitación 2: ${sendErr2?.message || JSON.stringify(sendRes2)}`);
    }
    const solId2 = (sendRes2 as any).invitation_id;
    const { data: solRow2 } = await admin.from('solicitudes_invitacion_interna').select('invitacion_id').eq('id', solId2).single();
    const invId2 = solRow2.invitacion_id;

    // Invitado abre y rechaza
    await guestPage.goto(`${TARGET_URL}/invitation/${invId2}`, { waitUntil: 'networkidle' });
    const rejectBtn = guestPage.locator('button:has-text("Rechazar")');
    await rejectBtn.waitFor({ state: 'visible', timeout: 10000 });
    await rejectBtn.click();

    const rejectedBanner = guestPage.locator('.pe-inv-guest-banner--rechazada');
    await rejectedBanner.waitFor({ state: 'visible', timeout: 10000 });

    // Verificar en DB
    const { data: invDbRejected } = await admin.from('invitaciones_internas').select('estado').eq('id', invId2).single();
    const { data: solDbRejected } = await admin.from('solicitudes_invitacion_interna').select('estado').eq('id', solId2).single();
    if (invDbRejected?.estado !== 'rechazada' || solDbRejected?.estado !== 'rechazada') {
      throw new Error('FALLO DB: El rechazo no actualizó los estados a rechazada.');
    }
    console.log('   ✓ Rechazo completado: Invitación=rechazada, Solicitud=rechazada.');

    // =========================================================================
    // ESCENARIO 7: Cancelación de una solicitud pendiente por el organizador
    // =========================================================================
    console.log('[8/10] Escenario 7: Cancelación de una solicitud pendiente...');
    const { data: sendRes3, error: sendErr3 } = await hostClient.rpc('enviar_invitacion_interna_seguro', {
      p_encuentro_id: encData.id,
      p_email: `otro-invitado-${runId}@puntoencuentro.test`,
    });
    if (sendErr3 || !(sendRes3 as any)?.ok) {
      throw new Error(`Error enviando invitación 3: ${sendErr3?.message || JSON.stringify(sendRes3)}`);
    }
    const solId3 = (sendRes3 as any).invitation_id;

    // Host cancela desde RPC
    const { data: cancelRes, error: cancelErr } = await hostClient.rpc('cancelar_invitacion_interna_seguro', {
      p_invitacion_id: solId3,
    });
    if (cancelErr || !(cancelRes as any)?.ok || (cancelRes as any)?.estado !== 'cancelada') {
      throw new Error(`FALLO CANCELACIÓN: Error al cancelar solicitud ${solId3}: ${cancelErr?.message}`);
    }

    const { data: solDbCancelled } = await admin.from('solicitudes_invitacion_interna').select('estado').eq('id', solId3).single();
    if (solDbCancelled?.estado !== 'cancelada') {
      throw new Error('FALLO DB: La solicitud no quedó en estado cancelada.');
    }
    console.log('   ✓ Solicitud cancelada exitosamente.');

    // =========================================================================
    // ESCENARIO 9: Compatibilidad con coordinación de fechas
    // =========================================================================
    console.log('[9/10] Escenario 9: Compatibilidad con encuentros en modo coordinación...');
    const { data: encCoord } = await admin.from('encuentros').insert({
      titulo: `[QA-E2E:${runId}] Asado con Coordinación`,
      host_id: hostUser.id,
      modalidad: 'presencial',
      date_mode: 'coordination',
      tipo_invitacion: 'individual',
      estado: 'activo',
    }).select().single();
    createdEncounterIds.push(encCoord.id);

    const { data: sendCoord, error: sendCoordErr } = await hostClient.rpc('enviar_invitacion_interna_seguro', {
      p_encuentro_id: encCoord.id,
      p_email: guestUser.email,
    });
    if (sendCoordErr || !(sendCoord as any)?.ok) {
      throw new Error(`Error enviando invitación coordinación: ${sendCoordErr?.message || JSON.stringify(sendCoord)}`);
    }
    const solCoordId = (sendCoord as any).invitation_id;
    const { data: solCoordRow } = await admin.from('solicitudes_invitacion_interna').select('invitacion_id').eq('id', solCoordId).single();
    const invCoordId = solCoordRow.invitacion_id;

    await guestPage.goto(`${TARGET_URL}/invitation/${invCoordId}`, { waitUntil: 'networkidle' });
    const coordNotice = guestPage.locator('text=Se coordinará la fecha entre los participantes');
    await coordNotice.waitFor({ state: 'visible', timeout: 10000 });

    const acceptCoordBtn = guestPage.locator('button:has-text("Aceptar invitación")');
    await acceptCoordBtn.click();
    await guestPage.waitForTimeout(1500);

    const { data: invCoordDb } = await admin.from('invitaciones_internas').select('estado, participante_id').eq('id', invCoordId).single();
    const { data: partCoordDb } = await admin.from('participantes').select('estado, token_invitacion').eq('id', invCoordDb.participante_id).single();

    if (invCoordDb.estado !== 'aceptada') {
      throw new Error('FALLO COORDINACIÓN: Invitación no quedó aceptada.');
    }
    if (partCoordDb.estado !== 'pendiente' || !partCoordDb.token_invitacion) {
      throw new Error('FALLO COORDINACIÓN: El participante en coordinación debe seguir pendiente hasta votar.');
    }
    console.log('   ✓ Coordinación de fechas respetada: Invitación aceptada y token individual emitido.');

    // =========================================================================
    // ESCENARIO 10: Ausencia de enumeración observable ante correos inexistentes
    // =========================================================================
    console.log('[10/10] Escenario 10: Comprobación de no-enumeración con correo inexistente...');
    const fakeEmail = `cuenta-totalmente-inexistente-${runId}@ejemplo.test`;

    await hostPage.goto(`${TARGET_URL}/meet/${encData.id}`, { waitUntil: 'networkidle' });
    const emailInputFake = hostPage.locator('#internal-invite-email');
    await emailInputFake.waitFor({ state: 'visible', timeout: 10000 });
    await emailInputFake.fill(fakeEmail);
    const sendBtnFake = hostPage.locator('.pe-internal-invites-submit-btn');
    await sendBtnFake.click();

    // Esperar respuesta exitosa neutra en UI
    const feedbackFake = hostPage.locator('.pe-internal-invites-feedback--success');
    await feedbackFake.waitFor({ state: 'visible', timeout: 10000 });
    const feedbackText = await feedbackFake.textContent();
    if (!feedbackText?.includes('Si el correo corresponde a una cuenta registrada')) {
      throw new Error(`Mensaje neutral no mostrado. Obtenido: ${feedbackText}`);
    }

    // Verificar en DB de Staging que NO se crearon invitaciones reales ni usuarios falsos
    const { data: fakeInvRows } = await admin.from('invitaciones_internas').select('id').eq('destinatario_email', fakeEmail);
    if (fakeInvRows && fakeInvRows.length > 0) {
      throw new Error('FALLO DE PRIVACIDAD: Se creó un registro en invitaciones_internas para un correo inexistente.');
    }

    const { data: fakeUsers } = await admin.auth.admin.listUsers();
    if (fakeUsers.users.some(u => u.email === fakeEmail)) {
      throw new Error('FALLO DE PRIVACIDAD: Se creó un usuario ficticio en auth.users.');
    }

    // Pero SÍ se registró la solicitud del host como pendiente en solicitudes_invitacion_interna
    const { data: fakeSol } = await admin.from('solicitudes_invitacion_interna').select('estado').eq('destinatario_email', fakeEmail).single();
    if (fakeSol?.estado !== 'pendiente') {
      throw new Error('FALLO FUNCIONAL: La solicitud del organizador no figura como pendiente.');
    }
    console.log('   ✓ No-enumeración comprobada: UI neutra, cero registros colaterales y solicitud registrada.\n');

    console.log('================================================================');
    console.log('TODOS LOS 10 ESCENARIOS E2E EN STAGING COMPLETADOS CON ÉXITO');
    console.log('================================================================\n');

  } catch (err: any) {
    console.error(`\n❌ Error en prueba E2E de Invitaciones Internas: ${err.message}`);
    throw err;
  } finally {
    await cleanup();
  }
}

runInternalInvitationsE2E().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
