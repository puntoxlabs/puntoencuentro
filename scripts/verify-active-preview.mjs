import http from 'http';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const URL_TO_TEST = 'http://127.0.0.1:4173/preview/home-gsap';
const CDP_PORT = 9255;
const ARTIFACTS_DIR = 'C:/Users/Minar/.gemini/antigravity/brain/70d9face-fb29-4084-a777-b0b51f8d52f3/active-instance-validation';

if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function getChromePath() {
  const possible = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const p of possible) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome no encontrado');
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.callbacks = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error('Eval failed: ' + JSON.stringify(res.exceptionDetails));
    }
    return res.result?.value;
  }

  async screenshot(filePath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
  }

  close() {
    this.ws.close();
  }
}

async function run() {
  console.log('--- Iniciando verificación visual sobre URL activa ---');
  console.log('Target URL:', URL_TO_TEST);

  const chromePath = getChromePath();
  const profileDir = path.join(process.env.TEMP, 'test-preview-chrome-' + Date.now());
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1440,900',
  ]);

  let targetWs = null;
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(URL_TO_TEST)}`, { method: 'PUT' });
      const data = await resp.json();
      targetWs = data.webSocketDebuggerUrl;
      if (targetWs) break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (!targetWs) {
    chromeProc.kill();
    throw new Error('No se pudo conectar a CDP');
  }

  const client = new CdpClient(targetWs);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');

  // Bypass AccessGate in test session
  await client.eval(`
    localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
    location.reload();
  `);

  // Esperar a que la página cargue completamente tras bypass
  await new Promise(r => setTimeout(r, 3000));

  // 1. Extraer el texto de Build
  const buildText = await client.eval(`
    (() => {
      const el = document.querySelector('.home-build-info span');
      return el ? el.innerText.trim() : 'NO_BUILD_INFO';
    })()
  `);
  console.log('Build Info en pantalla:', buildText);

  // 2. Extraer orden topológico de secciones
  const sectionsOrder = await client.eval(`
    (() => {
      const results = [];
      const hero = document.querySelector('.home-hero-wrapper');
      const discovery = document.querySelector('.pe-discovery-section');
      const pillars = document.querySelector('.home-pillars-section');
      const encounters = document.querySelector('.home-encounters-section');

      if (hero) results.push({ name: 'Hero', top: hero.getBoundingClientRect().top });
      if (discovery) results.push({ name: 'HomeOpenEncounters (Discovery)', top: discovery.getBoundingClientRect().top });
      if (pillars) results.push({ name: 'HomePillarsSection', top: pillars.getBoundingClientRect().top });
      if (encounters) results.push({ name: 'HomeEncountersSection', top: encounters.getBoundingClientRect().top });

      results.sort((a, b) => a.top - b.top);
      return results;
    })()
  `);
  console.log('Orden vertical de componentes:', sectionsOrder);

  // 3. Inspeccionar Toolbar de Tus Encuentros
  const toolbarData = await client.eval(`
    (() => {
      const title = document.querySelector('.pe-toolbar-title')?.innerText?.trim() || null;
      const count = document.querySelector('.pe-toolbar-summary-count')?.innerText?.trim() || null;
      const tabs = Array.from(document.querySelectorAll('.pe-segmented-btn')).map(b => b.innerText.trim());
      const filterBtn = document.querySelector('.pe-filter-btn')?.innerText?.trim() || null;
      const toolbarBox = document.querySelector('.pe-toolbar-container')?.getBoundingClientRect();
      const titleBox = document.querySelector('.pe-toolbar-title')?.getBoundingClientRect();
      const countBox = document.querySelector('.pe-toolbar-summary-count')?.getBoundingClientRect();

      return {
        title,
        count,
        tabs,
        filterBtn,
        toolbarWidth: toolbarBox?.width,
        titleLeft: titleBox?.left,
        countLeft: countBox?.left,
        gapBetweenTitleAndCount: countBox ? (countBox.left - titleBox.right) : null,
      };
    })()
  `);
  console.log('Datos de Toolbar Tus Encuentros:', toolbarData);

  // 4. Inspeccionar Discovery Carrousel
  const discoveryData = await client.eval(`
    (() => {
      const title = document.querySelector('.pe-discovery-title')?.innerText?.trim() || null;
      const cards = document.querySelectorAll('.pe-open-card');
      const cardsData = Array.from(cards).map(c => ({
        title: c.querySelector('.pe-open-card__title')?.innerText?.trim(),
        badge: c.querySelector('.pe-open-card__badge')?.innerText?.trim(),
        zone: c.querySelector('.pe-open-card__zone-text')?.innerText?.trim(),
      }));
      return {
        title,
        cardsCount: cards.length,
        cardsSample: cardsData.slice(0, 3),
      };
    })()
  `);
  console.log('Datos de Discovery:', discoveryData);

  // Capturar screenshot Desktop Top
  const desktopImg = path.join(ARTIFACTS_DIR, 'desktop_1440x900_top.png');
  await client.screenshot(desktopImg);
  console.log('Screenshot Desktop Top guardado:', desktopImg);

  // Scroll a Discovery
  await client.eval(`document.querySelector('.pe-discovery-section')?.scrollIntoView({ behavior: 'instant', block: 'start' });`);
  await new Promise(r => setTimeout(r, 600));
  const discoveryImg = path.join(ARTIFACTS_DIR, 'desktop_1440x900_discovery.png');
  await client.screenshot(discoveryImg);
  console.log('Screenshot Discovery guardado:', discoveryImg);

  // Scroll a Tus Encuentros
  await client.eval(`document.querySelector('.home-encounters-section')?.scrollIntoView({ behavior: 'instant', block: 'start' });`);
  await new Promise(r => setTimeout(r, 600));
  const toolbarImg = path.join(ARTIFACTS_DIR, 'desktop_1440x900_your_encounters.png');
  await client.screenshot(toolbarImg);
  console.log('Screenshot Toolbar guardado:', toolbarImg);

  // Scroll al final (Build Info)
  await client.eval(`window.scrollTo(0, document.body.scrollHeight);`);
  await new Promise(r => setTimeout(r, 600));
  const footerImg = path.join(ARTIFACTS_DIR, 'desktop_1440x900_footer_build.png');
  await client.screenshot(footerImg);
  console.log('Screenshot Footer guardado:', footerImg);

  // Emular Mobile 390x844
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await client.eval(`window.scrollTo(0, 0);`);
  await new Promise(r => setTimeout(r, 800));

  const mobileTopImg = path.join(ARTIFACTS_DIR, 'mobile_390x844_top.png');
  await client.screenshot(mobileTopImg);
  console.log('Screenshot Mobile Top guardado:', mobileTopImg);

  await client.eval(`document.querySelector('.pe-discovery-section')?.scrollIntoView({ behavior: 'instant', block: 'start' });`);
  await new Promise(r => setTimeout(r, 600));
  const mobileDiscoveryImg = path.join(ARTIFACTS_DIR, 'mobile_390x844_discovery.png');
  await client.screenshot(mobileDiscoveryImg);
  console.log('Screenshot Mobile Discovery guardado:', mobileDiscoveryImg);

  await client.eval(`document.querySelector('.home-encounters-section')?.scrollIntoView({ behavior: 'instant', block: 'start' });`);
  await new Promise(r => setTimeout(r, 600));
  const mobileToolbarImg = path.join(ARTIFACTS_DIR, 'mobile_390x844_toolbar.png');
  await client.screenshot(mobileToolbarImg);
  console.log('Screenshot Mobile Toolbar guardado:', mobileToolbarImg);

  client.close();
  chromeProc.kill();

  const report = {
    url: URL_TO_TEST,
    buildText,
    sectionsOrder,
    toolbarData,
    discoveryData,
    screenshots: {
      desktopTop: desktopImg,
      desktopDiscovery: discoveryImg,
      desktopToolbar: toolbarImg,
      desktopFooter: footerImg,
      mobileTop: mobileTopImg,
      mobileDiscovery: mobileDiscoveryImg,
      mobileToolbar: mobileToolbarImg,
    }
  };

  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, 'validation_report.json'),
    JSON.stringify(report, null, 2)
  );

  console.log('Validación finalizada con éxito.');
}

run().catch(err => {
  console.error('Error durante la validación:', err);
  process.exit(1);
});
