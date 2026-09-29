import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const targetUrl = 'https://puntoencuentro.vercel.app/create/ai';
const supabaseUrl = 'https://aurbicjwftjhwryhyjiq.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1cmJpY2p3ZnRqaHdyeWh5amlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwMjAwNzIsImV4cCI6MjA5MjU5NjA3Mn0.PvBu1eQjx7p7ECTM_pgy3_fwLQKhZqXJ4Mys_GWWr1s';

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.callbacks = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      }
    };
  }

  async send(method, params = {}) {
    await this.ready;
    const msgId = ++this.id;
    return new Promise((resolve, reject) => {
      this.callbacks.set(msgId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  async evaluate(expression) {
    let script = expression.trim();
    if ((script.includes('const ') || script.includes('let ')) && !script.startsWith('(')) {
      script = `(() => {\n${script}\n})()`;
    }
    const res = await this.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval exception: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await this.send('Emulation.setVisibleSize', { width, height });
  }

  async waitForSelector(selector, timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const exists = await this.evaluate(`Boolean(document.querySelector('${selector}'))`);
      if (exists) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timeout esperando selector: ${selector}`);
  }

  async typeInChat(text) {
    await this.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) throw new Error('Chat textarea no encontrada');
      ta.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    // Click send button
    await this.evaluate(`(() => {
      const btn = document.querySelector('button[aria-label="Enviar mensaje"]');
      if (btn) btn.click();
    })()`);
  }

  async typeInTextarea(selector, text) {
    await this.evaluate(`(() => {
      const ta = document.querySelector('${selector}');
      if (!ta) throw new Error('Textarea no encontrada: ${selector}');
      ta.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }

  close() {
    this.ws.close();
  }
}

async function run() {
  console.log('=============================================================');
  console.log('SMOKE TEST PRODUCTIVO — FRONTEND Y BACKEND EN VIVO');
  console.log(`URL Frontend: ${targetUrl}`);
  console.log(`URL Supabase: ${supabaseUrl}`);
  console.log('=============================================================');

  // Obtener sesión anónima legítima de Supabase
  const sb = createClient(supabaseUrl, supabaseAnonKey);
  const { data: authData, error: authError } = await sb.auth.signInAnonymously();
  if (authError || !authData.session) {
    throw new Error('Fallo al obtener sesión anónima de Supabase: ' + authError?.message);
  }
  console.log(`- Sesión de anfitrión autenticada obtenida (User ID: ${authData.user.id})`);

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join('C:\\Users\\Minar\\AppData\\Local\\Temp', 'chrome-smoke-live-' + Date.now());
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9222',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
  ]);

  let cdp = null;

  try {
    let targetWs = null;
    for (let i = 0; i < 30; i++) {
      try {
        const resp = await fetch('http://127.0.0.1:9222/json/new?' + encodeURIComponent(targetUrl), { method: 'PUT' });
        if (resp.ok) {
          const tab = await resp.json();
          targetWs = tab.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!targetWs) {
      throw new Error('Fallo al conectar con Chrome CDP');
    }

    cdp = new CdpClient(targetWs);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await cdp.setViewport(1280, 800);

    // Navegar y configurar localStorage
    await cdp.send('Page.navigate', { url: targetUrl });
    await new Promise((r) => setTimeout(r, 2000));

    await cdp.evaluate(`(() => {
      localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
      localStorage.setItem('sb-aurbicjwftjhwryhyjiq-auth-token', JSON.stringify(${JSON.stringify(authData.session)}));
    })()`);

    await cdp.send('Page.reload', { ignoreCache: true });
    await new Promise((r) => setTimeout(r, 2500));

    // =========================================================================
    // ESCENARIO A: Encuentro con fecha fija y mensaje
    // =========================================================================
    console.log('\n--- ESCENARIO A: Encuentro con fecha fija y mensaje ---');
    await cdp.waitForSelector('textarea', 15000);
    console.log('- Enviando prompt de creación con mensaje...');
    await cdp.typeInChat('Cena con amigos el 24 de octubre a las 21 en mi casa. Mensaje: Vengan con hambre que voy a cocinar asado');

    console.log('- Esperando interpretación de IA...');
    await cdp.waitForSelector('[data-testid="complete-draft-summary"]', 30000);
    console.log('✔ DraftSummary desplegado correctamente');

    const descSectionA = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="draft-summary-description-section"]'))`);
    assert.equal(descSectionA, true, 'Debe mostrar la sección del mensaje');

    const descTextA = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
    console.log(`- Mensaje interpretado por IA en vivo: "${descTextA}"`);
    assert.ok(descTextA.length > 5, 'El mensaje interpretado no debe estar vacío');

    // Editar manualmente
    console.log('- Abriendo editor manual...');
    await cdp.evaluate(`document.querySelector('[data-testid="edit-description-button"]').click()`);
    await cdp.waitForSelector('[data-testid="description-textarea"]', 5000);

    const updatedTextA = descTextA + '\nTraigan bebidas frías.';
    await cdp.typeInTextarea('[data-testid="description-textarea"]', updatedTextA);
    await cdp.evaluate(`
      const buttons = Array.from(document.querySelectorAll('.pe-sheet-container button'));
      const saveBtn = buttons.find(b => b.textContent.trim() === 'Guardar');
      saveBtn.click();
    `);
    await new Promise((r) => setTimeout(r, 800));

    const textAfterEditA = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
    assert.equal(textAfterEditA, updatedTextA, 'El mensaje editado manualmente debe actualizarse en DraftSummary');
    console.log('✔ Edición manual guardada correctamente');

    // Quitar mensaje
    console.log('- Quitando mensaje...');
    await cdp.evaluate(`document.querySelector('[data-testid="edit-description-button"]').click()`);
    await cdp.waitForSelector('[data-testid="remove-description-button"]', 5000);
    await cdp.evaluate(`document.querySelector('[data-testid="remove-description-button"]').click()`);
    await new Promise((r) => setTimeout(r, 800));

    const addBtnAfterRemove = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="add-description-button"]'))`);
    assert.equal(addBtnAfterRemove, true, 'Debe reaparecer + Agregar mensaje tras quitar');
    console.log('✔ Mensaje quitado exitosamente');

    // Volver a agregar mensaje
    console.log('- Volviendo a agregar mensaje...');
    await cdp.evaluate(`document.querySelector('[data-testid="add-description-button"]').click()`);
    await cdp.waitForSelector('[data-testid="description-textarea"]', 5000);
    const reAddedText = 'Nuevo mensaje agregado manualmente';
    await cdp.typeInTextarea('[data-testid="description-textarea"]', reAddedText);
    await cdp.evaluate(`
      const buttons = Array.from(document.querySelectorAll('.pe-sheet-container button'));
      const saveBtn = buttons.find(b => b.textContent.trim() === 'Guardar');
      saveBtn.click();
    `);
    await new Promise((r) => setTimeout(r, 800));

    const textAfterReAdd = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
    assert.equal(textAfterReAdd, reAddedText, 'El mensaje re-agregado debe aparecer en DraftSummary');
    console.log('✔ Mensaje re-agregado exitosamente');

    // F5 Persistencia
    console.log('- Probando persistencia tras recarga F5...');
    await cdp.send('Page.reload', { ignoreCache: true });
    await cdp.waitForSelector('[data-testid="complete-draft-summary"]', 15000);
    await new Promise((r) => setTimeout(r, 800));

    const textAfterF5 = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
    assert.equal(textAfterF5, reAddedText, 'El mensaje debe persistir tras F5');
    console.log('✔ Persistencia F5 verificada en producción');

    // =========================================================================
    // ESCENARIO B: Encuentro con coordinación y mensaje
    // =========================================================================
    console.log('\n--- ESCENARIO B: Encuentro con coordinación y mensaje ---');
    await cdp.evaluate(`sessionStorage.clear()`);
    await cdp.send('Page.navigate', { url: targetUrl });
    await new Promise((r) => setTimeout(r, 2000));
    await cdp.waitForSelector('textarea', 15000);

    console.log('- Enviando prompt de coordinación con mensaje...');
    await cdp.typeInChat('Cena en mi casa. Votemos el 17 de octubre a las 21 o el 18 de octubre a las 20. Mensaje: Avisen pronto');
    await new Promise((r) => setTimeout(r, 8000));

    // Confirmar opciones de coordinación si aparece la tarjeta
    console.log('- Confirmando opciones con "Sí, continuar"...');
    await cdp.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Sí, continuar'));
      if (btn) btn.click();
    })()`);
    await new Promise((r) => setTimeout(r, 2000));

    await cdp.waitForSelector('[data-testid="complete-draft-summary"]', 20000);
    const descTextB = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
    console.log(`- Mensaje coordinación interpretado en vivo: "${descTextB}"`);
    assert.ok(descTextB.toLowerCase().includes('avisen') || descTextB.toLowerCase().includes('pronto'), 'Debe reflejar el mensaje');

    const draftCoordState = await cdp.evaluate(`JSON.parse(sessionStorage.getItem('pe-ai-wizard-session')).state.draft`);
    assert.equal(draftCoordState.dateMode, 'coordination', 'El modo debe ser coordinación');
    assert.equal(draftCoordState.dateOptions.length, 2, 'Deben existir 2 alternativas');
    console.log('✔ Coordinación con 2 fechas y mensaje interpretada correctamente');

    // =========================================================================
    // ESCENARIO C: Encuentro sin mensaje
    // =========================================================================
    console.log('\n--- ESCENARIO C: Encuentro sin mensaje ---');
    await cdp.evaluate(`sessionStorage.clear()`);
    await cdp.send('Page.navigate', { url: targetUrl });
    await new Promise((r) => setTimeout(r, 2000));
    await cdp.waitForSelector('textarea', 15000);

    console.log('- Enviando prompt sin mensaje...');
    await cdp.typeInChat('Cena en la pizzeria el 15 de noviembre a las 20');
    await new Promise((r) => setTimeout(r, 8000));
    await cdp.waitForSelector('[data-testid="complete-draft-summary"]', 20000);

    const addBtnC = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="add-description-button"]'))`);
    assert.equal(addBtnC, true, 'En encuentro sin mensaje debe mostrar "+ Agregar mensaje"');
    const descTextCExists = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="draft-description-text"]'))`);
    assert.equal(descTextCExists, false, 'No debe haber texto de mensaje alucinado');
    console.log('✔ Encuentro sin mensaje verificado (sin alucinaciones, botón "+ Agregar mensaje" visible)');

    // =========================================================================
    // ESCENARIO D: Mensaje largo con "Ver más" / "Ver menos"
    // =========================================================================
    console.log('\n--- ESCENARIO D: Mensaje largo con "Ver más" / "Ver menos" ---');
    await cdp.evaluate(`document.querySelector('[data-testid="add-description-button"]').click()`);
    await cdp.waitForSelector('[data-testid="description-textarea"]', 5000);

    const veryLongMsg = '¡Bienvenidos al gran encuentro anual de fin de año!\n\nEste año nos volvemos a juntar en la quinta para compartir un día inolvidable. Tendremos asado al mediodía con opciones vegetarianas, pileta libre toda la tarde, torneo de metegol y música en vivo al atardecer.\n\nPor favor confirmen con anticipación y aclaren si vienen acompañados o con niños para calcular las porciones. Traigan protector solar, toalla y ganas de divertirse.';
    await cdp.typeInTextarea('[data-testid="description-textarea"]', veryLongMsg);
    await cdp.evaluate(`
      const buttons = Array.from(document.querySelectorAll('.pe-sheet-container button'));
      const saveBtn = buttons.find(b => b.textContent.trim() === 'Guardar');
      saveBtn.click();
    `);
    await new Promise((r) => setTimeout(r, 800));

    const toggleBtnTextD = await cdp.evaluate(`document.querySelector('[data-testid="toggle-description-expand-button"]').textContent.trim()`);
    assert.equal(toggleBtnTextD, 'Ver más', 'Debe mostrar "Ver más" para mensaje largo');
    console.log('- Estado inicial colapsado: botón "Ver más" presente');

    await cdp.evaluate(`document.querySelector('[data-testid="toggle-description-expand-button"]').click()`);
    await new Promise((r) => setTimeout(r, 300));
    const toggleBtnTextD2 = await cdp.evaluate(`document.querySelector('[data-testid="toggle-description-expand-button"]').textContent.trim()`);
    assert.equal(toggleBtnTextD2, 'Ver menos', 'Debe cambiar a "Ver menos" al expandir');
    console.log('- Estado expandido: botón "Ver menos" presente');

    await cdp.evaluate(`document.querySelector('[data-testid="toggle-description-expand-button"]').click()`);
    await new Promise((r) => setTimeout(r, 300));
    const toggleBtnTextD3 = await cdp.evaluate(`document.querySelector('[data-testid="toggle-description-expand-button"]').textContent.trim()`);
    assert.equal(toggleBtnTextD3, 'Ver más', 'Debe volver a "Ver más" al colapsar');
    console.log('✔ "Ver más" y "Ver menos" funcionando correctamente');

    // =========================================================================
    // ESCENARIO E: Modificación simultánea de fecha y mensaje
    // =========================================================================
    console.log('\n--- ESCENARIO E: Modificación simultánea de fecha y mensaje ---');
    console.log('- Enviando modificación compuesta...');
    await cdp.typeInChat('Cambiá la fecha al 20 de noviembre y hacé el mensaje más corto: Los esperamos con pizza');
    await new Promise((r) => setTimeout(r, 8000));
    await cdp.waitForSelector('[data-testid="complete-draft-summary"]', 20000);

    const descTextE = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
    console.log(`- Mensaje tras modificación compuesta: "${descTextE}"`);
    assert.ok(descTextE.toLowerCase().includes('pizza'), 'El mensaje debe haberse actualizado a pizza');

    const draftFinalE = await cdp.evaluate(`JSON.parse(sessionStorage.getItem('pe-ai-wizard-session')).state.draft`);
    assert.equal(draftFinalE.date, '2026-11-20', 'La fecha debe haberse actualizado al 20 de noviembre');
    assert.equal(draftFinalE.title, 'Cena', 'El título debe conservarse');
    assert.equal(draftFinalE.locationText, 'la pizzeria', 'El lugar debe conservarse');
    console.log('✔ Modificación simultánea de fecha y mensaje verificada exitosamente');

    console.log('\n=============================================================');
    console.log('SMOKE TEST PRODUCTIVO COMPLETO: 5 ESCENARIOS (A, B, C, D, E) PASS');
    console.log('SE DETIENE ANTES DE "CREAR ENCUENTRO" (SIN CREAR ENCUENTROS)');
    console.log('=============================================================\n');

  } finally {
    if (cdp) cdp.close();
    chrome.kill();
  }
}

run().catch((err) => {
  console.error('Error fatal durante el smoke test productivo:', err);
  process.exit(1);
});
