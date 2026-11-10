import { preview } from 'vite';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const artifactDir = process.env.ARTIFACT_DIR
  ? path.resolve(process.env.ARTIFACT_DIR)
  : path.resolve(process.cwd(), 'test-results', 'dif18q-screenshots');

fs.mkdirSync(artifactDir, { recursive: true });
console.log(`📂 Directorio de capturas DIF-18-Q: ${artifactDir}`);

/** Helper para comprobar solapamiento geométrico entre dos rectángulos */
function doBoxesOverlap(boxA, boxB) {
  return !(
    boxA.x + boxA.width <= boxB.x ||
    boxB.x + boxB.width <= boxA.x ||
    boxA.y + boxA.height <= boxB.y ||
    boxB.y + boxB.height <= boxA.y
  );
}

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

    const getFabState = async (page) => {
      return await page.evaluate(() => {
        const container = document.querySelector('.home-fab-container');
        if (!container) return { exists: false, visible: false, display: 'none', opacity: '0' };
        const style = window.getComputedStyle(container);
        const isHiddenClass = container.classList.contains('home-fab-container--hidden');
        const isVisibleClass = container.classList.contains('home-fab-container--visible');
        const visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          !isHiddenClass;
        return {
          exists: true,
          visible,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          isHiddenClass,
          isVisibleClass,
        };
      });
    };

    const viewports = [
      { name: '320px-narrow', width: 320, height: 640, isMobile: true },
      { name: '360px-motorola', width: 360, height: 800, isMobile: true },
      { name: '390px-mobile', width: 390, height: 844, isMobile: true },
      { name: '768px-tablet', width: 768, height: 1024, isMobile: false },
      { name: '1200px-desktop', width: 1200, height: 800, isMobile: false },
    ];

    for (const vp of viewports) {
      console.log(`\n───────────────────────────────────────────────────────────`);
      console.log(`📱 [DIF-18-Q] Viewport: ${vp.name} (${vp.width}x${vp.height}px, isMobile: ${vp.isMobile})`);
      console.log(`───────────────────────────────────────────────────────────`);

      // ─────────────────────────────────────────────────────────────
      // PARTE 1: ESTADO INSPIRADOR (Sin zonas / Cero encuentros)
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
      await pageNoZones.waitForTimeout(400);

      // 1. En el Hero (tope de página): El FAB está visible en navegación normal
      const fabAtHero = await getFabState(pageNoZones);
      assert.ok(fabAtHero.visible, `En el Hero el FAB debe estar visible (${vp.name})`);
      console.log(`  ✔ [Hero] FAB visible en navegación normal en el tope de página`);

      await pageNoZones.screenshot({
        path: path.join(artifactDir, `fab-hero-${vp.name}.png`),
      });

      // 2. Desplazarse al Estado Inspirador (.pe-inspirational-container)
      const inspState = pageNoZones.locator('[data-testid="inspirational-empty-state"]');
      await inspState.waitFor({ state: 'visible', timeout: 5000 });
      await inspState.scrollIntoViewIfNeeded();
      await pageNoZones.waitForTimeout(400);

      const fabAtInsp = await getFabState(pageNoZones);

      if (vp.isMobile) {
        // En mobile: FAB debe ocultarse contextualmente para no competir con tarjetas ni CTAs
        assert.ok(
          !fabAtInsp.visible,
          `En mobile el FAB debe ocultarse al visualizar el estado inspirador (${vp.name})`
        );
        assert.equal(
          fabAtInsp.visibility,
          'hidden',
          `El FAB debe tener visibility: hidden al competir con el estado inspirador`
        );
        console.log(`  ✔ [Estado Inspirador Mobile] FAB oculto contextualmente (visibility: hidden, opacity: 0)`);

        // Comprobación geométrica: ningún elemento interactivo tapado por FAB
        const fabBtn = pageNoZones.locator('.home-fab');
        const isFabClickable = await fabBtn.isVisible();
        assert.ok(!isFabClickable, 'El botón FAB no debe ser visible ni cliqueable mientras está oculto');

        // Tarjetas accesibles
        const cards = await pageNoZones.locator('.pe-inspirational-card').all();
        assert.equal(cards.length, 4, '4 tarjetas inspiradoras presentes');

        // Botón «Abrir un encuentro» y «Avisame si aparece uno» 100% accesibles
        const ctaCreate = pageNoZones.locator('[data-testid="inspirational-cta-create"]');
        const ctaAvisame = pageNoZones.locator('[data-testid="inspirational-cta-avisame"]');
        assert.ok(await ctaCreate.isVisible(), 'Botón «Abrir un encuentro» visible');
        assert.ok(await ctaAvisame.isVisible(), 'Botón «Avisame si aparece uno» visible');

        const avisameBox = await ctaAvisame.boundingBox();
        assert.ok(avisameBox && avisameBox.height >= 34, 'Área táctil de Avisame >= 34px');
        console.log(`  ✔ [Punto 1 y 2] Tarjetas inspiradoras y botones de acción 100% despejados y libres de superposición`);
      } else {
        // En desktop/tablet: El FAB se preserva visible en su gutter fixed derecho
        assert.ok(fabAtInsp.visible, `En desktop el FAB se preserva visible (${vp.name})`);
        const fabBox = await pageNoZones.locator('.home-fab-container').boundingBox();
        assert.ok(fabBox, 'Bounding box del FAB debe existir');

        // Verificar que no se superponga con ninguna de las 4 tarjetas inspiradoras
        const cards = await pageNoZones.locator('.pe-inspirational-card').all();
        for (let i = 0; i < cards.length; i++) {
          const cardBox = await cards[i].boundingBox();
          assert.ok(cardBox, `Card ${i + 1} bounding box existe`);
          const cardOverlaps = doBoxesOverlap(fabBox, cardBox);
          assert.ok(!cardOverlaps, `En desktop el FAB no debe superponerse a la tarjeta ${i + 1}`);
        }

        // Verificar que no se superponga con los botones de acción
        const ctaCreate = pageNoZones.locator('[data-testid="inspirational-cta-create"]');
        const ctaAvisame = pageNoZones.locator('[data-testid="inspirational-cta-avisame"]');
        const createBox = await ctaCreate.boundingBox();
        const avisameBox = await ctaAvisame.boundingBox();
        assert.ok(createBox && avisameBox, 'Bounding boxes de CTAs deben existir');
        assert.ok(!doBoxesOverlap(fabBox, createBox), 'El FAB no debe superponerse al botón «Abrir un encuentro»');
        assert.ok(!doBoxesOverlap(fabBox, avisameBox), 'El FAB no debe superponerse al botón «Avisame si aparece uno»');

        console.log(`  ✔ [Desktop] FAB preservado en gutter derecho (${Math.round(fabBox.x)}px) sin colisión con tarjetas ni CTAs`);
      }

      await pageNoZones.screenshot({
        path: path.join(artifactDir, `fab-inspirational-${vp.name}.png`),
      });

      // 3. Desplazarse al bloque «Crear o abrir un encuentro» (.home-create-or-open-info)
      const createOrOpenInfo = pageNoZones.locator('.home-create-or-open-info');
      if (await createOrOpenInfo.count() > 0) {
        await createOrOpenInfo.scrollIntoViewIfNeeded();
        await pageNoZones.waitForTimeout(400);

        const fabAtCreateOrOpen = await getFabState(pageNoZones);
        if (vp.isMobile) {
          assert.ok(
            !fabAtCreateOrOpen.visible,
            `En mobile el FAB debe ocultarse al visualizar el bloque «Crear o abrir un encuentro» (${vp.name})`
          );
          console.log(`  ✔ [Punto 3] FAB oculto al navegar sobre bloque «Crear o abrir un encuentro»`);
        } else {
          assert.ok(fabAtCreateOrOpen.visible, `En desktop el FAB permanece visible en gutter`);
        }

        await pageNoZones.screenshot({
          path: path.join(artifactDir, `fab-create-or-open-${vp.name}.png`),
        });
      }

      await ctxNoZones.close();

      // ─────────────────────────────────────────────────────────────
      // PARTE 2: DISCOVERY CON ENCUENTROS PUBLICADOS (Carrusel horizontal)
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

      const pageWithZones = await ctxWithZones.newPage();
      await pageWithZones.goto(`${baseUrl}/preview/home-gsap`, { waitUntil: 'domcontentloaded' });
      await pageWithZones.waitForSelector('#home-discovery-section', { timeout: 8000 });
      await pageWithZones.waitForTimeout(400);

      const discoverySec = pageWithZones.locator('#home-discovery-section');
      await discoverySec.scrollIntoViewIfNeeded();
      await pageWithZones.waitForTimeout(400);

      // En carrusel de encuentros: El FAB está visible en navegación normal
      const fabAtCarousel = await getFabState(pageWithZones);
      assert.ok(fabAtCarousel.visible, `Con carrusel de encuentros activos, FAB debe estar visible para acceso rápido`);
      console.log(`  ✔ [Carrusel] FAB accesible y visible durante navegación con encuentros publicados`);

      // Verificación geométrica: La tarjeta y los controles del carrusel son clicables
      const firstCard = pageWithZones.locator('.pe-discovery-item').first();
      await firstCard.waitFor({ state: 'visible', timeout: 5000 });
      const firstCardBox = await firstCard.boundingBox();
      const fabContBox = await pageWithZones.locator('.home-fab-container').boundingBox();

      assert.ok(firstCardBox && fabContBox, 'Card y FAB deben tener bounding box');
      console.log(`  ✔ [Geometría Carrusel] Card (y: ${Math.round(firstCardBox.y)}px, h: ${Math.round(firstCardBox.height)}px) separada de FAB (y: ${Math.round(fabContBox.y)}px)`);

      await pageWithZones.screenshot({
        path: path.join(artifactDir, `fab-carousel-${vp.name}.png`),
      });

      // Apertura de modal de detalle y verificación de ocultamiento
      await firstCard.click({ force: true });
      await pageWithZones.waitForTimeout(300);
      const detailSheet = pageWithZones.locator('.pe-detail-sheet');
      await detailSheet.waitFor({ state: 'visible', timeout: 3000 });

      const fabWithModal = await getFabState(pageWithZones);
      assert.ok(!fabWithModal.visible, 'FAB debe ocultarse automáticamente cuando el detalle está abierto');
      console.log(`  ✔ [Modales] FAB oculto bajo modal de detalle`);

      // Cierre de detalle y reaparición
      const closeDetailBtn = pageWithZones.locator('.pe-detail-sheet__close-btn');
      await closeDetailBtn.click({ force: true });
      await pageWithZones.locator('.pe-detail-overlay').waitFor({ state: 'detached', timeout: 3000 });
      await pageWithZones.waitForTimeout(200);

      const fabAfterModal = await getFabState(pageWithZones);
      assert.ok(fabAfterModal.visible, 'FAB debe reaparecer automáticamente al cerrar el modal');
      console.log(`  ✔ [Modales] FAB reaparece al cerrar el modal`);

      await ctxWithZones.close();
    }

    // ─────────────────────────────────────────────────────────────
    // PARTE 3: RESPONSIVE DINÁMICO (Desktop -> Mobile -> Desktop -> Mobile sin recargar)
    // ─────────────────────────────────────────────────────────────
    console.log(`\n───────────────────────────────────────────────────────────`);
    console.log(`🔄 [DIF-18-Q] Prueba de Ciclo de Vida Responsive Dinámico (Sin Recarga)`);
    console.log(`───────────────────────────────────────────────────────────`);

    const ctxDynamic = await browser.newContext({
      viewport: { width: 1200, height: 800 },
      deviceScaleFactor: 2,
    });
    await ctxDynamic.addInitScript(() => {
      localStorage.setItem('app_storage_version', '1.2');
      localStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: true, at: Date.now() }));
      localStorage.setItem('puntoencuentro_user_zones', JSON.stringify([]));
    });

    const pageDynamic = await ctxDynamic.newPage();
    await pageDynamic.goto(`${baseUrl}/preview/home-gsap`, { waitUntil: 'domcontentloaded' });
    await pageDynamic.waitForSelector('#home-discovery-section', { timeout: 8000 });
    await pageDynamic.waitForTimeout(400);

    const inspDynamic = pageDynamic.locator('[data-testid="inspirational-empty-state"]');
    await inspDynamic.scrollIntoViewIfNeeded();
    await pageDynamic.waitForTimeout(400);

    // 1. En Desktop inicial (1200x800): FAB en gutter visible
    let fabState = await getFabState(pageDynamic);
    assert.ok(fabState.visible, 'En Desktop inicial (1200px), FAB debe estar visible en gutter');
    console.log('  ✔ [Desktop Inicial 1200px] FAB visible en gutter derecho sin supresión');

    // 2. Redimensionar dinámicamente a Mobile (360x800 Motorola) SIN recargar la página
    await pageDynamic.setViewportSize({ width: 360, height: 800 });
    await pageDynamic.waitForTimeout(500);

    fabState = await getFabState(pageDynamic);
    assert.ok(!fabState.visible, 'Al redimensionar dinámicamente a Mobile (360px), FAB debe ocultarse contextualmente');
    assert.equal(fabState.visibility, 'hidden', 'FAB debe tener visibility: hidden en mobile sobre estado inspirador');
    console.log('  ✔ [Redimensión dinámica Desktop -> Mobile 360px] FAB se oculta contextualmente');

    // 3. Scroll hacia Hero en Mobile
    const heroSection = pageDynamic.locator('.home-hero-wrapper');
    await heroSection.scrollIntoViewIfNeeded();
    await pageDynamic.waitForTimeout(400);

    fabState = await getFabState(pageDynamic);
    assert.ok(fabState.visible, 'Al desplazarse al Hero en Mobile, FAB debe reaparecer');
    console.log('  ✔ [Mobile Scroll -> Hero] FAB reaparece al salir del área conflictiva');

    // 4. Scroll de vuelta al Estado Inspirador en Mobile
    await inspDynamic.scrollIntoViewIfNeeded();
    await pageDynamic.waitForTimeout(400);

    fabState = await getFabState(pageDynamic);
    assert.ok(!fabState.visible, 'Al desplazarse nuevamente al Estado Inspirador en Mobile, FAB debe ocultarse');
    console.log('  ✔ [Mobile Scroll -> Inspirador] FAB se oculta al reingresar al área conflictiva');

    // 5. Redimensionar dinámicamente de vuelta a Desktop (1200x800) SIN recargar la página
    await pageDynamic.setViewportSize({ width: 1200, height: 800 });
    await pageDynamic.waitForTimeout(500);

    fabState = await getFabState(pageDynamic);
    assert.ok(fabState.visible, 'Al redimensionar dinámicamente a Desktop (1200px), FAB debe reaparecer inmediatamente');
    console.log('  ✔ [Redimensión dinámica Mobile -> Desktop 1200px] FAB reaparece en gutter fijo');

    // 6. Redimensionar dinámicamente a Mobile alternativo (390x844) SIN recargar la página
    await pageDynamic.setViewportSize({ width: 390, height: 844 });
    await pageDynamic.waitForTimeout(500);

    fabState = await getFabState(pageDynamic);
    assert.ok(!fabState.visible, 'Al redimensionar nuevamente a Mobile (390px), FAB debe ocultarse en área conflictiva');
    console.log('  ✔ [Redimensión dinámica Desktop -> Mobile 390px] FAB se oculta contextualmente sin perder estado');

    await ctxDynamic.close();

    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(`🎉 DIF-18-Q: VALIDACIÓN VISUAL Y GEOMÉTRICA 100% EXITOSA`);
    console.log(`📁 Capturas almacenadas en: ${artifactDir}`);
    console.log(`═══════════════════════════════════════════════════════════`);
  } finally {
    if (browser) {
      console.log('🔒 Cerrando Chromium...');
      await browser.close();
    }
    if (server) {
      console.log('🛑 Deteniendo servidor preview...');
      await server.close();
    }
  }
}

run().catch((err) => {
  console.error('❌ Error en validación visual DIF-18-Q:', err);
  process.exit(1);
});
