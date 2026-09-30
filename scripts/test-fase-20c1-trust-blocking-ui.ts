import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

import { supabase } from '../src/lib/supabase';
import { trustService } from '../src/services/trustService';
import { ContextualBlockModal } from '../src/components/trust/ContextualBlockModal';
import { ContextualBlockAction } from '../src/components/trust/ContextualBlockAction';

describe('Fase 2.0-C1 (T3-B): UI Contextual de Bloqueo / Desbloqueo — Frontend Tests', () => {
  let rpcCalls: { fn: string; params: any }[] = [];
  let fromCalls: { table: string }[] = [];

  beforeEach(() => {
    rpcCalls = [];
    fromCalls = [];

    (supabase as any).rpc = async (fn: string, params?: any) => {
      rpcCalls.push({ fn, params });
      if (fn === 'get_estado_bloqueo_desde_solicitud_seguro') {
        return {
          data: { ok: true, blocked_by_me: false },
          error: null,
        };
      }
      if (fn === 'bloquear_desde_solicitud_seguro') {
        return {
          data: { ok: true, accion: 'blocked', estado_solicitud: 'rejected' },
          error: null,
        };
      }
      if (fn === 'desbloquear_desde_solicitud_seguro') {
        return {
          data: { ok: true, accion: 'unblocked' },
          error: null,
        };
      }
      return { data: { ok: true }, error: null };
    };

    (supabase as any).from = (table: string) => {
      fromCalls.push({ table });
      throw new Error(`Acceso directo prohibido a tabla: ${table}`);
    };
  });

  describe('1. Integración en HostOpenEncounterSection', () => {
    test('HostOpenEncounterSection importa y utiliza ContextualBlockAction', () => {
      const sectionPath = path.resolve(
        process.cwd(),
        'src/components/host/HostOpenEncounterSection.tsx'
      );
      const code = fs.readFileSync(sectionPath, 'utf-8');

      assert.ok(
        code.includes("import { ContextualBlockAction } from '@/components/trust/ContextualBlockAction'"),
        'Debe importar ContextualBlockAction'
      );
      assert.ok(
        code.includes('<ContextualBlockAction') && code.includes('variant="compact"'),
        'Debe renderizar ContextualBlockAction con variant="compact" en solicitudes pendientes'
      );
      assert.ok(
        code.includes('<ContextualBlockAction') && code.includes('variant="link"'),
        'Debe renderizar ContextualBlockAction con variant="link" en historial resuelto'
      );
      assert.ok(
        !code.includes('targetUserId') && !code.includes('blocked_user_id'),
        'No debe referenciar ni pasar IDs de usuario destino'
      );
    });
  });

  describe('2. Integración en InviteGuest', () => {
    test('InviteGuest importa y utiliza ContextualBlockAction con validación de cuenta y solicitud', () => {
      const invitePath = path.resolve(
        process.cwd(),
        'src/screens/InviteGuest.tsx'
      );
      const code = fs.readFileSync(invitePath, 'utf-8');

      assert.ok(
        code.includes("import { ContextualBlockAction } from '@/components/trust/ContextualBlockAction'"),
        'InviteGuest debe importar ContextualBlockAction'
      );
      assert.ok(
        code.includes('mySolicitudId') && code.includes('openEncountersService.getMiSolicitud'),
        'Debe consultar la solicitud real del participante autenticado'
      );
      assert.ok(
        code.includes('user.is_anonymous'),
        'Debe verificar que el usuario no sea anónimo para habilitar la acción'
      );
      assert.ok(
        code.includes('<ContextualBlockAction') && code.includes('solicitudId={mySolicitudId}'),
        'Debe renderizar ContextualBlockAction pasando mySolicitudId'
      );
    });
  });

  describe('3. Componente ContextualBlockModal (Render y Textos)', () => {
    test('Renderiza modal de Bloqueo con textos sobrios, neutrales y no acusatorios', () => {
      const html = renderToString(
        React.createElement(ContextualBlockModal, {
          isOpen: true,
          onClose: () => {},
          solicitudId: 'sol-123',
          applicantName: 'Carlos',
          currentBlocked: false,
          onSuccess: () => {},
        })
      );

      assert.ok(
        html.includes('¿Bloquear a'),
        'Debe incluir título sobrio de confirmación de bloqueo'
      );
      assert.ok(
        html.includes('no verán sus respectivas publicaciones') || html.includes('Encuentros Abiertos'),
        'Debe explicar la invisibilidad bilateral en Encuentros Abiertos e Intenciones'
      );
      assert.ok(
        html.includes('no envía ningún reporte') || html.includes('reporte'),
        'Debe aclarar la diferencia respecto de un reporte de moderación'
      );
      assert.ok(
        !html.includes('te bloqueó') && !html.includes('culpable') && !html.includes('denunciado'),
        'No debe contener lenguaje acusatorio ni revelar estado inverso'
      );
    });

    test('Renderiza modal de Desbloqueo explicando que no restaura solicitudes previas', () => {
      const html = renderToString(
        React.createElement(ContextualBlockModal, {
          isOpen: true,
          onClose: () => {},
          solicitudId: 'sol-123',
          targetName: 'Carlos',
          isBlocked: true,
          onSuccess: () => {},
        })
      );

      assert.ok(
        html.includes('¿Desbloquear a'),
        'Debe incluir título sobrio de desbloqueo'
      );
      assert.ok(
        html.includes('volver a interactuar') || html.includes('futuras'),
        'Debe explicar que permite futuras interacciones'
      );
      assert.ok(
        html.includes('no se restauran') || html.includes('restauran'),
        'Debe aclarar que no restauran solicitudes ni intereses anteriores'
      );
    });

    test('No renderiza contenido cuando isOpen es false', () => {
      const html = renderToString(
        React.createElement(ContextualBlockModal, {
          isOpen: false,
          onClose: () => {},
          solicitudId: 'sol-123',
          targetName: 'Carlos',
          isBlocked: false,
          onSuccess: () => {},
        })
      );

      assert.equal(html, '', 'Cuando isOpen es false no debe renderizar nada');
    });
  });

  describe('4. Estilos y Accesibilidad (Touch Target y Roles)', () => {
    test('CSS de ContextualBlockAction garantiza touch targets >= 44x44px', () => {
      const cssPath = path.resolve(
        process.cwd(),
        'src/components/trust/ContextualBlockAction.css'
      );
      const css = fs.readFileSync(cssPath, 'utf-8');

      assert.ok(
        css.includes('min-height: 44px') && css.includes('min-width: 44px'),
        'ContextualBlockAction button debe tener min-height >= 44px y min-width >= 44px'
      );
    });

    test('CSS de ContextualBlockModal garantiza accesibilidad de botones del modal', () => {
      const cssPath = path.resolve(
        process.cwd(),
        'src/components/trust/ContextualBlockModal.css'
      );
      const css = fs.readFileSync(cssPath, 'utf-8');

      assert.ok(
        css.includes('min-height: 44px'),
        'Botones de modal deben tener min-height >= 44px'
      );
    });
  });

  describe('5. Data Layer en trustService (Contratos y Parámetros Seguros)', () => {
    test('getEstadoBloqueoDesdeSolicitud sólo envía p_solicitud_id y maneja respuesta', async () => {
      const res = await trustService.getEstadoBloqueoDesdeSolicitud('sol-abc-123');

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'get_estado_bloqueo_desde_solicitud_seguro');
      assert.deepEqual(rpcCalls[0].params, { p_solicitud_id: 'sol-abc-123' });
      assert.equal(fromCalls.length, 0, 'No debe consultar tablas directamente');
      assert.equal(res.ok, true);
      assert.equal(res.blockedByMe, false);
    });

    test('getEstadoBloqueoDesdeSolicitud falla cerrado (fail-soft) ante solicitudId vacío', async () => {
      const res = await trustService.getEstadoBloqueoDesdeSolicitud('');

      assert.equal(res.ok, false);
      assert.equal(res.blockedByMe, false);
      assert.equal(rpcCalls.length, 0);
    });

    test('bloquearDesdeSolicitud sólo envía p_solicitud_id', async () => {
      const res = await trustService.bloquearDesdeSolicitud('sol-xyz-999');

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'bloquear_desde_solicitud_seguro');
      assert.deepEqual(rpcCalls[0].params, { p_solicitud_id: 'sol-xyz-999' });
      assert.equal(fromCalls.length, 0);
      assert.equal(res.ok, true);
      assert.equal(res.blocked, true);
    });

    test('bloquearDesdeSolicitud falla cerrado ante solicitudId vacío', async () => {
      const res = await trustService.bloquearDesdeSolicitud('');

      assert.equal(res.ok, false);
      assert.equal(rpcCalls.length, 0);
    });

    test('desbloquearDesdeSolicitud sólo envía p_solicitud_id', async () => {
      const res = await trustService.desbloquearDesdeSolicitud('sol-unblock-555');

      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, 'desbloquear_desde_solicitud_seguro');
      assert.deepEqual(rpcCalls[0].params, { p_solicitud_id: 'sol-unblock-555' });
      assert.equal(fromCalls.length, 0);
      assert.equal(res.ok, true);
      assert.equal(res.blocked, false);
    });

    test('desbloquearDesdeSolicitud falla cerrado ante solicitudId vacío', async () => {
      const res = await trustService.desbloquearDesdeSolicitud('');

      assert.equal(res.ok, false);
      assert.equal(rpcCalls.length, 0);
    });
  });
});
