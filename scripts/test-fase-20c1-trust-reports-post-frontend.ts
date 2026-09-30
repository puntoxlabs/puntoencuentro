import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

import { supabase } from '../src/lib/supabase';
import { trustService } from '../src/services/trustService';
import { ReportRequestModal } from '../src/components/host/ReportRequestModal';
import { HostOpenEncounterSection } from '../src/components/host/HostOpenEncounterSection';

describe('Fase 2.0-C1 (T2-B2): UI de Reporte Post-Encuentro — Frontend Tests', () => {
  let rpcCalls: { fn: string; params: any }[] = [];
  let fromCalls: { table: string }[] = [];

  beforeEach(() => {
    rpcCalls = [];
    fromCalls = [];

    (supabase as any).rpc = async (fn: string, params?: any) => {
      rpcCalls.push({ fn, params });
      return {
        data: { ok: true, estado: 'pending' },
        error: null,
      };
    };

    (supabase as any).from = (table: string) => {
      fromCalls.push({ table });
      throw new Error(`Acceso directo prohibido a tabla: ${table}`);
    };
  });

  // ========================================================
  // 1. RENDERIZADO Y CONTRATO DEL MODAL EN POST_ENCUENTRO
  // ========================================================
  describe('1. Renderizado y Contrato del ReportRequestModal en Post-Encuentro', () => {
    test('renderiza título post-encuentro, copy de moderación y participante reportado', () => {
      const html = renderToString(
        React.createElement(ReportRequestModal, {
          isOpen: true,
          onClose: () => {},
          solicitudId: 'sol-approved-999',
          applicantName: 'Lucía Fernández',
          contexto: 'post_encuentro',
          targetLabel: 'Participante',
        })
      );

      assert.ok(html.includes('Reportar este encuentro'), 'Debe mostrar título dinámico para post_encuentro');
      assert.ok(
        html.includes('Usá esta opción para informarnos sobre cualquier incidente o comportamiento indebido ocurrido durante o después del encuentro.'),
        'Debe mostrar copy adecuado para post_encuentro'
      );
      assert.ok(html.includes('Participante:'), 'Debe mostrar label Participante');
      assert.ok(html.includes('Lucía Fernández'), 'Debe mostrar nombre del participante');
    });

    test('renderiza objetivo "Anfitrión" cuando el participante reporta al host', () => {
      const html = renderToString(
        React.createElement(ReportRequestModal, {
          isOpen: true,
          onClose: () => {},
          solicitudId: 'sol-approved-888',
          applicantName: 'Café de Especialidad y Charlas',
          contexto: 'post_encuentro',
          targetLabel: 'Anfitrión',
        })
      );

      assert.ok(html.includes('Reportar este encuentro'), 'Debe mostrar título de reporte');
      assert.ok(html.includes('Anfitrión:'), 'Debe mostrar label Anfitrión');
      assert.ok(html.includes('Café de Especialidad y Charlas'), 'Debe mostrar el contexto/nombre del anfitrión');
    });

    test('muestra exactamente los 4 motivos permitidos en post_encuentro', () => {
      const html = renderToString(
        React.createElement(ReportRequestModal, {
          isOpen: true,
          onClose: () => {},
          solicitudId: 'sol-test-123',
          contexto: 'post_encuentro',
        })
      );

      assert.ok(html.includes('Comportamiento inapropiado'), 'Debe incluir inappropriate_behavior');
      assert.ok(html.includes('Promoción o actividad comercial no acordada'), 'Debe incluir commercial_spam');
      assert.ok(html.includes('Situación de seguridad'), 'Debe incluir safety_concern');
      assert.ok(html.includes('Otro motivo'), 'Debe incluir other');

      // Invariantes negativas: no debe incluir no_show
      assert.ok(!html.includes('no_show'), 'NO debe incluir no_show');
      assert.ok(!html.includes('No asistió'), 'NO debe incluir opción de inasistencia');
    });

    test('campo de detalle tiene límite de 1000 caracteres y contador', () => {
      const html = renderToString(
        React.createElement(ReportRequestModal, {
          isOpen: true,
          onClose: () => {},
          solicitudId: 'sol-test-123',
          contexto: 'post_encuentro',
        })
      );

      assert.ok(html.includes('maxLength="1000"'), 'Debe limitar textarea a 1000 caracteres');
      assert.ok(html.includes('0 / 1000'), 'Debe mostrar contador de caracteres inicial');
    });

    test('mensajes de error de duplicado y ventana cerrada reflejan semántica post-encuentro', () => {
      const modalCode = fs.readFileSync(
        path.resolve(process.cwd(), 'src/components/host/ReportRequestModal.tsx'),
        'utf-8'
      );

      assert.ok(
        modalCode.includes('Ya enviaste un reporte sobre este encuentro.'),
        'Debe contemplar mensaje de duplicado en post_encuentro'
      );
      assert.ok(
        modalCode.includes('El período para reportar este encuentro ha finalizado.'),
        'Debe contemplar mensaje de ventana de 72h cerrada en post_encuentro'
      );
      assert.ok(
        modalCode.includes('No fue posible asociar el encuentro para el reporte.'),
        'Debe contemplar error de relación inválida en post_encuentro'
      );
    });
  });

  // ========================================================
  // 2. INTEGRACIÓN HOST: HostOpenEncounterSection
  // ========================================================
  describe('2. Integración de Reporte Post-Encuentro para el Host', () => {
    const pastEncounter = {
      id: 'enc-past-1',
      titulo: 'Café de la tarde',
      fecha: '2026-01-01',
      hora: '10:00',
      is_open: false,
      max_participants: 5,
    };

    const futureEncounter = {
      id: 'enc-future-1',
      titulo: 'Café futuro',
      fecha: '2027-12-01',
      hora: '18:00',
      is_open: true,
      max_participants: 5,
    };

    test('encuentro pasado: solicitud approved muestra acción de reporte', () => {
      const solicitudes = [
        {
          id: 'sol-app-1',
          nombre_solicitante: 'Martín Palermo',
          estado: 'approved' as const,
          created_at: new Date().toISOString(),
        },
      ];

      const html = renderToString(
        React.createElement(HostOpenEncounterSection, {
          encuentro: pastEncounter,
          hostId: 'host-123',
          confirmedCount: 1,
          onRefresh: () => {},
          onParticipantAdded: () => {},
          initialSolicitudes: solicitudes,
        })
      );

      assert.ok(html.includes('Martín Palermo'), 'Debe listar el solicitante aprobado');
      assert.ok(html.includes('Aceptada'), 'Debe mostrar badge de Aceptada');
      assert.ok(html.includes('pe-host-resolved-item__btn-report'), 'Debe mostrar botón de reporte para participante aprobado');
      assert.ok(html.includes('Reportar participante'), 'El botón debe tener title o aria-label para reportar participante');
    });

    test('encuentro pasado: solicitudes rejected y withdrawn NO muestran acción de reporte', () => {
      const solicitudes = [
        {
          id: 'sol-rej-1',
          nombre_solicitante: 'Rechazado Test',
          estado: 'rejected' as const,
          created_at: new Date().toISOString(),
        },
        {
          id: 'sol-wit-1',
          nombre_solicitante: 'Retirado Test',
          estado: 'withdrawn' as const,
          created_at: new Date().toISOString(),
        },
      ];

      const html = renderToString(
        React.createElement(HostOpenEncounterSection, {
          encuentro: pastEncounter,
          hostId: 'host-123',
          confirmedCount: 0,
          onRefresh: () => {},
          onParticipantAdded: () => {},
          initialSolicitudes: solicitudes,
        })
      );

      assert.ok(html.includes('Rechazado Test'), 'Muestra solicitante rechazado en historial');
      assert.ok(html.includes('Retirado Test'), 'Muestra solicitante retirado en historial');
      // No debe existir botón de reporte porque el encuentro finalizó y no participaron
      assert.ok(!html.includes('pe-host-resolved-item__btn-report'), 'NO debe mostrar botón de reporte si no fue aprobado en encuentro pasado');
    });

    test('encuentro futuro: solicitudes pendientes muestran acción de reporte pre_solicitud', () => {
      const solicitudes = [
        {
          id: 'sol-future-pending',
          nombre_solicitante: 'Usuario Pendiente Futuro',
          estado: 'pending' as const,
          created_at: new Date().toISOString(),
        },
      ];

      const html = renderToString(
        React.createElement(HostOpenEncounterSection, {
          encuentro: futureEncounter,
          hostId: 'host-123',
          confirmedCount: 0,
          onRefresh: () => {},
          onParticipantAdded: () => {},
          initialSolicitudes: solicitudes,
        })
      );

      assert.ok(html.includes('pe-host-request-item__btn-report'), 'Debe permitir reportar solicitud pendiente en encuentro futuro');
      assert.ok(html.includes('Reportar solicitud'), 'Debe indicar Reportar solicitud para contexto pre-encuentro');
    });

    test('código de HostOpenEncounterSection discrimina contexto pre_solicitud vs post_encuentro según isPast', () => {
      const sectionPath = path.resolve(
        process.cwd(),
        'src/components/host/HostOpenEncounterSection.tsx'
      );
      const code = fs.readFileSync(sectionPath, 'utf-8');

      assert.ok(
        code.includes("contexto: isPast ? 'post_encuentro' : 'pre_solicitud'"),
        'Debe discriminar contexto post_encuentro vs pre_solicitud según si el encuentro ya pasó'
      );
      assert.ok(
        code.includes("(!isPast || req.estado === 'approved')"),
        'Encuentros pasados solo permiten reportar si la solicitud fue aprobada'
      );
    });
  });

  // ========================================================
  // 3. INTEGRACIÓN PARTICIPANTE: InviteGuest.tsx
  // ========================================================
  describe('3. Integración de Reporte Post-Encuentro para el Participante (InviteGuest)', () => {
    const inviteGuestPath = path.resolve(process.cwd(), 'src/screens/InviteGuest.tsx');
    const inviteGuestCode = fs.readFileSync(inviteGuestPath, 'utf-8');

    test('pantalla individual importa ReportRequestModal y openEncountersService', () => {
      assert.ok(
        inviteGuestCode.includes("import { openEncountersService } from '@/services/openEncountersService'"),
        'Debe importar openEncountersService'
      );
      assert.ok(
        inviteGuestCode.includes("import { ReportRequestModal } from '@/components/host/ReportRequestModal'"),
        'Debe importar ReportRequestModal'
      );
    });

    test('verifica que el usuario sea permanente y que el encuentro haya finalizado antes de consultar solicitud', () => {
      assert.ok(
        inviteGuestCode.includes('!user.is_anonymous') || inviteGuestCode.includes('user.is_anonymous'),
        'Debe validar usuario permanente'
      );
      assert.ok(
        inviteGuestCode.includes('isEncuentroFinalizado') || inviteGuestCode.includes('isFinalizado'),
        'Debe validar que el encuentro esté finalizado'
      );
      assert.ok(
        inviteGuestCode.includes('openEncountersService.getMiSolicitud'),
        'Debe invocar getMiSolicitud para recuperar el solicitud_id de manera segura'
      );
    });

    test('el botón de reporte al anfitrión es sobrio y cumple touch target >= 44px', () => {
      assert.ok(
        inviteGuestCode.includes('guest-report-host-btn'),
        'Debe tener la clase guest-report-host-btn'
      );
      assert.ok(
        inviteGuestCode.includes('Reportar anfitrión'),
        'Debe mostrar texto "Reportar anfitrión"'
      );
      assert.ok(
        inviteGuestCode.includes('minHeight: 44') || inviteGuestCode.includes('min-height: 44px'),
        'Debe cumplir accesibilidad táctil min-height 44px'
      );
    });

    test('el modal de reporte del participante se invoca con contexto="post_encuentro" y targetLabel="Anfitrión"', () => {
      assert.ok(
        inviteGuestCode.includes('contexto="post_encuentro"'),
        'Debe pasar contexto post_encuentro'
      );
      assert.ok(
        inviteGuestCode.includes('targetLabel="Anfitrión"'),
        'Debe pasar targetLabel Anfitrión'
      );
    });

    test('estilos de guest-report-host-btn están declarados en Guest.css con min-height 44px', () => {
      const cssPath = path.resolve(process.cwd(), 'src/screens/Guest.css');
      const css = fs.readFileSync(cssPath, 'utf-8');

      assert.ok(css.includes('.guest-report-host-btn'), 'Guest.css debe definir .guest-report-host-btn');
      assert.ok(css.includes('min-height: 44px'), 'Debe asegurar min-height de 44px');
    });
  });

  // ========================================================
  // 4. DATA LAYER Y CONTRATO SEGURO RPC
  // ========================================================
  describe('4. Data Layer y Seguridad de Parámetros en trustService (Post-Encuentro)', () => {
    test('crearReporteSeguro post_encuentro envía estrictamente p_solicitud_id, p_contexto, p_motivo y p_detalle', async () => {
      const res = await trustService.crearReporteSeguro({
        solicitudId: 'solicitud-post-123',
        contexto: 'post_encuentro',
        motivo: 'inappropriate_behavior',
        detalle: 'Ocurrió un incidente durante el evento',
      });

      assert.equal(res.ok, true);
      assert.equal(res.estado, 'pending');

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'crear_reporte_seguro');

      const params = rpcCalls[0].params;
      assert.deepEqual(params, {
        p_solicitud_id: 'solicitud-post-123',
        p_contexto: 'post_encuentro',
        p_motivo: 'inappropriate_behavior',
        p_detalle: 'Ocurrió un incidente durante el evento',
      });

      // Ningún ID arbitrario viaja desde el cliente
      assert.equal((params as any).p_reporter_id, undefined);
      assert.equal((params as any).p_reported_id, undefined);
      assert.equal((params as any).p_encuentro_id, undefined);
      assert.equal((params as any).p_host_id, undefined);
      assert.equal((params as any).p_usuario_id, undefined);
      assert.equal((params as any).p_participante_id, undefined);

      assert.equal(fromCalls.length, 0, 'No debe acceder a tablas directas');
    });

    test('soporta motivo "other" en post_encuentro', async () => {
      const res = await trustService.crearReporteSeguro({
        solicitudId: 'solicitud-post-999',
        contexto: 'post_encuentro',
        motivo: 'other',
        detalle: 'Explicación detallada requerida para other',
      });

      assert.equal(res.ok, true);
      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].params.p_motivo, 'other');
    });
  });

  // ========================================================
  // 5. INVARIANTES DE PRIVACIDAD Y NO OPINABILIDAD
  // ========================================================
  describe('5. Invariantes de Privacidad y No Opinabilidad', () => {
    test('no se introducen términos acusatorios ni juicios punitivos en código UI', () => {
      const modalCode = fs.readFileSync(
        path.resolve(process.cwd(), 'src/components/host/ReportRequestModal.tsx'),
        'utf-8'
      );
      const inviteCode = fs.readFileSync(
        path.resolve(process.cwd(), 'src/screens/InviteGuest.tsx'),
        'utf-8'
      );

      const forbidden = [
        'usuario culpable',
        'usuario sancionado',
        'usuario bloqueado',
        'penalizado',
        'score',
        'trust score',
        'buena conducta',
      ];

      for (const phrase of forbidden) {
        assert.ok(!modalCode.toLowerCase().includes(phrase), `Modal no debe incluir: "${phrase}"`);
        assert.ok(!inviteCode.toLowerCase().includes(phrase), `InviteGuest no debe incluir: "${phrase}"`);
      }
    });
  });
});
