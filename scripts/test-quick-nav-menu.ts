import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Mini-sprint Prelanzamiento: Menú de navegación y accesos rápidos', () => {
  const rootDir = process.cwd();

  test('1. Estructura de archivos y componentes del menú', () => {
    const componentPath = path.join(rootDir, 'src/components/navigation/QuickNavMenu.tsx');
    const cssPath = path.join(rootDir, 'src/components/navigation/QuickNavMenu.css');

    assert.ok(fs.existsSync(componentPath), 'QuickNavMenu.tsx debe existir');
    assert.ok(fs.existsSync(cssPath), 'QuickNavMenu.css debe existir');

    const content = fs.readFileSync(componentPath, 'utf8');

    // Verifica que exporte QuickNavMenu y QuickNavMenuProps
    assert.match(content, /export interface QuickNavMenuProps/, 'Debe exportar QuickNavMenuProps');
    assert.match(content, /export const QuickNavMenu/, 'Debe exportar QuickNavMenu');

    // Verifica los tres grupos requeridos
    assert.match(content, /nav_menu\.group_activity/, 'Debe incluir Grupo A: Mi actividad');
    assert.match(content, /nav_menu\.group_explore/, 'Debe incluir Grupo B: Explorar');
    assert.match(content, /nav_menu\.group_info/, 'Debe incluir Grupo C: Información');

    // Verifica las opciones del Grupo A
    assert.match(content, /onSelectEncuentros/, 'Debe incluir opción Mis encuentros');
    assert.match(content, /onSelectGanas/, 'Debe incluir opción Mis ganas');
    assert.match(content, /onSelectSolicitudes/, 'Debe incluir opción Mis solicitudes');
    assert.match(content, /onSelectFavoritos/, 'Debe incluir opción Favoritos');
    assert.match(content, /onSelectMisListas/, 'Debe incluir opción Mis listas');

    // Verifica las opciones del Grupo B
    assert.match(content, /onSelectMeSumo/, 'Debe incluir opción Me sumo');
    assert.match(content, /onSelectMisAvisos/, 'Debe incluir opción Mis avisos');

    // Verifica las opciones del Grupo C
    assert.match(content, /onSelectHelp/, 'Debe incluir opción Cómo funciona / Ayuda');
    assert.match(content, /onSelectFeedback/, 'Debe incluir opción Enviar una opinión');
  });

  test('2. Accesibilidad y gestión de foco en QuickNavMenu', () => {
    const componentPath = path.join(rootDir, 'src/components/navigation/QuickNavMenu.tsx');
    const content = fs.readFileSync(componentPath, 'utf8');

    // Roles y atributos ARIA
    assert.match(content, /role="dialog"/, 'Debe tener role="dialog"');
    assert.match(content, /aria-modal="true"/, 'Debe tener aria-modal="true"');
    assert.match(content, /aria-label=/, 'Debe tener aria-label');

    // Manejo de tecla Escape y retorno de foco
    assert.match(content, /e\.key === 'Escape'/, 'Debe responder a la tecla Escape');
    assert.match(content, /triggerRef\?\.current\?\.focus\(\)/, 'Debe devolver el foco al disparador al cerrar');

    // Bloqueo de scroll en mobile
    assert.match(content, /document\.body\.style\.overflow = 'hidden'/, 'Debe contener el scroll de fondo en mobile');
  });

  test('3. Integración en Home.tsx: Reemplazo del botón de 3 puntos y preservación de otros controles', () => {
    const homePath = path.join(rootDir, 'src/screens/Home.tsx');
    const homeContent = fs.readFileSync(homePath, 'utf8');

    // Verifica que QuickNavMenu esté importado
    assert.match(homeContent, /import \{ QuickNavMenu \} from '@\/components\/navigation\/QuickNavMenu'/, 'QuickNavMenu debe estar importado en Home.tsx');

    // Verifica que el botón de menú utilice Menu de Lucide y atributos accesibles
    assert.match(homeContent, /<Menu size=\{22\} \/>/, 'El botón del header debe usar el ícono Menu de Lucide');
    assert.match(homeContent, /aria-label=\{t\('nav_menu\.button_label'/, 'El botón del header debe tener aria-label accesible');
    assert.match(homeContent, /aria-expanded=\{isNavMenuOpen\}/, 'El botón del header debe comunicar el estado aria-expanded');
    assert.match(homeContent, /aria-haspopup="dialog"/, 'El botón del header debe tener aria-haspopup');

    // Verifica que los controles independientes sigan existiendo intactos
    assert.match(homeContent, /home-header-bell-btn/, 'La campana de notificaciones debe conservarse intacta');
    assert.match(homeContent, /home-header-avatar-btn/, 'El avatar de cuenta debe conservarse intacto');
    assert.match(homeContent, /className="home-fab"/, 'El botón flotante persistente + Crear debe conservarse intacto');
  });

  test('4. Conexión limpia a Mi espacio, Discovery y Avisame sin duplicar modales ni estado', () => {
    const homePath = path.join(rootDir, 'src/screens/Home.tsx');
    const openEncountersPath = path.join(rootDir, 'src/components/home/openEncounters/HomeOpenEncounters.tsx');
    const homeContent = fs.readFileSync(homePath, 'utf8');
    const openEncountersContent = fs.readFileSync(openEncountersPath, 'utf8');

    // Navegación controlada a Mi espacio
    assert.match(homeContent, /id="home-personal-activity-section"/, 'Mi espacio debe tener id="home-personal-activity-section" para scroll seguro');
    assert.match(homeContent, /personalActivityRef/, 'Home.tsx debe utilizar referencia React para Mi espacio');
    assert.match(homeContent, /setUserSectionTab\(tab\)/, 'Al seleccionar pestaña debe sincronizar userSectionTab');

    // Navegación a Discovery
    assert.match(homeContent, /home-discovery-section/, 'Me sumo debe desplazarse a home-discovery-section');

    // Apertura limpia de Avisame vía prop externa sin duplicar el modal
    assert.match(homeContent, /externalAvisameTrigger=\{externalAvisameTrigger\}/, 'HomeOpenEncounters debe recibir externalAvisameTrigger');
    assert.match(openEncountersContent, /externalAvisameTrigger\?: \{ tab: 'create' \| 'list'; timestamp: number \} \| null/, 'HomeOpenEncountersProps debe tipar externalAvisameTrigger');
    assert.match(openEncountersContent, /setAvisameTab\(externalAvisameTrigger\.tab\)/, 'Debe activar la pestaña configurada en externalAvisameTrigger');
    assert.match(openEncountersContent, /setIsAvisameOpen\(true\)/, 'Debe abrir la única instancia de AvisameSheet');

    // Protección de usuario en Avisame: si no es permanente, solicita login
    assert.match(openEncountersContent, /if \(!isPermanentUser\) \{\s*setLoginSheetAction\('create_alert'\);\s*setIsLoginSheetOpen\(true\);/, 'Si no es permanente, Avisame solicita login');
  });

  test('5. Protección de permisos para usuarios anónimos y permanentes', () => {
    const homePath = path.join(rootDir, 'src/screens/Home.tsx');
    const navPath = path.join(rootDir, 'src/components/navigation/QuickNavMenu.tsx');
    const homeContent = fs.readFileSync(homePath, 'utf8');
    const navContent = fs.readFileSync(navPath, 'utf8');

    // En QuickNavMenu se muestra el tag de requerimiento si no es permanente
    assert.match(navContent, /!isPermanentUser && \(\s*<span className="pe-quick-nav-tag-account">/, 'Debe señalar visualmente requerimiento de cuenta para Favoritos, Listas y Avisos');

    // En Home.tsx los manejadores redirigen a AccountSheet/login si !isPermanentUser
    assert.match(homeContent, /if \(!isPermanentUser\) \{\s*setIsAccountOpen\(true\);\s*return;\s*\}\s*setIsFavoritesOpen\(true\);/, 'Favoritos no se abre para usuario sin cuenta permanente');
    assert.match(homeContent, /if \(!isPermanentUser\) \{\s*setIsAccountOpen\(true\);\s*return;\s*\}\s*setIsGuestListsOpen\(true\);/, 'Mis listas no se abre para usuario sin cuenta permanente');
  });

  test('6. Apertura de Cómo funciona en sección 1 conservando demás secciones de InfoSheet', () => {
    const infoSheetPath = path.join(rootDir, 'src/components/ui/InfoSheet.tsx');
    const homePath = path.join(rootDir, 'src/screens/Home.tsx');
    const infoContent = fs.readFileSync(infoSheetPath, 'utf8');
    const homeContent = fs.readFileSync(homePath, 'utf8');

    // InfoSheet acepta initialSection opcional
    assert.match(infoContent, /initialSection\?: number \| null/, 'InfoSheetProps debe soportar initialSection');
    assert.match(infoContent, /setActiveSection\(initialSection \?\? null\)/, 'InfoSheet debe sincronizar activeSection con initialSection');

    // Home pasa initialSection=1 (Cómo funciona) y resetea al cerrar
    assert.match(homeContent, /setInfoInitialSection\(1\)/, 'Al seleccionar Ayuda se especifica sección 1 (Cómo funciona)');
    assert.match(homeContent, /initialSection=\{infoInitialSection\}/, 'InfoSheet recibe prop initialSection');
    assert.match(homeContent, /setInfoInitialSection\(null\)/, 'InfoSheet limpia initialSection al cerrar');
  });

  test('7. Adaptabilidad CSS: Mobile Bottom Sheet y Desktop Dropdown compacto', () => {
    const cssPath = path.join(rootDir, 'src/components/navigation/QuickNavMenu.css');
    const homeCssPath = path.join(rootDir, 'src/screens/Home.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');
    const homeCssContent = fs.readFileSync(homeCssPath, 'utf8');

    // Mobile: fixed bottom sheet
    assert.match(cssContent, /@media \(max-width: 767px\)/, 'Debe incluir media query mobile');
    assert.match(cssContent, /position: fixed;/, 'Panel mobile debe ser fixed');
    assert.match(cssContent, /bottom: 0;/, 'Panel mobile debe anclarse al fondo');
    assert.match(cssContent, /slideUpQuickNavMobile/, 'Panel mobile debe animarse deslizándose hacia arriba');

    // Desktop: absolute dropdown
    assert.match(cssContent, /@media \(min-width: 768px\)/, 'Debe incluir media query desktop');
    assert.match(cssContent, /position: absolute;/, 'Panel desktop debe ser absolute');
    assert.match(cssContent, /top: calc\(100% \+ 8px\);/, 'Panel desktop debe posicionarse bajo el header');

    // Home.css: anchor relativo y scroll-margin-top
    assert.match(homeCssContent, /\.home-header-actions \{\s*display: flex;\s*align-items: center;\s*gap: 8px;\s*position: relative;/, '.home-header-actions debe tener position: relative');
    assert.match(homeCssContent, /scroll-margin-top: calc\(75px \+ env\(safe-area-inset-top, 0px\)\);/, 'Secciones de destino deben definir scroll-margin-top para el header sticky');

    // Prefers reduced motion
    assert.match(cssContent, /@media \(prefers-reduced-motion: reduce\)/, 'Debe respetar prefers-reduced-motion');
  });

  test('8. Consistencia estricta de Internacionalización (ES, EN, PT-BR, PT)', () => {
    const es = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/locales/es.json'), 'utf8'));
    const en = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/locales/en.json'), 'utf8'));
    const ptBr = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/locales/pt-BR.json'), 'utf8'));
    const pt = JSON.parse(fs.readFileSync(path.join(rootDir, 'src/i18n/locales/pt.json'), 'utf8'));

    const requiredKeys = [
      'button_label',
      'title',
      'close',
      'group_activity',
      'group_explore',
      'group_info',
      'my_encounters',
      'my_intentions',
      'my_requests',
      'favorites',
      'my_lists',
      'explore_open',
      'my_alerts',
      'help',
      'feedback',
      'requires_account',
      'pending_badge',
      'pending_badge_plural',
    ];

    assert.ok(es.nav_menu, 'es.json debe incluir objeto nav_menu');
    assert.ok(en.nav_menu, 'en.json debe incluir objeto nav_menu');
    assert.ok(ptBr.nav_menu, 'pt-BR.json debe incluir objeto nav_menu');
    assert.ok(pt.nav_menu, 'pt.json debe incluir objeto nav_menu');

    for (const key of requiredKeys) {
      assert.ok(es.nav_menu[key], `es.json nav_menu.${key} debe existir`);
      assert.ok(en.nav_menu[key], `en.json nav_menu.${key} debe existir`);
      assert.ok(ptBr.nav_menu[key], `pt-BR.json nav_menu.${key} debe existir`);
      assert.ok(pt.nav_menu[key], `pt.json nav_menu.${key} debe existir`);
    }

    // Nombres exactos en castellano según arquitectura verbal
    assert.strictEqual(es.nav_menu.my_encounters, 'Mis encuentros');
    assert.strictEqual(es.nav_menu.my_intentions, 'Mis ganas');
    assert.strictEqual(es.nav_menu.my_requests, 'Mis solicitudes');
    assert.strictEqual(es.nav_menu.favorites, 'Favoritos');
    assert.strictEqual(es.nav_menu.my_lists, 'Mis listas');
    assert.strictEqual(es.nav_menu.explore_open, 'Me sumo');
    assert.strictEqual(es.nav_menu.my_alerts, 'Mis avisos');
    assert.strictEqual(es.nav_menu.help, 'Cómo funciona / Ayuda');
    assert.strictEqual(es.nav_menu.feedback, 'Enviar una opinión');
  });

  test('9. Validación de Home V2 activa por defecto en Producción y Staging con Menú, Mi Espacio y Me Sumo', () => {
    const homePath = path.join(rootDir, 'src/screens/Home.tsx');
    const homeContent = fs.readFileSync(homePath, 'utf8');

    // Confirma que isV2Variant NO depende de isProductionEnv
    assert.ok(!homeContent.includes('!isProductionEnv'), 'isV2Variant no debe depender de !isProductionEnv');
    assert.ok(!homeContent.includes('const isProductionEnv'), 'Home.tsx no debe definir un guard restrictivo isProductionEnv para V2');
    assert.match(homeContent, /const isV2Variant = propHomeVariant !== 'v1' && queryHomeVariant !== 'v1';/, 'Home V2 debe ser la variante activa por defecto');
  });
});
