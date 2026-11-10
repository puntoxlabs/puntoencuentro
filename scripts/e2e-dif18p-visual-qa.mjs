import { preview } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// Directorio de capturas y artefactos configurable o relativo al workspace
const artifactDir = process.env.ARTIFACT_DIR
  ? path.resolve(process.env.ARTIFACT_DIR)
  : path.resolve(process.cwd(), 'test-results', 'dif18p-screenshots');

fs.mkdirSync(artifactDir, { recursive: true });
console.log(`📂 Directorio de artefactos y capturas: ${artifactDir}`);

async function run() {
  let server = null;
  let browser = null;

  try {
    console.log('🚀 Iniciando servidor Vite preview...');
    server = await preview({
      preview: { port: 5188, strictPort: true },
    });

    const baseUrl = 'http://localhost:5188';
    console.log(`📡 Servidor preview escuchando en ${baseUrl}`);

    browser = await chromium.launch({ headless: true });

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
      // FASE 1: CON ZONAS (Carrusel activo, controles responsive, modales y FAB)
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
      await pageZones.waitForTimeout(500);

      const discoverySec = pageZones.locator('#home-discovery-section');
      await discoverySec.scrollIntoViewIfNeeded();
      await pageZones.waitForTimeout(300);

      // 1. Verificación de «Ver en lista» en lugar de «Ver todos» (DIF-18-P Punto 1)
      const seeInListBtn = pageZones.locator('[data-testid="discovery-see-in-list-btn"]');
      await seeInListBtn.waitFor({ state: 'visible', timeout: 5000 });
      const seeInListText = await seeInListBtn.textContent();
      assert.ok(seeInListText.includes('Ver en lista'), `El botón debe decir "Ver en lista", obtenido: "${seeInListText}"`);
      console.log(`  ✔ [Punto 1] Botón renombrado a "Ver en lista" con éxito`);

      // 2. Verificación de ausencia de scroll horizontal global (DIF-18-P Punto 4)
      const bodyScrollWidth = await pageZones.evaluate(() => document.documentElement.scrollWidth);
      const bodyClientWidth = await pageZones.evaluate(() => document.documentElement.clientWidth);
      assert.ok(
        bodyScrollWidth <= bodyClientWidth + 1,
        `Scroll horizontal no permitido: scrollWidth (${bodyScrollWidth}px) <= clientWidth (${bodyClientWidth}px)`
      );
      console.log(`  ✔ [Punto 4] Cero scroll horizontal global (${bodyScrollWidth}px <= ${bodyClientWidth}px)`);

      // 3. Verificación de la distribución real de TODOS los controles en el header (DIF-18-P Punto 2 y 4)
      const filterBtn = pageZones.locator('[data-testid="discovery-filter-btn"]');
      const avisameBtn = pageZones.locator('[data-testid="discovery-avisame-btn"]');
      const zoneBadge = pageZones.locator('[data-testid="discovery-zone-badge"]');

      const filterBox = await filterBtn.boundingBox();
      const avisameBox = await avisameBtn.boundingBox();
      const seeInListBox = await seeInListBtn.boundingBox();
      const zoneBadgeBox = await zoneBadge.boundingBox();

      assert.ok(filterBox && avisameBox && seeInListBox && zoneBadgeBox, 'Todos los controles deben tener bounding box');

      // Comprobar que ningún control desborde el ancho de pantalla
      assert.ok(
        filterBox.x >= 0 && filterBox.x + filterBox.width <= vp.width + 1.5,
        `Filtro disponibilidad no debe desbordar: right=${Math.round(filterBox.x + filterBox.width)}px <= viewport=${vp.width}px`
      );
      assert.ok(
        avisameBox.x >= 0 && avisameBox.x + avisameBox.width <= vp.width + 1.5,
        `Botón Avisame no debe desbordar: right=${Math.round(avisameBox.x + avisameBox.width)}px <= viewport=${vp.width}px`
      );
      assert.ok(
        seeInListBox.x >= 0 && seeInListBox.x + seeInListBox.width <= vp.width + 1.5,
        `Botón Ver en lista no debe desbordar: right=${Math.round(seeInListBox.x + seeInListBox.width)}px <= viewport=${vp.width}px`
      );
      assert.ok(
        zoneBadgeBox.x >= 0 && zoneBadgeBox.x + zoneBadgeBox.width <= vp.width + 1.5,
        `Insignia de zonas no debe desbordar: right=${Math.round(zoneBadgeBox.x + zoneBadgeBox.width)}px <= viewport=${vp.width}px`
      );

      // Comprobar alturas mínimas para áreas táctiles móviles (>= 34px)
      assert.ok(filterBox.height >= 34, `Filtro altura táctil >= 34px (obtenido: ${filterBox.height}px)`);
      assert.ok(avisameBox.height >= 34, `Avisame altura táctil >= 34px (obtenido: ${avisameBox.height}px)`);
      assert.ok(seeInListBox.height >= 34, `Ver en lista altura táctil >= 34px (obtenido: ${seeInListBox.height}px)`);

      console.log(`  ✔ [Punto 2 & 4] Distribución de controles en ${vp.width}px validada (sin recorte, padding y wrap armónico)`);

      // Captura screenshot Discovery Header
      const headerPath = path.join(artifactDir, `discovery-header-${vp.name}.png`);
      await discoverySec.screenshot({ path: headerPath });
      console.log(`  📷 Captura header: ${headerPath}`);

      // 4. Verificación de FAB "+ Crear" visible inicialmente en Home (DIF-18-P Punto 5)
      const getFabDebugInfo = async () => {
        return await pageZones.evaluate(() => {
          const fab = document.querySelector('.home-fab-container');
          const hasBackdrop = Boolean(document.querySelector('.pe-discovery-see-all-backdrop'));
          const hasSheet = Boolean(document.querySelector('.pe-discovery-see-all-sheet'));
          const hasDetail = Boolean(document.querySelector('.pe-detail-overlay'));
          const hasZones = Boolean(document.querySelector('.pe-zones-overlay'));
          const hasAvisame = Boolean(document.querySelector('.pe-sheet-overlay'));
          if (!fab) return { exists: false, hasBackdrop, hasSheet, hasDetail, hasZones, hasAvisame };
          const style = window.getComputedStyle(fab);
          return {
            exists: true,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            hasBackdrop,
            hasSheet,
            hasDetail,
            hasZones,
            hasAvisame,
          };
        });
      };

      const isFabVisible = async () => {
        const info = await getFabDebugInfo();
        return info.exists && info.display !== 'none' && info.visibility !== 'hidden';
      };

      assert.ok(await isFabVisible(), 'FAB "+ Crear" debe estar visible normalmente en la Home');
      console.log(`  ✔ [Punto 5] FAB "+ Crear" visible en estado normal de Home`);

      // ─────────────────────────────────────────────────────────────
      // PRUEBA DE LOS 4 MODALES / SHEETS Y OCULTAMIENTO DEL FAB
      // ─────────────────────────────────────────────────────────────

      // Modal 1: Sheet vertical «Ver en lista» (.pe-discovery-see-all-backdrop / .pe-discovery-see-all-sheet)
      await seeInListBtn.click();
      await pageZones.waitForTimeout(350);

      const listSheet = pageZones.locator('[data-testid="discovery-see-all-sheet"]');
      await listSheet.waitFor({ state: 'visible', timeout: 3000 });
      const sheetTitle = pageZones.locator('.pe-discovery-see-all-title');
      const sheetTitleText = await sheetTitle.textContent();
      assert.ok(
        sheetTitleText.includes('Encuentros en tus zonas') ||
          sheetTitleText.includes('Encuentros abiertos') ||
          sheetTitleText.includes('Encuentros online'),
        `Título contextual de lista vertical correcto: "${sheetTitleText}"`
      );

      assert.ok(
        !(await isFabVisible()),
        'FAB "+ Crear" debe ocultarse automáticamente cuando el Sheet de lista vertical está abierto'
      );
      console.log(`  ✔ [Punto 5] FAB oculto con modal 1: «Ver en lista» (.pe-discovery-see-all-backdrop)`);

      // Captura screenshot Sheet vertical
      const sheetPath = path.join(artifactDir, `discovery-list-sheet-${vp.name}.png`);
      await pageZones.screenshot({ path: sheetPath });
      console.log(`  📷 Captura sheet vertical: ${sheetPath}`);

      // Cerrar modal 1 y verificar retorno del FAB
      const closeListBtn = pageZones.locator('[data-testid="discovery-see-all-close-btn"]');
      await closeListBtn.click({ force: true });
      await pageZones.locator('.pe-discovery-see-all-backdrop').waitFor({ state: 'detached', timeout: 3000 });
      assert.ok(await isFabVisible(), 'FAB "+ Crear" debe reaparecer al cerrar el Sheet de lista vertical');

      // Modal 2: Sheet de «Avisame» (.pe-sheet-overlay / .pe-avisame-sheet)
      await avisameBtn.click({ force: true });
      await pageZones.waitForTimeout(350);
      const avisameOverlay = pageZones.locator('.pe-sheet-overlay');
      await avisameOverlay.waitFor({ state: 'visible', timeout: 3000 });
      assert.ok(
        !(await isFabVisible()),
        'FAB "+ Crear" debe ocultarse automáticamente cuando Avisame sheet está abierto (.pe-sheet-overlay / .pe-avisame-sheet)'
      );
      console.log(`  ✔ [Punto 5] FAB oculto con modal 2: «Avisame» (.pe-sheet-overlay / .pe-avisame-sheet)`);

      // Cerrar modal 2 (tecla Escape o botón de cierre)
      await pageZones.keyboard.press('Escape');
      await pageZones.waitForTimeout(200);
      if (await avisameOverlay.isVisible()) {
        const closeAvisameBtn = pageZones.locator('.pe-avisame-close-btn');
        if (await closeAvisameBtn.isVisible()) {
          await closeAvisameBtn.click({ force: true });
        }
      }
      await avisameOverlay.waitFor({ state: 'detached', timeout: 3000 });
      assert.ok(await isFabVisible(), 'FAB "+ Crear" debe reaparecer al cerrar Avisame');

      // Modal 3: Modal de «Zonas» (.pe-zones-overlay / .pe-zones-modal)
      await zoneBadge.click({ force: true });
      await pageZones.waitForTimeout(350);
      const zonesModal = pageZones.locator('.pe-zones-modal');
      await zonesModal.waitFor({ state: 'visible', timeout: 3000 });
      assert.ok(
        !(await isFabVisible()),
        'FAB "+ Crear" debe ocultarse automáticamente cuando el selector de Zonas está abierto (.pe-zones-overlay / .pe-zones-modal)'
      );
      console.log(`  ✔ [Punto 5] FAB oculto con modal 3: «Zonas» (.pe-zones-overlay / .pe-zones-modal)`);

      // Cerrar modal 3 (botón cerrar de zonas)
      const closeZonesBtn = pageZones.locator('.pe-zones-modal__close-btn');
      await closeZonesBtn.click({ force: true });
      await pageZones.locator('.pe-zones-overlay').waitFor({ state: 'detached', timeout: 3000 });
      assert.ok(await isFabVisible(), 'FAB "+ Crear" debe reaparecer al cerrar Zonas');

      // Modal 4: Sheet de «Detalle» (.pe-detail-overlay / .pe-detail-sheet)
      const firstCard = pageZones.locator('.pe-discovery-item').first();
      await firstCard.waitFor({ state: 'visible', timeout: 3000 });
      await firstCard.click({ force: true });
      await pageZones.waitForTimeout(350);
      const detailSheet = pageZones.locator('.pe-detail-sheet');
      await detailSheet.waitFor({ state: 'visible', timeout: 3000 });
      assert.ok(
        !(await isFabVisible()),
        'FAB "+ Crear" debe ocultarse automáticamente cuando el Detalle está abierto (.pe-detail-overlay / .pe-detail-sheet)'
      );
      console.log(`  ✔ [Punto 5] FAB oculto con modal 4: «Detalle» (.pe-detail-overlay / .pe-detail-sheet)`);

      // Cerrar modal 4 (botón cerrar de detalle)
      const closeDetailBtn = pageZones.locator('.pe-detail-sheet__close-btn');
      await closeDetailBtn.click({ force: true });
      await pageZones.locator('.pe-detail-overlay').waitFor({ state: 'detached', timeout: 3000 });
      assert.ok(await isFabVisible(), 'FAB "+ Crear" debe reaparecer al cerrar Detalle');

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
      await pageNoZones.waitForTimeout(500);

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

      // C. Verificación de accesibilidad de acciones inferiores respecto al FAB (DIF-18-P Punto 1 & 5)
      const bottomActions = pageNoZones.locator('.pe-inspirational-actions');
      await bottomActions.scrollIntoViewIfNeeded();
      await pageNoZones.waitForTimeout(200);

      const openCreateBtn = pageNoZones.locator('[data-testid="inspirational-cta-create"]');
      const openAvisameBtn = pageNoZones.locator('[data-testid="inspirational-cta-avisame"]');
      assert.ok(await openCreateBtn.isVisible(), 'Botón "Abrir un encuentro" visible y accesible');
      assert.ok(await openAvisameBtn.isVisible(), 'Botón "Avisame si aparece uno" visible y accesible');

      // Captura screenshot Estado Inspirador
      const inspPath = path.join(artifactDir, `inspirational-state-${vp.name}.png`);
      await inspState.screenshot({ path: inspPath });
      console.log(`  📷 Captura estado inspirador: ${inspPath}`);

      await ctxNoZones.close();
    }

    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(`🎉 TODAS LAS PRUEBAS E2E Y RESPONSIVE PASARON EXITOSAMENTE`);
    console.log(`📁 Capturas almacenadas en: ${artifactDir}`);
    console.log(`═══════════════════════════════════════════════════════════`);
  } finally {
    if (browser) {
      console.log('🔒 Cerrando navegador Chromium...');
      await browser.close();
    }
    if (server) {
      console.log('🛑 Deteniendo servidor Vite preview...');
      await server.close();
    }
  }
}

run().catch((err) => {
  console.error('❌ Error en validación visual E2E:', err);
  process.exit(1);
});
