import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

import { supabase } from '../src/lib/supabase';
import { trustService } from '../src/services/trustService';
import {
  ApplicantTrustSignals,
  formatMemberSinceMonth,
} from '../src/components/host/ApplicantTrustSignals';
import type { PerfilConfianzaSolicitante } from '../src/types/trust';

describe('Fase 2.0-C1 (T1): Ficha Factual de Actividad del Solicitante — Frontend Tests', () => {
  let rpcCalls: { fn: string; params: any }[] = [];
  let fromCalls: { table: string }[] = [];

  beforeEach(() => {
    rpcCalls = [];
    fromCalls = [];

    (supabase as any).rpc = async (fn: string, params?: any) => {
      rpcCalls.push({ fn, params });
      return {
        data: {
          ok: true,
          data: {
            member_since_month: '2026-08',
            approved_open_encounters_previous: 3,
            hosted_open_encounters_previous: 1,
            no_prior_open_history: false,
          },
        },
        error: null,
      };
    };

    (supabase as any).from = (table: string) => {
      fromCalls.push({ table });
      throw new Error(`Acceso directo prohibido a tabla: ${table}`);
    };
  });

  describe('1. Formato de Antigüedad y Localización', () => {
    test('formatea correctamente YYYY-MM a español sin hora ni día', () => {
      assert.equal(formatMemberSinceMonth('2026-08'), 'agosto de 2026');
      assert.equal(formatMemberSinceMonth('2025-01'), 'enero de 2025');
      assert.equal(formatMemberSinceMonth('2026-12'), 'diciembre de 2026');
      assert.equal(formatMemberSinceMonth(null), null);
      assert.equal(formatMemberSinceMonth(''), null);
      assert.equal(formatMemberSinceMonth('invalido'), null);
    });
  });

  describe('2. Renderizado de Señales Factuales y Pluralización', () => {
    test('renderiza antigüedad y conteos en plural', () => {
      const profile: PerfilConfianzaSolicitante = {
        member_since_month: '2026-08',
        approved_open_encounters_previous: 4,
        hosted_open_encounters_previous: 2,
        no_prior_open_history: false,
      };

      const html = renderToString(
        React.createElement(ApplicantTrustSignals, {
          solicitudId: 'solicitud-123',
          initialProfile: profile,
        })
      );

      assert.ok(html.includes('Señales en PuntoEncuentro'), 'Título de la ficha');
      assert.ok(html.includes('En PuntoEncuentro desde agosto de 2026'), 'Antigüedad');
      assert.ok(
        html.includes('Fue aceptado en 4 encuentros abiertos anteriores'),
        'Admisiones previas en plural'
      );
      assert.ok(
        html.includes('Organizó 2 encuentros abiertos anteriores'),
        'Organizados previos en plural'
      );
    });

    test('renderiza conteos en singular cuando el valor es 1', () => {
      const profile: PerfilConfianzaSolicitante = {
        member_since_month: '2026-05',
        approved_open_encounters_previous: 1,
        hosted_open_encounters_previous: 1,
        no_prior_open_history: false,
      };

      const html = renderToString(
        React.createElement(ApplicantTrustSignals, {
          solicitudId: 'solicitud-123',
          initialProfile: profile,
        })
      );

      assert.ok(
        html.includes('Fue aceptado en 1 encuentro abierto anterior'),
        'Admisiones previas en singular'
      );
      assert.ok(
        html.includes('Organizó 1 encuentro abierto anterior'),
        'Organizados previos en singular'
      );
    });

    test('omite la línea de host si hosted_open_encounters_previous es 0', () => {
      const profile: PerfilConfianzaSolicitante = {
        member_since_month: '2026-06',
        approved_open_encounters_previous: 2,
        hosted_open_encounters_previous: 0,
        no_prior_open_history: false,
      };

      const html = renderToString(
        React.createElement(ApplicantTrustSignals, {
          solicitudId: 'solicitud-123',
          initialProfile: profile,
        })
      );

      assert.ok(!html.includes('Organizó'), 'No debe mostrar organizados si es 0');
    });
  });

  describe('3. Usuario Sin Historial Previo (Estado Neutral)', () => {
    test('renderiza estado neutral sin advertencias ni estigma cuando no_prior_open_history es true', () => {
      const profile: PerfilConfianzaSolicitante = {
        member_since_month: '2026-09',
        approved_open_encounters_previous: 0,
        hosted_open_encounters_previous: 0,
        no_prior_open_history: true,
      };

      const html = renderToString(
        React.createElement(ApplicantTrustSignals, {
          solicitudId: 'solicitud-123',
          initialProfile: profile,
        })
      );

      assert.ok(
        html.includes('Sin historial previo en Encuentros Abiertos'),
        'Título de estado neutral'
      );
      assert.ok(
        html.includes(
          'Esta persona todavía no tiene actividad previa suficiente en PuntoEncuentro. Su mensaje de presentación puede ayudarte a decidir.'
        ),
        'Microcopy neutral'
      );
      assert.ok(!html.includes('Fue aceptado en 0'), 'No debe mostrar 0 encuentros');
    });
  });

  describe('4. Invariantes de Lenguaje y No-Opinabilidad', () => {
    test('la UI NUNCA incluye palabras de juicio, asistencia presencial, scoring o estrellas', () => {
      const testProfiles: PerfilConfianzaSolicitante[] = [
        {
          member_since_month: '2026-08',
          approved_open_encounters_previous: 5,
          hosted_open_encounters_previous: 2,
          no_prior_open_history: false,
        },
        {
          member_since_month: '2026-09',
          approved_open_encounters_previous: 0,
          hosted_open_encounters_previous: 0,
          no_prior_open_history: true,
        },
      ];

      for (const p of testProfiles) {
        const html = renderToString(
          React.createElement(ApplicantTrustSignals, {
            solicitudId: 'solicitud-123',
            initialProfile: p,
          })
        );

        const forbiddenWords = [
          'asistió',
          'asistencia',
          'completó',
          'identidad verificada',
          'Good Standing',
          'score',
          'Score',
          'estrella',
          'estrellas',
          'reputación',
          'reputacion',
          'sospechoso',
          'riesgo',
          'baja confianza',
          'rating',
        ];

        for (const word of forbiddenWords) {
          assert.ok(
            !html.includes(word),
            `El renderizado NO debe contener la palabra prohibida "${word}"`
          );
        }
      }
    });
  });

  describe('5. Seguridad y Aislamiento en trustService', () => {
    test('getPerfilConfianzaSolicitante envía únicamente solicitudId vía RPC sin acceso a tablas', async () => {
      const res = await trustService.getPerfilConfianzaSolicitante('solicitud-uuid-999');

      assert.equal(res.ok, true);
      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'get_perfil_confianza_solicitante');
      assert.deepEqual(rpcCalls[0].params, {
        p_solicitud_id: 'solicitud-uuid-999',
      });
      assert.equal(fromCalls.length, 0, 'No debe acceder a tablas directas');
    });

    test('rechaza solicitudId vacío sin realizar llamadas', async () => {
      const res = await trustService.getPerfilConfianzaSolicitante('');
      assert.equal(res.ok, false);
      assert.equal(res.error, 'invalid_solicitud_id');
      assert.equal(rpcCalls.length, 0);
    });
  });

  describe('6. Integración en HostOpenEncounterSection', () => {
    test('HostOpenEncounterSection importa y renderiza ApplicantTrustSignals', () => {
      const sectionFilePath = path.resolve(
        process.cwd(),
        'src/components/host/HostOpenEncounterSection.tsx'
      );
      const code = fs.readFileSync(sectionFilePath, 'utf-8');

      assert.ok(
        code.includes("import { ApplicantTrustSignals } from './ApplicantTrustSignals'"),
        'Debe importar ApplicantTrustSignals'
      );
      assert.ok(
        code.includes('<ApplicantTrustSignals solicitudId={req.id} />'),
        'Debe renderizar ApplicantTrustSignals pasando solicitudId'
      );
      assert.ok(
        code.includes('handleAprobar') && code.includes('handleRechazar'),
        'Botones de aprobación y rechazo deben conservarse intactos'
      );
    });
  });
});
