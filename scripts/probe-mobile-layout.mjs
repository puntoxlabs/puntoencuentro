import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const CDP_PORT = 9243;

async function probeLayout() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'chrome-probe-' + Date.now());
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
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2.6, mobile: true });

    await send('Page.navigate', { url: 'https://puntoencuentro.com.ar/preview/home-gsap' });
    await new Promise(r => setTimeout(r, 1500));
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`
    });
    await send('Page.reload');
    await new Promise(r => setTimeout(r, 3000));

    const layout = (await send('Runtime.evaluate', {
      expression: `(() => {
        const heroWrapper = document.querySelector('.home-hero-wrapper');
        const chips = document.querySelector('.home-suggestions-container');
        const cta = document.querySelector('.home-intent-submit-btn');
        const textarea = document.querySelector('.home-intent-textarea');
        const pillars = document.querySelector('.home-pillars-section');
        const fab = document.querySelector('.home-fab');
        const previewBadge = document.querySelector('.home-gsap-preview-badge, button[title*="GSAP"]');
        
        function serializeRect(r) {
          if (!r) return null;
          return {
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            left: Math.round(r.left),
            right: Math.round(r.right),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        }
        
        return {
          window: { width: window.innerWidth, height: window.innerHeight },
          heroWrapper: serializeRect(heroWrapper?.getBoundingClientRect()),
          chips: serializeRect(chips?.getBoundingClientRect()),
          cta: serializeRect(cta?.getBoundingClientRect()),
          textarea: serializeRect(textarea?.getBoundingClientRect()),
          pillars: serializeRect(pillars?.getBoundingClientRect()),
          fab: serializeRect(fab?.getBoundingClientRect()),
          previewBadge: serializeRect(previewBadge?.getBoundingClientRect()),
        };
      })()`,
      returnByValue: true
    })).result.value;

    console.log('Mobile 390x844 layout:', JSON.stringify(layout, null, 2));

    ws.close();
  } finally {
    proc.kill();
  }
}
probeLayout().catch(console.error);
