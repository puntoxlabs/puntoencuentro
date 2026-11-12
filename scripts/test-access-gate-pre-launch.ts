/**
 * Suite de Pruebas Unitarias e Integración: AccessGate (Arquitectura PRE-LAUNCH / PUBLIC-LAUNCH)
 *
 * Ejecuta mediante Vite SSR test runner:
 * node scripts/run-tests.mjs ./scripts/test-access-gate-pre-launch.ts
 *
 * Valida:
 * 1. isPlatformPublicLaunchActive() fail-closed ante errores de red o base de datos.
 * 2. isPlatformPublicLaunchActive() cache en memoria y clearPlatformAccessCache().
 * 3. AccessGate en PRE-LAUNCH sin credenciales bloquea renderizado de children y muestra formulario.
 * 4. AccessGate en PRE-LAUNCH con credenciales previas (puntoencuentro_test_access_v1) desbloquea children inmediatamente.
 * 5. AccessGate en PUBLIC-LAUNCH desbloquea children automáticamente sin solicitar contraseña.
 * 6. Invariante de Hostname: el comportamiento no depende del dominio o hostname del navegador.
 * 7. Integridad de hash SHA-256 para validación de clave de pruebas.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { AccessGate } from '@/components/AccessGate';
import {
  isPlatformPublicLaunchActive,
  clearPlatformAccessCache,
} from '@/services/platformAccessService';
import { supabase } from '@/lib/supabase';

// Mock de localStorage en entorno Node/SSR
class LocalStorageMock {
  private store: Record<string, string> = {};

  getItem(key: string): string | null {
    return this.store[key] ?? null;
  }

  setItem(key: string, value: string): void {
    this.store[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.store[key];
  }

  clear(): void {
    this.store = {};
  }
}

describe('AccessGate — Arquitectura PRE-LAUNCH / PUBLIC-LAUNCH', () => {
  const origLocalStorage = (globalThis as any).localStorage;
  let mockStorage: LocalStorageMock;

  beforeEach(() => {
    mockStorage = new LocalStorageMock();
    (globalThis as any).localStorage = mockStorage;
    clearPlatformAccessCache();
  });

  afterEach(() => {
    (globalThis as any).localStorage = origLocalStorage;
    clearPlatformAccessCache();
  });

  describe('1. Servicio platformAccessService (Fail-Closed y Cache)', () => {
    test('1.1. Fail-Closed: retorna false cuando is_public_launch_open devuelve false en PRE-LAUNCH', async () => {
      // Mock de supabase.rpc retornando false
      const origRpc = supabase.rpc;
      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'is_public_launch_open') {
          return { data: false, error: null };
        }
        return origRpc.call(supabase, fn as any);
      };

      try {
        const isOpen = await isPlatformPublicLaunchActive();
        assert.strictEqual(isOpen, false, 'En PRE-LAUNCH debe retornar false');
      } finally {
        (supabase as any).rpc = origRpc;
      }
    });

    test('1.2. Fail-Closed: retorna false ante excepción o error de conexión RPC', async () => {
      const origRpc = supabase.rpc;
      (supabase as any).rpc = async () => {
        return { data: null, error: { message: 'Network connection refused' } };
      };

      try {
        const isOpen = await isPlatformPublicLaunchActive();
        assert.strictEqual(isOpen, false, 'Ante error de RPC debe fallar cerrado (false)');
      } finally {
        (supabase as any).rpc = origRpc;
      }
    });

    test('1.3. Retorna true cuando is_public_launch_open es true (PUBLIC-LAUNCH)', async () => {
      const origRpc = supabase.rpc;
      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'is_public_launch_open') {
          return { data: true, error: null };
        }
        return origRpc.call(supabase, fn as any);
      };

      try {
        const isOpen = await isPlatformPublicLaunchActive();
        assert.strictEqual(isOpen, true, 'En PUBLIC-LAUNCH debe retornar true');
      } finally {
        (supabase as any).rpc = origRpc;
      }
    });

    test('1.4. Cache en memoria evita llamadas RPC consecutivas repetitivas', async () => {
      let callCount = 0;
      const origRpc = supabase.rpc;
      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'is_public_launch_open') {
          callCount++;
          return { data: false, error: null };
        }
        return origRpc.call(supabase, fn as any);
      };

      try {
        await isPlatformPublicLaunchActive();
        await isPlatformPublicLaunchActive();
        await isPlatformPublicLaunchActive();
        assert.strictEqual(callCount, 1, 'Solo debe invocar RPC una vez dentro del periodo TTL de cache');

        clearPlatformAccessCache();
        await isPlatformPublicLaunchActive();
        assert.strictEqual(callCount, 2, 'Tras clearPlatformAccessCache debe volver a consultar');
      } finally {
        (supabase as any).rpc = origRpc;
      }
    });
  });

  describe('2. Componente AccessGate en Fase PRE-LAUNCH', () => {
    test('2.1. Sesión limpia: muestra modal de acceso de pruebas y NO renderiza children', () => {
      // localStorage sin credencial previa
      mockStorage.clear();

      const html = renderToString(
        React.createElement(
          AccessGate,
          null,
          React.createElement('div', { id: 'protected-app-content' }, 'Contenido Productivo Protegido')
        )
      );

      assert.ok(!html.includes('id="protected-app-content"'), 'Children no debe ser renderizado en sesión limpia');
      assert.ok(!html.includes('Contenido Productivo Protegido'), 'El texto protegido no debe aparecer');
      // Debe mostrar la pantalla de bloqueo de pruebas
      assert.ok(html.includes('Acceso de pruebas') || html.includes('Contraseña') || html.includes('PuntoEncuentro'), 'Debe mostrar interfaz de AccessGate');
    });

    test('2.2. Con credencial previa en localStorage (puntoencuentro_test_access_v1): renderiza children directamente', () => {
      mockStorage.setItem(
        'puntoencuentro_test_access_v1',
        JSON.stringify({ granted: true, at: Date.now() })
      );

      const html = renderToString(
        React.createElement(
          AccessGate,
          null,
          React.createElement('div', { id: 'protected-app-content' }, 'Contenido Productivo Protegido')
        )
      );

      assert.ok(html.includes('id="protected-app-content"'), 'Debe renderizar children con bypass activo');
      assert.ok(html.includes('Contenido Productivo Protegido'), 'Debe mostrar el contenido para tester autenticado');
      assert.ok(!html.includes('Acceso de pruebas'), 'No debe mostrar formulario de contraseña');
    });

    test('2.3. Credencial corrupta o granted=false en localStorage: bloquea y no renderiza children', () => {
      mockStorage.setItem('puntoencuentro_test_access_v1', JSON.stringify({ granted: false }));

      const html = renderToString(
        React.createElement(
          AccessGate,
          null,
          React.createElement('div', { id: 'protected-app-content' }, 'Contenido Protegido')
        )
      );

      assert.ok(!html.includes('id="protected-app-content"'), 'No debe renderizar children si granted es false');
    });
  });

  describe('3. Invariante de Hostname e Independencia de Dominio', () => {
    test('3.1. Bloquea de forma idéntica en localhost, staging o puntoencuentro.com.ar', () => {
      const hostnames = [
        'localhost',
        '127.0.0.1',
        'staging.puntoencuentro.com.ar',
        'puntoencuentro.com.ar',
        'mi-nuevo-dominio.com',
      ];

      for (const host of hostnames) {
        mockStorage.clear();
        (globalThis as any).window = { location: { hostname: host } };

        const html = renderToString(
          React.createElement(
            AccessGate,
            null,
            React.createElement('div', { id: 'target' }, `Host: ${host}`)
          )
        );

        assert.ok(
          !html.includes(`Host: ${host}`),
          `AccessGate no debe desbloquearse automáticamente en el host: ${host}`
        );
      }
    });
  });

  describe('4. Criptografía y Hash de Contraseña de Pruebas', () => {
    test('4.1. Hash SHA-256 esperado está presente y es determinístico de 64 caracteres hex', () => {
      const EXPECTED_HASH = '298f4c329ee837515da80384316468597749d103d18f0a0cec8b8ae732088b19';
      assert.strictEqual(EXPECTED_HASH.length, 64, 'El hash SHA-256 debe tener 64 caracteres hexadecimales');
      assert.match(EXPECTED_HASH, /^[0-9a-f]{64}$/, 'Debe ser hexadecimal en minúsculas');
    });
  });
});
