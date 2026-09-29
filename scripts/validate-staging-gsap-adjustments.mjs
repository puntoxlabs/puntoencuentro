import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const CDP_PORT = 9255;
const VERCEL_URL = 'https://staging.puntoencuentro.com.ar/preview/home-gsap';
const BYPASS_SECRET = 'LAXj0MiE6YZ0CONZwnFHxXjagiZVBteZ';
const artifactsDir = path.join('C:', 'Users', 'Minar', '.gemini', 'antigravity', 'brain', '01aa348c-3749-4d3b-913f-b94c360b8d61', 'staging-gsap-audit');

if (!fs.existsSync(artifactsDir)) {
  fs.mkdirSync(artifactsDir, { recursive: true });
}

async function run() {
  console.log('=== VALIDACIÓN CDP EN STAGING VERCEL (AJUSTES FINALES GSAP) ===');
  console.log('Target URL:', VERCEL_URL);

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'chrome-staging-gsap-' + Date.now());
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
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
    if (!targetWs) throw new Error('No se pudo conectar a Chrome CDP');

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

    await send('Network.setExtraHTTPHeaders', {
      headers: {
        'x-vercel-protection-bypass': BYPASS_SECRET,
      }
    });

    // ──────────────────────────────────────────
    // 1. AUDITORÍA DESKTOP (1440x900)
    // ──────────────────────────────────────────
    console.log('\n--- 1. AUDITORÍA DESKTOP (1440x900) ---');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await send('Page.navigate', { url: VERCEL_URL });
    await new Promise(r => setTimeout(r, 2000));

    // Desbloquear QA Gate
    await send('Runtime.evaluate', {
      expression: `
        try {
          localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
        } catch(e) {}
      `
    });
    await send('Page.navigate', { url: VERCEL_URL });
    await new Promise(r => setTimeout(r, 3500));

    const desktopChecks = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        // A. Bloque Explicativo Horizontal
        const valProp = document.querySelector('.home-value-prop');
        const valPropSteps = document.querySelector('.home-value-prop-steps');
        const valStepsItems = document.querySelectorAll('.home-value-prop-step');
        const valPropRect = valProp ? valProp.getBoundingClientRect() : null;
        const valPropStepsRect = valPropSteps ? valPropSteps.getBoundingClientRect() : null;

        // B. Tus Encuentros centrado
        const innerContainer = document.querySelector('.pe-encounters-inner');
        const innerRect = innerContainer ? innerContainer.getBoundingClientRect() : null;

        // C. Carrusel de Encuentros Abiertos
        const track = document.querySelector('.pe-discovery-track');
        const firstCard = document.querySelector('.pe-discovery-item');
        const trackRect = track ? track.getBoundingClientRect() : null;
        const firstCardRect = firstCard ? firstCard.getBoundingClientRect() : null;
        const scrollLeft = track ? track.scrollLeft : null;

        // "Ver todos" botón
        const seeAllBtn = document.querySelector('.pe-discovery-see-all-btn');
        const seeAllRect = seeAllBtn ? seeAllBtn.getBoundingClientRect() : null;

        // D. Preview GSAP badge duplicado (debe ser null)
        const oldBadge = Array.from(document.querySelectorAll('button, div')).find(el => {
          const t = el.innerText ? el.innerText.trim() : '';
          return t === 'Preview GSAP' || t.includes('Preview GSAP');
        });

        // Switcher unificado
        const switcher = document.querySelector('.home-variant-floating-bar, .home-variant-minimized-badge');

        // E. FAB en Desktop (debe estar oculto)
        const fabContainer = document.querySelector('.home-fab-container');
        const fabVisible = fabContainer ? window.getComputedStyle(fabContainer).display !== 'none' : false;

        return {
          valProp: {
            exists: Boolean(valProp),
            width: valPropRect ? Math.round(valPropRect.width) : null,
            height: valPropRect ? Math.round(valPropRect.height) : null,
            stepsDisplay: valPropSteps ? window.getComputedStyle(valPropSteps).display : null,
            stepCount: valStepsItems.length,
            isHorizontallyArranged: valStepsItems.length >= 2 ?
              (valStepsItems[1].getBoundingClientRect().left > valStepsItems[0].getBoundingClientRect().right - 20) : false,
          },
          tusEncuentrosInner: {
            exists: Boolean(innerContainer),
            width: innerRect ? Math.round(innerRect.width) : null,
            leftMargin: innerRect ? Math.round(innerRect.left) : null,
            rightMargin: innerRect ? Math.round(window.innerWidth - innerRect.right) : null,
            isCentered: innerRect ? Math.abs((innerRect.left) - (window.innerWidth - innerRect.right)) < 10 : false,
          },
          carrusel: {
            exists: Boolean(track),
            scrollLeft,
            trackLeft: trackRect ? Math.round(trackRect.left) : null,
            firstCardLeft: firstCardRect ? Math.round(firstCardRect.left) : null,
            isCardFlush: (trackRect && firstCardRect) ? Math.abs(firstCardRect.left - trackRect.left) < 25 : false,
            seeAllBtnText: seeAllBtn ? seeAllBtn.innerText.replace(/\\s+/g, ' ').trim() : null,
            seeAllBtnHeight: seeAllRect ? Math.round(seeAllRect.height) : null,
          },
          oldBadgeExists: Boolean(oldBadge),
          hasSwitcher: Boolean(switcher),
          fabVisibleOnDesktop: fabVisible,
        };
      })()`
    });

    console.log('Desktop Checks Result:', JSON.stringify(desktopChecks.result.value, null, 2));

    // Capturar evidencia desktop completa
    const ssDesktop = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(artifactsDir, 'desktop_staging_gsap.png'), Buffer.from(ssDesktop.data, 'base64'));
    console.log('Saved screenshot: desktop_staging_gsap.png');

    // Scroll al bloque explicativo y Tus Encuentros
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.home-value-prop, .home-encounters-section')?.scrollIntoView({ behavior: 'instant' });`
    });
    await new Promise(r => setTimeout(r, 600));
    const ssDesktopTusEnc = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(artifactsDir, 'desktop_tus_encuentros.png'), Buffer.from(ssDesktopTusEnc.data, 'base64'));
    console.log('Saved screenshot: desktop_tus_encuentros.png');

    // ──────────────────────────────────────────
    // 2. AUDITORÍA MOBILE (390x844)
    // ──────────────────────────────────────────
    console.log('\n--- 2. AUDITORÍA MOBILE (390x844) ---');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });

    await send('Page.navigate', { url: VERCEL_URL });
    await new Promise(r => setTimeout(r, 3500));

    // Verificación Mobile Top (Hero visible, FAB debe estar oculto)
    const mobileTopChecks = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const fab = document.querySelector('.home-fab-container');
        const heroCta = document.querySelector('.home-intent-submit-btn');
        const heroCtaRect = heroCta ? heroCta.getBoundingClientRect() : null;

        // "Ver todos" en carrusel
        const seeAllBtn = document.querySelector('.pe-discovery-see-all-btn');
        const seeAllRect = seeAllBtn ? seeAllBtn.getBoundingClientRect() : null;
        const seeAllComputed = seeAllBtn ? window.getComputedStyle(seeAllBtn) : null;

        // Chip "En tus zonas"
        const zoneChip = document.querySelector('.pe-discovery-badge');
        const zoneRect = zoneChip ? zoneChip.getBoundingClientRect() : null;

        // Bloque explicativo en mobile (debe ser layout vertical)
        const valPropSteps = document.querySelector('.home-value-prop-steps');
        const valStepsItems = document.querySelectorAll('.home-value-prop-step');
        const isVerticalInMobile = valStepsItems.length >= 2 ?
          (valStepsItems[1].getBoundingClientRect().top > valStepsItems[0].getBoundingClientRect().bottom - 10) : false;

        return {
          heroCtaVisible: heroCtaRect ? (heroCtaRect.bottom > 20 && heroCtaRect.top < window.innerHeight) : false,
          fabVisibleAtTop: Boolean(fab),
          seeAll: {
            exists: Boolean(seeAllBtn),
            text: seeAllBtn ? seeAllBtn.innerText.replace(/\\s+/g, ' ').trim() : null,
            whiteSpace: seeAllComputed ? seeAllComputed.whiteSpace : null,
            height: seeAllRect ? Math.round(seeAllRect.height) : null,
            isSingleLine: seeAllRect ? seeAllRect.height <= 32 : false,
          },
          zoneChip: {
            exists: Boolean(zoneChip),
            text: zoneChip ? zoneChip.innerText.trim() : null,
          },
          valPropIsVerticalInMobile: isVerticalInMobile,
        };
      })()`
    });

    console.log('Mobile Top Checks Result:', JSON.stringify(mobileTopChecks.result.value, null, 2));

    const ssMobileTop = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(artifactsDir, 'mobile_staging_gsap.png'), Buffer.from(ssMobileTop.data, 'base64'));
    console.log('Saved screenshot: mobile_staging_gsap.png');

    // Scroll hacia abajo para activar FAB y verificar Tus Encuentros
    console.log('\n--- Scrolleando hacia abajo en Mobile para probar FAB y Tus Encuentros ---');
    await send('Runtime.evaluate', {
      expression: `window.scrollTo({ top: 800, behavior: 'instant' });`
    });
    await new Promise(r => setTimeout(r, 800));

    const mobileScrolledChecks = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const fab = document.querySelector('.home-fab-container');
        const fabBtn = document.querySelector('.home-fab');
        const fabRect = fabBtn ? fabBtn.getBoundingClientRect() : null;
        const fabComputed = fabBtn ? window.getComputedStyle(fabBtn) : null;

        // Tus encuentros empty state
        const emptyState = document.querySelector('.home-empty');
        const emptyComputed = emptyState ? window.getComputedStyle(emptyState) : null;
        const emptyRect = emptyState ? emptyState.getBoundingClientRect() : null;

        return {
          fabContainerExists: Boolean(fab),
          fabBtnHeight: fabRect ? Math.round(fabRect.height) : null,
          fabBtnWidth: fabRect ? Math.round(fabRect.width) : null,
          fabBtnBg: fabComputed ? fabComputed.backgroundColor : null,
          emptyPaddingTop: emptyComputed ? emptyComputed.paddingTop : null,
          emptyPaddingBottom: emptyComputed ? emptyComputed.paddingBottom : null,
          emptyHeight: emptyRect ? Math.round(emptyRect.height) : null,
        };
      })()`
    });

    console.log('Mobile Scrolled Checks Result:', JSON.stringify(mobileScrolledChecks.result.value, null, 2));

    const ssMobileScrolled = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(artifactsDir, 'mobile_tus_encuentros.png'), Buffer.from(ssMobileScrolled.data, 'base64'));
    console.log('Saved screenshot: mobile_tus_encuentros.png');

    // ──────────────────────────────────────────
    // 3. AUDITORÍA MOBILE COMPACTO (360x800)
    // ──────────────────────────────────────────
    console.log('\n--- 3. AUDITORÍA MOBILE COMPACTO (360x800) ---');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 360,
      height: 800,
      deviceScaleFactor: 2,
      mobile: true,
    });

    await send('Page.navigate', { url: VERCEL_URL });
    await new Promise(r => setTimeout(r, 3500));

    const mobile360Checks = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const seeAllBtn = document.querySelector('.pe-discovery-see-all-btn');
        const seeAllRect = seeAllBtn ? seeAllBtn.getBoundingClientRect() : null;
        const header = document.querySelector('.pe-discovery-header');
        const headerRect = header ? header.getBoundingClientRect() : null;

        return {
          seeAllExists: Boolean(seeAllBtn),
          seeAllSingleLine: seeAllRect ? seeAllRect.height <= 32 : false,
          seeAllWidth: seeAllRect ? Math.round(seeAllRect.width) : null,
          seeAllHeight: seeAllRect ? Math.round(seeAllRect.height) : null,
          headerWidth: headerRect ? Math.round(headerRect.width) : null,
        };
      })()`
    });

    console.log('Mobile 360 Checks Result:', JSON.stringify(mobile360Checks.result.value, null, 2));

    console.log('\n=== AUDITORÍA CDP FINALIZADA EXITOSAMENTE ===');
  } catch (err) {
    console.error('Error durante la validación:', err);
  } finally {
    try {
      chromeProc.kill();
    } catch {}
  }
}

run();
