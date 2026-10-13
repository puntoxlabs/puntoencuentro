import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Home from '../src/screens/Home';
import { AuthContext } from '../src/contexts/AuthContext';
import { NotificationsProvider } from '../src/contexts/NotificationsContext';
import { HomeSolicitudesSection } from '../src/components/home/solicitudes/HomeSolicitudesSection';
import { HomeIntencionesSection } from '../src/components/home/intentions/HomeIntencionesSection';
import { IntencionCard } from '../src/components/home/intentions/IntencionCard';
import type { Intencion } from '../src/types/intenciones';

describe('Mi espacio Mobile (360px, 390px, 412px, Font Scaling) — Suite de Verificación UI/UX', () => {
  const mockUser = {
    id: 'test-user-mobile-uid',
    email: 'mobile-test@example.com',
    user_metadata: { full_name: 'Usuario Mobile' },
    is_anonymous: false,
  };

  const authValue = {
    user: mockUser,
    isPermanentUser: true,
    authLoading: false,
    signInWithGoogleForDiscovery: async () => {},
    signOut: async () => {},
  };

  test('1. TABS: Renderiza las 3 pestañas con atributos de accesibilidad rol tab y tablist', () => {
    const html = renderToString(
      React.createElement(
        AuthContext.Provider,
        { value: authValue },
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/?homeVariant=v2'] },
          React.createElement(NotificationsProvider, null, React.createElement(Home, { homeVariant: 'v2' }))
        )
      )
    );

    // Contenedor tablist
    assert.ok(html.includes('role="tablist"'), 'Debe contener un contenedor con role="tablist"');
    assert.ok(html.includes('home-user-tabs'), 'Debe contener la clase .home-user-tabs');

    // Las 3 tabs deben existir con role="tab"
    assert.ok(html.includes('Mis encuentros'), 'Debe renderizar la tab Mis encuentros');
    assert.ok(html.includes('Mis ganas'), 'Debe renderizar la tab Mis ganas');
    assert.ok(html.includes('Mis solicitudes'), 'Debe renderizar la tab Mis solicitudes');

    // La primera tab debe estar activa por defecto
    assert.ok(html.includes('home-user-tab--active'), 'Debe tener una tab activa');
    assert.ok(html.includes('aria-selected="true"'), 'Debe marcar aria-selected="true" en la tab activa');
  });

  test('2. CSS TABS: Soporta scroll horizontal nativo defensivo sin romper la página en 360px ni con font scaling', () => {
    const homeCss = readFileSync(resolve(process.cwd(), 'src/screens/Home.css'), 'utf8');

    // Comprobar overflow-x: auto y scrollbar oculta en .home-user-tabs
    assert.ok(homeCss.includes('.home-user-tabs {'), 'Debe definir .home-user-tabs');
    assert.ok(homeCss.includes('overflow-x: auto'), 'Debe permitir overflow-x: auto para contener scroll en pantallas angostas');
    assert.ok(homeCss.includes('scrollbar-width: none'), 'Debe ocultar la barra de scroll en Firefox');
    assert.ok(homeCss.includes('-webkit-overflow-scrolling: touch'), 'Debe tener inercia táctil para iOS');

    // Comprobar white-space: nowrap y flex-shrink: 0 en .home-user-tab
    assert.ok(homeCss.includes('white-space: nowrap'), 'Debe impedir saltos de línea feos en el texto de las tabs');
    assert.ok(homeCss.includes('flex-shrink: 0'), 'Las tabs no deben estrangularse ni deformarse');

    // Comprobar media query para mobile angosto (<= 412px)
    assert.ok(homeCss.includes('@media (max-width: 412px)'), 'Debe incluir ajustes para pantallas de 360-412px');
    assert.ok(homeCss.includes('min-height: 36px') || homeCss.includes('min-height: 38px'), 'Debe asegurar target táctil cómodo');
  });

  test('3. BADGES EN TABS: Badge de solicitudes pendientes no deforma la tab ni tape texto', () => {
    const homeCss = readFileSync(resolve(process.cwd(), 'src/screens/Home.css'), 'utf8');

    assert.ok(homeCss.includes('.home-user-tab-badge {'), 'Debe existir .home-user-tab-badge');
    assert.ok(homeCss.includes('flex-shrink: 0'), 'El badge debe tener flex-shrink: 0');
    assert.ok(homeCss.includes('box-sizing: border-box'), 'El badge debe tener box-sizing border-box');
  });

  test('4. PANEL DE PESTAÑA: .home-user-tab-panel unifica el espaciado vertical y elimina saltos', () => {
    const homeCss = readFileSync(resolve(process.cwd(), 'src/screens/Home.css'), 'utf8');

    assert.ok(homeCss.includes('.home-user-tab-panel {'), 'Debe definir .home-user-tab-panel');
    assert.ok(homeCss.includes('margin-top: 0.75rem'), 'Debe tener ritmo vertical mobile controlado');
  });

  test('5. MIS SOLICITUDES: Componente renderiza empty state y estructura accesible', () => {
    const htmlEmpty = renderToString(
      React.createElement(
        AuthContext.Provider,
        { value: authValue },
        React.createElement(HomeSolicitudesSection, {
          onSelectEncuentro: () => {},
          initialLoading: false,
        })
      )
    );

    // Empty state
    assert.ok(htmlEmpty.includes('pe-solicitudes-section'), 'Debe contener la clase .pe-solicitudes-section');
    assert.ok(
      htmlEmpty.includes('pe-solicitudes-loading') || htmlEmpty.includes('pe-solicitudes-empty'),
      'Debe renderizar estado de carga o vacío limpio'
    );
    // Verificación de copy sin lenguaje interno "Discovery"
    assert.ok(!htmlEmpty.includes('Discovery'), 'El copy del empty state NO debe incluir la palabra técnica Discovery');
    assert.ok(
      htmlEmpty.includes('vas a poder seguir el estado de tu solicitud acá') ||
      htmlEmpty.includes('podrás seguir el estado de tu solicitud acá'),
      'Debe incluir el texto humano de seguimiento'
    );
  });

  test('6. MIS SOLICITUDES CSS: Acciones responsivas con flex-wrap y botones cómodos en mobile', () => {
    const solicitudesCss = readFileSync(
      resolve(process.cwd(), 'src/components/home/solicitudes/HomeSolicitudesSection.css'),
      'utf8'
    );

    assert.ok(solicitudesCss.includes('.pe-solicitud-actions {'), 'Debe definir .pe-solicitud-actions');
    assert.ok(solicitudesCss.includes('flex-wrap: wrap'), 'Las acciones deben permitir wrap en mobile');
    assert.ok(solicitudesCss.includes('@media (max-width: 480px)'), 'Debe definir reglas para mobile angosto');
    assert.ok(solicitudesCss.includes('min-height: 38px'), 'Botones deben tener altura táctil mínima de 38px');
    assert.ok(solicitudesCss.includes('word-break: break-word'), 'El título de la solicitud debe evitar overflow por palabras largas');
    assert.ok(solicitudesCss.includes('flex-shrink: 0'), 'El badge de solicitud no debe aplastarse');
  });

  test('7. MIS GANAS: Mini card V2 compacta sin botones visibles repetidos (acciones dentro del menú ⋮)', () => {
    const mockIntencion: Intencion = {
      id: 'intencion-test-1',
      usuario_id: 'test-user-mobile-uid',
      titulo: 'Caminata fotográfica por la costa con título extraordinariamente largo para probar wrap',
      descripcion: 'Salida de tarde con cámara para probar el comportamiento en viewports de 360px',
      modalidad: 'presencial',
      localidad_id: 'loc-1',
      localidad_nombre: 'Centro',
      temporalidad_texto: 'Este fin de semana',
      estado: 'activa',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const htmlCard = renderToString(
      React.createElement(IntencionCard, {
        intencion: mockIntencion,
        onEdit: () => {},
        onPausar: () => {},
        onReactivar: () => {},
        onCerrar: () => {},
        onOrganizar: () => {},
        isV2Variant: true,
      })
    );

    assert.ok(htmlCard.includes('pe-intencion-card--mini'), 'Debe tener la clase mini en V2');
    assert.ok(htmlCard.includes('pe-intencion-card__title'), 'Debe renderizar el título');
    assert.ok(htmlCard.includes('pe-intencion-card__status-badge'), 'Debe renderizar badge de estado');
    assert.ok(htmlCard.includes('pe-intencion-card__more-btn'), 'Debe tener botón de más opciones accesible');

    // Los botones primarios repetidos NO deben estar en el footer visible en V2
    assert.ok(!htmlCard.includes('pe-intencion-card__primary-actions'), 'En V2 no deben renderizarse botones primarios repetidos fuera del menú');
    assert.ok(!htmlCard.includes('pe-intencion-card__footer'), 'En V2 no debe existir barra footer repetida');

    // Las opciones deben estar integradas en el menú con role="menuitem"
    assert.ok(htmlCard.includes('role="menu"'), 'Debe contener el menú desplegable accesible');
    assert.ok(htmlCard.includes('Organizar'), 'El menú debe contener la acción Organizar');
    assert.ok(htmlCard.includes('Editar'), 'El menú debe contener la acción Editar');
    assert.ok(htmlCard.includes('Pausar'), 'El menú debe contener la acción Pausar');
    assert.ok(htmlCard.includes('Cerrar'), 'El menú debe contener la acción Cerrar');

    // Verificar orden en el HTML del menú: Organizar -> Editar -> Pausar -> Cerrar
    const idxOrganizar = htmlCard.indexOf('Organizar');
    const idxEditar = htmlCard.indexOf('Editar');
    const idxPausar = htmlCard.indexOf('Pausar');
    const idxCerrar = htmlCard.indexOf('Cerrar');
    assert.ok(idxOrganizar < idxEditar, 'Organizar debe preceder a Editar');
    assert.ok(idxEditar < idxPausar, 'Editar debe preceder a Pausar');
    assert.ok(idxPausar < idxCerrar, 'Pausar debe preceder a Cerrar');
  });

  test('8. MIS GANAS ESTILO: Degradé sutil, base blanca y bordes suaves en IntencionCard.css', () => {
    const cardCss = readFileSync(
      resolve(process.cwd(), 'src/components/home/intentions/IntencionCard.css'),
      'utf8'
    );

    assert.ok(cardCss.includes('linear-gradient('), 'Mini card debe tener degradé suave');
    assert.ok(cardCss.includes('#ffffff'), 'Mini card debe partir de base blanca');
    assert.ok(cardCss.includes('.pe-intencion-card__menu-separator'), 'Debe existir separador antes de opción destructiva');
  });

  test('9. MIS ENCUENTROS: ActiveCard header tiene flex-wrap defensivo para badges y títulos largos', () => {
    const homeTsx = readFileSync(resolve(process.cwd(), 'src/screens/Home.tsx'), 'utf8');

    assert.ok(
      homeTsx.includes("flexWrap: 'wrap'") && homeTsx.includes("justifyContent: 'flex-end'"),
      'ActiveCard header debe permitir wrap y flex-end para badges en pantallas angostas'
    );
  });
});
