import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const CDP_PORT = 9242;

async function fase0Audit() {
  console.log('=== FASE 0: VERIFICACIÓN PREVIA OBLIGATORIA ===\n');
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'chrome-fase0-' + Date.now());
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
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?https://puntoencuentro.com.ar/preview/home-gsap`, { method: 'PUT' });
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

    const requests = [];
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'Network.requestWillBeSent') {
          requests.push(msg.params.request.url);
        }
      } catch {}
    });

    // 1. Verificar / (Home principal)
    requests.length = 0;
    await send('Page.navigate', { url: 'https://puntoencuentro.com.ar/' });
    await new Promise(r => setTimeout(r, 2500));
    const homeGsap = requests.some(u => u.includes('HomeDynamicCanvasGsap') && u.endsWith('.js'));
    console.log('1. Home principal (/):');
    console.log(`   - Descargó GSAP: ${homeGsap ? 'SÍ (ERROR)' : 'NO (CORRECTO)'}`);

    // 2. Verificar /preview/home-d
    requests.length = 0;
    await send('Page.navigate', { url: 'https://puntoencuentro.com.ar/preview/home-d' });
    await new Promise(r => setTimeout(r, 2500));
    const homeDGsap = requests.some(u => u.includes('HomeDynamicCanvasGsap') && u.endsWith('.js'));
    console.log('2. Preview Home D (/preview/home-d):');
    console.log(`   - Descargó GSAP: ${homeDGsap ? 'SÍ (ERROR)' : 'NO (CORRECTO)'}`);

    // 3. Verificar /preview/home-gsap
    // Autenticar primero en dominio
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`
    });
    requests.length = 0;
    await send('Page.navigate', { url: 'https://puntoencuentro.com.ar/preview/home-gsap' });
    await new Promise(r => setTimeout(r, 3500));

    const previewGsapLoaded = requests.some(u => u.includes('HomeDynamicCanvasGsap') && u.endsWith('.js'));
    console.log('3. Preview Home GSAP (/preview/home-gsap):');
    console.log(`   - Descargó GSAP chunk: ${previewGsapLoaded ? 'SÍ (CORRECTO)' : 'NO (ERROR)'}`);

    const domInfo = (await send('Runtime.evaluate', {
      expression: `(() => {
        const isCanvasGsapMounted = Boolean(document.querySelector('.home-dynamic-canvas--gsap'));
        const canvasStitchMounted = Boolean(document.querySelector('.home-dynamic-canvas--stitch'));
        const previewBadge = Array.from(document.querySelectorAll('button, div, span')).find(el => el.textContent && el.textContent.includes('Preview GSAP'))?.textContent?.trim();
        const switcherPresent = Boolean(document.querySelector('.home-variant-switcher'));
        const metaRobots = document.querySelector('meta[name="robots"]')?.getAttribute('content');
        
        // Tags y sus textos
        const tags = Array.from(document.querySelectorAll('.home-gsap-tag')).map(t => ({
          id: t.id,
          text: t.querySelector('.home-gsap-tag-text')?.textContent || t.textContent || '',
          className: t.className
        }));

        // Búsqueda de cualquier texto con "quedan"
        const pageText = document.body.innerText;
        const hasQuedan = /quedan\s+\d+/i.test(pageText);

        return {
          isCanvasGsapMounted,
          canvasStitchMounted,
          previewBadge,
          switcherPresent,
          metaRobots,
          tagCount: tags.length,
          tags,
          hasQuedan
        };
      })()`,
      returnByValue: true
    })).result.value;

    console.log('   - Componente .home-dynamic-canvas--gsap montado:', domInfo.isCanvasGsapMounted);
    console.log('   - Componente .home-dynamic-canvas--stitch montado:', domInfo.canvasStitchMounted);
    console.log('   - Badge visible:', domInfo.previewBadge);
    console.log('   - HomeVariantSwitcher presente (debe ser false):', domInfo.switcherPresent);
    console.log('   - Meta robots:', domInfo.metaRobots);
    console.log('   - Total tags en DOM:', domInfo.tagCount);
    console.log('   - ¿Contiene texto "quedan N"?:', domInfo.hasQuedan ? 'SÍ (ERROR)' : 'NO (CORRECTO)');
    console.log('   - Textos de tags:');
    domInfo.tags.forEach(t => console.log(`     * [${t.id}] ${t.text}`));

    ws.close();
  } finally {
    proc.kill();
  }
}

fase0Audit().catch(console.error);
