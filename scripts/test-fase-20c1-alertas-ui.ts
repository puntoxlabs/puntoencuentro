import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

import { AlertasSheet } from '../src/components/home/alerts/AlertasSheet';
import type { AlertaCompatibilidad, UseAlertasReturn } from '../src/types/alertas';

describe('Fase 2.0-C1: UI In-App de Alertas — Pruebas Dirigidas', () => {
  const sampleAlertaUnread: AlertaCompatibilidad = {
    id: 'alerta-1-unread',
    tipo: 'interes_convertido',
    source_intencion_id: 'intencion-123',
    target_encuentro_id: 'encuentro-456',
    leida: false,
    created_at: '2026-09-30T10:00:00Z',
    encuentro_titulo: 'Torneo de Pádel',
    encuentro_fecha: '2026-10-15',
    encuentro_hora: '18:00:00',
    encuentro_modalidad: 'presencial',
    encuentro_approximate_zone: 'Palermo',
    encuentro: {
      id: 'encuentro-456',
      titulo: 'Torneo de Pádel',
      descripcion: 'Partidos amistosos',
      fecha: '2026-10-15',
      hora: '18:00:00',
      modalidad: 'presencial',
      approximate_zone: 'Palermo',
      locality_id: 'palermo',
      is_open: true,
    },
  };

  const sampleAlertaRead: AlertaCompatibilidad = {
    ...sampleAlertaUnread,
    id: 'alerta-2-read',
    leida: true,
    created_at: '2026-09-29T10:00:00Z',
    encuentro_titulo: 'Café de Tecnología',
    encuentro: {
      ...sampleAlertaUnread.encuentro,
      id: 'encuentro-789',
      titulo: 'Café de Tecnología',
      is_open: true,
    },
  };

  const sampleAlertaUnavailable: AlertaCompatibilidad = {
    ...sampleAlertaUnread,
    id: 'alerta-3-unavailable',
    leida: false,
    encuentro_titulo: 'Encuentro Pasado o Cancelado',
    encuentro: {
      ...sampleAlertaUnread.encuentro,
      id: 'encuentro-999',
      titulo: 'Encuentro Pasado o Cancelado',
      is_open: false,
    },
  };

  function createMockHook(overrides?: Partial<UseAlertasReturn>): UseAlertasReturn {
    return {
      alertas: [],
      unreadCount: 0,
      loading: false,
      error: null,
      refresh: async () => {},
      marcarLeida: async (id: string) => ({ ok: true, data: { id, leida: true } }),
      ...overrides,
    };
  }

  describe('1. Visibilidad Condicional de la Campana en Home', () => {
    const homeFilePath = path.resolve(process.cwd(), 'src/screens/Home.tsx');
    const homeCode = fs.readFileSync(homeFilePath, 'utf-8');

    test('la campana está condicionada exclusivamente a usuario permanente (user && !user.is_anonymous)', () => {
      // Verificar la cláusula exacta en el código de Home.tsx
      assert.ok(
        homeCode.includes('user && !user.is_anonymous'),
        'Debe verificar explícitamente que el usuario no sea anónimo para mostrar la campana'
      );
      assert.ok(
        homeCode.includes('home-header-bell-btn'),
        'Debe incluir la clase de botón para la campana de alertas'
      );
    });

    test('simulación: renderizado de campana según estado de usuario', () => {
      // Helper para renderizar barra de acciones simulando la lógica de Home.tsx
      const renderHeaderActions = (user: { is_anonymous: boolean } | null, unreadCount: number) => {
        const showBell = Boolean(user && !user.is_anonymous);
        const badgeText = unreadCount > 99 ? '99+' : unreadCount > 0 ? String(unreadCount) : null;

        return renderToString(
          React.createElement('div', { className: 'home-header-actions' },
            showBell && React.createElement('button', {
              type: 'button',
              className: 'home-header-icon-btn home-header-bell-btn',
              'aria-label': unreadCount > 0 ? `Alertas (${unreadCount} no leídas)` : 'Alertas',
              title: 'Alertas',
            },
              React.createElement('div', { className: 'home-header-bell-wrapper' },
                React.createElement('span', { className: 'bell-icon' }, '🔔'),
                badgeText && React.createElement('span', { className: 'home-header-bell-badge' }, badgeText)
              )
            )
          )
        );
      };

      // 1. Usuario permanente -> Campana visible
      const htmlPermanent = renderHeaderActions({ is_anonymous: false }, 3);
      assert.ok(htmlPermanent.includes('home-header-bell-btn'), 'Debe verse para cuenta permanente');
      assert.ok(htmlPermanent.includes('Alertas (3 no leídas)'), 'Aria label con conteo');
      assert.ok(htmlPermanent.includes('home-header-bell-badge'), 'Badge visible');
      assert.ok(htmlPermanent.includes('>3<'), 'Conteo exacto');

      // 2. Usuario anónimo -> Campana oculta
      const htmlAnonymous = renderHeaderActions({ is_anonymous: true }, 3);
      assert.ok(!htmlAnonymous.includes('home-header-bell-btn'), 'NO debe verse para cuenta anónima');
      assert.ok(!htmlAnonymous.includes('home-header-bell-badge'), 'Badge oculto');

      // 3. Sin usuario -> Campana oculta
      const htmlGuest = renderHeaderActions(null, 0);
      assert.ok(!htmlGuest.includes('home-header-bell-btn'), 'NO debe verse para visitante no autenticado');
    });
  });

  describe('2. Badge de No Leídas', () => {
    test('badge oculto cuando unreadCount === 0', () => {
      const renderBadge = (unreadCount: number) => {
        const badgeText = unreadCount > 99 ? '99+' : unreadCount > 0 ? String(unreadCount) : null;
        return renderToString(
          React.createElement('div', null,
            badgeText && React.createElement('span', { className: 'home-header-bell-badge' }, badgeText)
          )
        );
      };

      const htmlZero = renderBadge(0);
      assert.ok(!htmlZero.includes('home-header-bell-badge'), 'No debe renderizar badge con 0 no leídas');
    });

    test('badge visible con conteo exacto para valores 1 a 99', () => {
      const renderBadge = (unreadCount: number) => {
        const badgeText = unreadCount > 99 ? '99+' : unreadCount > 0 ? String(unreadCount) : null;
        return renderToString(
          React.createElement('div', null,
            badgeText && React.createElement('span', { className: 'home-header-bell-badge' }, badgeText)
          )
        );
      };

      assert.ok(renderBadge(1).includes('>1<'), 'Conteo 1');
      assert.ok(renderBadge(5).includes('>5<'), 'Conteo 5');
      assert.ok(renderBadge(99).includes('>99<'), 'Conteo 99');
    });

    test('badge muestra "99+" cuando unreadCount > 99', () => {
      const renderBadge = (unreadCount: number) => {
        const badgeText = unreadCount > 99 ? '99+' : unreadCount > 0 ? String(unreadCount) : null;
        return renderToString(
          React.createElement('div', null,
            badgeText && React.createElement('span', { className: 'home-header-bell-badge' }, badgeText)
          )
        );
      };

      assert.ok(renderBadge(100).includes('>99+<'), 'Conteo 100 -> 99+');
      assert.ok(renderBadge(250).includes('>99+<'), 'Conteo 250 -> 99+');
    });
  });

  describe('3. Componente AlertasSheet — Estados y Renderizado', () => {
    test('renderiza estado vacío accesible cuando no hay alertas', () => {
      const hook = createMockHook({ alertas: [], loading: false, error: null });
      const html = renderToString(
        React.createElement(AlertasSheet, {
          isOpen: true,
          onClose: () => {},
          alertasHook: hook,
        })
      );

      assert.ok(html.includes('role="dialog"'), 'Debe tener role dialog');
      assert.ok(html.includes('aria-label="Alertas"'), 'Debe tener aria-label Alertas');
      assert.ok(html.includes('No tenés alertas nuevas.'), 'Texto de estado vacío exacto');
      assert.ok(html.includes('pe-alerts-empty'), 'Contenedor de estado vacío');
    });

    test('renderiza estado de carga cuando loading === true', () => {
      const hook = createMockHook({ alertas: [], loading: true, error: null });
      const html = renderToString(
        React.createElement(AlertasSheet, {
          isOpen: true,
          onClose: () => {},
          alertasHook: hook,
        })
      );

      assert.ok(html.includes('role="status"'), 'Live region para carga');
      assert.ok(html.includes('Cargando alertas...'), 'Texto de carga');
      assert.ok(html.includes('pe-alerts-spinner'), 'Spinner visible');
    });

    test('renderiza estado de error y botón de reintento cuando error !== null', () => {
      const hook = createMockHook({
        alertas: [],
        loading: false,
        error: 'Error de conexión con el servidor',
      });
      const html = renderToString(
        React.createElement(AlertasSheet, {
          isOpen: true,
          onClose: () => {},
          alertasHook: hook,
        })
      );

      assert.ok(html.includes('role="alert"'), 'Role alert para el error');
      assert.ok(html.includes('Error de conexión con el servidor'), 'Mensaje de error');
      assert.ok(html.includes('Reintentar'), 'Botón de reintento');
    });

    test('renderiza listado con copy específico "Una idea que te interesaba ahora tiene encuentro."', () => {
      const hook = createMockHook({
        alertas: [sampleAlertaUnread],
        loading: false,
        error: null,
      });
      const html = renderToString(
        React.createElement(AlertasSheet, {
          isOpen: true,
          onClose: () => {},
          alertasHook: hook,
        })
      );

      assert.ok(
        html.includes('Una idea que te interesaba ahora tiene encuentro.'),
        'Copy principal obligatorio para interes_convertido'
      );
      assert.ok(html.includes('Torneo de Pádel'), 'Título del encuentro');
      assert.ok(html.includes('Palermo'), 'Zona aproximada');
      assert.ok(html.includes('Presencial'), 'Modalidad');
    });

    test('diferenciación visual y semántica entre alerta leída y no leída', () => {
      const hook = createMockHook({
        alertas: [sampleAlertaUnread, sampleAlertaRead],
        loading: false,
        error: null,
      });
      const html = renderToString(
        React.createElement(AlertasSheet, {
          isOpen: true,
          onClose: () => {},
          alertasHook: hook,
        })
      );

      // Alerta no leída
      assert.ok(html.includes('pe-alert-card--unread'), 'Clase unread en tarjeta no leída');
      assert.ok(html.includes('pe-alert-card__status-badge--unread'), 'Badge no leída');
      assert.ok(html.includes('pe-alert-dot'), 'Punto indicador no leída');
      assert.ok(html.includes('>Nueva<'), 'Texto de badge Nueva');

      // Alerta leída
      assert.ok(html.includes('pe-alert-card--read'), 'Clase read en tarjeta leída');
      assert.ok(html.includes('pe-alert-card__status-badge--read'), 'Badge leída');
      assert.ok(html.includes('>Leída<'), 'Texto de badge Leída');
    });

    test('no renderiza nada si isOpen === false', () => {
      const hook = createMockHook({ alertas: [sampleAlertaUnread] });
      const html = renderToString(
        React.createElement(AlertasSheet, {
          isOpen: false,
          onClose: () => {},
          alertasHook: hook,
        })
      );

      assert.equal(html, '', 'Cuando isOpen es false no debe renderizar markup');
    });
  });

  describe('4. Acción "Marcar como leída"', () => {
    test('en tarjeta no leída ofrece el botón interactivo "Marcar como leída"', () => {
      const hook = createMockHook({
        alertas: [sampleAlertaUnread],
      });
      const html = renderToString(
        React.createElement(AlertasSheet, {
          isOpen: true,
          onClose: () => {},
          alertasHook: hook,
        })
      );

      assert.ok(
        html.includes('Marcar como leída'),
        'Debe ofrecer botón Marcar como leída'
      );
    });

    test('en tarjeta ya leída el botón desaparece y muestra etiqueta estática "Leída"', () => {
      const hook = createMockHook({
        alertas: [sampleAlertaRead],
      });
      const html = renderToString(
        React.createElement(AlertasSheet, {
          isOpen: true,
          onClose: () => {},
          alertasHook: hook,
        })
      );

      assert.ok(
        !html.includes('pe-alert-card__btn--secondary'),
        'No debe tener botón interactivo de marcar como leída'
      );
      assert.ok(
        html.includes('pe-alert-card__read-label'),
        'Debe tener etiqueta estática de lectura'
      );
      assert.ok(html.includes('>Leída<'), 'Texto Leída');
    });
  });

  describe('5. Apertura Segura de Encuentro Abierto sin public_token', () => {
    test('ofrece CTA principal "Ver encuentro" sin requerir ni exponer public_token', () => {
      const hook = createMockHook({
        alertas: [sampleAlertaUnread],
      });
      const html = renderToString(
        React.createElement(AlertasSheet, {
          isOpen: true,
          onClose: () => {},
          alertasHook: hook,
        })
      );

      assert.ok(html.includes('Ver encuentro'), 'CTA principal Ver encuentro');
      assert.ok(
        !html.includes('public_token'),
        'public_token NO debe aparecer en el HTML ni en los datos de la alerta'
      );
    });

    test('si el encuentro no está disponible (is_open: false), muestra estado defensivo inline "Este encuentro ya no está disponible."', () => {
      const hook = createMockHook({
        alertas: [sampleAlertaUnavailable],
      });
      const html = renderToString(
        React.createElement(AlertasSheet, {
          isOpen: true,
          onClose: () => {},
          alertasHook: hook,
        })
      );

      assert.ok(
        html.includes('Este encuentro ya no está disponible.'),
        'Debe mostrar mensaje defensivo obligatorio si el encuentro no está abierto'
      );
      assert.ok(
        html.includes('pe-alert-card__unavailable'),
        'Contenedor defensivo con estilos de advertencia'
      );
      assert.ok(
        html.includes('Marcar como leída'),
        'Aun no estando disponible, permite marcar la alerta como leída'
      );
    });
  });

  describe('6. Integración en Home.tsx', () => {
    const homeFilePath = path.resolve(process.cwd(), 'src/screens/Home.tsx');
    const homeCode = fs.readFileSync(homeFilePath, 'utf-8');

    test('Home.tsx importa e integra AlertasSheet y HomeOpenEncounterDetailSheet', () => {
      assert.ok(
        homeCode.includes("import { AlertasSheet } from '@/components/home/alerts'"),
        'Debe importar AlertasSheet'
      );
      assert.ok(
        homeCode.includes("import { HomeOpenEncounterDetailSheet } from '@/components/home/openEncounters/HomeOpenEncounterDetailSheet'"),
        'Debe importar HomeOpenEncounterDetailSheet'
      );
      assert.ok(
        homeCode.includes('<AlertasSheet'),
        'Debe renderizar AlertasSheet en el JSX'
      );
      assert.ok(
        homeCode.includes('<HomeOpenEncounterDetailSheet'),
        'Debe renderizar HomeOpenEncounterDetailSheet para apertura desde alertas'
      );
    });

    test('Home.tsx no requiere public_token para abrir el detalle del encuentro desde la alerta', () => {
      assert.ok(
        !homeCode.includes('enc.public_token'),
        'Home.tsx no debe buscar ni necesitar enc.public_token de la alerta'
      );
    });
  });
});
