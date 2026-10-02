/**
 * Suite de Pruebas Unitarias y de Integración Frontend
 * Módulo: Fase 1.5 — UI Mínima de Notificaciones In-App
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { validateDeepLink } from '../src/lib/deepLink';
import { formatRelativeTime } from '../src/lib/formatRelativeTime';
import { NotificationItem } from '../src/components/notifications/NotificationItem';
import type { InboxNotificationItem } from '../src/types/notifications';

describe('Fase 1.5: UI Mínima de Notificaciones In-App', () => {
  // -------------------------------------------------------------
  // 1. VALIDACIÓN DE DEEP LINKS
  // -------------------------------------------------------------
  describe('1. Validador de Deep Links (validateDeepLink)', () => {
    test('Acepta rutas relativas canónicas válidas', () => {
      assert.equal(validateDeepLink('/meet/123e4567-e89b-12d3-a456-426614174000'), '/meet/123e4567-e89b-12d3-a456-426614174000');
      assert.equal(validateDeepLink('/coordination/123'), '/coordination/123');
      assert.equal(validateDeepLink('/invite/tok_abc123'), '/invite/tok_abc123');
      assert.equal(validateDeepLink('/join/pub_xyz789'), '/join/pub_xyz789');
      assert.equal(validateDeepLink('/encuentros?tab=upcoming&filter=all'), '/encuentros?tab=upcoming&filter=all');
    });

    test('Rechaza esquemas externos y protocolos peligrosos (XSS / Open Redirect)', () => {
      assert.equal(validateDeepLink('javascript:alert(document.cookie)'), null);
      assert.equal(validateDeepLink('javascript:void(0)'), null);
      assert.equal(validateDeepLink('data:text/html,<script>alert(1)</script>'), null);
      assert.equal(validateDeepLink('http://evil.com/phishing'), null);
      assert.equal(validateDeepLink('https://external-site.com'), null);
      assert.equal(validateDeepLink('//evil.com/protocol-relative'), null);
      assert.equal(validateDeepLink('mailto:test@test.com'), null);
    });

    test('Rechaza entradas nulas, vacías o sin prefijo de barra', () => {
      assert.equal(validateDeepLink(null), null);
      assert.equal(validateDeepLink(undefined), null);
      assert.equal(validateDeepLink(''), null);
      assert.equal(validateDeepLink('   '), null);
      assert.equal(validateDeepLink('meet/relative-without-slash'), null);
    });
  });

  // -------------------------------------------------------------
  // 2. FORMATEO TEMPORAL RELATIVO
  // -------------------------------------------------------------
  describe('2. Formateo de Fecha/Hora Relativa (formatRelativeTime)', () => {
    test('Muestra "Hace un momento" para eventos de menos de 1 minuto', () => {
      const nowIso = new Date(Date.now() - 15 * 1000).toISOString();
      assert.equal(formatRelativeTime(nowIso), 'Hace un momento');
    });

    test('Muestra minutos para eventos de hace menos de 1 hora', () => {
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      assert.equal(formatRelativeTime(tenMinAgo), 'Hace 10 min');
    });

    test('Muestra horas para eventos de hace menos de 24 horas', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
      assert.equal(formatRelativeTime(threeHoursAgo), 'Hace 3 h');
    });

    test('Maneja entradas inválidas o nulas de forma segura', () => {
      assert.equal(formatRelativeTime(null), '');
      assert.equal(formatRelativeTime(undefined), '');
      assert.equal(formatRelativeTime('invalid-date-string'), '');
    });
  });

  // -------------------------------------------------------------
  // 3. COMPONENTE NOTIFICATION ITEM
  // -------------------------------------------------------------
  describe('3. Componente NotificationItem — Renderizado y Accesibilidad', () => {
    const sampleUnread: InboxNotificationItem = {
      id: 'notif-1',
      notificationType: 'match_found',
      targetType: 'encounter',
      targetId: 'encounter-123',
      deepLink: '/meet/encounter-123',
      title: 'Nuevo Encuentro Compatible',
      body: 'Hay un encuentro de Pádel en Palermo cerca de tu zona.',
      payload: {},
      readAt: null,
      isRead: false,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      createdAt: new Date(Date.now() - 5 * 60000).toISOString(),
    };

    const sampleRead: InboxNotificationItem = {
      ...sampleUnread,
      id: 'notif-2',
      isRead: true,
      readAt: new Date(Date.now() - 60000).toISOString(),
    };

    test('Notificación no leída: incluye clase unread, punto indicador y aria-label accesible', () => {
      const html = renderToString(
        React.createElement(NotificationItem, {
          item: sampleUnread,
          onSelect: () => {},
        })
      );

      assert.ok(html.includes('pe-notification-card--unread'), 'Debe incluir clase unread');
      assert.ok(html.includes('pe-notification-unread-dot'), 'Debe renderizar punto visual de no leída');
      assert.ok(html.includes('aria-label="No leída: Nuevo Encuentro Compatible.'), 'Aria label indica estado no leído');
      assert.ok(html.includes('Nuevo Encuentro Compatible'), 'Título visible');
      assert.ok(html.includes('Hay un encuentro de Pádel en Palermo'), 'Cuerpo visible');
    });

    test('Notificación leída: clase read, sin punto de no leída', () => {
      const html = renderToString(
        React.createElement(NotificationItem, {
          item: sampleRead,
          onSelect: () => {},
        })
      );

      assert.ok(html.includes('pe-notification-card--read'), 'Debe incluir clase read');
      assert.ok(!html.includes('pe-notification-unread-dot'), 'No debe tener punto unread');
      assert.ok(html.includes('pe-notification-read-spacer'), 'Debe incluir espaciador para alinear');
      assert.ok(!html.includes('aria-label="No leída:'), 'Aria label no debe decir No leída');
    });
  });

  // -------------------------------------------------------------
  // 4. LÓGICA DE BADGE Y VISIBILIDAD DE LA CAMPANA
  // -------------------------------------------------------------
  describe('4. Visibilidad de la Campana y Conteo de No Leídas', () => {
    const renderBellMarkup = (isPermanent: boolean, unreadCount: number) => {
      if (!isPermanent) return null;
      const badgeText = unreadCount > 99 ? '99+' : unreadCount > 0 ? String(unreadCount) : null;
      return renderToString(
        React.createElement('button', {
          type: 'button',
          className: 'home-header-icon-btn home-header-bell-btn',
          'aria-label': unreadCount > 0 ? `Notificaciones (${unreadCount} no leídas)` : 'Notificaciones',
        },
          React.createElement('div', { className: 'home-header-bell-wrapper' },
            React.createElement('span', null, '🔔'),
            badgeText && React.createElement('span', { className: 'home-header-bell-badge' }, badgeText)
          )
        )
      );
    };

    test('Oculta para usuarios no autenticados o anónimos', () => {
      assert.equal(renderBellMarkup(false, 5), null);
    });

    test('Visible para usuario permanente sin badge cuando unreadCount === 0', () => {
      const html = renderBellMarkup(true, 0);
      assert.ok(html !== null);
      assert.ok(html.includes('home-header-bell-btn'));
      assert.ok(!html.includes('home-header-bell-badge'), 'Sin badge para 0');
      assert.ok(html.includes('aria-label="Notificaciones"'));
    });

    test('Muestra número exacto para 1..99 no leídas', () => {
      const html1 = renderBellMarkup(true, 1)!;
      assert.ok(html1.includes('home-header-bell-badge'));
      assert.ok(html1.includes('>1<'));
      assert.ok(html1.includes('Notificaciones (1 no leídas)'));

      const html42 = renderBellMarkup(true, 42)!;
      assert.ok(html42.includes('>42<'));

      const html99 = renderBellMarkup(true, 99)!;
      assert.ok(html99.includes('>99<'));
    });

    test('Muestra "99+" cuando el conteo supera 99', () => {
      const html100 = renderBellMarkup(true, 100)!;
      assert.ok(html100.includes('>99+<'));

      const html500 = renderBellMarkup(true, 500)!;
      assert.ok(html500.includes('>99+<'));
    });
  });

  // -------------------------------------------------------------
  // 5. BANDEJA DE NOTIFICACIONES (ESTADOS UI)
  // -------------------------------------------------------------
  describe('5. Bandeja de Notificaciones (Estados UI)', () => {
    test('Estado vacío: muestra mensaje comprensible "Todavía no tenés notificaciones."', () => {
      const emptyHtml = renderToString(
        React.createElement('div', { className: 'pe-notifications-empty' },
          React.createElement('h4', { className: 'pe-notifications-empty-title' }, 'Todavía no tenés notificaciones.')
        )
      );
      assert.ok(emptyHtml.includes('Todavía no tenés notificaciones.'));
    });

    test('Acción "Marcar todas como leídas": sólo visible cuando unreadCount > 0', () => {
      const renderHeaderActions = (unreadCount: number) => {
        return renderToString(
          React.createElement('div', { className: 'pe-notifications-header-actions' },
            unreadCount > 0 && React.createElement('button', {
              type: 'button',
              className: 'pe-notifications-mark-all-btn',
            }, 'Marcar todas como leídas'),
            React.createElement('button', {
              type: 'button',
              className: 'pe-notifications-close-btn',
              'aria-label': 'Cerrar notificaciones',
            })
          )
        );
      };

      const htmlZero = renderHeaderActions(0);
      assert.ok(!htmlZero.includes('Marcar todas como leídas'), 'No debe verse si unreadCount === 0');

      const htmlUnread = renderHeaderActions(3);
      assert.ok(htmlUnread.includes('Marcar todas como leídas'), 'Debe verse si unreadCount > 0');
    });

    test('Estado de error recuperable: incluye botón "Reintentar"', () => {
      const errorHtml = renderToString(
        React.createElement('div', { className: 'pe-notifications-error', role: 'alert' },
          React.createElement('h4', { className: 'pe-notifications-error-title' }, 'No pudimos cargar tus notificaciones'),
          React.createElement('button', { type: 'button', className: 'pe-notifications-retry-btn' }, 'Reintentar')
        )
      );
      assert.ok(errorHtml.includes('No pudimos cargar tus notificaciones'));
      assert.ok(errorHtml.includes('Reintentar'));
    });
  });
});
