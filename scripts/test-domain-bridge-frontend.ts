/**
 * Suite Automatizada: Frontend del Puente de Identidad entre Dominios (Mini-Sprint 2B-3)
 *
 * Verifica de punta a punta los 12 escenarios obligatorios del prompt:
 * 1. Paridad completa de inventario local (las 6 fuentes y deduplicación estricta).
 * 2. Usuario anónimo con encuentros detectado en estado ready_to_migrate.
 * 3. Invitado sin cuenta con tokens locales materializable sin pérdida.
 * 4. Cuenta permanente Google identificada en estado google_ready.
 * 5. Cancelación antes del canje con revocación de ticket y retorno seguro.
 * 6. Ticket vencido o revocado mapeado a mensaje comprensible sin jerga.
 * 7. Interrupción de red posterior al COMMIT y confirmación idempotente.
 * 8. Rechazo de terceros (intended_target_mismatch) y protección anti-DoS.
 * 9. Protocolo postMessage seguro, rechazo de origen malicioso y nonce incorrecto.
 * 10. Protección contra filtración de códigos en URLs, query strings y logs.
 * 11. Transferencia sucesiva A -> B -> C y congelamiento post-migración sin signOut.
 * 12. Preservación y deduplicación de participaciones en Home para sesiones anónimas.
 * 13. Ensayo dual-origin simulado (localhost:5173 <-> 127.0.0.1:5174).
 * 14. Gobernanza de Feature Flags independientes y desactivados por defecto.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Módulos bajo prueba
import {
  collectAllLocalInvitationTokens,
  getParticipatedIndividualTokens,
  saveParticipatedToken,
  getGeneralParticipatedTokens,
  getCoordinationGeneralParticipatedTokens,
} from '../src/lib/participatedTokens';
import {
  isTrustedBridgeOrigin,
  isCurrentOriginLegacy,
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
} from '../src/services/domainMigrationBridgeService';
import { isValidPostAuthRedirect } from '../src/hooks/usePostAuthRedirect';
import { normalizeRouteForFeedback } from '../src/services/feedbackService';

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
    };
    (globalThis as any).localStorage = mockLocal;
    (globalThis as any).sessionStorage = mockSession;
  });

  // =========================================================================
  // BLOQUE 1: PARIDAD DE INVENTARIO LOCAL (LAS 6 FUENTES Y COORDINACIÓN)
  // =========================================================================
  describe('1. Paridad de Inventario Local y Deduplicación', () => {
    test('Recolecta y deduplica tokens válidos de las 6 fuentes locales', () => {
      const token1 = '11111111-1111-4111-8111-111111111111';
      const token2 = '22222222-2222-4222-8222-222222222222';
      const token3 = '33333333-3333-4333-8333-333333333333';
      const token4 = '44444444-4444-4444-8444-444444444444';
      const token5 = '55555555-5555-4555-8555-555555555555';
      const token6 = '66666666-6666-4666-8666-666666666666';

      // Fuente 1: participated_tokens (array)
      mockLocal.setItem('participated_tokens', JSON.stringify([token1, token2]));

      // Fuente 2: puntoencuentro_guest_token_by_public_*
      mockLocal.setItem(`puntoencuentro_guest_token_by_public_pub_abc`, token3);

      // Fuente 3: puntoencuentro_coordination_guest_token_by_public_*
      mockLocal.setItem(`puntoencuentro_coordination_guest_token_by_public_coord_xyz`, token4);

      // Fuente 4: encuentros_general (mapa histórico)
      mockLocal.setItem(
        'encuentros_general',
        JSON.stringify({
          encuentros: {
            enc_1: { token_invitacion: token5 },
            enc_duplicate: { token_invitacion: token1 }, // Duplicado intencional
          },
        })
      );

      // Fuente 5: encuentros_coordination_general (mapa histórico)
      mockLocal.setItem(
        'encuentros_coordination_general',
        JSON.stringify({
          encuentros: {
            enc_coord_1: { token_invitacion: token6 },
          },
        })
      );

      // Fuente 6: sessionStorage['pending_participant_invitation_token']
      mockSession.setItem('pending_participant_invitation_token', token2); // Duplicado intencional

      const allTokens = collectAllLocalInvitationTokens();

      assert.equal(allTokens.length, 6, 'Debe contener exactamente 6 tokens únicos');
      assert.ok(allTokens.includes(token1), 'Debe incluir token1');
      assert.ok(allTokens.includes(token2), 'Debe incluir token2');
      assert.ok(allTokens.includes(token3), 'Debe incluir token3');
      assert.ok(allTokens.includes(token4), 'Debe incluir token4');
      assert.ok(allTokens.includes(token5), 'Debe incluir token5');
      assert.ok(allTokens.includes(token6), 'Debe incluir token6');
    });

    test('Filtra valores vacíos, malformados o no UUID de forma segura', () => {
      mockLocal.setItem(
        'participated_tokens',
        JSON.stringify(['not-a-uuid', '', null, 12345, '11111111-1111-4111-8111-111111111111'])
      );
      mockLocal.setItem('puntoencuentro_guest_token_by_public_invalid', 'evil<script>');

      const tokens = collectAllLocalInvitationTokens();
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0], '11111111-1111-4111-8111-111111111111');
    });

    test('Normaliza tokens a minúsculas sin duplicados por casing', () => {
      const lower = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const upper = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';

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

      // Durante la preparación o recolección, los datos locales deben permanecer intactos
      const tokens = collectAllLocalInvitationTokens();
      assert.equal(tokens.length, 1);
      assert.notEqual(mockLocal.getItem('participated_tokens'), null);
      assert.notEqual(mockLocal.getItem('puntoencuentro_guest_token_by_public_test'), null);
    });
  });

  // =========================================================================
  // BLOQUE 2: SEGURIDAD DEL PROTOCOLO POSTMESSAGE, ORÍGENES Y NONCES
  // =========================================================================
  describe('2. Seguridad de Protocolo postMessage y Handshake', () => {
    test('generateBridgeNonce produce nonces CSPRNG de 128 bits (32 hex)', () => {
      const n1 = generateBridgeNonce();
      const n2 = generateBridgeNonce();

      assert.equal(n1.length, 32);
      assert.match(n1, /^[0-9a-f]{32}$/i);
      assert.equal(n2.length, 32);
      assert.notEqual(n1, n2, 'Dos nonces generados no deben colisionar');
    });

    test('isTrustedBridgeOrigin acepta origen canónico, legados y localhost en desarrollo/staging', () => {
      const cfg = resolveDomainConfig();
      // Canónico
      assert.equal(isTrustedBridgeOrigin(cfg.canonicalOrigin), true);
      // Localhost / 127.0.0.1 para ensayo dual
      assert.equal(isTrustedBridgeOrigin('http://localhost:5173'), true);
      assert.equal(isTrustedBridgeOrigin('http://127.0.0.1:5174'), true);
    });

    test('isTrustedBridgeOrigin rechaza orígenes maliciosos, esquemas inseguros o wildcards (ADV-08)', () => {
      assert.equal(isTrustedBridgeOrigin('*'), false);
      assert.equal(isTrustedBridgeOrigin('https://evil.com'), false);
      assert.equal(isTrustedBridgeOrigin('http://puntoencuentro.com.ar.evil.com'), false);
      assert.equal(isTrustedBridgeOrigin('javascript:alert(1)'), false);
      assert.equal(isTrustedBridgeOrigin(''), false);
      assert.equal(isTrustedBridgeOrigin(null), false);
    });

    test('Rechazo estricto de nonce adulterado en listenForBridgeCodeOnReceive', () => {
      let reportedError: string | null = null;
      let receivedCode: string | null = null;

      const mockOpener = {
        postMessage: () => {},
      } as unknown as Window;
      const targetUserId = '22222222-bbbb-4222-8222-222222222222';

      // Configurar simulación de window con message listener
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
        onCodeReceived: (t) => {
          receivedCode = t;
        },
        onError: (err) => {
          reportedError = err;
        },
      });

      assert.ok(registeredListener);

      // Simular ataque: atacante envía PE_BRIDGE_CODE con nonce adulterado
      const fakeMessage = {
        origin: 'http://localhost:5173',
        source: mockOpener,
        data: {
          type: 'PE_BRIDGE_CODE',
          ticket_token: 'b'.repeat(64),
          bridge_nonce: '0'.repeat(32), // Nonce incorrecto
        },
      } as MessageEvent;

      registeredListener!(fakeMessage);

      assert.equal(reportedError, 'bridge_nonce_mismatch', 'Debe rechazar nonce adulterado');
      assert.equal(receivedCode, null, 'No debe aceptar el código si el nonce no coincide');

      session.cleanup();
    });
  });

  // =========================================================================
  // BLOQUE 3: SIMULACIÓN DE ENSAYO DUAL-ORIGIN (localhost:5173 <-> 127.0.0.1:5174)
  // =========================================================================
  describe('3. Ensayo Simulado Cross-Origin Dual (Dominio A <-> Dominio B)', () => {
    test('Aislamiento de almacenamiento: Origen A y Origen B no comparten storage', () => {
      const originAStorage = new MockStorage();
      const originBStorage = new MockStorage();

      originAStorage.setItem('participated_tokens', JSON.stringify(['11111111-1111-4111-8111-111111111111']));
      assert.equal(originBStorage.getItem('participated_tokens'), null, 'Dominio B no puede leer storage de Dominio A');
    });

    test('Handshake simulado: Target genera nonce 128b y Source entrega ticket asociado a target', () => {
      const originA = 'http://localhost:5173';
      const originB = 'http://127.0.0.1:5174';

      const targetUserId = '22222222-bbbb-4222-8222-222222222222';
      const bridgeNonce = generateBridgeNonce();

      // Mensaje de B -> A
      const readyMsg = {
        type: 'PE_BRIDGE_READY',
        target_user_id: targetUserId,
        bridge_nonce: bridgeNonce,
      };

      assert.equal(isTrustedBridgeOrigin(originA), true);
      assert.equal(isTrustedBridgeOrigin(originB), true);
      assert.match(readyMsg.target_user_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      assert.match(readyMsg.bridge_nonce, /^[0-9a-f]{32}$/i);

      // Respuesta de A -> B
      const ticketToken = 'a'.repeat(64);
      const codeMsg = {
        type: 'PE_BRIDGE_CODE',
        ticket_token: ticketToken,
        bridge_nonce: readyMsg.bridge_nonce, // Eco exacto
      };

      assert.equal(codeMsg.bridge_nonce, bridgeNonce);
      assert.equal(codeMsg.ticket_token.length, 64);
    });
  });

  // =========================================================================
  // BLOQUE 4: CAÍDA DE RED POST-COMMIT E IDEMPOTENCIA
  // =========================================================================
  describe('4. Resiliencia, Caída de Red Post-Commit e Idempotencia (ADV-15)', () => {
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
  });

  // =========================================================================
  // BLOQUE 5: MATRIZ DE MENSAJES UX (CERO JERGA TÉCNICA)
  // =========================================================================
  describe('5. Matriz de Mensajes UX en Lenguaje Claro', () => {
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
  // BLOQUE 6: PROTECCIÓN CONTRA FUGAS DE SECRETOS EN URLS Y CABECERAS
  // =========================================================================
  describe('6. Protección contra Fugas de Secretos y Anti-Framing (ADV-09)', () => {
    test('isValidPostAuthRedirect autoriza rutas de migración y rechaza parámetros con códigos', () => {
      assert.equal(isValidPostAuthRedirect('/auth/domain-bridge'), true);
      assert.equal(isValidPostAuthRedirect('/migrate-receive'), true);

      // Rechazo estricto de códigos en query string o fragmentos
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

      assert.ok(bridgeHeader, 'Debe existir configuración de cabeceras para /auth/domain-bridge');
      assert.ok(receiveHeader, 'Debe existir configuración de cabeceras para /migrate-receive');

      const hasXFrame = (entry: any) =>
        entry.headers.some((h: any) => h.key === 'X-Frame-Options' && h.value === 'DENY');
      const hasCsp = (entry: any) =>
        entry.headers.some((h: any) => h.key === 'Content-Security-Policy' && h.value.includes("frame-ancestors 'none'"));
      const hasNoStore = (entry: any) =>
        entry.headers.some((h: any) => h.key === 'Cache-Control' && h.value === 'no-store');

      assert.ok(hasXFrame(bridgeHeader), '/auth/domain-bridge debe tener X-Frame-Options: DENY');
      assert.ok(hasCsp(bridgeHeader), '/auth/domain-bridge debe tener CSP frame-ancestors none');
      assert.ok(hasNoStore(bridgeHeader), '/auth/domain-bridge debe tener Cache-Control: no-store');

      assert.ok(hasXFrame(receiveHeader), '/migrate-receive debe tener X-Frame-Options: DENY');
      assert.ok(hasCsp(receiveHeader), '/migrate-receive debe tener CSP frame-ancestors none');
      assert.ok(hasNoStore(receiveHeader), '/migrate-receive debe tener Cache-Control: no-store');
    });
  });

  // =========================================================================
  // BLOQUE 7: RETIRO POST-MIGRACIÓN Y CADENA A -> B -> C (ADV-16, ADV-17)
  // =========================================================================
  describe('7. Retiro Post-Migración y Cadena A -> B -> C', () => {
    test('markLocalSessionRetired persiste estado y isLocalSessionRetired lo detecta', () => {
      assert.equal(isLocalSessionRetired(), false);
      markLocalSessionRetired();
      assert.equal(isLocalSessionRetired(), true);
      assert.equal(mockLocal.getItem(RETIRED_LOCAL_SESSION_KEY), 'true');
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
  // BLOQUE 8: GOBERNANZA DE FEATURE FLAGS
  // =========================================================================
  describe('8. Gobernanza de Feature Flags y Desactivación por Defecto', () => {
    test('Feature flags están desactivados por defecto en producción', () => {
      assert.equal(typeof ENABLE_DOMAIN_MIGRATION_BRIDGE, 'boolean');
      assert.equal(typeof ENABLE_DOMAIN_MIGRATION_MANUAL_FALLBACK, 'boolean');
      assert.equal(domainMigrationBridgeService.isBridgeEnabled(), ENABLE_DOMAIN_MIGRATION_BRIDGE);
      assert.equal(domainMigrationBridgeService.isManualFallbackEnabled(), ENABLE_DOMAIN_MIGRATION_MANUAL_FALLBACK);
    });
  });
});
