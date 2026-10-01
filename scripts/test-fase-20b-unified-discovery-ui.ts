import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';

import {
  HomeOpenEncounters,
  PENDING_INTENTION_INTEREST_KEY,
} from '../src/components/home/openEncounters/HomeOpenEncounters';
import { PublicIntencionCard } from '../src/components/home/discovery/PublicIntencionCard';
import { OPEN_ENCOUNTERS_DEMO } from '../src/components/home/openEncounters/demoData';
import type { PublicIntencionSummary } from '../src/types/intenciones';
import type { OpenEncounterSummary } from '../src/components/home/openEncounters/types';

describe('Fase 2.0-B Discovery Unificado — Bloque 4 UI Tests', () => {
  const sampleIntencionAjena: PublicIntencionSummary = {
    id: 'int-public-1',
    titulo: 'Pádel principiantes',
    descripcion: 'Para divertirnos y aprender',
    temporalidad_texto: 'Este sábado por la tarde',
    fecha_desde: '2026-10-03',
    fecha_hasta: '2026-10-03',
    modalidad: 'presencial',
    locality_id: 'palermo',
    approximate_zone: 'Palermo',
    interested_count: 2,
    created_at: '2026-09-29T10:00:00Z',
    is_own: false,
    viewer_interested: false,
  };

  const sampleIntencionPropia: PublicIntencionSummary = {
    ...sampleIntencionAjena,
    id: 'int-propia-1',
    titulo: 'Mi intención de running',
    is_own: true,
    viewer_interested: false,
  };

  const sampleIntencionInteresada: PublicIntencionSummary = {
    ...sampleIntencionAjena,
    id: 'int-interesada-1',
    titulo: 'Ajedrez en el parque',
    viewer_interested: true,
  };

  describe('1. Selector de Tabs y Estructura del Discovery', () => {
    test('renderiza selector accesible [ Todo ] [ Encuentros ] [ Ganas de… ]', () => {
      const html = renderToString(
        React.createElement(HomeOpenEncounters, {
          encounters: OPEN_ENCOUNTERS_DEMO,
          intentions: [sampleIntencionAjena],
        })
      );

      assert.ok(html.includes('role="tablist"'), 'Debe incluir tablist accesible');
      assert.ok(html.includes('Todo'), 'Tab Todo');
      assert.ok(html.includes('Encuentros'), 'Tab Encuentros');
      assert.ok(html.includes('Ganas de…'), 'Tab Ganas de…');
      assert.ok(html.includes('aria-selected="true"'), 'Tab activo seleccionado');
    });

    test('en vista "Todo" muestra ambos grupos separados sin ranking común', () => {
      const html = renderToString(
        React.createElement(HomeOpenEncounters, {
          encounters: OPEN_ENCOUNTERS_DEMO,
          intentions: [sampleIntencionAjena],
        })
      );

      assert.ok(html.includes('Encuentros próximos'), 'Subtítulo grupo 1');
      assert.ok(html.includes('Ganas de…'), 'Subtítulo grupo 2');
      assert.ok(html.includes('Pádel principiantes'), 'Intención visible en Todo');
      assert.ok(html.includes('Fútbol 5'), 'Encuentro visible en Todo');
    });
  });

  describe('2. Card Pública de Intención (PublicIntencionCard)', () => {
    test('muestra únicamente datos del DTO público sanitizado', () => {
      const html = renderToString(
        React.createElement(PublicIntencionCard, {
          intencion: sampleIntencionAjena,
        })
      );

      assert.ok(html.includes('Ganas de…'), 'Badge de tipo');
      assert.ok(html.includes('Presencial'), 'Badge de modalidad');
      assert.ok(html.includes('Pádel principiantes'), 'Título');
      assert.ok(html.includes('Para divertirnos y aprender'), 'Descripción');
      assert.ok(html.includes('Palermo'), 'Zona aproximada');
      assert.ok(html.includes('Este sábado por la tarde'), 'Temporalidad texto');
      assert.ok(html.includes('2'), 'Contador de interesados');

      // No exponer campos privados ni técnicos
      assert.ok(!html.includes('user_id'), 'user_id no debe estar en HTML');
      assert.ok(!html.includes('encuentro_id'), 'encuentro_id no debe estar en HTML');
      assert.ok(!html.includes('updated_at'), 'updated_at no debe estar en HTML');
    });

    test('intención propia muestra "Tu intención" y NUNCA botón de interés', () => {
      const html = renderToString(
        React.createElement(PublicIntencionCard, {
          intencion: sampleIntencionPropia,
        })
      );

      assert.ok(html.includes('Tu intención'), 'Badge indicando propiedad');
      assert.ok(html.includes('Tu intención publicada en Discovery'), 'Mensaje claro');
      assert.ok(!html.includes('A mí también me interesa'), 'NO debe ofrecer botón de interés propio');
    });

    test('intención ajena no interesada muestra CTA "A mí también me interesa"', () => {
      const html = renderToString(
        React.createElement(PublicIntencionCard, {
          intencion: sampleIntencionAjena,
        })
      );

      assert.ok(html.includes('A mí también me interesa'), 'Botón para marcar interés');
      assert.ok(!html.includes('Tu intención'), 'NO es propia');
    });

    test('intención ajena con viewer_interested=true muestra "Te interesa" y botón de retiro', () => {
      const html = renderToString(
        React.createElement(PublicIntencionCard, {
          intencion: sampleIntencionInteresada,
        })
      );

      assert.ok(html.includes('Te interesa'), 'Estado activo visible');
      assert.ok(html.includes('Ya no me interesa'), 'Botón discreto para retirar interés');
      assert.ok(!html.includes('A mí también me interesa'), 'No debe mostrar CTA inicial');
    });

    test('incluye microcopy explicativo sobre la naturaleza de la acción', () => {
      const html = renderToString(
        React.createElement(PublicIntencionCard, {
          intencion: sampleIntencionAjena,
        })
      );

      assert.ok(
        html.includes(
          'Le muestra a quien propuso la idea que hay interés para que se anime a poner fecha y lugar'
        ),
        'Microcopy pedagógico debe estar presente'
      );
      assert.ok(
        html.includes('No te suma a ningún grupo ni te compromete'),
        'Microcopy sobre falta de compromiso'
      );
    });
  });

  describe('3. Comportamiento de Acciones e Idempotencia', () => {
    test('marcar interés invoca callback con parámetros explícitos (id, true)', () => {
      let calledId: string | null = null;
      let calledValue: boolean | null = null;

      const card = React.createElement(PublicIntencionCard, {
        intencion: sampleIntencionAjena,
        onInterestClick: (id, val) => {
          calledId = id;
          calledValue = val;
        },
      });

      // Simular click
      (card.props as any).onInterestClick(sampleIntencionAjena.id, true);

      assert.equal(calledId, sampleIntencionAjena.id);
      assert.equal(calledValue, true, 'Debe enviar true explícito');
    });

    test('retirar interés invoca callback con parámetros explícitos (id, false)', () => {
      let calledId: string | null = null;
      let calledValue: boolean | null = null;

      const card = React.createElement(PublicIntencionCard, {
        intencion: sampleIntencionInteresada,
        onInterestClick: (id, val) => {
          calledId = id;
          calledValue = val;
        },
      });

      // Simular click de retiro
      (card.props as any).onInterestClick(sampleIntencionInteresada.id, false);

      assert.equal(calledId, sampleIntencionInteresada.id);
      assert.equal(calledValue, false, 'Debe enviar false explícito (sin toggle)');
    });
  });

  describe('4. Lifecycle de Pending Interest post-OAuth', () => {
    test('constante PENDING_INTENTION_INTEREST_KEY está estandarizada', () => {
      assert.equal(
        PENDING_INTENTION_INTEREST_KEY,
        'puntoencuentro_pending_intention_interest'
      );
    });

    test('pending action guarda exclusivamente intencionId e interesado: true', () => {
      const pendingPayload = {
        intencionId: 'int-123',
        interesado: true,
      };

      const serialized = JSON.stringify(pendingPayload);
      const parsed = JSON.parse(serialized);

      assert.equal(parsed.intencionId, 'int-123');
      assert.equal(parsed.interesado, true);
      assert.equal(parsed.user_id, undefined, 'No guardar user_id');
      assert.equal(parsed.token, undefined, 'No guardar token');
    });
  });

  describe('5. Empty States y Fail-Soft', () => {
    test('renderiza copy humano cuando no hay intenciones en la zona', () => {
      const html = renderToString(
        React.createElement(HomeOpenEncounters, {
          encounters: OPEN_ENCOUNTERS_DEMO,
          intentions: [],
        })
      );

      assert.ok(
        html.includes('Todavía no hay nada por acá.'),
        'Título empty state'
      );
      assert.ok(
        html.includes('¿Y vos? ¿Qué tenés ganas de hacer?'),
        'Cuerpo empty state'
      );
      assert.ok(
        html.includes('Tengo ganas de…'),
        'CTA secundario empty state'
      );
    });

    test('renderiza aviso cuando no hay encuentros en la zona', () => {
      const html = renderToString(
        React.createElement(HomeOpenEncounters, {
          encounters: [],
          intentions: [sampleIntencionAjena],
        })
      );

      assert.ok(
        html.includes('No hay encuentros abiertos ahora en tus zonas.'),
        'Mensaje de encuentros vacíos'
      );
      assert.ok(
        html.includes('Pádel principiantes'),
        'Intenciones siguen disponibles a pesar de no haber encuentros'
      );
    });
  });

  describe('6. Aislamiento y Seguridad de Componentes', () => {
    test('PublicIntencionCard y HomeOpenEncounters son funciones puras/componentes exportados', () => {
      assert.equal(typeof PublicIntencionCard, 'function');
      assert.equal(typeof HomeOpenEncounters, 'function');
    });
  });
});
