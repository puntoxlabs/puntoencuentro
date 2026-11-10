import { preview } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const artifactDir = 'C:/Users/Minar/.gemini/antigravity/brain/cc2ae1cb-fe34-4c02-9536-86890de98c2b/screenshots';
fs.mkdirSync(artifactDir, { recursive: true });

async function run() {
  console.log('🚀 Starting Vite preview server...');
  const server = await preview({
    preview: { port: 5188, strictPort: true },
  });

  const baseUrl = 'http://localhost:5188';
  console.log(`📡 Preview server listening at ${baseUrl}`);

  const browser = await chromium.launch({ headless: true });
  const viewports = [
    { name: '320px-narrow', width: 320, height: 640 },
    { name: '360px-motorola', width: 360, height: 800 },
    { name: '390px-mobile', width: 390, height: 844 },
    { name: '768px-tablet', width: 768, height: 1024 },
    { name: '1200px-desktop', width: 1200, height: 800 },
  ];

  for (const vp of viewports) {
    console.log(`\n───────────────────────────────────────────────────────────`);
    console.log(`📱 Evaluando Viewport: ${vp.name} (${vp.width}x${vp.height}px)`);
    console.log(`───────────────────────────────────────────────────────────`);

    // ─────────────────────────────────────────────────────────────
    // FASE 1: CON ZONAS (Carrusel activo, «Ver en lista», FAB, Sheet)
    // ─────────────────────────────────────────────────────────────
    const ctxWithZones = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    await ctxWithZones.addInitScript(() => {
      localStorage.setItem('app_storage_version', '1.2');
      localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
      localStorage.setItem('puntoencuentro_user_zones', JSON.stringify(['guemes', 'centro']));
    });

    const pageZones = await ctxWithZones.newPage();
    await pageZones.goto(`${baseUrl}/preview/home-gsap`, { waitUntil: 'domcontentloaded' });
    await pageZones.waitForSelector('#home-discovery-section', { timeout: 8000 });
    await pageZones.waitForTimeout(600);

    const discoverySec = pageZones.locator('#home-discovery-section');
    await discoverySec.scrollIntoViewIfNeeded();
    await pageZones.waitForTimeout(300);

    // 1. Verificación de «Ver en lista» en lugar de «Ver todos» (DIF-18-P Punto 1)
    const seeInListBtn = pageZones.locator('[data-testid="discovery-see-in-list-btn"]');
    await seeInListBtn.waitFor({ state: 'visible', timeout: 5000 });
    const seeInListText = await seeInListBtn.textContent();
    assert.ok(seeInListText.includes('Ver en lista'), `El botón debe decir "Ver en lista", obtenido: "${seeInListText}"`);
    console.log(`  ✔ [Punto 1] Botón renonbrado a "Ver en lista" con éxito`);

    // 2. Verificación de ausencia de scroll horizontal global (DIF-18-P Punto 4)
    const bodyScrollWidth = await pageZones.evaluate(() => document.documentElement.scrollWidth);
    const bodyClientWidth = await pageZones.evaluate(() => document.documentElement.clientWidth);
    assert.ok(
      bodyScrollWidth <= bodyClientWidth + 1,
      `Scroll horizontal no permitido: scrollWidth (${bodyScrollWidth}) <= clientWidth (${bodyClientWidth})`
    );
    console.log(`  ✔ [Punto 4] Cero scroll horizontal global (scrollWidth ${bodyScrollWidth}px <= clientWidth ${bodyClientWidth}px)`);

    // 3. Verificación de que ningún botón quede recortado en el borde derecho (DIF-18-P Punto 4)
    const seeInListBox = await seeInListBtn.boundingBox();
    assert.ok(seeInListBox, 'El botón Ver en lista debe tener bounding box');
    assert.ok(
      seeInListBox.x + seeInListBox.width <= vp.width + 1,
      `Botón no debe recortarse a la derecha: x+width (${seeInListBox.x + seeInListBox.width}px) <= viewport (${vp.width}px)`
    );
    assert.ok(
      seeInListBox.height >= 34,
      `Área táctil accesible: altura ${seeInListBox.height}px >= 34px`
    );
    console.log(`  ✔ [Punto 4] Controles accesibles sin recorte (borde derecho: ${Math.round(seeInListBox.x + seeInListBox.width)}px / ${vp.width}px, altura: ${Math.round(seeInListBox.height)}px)`);

    // Captura screenshot Discovery Header
    const headerPath = path.join(artifactDir, `discovery-header-${vp.name}.png`);
    await discoverySec.screenshot({ path: headerPath });
    console.log(`  📷 Captura header: ${headerPath}`);

    // 4. Apertura de la vista vertical «Ver en lista» (DIF-18-P Punto 1)
    await seeInListBtn.click();
    await pageZones.waitForTimeout(400);

    const sheet = pageZones.locator('[data-testid="discovery-see-all-sheet"]');
    await sheet.waitFor({ state: 'visible', timeout: 3000 });

    const sheetTitle = pageZones.locator('.pe-discovery-see-all-title');
    const sheetTitleText = await sheetTitle.textContent();
    assert.ok(
      sheetTitleText.includes('Encuentros en tus zonas') || sheetTitleText.includes('Encuentros abiertos') || sheetTitleText.includes('Encuentros online'),
      `Título contextual de lista vertical correcto: "${sheetTitleText}"`
    );
    console.log(`  ✔ [Punto 1] Vista vertical abierta con título contextual: "${sheetTitleText?.trim()}"`);

    // 5. Verificación de que el botón flotante "+ Crear" está oculto con el sheet abierto (DIF-18-P Punto 5)
    const fabVisible = await pageZones.evaluate(() => {
      const fab = document.querySelector('.home-fab-container');
      if (!fab) return false;
      const style = window.getComputedStyle(fab);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
    assert.ok(!fabVisible, 'FAB "+ Crear" debe ocultarse automáticamente cuando el sheet está abierto');
    console.log(`  ✔ [Punto 5] FAB "+ Crear" oculto automáticamente con sheet abierto`);

    // Captura screenshot Sheet vertical
    const sheetPath = path.join(artifactDir, `discovery-list-sheet-${vp.name}.png`);
    await pageZones.screenshot({ path: sheetPath });
    console.log(`  📷 Captura sheet vertical: ${sheetPath}`);

    // Cerrar el sheet
    const closeBtn = pageZones.locator('[data-testid="discovery-see-all-close-btn"]');
    await closeBtn.click();
    await pageZones.waitForTimeout(300);
    const isSheetClosed = await sheet.isVisible();
    assert.ok(!isSheetClosed, 'El sheet vertical se cierra correctamente al pulsar close');
    console.log(`  ✔ [Punto 1] Cierre y retorno contextual al carrusel completado`);

    await ctxWithZones.close();

    // ─────────────────────────────────────────────────────────────
    // FASE 2: SIN ZONAS (Estado inspirador, badges anti-overflow, single CTA)
    // ─────────────────────────────────────────────────────────────
    const ctxNoZones = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    await ctxNoZones.addInitScript(() => {
      localStorage.setItem('app_storage_version', '1.2');
      localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
      localStorage.setItem('puntoencuentro_user_zones', JSON.stringify([]));
    });

    const pageNoZones = await ctxNoZones.newPage();
    await pageNoZones.goto(`${baseUrl}/preview/home-gsap`, { waitUntil: 'domcontentloaded' });
    await pageNoZones.waitForSelector('#home-discovery-section', { timeout: 8000 });
    await pageNoZones.waitForTimeout(600);

    const inspState = pageNoZones.locator('[data-testid="inspirational-empty-state"]');
    await inspState.waitFor({ state: 'visible', timeout: 5000 });
    await inspState.scrollIntoViewIfNeeded();
    await pageNoZones.waitForTimeout(300);

    // A. Eliminación de botón duplicado "Configurar zonas" (DIF-18-P Punto 3)
    const topConfigPrompt = pageNoZones.locator('[data-testid="inspirational-btn-configure-zones"]');
    const hasTopPrompt = await topConfigPrompt.isVisible();
    const bottomConfigBtn = pageNoZones.locator('[data-testid="inspirational-cta-zones"]');
    const hasBottomBtn = await bottomConfigBtn.isVisible();

    assert.ok(hasTopPrompt, 'Debe mostrarse el CTA contextual superior de "Configurar zonas"');
    assert.ok(!hasBottomBtn, 'NO debe haber un segundo botón duplicado de "Configurar zonas" al final');
    console.log(`  ✔ [Punto 3] Único CTA "Configurar zonas" en recuadro superior (duplicado eliminado)`);

    // B. Verificación de que las 4 etiquetas ("IDEA PARA ORGANIZAR") NO desborden (DIF-18-P Punto 2)
    const cards = await pageNoZones.locator('.pe-inspirational-card').all();
    assert.equal(cards.length, 4, 'Deben existir exactamente 4 tarjetas inspiradoras');

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const cardBox = await card.boundingBox();
      const badge = card.locator('.pe-inspirational-card-badge');
      const badgeBox = await badge.boundingBox();

      assert.ok(cardBox && badgeBox, `Tarjeta y badge ${i + 1} deben tener bounding box`);

      // Comprobación de no desbordamiento: badge debe quedar estrictamente dentro de la tarjeta
      assert.ok(
        badgeBox.x >= cardBox.x - 1,
        `Badge ${i + 1} (x: ${badgeBox.x}px) no sobresale a la izquierda de la tarjeta (x: ${cardBox.x}px)`
      );
      assert.ok(
        badgeBox.x + badgeBox.width <= cardBox.x + cardBox.width + 1.5,
        `Badge ${i + 1} (right: ${badgeBox.x + badgeBox.width}px) no sobresale a la derecha de la tarjeta (right: ${cardBox.x + cardBox.width}px)`
      );
    }
    console.log(`  ✔ [Punto 2] Las 4 etiquetas "IDEA PARA ORGANIZAR" 100% contenidas sin invadir tarjetas vecinas`);

    // Captura screenshot Estado Inspirador
    const inspPath = path.join(artifactDir, `inspirational-state-${vp.name}.png`);
    await inspState.screenshot({ path: inspPath });
    console.log(`  📷 Captura estado inspirador: ${inspPath}`);

    await ctxNoZones.close();
  }

  await browser.close();
  await server.close();

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`🎉 TODAS LAS PRUEBAS E2E Y RESPONSIVE PASARON EXITOSAMENTE`);
  console.log(`═══════════════════════════════════════════════════════════`);
}

run().catch((err) => {
  console.error('❌ Error en validación visual E2E:', err);
  process.exit(1);
});
