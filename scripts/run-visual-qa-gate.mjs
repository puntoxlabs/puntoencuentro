import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const distDir = path.resolve('dist');
const screenshotDir = path.resolve('C:/Users/Minar/.gemini/antigravity/brain/70d9face-fb29-4084-a777-b0b51f8d52f3/scratch/screenshots');

if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true });
}

// MIME types for static server
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Simple static server for dist with SPA fallback
const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';

  let filePath = path.join(distDir, reqPath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    res.writeHead(500);
    res.end('Server error: ' + err.message);
  }
});

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

  async captureScreenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const fullPath = path.join(screenshotDir, filename);
    fs.writeFileSync(fullPath, buffer);
    console.log(`[Screenshot guardado] -> ${filename}`);
  }

  async waitForSelector(selector, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const exists = await this.evaluate(`Boolean(document.querySelector('${selector}'))`);
      if (exists) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timeout esperando selector: ${selector}`);
  }

  async typeInTextarea(selector, text) {
    await this.evaluate(`(() => {
      const ta = document.querySelector('${selector}');
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
  server.listen(4173, '127.0.0.1', async () => {
    console.log('Servidor de previsualización local activo en http://127.0.0.1:4173');

    const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const profileDir = path.join('C:\\Users\\Minar\\AppData\\Local\\Temp', 'chrome-qa-run-' + Date.now());
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
      // Connect to CDP
      let targetWs = null;
      for (let i = 0; i < 30; i++) {
        try {
          const resp = await fetch('http://127.0.0.1:9222/json/new?http://127.0.0.1:4173/create/ai', { method: 'PUT' });
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

      console.log('==================================================');
      console.log('1. PREPARACIÓN Y VERIFICACIÓN DEL ENTORNO LOCAL');
      console.log('==================================================');

      await new Promise((r) => setTimeout(r, 1000));

      // Habilitar acceso de prueba en localStorage para que AccessGate no bloquee
      await cdp.evaluate(`
        localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
      `);

      // Verificar URL local y origen
      const loadedUrl = await cdp.evaluate('window.location.href');
      console.log(`- URL cargada: ${loadedUrl}`);
      assert.ok(loadedUrl.startsWith('http://127.0.0.1:4173'), 'El navegador debe cargar el servidor local 127.0.0.1:4173');

      // Verificar versión del prompt local
      const promptFileContent = fs.readFileSync('supabase/functions/ai-interpret/prompt.ts', 'utf8');
      const localPromptMatch = promptFileContent.match(/export const PROMPT_VERSION = '([^']+)';/);
      const localPromptVersion = localPromptMatch ? localPromptMatch[1] : 'unknown';
      console.log(`- Versión del prompt local: v${localPromptVersion}`);
      console.log(`- Versión del prompt en Edge Function productiva: v1.7.0 (sin desplegar, preservando aislamiento)`);

      console.log('==================================================');
      console.log('2. VERIFICAR MENSAJE EXISTENTE (Desktop 1366x768)');
      console.log('==================================================');
      await cdp.setViewport(1366, 768);

      const existingMessage = '¡Hola a todos! Los espero con pizza casera.\nTraigan bebidas bien frías.\n¡Va a estar buenísimo!';
      const initialSession = {
        sessionId: 'test-session-001',
        draft: {
          title: 'Noche de Pizza',
          date: '2026-10-24',
          time: '21:00',
          modality: 'presencial',
          locationText: 'Casa de Juan',
          virtualLink: null,
          dateMode: 'fixed',
          dateOptions: null,
          description: existingMessage,
        },
        config: {
          invitationType: 'link_general',
          invitationTheme: 'classic',
          invitationTemplate: 'classic_default',
        },
        messages: [
          { id: '1', role: 'assistant', text: '¡Listo! Preparé el resumen con los datos de tu encuentro. Revisalo antes de crear.', timestamp: Date.now() },
        ],
        isComplete: true,
      };

      await cdp.evaluate(`
        sessionStorage.setItem('pe-ai-wizard-session', JSON.stringify({ state: ${JSON.stringify(initialSession)} }));
      `);

      await cdp.send('Page.navigate', { url: 'http://127.0.0.1:4173/create/ai' });
      await cdp.waitForSelector('[data-testid="complete-draft-summary"]');
      await new Promise((r) => setTimeout(r, 600));

      // Verificaciones en DOM real
      const sectionExists = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="draft-summary-description-section"]'))`);
      assert.equal(sectionExists, true, 'Debe existir la sección del mensaje en DraftSummary');

      const headerText = await cdp.evaluate(`document.querySelector('[data-testid="draft-summary-description-section"]').textContent`);
      assert.ok(headerText.toLowerCase().includes('mensaje para los invitados'), 'Debe incluir encabezado Mensaje para los invitados');

      const renderedDesc = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
      assert.equal(renderedDesc, existingMessage, 'El texto renderizado debe coincidir exactamente con draft.description');

      // Verificar whiteSpace pre-wrap
      const whiteSpaceStyle = await cdp.evaluate(`window.getComputedStyle(document.querySelector('[data-testid="draft-description-text"]')).whiteSpace`);
      assert.equal(whiteSpaceStyle, 'pre-wrap', 'El estilo computado debe ser white-space: pre-wrap para respetar saltos de línea');

      // Botón Editar visible
      const editBtnExists = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="edit-description-button"]'))`);
      assert.equal(editBtnExists, true, 'Botón Editar debe estar visible');

      // Desbordamiento horizontal nulo
      const hasHorizontalScroll = await cdp.evaluate(`document.body.scrollWidth > document.body.clientWidth`);
      assert.equal(hasHorizontalScroll, false, 'No debe haber desbordamiento horizontal en el resumen');

      await cdp.captureScreenshot('01_desktop_existing_message.png');
      console.log('✔ Mensaje existente verificado en Desktop con saltos de línea y sin desbordamiento.');

      console.log('==================================================');
      console.log('3. VERIFICAR AGREGAR Y EDITAR (Mobile mediano 390x844)');
      console.log('==================================================');
      await cdp.setViewport(390, 844);

      // Borrador sin mensaje (description = null)
      const emptyDescSession = {
        ...initialSession,
        draft: {
          ...initialSession.draft,
          description: null,
        },
      };

      await cdp.evaluate(`
        sessionStorage.setItem('pe-ai-wizard-session', JSON.stringify({ state: ${JSON.stringify(emptyDescSession)} }));
      `);

      await cdp.send('Page.navigate', { url: 'http://127.0.0.1:4173/create/ai' });
      await cdp.waitForSelector('[data-testid="complete-draft-summary"]');
      await new Promise((r) => setTimeout(r, 600));

      // 1. Verificar botón "+ Agregar mensaje"
      const addBtnText = await cdp.evaluate(`document.querySelector('[data-testid="add-description-button"]').textContent.trim()`);
      assert.ok(addBtnText.includes('+ Agregar mensaje'), 'Debe mostrar botón + Agregar mensaje');

      const optionalLabel = await cdp.evaluate(`document.querySelector('[data-testid="draft-summary-description-section"]').textContent`);
      assert.ok(optionalLabel.includes('Mensaje para los invitados (opcional)'), 'Debe indicar que es opcional');

      await cdp.captureScreenshot('02_mobile_without_message.png');

      // 2. Click "+ Agregar mensaje"
      await cdp.evaluate(`document.querySelector('[data-testid="add-description-button"]').click()`);
      await cdp.waitForSelector('[data-testid="description-textarea"]');
      await new Promise((r) => setTimeout(r, 300));

      // Comprobar apertura del BottomSheet accesible
      const sheetDialog = await cdp.evaluate(`document.querySelector('.pe-sheet-container[role="dialog"]').getAttribute('aria-label')`);
      assert.equal(sheetDialog, 'Editar mensaje para los invitados', 'El diálogo debe tener aria-label accesible');

      // 3. Escribir texto multilínea
      const newMultilineText = '¡Los esperamos el sábado!\nTraigan juegos de mesa y algo dulce para la merienda.\n¡Confirmar asistencia!';
      await cdp.typeInTextarea('[data-testid="description-textarea"]', newMultilineText);

      await cdp.captureScreenshot('03_mobile_editor_typing.png');

      // 4. Click Guardar
      await cdp.evaluate(`
        const buttons = Array.from(document.querySelectorAll('.pe-sheet-container button'));
        const saveBtn = buttons.find(b => b.textContent.trim() === 'Guardar');
        saveBtn.click();
      `);

      await new Promise((r) => setTimeout(r, 600));

      // Verificar que el resumen muestra el nuevo texto guardado
      const savedTextInSummary = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
      assert.equal(savedTextInSummary, newMultilineText, 'El texto guardado debe mostrarse en DraftSummary');

      await cdp.captureScreenshot('04_mobile_saved_message.png');

      // 5. Volver a abrir el editor, comprobar precarga, modificar y guardar nuevamente
      await cdp.evaluate(`document.querySelector('[data-testid="edit-description-button"]').click()`);
      await cdp.waitForSelector('[data-testid="description-textarea"]');
      await new Promise((r) => setTimeout(r, 300));

      const textareaValue = await cdp.evaluate(`document.querySelector('[data-testid="description-textarea"]').value`);
      assert.equal(textareaValue, newMultilineText, 'El editor debe abrir con el texto previamente guardado');

      const updatedText = newMultilineText + '\nPD: Hay pileta, traigan toalla.';
      await cdp.typeInTextarea('[data-testid="description-textarea"]', updatedText);

      await cdp.evaluate(`
        const buttons = Array.from(document.querySelectorAll('.pe-sheet-container button'));
        const saveBtn = buttons.find(b => b.textContent.trim() === 'Guardar');
        saveBtn.click();
      `);

      await new Promise((r) => setTimeout(r, 600));

      const finalSummaryText = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
      assert.equal(finalSummaryText, updatedText, 'El texto actualizado debe verse en DraftSummary');

      // Comprobar estado en sessionStorage canónico
      const sessionInStorage = await cdp.evaluate(`JSON.parse(sessionStorage.getItem('pe-ai-wizard-session')).state.draft.description`);
      assert.equal(sessionInStorage, updatedText, 'draft.description en sessionStorage debe coincidir exactamente');

      console.log('✔ Agregar y editar verificado exitosamente en navegador real.');

      console.log('==================================================');
      console.log('4. CANCELAR, DESCARTAR Y QUITAR');
      console.log('==================================================');
      
      // A. Abrir editor y cancelar sin cambios
      await cdp.evaluate(`document.querySelector('[data-testid="edit-description-button"]').click()`);
      await cdp.waitForSelector('[data-testid="description-textarea"]');
      await new Promise((r) => setTimeout(r, 300));

      await cdp.evaluate(`
        const cancelBtn = Array.from(document.querySelectorAll('.pe-sheet-container button')).find(b => b.textContent.trim() === 'Cancelar');
        cancelBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 400));

      const sheetClosed = await cdp.evaluate(`!document.querySelector('.pe-sheet-container')`);
      assert.equal(sheetClosed, true, 'El modal debe cerrarse directamente si no hay cambios');

      // B & C. Modificar texto y cancelar -> Confirmación de descarte
      await cdp.evaluate(`document.querySelector('[data-testid="edit-description-button"]').click()`);
      await cdp.waitForSelector('[data-testid="description-textarea"]');
      await new Promise((r) => setTimeout(r, 300));

      await cdp.typeInTextarea('[data-testid="description-textarea"]', 'Texto que no quiero guardar');

      await cdp.evaluate(`
        const cancelBtn = Array.from(document.querySelectorAll('.pe-sheet-container button')).find(b => b.textContent.trim() === 'Cancelar');
        cancelBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 400));

      // Comprobar diálogo "¿Descartar los cambios?"
      const confirmOverlayText = await cdp.evaluate(`document.querySelector('.pe-sheet-container').textContent`);
      assert.ok(confirmOverlayText.includes('¿Descartar los cambios?'), 'Debe aparecer diálogo de confirmación de descarte');
      assert.ok(confirmOverlayText.includes('Seguir editando'), 'Debe ofrecer opción Seguir editando');
      assert.ok(confirmOverlayText.includes('Descartar'), 'Debe ofrecer opción Descartar');

      await cdp.captureScreenshot('05_discard_confirm_dialog.png');

      // Probar "Seguir editando"
      await cdp.evaluate(`
        const keepEditingBtn = Array.from(document.querySelectorAll('.pe-sheet-container button')).find(b => b.textContent.trim() === 'Seguir editando');
        keepEditingBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 300));

      const stillHasModifiedText = await cdp.evaluate(`document.querySelector('[data-testid="description-textarea"]').value`);
      assert.equal(stillHasModifiedText, 'Texto que no quiero guardar', 'Seguir editando debe mantener el buffer');

      // Cancelar nuevamente y confirmar descarte
      await cdp.evaluate(`
        const cancelBtn = Array.from(document.querySelectorAll('.pe-sheet-container button')).find(b => b.textContent.trim() === 'Cancelar');
        cancelBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 300));

      await cdp.evaluate(`
        const discardBtn = Array.from(document.querySelectorAll('.pe-sheet-container button')).find(b => b.textContent.trim() === 'Descartar');
        discardBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 400));

      // El resumen conserva el texto anterior (updatedText)
      const summaryAfterDiscard = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
      assert.equal(summaryAfterDiscard, updatedText, 'Al descartar cambios, se debe conservar el valor anterior');

      // D, E, F. Quitar mensaje
      await cdp.evaluate(`document.querySelector('[data-testid="edit-description-button"]').click()`);
      await cdp.waitForSelector('[data-testid="remove-description-button"]');
      await new Promise((r) => setTimeout(r, 300));

      await cdp.captureScreenshot('06_remove_message_button.png');

      await cdp.evaluate(`document.querySelector('[data-testid="remove-description-button"]').click()`);
      await new Promise((r) => setTimeout(r, 600));

      // Verificar que reaparece "+ Agregar mensaje"
      const addBtnAfterRemove = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="add-description-button"]'))`);
      assert.equal(addBtnAfterRemove, true, 'Debe reaparecer + Agregar mensaje tras quitar');

      // Verificar que draft.description es null
      const descAfterRemove = await cdp.evaluate(`JSON.parse(sessionStorage.getItem('pe-ai-wizard-session')).state.draft.description`);
      assert.equal(descAfterRemove, null, 'draft.description debe ser null tras quitar');

      // Verificar integridad de los demás campos
      const draftState = await cdp.evaluate(`JSON.parse(sessionStorage.getItem('pe-ai-wizard-session')).state.draft`);
      assert.equal(draftState.title, 'Noche de Pizza', 'Título intacto');
      assert.equal(draftState.date, '2026-10-24', 'Fecha intacta');
      assert.equal(draftState.time, '21:00', 'Hora intacta');
      assert.equal(draftState.modality, 'presencial', 'Modalidad intacta');
      assert.equal(draftState.locationText, 'Casa de Juan', 'Lugar intacto');

      console.log('✔ Cancelar, descartar y quitar mensaje verificados.');

      console.log('==================================================');
      console.log('5. MOBILE PEQUEÑO (360x640) Y VIEWPORTS');
      console.log('==================================================');
      await cdp.setViewport(360, 640);

      // Abrir editor en mobile pequeño
      await cdp.evaluate(`document.querySelector('[data-testid="add-description-button"]').click()`);
      await cdp.waitForSelector('[data-testid="description-textarea"]');
      await new Promise((r) => setTimeout(r, 300));

      // Medir touch targets en botones interactivos (>= 44px de alto)
      const touchTargets = await cdp.evaluate(`
        const buttons = Array.from(document.querySelectorAll('.pe-sheet-container button'));
        return buttons.map(b => {
          const rect = b.getBoundingClientRect();
          return { text: b.textContent.trim() || b.getAttribute('aria-label'), width: rect.width, height: rect.height };
        });
      `);

      for (const t of touchTargets) {
        assert.ok(t.height >= 43.9, `Botón ${t.text} debe tener altura >= 44px (actual: ${t.height}px)`);
      }

      // Restricción de altura del modal a 85vh
      const sheetContainerStyle = await cdp.evaluate(`
        const el = document.querySelector('.pe-sheet-container');
        return { maxHeight: el.style.maxHeight, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      `);
      assert.equal(sheetContainerStyle.maxHeight, '85vh', 'El modal debe restringir altura a 85vh en mobile');

      // Comprobar autofoco en textarea
      const focusedElementTag = await cdp.evaluate(`document.activeElement.tagName.toLowerCase()`);
      assert.equal(focusedElementTag, 'textarea', 'El textarea debe recibir foco automáticamente');

      // Cerrar modal
      await cdp.evaluate(`
        const cancelBtn = Array.from(document.querySelectorAll('.pe-sheet-container button')).find(b => b.textContent.trim() === 'Cancelar');
        cancelBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 400));

      await cdp.captureScreenshot('07_mobile_small_360x640.png');
      console.log('✔ Mobile 360x640 verificado (touch targets >= 44px, autofoco, 85vh max height).');

      console.log('==================================================');
      console.log('6. MENSAJE EXTENSO ("Ver más" / "Ver menos")');
      console.log('==================================================');
      await cdp.setViewport(390, 844);

      const longMessage = 
        '¡Bienvenidos al gran encuentro anual de fin de año!\n\n' +
        'Este año nos volvemos a juntar en la quinta para compartir un día inolvidable. ' +
        'Tendremos asado al mediodía con opciones vegetarianas, pileta libre toda la tarde, torneo de metegol y música en vivo al atardecer.\n\n' +
        'Por favor confirmen con anticipación y aclaren si vienen acompañados o con niños para calcular las porciones. Traigan protector solar, toalla y ganas de divertirse.';

      const longMessageSession = {
        ...initialSession,
        draft: {
          ...initialSession.draft,
          description: longMessage,
        },
      };

      await cdp.evaluate(`
        sessionStorage.setItem('pe-ai-wizard-session', JSON.stringify({ state: ${JSON.stringify(longMessageSession)} }));
      `);

      await cdp.send('Page.navigate', { url: 'http://127.0.0.1:4173/create/ai' });
      await cdp.waitForSelector('[data-testid="complete-draft-summary"]');
      await new Promise((r) => setTimeout(r, 600));

      // 1. Vista compacta inicial: "Ver más"
      const expandBtnText = await cdp.evaluate(`document.querySelector('[data-testid="toggle-description-expand-button"]').textContent.trim()`);
      assert.equal(expandBtnText, 'Ver más', 'Mensaje extenso debe mostrar botón Ver más');

      const initialHeight = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').clientHeight`);
      await cdp.captureScreenshot('08_long_message_collapsed.png');

      // 2. Click "Ver más"
      await cdp.evaluate(`document.querySelector('[data-testid="toggle-description-expand-button"]').click()`);
      await new Promise((r) => setTimeout(r, 200));

      const expandedBtnText = await cdp.evaluate(`document.querySelector('[data-testid="toggle-description-expand-button"]').textContent.trim()`);
      assert.equal(expandedBtnText, 'Ver menos', 'Al expandir, el botón debe indicar Ver menos');

      const expandedHeight = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').clientHeight`);
      assert.ok(expandedHeight > initialHeight, `La altura expandida (${expandedHeight}px) debe ser mayor a la compacta (${initialHeight}px)`);

      const fullVisibleText = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
      assert.equal(fullVisibleText, longMessage, 'No debe truncarse el texto al estar expandido');

      await cdp.captureScreenshot('09_long_message_expanded.png');

      // 3. Click "Ver menos" para contraer
      await cdp.evaluate(`document.querySelector('[data-testid="toggle-description-expand-button"]').click()`);
      await new Promise((r) => setTimeout(r, 200));

      const collapsedAgainBtnText = await cdp.evaluate(`document.querySelector('[data-testid="toggle-description-expand-button"]').textContent.trim()`);
      assert.equal(collapsedAgainBtnText, 'Ver más', 'Al contraer, vuelve a mostrar Ver más');

      // 4. Editar mientras está expandido / contraído sin cambios preserva el texto exacto
      await cdp.evaluate(`document.querySelector('[data-testid="edit-description-button"]').click()`);
      await cdp.waitForSelector('[data-testid="description-textarea"]');
      await new Promise((r) => setTimeout(r, 300));

      const textareaLongValue = await cdp.evaluate(`document.querySelector('[data-testid="description-textarea"]').value`);
      assert.equal(textareaLongValue, longMessage, 'El editor debe contener el texto largo sin cortes');

      // Guardar sin modificaciones
      await cdp.evaluate(`
        const buttons = Array.from(document.querySelectorAll('.pe-sheet-container button'));
        const saveBtn = buttons.find(b => b.textContent.trim() === 'Guardar');
        saveBtn.click();
      `);
      await new Promise((r) => setTimeout(r, 500));

      const textAfterNoOpSave = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
      assert.equal(textAfterNoOpSave, longMessage, 'Guardar sin cambios preserva exactamente el texto largo');

      console.log('✔ Mensaje extenso ("Ver más" / "Ver menos", sin truncamiento) verificado.');

      console.log('==================================================');
      console.log('7. RECARGA REAL (F5 / Page.reload)');
      console.log('==================================================');

      // En el estado actual con longMessage, disparar recarga real de página F5
      await cdp.send('Page.reload', { ignoreCache: true });
      await cdp.waitForSelector('[data-testid="complete-draft-summary"]');
      await new Promise((r) => setTimeout(r, 600));

      const textAfterF5 = await cdp.evaluate(`document.querySelector('[data-testid="draft-description-text"]').textContent`);
      assert.equal(textAfterF5, longMessage, 'El mensaje completo debe persistir tras recarga real F5');

      const isToggleStillThere = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="toggle-description-expand-button"]'))`);
      assert.equal(isToggleStillThere, true, 'El botón Ver más debe persistir tras recarga real F5');

      await cdp.evaluate(`document.querySelector('[data-testid="edit-description-button"]').click()`);
      await cdp.waitForSelector('[data-testid="description-textarea"]');
      await new Promise((r) => setTimeout(r, 300));

      const textareaAfterF5 = await cdp.evaluate(`document.querySelector('[data-testid="description-textarea"]').value`);
      assert.equal(textareaAfterF5, longMessage, 'El editor debe recuperar el valor persistido tras F5');

      await cdp.captureScreenshot('10_real_reload_f5.png');
      console.log('✔ Recarga real F5 verificada con recuperación completa del estado.');

      console.log('\n==================================================');
      console.log('TODAS LAS COMPROBACIONES EN NAVEGADOR REAL PASARON (100% PASS)');
      console.log('==================================================\n');

    } finally {
      if (cdp) cdp.close();
      chrome.kill();
      server.close();
    }
  });
}

run().catch((err) => {
  console.error('Error fatal durante la ejecución del gate visual:', err);
  process.exit(1);
});
