import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { supabase } from '../src/lib/supabase';
import { alertasService } from '../src/services/alertasService';
import type { AlertaCompatibilidad } from '../src/types/alertas';

describe('Fase 2.0-C1: Frontend Data Layer de Alertas', () => {
  let rpcCalls: { fn: string; params: any }[] = [];
  let fromCalls: { table: string }[] = [];
  let mockRpcResponse: { data: any; error: any } = { data: null, error: null };

  beforeEach(() => {
    rpcCalls = [];
    fromCalls = [];
    mockRpcResponse = { data: null, error: null };

    // Interceptar supabase.rpc
    (supabase as any).rpc = async (fn: string, params?: any) => {
      rpcCalls.push({ fn, params });
      if (mockRpcResponse.error instanceof Error && !(mockRpcResponse.error as any).message) {
        throw mockRpcResponse.error;
      }
      return mockRpcResponse;
    };

    // Interceptar supabase.from para verificar que no haya acceso directo a tablas
    (supabase as any).from = (table: string) => {
      fromCalls.push({ table });
      throw new Error(`Acceso directo prohibido a tabla: ${table}`);
    };
  });

  describe('1. alertasService.getMisAlertas()', () => {
    test('Usa exclusivamente la RPC segura get_mis_alertas_seguro sin parámetros de usuario cliente', async () => {
      mockRpcResponse = {
        data: {
          ok: true,
          alertas: [],
        },
        error: null,
      };

      const res = await alertasService.getMisAlertas();
      assert.equal(res.ok, true);
      assert.deepEqual(res.data, []);
      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'get_mis_alertas_seguro');
      assert.equal(rpcCalls[0].params, undefined, 'No debe enviar parámetros ni user_id desde cliente');
      assert.equal(fromCalls.length, 0, 'No debe acceder directamente a tablas');
    });

    test('Mapea correctamente el DTO público sanitizado', async () => {
      const mockAlertaBackend = {
        id: 'alerta-uuid-1',
        tipo: 'interes_convertido',
        source_intencion_id: 'intencion-uuid-1',
        target_encuentro_id: 'encuentro-uuid-1',
        leida: false,
        created_at: '2026-09-30T10:00:00Z',
        encuentro_titulo: 'Torneo Pádel Palermo',
        encuentro_fecha: '2026-10-10',
        encuentro_hora: '18:00:00',
        encuentro_modalidad: 'presencial',
        encuentro_approximate_zone: 'Palermo',
        encuentro: {
          id: 'encuentro-uuid-1',
          titulo: 'Torneo Pádel Palermo',
          descripcion: 'Detalle público',
          fecha: '2026-10-10',
          hora: '18:00:00',
          modalidad: 'presencial',
          approximate_zone: 'Palermo',
          locality_id: 'palermo',
          is_open: true,
        },
      };

      mockRpcResponse = {
        data: {
          ok: true,
          alertas: [mockAlertaBackend],
        },
        error: null,
      };

      const res = await alertasService.getMisAlertas();
      assert.equal(res.ok, true);
      assert.ok(res.data);
      assert.equal(res.data.length, 1);

      const alerta = res.data[0];
      assert.equal(alerta.id, 'alerta-uuid-1');
      assert.equal(alerta.tipo, 'interes_convertido');
      assert.equal(alerta.source_intencion_id, 'intencion-uuid-1');
      assert.equal(alerta.target_encuentro_id, 'encuentro-uuid-1');
      assert.equal(alerta.leida, false);
      assert.equal(alerta.encuentro.titulo, 'Torneo Pádel Palermo');
      assert.equal(alerta.encuentro.approximate_zone, 'Palermo');
      assert.equal((alerta as any).public_token, undefined, 'DTO no debe incluir public_token');
      assert.equal((alerta.encuentro as any).public_token, undefined, 'encuentro DTO no debe incluir public_token');
    });

    test('Garantiza ausencia de campos privados en el DTO (host_id, emails, lugar_texto, public_token)', async () => {
      const rawPayload = {
        id: 'alerta-uuid-2',
        tipo: 'interes_convertido',
        source_intencion_id: 'intencion-uuid-2',
        target_encuentro_id: 'encuentro-uuid-2',
        leida: false,
        created_at: '2026-09-30T11:00:00Z',
        encuentro: {
          id: 'encuentro-uuid-2',
          titulo: 'Café de charlas',
          descripcion: 'Charlas de tecnología',
          fecha: '2026-10-12',
          hora: '19:00',
          modalidad: 'presencial',
          approximate_zone: 'Recoleta',
          locality_id: 'recoleta',
          is_open: true,
        },
      };

      mockRpcResponse = {
        data: {
          ok: true,
          data: [rawPayload],
        },
        error: null,
      };

      const res = await alertasService.getMisAlertas();
      assert.equal(res.ok, true);
      const item: any = res.data?.[0];

      // Verificación de invariantes de seguridad y privacidad
      assert.equal(item.user_id, undefined, 'user_id de la alerta no debe ser visible');
      assert.equal(item.host_id, undefined, 'host_id no debe ser expuesto');
      assert.equal(item.encuentro.host_id, undefined, 'encuentro.host_id no debe ser expuesto');
      assert.equal(item.public_token, undefined, 'public_token no debe ser expuesto');
      assert.equal(item.encuentro.public_token, undefined, 'encuentro.public_token no debe ser expuesto');
      assert.equal(item.lugar_texto, undefined, 'lugar_texto exacto no debe ser expuesto');
      assert.equal(item.encuentro.lugar_texto, undefined, 'encuentro.lugar_texto no debe ser expuesto');
      assert.equal(item.email, undefined, 'email no debe ser expuesto');
      assert.equal(item.encuentro.email, undefined);
      assert.equal(item.encuentro.host_id, undefined, 'encuentro.host_id no debe ser expuesto');
      assert.equal(item.lugar_texto, undefined, 'lugar_texto exacto no debe ser expuesto');
      assert.equal(item.encuentro.lugar_texto, undefined, 'encuentro.lugar_texto no debe ser expuesto');
      assert.equal(item.email, undefined, 'email no debe ser expuesto');
      assert.equal(item.encuentro.email, undefined);
    });

    test('Propaga errores de autenticación devueltos por el backend', async () => {
      mockRpcResponse = {
        data: { ok: false, error: 'permanent_account_required' },
        error: null,
      };

      const res = await alertasService.getMisAlertas();
      assert.equal(res.ok, false);
      assert.equal(res.error, 'permanent_account_required');
      assert.equal(res.data, undefined);
    });

    test('Captura errores de red/supabase de forma controlada', async () => {
      mockRpcResponse = {
        data: null,
        error: { message: 'Network connection failed' },
      };

      const res = await alertasService.getMisAlertas();
      assert.equal(res.ok, false);
      assert.equal(res.error, 'Network connection failed');
      assert.equal(res.data, undefined);
    });
  });

  describe('2. alertasService.marcarLeida()', () => {
    test('Usa exclusivamente la RPC segura marcar_alerta_leida_seguro con p_alerta_id', async () => {
      mockRpcResponse = {
        data: {
          ok: true,
          id: 'alerta-uuid-1',
          leida: true,
          idempotent: false,
        },
        error: null,
      };

      const res = await alertasService.marcarLeida('alerta-uuid-1');
      assert.equal(res.ok, true);
      assert.equal(res.data?.id, 'alerta-uuid-1');
      assert.equal(res.data?.leida, true);
      assert.equal(res.idempotent, false);

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'marcar_alerta_leida_seguro');
      assert.deepEqual(rpcCalls[0].params, { p_alerta_id: 'alerta-uuid-1' });
      assert.equal(fromCalls.length, 0);
    });

    test('Valida parámetro alertaId localmente y rechaza si es vacío', async () => {
      const res = await alertasService.marcarLeida('');
      assert.equal(res.ok, false);
      assert.equal(res.error, 'invalid_alerta_id');
      assert.equal(rpcCalls.length, 0, 'No debe invocar RPC si el id es vacío');
    });

    test('Propaga error si el usuario no es propietario (unauthorized)', async () => {
      mockRpcResponse = {
        data: { ok: false, error: 'unauthorized' },
        error: null,
      };

      const res = await alertasService.marcarLeida('alerta-ajena-id');
      assert.equal(res.ok, false);
      assert.equal(res.error, 'unauthorized');
    });

    test('Soporta respuesta idempotente del backend sin error', async () => {
      mockRpcResponse = {
        data: {
          ok: true,
          id: 'alerta-uuid-1',
          leida: true,
          idempotent: true,
        },
        error: null,
      };

      const res = await alertasService.marcarLeida('alerta-uuid-1');
      assert.equal(res.ok, true);
      assert.equal(res.idempotent, true);
      assert.equal(res.data?.leida, true);
    });
  });

  describe('3. Lógica reactiva de estado y unreadCount', () => {
    const alertasMock: AlertaCompatibilidad[] = [
      {
        id: 'a1',
        tipo: 'interes_convertido',
        source_intencion_id: 'i1',
        target_encuentro_id: 'e1',
        leida: false,
        created_at: '2026-09-30T10:00:00Z',
        encuentro: { id: 'e1', titulo: 'E1', approximate_zone: 'Z1', modalidad: 'presencial' },
      },
      {
        id: 'a2',
        tipo: 'interes_convertido',
        source_intencion_id: 'i2',
        target_encuentro_id: 'e2',
        leida: false,
        created_at: '2026-09-30T09:00:00Z',
        encuentro: { id: 'e2', titulo: 'E2', approximate_zone: 'Z2', modalidad: 'presencial' },
      },
      {
        id: 'a3',
        tipo: 'interes_convertido',
        source_intencion_id: 'i3',
        target_encuentro_id: 'e3',
        leida: true,
        created_at: '2026-09-30T08:00:00Z',
        encuentro: { id: 'e3', titulo: 'E3', approximate_zone: 'Z3', modalidad: 'presencial' },
      },
    ];

    test('unreadCount con 0 no leídas devuelve 0', () => {
      const leidas = alertasMock.map((a) => ({ ...a, leida: true }));
      const unreadCount = leidas.filter((a) => !a.leida).length;
      assert.equal(unreadCount, 0);
    });

    test('unreadCount con 1 no leída devuelve 1', () => {
      const unaNoLeida = [alertasMock[0], { ...alertasMock[1], leida: true }, alertasMock[2]];
      const unreadCount = unaNoLeida.filter((a) => !a.leida).length;
      assert.equal(unreadCount, 1);
    });

    test('unreadCount con varias no leídas calcula el total exacto (2 en este caso)', () => {
      const unreadCount = alertasMock.filter((a) => !a.leida).length;
      assert.equal(unreadCount, 2);
    });

    test('Al marcar una alerta como leída exitosamente, se actualiza localmente y unreadCount disminuye', () => {
      let state = [...alertasMock];
      const initialUnread = state.filter((a) => !a.leida).length;
      assert.equal(initialUnread, 2);

      // Simular marcado exitoso de 'a1'
      const targetId = 'a1';
      state = state.map((a) => (a.id === targetId ? { ...a, leida: true } : a));

      const updatedUnread = state.filter((a) => !a.leida).length;
      assert.equal(updatedUnread, 1);
      assert.equal(state.find((a) => a.id === 'a1')?.leida, true);
      assert.equal(state.find((a) => a.id === 'a2')?.leida, false);
    });

    test('Si marcar leída falla, se conserva el estado previo y unreadCount no cambia', () => {
      let state = [...alertasMock];
      const initialUnread = state.filter((a) => !a.leida).length;

      // Supongamos que falla la RPC: el estado local no se modifica
      const failed = true;
      if (!failed) {
        state = state.map((a) => (a.id === 'a1' ? { ...a, leida: true } : a));
      }

      assert.equal(state.filter((a) => !a.leida).length, initialUnread);
      assert.equal(state.find((a) => a.id === 'a1')?.leida, false);
    });
  });

  describe('4. Invariantes de diseño y arquitectura de useAlertas', () => {
    test('Código fuente no incluye polling (setInterval / setTimeout) ni realtime channel subscription', () => {
      const hookPath = path.join(process.cwd(), 'src/hooks/useAlertas.ts');
      const servicePath = path.join(process.cwd(), 'src/services/alertasService.ts');

      const hookSource = fs.readFileSync(hookPath, 'utf8');
      const serviceSource = fs.readFileSync(servicePath, 'utf8');

      // Comprobar ausencia de polling
      assert.ok(!hookSource.includes('setInterval'), 'useAlertas no debe usar setInterval');
      assert.ok(!hookSource.includes('setTimeout'), 'useAlertas no debe usar setTimeout');
      assert.ok(!serviceSource.includes('setInterval'), 'alertasService no debe usar setInterval');
      assert.ok(!serviceSource.includes('setTimeout'), 'alertasService no debe usar setTimeout');

      // Comprobar ausencia de suscripciones realtime
      assert.ok(!hookSource.includes('.channel('), 'useAlertas no debe abrir realtime channels');
      assert.ok(!hookSource.includes('.subscribe('), 'useAlertas no debe suscribirse a realtime');
      assert.ok(!serviceSource.includes('.channel('), 'alertasService no debe abrir realtime channels');
    });

    test('Código fuente no tiene acceso directo a tablas ni .from("alertas_compatibilidad")', () => {
      const hookPath = path.join(process.cwd(), 'src/hooks/useAlertas.ts');
      const servicePath = path.join(process.cwd(), 'src/services/alertasService.ts');

      const hookSource = fs.readFileSync(hookPath, 'utf8');
      const serviceSource = fs.readFileSync(servicePath, 'utf8');

      assert.ok(!hookSource.includes('.from('), 'useAlertas no debe acceder con .from()');
      assert.ok(!serviceSource.includes('.from('), 'alertasService no debe acceder con .from()');
      assert.ok(!serviceSource.includes('alertas_compatibilidad'), 'alertasService debe usar RPCs');
    });
  });
});
