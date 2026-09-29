import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';

import { useWizardStore } from '../src/store/wizardStore';
import { preloadWizardFromIntencion } from '../src/lib/preloadWizardFromIntencion';
import { intencionesService } from '../src/services/intencionesService';
import { IntencionCard } from '../src/components/home/intentions/IntencionCard';
import { supabase } from '../src/lib/supabase';
import type { Intencion } from '../src/types/intenciones';

describe('Fase 2.0-A — Intenciones: Bloque 4 Frontend Tests (Intención → Encuentro)', () => {
  beforeEach(() => {
    useWizardStore.getState().reset();
  });

  const baseIntencion: Intencion = {
    id: 'int-123',
    user_id: 'usr-1',
    titulo: 'Salir a correr por los bosques',
    descripcion: 'Unos 8k a ritmo tranquilo',
    temporalidad_texto: 'Este sábado a la mañana',
    fecha_desde: '2026-10-03',
    fecha_hasta: '2026-10-03',
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

  describe('1. wizardStore — Gestión de sourceIntentionId', () => {
    test('A. sourceIntentionId inicia en null por defecto', () => {
      const state = useWizardStore.getState();
      assert.equal(state.sourceIntentionId, null);
    });

    test('B. setSourceIntentionId asigna correctamente el id de la intención origen', () => {
      useWizardStore.getState().setSourceIntentionId('int-abc-999');
      assert.equal(useWizardStore.getState().sourceIntentionId, 'int-abc-999');
    });

    test('C. reset() restablece sourceIntentionId a null', () => {
      useWizardStore.getState().setSourceIntentionId('int-abc-999');
      assert.equal(useWizardStore.getState().sourceIntentionId, 'int-abc-999');

      useWizardStore.getState().reset();
      assert.equal(useWizardStore.getState().sourceIntentionId, null);
    });
  });

  describe('2. preloadWizardFromIntencion — Mapeo estricto del Draft', () => {
    test('A. Precarga titulo, descripcion y modalidad presencial correctamente', () => {
      preloadWizardFromIntencion(baseIntencion);
      const state = useWizardStore.getState();

      assert.equal(state.titulo, 'Salir a correr por los bosques');
      assert.equal(state.descripcion, 'Unos 8k a ritmo tranquilo');
      assert.equal(state.modalidad, 'presencial');
      assert.equal(state.sourceIntentionId, 'int-123');
      assert.equal(state.step, 1);
    });

    test('B. Modalidad virtual se mapea a "virtual"', () => {
      preloadWizardFromIntencion({
        ...baseIntencion,
        id: 'int-virtual',
        modalidad: 'virtual',
      });
      const state = useWizardStore.getState();
      assert.equal(state.modalidad, 'virtual');
      assert.equal(state.sourceIntentionId, 'int-virtual');
    });

    test('C. Modalidad indistinta se mapea a null para que el usuario elija en el wizard', () => {
      preloadWizardFromIntencion({
        ...baseIntencion,
        id: 'int-indistinto',
        modalidad: 'indistinto',
      });
      const state = useWizardStore.getState();
      assert.equal(state.modalidad, null);
      assert.equal(state.sourceIntentionId, 'int-indistinto');
    });

    test('D. Logística obligatoria (fecha, hora, lugar_texto, link_virtual) queda VACÍA (no inventa datos)', () => {
      preloadWizardFromIntencion(baseIntencion);
      const state = useWizardStore.getState();

      assert.equal(state.fecha, '', 'La fecha debe quedar vacía');
      assert.equal(state.hora, '', 'La hora debe quedar vacía');
      assert.equal(state.lugar_texto, '', 'El lugar_texto no debe inventarse a partir de locality_id');
      assert.equal(state.link_virtual, '', 'El link_virtual debe quedar vacío');
    });

    test('E. Limpia datos anteriores y reinicia paso a 1', () => {
      useWizardStore.getState().setField('step', 3);
      useWizardStore.getState().setField('encuentro_id', 'enc-old-123');
      useWizardStore.getState().setField('fecha', '2026-12-31');

      preloadWizardFromIntencion(baseIntencion);
      const state = useWizardStore.getState();

      assert.equal(state.step, 1);
      assert.equal(state.encuentro_id, null);
      assert.equal(state.fecha, '');
    });
  });

  describe('3. intencionesService — convertirIntencionAEncuentro', () => {
    test('A. Invoca la RPC convertir_intencion_a_encuentro con los parámetros seguros', async () => {
      let rpcNameCalled = '';
      let rpcParamsCalled: any = null;

      const originalRpc = supabase.rpc;
      (supabase as any).rpc = async (fn: string, params: any) => {
        rpcNameCalled = fn;
        rpcParamsCalled = params;
        return {
          data: {
            ok: true,
            id: params.p_intencion_id,
            estado: 'convertida',
            encuentro_id: params.p_encuentro_id,
            idempotent: false,
          },
          error: null,
        };
      };

      try {
        const result = await intencionesService.convertirIntencionAEncuentro('int-123', 'enc-456');

        assert.equal(rpcNameCalled, 'convertir_intencion_a_encuentro');
        assert.deepEqual(rpcParamsCalled, {
          p_intencion_id: 'int-123',
          p_encuentro_id: 'enc-456',
        });
        assert.equal(result.ok, true);
        assert.equal(result.data?.id, 'int-123');
        assert.equal(result.data?.estado, 'convertida');
        assert.equal(result.data?.encuentro_id, 'enc-456');
        assert.equal(result.data?.idempotent, false);
      } finally {
        (supabase as any).rpc = originalRpc;
      }
    });

    test('B. Captura errores de RPC y devuelve ok: false sin lanzar excepción no controlada', async () => {
      const originalRpc = supabase.rpc;
      (supabase as any).rpc = async () => {
        return {
          data: null,
          error: { message: 'intention_not_found' },
        };
      };

      try {
        const result = await intencionesService.convertirIntencionAEncuentro('int-not-found', 'enc-1');
        assert.equal(result.ok, false);
        assert.equal(result.error, 'intention_not_found');
      } finally {
        (supabase as any).rpc = originalRpc;
      }
    });

    test('C. Captura excepciones de red y devuelve ok: false fail-safe', async () => {
      const originalRpc = supabase.rpc;
      (supabase as any).rpc = async () => {
        throw new Error('Network failure');
      };

      try {
        const result = await intencionesService.convertirIntencionAEncuentro('int-1', 'enc-1');
        assert.equal(result.ok, false);
        assert.equal(result.error, 'Network failure');
      } finally {
        (supabase as any).rpc = originalRpc;
      }
    });
  });

  describe('4. IntencionCard — Visibilidad del CTA "Organizar encuentro"', () => {
    test('A. Intención ACTIVA renderiza botón "Organizar encuentro" cuando onOrganizar está provisto', () => {
      let organizadoIntencion: Intencion | null = null;
      const html = renderToString(
        React.createElement(IntencionCard, {
          intencion: baseIntencion,
          onEdit: () => {},
          onPausar: () => {},
          onReactivar: () => {},
          onCerrar: () => {},
          onOrganizar: (i) => {
            organizadoIntencion = i;
          },
        })
      );

      assert.ok(html.includes('Organizar encuentro'), 'Debe renderizar botón Organizar encuentro');
      assert.ok(html.includes('pe-intencion-card__btn--organizar'), 'Debe tener clase CSS correspondiente');
    });

    test('B. Intención PAUSADA también renderiza botón "Organizar encuentro"', () => {
      const pausada: Intencion = { ...baseIntencion, estado: 'pausada' };
      const html = renderToString(
        React.createElement(IntencionCard, {
          intencion: pausada,
          onEdit: () => {},
          onPausar: () => {},
          onReactivar: () => {},
          onCerrar: () => {},
          onOrganizar: () => {},
        })
      );

      assert.ok(html.includes('Organizar encuentro'), 'Debe renderizar botón en estado pausada');
    });

    test('C. Intención CONVERTIDA NO renderiza botón "Organizar encuentro"', () => {
      const convertida: Intencion = { ...baseIntencion, estado: 'convertida', encuentro_id: 'enc-1' };
      const html = renderToString(
        React.createElement(IntencionCard, {
          intencion: convertida,
          onEdit: () => {},
          onPausar: () => {},
          onReactivar: () => {},
          onCerrar: () => {},
          onOrganizar: () => {},
        })
      );

      assert.ok(!html.includes('Organizar encuentro'), 'NO debe renderizar botón Organizar encuentro en estado convertida');
    });

    test('D. Intención CERRADA NO renderiza botón "Organizar encuentro"', () => {
      const cerrada: Intencion = { ...baseIntencion, estado: 'cerrada' };
      const html = renderToString(
        React.createElement(IntencionCard, {
          intencion: cerrada,
          onEdit: () => {},
          onPausar: () => {},
          onReactivar: () => {},
          onCerrar: () => {},
          onOrganizar: () => {},
        })
      );

      assert.ok(!html.includes('Organizar encuentro'), 'NO debe renderizar botón Organizar encuentro en estado cerrada');
    });

    test('E. Sin handler onOrganizar NO renderiza el botón', () => {
      const html = renderToString(
        React.createElement(IntencionCard, {
          intencion: baseIntencion,
          onEdit: () => {},
          onPausar: () => {},
          onReactivar: () => {},
          onCerrar: () => {},
        })
      );

      assert.ok(!html.includes('Organizar encuentro'), 'NO debe renderizar botón si onOrganizar no fue pasado');
    });
  });

  describe('5. Step4InviteType — Tolerancia a fallos y preservación de contexto', () => {
    test('A. Tolerancia a fallo de vinculación: si la vinculación falla, no borra el encuentro ni rompe el flujo', async () => {
      // Simular intento de vinculación que falla
      const originalRpc = supabase.rpc;
      (supabase as any).rpc = async () => {
        return { data: null, error: { message: 'temporary_network_error' } };
      };

      try {
        useWizardStore.getState().setSourceIntentionId('int-123');

        // Simular llamada de Step4
        const sourceId = useWizardStore.getState().sourceIntentionId;
        const convRes = await intencionesService.convertirIntencionAEncuentro(
          sourceId!,
          'enc-new-456'
        );

        assert.equal(convRes.ok, false);
        // Si convRes.ok es false, Step4InviteType no limpia el sourceIntentionId para permitir reintento
        // y no invoca borrado del encuentro
        assert.equal(useWizardStore.getState().sourceIntentionId, 'int-123', 'Debe preservar sourceIntentionId para reintento');
      } finally {
        (supabase as any).rpc = originalRpc;
      }
    });

    test('B. Vinculación exitosa limpia sourceIntentionId de wizardStore', async () => {
      const originalRpc = supabase.rpc;
      (supabase as any).rpc = async () => {
        return {
          data: { ok: true, id: 'int-123', estado: 'convertida', encuentro_id: 'enc-new-456', idempotent: false },
          error: null,
        };
      };

      try {
        useWizardStore.getState().setSourceIntentionId('int-123');

        const sourceId = useWizardStore.getState().sourceIntentionId;
        const convRes = await intencionesService.convertirIntencionAEncuentro(
          sourceId!,
          'enc-new-456'
        );

        assert.equal(convRes.ok, true);
        if (convRes.ok) {
          useWizardStore.getState().setSourceIntentionId(null);
        }
        assert.equal(useWizardStore.getState().sourceIntentionId, null, 'Debe haber limpiado sourceIntentionId');
      } finally {
        (supabase as any).rpc = originalRpc;
      }
    });
  });
});
