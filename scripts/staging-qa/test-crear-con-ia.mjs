import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const CDP_PORT = 9260;
const VERCEL_URL = 'https://staging.puntoencuentro.com.ar';

async function testCrearConIa() {
  console.log('=== TEST CREAR CON IA EN STAGING ===');
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'chrome-test-ai-' + Date.now());
  const proc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-gpu',
    '--hide-scrollbars'
  ]);

  try {
    let targetWs = null;
    for (let i = 0; i < 30; i++) {
      try {
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(VERCEL_URL)}`, { method: 'PUT' });
        if (resp.ok) {
          const tab = await resp.json();
          targetWs = tab.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    if (!targetWs) throw new Error('No target WS');

    const ws = new WebSocket(targetWs);
    await new Promise(r => ws.on('open', r));

    let id = 1;
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const reqId = id++;
        const handler = (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.id === reqId) {
            ws.off('message', handler);
            if (msg.error) reject(msg.error);
            else resolve(msg.result);
          }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id: reqId, method, params }));
      });
    }

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    const consoleLogs = [];
    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'Runtime.consoleAPICalled') {
          consoleLogs.push({ type: msg.params.type, args: msg.params.args.map(a => a.value || a.description) });
        }
      } catch {}
    });

    // Desbloquear acceso test y navegar a /
    await send('Page.navigate', { url: VERCEL_URL });
    await new Promise(r => setTimeout(r, 1500));
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`
    });
    await send('Page.navigate', { url: VERCEL_URL });
    await new Promise(r => setTimeout(r, 2500));

    // Test Case 1: Escribir en Hero input "Cena en familia hoy a las 21" y click en "Hacer que pase"
    console.log('\n--- Probando Case 1: "Cena en familia hoy a las 21" ---');
    const inputRes = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const input = document.querySelector('textarea, input.home-intent-input, .home-intent-input textarea');
        if (!input) return { ok: false, error: 'no input' };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
                       Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
          setter.call(input, 'Cena en familia hoy a las 21');
        } else {
          input.value = 'Cena en familia hoy a las 21';
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const btn = document.querySelector('.home-intent-submit-btn');
        if (!btn) return { ok: false, error: 'no btn' };
        btn.click();
        return { ok: true, inputFound: true, btnFound: true };
      })()`
    });
    console.log('Submit result:', inputRes.result.value);

    // Esperar navegación a /create/ai
    await new Promise(r => setTimeout(r, 3000));

    const wizardState = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        return {
          currentUrl: window.location.href,
          pathname: window.location.pathname,
          title: document.title,
          h1: document.querySelector('h1, h2')?.innerText,
          messages: Array.from(document.querySelectorAll('.ai-chat-bubble, .ai-message, p')).map(p => p.innerText.trim()).filter(Boolean).slice(0, 10),
          hasFallbackBtn: Array.from(document.querySelectorAll('button')).some(b => b.innerText.toLowerCase().includes('manual')),
          allButtons: Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(Boolean),
        };
      })()`
    });

    console.log('Wizard state after submit:', JSON.stringify(wizardState.result.value, null, 2));

    console.log('\nCaptured relevant console logs:');
    const aiLogs = consoleLogs.filter(l => JSON.stringify(l).includes('aiService') || JSON.stringify(l).includes('interpret') || JSON.stringify(l).includes('functions'));
    console.log(JSON.stringify(aiLogs, null, 2));

  } catch (err) {
    console.error('Test error:', err);
  } finally {
    try { proc.kill(); } catch {}
  }
}

testCrearConIa();
