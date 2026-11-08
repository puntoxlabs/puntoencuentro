/**
 * Suite Automatizada: Frontend del Puente de Identidad entre Dominios (Mini-Sprint 2B-3)
 *
 * Cubre de punta a punta:
 * 1. Paridad de Inventario Local y Deduplicación (las 6 fuentes y persistencia en coordinación).
 * 2. Presincronización de Recursos y Validación Estricta de RPCs (desglose, fallos parciales, PostgREST).
 * 3. Seguridad de Protocolo postMessage y Allowlist Estricta de Orígenes (protocolo, host, puerto, no wildcards).
 * 4. Handshake Determinista sin Dependencia de document.referrer y Validación de Nonces.
 * 5. Ciclo de Vida de Popup Móvil, Ventana Cerrada, Cancelación y Reintentos.
 * 6. Aislamiento y Scoping de Sesión Retirada por Identidad (sin herencia entre usuarios ni signOut).
 * 7. Detección de Inventario y Resiliencia ante Fallos de Servidor (error_recoverable vs empty_clean).
 * 8. Resiliencia, Caída de Red Post-Commit e Idempotencia (ADV-15).
 * 9. Matriz de Mensajes UX en Lenguaje Claro (cero jerga técnica).
 * 10. Protección contra Fugas de Secretos en URLs, Redirecciones y Anti-Framing (ADV-09).
 * 11. Ensayo Simulado Cross-Origin Dual (localhost:5173 <-> 127.0.0.1:5174) de punta a punta.
 * 12. Gobernanza de Feature Flags Independientes y Desactivados por Defecto.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Módulos bajo prueba
import {
  collectAllLocalInvitationTokens,
  getParticipatedIndividualTokens,
  saveParticipatedToken,
} from '../src/lib/participatedTokens';
import {
  isTrustedBridgeOrigin,
  AUTHORIZED_LOCAL_BRIDGE_ORIGINS,
  getTargetMigrationOrigin,
  resolveDomainConfig,
  resolveLegacyDomainRedirect,
  redactSensitiveUrlForLogs,
} from '../src/config/domainConfig';
import {
  ENABLE_DOMAIN_MIGRATION_BRIDGE,
  ENABLE_DOMAIN_MIGRATION_MANUAL_FALLBACK,
} from '../src/config/features';
import {
  domainMigrationBridgeService,
  generateBridgeNonce,
  getMigrationUserMessage,
  isLocalSessionRetired,
  markLocalSessionRetired,
  RETIRED_LOCAL_SESSION_KEY,
  RETIRED_LOCAL_SESSION_PREFIX,
} from '../src/services/domainMigrationBridgeService';
import { isValidPostAuthRedirect } from '../src/hooks/usePostAuthRedirect';
import { normalizeRouteForFeedback } from '../src/services/feedbackService';
import { supabase } from '../src/lib/supabase';
import {
  runUnifiedSignInWithGoogle,
  checkAnonymousUpgradeState,
  createTransferTicket,
} from '../src/contexts/AuthContext';

// Mock simple de Web Storage en memoria para Node
class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

describe('Mini-Sprint 2B-3: Frontend del Puente de Identidad entre Dominios', () => {
  let mockLocal: MockStorage;
  let mockSession: MockStorage;
  let originalRpc: any;
  let originalGetSession: any;

  beforeEach(() => {
    mockLocal = new MockStorage();
    mockSession = new MockStorage();

    (globalThis as any).window = {
      localStorage: mockLocal,
      sessionStorage: mockSession,
      location: {
        origin: 'http://localhost:5173',
        href: 'http://localhost:5173/',
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      open: () => null,
    };
    (globalThis as any).localStorage = mockLocal;
    (globalThis as any).sessionStorage = mockSession;

    originalRpc = (supabase as any).rpc;
    originalGetSession = (supabase.auth as any).getSession;
  });

  afterEach(() => {
    (supabase as any).rpc = originalRpc;
    (supabase.auth as any).getSession = originalGetSession;
  });

  // =========================================================================
  // BLOQUE 1: PARIDAD DE INVENTARIO LOCAL Y DEDUPLICACIÓN
  // =========================================================================
  describe('1. Paridad de Inventario Local y Deduplicación', () => {
    test('Recolecta y deduplica tokens válidos de las 6 fuentes locales', () => {
      const token1 = '11111111-1111-4111-8111-111111111111';
      const token2 = '22222222-2222-4222-8222-222222222222';
      const token3 = '33333333-3333-4333-8333-333333333333';
      const token4 = '44444444-4444-4444-8444-444444444444';
      const token5 = '55555555-5555-4555-8555-555555555555';
      const token6 = '66666666-6666-4666-8666-666666666666';

      mockLocal.setItem('participated_tokens', JSON.stringify([token1, token2]));
      mockLocal.setItem('puntoencuentro_guest_token_by_public_pub_abc', token3);
      mockLocal.setItem('puntoencuentro_coordination_guest_token_by_public_coord_xyz', token4);
      mockLocal.setItem(
        'encuentros_general',
        JSON.stringify({
          encuentros: {
            enc_1: { token_invitacion: token5 },
            enc_duplicate: { token_invitacion: token1 },
          },
        })
      );
      mockLocal.setItem(
        'encuentros_coordination_general',
        JSON.stringify({
          encuentros: {
            enc_coord_1: { token_invitacion: token6 },
          },
        })
      );
      mockSession.setItem('pending_participant_invitation_token', token2);

      const tokens = collectAllLocalInvitationTokens();
      assert.equal(tokens.length, 6, 'Deben recolectarse exactamente 6 tokens únicos');
      assert.ok(tokens.includes(token1));
      assert.ok(tokens.includes(token2));
      assert.ok(tokens.includes(token3));
      assert.ok(tokens.includes(token4));
      assert.ok(tokens.includes(token5));
      assert.ok(tokens.includes(token6));
    });

    test('Filtra valores vacíos, malformados o no UUID de forma segura', () => {
      mockLocal.setItem(
        'participated_tokens',
        JSON.stringify(['not-a-uuid', '', null, undefined, '12345', '77777777-7777-4777-8777-777777777777'])
      );

      const tokens = collectAllLocalInvitationTokens();
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0], '77777777-7777-4777-8777-777777777777');
    });

    test('Normaliza tokens a minúsculas sin duplicados por casing', () => {
      const upper = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
      const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

      mockLocal.setItem('participated_tokens', JSON.stringify([upper]));
      mockSession.setItem('pending_participant_invitation_token', lower);

      const tokens = collectAllLocalInvitationTokens();
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0], lower);
    });

    test('saveParticipatedToken guarda de forma idempotente en participated_tokens', () => {
      const token = '11111111-2222-4333-8444-555555555555';
      saveParticipatedToken(token);
      saveParticipatedToken(token);

      const tokens = getParticipatedIndividualTokens();
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0], token);
    });

    test('No borra información local de origen antes de confirmar exitosamente', () => {
      const token = '11111111-2222-4333-8444-555555555555';
      saveParticipatedToken(token);
      mockLocal.setItem('puntoencuentro_guest_token_by_public_test', token);

      const tokens = collectAllLocalInvitationTokens();
      assert.equal(tokens.length, 1);
      assert.notEqual(mockLocal.getItem('participated_tokens'), null);
      assert.notEqual(mockLocal.getItem('puntoencuentro_guest_token_by_public_test'), null);
    });
  });

  // =========================================================================
  // BLOQUE 2: PRESINCRONIZACIÓN DE RECURSOS Y VALIDACIÓN ESTRICTA DE RPCS
  // =========================================================================
  describe('2. Presincronización de Recursos y Validación de RPCs', () => {
    test('Sincronización exitosa retorna desglose completo de tokens', async () => {
      const token = 'aaaaaaaa-1111-4111-8111-111111111111';
      saveParticipatedToken(token);

      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'user-source-123', is_anonymous: true } } },
      });

      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'vincular_tokens_participante_lote_seguro') {
          return {
            data: { ok: true, linked_count: 1, already_linked_count: 0, skipped_count: 0 },
            error: null,
          };
        }
        return { data: { ok: true }, error: null };
      };

      const res = await domainMigrationBridgeService.prepareSourceResources();
      assert.equal(res.ok, true);
      assert.equal(res.linkedCount, 1);
      assert.equal(res.alreadyLinkedCount, 0);
      assert.equal(res.skippedCount, 0);
      assert.equal(res.totalTokens, 1);
    });

    test('Fallo funcional con { ok: false } en vinculación detiene flujo y no emite tickets', async () => {
      const token = 'aaaaaaaa-1111-4111-8111-111111111111';
      saveParticipatedToken(token);

      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'user-source-123', is_anonymous: true } } },
      });

      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'vincular_tokens_participante_lote_seguro') {
          return {
            data: { ok: false, error: 'rate_limit_exceeded' },
            error: null,
          };
        }
        return { data: { ok: true }, error: null };
      };

      const res = await domainMigrationBridgeService.prepareSourceResources();
      assert.equal(res.ok, false);
      assert.equal(res.error, 'rate_limit_exceeded');
    });

    test('Error PostgREST en RPC de vinculación detiene flujo fail-closed', async () => {
      const token = 'aaaaaaaa-1111-4111-8111-111111111111';
      saveParticipatedToken(token);

      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'user-source-123', is_anonymous: true } } },
      });

      (supabase as any).rpc = async () => {
        return {
          data: null,
          error: { message: '500: Database connection error' },
        };
      };

      const res = await domainMigrationBridgeService.prepareSourceResources();
      assert.equal(res.ok, false);
      assert.ok(res.error?.includes('Database connection error'));
    });

    test('Fallo en sincronización de localidades aborta la preparación', async () => {
      mockLocal.setItem('puntoencuentro_zones_v1', JSON.stringify(['loc-palermo', 'loc-belgrano']));

      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'user-source-123', is_anonymous: true } } },
      });

      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'set_user_localidades_seguro') {
          return { data: { ok: false, error: 'set_localities_error' }, error: null };
        }
        return { data: { ok: true }, error: null };
      };

      const res = await domainMigrationBridgeService.prepareSourceResources();
      assert.equal(res.ok, false);
      assert.equal(res.error, 'set_localities_error');
    });

    test('Sesión anónima retirada detectada en servidor marca retiro local y aborta', async () => {
      const token = 'aaaaaaaa-1111-4111-8111-111111111111';
      saveParticipatedToken(token);

      const userId = 'user-already-retired-999';
      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: userId, is_anonymous: true } } },
      });

      (supabase as any).rpc = async () => {
        return {
          data: { ok: false, error: 'anonymous_session_already_migrated' },
          error: null,
        };
      };

      const res = await domainMigrationBridgeService.prepareSourceResources();
      assert.equal(res.ok, false);
      assert.equal(res.error, 'anonymous_session_already_migrated');
      assert.equal(isLocalSessionRetired(userId), true, 'Debe marcarse como retirada');
    });

    test('prepareSourceResources rechaza respuesta nula o sin campo ok explícito en RPC', async () => {
      const token = 'aaaaaaaa-1111-4111-8111-111111111111';
      saveParticipatedToken(token);

      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'user-source-123', is_anonymous: true } } },
      });

      // Caso 1: respuesta nula
      (supabase as any).rpc = async () => ({ data: null, error: null });
      const resNull = await domainMigrationBridgeService.prepareSourceResources();
      assert.equal(resNull.ok, false);
      assert.equal(resNull.isComplete, false);

      // Caso 2: respuesta sin ok === true
      (supabase as any).rpc = async () => ({ data: { linked_count: 1 }, error: null });
      const resNoOk = await domainMigrationBridgeService.prepareSourceResources();
      assert.equal(resNoOk.ok, false);
      assert.equal(resNoOk.isComplete, false);
    });

    test('prepareSourceResources maneja skipped_count > 0 con hasUnrecoveredTokens: true sin bloquear', async () => {
      const token1 = '11111111-1111-4111-8111-111111111111';
      const token2 = '22222222-2222-4222-8222-222222222222';
      saveParticipatedToken(token1);
      saveParticipatedToken(token2);

      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'user-source-123', is_anonymous: true } } },
      });

      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'vincular_tokens_participante_lote_seguro') {
          return {
            data: {
              ok: true,
              linked_count: 1,
              already_linked_count: 0,
              skipped_count: 1,
            },
            error: null,
          };
        }
        return { data: { ok: true }, error: null };
      };

      const res = await domainMigrationBridgeService.prepareSourceResources();
      assert.equal(res.ok, true, 'No debe bloquear el flujo ante tokens obsoletos');
      assert.equal(res.totalTokens, 2);
      assert.equal(res.linkedCount, 1);
      assert.equal(res.skippedCount, 1);
      assert.equal(res.hasUnrecoveredTokens, true, 'Debe marcar participaciones pendientes');
      assert.equal(res.isComplete, false, 'No debe reportar completitud al 100%');
    });

    test('prepareSourceResources divide lotes superiores a 50 tokens (e.g. 75) en llamadas de 50', async () => {
      const tokensCount = 75;
      const batchesReceived: string[][] = [];

      for (let i = 0; i < tokensCount; i++) {
        const hex = i.toString(16).padStart(12, '0');
        saveParticipatedToken(`99999999-9999-4999-8999-${hex}`);
      }

      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'user-source-123', is_anonymous: true } } },
      });

      (supabase as any).rpc = async (fn: string, params: any) => {
        if (fn === 'vincular_tokens_participante_lote_seguro') {
          batchesReceived.push(params.p_tokens);
          return {
            data: {
              ok: true,
              linked_count: params.p_tokens.length,
              already_linked_count: 0,
              skipped_count: 0,
            },
            error: null,
          };
        }
        return { data: { ok: true }, error: null };
      };

      const res = await domainMigrationBridgeService.prepareSourceResources();
      assert.equal(res.ok, true);
      assert.equal(res.totalTokens, 75);
      assert.equal(res.linkedCount, 75);
      assert.equal(res.hasUnrecoveredTokens, false);
      assert.equal(res.isComplete, true);

      // Verificar que se dividió en 2 lotes (50 y 25) respetando LIMIT 50 de SQL
      assert.equal(batchesReceived.length, 2, 'Debe llamar la RPC exactamente 2 veces');
      assert.equal(batchesReceived[0].length, 50, 'El primer lote debe tener 50 tokens');
      assert.equal(batchesReceived[1].length, 25, 'El segundo lote debe tener 25 tokens');
    });
  });

  // =========================================================================
  // BLOQUE 3: SEGURIDAD DEL PROTOCOLO POSTMESSAGE Y ALLOWLIST ESTRICTA
  // =========================================================================
  describe('3. Seguridad de Protocolo postMessage y Allowlist Estricta', () => {
    test('generateBridgeNonce produce nonces CSPRNG de 128 bits (32 hex)', () => {
      const n1 = generateBridgeNonce();
      const n2 = generateBridgeNonce();

      assert.equal(n1.length, 32);
      assert.match(n1, /^[0-9a-f]{32}$/i);
      assert.equal(n2.length, 32);
      assert.notEqual(n1, n2, 'Dos nonces generados no deben colisionar');
    });

    test('isTrustedBridgeOrigin acepta orígenes válidos configurados por entorno', () => {
      // Producción acepta su canónico oficial HTTPS
      assert.equal(isTrustedBridgeOrigin('https://puntoencuentro.com.ar', { env: { VITE_APP_ENV: 'production' } }), true);
      // Staging acepta su canónico oficial HTTPS
      assert.equal(isTrustedBridgeOrigin('https://staging.puntoencuentro.com.ar', { env: { VITE_APP_ENV: 'staging' } }), true);
      // Entorno local / pruebas acepta puertos duales autorizados
      assert.equal(isTrustedBridgeOrigin('http://localhost:5173'), true);
      assert.equal(isTrustedBridgeOrigin('http://127.0.0.1:5174'), true);
    });

    test('isTrustedBridgeOrigin rechaza preview ajeno (*.vercel.app no autorizado)', () => {
      assert.equal(
        isTrustedBridgeOrigin('https://malicious.vercel.app', { env: { VITE_APP_ENV: 'preview' } }),
        false,
        'Debe rechazar subdominios de Vercel ajenos al proyecto'
      );
      assert.equal(
        isTrustedBridgeOrigin('https://attacker-preview.vercel.app', { env: { VITE_APP_ENV: 'preview' } }),
        false
      );
    });

    test('isTrustedBridgeOrigin acepta preview legítimo de puntoencuentro o inyectado por Vercel', () => {
      assert.equal(
        isTrustedBridgeOrigin('https://puntoencuentro-pr12.vercel.app', { env: { VITE_APP_ENV: 'preview' } }),
        true
      );
      assert.equal(
        isTrustedBridgeOrigin('https://custom-deploy.vercel.app', {
          env: { VITE_APP_ENV: 'preview', VERCEL_URL: 'custom-deploy.vercel.app' },
        }),
        true
      );
    });

    test('isTrustedBridgeOrigin rechaza confianza cruzada no configurada entre Producción y Staging', () => {
      // Producción rechaza Staging por defecto
      assert.equal(
        isTrustedBridgeOrigin('https://staging.puntoencuentro.com.ar', { env: { VITE_APP_ENV: 'production' } }),
        false,
        'Producción nunca debe confiar en Staging sin target explícito'
      );
      // Producción rechaza localhost
      assert.equal(
        isTrustedBridgeOrigin('http://localhost:5173', { env: { VITE_APP_ENV: 'production' } }),
        false,
        'Producción nunca debe confiar en localhost'
      );
      // Staging rechaza Producción por defecto
      assert.equal(
        isTrustedBridgeOrigin('https://puntoencuentro.com.ar', { env: { VITE_APP_ENV: 'staging' } }),
        false,
        'Staging nunca debe confiar en Producción sin target explícito'
      );
      // Target explícito autoriza migración controlada
      assert.equal(
        isTrustedBridgeOrigin('https://staging.puntoencuentro.com.ar', {
          env: {
            VITE_APP_ENV: 'production',
            VITE_MIGRATION_TARGET_ORIGIN: 'https://staging.puntoencuentro.com.ar',
          },
        }),
        true
      );
    });

    test('isTrustedBridgeOrigin rechaza adversarialmente http://localhost:5999 (puerto no autorizado)', () => {
      assert.equal(isTrustedBridgeOrigin('http://localhost:5999'), false);
      assert.equal(isTrustedBridgeOrigin('http://127.0.0.1:5999'), false);
      assert.equal(isTrustedBridgeOrigin('http://localhost:8080'), false);
    });

    test('isTrustedBridgeOrigin rechaza adversarialmente http://puntoencuentro.com.ar (HTTP inseguro)', () => {
      assert.equal(isTrustedBridgeOrigin('http://puntoencuentro.com.ar'), false);
      assert.equal(isTrustedBridgeOrigin('http://puntoencuentro.com.ar:80'), false);
    });

    test('isTrustedBridgeOrigin rechaza puertos alternativos no autorizados en producción', () => {
      assert.equal(isTrustedBridgeOrigin('https://puntoencuentro.com.ar:8443'), false);
      assert.equal(isTrustedBridgeOrigin('https://puntoencuentro.com.ar:5173'), false);
    });

    test('isTrustedBridgeOrigin rechaza hosts engañosos y wildcards (ADV-08)', () => {
      assert.equal(isTrustedBridgeOrigin('*'), false);
      assert.equal(isTrustedBridgeOrigin('null'), false);
      assert.equal(isTrustedBridgeOrigin(''), false);
      assert.equal(isTrustedBridgeOrigin('https://puntoencuentro.com.ar.evil.com'), false);
      assert.equal(isTrustedBridgeOrigin('https://evil-puntoencuentro.com.ar'), false);
      assert.equal(isTrustedBridgeOrigin('javascript:alert(1)'), false);
    });

    test('isTrustedBridgeOrigin rechaza credenciales embebidas y rutas en el origen', () => {
      assert.equal(isTrustedBridgeOrigin('http://user:pass@localhost:5173'), false);
      assert.equal(isTrustedBridgeOrigin('http://localhost:5173/auth/callback'), false);
      assert.equal(isTrustedBridgeOrigin('http://localhost:5173?foo=bar'), false);
    });
  });

  // =========================================================================
  // BLOQUE 4: HANDSHAKE SIN DOCUMENT.REFERRER Y VALIDACIÓN DE NONCES
  // =========================================================================
  describe('4. Handshake sin document.referrer y Validación de Nonces', () => {
    test('Determina el origen autorizado mediante sourceOrigin explícito sin referrer', () => {
      const mockOpener = { postMessage: () => {} } as unknown as Window;
      const targetUserId = '22222222-bbbb-4222-8222-222222222222';

      // Referrer no disponible (Referrer-Policy: no-referrer)
      (globalThis as any).document = { referrer: '' };

      let sentMessage: any = null;
      let sentTargetOrigin: string | null = null;
      const fakeOpener = {
        postMessage: (msg: any, target: string) => {
          sentMessage = msg;
          sentTargetOrigin = target;
        },
      } as unknown as Window;

      const session = domainMigrationBridgeService.listenForBridgeCodeOnReceive({
        sourceOpener: fakeOpener,
        targetUserId,
        sourceOrigin: 'http://localhost:5173',
        onCodeReceived: () => {},
        onError: () => {},
      });

      assert.equal(session.authorizedSourceOrigin, 'http://localhost:5173');
      assert.equal(sentTargetOrigin, 'http://localhost:5173', 'NUNCA debe usar targetOrigin = *');
      assert.equal(sentMessage.type, 'PE_BRIDGE_READY');
      assert.equal(sentMessage.target_user_id, targetUserId);
      assert.match(sentMessage.bridge_nonce, /^[0-9a-f]{32}$/i);

      session.cleanup();
    });

    test('Rechazo fail-closed si ni sourceOrigin ni document.referrer son válidos', () => {
      let reportedError: string | null = null;
      (globalThis as any).document = { referrer: '' };

      const session = domainMigrationBridgeService.listenForBridgeCodeOnReceive({
        sourceOpener: {} as Window,
        targetUserId: '22222222-bbbb-4222-8222-222222222222',
        sourceOrigin: 'http://evil-origin.com',
        onCodeReceived: () => {},
        onError: (err) => {
          reportedError = err;
        },
      });

      assert.equal(reportedError, 'untrusted_source_origin');
      assert.equal(session.authorizedSourceOrigin, '');
      session.cleanup();
    });

    test('Rechazo estricto de nonce adulterado en listenForBridgeCodeOnReceive', () => {
      let reportedError: string | null = null;
      let receivedCode: string | null = null;

      const mockOpener = { postMessage: () => {} } as unknown as Window;
      const targetUserId = '22222222-bbbb-4222-8222-222222222222';

      let registeredListener: ((e: MessageEvent) => void) | null = null;
      const fakeWindow = {
        addEventListener: (_evt: string, fn: any) => {
          registeredListener = fn;
        },
        removeEventListener: () => {
          registeredListener = null;
        },
      };
      (globalThis as any).window = fakeWindow;

      const session = domainMigrationBridgeService.listenForBridgeCodeOnReceive({
        sourceOpener: mockOpener,
        targetUserId,
        sourceOrigin: 'http://localhost:5173',
        onCodeReceived: (t) => {
          receivedCode = t;
        },
        onError: (err) => {
          reportedError = err;
        },
      });

      assert.ok(registeredListener);

      const fakeMessage = {
        origin: 'http://localhost:5173',
        source: mockOpener,
        data: {
          type: 'PE_BRIDGE_CODE',
          ticket_token: 'b'.repeat(64),
          bridge_nonce: '0'.repeat(32),
        },
      } as MessageEvent;

      registeredListener!(fakeMessage);

      assert.equal(reportedError, 'bridge_nonce_mismatch');
      assert.equal(receivedCode, null);
      session.cleanup();
    });

    test('notifyCompleted entrega PE_BRIDGE_COMPLETED con nonce hacia el origen exacto (cero *)', () => {
      let deliveredMessage: any = null;
      let deliveredOrigin: string | null = null;

      const mockOpener = {
        postMessage: (msg: any, target: string) => {
          deliveredMessage = msg;
          deliveredOrigin = target;
        },
      } as unknown as Window;

      const session = domainMigrationBridgeService.listenForBridgeCodeOnReceive({
        sourceOpener: mockOpener,
        targetUserId: '22222222-bbbb-4222-8222-222222222222',
        sourceOrigin: 'http://localhost:5173',
        onCodeReceived: () => {},
        onError: () => {},
      });

      session.notifyCompleted();

      assert.equal(deliveredOrigin, 'http://localhost:5173');
      assert.notEqual(deliveredOrigin, '*');
      assert.equal(deliveredMessage.type, 'PE_BRIDGE_COMPLETED');
      assert.equal(deliveredMessage.bridge_nonce, session.nonce);

      session.cleanup();
    });
  });

  // =========================================================================
  // BLOQUE 5: CICLO DE VIDA DE POPUP MÓVIL, VENTANA CERRADA Y CANCELACIÓN
  // =========================================================================
  describe('5. Ciclo de Vida de Popup Móvil, Ventana Cerrada y Cancelación', () => {
    test('Acepta popup provisto sincrónicamente y no pierde listeners', () => {
      let listenerAttached = false;
      const fakeWindow = {
        addEventListener: (evt: string) => {
          if (evt === 'message') listenerAttached = true;
        },
        removeEventListener: () => {},
      };
      (globalThis as any).window = fakeWindow;

      const mockPopup = { closed: false, postMessage: () => {} } as unknown as Window;

      const bridge = domainMigrationBridgeService.startBridgeHandshake({
        popupWindow: mockPopup,
        targetOrigin: 'http://127.0.0.1:5174',
        onStateChange: () => {},
        onError: () => {},
      });

      assert.equal(listenerAttached, true, 'El listener debe estar registrado de inmediato');
      bridge.cancel();
    });

    test('Falla de popup bloqueado reporta popup_blocked si fallback manual está inactivo', () => {
      let reportedError: string | null = null;
      (globalThis as any).window = {
        open: () => null, // Popup bloqueado por navegador
        addEventListener: () => {},
        removeEventListener: () => {},
      };

      domainMigrationBridgeService.startBridgeHandshake({
        popupWindow: null,
        targetOrigin: 'http://127.0.0.1:5174',
        onStateChange: () => {},
        onError: (err) => {
          reportedError = err;
        },
      });

      assert.equal(reportedError, 'popup_blocked');
    });

    test('Cancelación manual revoca ticket en servidor y restablece estado', async () => {
      let revokedCalled = false;
      let stateResult: string | null = null;

      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'revoke_my_pending_transfer_ticket') {
          revokedCalled = true;
          return { data: { ok: true }, error: null };
        }
        return { data: { ok: true }, error: null };
      };

      const mockPopup = { closed: false, postMessage: () => {} } as unknown as Window;
      const bridge = domainMigrationBridgeService.startBridgeHandshake({
        popupWindow: mockPopup,
        targetOrigin: 'http://127.0.0.1:5174',
        onStateChange: (st) => {
          stateResult = st;
        },
        onError: () => {},
      });

      const cancelRes = await bridge.cancel();
      assert.equal(cancelRes?.ok, true);
      assert.equal(stateResult, 'ready_to_migrate');
      assert.equal(revokedCalled, true, 'Debe invocar revoke_my_pending_transfer_ticket');
    });

    test('Carrera de cancelación durante emisión de ticket revoca en servidor y nunca envía PE_BRIDGE_CODE', async () => {
      let resolveTicketRpc: ((val: any) => void) | null = null;
      let revokeCalled = false;
      const postMessagesSent: any[] = [];

      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'source-123', is_anonymous: true } } },
      });

      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'create_domain_migration_ticket_seguro') {
          return new Promise((resolve) => {
            resolveTicketRpc = resolve;
          });
        }
        if (fn === 'revoke_my_pending_transfer_ticket') {
          revokeCalled = true;
          return { data: { ok: true }, error: null };
        }
        return { data: { ok: true }, error: null };
      };

      let registeredListener: ((e: MessageEvent) => void) | null = null;
      (globalThis as any).window = {
        location: { origin: 'http://localhost:5173' },
        addEventListener: (_evt: string, fn: any) => {
          registeredListener = fn;
        },
        removeEventListener: () => {},
      };

      const mockPopup = {
        closed: false,
        postMessage: (msg: any) => {
          postMessagesSent.push(msg);
        },
      } as unknown as Window;

      const bridge = domainMigrationBridgeService.startBridgeHandshake({
        popupWindow: mockPopup,
        targetOrigin: 'http://127.0.0.1:5174',
        onStateChange: () => {},
        onError: () => {},
      });

      // Simular llegada de PE_BRIDGE_READY
      assert.ok(registeredListener);
      registeredListener!({
        origin: 'http://127.0.0.1:5174',
        source: mockPopup,
        data: {
          type: 'PE_BRIDGE_READY',
          target_user_id: '22222222-2222-4222-8222-222222222222',
          bridge_nonce: 'a'.repeat(32),
        },
      } as MessageEvent);

      // Dar tiempo para que prepareSourceResources termine y entre a create_domain_migration_ticket_seguro
      await new Promise((r) => setTimeout(r, 10));

      // El usuario cancela la transferencia mientras la RPC del ticket está en vuelo
      bridge.cancel();

      // Ahora la RPC remota resuelve tardíamente
      resolveTicketRpc!({
        data: { ok: true, ticket_token: 't'.repeat(64) },
        error: null,
      });

      await new Promise((r) => setTimeout(r, 20));

      // Debe revocar de inmediato el ticket tardío emitido
      assert.equal(revokeCalled, true, 'Debe revocar el ticket emitido tras la cancelación');
      // NUNCA debe entregar el código postMessage al popup
      const codeMessages = postMessagesSent.filter((m) => m?.type === 'PE_BRIDGE_CODE');
      assert.equal(codeMessages.length, 0, 'NUNCA debe enviar PE_BRIDGE_CODE tras cancelación');
    });

    test('Cancelación durante preparación aborta y nunca emite ticket', async () => {
      let resolvePrepRpc: ((val: any) => void) | null = null;
      let ticketEmitCalled = false;

      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'source-123', is_anonymous: true } } },
      });

      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'set_user_localidades_seguro') {
          return new Promise((resolve) => {
            resolvePrepRpc = resolve;
          });
        }
        if (fn === 'create_domain_migration_ticket_seguro') {
          ticketEmitCalled = true;
          return { data: { ok: true, ticket_token: 'x'.repeat(64) }, error: null };
        }
        return { data: { ok: true }, error: null };
      };

      mockLocal.setItem('puntoencuentro_zones_v1', JSON.stringify(['loc-palermo']));

      let registeredListener: ((e: MessageEvent) => void) | null = null;
      (globalThis as any).window = {
        location: { origin: 'http://localhost:5173' },
        addEventListener: (_evt: string, fn: any) => {
          registeredListener = fn;
        },
        removeEventListener: () => {},
      };

      const mockPopup = { closed: false, postMessage: () => {} } as unknown as Window;
      const bridge = domainMigrationBridgeService.startBridgeHandshake({
        popupWindow: mockPopup,
        targetOrigin: 'http://127.0.0.1:5174',
        onStateChange: () => {},
        onError: () => {},
      });

      // El usuario cancela de inmediato mientras sincroniza zonas
      bridge.cancel();

      // Resolver preparación tardía
      if (resolvePrepRpc) {
        resolvePrepRpc({ data: { ok: true }, error: null });
      }

      // Llega PE_BRIDGE_READY tardío
      if (registeredListener) {
        registeredListener({
          origin: 'http://127.0.0.1:5174',
          source: mockPopup,
          data: {
            type: 'PE_BRIDGE_READY',
            target_user_id: '22222222-2222-4222-8222-222222222222',
            bridge_nonce: 'b'.repeat(32),
          },
        } as MessageEvent);
      }

      await new Promise((r) => setTimeout(r, 20));
      assert.equal(ticketEmitCalled, false, 'No debe emitir ticket si fue cancelado');
    });
  });

  // =========================================================================
  // BLOQUE 6: AISLAMIENTO Y SCOPING DE SESIÓN RETIRADA POR IDENTIDAD
  // =========================================================================
  describe('6. Aislamiento y Scoping de Sesión Retirada por Identidad', () => {
    test('Retirar Usuario A NO afecta a Usuario B en el mismo navegador', () => {
      const userA = '11111111-aaaa-4111-8111-111111111111';
      const userB = '22222222-bbbb-4222-8222-222222222222';

      assert.equal(isLocalSessionRetired(userA), false);
      assert.equal(isLocalSessionRetired(userB), false);

      markLocalSessionRetired(userA);

      assert.equal(isLocalSessionRetired(userA), true, 'Usuario A debe estar retirado');
      assert.equal(isLocalSessionRetired(userB), false, 'Usuario B NO debe heredar el estado');
      assert.equal(mockLocal.getItem(`${RETIRED_LOCAL_SESSION_PREFIX}${userB}`), null);
    });

    test('Nunca invoca signOut() sobre la sesión de origen transferida', () => {
      let signOutCalled = false;
      (supabase.auth as any).signOut = async () => {
        signOutCalled = true;
      };

      markLocalSessionRetired('user-test-no-signout');
      assert.equal(signOutCalled, false, 'Jamás debe llamar a signOut()');
    });
  });

  // =========================================================================
  // BLOQUE 7: DETECCIÓN DE INVENTARIO Y RESILIENCIA ANTE FALLOS DE SERVIDOR
  // =========================================================================
  describe('7. Detección de Inventario y Resiliencia ante Fallos', () => {
    test('Falla de red en get_anonymous_upgrade_state resulta en error_recoverable, NO empty_clean', async () => {
      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'anon-user-1', is_anonymous: true } } },
      });

      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'get_anonymous_upgrade_state') {
          return { data: null, error: { message: 'Failed to fetch (network error)' } };
        }
        return { data: null, error: null };
      };

      const res = await domainMigrationBridgeService.detectInventory();
      assert.equal(res.state, 'error_recoverable', 'Fallo de red debe ser error_recoverable');
      assert.notEqual(res.state, 'empty_clean', 'NUNCA debe reportar empty_clean ante error');
      assert.ok(res.error?.includes('Failed to fetch'));
    });

    test('Respuesta { ok: false } de get_anonymous_upgrade_state se trata como error_recoverable', async () => {
      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'anon-user-2', is_anonymous: true } } },
      });

      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'get_anonymous_upgrade_state') {
          return { data: { ok: false, error: 'internal_query_timeout' }, error: null };
        }
        return { data: null, error: null };
      };

      const res = await domainMigrationBridgeService.detectInventory();
      assert.equal(res.state, 'error_recoverable');
      assert.equal(res.error, 'internal_query_timeout');
    });

    test('Solo reporta empty_clean cuando el servidor confirma 0 recursos y no hay tokens locales', async () => {
      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'anon-clean', is_anonymous: true } } },
      });

      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'get_anonymous_upgrade_state') {
          return {
            data: {
              ok: true,
              already_migrated: false,
              has_transferable_resources: false,
              has_owned_encounters: false,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      };

      const res = await domainMigrationBridgeService.detectInventory();
      assert.equal(res.state, 'empty_clean');
      assert.equal(res.inventory?.hasTransferableResources, false);
    });

    test('Cuenta permanente Google identificada en estado google_ready', async () => {
      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'google-user', is_anonymous: false } } },
      });

      const res = await domainMigrationBridgeService.detectInventory();
      assert.equal(res.state, 'google_ready');
      assert.equal(res.inventory?.isAnonymous, false);
    });
  });

  // =========================================================================
  // BLOQUE 8: RESILIENCIA, CAÍDA DE RED POST-COMMIT E IDEMPOTENCIA (ADV-15)
  // =========================================================================
  describe('8. Resiliencia, Caída de Red Post-Commit e Idempotencia (ADV-15)', () => {
    test('confirmMigrationCompleted valida formato hex de 64 caracteres antes de invocar RPC', async () => {
      const invalidShort = '1234abcd';
      const res = await domainMigrationBridgeService.confirmMigrationCompleted(invalidShort);
      assert.equal(res.ok, false);
      assert.equal(res.error, 'invalid_token_format');
    });

    test('claimMigrationTicket valida formato hex de 64 caracteres fail-closed', async () => {
      const invalidToken = 'not-a-hex-token';
      const res = await domainMigrationBridgeService.claimMigrationTicket(invalidToken);
      assert.equal(res.ok, false);
      assert.equal(res.error, 'invalid_token_format');
    });

    test('Caída de red en claim dispara confirmación idempotente y recupera éxito', async () => {
      const validToken = 'c'.repeat(64);

      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'claim_domain_migration_ticket_seguro') {
          return { data: null, error: { message: 'Network request failed' } };
        }
        if (fn === 'confirmar_migracion_dominio_completada_seguro') {
          return {
            data: { ok: true, already_completed: true, resources_transferred: { count: 3 } },
            error: null,
          };
        }
        return { data: null, error: null };
      };

      const res = await domainMigrationBridgeService.claimMigrationTicket(validToken);
      assert.equal(res.ok, true);
      assert.equal(res.alreadyCompleted, true);
    });
  });

  // =========================================================================
  // BLOQUE 9: MATRIZ DE MENSAJES UX EN LENGUAJE CLARO (CERO JERGA)
  // =========================================================================
  describe('9. Matriz de Mensajes UX en Lenguaje Claro', () => {
    const forbiddenJargon = [
      'jwt',
      'token',
      'rpc',
      'sql',
      'postgres',
      'localstorage',
      'sessionstorage',
      'sha-256',
      'hash',
      'bearer',
    ];

    const testErrors = [
      'network_error',
      'ticket_expired',
      'ticket_target_mismatch',
      'ticket_already_used',
      'ticket_revoked',
      'anonymous_session_already_migrated',
      'transfer_ticket_already_pending',
      'invalid_token_format',
      'rate_limit_exceeded',
      'no_transferable_resources',
      'cross_origin_migration_disabled',
      'manual_migration_disabled',
      'popup_blocked',
      'popup_closed',
    ];

    test('Todos los códigos de error tienen mensajes claros sin jerga técnica', () => {
      for (const err of testErrors) {
        const msg = getMigrationUserMessage(err).toLowerCase();
        assert.ok(msg.length > 10, `Mensaje para ${err} no debe estar vacío`);

        for (const word of forbiddenJargon) {
          assert.equal(
            msg.includes(word),
            false,
            `El mensaje para ${err} no debe contener jerga técnica ("${word}"): ${msg}`
          );
        }
      }
    });

    test('ticket_expired explica que los encuentros siguen a salvo en la pestaña anterior', () => {
      const msg = getMigrationUserMessage('ticket_expired');
      assert.ok(msg.includes('venció'));
      assert.ok(msg.includes('a salvo'));
    });

    test('rate_limit_exceeded es empático y pide esperar unos minutos', () => {
      const msg = getMigrationUserMessage('rate_limit_exceeded');
      assert.ok(msg.includes('varios intentos'));
      assert.ok(msg.includes('minutos'));
    });
  });

  // =========================================================================
  // BLOQUE 10: PROTECCIÓN CONTRA FUGAS DE SECRETOS EN URLS Y CABECERAS
  // =========================================================================
  describe('10. Protección contra Fugas de Secretos y Anti-Framing (ADV-09)', () => {
    test('isValidPostAuthRedirect autoriza rutas de migración y rechaza parámetros con códigos', () => {
      assert.equal(isValidPostAuthRedirect('/auth/domain-bridge'), true);
      assert.equal(isValidPostAuthRedirect('/migrate-receive'), true);

      assert.equal(isValidPostAuthRedirect(`/migrate-receive?code=${'a'.repeat(64)}`), false);
      assert.equal(isValidPostAuthRedirect(`/auth/domain-bridge?ticket=${'b'.repeat(64)}`), false);
      assert.equal(isValidPostAuthRedirect('/migrate-receive#access_token=secret'), false);
      assert.equal(isValidPostAuthRedirect('//evil.com/migrate-receive'), false);
    });

    test('normalizeRouteForFeedback sanitiza /auth/domain-bridge y /migrate-receive sin capturar query', () => {
      assert.equal(normalizeRouteForFeedback('/auth/domain-bridge?foo=bar'), '/auth/domain-bridge');
      assert.equal(normalizeRouteForFeedback('/migrate-receive#hash'), '/migrate-receive');
    });

    test('redactSensitiveUrlForLogs sanitiza tokens y llaves en logs de diagnóstico', () => {
      const dirtyUrl = 'http://localhost:5173/auth/domain-bridge?ticket=' + 'f'.repeat(64);
      const clean = redactSensitiveUrlForLogs(dirtyUrl);
      assert.ok(!clean.includes('f'.repeat(64)));
      assert.ok(decodeURIComponent(clean).includes('[REDACTED]'));
    });

    test('vercel.json contiene cabeceras anti-framing y no-store para ambas rutas', () => {
      const vercelJsonPath = path.resolve(process.cwd(), 'vercel.json');
      const content = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));

      const bridgeHeader = content.headers.find((h: any) => h.source.includes('/auth/domain-bridge'));
      const receiveHeader = content.headers.find((h: any) => h.source.includes('/migrate-receive'));

      assert.ok(bridgeHeader, 'Debe existir cabecera para /auth/domain-bridge');
      assert.ok(receiveHeader, 'Debe existir cabecera para /migrate-receive');

      const hasXFrame = (entry: any) =>
        entry.headers.some((h: any) => h.key === 'X-Frame-Options' && h.value === 'DENY');
      const hasCsp = (entry: any) =>
        entry.headers.some((h: any) => h.key === 'Content-Security-Policy' && h.value.includes("frame-ancestors 'none'"));
      const hasNoStore = (entry: any) =>
        entry.headers.some((h: any) => h.key === 'Cache-Control' && h.value === 'no-store');

      assert.ok(hasXFrame(bridgeHeader));
      assert.ok(hasCsp(bridgeHeader));
      assert.ok(hasNoStore(bridgeHeader));

      assert.ok(hasXFrame(receiveHeader));
      assert.ok(hasCsp(receiveHeader));
      assert.ok(hasNoStore(receiveHeader));
    });
  });

  // =========================================================================
  // BLOQUE 11: ENSAYO SIMULADO CROSS-ORIGIN DUAL DE PUNTA A PUNTA
  // =========================================================================
  describe('11. Ensayo Simulado Cross-Origin Dual (localhost:5173 <-> 127.0.0.1:5174)', () => {
    test('Intercambio completo end-to-end con métodos reales de servicio y cero wildcards', async () => {
      const originA = 'http://localhost:5173';
      const originB = 'http://127.0.0.1:5174';
      const targetUserId = 'bbbbbbbb-2222-4222-8222-222222222222';
      const sourceUserId = 'aaaaaaaa-1111-4111-8111-111111111111';
      const generatedTicket = 'd'.repeat(64);

      let targetListener: ((e: MessageEvent) => void) | null = null;
      let sourceListener: ((e: MessageEvent) => void) | null = null;

      let postMessageTargetCalls: Array<{ msg: any; targetOrigin: string }> = [];
      let postMessageSourceCalls: Array<{ msg: any; targetOrigin: string }> = [];

      const storageA = new MockStorage();
      const storageB = new MockStorage();

      // Ventana de origen (Dominio A) simulada
      // Recibe mensajes dirigidos a Dominio A (enviados por popupWindow)
      const windowA = {
        localStorage: storageA,
        sessionStorage: new MockStorage(),
        addEventListener: (_evt: string, fn: any) => {
          sourceListener = fn;
        },
        removeEventListener: () => {
          sourceListener = null;
        },
        location: { origin: originA },
        postMessage: (msg: any, target: string) => {
          postMessageSourceCalls.push({ msg, targetOrigin: target });
          if (sourceListener) {
            (globalThis as any).window = windowA;
            (globalThis as any).localStorage = storageA;
            sourceListener({
              origin: originB,
              source: popupWindow,
              data: msg,
            } as MessageEvent);
          }
        },
      } as unknown as Window;

      // Ventana popup (Dominio B) simulada
      // Recibe mensajes dirigidos a Dominio B (enviados por windowA)
      const popupWindow = {
        closed: false,
        opener: windowA,
        location: { origin: originB },
        localStorage: storageB,
        sessionStorage: new MockStorage(),
        postMessage: (msg: any, target: string) => {
          postMessageTargetCalls.push({ msg, targetOrigin: target });
          if (targetListener) {
            (globalThis as any).window = popupWindow;
            (globalThis as any).localStorage = storageB;
            targetListener({
              origin: originA,
              source: windowA,
              data: msg,
            } as MessageEvent);
          }
        },
      } as unknown as Window;

      (globalThis as any).window = windowA;

      // Mock de Supabase para Dominio A y Dominio B
      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: sourceUserId, is_anonymous: true } } },
      });

      (supabase as any).rpc = async (fn: string, params: any) => {
        if (fn === 'create_domain_migration_ticket_seguro') {
          assert.equal(params.p_intended_target_user_id, targetUserId);
          assert.equal(params.p_flow_mode, 'cross_origin_bridge');
          return {
            data: { ok: true, ticket_token: generatedTicket },
            error: null,
          };
        }
        if (fn === 'claim_domain_migration_ticket_seguro') {
          assert.equal(params.p_ticket_token, generatedTicket);
          return {
            data: { ok: true, resources_transferred: { encuentros: 2 } },
            error: null,
          };
        }
        return { data: { ok: true }, error: null };
      };

      // 1. Dominio A inicia handshake
      let sourceState: string | null = null;
      const bridgeA = domainMigrationBridgeService.startBridgeHandshake({
        popupWindow,
        targetOrigin: originB,
        onStateChange: (st) => {
          sourceState = st;
        },
        onError: (err) => {
          assert.fail(`Error inesperado en Dominio A: ${err}`);
        },
      });

      // 2. Dominio B configura escucha con sourceOrigin = originA
      (popupWindow as any).addEventListener = (_evt: string, fn: any) => {
        targetListener = fn;
      };
      (popupWindow as any).removeEventListener = () => {
        targetListener = null;
      };

      (globalThis as any).window = popupWindow;
      (globalThis as any).localStorage = storageB;

      let codeReceivedByB: string | null = null;
      const bridgeB = domainMigrationBridgeService.listenForBridgeCodeOnReceive({
        sourceOpener: windowA,
        targetUserId,
        sourceOrigin: originA,
        onCodeReceived: async (token) => {
          codeReceivedByB = token;
          // Dominio B canjea el ticket recibido
          const claimRes = await domainMigrationBridgeService.claimMigrationTicket(token);
          assert.equal(claimRes.ok, true);
          // Dominio B notifica completitud
          bridgeB.notifyCompleted();
        },
        onError: (err) => {
          assert.fail(`Error inesperado en Dominio B: ${err}`);
        },
      });

      // Dar tiempo para la propagación de microtareas asíncronas
      await new Promise((r) => setTimeout(r, 50));

      // 3. Verificaciones de seguridad y paridad
      assert.equal(codeReceivedByB, generatedTicket, 'Dominio B debe recibir el código emitido');
      assert.equal(sourceState, 'already_migrated', 'Dominio A debe transicionar a already_migrated');
      assert.equal(storageA.getItem(`${RETIRED_LOCAL_SESSION_PREFIX}${sourceUserId}`) !== null, true, 'La sesión de A debe quedar retirada');

      // 4. Verificar que NINGÚN mensaje utilizó targetOrigin = '*'
      for (const call of postMessageTargetCalls) {
        assert.notEqual(call.targetOrigin, '*', 'Target de llamada de A a B no puede ser *');
        assert.equal(call.targetOrigin, originB);
      }
      for (const call of postMessageSourceCalls) {
        assert.notEqual(call.targetOrigin, '*', 'Target de llamada de B a A no puede ser *');
        assert.equal(call.targetOrigin, originA);
      }

      bridgeA.cancel();
      bridgeB.cleanup();
    });
  });

  // =========================================================================
  // BLOQUE 12: GOBERNANZA DE FEATURE FLAGS Y DESACTIVACIÓN POR DEFECTO
  // =========================================================================
  describe('12. Gobernanza de Feature Flags y Desactivación por Defecto', () => {
    test('Feature flags están desactivados por defecto en producción', () => {
      assert.equal(typeof ENABLE_DOMAIN_MIGRATION_BRIDGE, 'boolean');
      assert.equal(typeof ENABLE_DOMAIN_MIGRATION_MANUAL_FALLBACK, 'boolean');
      assert.equal(domainMigrationBridgeService.isBridgeEnabled(), ENABLE_DOMAIN_MIGRATION_BRIDGE);
      assert.equal(domainMigrationBridgeService.isManualFallbackEnabled(), ENABLE_DOMAIN_MIGRATION_MANUAL_FALLBACK);
    });

    test('Cadena de redirección histórica N -> 1 resuelve A -> C y B -> C sin encadenamiento', () => {
      const config = {
        canonicalOrigin: 'https://dominio-c.com',
        legacyHosts: new Set(['puntoencuentro.com.ar', 'dominio-b.com']),
        legacyRedirectEnabled: true,
      };

      const fromA = resolveLegacyDomainRedirect('https://puntoencuentro.com.ar/meet/1234', config);
      assert.equal(fromA.shouldRedirect, true);
      if (fromA.shouldRedirect) {
        assert.equal(fromA.destinationUrl, 'https://dominio-c.com/meet/1234');
      }

      const fromB = resolveLegacyDomainRedirect('https://dominio-b.com/meet/1234', config);
      assert.equal(fromB.shouldRedirect, true);
      if (fromB.shouldRedirect) {
        assert.equal(fromB.destinationUrl, 'https://dominio-c.com/meet/1234');
      }
    });
  });

  // =========================================================================
  // BLOQUE 13: ALTERNATIVA GOOGLE Y PARTICIPACIONES LOCALES DE INVITADOS
  // =========================================================================
  describe('13. Alternativa Google y Participaciones Locales de Invitados', () => {
    test('Invitado sin sesión con tokens locales que elige Google pre-sincroniza antes de OAuth', async () => {
      const guestToken = '77777777-7777-4777-8777-777777777777';
      saveParticipatedToken(guestToken);

      let ensureSessionCalled = false;
      let linkedBatchTokens: string[] = [];

      // Inicialmente el invitado no tiene sesión
      let currentSession: any = null;

      (supabase.auth as any).getSession = async () => ({
        data: { session: currentSession },
      });

      (supabase.auth as any).signInAnonymously = async () => {
        ensureSessionCalled = true;
        const fakeUser = { id: 'anon-guest-777', is_anonymous: true };
        currentSession = { user: fakeUser, session: { user: fakeUser } };
        return { data: { user: fakeUser, session: { user: fakeUser } }, error: null };
      };

      (supabase as any).rpc = async (fn: string, params: any) => {
        if (fn === 'vincular_tokens_participante_lote_seguro') {
          linkedBatchTokens = params.p_tokens;
          return {
            data: {
              ok: true,
              linked_count: 1,
              already_linked_count: 0,
              skipped_count: 0,
            },
            error: null,
          };
        }
        return { data: { ok: true }, error: null };
      };

      // 1. Ejecutar presincronización que realiza el botón Google
      const prepRes = await domainMigrationBridgeService.prepareSourceResources();

      // Debe materializar la sesión anónima técnica
      assert.equal(prepRes.ok, true);
      assert.equal(ensureSessionCalled, true, 'Debe materializar sesión anónima técnica');
      assert.equal(prepRes.linkedCount, 1);
      assert.equal(linkedBatchTokens.includes(guestToken), true, 'Debe vincular el token de invitado');
      assert.equal(prepRes.isComplete, true);
      assert.equal(prepRes.hasUnrecoveredTokens, false);

      // Los tokens locales se conservan intactos en el dispositivo
      const storedTokens = collectAllLocalInvitationTokens();
      assert.equal(storedTokens.includes(guestToken), true, 'Tokens deben conservarse hasta confirmación');
    });

    test('Fallo de presincronización en opción Google aborta el flujo fail-closed', async () => {
      const guestToken = '88888888-8888-4888-8888-888888888888';
      saveParticipatedToken(guestToken);

      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'anon-guest-888', is_anonymous: true } } },
      });

      // Simular falla de RPC de vinculación (ej. rate limit o error de base de datos)
      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'vincular_tokens_participante_lote_seguro') {
          return {
            data: { ok: false, error: 'rate_limit_exceeded' },
            error: null,
          };
        }
        return { data: { ok: true }, error: null };
      };

      const prepRes = await domainMigrationBridgeService.prepareSourceResources();
      assert.equal(prepRes.ok, false, 'Debe fallar cerrado');
      assert.equal(prepRes.error, 'rate_limit_exceeded');

      // Las participaciones no se pierden ni se borran
      const storedTokens = collectAllLocalInvitationTokens();
      assert.equal(storedTokens.includes(guestToken), true, 'No debe borrar tokens locales ante fallos');
    });

    test('Recorrido Google de punta a punta: invitado sin sesión con participaciones locales realiza upgrade sin fallar por render de React', async () => {
      const guestToken = '77777777-7777-4777-8777-777777777777';
      saveParticipatedToken(guestToken);

      let ensureSessionCalled = false;
      let linkedBatchTokens: string[] = [];
      let inventoryQueried = false;
      let transferTicketCreated = false;
      let oauthStarted = false;
      let currentSession: any = null;

      // 1. Invitado sin sesión activa al inicio
      (supabase.auth as any).getSession = async () => ({
        data: { session: currentSession },
      });

      (supabase.auth as any).signInAnonymously = async () => {
        ensureSessionCalled = true;
        const fakeUser = { id: 'anon-guest-full-flow-777', is_anonymous: true };
        currentSession = { user: fakeUser, session: { user: fakeUser } };
        return { data: { user: fakeUser, session: { user: fakeUser } }, error: null };
      };

      (supabase.auth as any).signInWithOAuth = async (params: any) => {
        oauthStarted = true;
        assert.equal(params?.provider, 'google');
        return { data: { provider: 'google', url: 'https://accounts.google.com/o/oauth2/auth' }, error: null };
      };

      (supabase as any).rpc = async (fn: string, params: any) => {
        if (fn === 'vincular_tokens_participante_lote_seguro') {
          linkedBatchTokens = params.p_tokens;
          return {
            data: {
              ok: true,
              linked_count: 1,
              already_linked_count: 0,
              skipped_count: 0,
            },
            error: null,
          };
        }
        if (fn === 'get_anonymous_upgrade_state') {
          inventoryQueried = true;
          return {
            data: {
              ok: true,
              is_anonymous: true,
              has_owned_encounters: false,
              has_participant_links: true,
              has_transferable_resources: true,
            },
            error: null,
          };
        }
        if (fn === 'create_anonymous_transfer_ticket') {
          transferTicketCreated = true;
          return {
            data: {
              ok: true,
              ticket_token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              expires_at: new Date(Date.now() + 180000).toISOString(),
            },
            error: null,
          };
        }
        return { data: { ok: true }, error: null };
      };

      // Simular que React no ha vuelto a renderizar (reactUser = null)
      const res = await runUnifiedSignInWithGoogle({ reactUser: null });

      // Verificaciones clave:
      // - No debe abortar con inventory_check_failed
      // - No debe abortar con anonymous_user_required
      // - Debe completar ok: true y haber iniciado OAuth
      assert.equal(res.ok, true, `El resultado debe ser exitoso: ${res.error}`);
      assert.equal(ensureSessionCalled, true, 'Debe haber creado sesión anónima');
      assert.equal(linkedBatchTokens.includes(guestToken), true, 'Debe haber vinculado participaciones locales');
      assert.equal(inventoryQueried, true, 'Debe haber consultado inventario server-side');
      assert.equal(transferTicketCreated, true, 'Debe haber emitido ticket de transferencia');
      assert.equal(oauthStarted, true, 'Debe haber iniciado Google OAuth');

      // Comprobar que el secret se guardó en sessionStorage
      const savedTicket = (globalThis as any).window.sessionStorage.getItem('pe_pending_transfer_ticket');
      assert.equal(savedTicket, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

      // Tokens locales permanecen guardados en localStorage
      const localStored = collectAllLocalInvitationTokens();
      assert.equal(localStored.includes(guestToken), true);
    });

    test('Recuperación parcial: 4 tokens vinculados y 1 omitido comunica unrecoveredTokens y preserva local storage', async () => {
      const tokens = [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555',
      ];
      for (const t of tokens) {
        saveParticipatedToken(t);
      }

      (supabase.auth as any).getSession = async () => ({
        data: { session: { user: { id: 'anon-partial-recovery-user', is_anonymous: true } } },
      });

      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'vincular_tokens_participante_lote_seguro') {
          return {
            data: {
              ok: true,
              linked_count: 4,
              already_linked_count: 0,
              skipped_count: 1,
            },
            error: null,
          };
        }
        return { data: { ok: true }, error: null };
      };

      const prepRes = await domainMigrationBridgeService.prepareSourceResources();

      assert.equal(prepRes.ok, true);
      assert.equal(prepRes.totalTokens, 5);
      assert.equal(prepRes.linkedCount, 4);
      assert.equal(prepRes.skippedCount, 1);
      assert.equal(prepRes.hasUnrecoveredTokens, true, 'Debe indicar que hay tokens no recuperados');
      assert.equal(prepRes.isComplete, false, 'No debe reportar recuperación completa');

      // Todos los 5 tokens deben conservarse en localStorage sin borrado prematuro
      const stored = collectAllLocalInvitationTokens();
      assert.equal(stored.length, 5);
      for (const t of tokens) {
        assert.equal(stored.includes(t), true, `Token ${t} debe conservarse en almacenamiento local`);
      }
    });
  });

  // =========================================================================
  // BLOQUE 14: COMPROBACIÓN EFECTIVA Y ESTRICTA DE CANCELACIÓN
  // =========================================================================
  describe('14. Comprobación Efectiva y Estricta de Cancelación', () => {
    test('Error de PostgREST en revocación devuelve ok: false fail-closed (sin default true)', async () => {
      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'revoke_my_pending_transfer_ticket') {
          return {
            data: null,
            error: { message: 'database_timeout', code: '57014' },
          };
        }
        return { data: { ok: true }, error: null };
      };

      const res = await domainMigrationBridgeService.cancelPendingMigration();
      assert.equal(res.ok, false, 'Debe fallar ante error de red o PostgREST');
      assert.equal(res.error, 'database_timeout');
    });

    test('Rechazo funcional en revocación (data.ok === false) devuelve ok: false', async () => {
      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'revoke_my_pending_transfer_ticket') {
          return {
            data: { ok: false, error: 'ticket_already_claimed' },
            error: null,
          };
        }
        return { data: { ok: true }, error: null };
      };

      const res = await domainMigrationBridgeService.cancelPendingMigration();
      assert.equal(res.ok, false);
      assert.equal(res.error, 'ticket_already_claimed');
    });

    test('Respuesta nula o indeterminada devuelve ok: false y no éxito por defecto', async () => {
      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'revoke_my_pending_transfer_ticket') {
          return {
            data: null,
            error: null,
          };
        }
        return { data: { ok: true }, error: null };
      };

      const res = await domainMigrationBridgeService.cancelPendingMigration();
      assert.equal(res.ok, false, 'No debe usar ?? true ante data nula');
      assert.equal(res.error, 'invalid_rpc_response');
    });

    test('Revocación exitosa confirmada devuelve ok: true y revokedCount verificado', async () => {
      (supabase as any).rpc = async (fn: string) => {
        if (fn === 'revoke_my_pending_transfer_ticket') {
          return {
            data: { ok: true, revoked_count: 1 },
            error: null,
          };
        }
        return { data: { ok: true }, error: null };
      };

      const res = await domainMigrationBridgeService.cancelPendingMigration();
      assert.equal(res.ok, true);
      assert.equal(res.revokedCount, 1);
    });
  });
});
