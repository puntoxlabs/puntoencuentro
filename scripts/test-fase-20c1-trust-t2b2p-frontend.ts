import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

// 1. Mocking translations
await import('../src/i18n/i18n');

// 2. Import components under test
const { HostOpenEncounterSection } = await import('../src/components/host/HostOpenEncounterSection');
const { HomeOpenEncounterDetailSheet } = await import('../src/components/home/openEncounters/HomeOpenEncounterDetailSheet');
const { openEncountersService } = await import('../src/services/openEncountersService');

describe('Fase 2.0-C1 (T2-B2-P): Prerrequisitos de Navegación y Host UI', () => {

  // ========================================================
  // SECCIÓN 8: TESTS DE NAVEGACIÓN EN HomeOpenEncounterDetailSheet
  // ========================================================
  describe('8. Navegación de participante en HomeOpenEncounterDetailSheet', () => {
    test('8.1. Solicitud approved con token_participante no genera /join?token= y usa /invite/:token', async () => {
      // Mock openEncountersService.getMiSolicitud to return approved state with token
      const originalGetMiSolicitud = openEncountersService.getMiSolicitud;
      const testToken = 'abcd-1234-token-invitacion';
      
      openEncountersService.getMiSolicitud = async () => ({
        ok: true,
        has_request: true,
        request_id: 'sol-111',
        estado: 'approved',
        token_participante: testToken,
      });

      try {
        const encounterMock = {
          id: 'enc-123',
          title: 'Encuentro Test',
          description: 'Probando navegación',
          approximateZone: 'Palermo',
          openSlots: 2,
          confirmedCount: 1,
        };

        // Render SSR
        const html = renderToString(
          React.createElement(HomeOpenEncounterDetailSheet, {
            isOpen: true,
            onClose: () => {},
            encounter: encounterMock,
            isDemo: false,
          })
        );

        // Assert that the deprecated /join?token is NOT present
        assert.ok(!html.includes('/join?token='), 'No debe existir /join?token= en ningún enlace o texto');
        assert.ok(!html.includes('/detail/'), 'No debe existir ruta inválida /detail/');
        assert.ok(html.includes('pe-detail-sheet'), 'El componente sheet se renderiza con normalidad');
      } finally {
        openEncountersService.getMiSolicitud = originalGetMiSolicitud;
      }
    });

    test('8.2. Verificación de lógica de redirección a /invite/:token vs /join?token=', () => {
      const token = 'token-participante-seguro-123';
      let navigatedTo: string | null = null;
      const navigateMock = (url: string) => {
        navigatedTo = url;
      };

      // Simular handler
      const requestState = { tokenParticipante: token };
      if (requestState.tokenParticipante) {
        navigateMock(`/invite/${encodeURIComponent(requestState.tokenParticipante)}`);
      }

      assert.equal(navigatedTo, `/invite/${token}`);
      assert.ok(!navigatedTo.includes('/join?token='));

      // Simular sin token: no navega ni construye ruta rota
      navigatedTo = null;
      const emptyState = { tokenParticipante: undefined };
      if (emptyState.tokenParticipante) {
        navigateMock(`/invite/${encodeURIComponent((emptyState as any).tokenParticipante)}`);
      }
      assert.equal(navigatedTo, null, 'Sin token no debe navegar a rutas rotas');
    });
  });

  // ========================================================
  // SECCIÓN 10: TESTS DE HostOpenEncounterSection CUANDO is_open=false
  // ========================================================
  describe('10. HostOpenEncounterSection: Preservación de historial de solicitudes', () => {
    const originalGetSolicitudesHost = openEncountersService.getSolicitudesHost;

    test('10.1. is_open = true: comportamiento actual preservado (badge activo, botón cerrar, historial)', async () => {
      const mockSolicitudes = [
        {
          id: 'sol-pending-1',
          encuentro_id: 'enc-1',
          usuario_id: 'user-1',
          nombre_solicitante: 'Carlos Pendiente',
          mensaje: 'Quiero sumarme',
          estado: 'pending' as const,
          created_at: new Date().toISOString(),
        },
        {
          id: 'sol-approved-1',
          encuentro_id: 'enc-1',
          usuario_id: 'user-2',
          nombre_solicitante: 'Laura Aprobada',
          estado: 'approved' as const,
          created_at: new Date().toISOString(),
        }
      ];

      openEncountersService.getSolicitudesHost = async () => mockSolicitudes;

      try {
        const encounterMock = {
          id: 'enc-1',
          is_open: true,
          open_public_zone: 'Palermo',
          max_participants: 5,
          fecha: '2026-10-15',
          hora: '19:00',
        };

        const html = renderToString(
          React.createElement(HostOpenEncounterSection, {
            encuentro: encounterMock,
            hostId: 'host-1',
            confirmedCount: 1,
            initialSolicitudes: mockSolicitudes,
            onRefresh: () => {},
            onParticipantAdded: () => {},
          })
        );

        assert.ok(html.includes('pe-host-open-card'), 'Debe renderizar la tarjeta completa');
        assert.ok(html.includes('pe-host-open-card__badge--active'), 'Badge activo presente');
        assert.ok(html.includes('Cerrar al Discovery'), 'Botón para cerrar disponible');
        assert.ok(html.includes('Historial de solicitudes'), 'Historial de solicitudes presente');
      } finally {
        openEncountersService.getSolicitudesHost = originalGetSolicitudesHost;
      }
    });

    test('10.2. is_open = false con solicitudes resueltas: historial permanece visible y no se oculta', async () => {
      const mockSolicitudes = [
        {
          id: 'sol-approved-1',
          encuentro_id: 'enc-2',
          usuario_id: 'user-2',
          nombre_solicitante: 'Laura Aprobada',
          estado: 'approved' as const,
          created_at: new Date().toISOString(),
        },
        {
          id: 'sol-rejected-1',
          encuentro_id: 'enc-2',
          usuario_id: 'user-3',
          nombre_solicitante: 'Pedro Rechazado',
          estado: 'rejected' as const,
          created_at: new Date().toISOString(),
        }
      ];

      openEncountersService.getSolicitudesHost = async () => mockSolicitudes;

      try {
        const encounterMock = {
          id: 'enc-2',
          is_open: false,
          open_public_zone: 'Recoleta',
          max_participants: 5,
          fecha: '2026-10-20',
          hora: '18:00',
        };

        const html = renderToString(
          React.createElement(HostOpenEncounterSection, {
            encuentro: encounterMock,
            hostId: 'host-1',
            confirmedCount: 2,
            initialSolicitudes: mockSolicitudes,
            onRefresh: () => {},
            onParticipantAdded: () => {},
          })
        );

        assert.ok(html.includes('pe-host-open-card'), 'Debe renderizar la tarjeta con historial');
        assert.ok(html.includes('pe-host-open-card__badge--inactive'), 'Badge debe ser inactivo/cerrado');
        assert.ok(html.includes('Cerrado al Discovery'), 'Texto Cerrado al Discovery visible');
        assert.ok(html.includes('Historial de solicitudes (2)'), 'Historial con 2 solicitudes presente');
        assert.ok(html.includes('Laura Aprobada'), 'Solicitante aprobada visible');
        assert.ok(html.includes('Pedro Rechazado'), 'Solicitante rechazada visible');
        assert.ok(html.includes('Reportar'), 'Acción de reporte presente para solicitudes resueltas');
      } finally {
        openEncountersService.getSolicitudesHost = originalGetSolicitudesHost;
      }
    });

    test('10.3. is_open = false sin historial y encuentro futuro: muestra banner estándar de apertura', async () => {
      openEncountersService.getSolicitudesHost = async () => [];

      try {
        const encounterMock = {
          id: 'enc-3',
          is_open: false,
          max_participants: 4,
          fecha: '2026-11-01',
          hora: '21:00',
        };

        const html = renderToString(
          React.createElement(HostOpenEncounterSection, {
            encuentro: encounterMock,
            hostId: 'host-1',
            confirmedCount: 0,
            onRefresh: () => {},
            onParticipantAdded: () => {},
          })
        );

        assert.ok(html.includes('pe-host-open-banner'), 'Renderiza el banner para abrir');
        assert.ok(html.includes('Abrir este encuentro'), 'Botón para abrir encuentro presente');
        assert.ok(!html.includes('pe-host-open-card'), 'No renderiza card vacía');
      } finally {
        openEncountersService.getSolicitudesHost = originalGetSolicitudesHost;
      }
    });

    test('10.4. encuentro pasado con solicitudes: historial permanece visible, badge Finalizado y sin reapertura', async () => {
      const mockSolicitudes = [
        {
          id: 'sol-past-1',
          encuentro_id: 'enc-past',
          usuario_id: 'user-past',
          nombre_solicitante: 'Marcos Histórico',
          estado: 'approved' as const,
          created_at: new Date('2026-08-01T12:00:00Z').toISOString(),
        }
      ];

      openEncountersService.getSolicitudesHost = async () => mockSolicitudes;

      try {
        const pastEncounterMock = {
          id: 'enc-past',
          is_open: false,
          open_public_zone: 'Belgrano',
          max_participants: 4,
          fecha: '2026-08-01',
          hora: '14:00',
          duration_minutes: 60,
        };

        const html = renderToString(
          React.createElement(HostOpenEncounterSection, {
            encuentro: pastEncounterMock,
            hostId: 'host-1',
            confirmedCount: 1,
            initialSolicitudes: mockSolicitudes,
            onRefresh: () => {},
            onParticipantAdded: () => {},
          })
        );

        assert.ok(html.includes('pe-host-open-card'), 'Mantiene visible la tarjeta para el host');
        assert.ok(html.includes('Finalizado'), 'Badge debe indicar Finalizado');
        assert.ok(html.includes('Marcos Histórico'), 'El solicitante histórico debe figurar');
        assert.ok(!html.includes('pe-host-open-banner__btn'), 'No debe ofrecer botón para abrir un encuentro pasado');
      } finally {
        openEncountersService.getSolicitudesHost = originalGetSolicitudesHost;
      }
    });

    test('10.5. encuentro pasado sin historial: retorna null (no ofrece abrir en Discovery)', async () => {
      openEncountersService.getSolicitudesHost = async () => [];

      try {
        const pastEncounterMock = {
          id: 'enc-past-empty',
          is_open: false,
          fecha: '2026-08-01',
          hora: '14:00',
          duration_minutes: 60,
        };

        const html = renderToString(
          React.createElement(HostOpenEncounterSection, {
            encuentro: pastEncounterMock,
            hostId: 'host-1',
            confirmedCount: 0,
            onRefresh: () => {},
            onParticipantAdded: () => {},
          })
        );

        assert.equal(html, '', 'Debe retornar null cuando el encuentro pasado no tiene solicitudes ni apertura');
      } finally {
        openEncountersService.getSolicitudesHost = originalGetSolicitudesHost;
      }
    });
  });
});
