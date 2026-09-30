import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

import { supabase } from '../src/lib/supabase';
import { trustService } from '../src/services/trustService';
import { ReportRequestModal } from '../src/components/host/ReportRequestModal';

describe('Fase 2.0-C1 (T2-B1): UI de Reporte Pre-Solicitud — Frontend Tests', () => {
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

  describe('1. Superficie e Integración en HostOpenEncounterSection', () => {
    test('HostOpenEncounterSection incluye acción secundaria "Reportar" en solicitudes', () => {
      const sectionPath = path.resolve(
        process.cwd(),
        'src/components/host/HostOpenEncounterSection.tsx'
      );
      const code = fs.readFileSync(sectionPath, 'utf-8');

      assert.ok(
        code.includes("import { ReportRequestModal } from './ReportRequestModal'"),
        'Debe importar ReportRequestModal'
      );
      assert.ok(
        code.includes('pe-host-request-item__btn-report'),
        'Debe contener botón de reporte en solicitudes pendientes'
      );
      assert.ok(
        code.includes('pe-host-resolved-item__btn-report'),
        'Debe contener botón de reporte en historial de solicitudes'
      );
      assert.ok(
        code.includes('<ReportRequestModal'),
        'Debe renderizar ReportRequestModal condicionalmente'
      );
    });

    test('Acciones Aceptar y Rechazar se mantienen independientes y no automáticas', () => {
      const sectionPath = path.resolve(
        process.cwd(),
        'src/components/host/HostOpenEncounterSection.tsx'
      );
      const code = fs.readFileSync(sectionPath, 'utf-8');

      assert.ok(
        code.includes('handleAprobar') && code.includes('handleRechazar'),
        'Botones de aprobación y rechazo deben estar presentes'
      );
      // Reportar solo actualiza el estado de reporte y no invoca aprobar ni rechazar
      assert.ok(
        code.includes('setReportingRequest'),
        'Reportar debe abrir modal sin alterar estado de la solicitud'
      );
    });

    test('Botones de reporte cumplen requisito de touch target >= 44px en CSS', () => {
      const cssPath = path.resolve(
        process.cwd(),
        'src/components/host/HostOpenEncounterSection.css'
      );
      const css = fs.readFileSync(cssPath, 'utf-8');

      assert.ok(
        css.includes('.pe-host-request-item__btn-report') &&
        css.includes('min-height: 44px') &&
        css.includes('min-width: 44px'),
        'pe-host-request-item__btn-report debe tener touch target >= 44px'
      );
      assert.ok(
        css.includes('.pe-host-resolved-item__btn-report') &&
        css.includes('min-height: 44px') &&
        css.includes('min-width: 44px'),
        'pe-host-resolved-item__btn-report debe tener touch target >= 44px'
      );
    });
  });

  describe('2. Renderizado y Contenido del ReportRequestModal', () => {
    test('renderiza título, copy no acusatorio y nombre del solicitante', () => {
      const html = renderToString(
        React.createElement(ReportRequestModal, {
          isOpen: true,
          onClose: () => {},
          solicitudId: 'solicitud-abc-123',
          applicantName: 'Carlos Gomez',
        })
      );

      assert.ok(html.includes('Reportar solicitud'), 'Debe mostrar título exacto');
      assert.ok(
        html.includes('Usá esta opción para informarnos sobre contenido inapropiado, promoción comercial o una situación de seguridad.'),
        'Debe mostrar copy no acusatorio requerido'
      );
      assert.ok(html.includes('Carlos Gomez'), 'Debe mostrar el nombre del solicitante');
    });

    test('muestra exactamente los 3 motivos permitidos para pre_solicitud', () => {
      const html = renderToString(
        React.createElement(ReportRequestModal, {
          isOpen: true,
          onClose: () => {},
          solicitudId: 'solicitud-abc-123',
          applicantName: 'Carlos Gomez',
        })
      );

      assert.ok(html.includes('Promoción o spam comercial'), 'Debe incluir commercial_spam');
      assert.ok(html.includes('Contenido o comportamiento inapropiado'), 'Debe incluir inappropriate_behavior');
      assert.ok(html.includes('Situación de seguridad'), 'Debe incluir safety_concern');

      // Invariantes negativas: no debe incluir other ni no_show
      assert.ok(!html.includes('no_show'), 'NO debe incluir no_show en pre_solicitud');
      assert.ok(!html.includes('Otro motivo'), 'NO debe incluir other en pre_solicitud');
    });

    test('incluye textarea opcional con límite 1000 caracteres y contador', () => {
      const html = renderToString(
        React.createElement(ReportRequestModal, {
          isOpen: true,
          onClose: () => {},
          solicitudId: 'solicitud-abc-123',
          applicantName: 'Carlos Gomez',
        })
      );

      assert.ok(
        html.includes('Contanos brevemente qué ocurrió (opcional)'),
        'Debe incluir label del textarea'
      );
      assert.ok(html.includes('0 / 1000'), 'Debe mostrar contador inicial 0 / 1000');
      assert.ok(html.includes('maxLength="1000"'), 'Debe limitar a 1000 caracteres');
    });

    test('no renderiza nada cuando isOpen es false', () => {
      const html = renderToString(
        React.createElement(ReportRequestModal, {
          isOpen: false,
          onClose: () => {},
          solicitudId: 'solicitud-abc-123',
          applicantName: 'Carlos Gomez',
        })
      );

      assert.equal(html, '');
    });
  });

  describe('3. Data Layer y Seguridad de Parámetros en trustService', () => {
    test('crearReporteSeguro envía estrictamente solicitudId, contexto, motivo y detalle sin IDs extras', async () => {
      const res = await trustService.crearReporteSeguro({
        solicitudId: 'solicitud-uuid-456',
        contexto: 'pre_solicitud',
        motivo: 'commercial_spam',
        detalle: 'Venta de productos no solicitada',
      });

      assert.equal(res.ok, true);
      assert.equal(res.estado, 'pending');

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'crear_reporte_seguro');

      const params = rpcCalls[0].params;
      assert.deepEqual(params, {
        p_solicitud_id: 'solicitud-uuid-456',
        p_contexto: 'pre_solicitud',
        p_motivo: 'commercial_spam',
        p_detalle: 'Venta de productos no solicitada',
      });

      // Confirmar invariantes de privacidad: no debe haber parámetros adicionales
      assert.equal((params as any).p_reporter_id, undefined);
      assert.equal((params as any).p_reported_id, undefined);
      assert.equal((params as any).p_encuentro_id, undefined);
      assert.equal((params as any).p_host_id, undefined);
      assert.equal((params as any).p_usuario_id, undefined);

      assert.equal(fromCalls.length, 0, 'No debe acceder a tablas directas');
    });

    test('rechaza solicitudId vacío sin realizar llamadas', async () => {
      const res = await trustService.crearReporteSeguro({
        solicitudId: '',
        contexto: 'pre_solicitud',
        motivo: 'commercial_spam',
      });

      assert.equal(res.ok, false);
      assert.equal(res.error, 'invalid_solicitud_id');
      assert.equal(rpcCalls.length, 0);
    });

    test('mapea error report_already_exists correctamente', async () => {
      (supabase as any).rpc = async () => ({
        data: { ok: false, error: 'report_already_exists' },
        error: null,
      });

      const res = await trustService.crearReporteSeguro({
        solicitudId: 'solicitud-uuid-456',
        contexto: 'pre_solicitud',
        motivo: 'safety_concern',
      });

      assert.equal(res.ok, false);
      assert.equal(res.error, 'report_already_exists');
    });

    test('mapea error report_window_closed correctamente', async () => {
      (supabase as any).rpc = async () => ({
        data: { ok: false, error: 'report_window_closed' },
        error: null,
      });

      const res = await trustService.crearReporteSeguro({
        solicitudId: 'solicitud-uuid-456',
        contexto: 'pre_solicitud',
        motivo: 'inappropriate_behavior',
      });

      assert.equal(res.ok, false);
      assert.equal(res.error, 'report_window_closed');
    });
  });

  describe('4. Invariantes de Privacidad y No-Opinabilidad en UI', () => {
    test('la UI nunca muestra acusaciones ni afirmaciones de culpabilidad', () => {
      const modalPath = path.resolve(
        process.cwd(),
        'src/components/host/ReportRequestModal.tsx'
      );
      const code = fs.readFileSync(modalPath, 'utf-8');

      const forbiddenPhrases = [
        'usuario culpable',
        'usuario sancionado',
        'usuario bloqueado',
        'penalizado',
        'tomaremos medidas',
        'reporte confirmado',
        'score',
        'trust score',
      ];

      for (const phrase of forbiddenPhrases) {
        assert.ok(
          !code.toLowerCase().includes(phrase),
          `Código de la UI no debe contener frase de juicio o sanción: "${phrase}"`
        );
      }
    });

    test('el feedback de éxito es discreto y puramente confirmatorio de recepción', () => {
      const modalPath = path.resolve(
        process.cwd(),
        'src/components/host/ReportRequestModal.tsx'
      );
      const code = fs.readFileSync(modalPath, 'utf-8');

      assert.ok(
        code.includes('Reporte enviado. Gracias por avisarnos.'),
        'Debe contener mensaje neutral de agradecimiento'
      );
    });
  });
});
