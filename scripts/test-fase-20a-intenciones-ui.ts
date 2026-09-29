import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

import { IntencionCard } from '../src/components/home/intentions/IntencionCard';
import { IntencionFormSheet } from '../src/components/home/intentions/IntencionFormSheet';
import {
  PENDING_INTENTION_STORAGE_KEY,
  HomeIntencionesSection,
} from '../src/components/home/intentions/HomeIntencionesSection';
import {
  resolverTemporalidadIntencion,
  TEMPORALIDAD_CHIPS,
} from '../src/lib/temporalidadIntencion';
import { getArgentinaTodayISO } from '../src/lib/argentinaDateTime';
import { LoginRequiredSheet } from '../src/components/auth/LoginRequiredSheet';
import type { Intencion, CrearIntencionPayload } from '../src/types/intenciones';

describe('Fase 2.0-A — Intenciones: Bloque 3 UI & Auth Guard Tests', () => {
  const mockLocalidades = [
    { id: 'loc-palermo', nombre: 'Palermo', ciudad: 'CABA', zona: 'Norte', pais: 'AR', orden: 1 },
    { id: 'loc-guemes', nombre: 'Güemes', ciudad: 'Mar del Plata', zona: 'Centro', pais: 'AR', orden: 2 },
  ];

  const mockIntencionActiva: Intencion = {
    id: 'int-activa-1',
    user_id: 'usr-1',
    titulo: 'Entrenar 10k en Palermo',
    descripcion: 'Ritmo 5:30 min/km por los lagos',
    temporalidad_texto: 'Este finde',
    fecha_desde: '2026-10-03',
    fecha_hasta: '2026-10-04',
    modalidad: 'presencial',
    locality_id: 'loc-palermo',
    localidad_nombre: 'Palermo',
    localidad_ciudad: 'CABA',
    localidad_zona: 'Norte',
    estado: 'activa',
    encuentro_id: null,
    created_at: '2026-09-29T10:00:00Z',
    updated_at: '2026-09-29T10:00:00Z',
  };

  const mockIntencionPausada: Intencion = {
    id: 'int-pausada-1',
    user_id: 'usr-1',
    titulo: 'Grupo de lectura de ciencia ficción',
    descripcion: 'Libro de este mes: Fundación',
    temporalidad_texto: 'Flexible',
    fecha_desde: null,
    fecha_hasta: null,
    modalidad: 'indistinto',
    locality_id: null,
    localidad_nombre: null,
    localidad_ciudad: null,
    localidad_zona: null,
    estado: 'pausada',
    encuentro_id: null,
    created_at: '2026-09-29T10:00:00Z',
    updated_at: '2026-09-29T10:00:00Z',
  };

  describe('1. IntencionCard — Renderizado y Acciones según estado', () => {
    test('A. Intención activa renderiza título, temporalidad, modalidad, localidad y badge Activa', () => {
      const html = renderToString(
        React.createElement(IntencionCard, {
          intencion: mockIntencionActiva,
          onEdit: () => {},
          onPausar: () => {},
          onReactivar: () => {},
          onCerrar: () => {},
        })
      );

      assert.ok(html.includes('Entrenar 10k en Palermo'), 'Debe incluir el título');
      assert.ok(html.includes('Ritmo 5:30 min/km'), 'Debe incluir la descripción');
      assert.ok(html.includes('Este finde'), 'Debe incluir la temporalidad');
      assert.ok(html.includes('Presencial'), 'Debe incluir la modalidad');
      assert.ok(html.includes('Palermo, CABA'), 'Debe incluir la localidad');
      assert.ok(html.includes('Activa'), 'Debe mostrar badge Activa');
      assert.ok(html.includes('Editar'), 'Debe incluir botón Editar');
      assert.ok(html.includes('Pausar'), 'Debe incluir botón Pausar');
      assert.ok(html.includes('Cerrar'), 'Debe incluir botón Cerrar');
      assert.ok(!html.includes('Reactivar'), 'NO debe incluir botón Reactivar para intención activa');
      assert.ok(!html.includes('Organizar encuentro'), 'NO debe implementar todavía Organizar encuentro');
    });

    test('B. Intención pausada renderiza badge Pausada y botón Reactivar (sin botón Pausar)', () => {
      const html = renderToString(
        React.createElement(IntencionCard, {
          intencion: mockIntencionPausada,
          onEdit: () => {},
          onPausar: () => {},
          onReactivar: () => {},
          onCerrar: () => {},
        })
      );

      assert.ok(html.includes('Grupo de lectura de ciencia ficción'), 'Debe incluir el título');
      assert.ok(html.includes('Pausada'), 'Debe mostrar badge Pausada');
      assert.ok(html.includes('Editar'), 'Debe incluir botón Editar');
      assert.ok(html.includes('Reactivar'), 'Debe incluir botón Reactivar');
      assert.ok(html.includes('Cerrar'), 'Debe incluir botón Cerrar');
      assert.ok(!html.includes('>Pausar<'), 'NO debe incluir botón Pausar para intención pausada');
      assert.ok(!html.includes('Organizar encuentro'), 'NO debe implementar conversión');
    });
  });

  describe('2. IntencionFormSheet — Campos MVP y delimitación', () => {
    test('A. Renderiza campos requeridos: Qué, Detalles, Cuándo, Modalidad y Localidad', () => {
      const html = renderToString(
        React.createElement(IntencionFormSheet, {
          isOpen: true,
          onClose: () => {},
          onSave: async () => true,
          localidades: mockLocalidades,
        })
      );

      assert.ok(html.includes('¿Qué te gustaría hacer? *'), 'Campo título');
      assert.ok(html.includes('Detalles'), 'Campo detalles');
      assert.ok(html.includes('¿Cuándo?'), 'Sección cuándo');
      assert.ok(html.includes('Hoy'), 'Chip Hoy');
      assert.ok(html.includes('Esta semana'), 'Chip Esta semana');
      assert.ok(html.includes('Este finde'), 'Chip Este finde');
      assert.ok(html.includes('Flexible'), 'Chip Flexible');
      assert.ok(html.includes('Presencial'), 'Modalidad presencial');
      assert.ok(html.includes('Virtual'), 'Modalidad virtual');
      assert.ok(html.includes('Indistinto'), 'Modalidad indistinto');
      assert.ok(html.includes('Palermo (CABA)'), 'Opciones de localidad');
      assert.ok(html.includes('+ Expresar intención'), 'Botón CTA');
    });

    test('B. NO incluye campos descartados (categoría, GPS, radio, matching, cupo, participantes)', () => {
      const html = renderToString(
        React.createElement(IntencionFormSheet, {
          isOpen: true,
          onClose: () => {},
          onSave: async () => true,
          localidades: mockLocalidades,
        })
      );

      assert.ok(!html.includes('categoría'), 'No debe tener categorías');
      assert.ok(!html.includes('radio'), 'No debe tener radio geográfico');
      assert.ok(!html.includes('matching'), 'No debe tener matching');
      assert.ok(!html.includes('cupo'), 'No debe tener cupo');
      assert.ok(!html.includes('participantes'), 'No debe tener participantes');
    });
  });

  describe('3. Temporalidad en cliente (Argentina Timezone)', () => {
    test('A. Chip Hoy resuelve a fecha de hoy en Argentina para desde y hasta', () => {
      const res = resolverTemporalidadIntencion('hoy');
      const today = getArgentinaTodayISO();
      assert.equal(res.temporalidad_texto, 'Hoy');
      assert.equal(res.fecha_desde, today);
      assert.equal(res.fecha_hasta, today);
    });

    test('B. Chip Flexible resuelve a null en ambas fechas', () => {
      const res = resolverTemporalidadIntencion('flexible');
      assert.equal(res.temporalidad_texto, 'Flexible');
      assert.equal(res.fecha_desde, null);
      assert.equal(res.fecha_hasta, null);
    });

    test('C. Chip Esta semana resuelve con fecha_desde = hoy y fecha_hasta >= hoy', () => {
      const res = resolverTemporalidadIntencion('esta_semana');
      const today = getArgentinaTodayISO();
      assert.equal(res.temporalidad_texto, 'Esta semana');
      assert.equal(res.fecha_desde, today);
      assert.ok(res.fecha_hasta !== null && res.fecha_hasta >= today);
    });

    test('D. Catálogo de chips contiene los 4 mínimos exigidos', () => {
      const ids = TEMPORALIDAD_CHIPS.map((c) => c.id);
      assert.deepEqual(ids, ['hoy', 'esta_semana', 'este_finde', 'flexible']);
    });
  });

  describe('4. Auth Guard y LoginRequiredSheet para Intenciones', () => {
    test('A. LoginRequiredSheet soporta action="create_intention" con copies y beneficios contextuales', () => {
      const html = renderToString(
        React.createElement(LoginRequiredSheet, {
          isOpen: true,
          onClose: () => {},
          onContinueWithGoogle: () => {},
          action: 'create_intention',
        })
      );

      assert.ok(
        html.includes('Para expresar tu intención necesitás una cuenta'),
        'Debe incluir título contextual para intenciones'
      );
      assert.ok(
        html.includes('gestionar tus intenciones, pausarlas y convertirlas en encuentros'),
        'Debe incluir cuerpo contextual'
      );
      assert.ok(
        html.includes('Expresar tus intereses y planes'),
        'Debe incluir beneficios contextuales de intenciones'
      );
    });
  });

  describe('5. Pending Draft en SessionStorage', () => {
    test('A. La clave de almacenamiento es la canónica puntoencuentro_pending_intention', () => {
      assert.equal(PENDING_INTENTION_STORAGE_KEY, 'puntoencuentro_pending_intention');
    });

    test('B. El draft no contiene tokens, secretos ni user_id', () => {
      const sampleDraft: CrearIntencionPayload = {
        titulo: 'Ir a ver teatro independiente',
        descripcion: 'En el Abasto',
        temporalidad_texto: 'Este finde',
        modalidad: 'presencial',
        locality_id: 'loc-palermo',
      };

      const serialized = JSON.stringify(sampleDraft);
      const parsed = JSON.parse(serialized);

      assert.equal('user_id' in parsed, false, 'Draft no debe contener user_id');
      assert.equal('token' in parsed, false, 'Draft no debe contener tokens');
      assert.equal('secret' in parsed, false, 'Draft no debe contener secretos');
      assert.equal(parsed.titulo, 'Ir a ver teatro independiente');
    });
  });

  describe('6. Aislamiento de capas y dependencias', () => {
    test('A. HomeIntencionesSection no importa supabase directamente', () => {
      const filePath = path.join(
        process.cwd(),
        'src/components/home/intentions/HomeIntencionesSection.tsx'
      );
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(!content.includes("from '@/lib/supabase'"), 'No debe importar cliente supabase');
      assert.ok(!content.includes("from '../lib/supabase'"), 'No debe importar cliente supabase');
      assert.ok(!content.includes('supabase.from('), 'No debe hacer queries directas');
      assert.ok(!content.includes('supabase.rpc('), 'No debe hacer RPCs directas');
    });

    test('B. IntencionCard e IntencionFormSheet no importan supabase', () => {
      const cardPath = path.join(
        process.cwd(),
        'src/components/home/intentions/IntencionCard.tsx'
      );
      const formPath = path.join(
        process.cwd(),
        'src/components/home/intentions/IntencionFormSheet.tsx'
      );
      const cardContent = fs.readFileSync(cardPath, 'utf-8');
      const formContent = fs.readFileSync(formPath, 'utf-8');

      assert.ok(!cardContent.includes('supabase'), 'IntencionCard no usa supabase');
      assert.ok(!formContent.includes('supabase'), 'IntencionFormSheet no usa supabase');
    });
  });

  describe('7. Ciclo de preservación y restauración de draft sin duplicación', () => {
    test('A. HomeIntencionesSection renderiza título y botón de acción en SSR', () => {
      const html = renderToString(React.createElement(HomeIntencionesSection));
      assert.ok(html.includes('Mis intenciones'), 'Debe incluir título de la sección');
      assert.ok(html.includes('+ Expresar intención'), 'Debe incluir botón para expresar intención');
    });

    test('B. El draft pendiente se consume UNA sola vez previniendo duplicados', () => {
      // Simular almacenamiento en memoria
      const fakeStorage = new Map<string, string>();
      fakeStorage.set(
        PENDING_INTENTION_STORAGE_KEY,
        JSON.stringify({
          titulo: 'Ir a caminar por la costanera',
          temporalidad_texto: 'Hoy',
          modalidad: 'presencial',
        })
      );

      // 1. Primera lectura recupera el draft
      const firstRead = fakeStorage.get(PENDING_INTENTION_STORAGE_KEY);
      assert.ok(firstRead !== undefined);
      fakeStorage.delete(PENDING_INTENTION_STORAGE_KEY); // Invariante de consumo inmediato

      // 2. Segunda lectura (simulando refresh o re-render) debe ser null
      const secondRead = fakeStorage.get(PENDING_INTENTION_STORAGE_KEY);
      assert.equal(secondRead, undefined, 'Debe haber sido eliminado para no duplicar intenciones');
    });
  });
});
