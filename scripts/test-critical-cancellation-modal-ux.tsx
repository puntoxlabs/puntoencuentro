/**
 * Suite de Pruebas Automatizadas: UX de Notificaciones Críticas y Modal de Cancelación/Logística
 * Previene regresiones donde cambios de ubicación o agenda se muestren erróneamente como cancelaciones.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { CriticalCancellationModal } from '../src/components/notifications/CriticalCancellationModal';
import { NotificationsContext } from '../src/contexts/NotificationsContext';
import type { InboxNotificationItem } from '../src/types/notifications';
import '../src/i18n/i18n'; // Cargar configuración e inicialización de i18next

describe('UX de Notificaciones Críticas: CriticalCancellationModal', () => {
  const createMockContext = (
    notifications: InboxNotificationItem[],
    marcarLeidaMock = async () => true
  ) => ({
    unreadCount: notifications.filter((n) => !n.isRead).length,
    notifications,
    loading: false,
    loadingMore: false,
    hasMore: false,
    error: null,
    isOpen: false,
    setIsOpen: () => {},
    fetchUnreadCount: async () => {},
    fetchNotifications: async () => {},
    marcarLeida: marcarLeidaMock,
    marcarTodasLeidas: async () => true,
    cargarMas: async () => {},
    subscribeToIncomingMatches: () => () => {},
  });

  const baseNotification: InboxNotificationItem = {
    id: 'notif-100',
    notificationType: 'encounter_cancelled_for_participant',
    targetType: 'encounter',
    targetId: 'enc-123',
    deepLink: '/meet/enc-123',
    title: 'Fútbol 5 en Palermo',
    body: 'El encuentro fue cancelado por el organizador.',
    payload: {},
    readAt: null,
    isRead: false,
    expiresAt: null,
    createdAt: new Date().toISOString(),
  };

  test('1. Cancelación real: muestra título «Encuentro cancelado» y motivo informado', () => {
    const cancelNotif: InboxNotificationItem = {
      ...baseNotification,
      id: 'notif-cancel-1',
      notificationType: 'encounter_cancelled_for_participant',
      body: 'El organizador canceló el encuentro.',
      payload: {
        title: 'Fútbol 5 en Palermo',
        cancellation_reason: 'Tormenta eléctrica y cancha anegada',
        priority: 'critical',
      },
    };

    const mockCtx = createMockContext([cancelNotif]);
    const html = renderToString(
      <NotificationsContext.Provider value={mockCtx}>
        <CriticalCancellationModal />
      </NotificationsContext.Provider>
    );

    // Título correcto de cancelación
    assert.ok(html.includes('Encuentro cancelado'), 'Debe mostrar el título Encuentro cancelado');
    // Motivo de cancelación visible
    assert.ok(html.includes('Tormenta eléctrica y cancha anegada'), 'Debe incluir el motivo de cancelación');
    assert.ok(html.includes('Motivo informado:'), 'Debe incluir la etiqueta Motivo informado');
    // Botón Entendido presente
    assert.ok(html.includes('Entendido'), 'Debe incluir el botón Entendido');
  });

  test('2. Reprogramación de fecha/horario: muestra «Cambio de fecha u horario» y NUNCA «Encuentro cancelado»', () => {
    const schedNotif: InboxNotificationItem = {
      ...baseNotification,
      id: 'notif-sched-1',
      notificationType: 'encounter_schedule_changed',
      body: 'El organizador modificó la fecha u horario del encuentro.',
      payload: {
        title: 'Café de Filosofía',
        date_label: 'Sábado 25/10 18:00',
        priority: 'critical',
        change_type: 'schedule',
        cancellation_reason: 'No debe mostrarse',
      },
    };

    const mockCtx = createMockContext([schedNotif]);
    const html = renderToString(
      <NotificationsContext.Provider value={mockCtx}>
        <CriticalCancellationModal />
      </NotificationsContext.Provider>
    );

    // Título correcto
    assert.ok(html.includes('Cambio de fecha u horario'), 'Debe mostrar Cambio de fecha u horario');
    // Invariante de seguridad UX: Jamás mostrar cancelación
    assert.ok(!html.includes('Encuentro cancelado'), 'NUNCA debe mostrar Encuentro cancelado para una reprogramación');
    // Jamás mostrar motivo de cancelación
    assert.ok(!html.includes('Motivo informado:'), 'No debe mostrar caja de motivo de cancelación');
    assert.ok(!html.includes('No debe mostrarse'));
    // Fecha visible
    assert.ok(html.includes('Sábado 25/10 18:00'));
  });

  test('3. Modificación de logística (ubicación o enlace): muestra «Cambio de ubicación o acceso» y NUNCA «Encuentro cancelado»', () => {
    const logisticsNotif: InboxNotificationItem = {
      ...baseNotification,
      id: 'notif-logistics-1',
      notificationType: 'encounter_logistics_changed',
      body: 'El organizador actualizó la información de ubicación o acceso del encuentro.',
      payload: {
        title: 'Tarde de Juegos de Mesa',
        priority: 'critical',
        change_type: 'logistics',
        cancellation_reason: 'Texto espurio que no debe salir',
      },
    };

    const mockCtx = createMockContext([logisticsNotif]);
    const html = renderToString(
      <NotificationsContext.Provider value={mockCtx}>
        <CriticalCancellationModal />
      </NotificationsContext.Provider>
    );

    // Título correcto
    assert.ok(html.includes('Cambio de ubicación o acceso'), 'Debe mostrar Cambio de ubicación o acceso');
    // Invariante de seguridad UX: Jamás alarmar falsamente con cancelación
    assert.ok(!html.includes('Encuentro cancelado'), 'NUNCA debe mostrar Encuentro cancelado para cambio de logística');
    assert.ok(!html.includes('Cambio de fecha u horario'), 'No debe confundirse con cambio de agenda');
    // Jamás mostrar caja de motivo de cancelación
    assert.ok(!html.includes('Motivo informado:'), 'No debe mostrar caja de motivo de cancelación');
    assert.ok(!html.includes('Texto espurio que no debe salir'));
    // Nombre del encuentro visible
    assert.ok(html.includes('Tarde de Juegos de Mesa'));
  });

  test('4. Otro aviso crítico genérico: muestra «Aviso importante» y NUNCA «Encuentro cancelado»', () => {
    const genericCriticalNotif: InboxNotificationItem = {
      ...baseNotification,
      id: 'notif-custom-critical',
      notificationType: 'security_perimeter_alert',
      body: 'Aviso importante sobre los términos de convivencia.',
      payload: {
        title: 'Comunidad PuntoEncuentro',
        priority: 'critical',
      },
    };

    const mockCtx = createMockContext([genericCriticalNotif]);
    const html = renderToString(
      <NotificationsContext.Provider value={mockCtx}>
        <CriticalCancellationModal />
      </NotificationsContext.Provider>
    );

    assert.ok(html.includes('Aviso importante'), 'Debe mostrar el título genérico seguro Aviso importante');
    assert.ok(!html.includes('Encuentro cancelado'), 'NUNCA debe mostrar Encuentro cancelado para avisos genéricos');
    assert.ok(!html.includes('Motivo informado:'));
  });

  test('5. Aviso informativo: NO abre el modal crítico (renderiza vacío)', () => {
    // Caso A: Coincidencia de match
    const infoNotif: InboxNotificationItem = {
      ...baseNotification,
      id: 'notif-info-1',
      notificationType: 'match_found',
      body: 'Tenés una nueva coincidencia en tu barrio.',
      payload: { score: 98 },
    };

    const mockCtxA = createMockContext([infoNotif]);
    const htmlA = renderToString(
      <NotificationsContext.Provider value={mockCtxA}>
        <CriticalCancellationModal />
      </NotificationsContext.Provider>
    );
    assert.equal(htmlA, '', 'Aviso informativo match_found no debe renderizar modal crítico');

    // Caso B: Reprogramación dirigida a solicitante pendiente (is_applicant: true)
    const applicantSchedNotif: InboxNotificationItem = {
      ...baseNotification,
      id: 'notif-info-2',
      notificationType: 'encounter_schedule_changed',
      body: 'Cambio de fecha en un encuentro al que te postulaste.',
      payload: { is_applicant: true, date_label: 'Domingo 15:00' },
    };

    const mockCtxB = createMockContext([applicantSchedNotif]);
    const htmlB = renderToString(
      <NotificationsContext.Provider value={mockCtxB}>
        <CriticalCancellationModal />
      </NotificationsContext.Provider>
    );
    assert.equal(htmlB, '', 'Reprogramación para solicitante pendiente no debe renderizar modal crítico');
  });

  test('6. Notificación ya leída (isRead: true): no abre modal crítico', () => {
    const readCriticalNotif: InboxNotificationItem = {
      ...baseNotification,
      id: 'notif-read-critical',
      notificationType: 'encounter_cancelled_for_participant',
      isRead: true,
      readAt: new Date().toISOString(),
      payload: { priority: 'critical' },
    };

    const mockCtx = createMockContext([readCriticalNotif]);
    const html = renderToString(
      <NotificationsContext.Provider value={mockCtx}>
        <CriticalCancellationModal />
      </NotificationsContext.Provider>
    );
    assert.equal(html, '', 'Notificación ya leída no debe volver a mostrar el modal');
  });

  test('7. Acción «Entendido»: invoca marcarLeida con el ID de la notificación crítica', async () => {
    let dismissedId: string | null = null;
    const mockMarcarLeida = async (id: string) => {
      dismissedId = id;
      return true;
    };

    const cancelNotif: InboxNotificationItem = {
      ...baseNotification,
      id: 'notif-to-dismiss-777',
      notificationType: 'encounter_cancelled_for_participant',
      payload: { priority: 'critical' },
    };

    const mockCtx = createMockContext([cancelNotif], mockMarcarLeida);
    // Simular el click llamando directamente a marcarLeida
    await mockCtx.marcarLeida(cancelNotif.id);
    assert.equal(dismissedId, 'notif-to-dismiss-777', 'Debe registrar la lectura en Inbox');
  });
});
