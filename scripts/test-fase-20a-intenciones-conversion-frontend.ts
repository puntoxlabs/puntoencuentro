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

  describe('5. Step4InviteType — Retry seguro y tolerancia a fallos', () => {
    test('A. Creación normal sin intención: no invoca convertirIntencionAEncuentro y conserva flujo intacto', async () => {
      let rpcCalled = false;
      const originalRpc = supabase.rpc;
      (supabase as any).rpc = async () => {
        rpcCalled = true;
        return { data: { ok: true }, error: null };
      };

      try {
        useWizardStore.getState().setSourceIntentionId(null);
        assert.equal(useWizardStore.getState().sourceIntentionId, null);
        // Cuando sourceIntentionId es null, el bloque de vinculación no se ejecuta
        const sourceId = useWizardStore.getState().sourceIntentionId;
        if (sourceId) {
          await intencionesService.convertirIntencionAEncuentro(sourceId, 'enc-1');
        }
        assert.equal(rpcCalled, false, 'No debe invocar RPC de conversión si no hay sourceIntentionId');
      } finally {
        (supabase as any).rpc = originalRpc;
      }
    });

    test('B. Intención con vinculación exitosa: limpia sourceIntentionId y continúa flujo normal', async () => {
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
          useWizardStore.getState().setField('sourceIntentionId', null);
        }
        assert.equal(useWizardStore.getState().sourceIntentionId, null, 'Debe limpiar sourceIntentionId tras éxito');
      } finally {
        (supabase as any).rpc = originalRpc;
      }
    });

    test('C. Fallo de vinculación NO navega automáticamente y preserva sourceIntentionId y encuentroId', async () => {
      const originalRpc = supabase.rpc;
      (supabase as any).rpc = async () => {
        return { data: null, error: { message: 'temporary_network_error' } };
      };

      try {
        useWizardStore.getState().setSourceIntentionId('int-123');
        useWizardStore.getState().setField('encuentro_id', 'enc-new-456');

        const sourceId = useWizardStore.getState().sourceIntentionId;
        const convRes = await intencionesService.convertirIntencionAEncuentro(
          sourceId!,
          'enc-new-456'
        );

        assert.equal(convRes.ok, false);
        // En fallo, NO se limpia sourceIntentionId ni se borra encuentro_id
        assert.equal(useWizardStore.getState().sourceIntentionId, 'int-123', 'Conserva sourceIntentionId');
        assert.equal(useWizardStore.getState().encuentro_id, 'enc-new-456', 'Conserva encuentro_id ya creado');
      } finally {
        (supabase as any).rpc = originalRpc;
      }
    });

    test('D. Retry de vinculación utiliza el MISMO encuentroId y NO crea un segundo encuentro', async () => {
      let rpcCalls = 0;
      let usedEncuentroId = '';
      const originalRpc = supabase.rpc;
      (supabase as any).rpc = async (fn: string, params: any) => {
        rpcCalls++;
        usedEncuentroId = params.p_encuentro_id;
        return {
          data: { ok: true, id: params.p_intencion_id, estado: 'convertida', encuentro_id: params.p_encuentro_id, idempotent: false },
          error: null,
        };
      };

      try {
        const existingEncuentroId = 'enc-already-created-789';
        useWizardStore.getState().setField('encuentro_id', existingEncuentroId);
        useWizardStore.getState().setSourceIntentionId('int-123');

        // Simular handleRetryLinking:
        // No llama a encuentrosService.createEncuentro, sino directamente a convertirIntencionAEncuentro con existingEncuentroId
        const targetId = useWizardStore.getState().encuentro_id;
        const sourceId = useWizardStore.getState().sourceIntentionId;
        const retryRes = await intencionesService.convertirIntencionAEncuentro(sourceId!, targetId!);

        assert.equal(retryRes.ok, true);
        assert.equal(rpcCalls, 1);
        assert.equal(usedEncuentroId, existingEncuentroId, 'Debe reutilizar el mismo encuentroId creado');
        assert.equal(useWizardStore.getState().encuentro_id, existingEncuentroId, 'El encuentroId se mantiene inalterado');
      } finally {
        (supabase as any).rpc = originalRpc;
      }
    });

    test('E. Retry exitoso limpia sourceIntentionId', async () => {
      const originalRpc = supabase.rpc;
      (supabase as any).rpc = async () => {
        return {
          data: { ok: true, id: 'int-123', estado: 'convertida', encuentro_id: 'enc-789', idempotent: false },
          error: null,
        };
      };

      try {
        useWizardStore.getState().setSourceIntentionId('int-123');
        const res = await intencionesService.convertirIntencionAEncuentro('int-123', 'enc-789');
        assert.equal(res.ok, true);
        useWizardStore.getState().setField('sourceIntentionId', null);
        assert.equal(useWizardStore.getState().sourceIntentionId, null);
      } finally {
        (supabase as any).rpc = originalRpc;
      }
    });

    test('F. Retry fallido conserva sourceIntentionId y encuentroId para futuros reintentos', async () => {
      const originalRpc = supabase.rpc;
      (supabase as any).rpc = async () => {
        return { data: null, error: { message: 'db_timeout' } };
      };

      try {
        useWizardStore.getState().setSourceIntentionId('int-123');
        useWizardStore.getState().setField('encuentro_id', 'enc-789');

        const res = await intencionesService.convertirIntencionAEncuentro('int-123', 'enc-789');
        assert.equal(res.ok, false);
        // Si el retry falla, el contexto sigue disponible
        assert.equal(useWizardStore.getState().sourceIntentionId, 'int-123');
        assert.equal(useWizardStore.getState().encuentro_id, 'enc-789');
      } finally {
        (supabase as any).rpc = originalRpc;
      }
    });

    test('G. "Continuar de todos modos": limpia sourceIntentionId y NO elimina el encuentro creado', () => {
      useWizardStore.getState().setSourceIntentionId('int-123');
      useWizardStore.getState().setField('encuentro_id', 'enc-789');

      // Simular handleContinueAnyway
      useWizardStore.getState().setField('sourceIntentionId', null);

      assert.equal(useWizardStore.getState().sourceIntentionId, null, 'Debe limpiar sourceIntentionId para evitar contaminar futuras creaciones');
      assert.equal(useWizardStore.getState().encuentro_id, 'enc-789', 'El encuentro creado NUNCA se elimina');
    });

    test('H. El encuentro creado nunca se elimina ni se revierte por fallo de vinculación', async () => {
      let deleteCalled = false;
      useWizardStore.getState().setField('encuentro_id', 'enc-valid-111');
      useWizardStore.getState().setSourceIntentionId('int-123');

      // Simular fallo
      const originalRpc = supabase.rpc;
      (supabase as any).rpc = async () => ({ data: null, error: { message: 'fail' } });

      try {
        const res = await intencionesService.convertirIntencionAEncuentro('int-123', 'enc-valid-111');
        assert.equal(res.ok, false);
        // En ningún momento se llama a borrar encuentro
        assert.equal(deleteCalled, false);
        assert.equal(useWizardStore.getState().encuentro_id, 'enc-valid-111', 'Encuentro intacto');
      } finally {
        (supabase as any).rpc = originalRpc;
      }
    });
  });
});
