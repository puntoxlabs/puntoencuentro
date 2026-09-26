import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';

const PORT = 4196;
const CDP_PORT = 9224;
const distDir = path.resolve('dist');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

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
    this.networkRequests = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'Network.requestWillBeSent') {
        const url = msg.params?.request?.url;
        if (url && (url.includes('.js') || url.includes('.css'))) {
          this.networkRequests.push(url);
        }
      }
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
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
    return res.result?.value;
  }
  clearRequests() {
    this.networkRequests = [];
  }
  close() {
    try { this.ws.close(); } catch(e) {}
  }
}

async function verifyIsolation() {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log(`Servidor local activo en http://127.0.0.1:${PORT}`);

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profileDir = path.join(process.env.TEMP, 'chrome-iso-' + Date.now());
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
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
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PORT}/`, { method: 'PUT' });
        if (resp.ok) {
          const tab = await resp.json();
          targetWs = tab.webSocketDebuggerUrl;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    cdp = new CdpClient(targetWs);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await new Promise(r => setTimeout(r, 1000));
    await cdp.evaluate(`localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));`);

    const routes = [
      { name: 'Home principal (/)', url: `http://127.0.0.1:${PORT}/`, shouldHaveGsap: false },
      { name: 'Preview Variante D (/preview/home-d)', url: `http://127.0.0.1:${PORT}/preview/home-d`, shouldHaveGsap: false },
      { name: 'Wizard AI (/create/ai)', url: `http://127.0.0.1:${PORT}/create/ai`, shouldHaveGsap: false },
      { name: 'Preview GSAP (/preview/home-gsap)', url: `http://127.0.0.1:${PORT}/preview/home-gsap`, shouldHaveGsap: true },
    ];

    const results = [];

    for (const r of routes) {
      cdp.clearRequests();
      await cdp.send('Page.navigate', { url: r.url });
      await new Promise(resolve => setTimeout(resolve, 3000));

      const requests = [...cdp.networkRequests];
      const hasGsapChunk = requests.some(u => u.includes('HomeDynamicCanvasGsap'));
      const chunkNames = requests.map(u => u.split('/').pop().split('?')[0]);

      const passed = hasGsapChunk === r.shouldHaveGsap;
      results.push({
        route: r.name,
        url: r.url,
        shouldHaveGsap: r.shouldHaveGsap,
        hasGsapChunk,
        passed,
        chunksLoaded: chunkNames
      });

      console.log(`\n--- ${r.name} ---`);
      console.log(`¿Cargó chunk GSAP?: ${hasGsapChunk ? 'SÍ' : 'NO'}`);
      console.log(`Esperado: ${r.shouldHaveGsap ? 'SÍ' : 'NO'} => ${passed ? 'PASS (Correcto)' : 'FAIL (Incorrecto)'}`);
      console.log(`Chunks descargados: ${chunkNames.join(', ')}`);
    }

    const allPassed = results.every(res => res.passed);
    console.log(`\n===============================================================`);
    console.log(`RESULTADO DE AISLAMIENTO: ${allPassed ? 'TODAS LAS PRUEBAS PASARON (100% AISLADO)' : 'FALLÓ EL AISLAMIENTO'}`);
    console.log(`===============================================================`);

    fs.writeFileSync(
      'C:/Users/Minar/.gemini/antigravity/brain/70d9face-fb29-4084-a777-b0b51f8d52f3/gsap-validation/bundle_isolation_report.json',
      JSON.stringify({ timestamp: new Date().toISOString(), results, allPassed }, null, 2)
    );

  } finally {
    if (cdp) cdp.close();
    chromeProc.kill();
    server.close();
  }
}

verifyIsolation().catch(console.error);
