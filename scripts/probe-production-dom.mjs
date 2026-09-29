import { spawn } from 'child_process';
import path from 'path';
import { WebSocket } from 'ws';

const PROD_BASE = 'https://puntoencuentro.com.ar';
const CDP_PORT = 9232;

async function probe() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'probe-geo3-' + Date.now());
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
  ]);

  try {
    let targetWs = null;
    for (let i = 0; i < 30; i++) {
      try {
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${PROD_BASE}/preview/home-gsap`, { method: 'PUT' });
        if (resp.ok) {
          const tab = await resp.json();
          targetWs = tab.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    if (!targetWs) throw new Error('No target ws');

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
    
    // First navigate to set localStorage on domain
    await send('Page.navigate', { url: `${PROD_BASE}/preview/home-gsap` });
    await new Promise(r => setTimeout(r, 1500));

    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`
    });

    // Reload with cache
    await send('Page.reload');
    await new Promise(r => setTimeout(r, 3000));

    const domInfo = await send('Runtime.evaluate', {
      expression: `(() => {
        const heroWrapper = document.querySelector('.home-hero-wrapper');
        const heroWrapperRect = heroWrapper ? heroWrapper.getBoundingClientRect().toJSON() : null;
        const heroWrapperPadding = heroWrapper ? window.getComputedStyle(heroWrapper).padding : null;
        
        const canvas = document.querySelector('.home-dynamic-canvas--gsap');
        const canvasRect = canvas ? canvas.getBoundingClientRect().toJSON() : null;
        
        const photoLeft = document.querySelector('.home-gsap-mobile-frag--left');
        const photoLeftRect = photoLeft ? photoLeft.getBoundingClientRect().toJSON() : null;

        const photoRight = document.querySelector('.home-gsap-mobile-frag--right');
        const photoRightRect = photoRight ? photoRight.getBoundingClientRect().toJSON() : null;

        const eyebrow = document.querySelector('.home-hero-badge');
        const eyebrowRect = eyebrow ? eyebrow.getBoundingClientRect().toJSON() : null;

        const h1 = document.querySelector('.home-hero-title');
        const h1Rect = h1 ? h1.getBoundingClientRect().toJSON() : null;

        const phrase = document.querySelector('.home-hero-rotating-container');
        const phraseRect = phrase ? phrase.getBoundingClientRect().toJSON() : null;

        const tags = Array.from(document.querySelectorAll('.home-gsap-tag')).map(t => ({
          id: t.id,
          text: t.textContent.trim(),
          rect: t.getBoundingClientRect().toJSON(),
          opacity: window.getComputedStyle(t).opacity,
          visibility: window.getComputedStyle(t).visibility,
          transform: window.getComputedStyle(t).transform,
        }));

        function collides(r1, r2) {
          if (!r1 || !r2) return false;
          return !(r1.right < r2.left || r1.left > r2.right || r1.bottom < r2.top || r1.top > r2.bottom);
        }

        return {
          windowInner: { w: window.innerWidth, h: window.innerHeight },
          visualViewport: window.visualViewport ? { w: window.visualViewport.width, h: window.visualViewport.height, top: window.visualViewport.offsetTop } : null,
          heroWrapperRect,
          heroWrapperPadding,
          canvasRect,
          photoLeftRect,
          photoRightRect,
          eyebrowRect,
          h1Rect,
          phraseRect,
          colPhotoLeftH1: collides(photoLeftRect, h1Rect),
          colPhotoLeftEyebrow: collides(photoLeftRect, eyebrowRect),
          colPhotoRightH1: collides(photoRightRect, h1Rect),
          colPhotoRightEyebrow: collides(photoRightRect, eyebrowRect),
          tagsCount: tags.length,
          tags: tags.map(t => ({ id: t.id, text: t.text, opacity: t.opacity, vis: t.visibility, top: t.rect.top, bottom: t.rect.bottom, left: t.rect.left, right: t.rect.right }))
        };
      })()`,
      returnByValue: true
    });

    console.log(JSON.stringify(domInfo.result?.value, null, 2));

    ws.close();
  } finally {
    chromeProc.kill();
  }
}

probe().catch(console.error);
