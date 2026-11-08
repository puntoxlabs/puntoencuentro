/**
 * Pruebas de Seguridad y Pertenencia Estricta del Manifiesto de Emergencia
 * Mini-Sprint 2B-4 (PR #7)
 *
 * Valida:
 * 1. Firma criptográfica de procedencia (HMAC SHA-256) contra manipulación manual.
 * 2. Rechazo de UUIDs ajenos o cuentas permanentes reales no-QA.
 * 3. Rechazo de referencias mixtas (fallo cerrado / all-or-nothing).
 * 4. Preservación del manifiesto y aborto seguro ante incertidumbre.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  computeManifestSignature,
  verifyManifestProvenance,
  verifyFixtureOwnership,
  cleanAuthorizedManifest,
} from './emergency-bridge-killswitch-reset.ts';

const TEST_SECRET = 'sb_secret_staging_test_mock_secret_key_12345';

describe('Endurecimiento de Procedencia y Pertenencia de Fixtures (PR #7)', () => {
  const validRunId = 'bridge-e2e-1794159999999-a1b2c3d4';
  const validUser1 = crypto.randomUUID();
  const validUser2 = crypto.randomUUID();
  const validEncounter1 = crypto.randomUUID();
  const validTicketHash1 = crypto.randomBytes(32).toString('hex');

  // -------------------------------------------------------------------------
  // 1. Verificación de Procedencia Criptográfica
  // -------------------------------------------------------------------------
  test('1.1 Manifiesto legítimo firmado por el runner aprueba la verificación', () => {
    const sig = computeManifestSignature(
      validRunId,
      [validUser1, validUser2],
      [validEncounter1],
      [validTicketHash1],
      TEST_SECRET
    );

    const manifest = {
      runId: validRunId,
      timestamp: new Date().toISOString(),
      trackedUserIds: [validUser1, validUser2],
      trackedEncounterIds: [validEncounter1],
      trackedTicketHashes: [validTicketHash1],
      provenanceSignature: sig,
    };

    const res = verifyManifestProvenance(manifest, TEST_SECRET);
    assert.equal(res.valid, true, 'El manifiesto legítimo debió ser válido');
  });

  test('1.2 PRUEBA NEGATIVA: Manifiesto manipulado manualmente (inyección de UUID) es rechazado', () => {
    const legitimateSig = computeManifestSignature(
      validRunId,
      [validUser1],
      [validEncounter1],
      [validTicketHash1],
      TEST_SECRET
    );

    // Atacante o script manual inyecta un segundo UUID de usuario en el JSON sin conocer la clave secreta
    const injectedUser = crypto.randomUUID();
    const tamperedManifest = {
      runId: validRunId,
      timestamp: new Date().toISOString(),
      trackedUserIds: [validUser1, injectedUser], // Manipulado
      trackedEncounterIds: [validEncounter1],
      trackedTicketHashes: [validTicketHash1],
      provenanceSignature: legitimateSig, // Firma previa original
    };

    const res = verifyManifestProvenance(tamperedManifest, TEST_SECRET);
    assert.equal(res.valid, false, 'El manifiesto manipulado debió ser rechazado');
    assert.match(res.error || '', /Firma criptográfica inválida/i);
  });

  test('1.3 PRUEBA NEGATIVA: Manifiesto sin firma de procedencia es rechazado', () => {
    const unsignedManifest = {
      runId: validRunId,
      timestamp: new Date().toISOString(),
      trackedUserIds: [validUser1],
      trackedEncounterIds: [validEncounter1],
      trackedTicketHashes: [validTicketHash1],
    };

    const res = verifyManifestProvenance(unsignedManifest, TEST_SECRET);
    assert.equal(res.valid, false);
    assert.match(res.error || '', /Falta la firma criptográfica/i);
  });

  test('1.4 PRUEBA NEGATIVA: Formato de runId malformado es rechazado inmediatamente', () => {
    const malformedRunId = 'malicious-run-exploit-123';
    const sig = computeManifestSignature(
      malformedRunId,
      [validUser1],
      [],
      [],
      TEST_SECRET
    );

    const badManifest = {
      runId: malformedRunId,
      timestamp: new Date().toISOString(),
      trackedUserIds: [validUser1],
      trackedEncounterIds: [],
      trackedTicketHashes: [],
      provenanceSignature: sig,
    };

    const res = verifyManifestProvenance(badManifest, TEST_SECRET);
    assert.equal(res.valid, false);
    assert.match(res.error || '', /runId inválido/i);
  });

  // -------------------------------------------------------------------------
  // 2. Verificación de Pertenencia Estricta contra la Base de Datos
  // -------------------------------------------------------------------------
  test('2.1 Fixtures legítimos (anónimo o qa-host@puntoencuentro.test) aprueban pertenencia', async () => {
    const mockAdminClient = {
      auth: {
        admin: {
          getUserById: async (uid: string) => {
            if (uid === validUser1) {
              return { data: { user: { id: validUser1, is_anonymous: true } }, error: null };
            }
            if (uid === validUser2) {
              return {
                data: {
                  user: {
                    id: validUser2,
                    is_anonymous: false,
                    email: 'qa-host-179415-abcd@puntoencuentro.test',
                  },
                },
                error: null,
              };
            }
            return { data: { user: null }, error: { message: 'User not found' } };
          },
        },
      },
      from: (table: string) => ({
        select: () => ({
          in: async () => ({
            data: [
              {
                id: validEncounter1,
                host_id: validUser1,
                titulo: `Fixture E2E Bridge [${validRunId}]`,
                descripcion: `Fixture E2E [runId: ${validRunId}]`,
              },
            ],
            error: null,
          }),
        }),
      }),
    };

    const res = await verifyFixtureOwnership(mockAdminClient, validRunId, [validUser1, validUser2], [validEncounter1]);
    assert.equal(res.authorized, true, 'Los fixtures conformes debieron ser autorizados');
  });

  test('2.2 PRUEBA NEGATIVA: Cuenta permanente real/ajena (no anónima, no QA test) es rechazada', async () => {
    const realUserUid = crypto.randomUUID();
    const mockAdminClient = {
      auth: {
        admin: {
          getUserById: async (uid: string) => {
            if (uid === realUserUid) {
              return {
                data: {
                  user: {
                    id: realUserUid,
                    is_anonymous: false,
                    email: 'director@puntoencuentro.com.ar', // Cuenta real no QA
                  },
                },
                error: null,
              };
            }
            return { data: { user: null }, error: null };
          },
        },
      },
      from: () => ({
        select: () => ({ in: async () => ({ data: [], error: null }) }),
      }),
    };

    const res = await verifyFixtureOwnership(mockAdminClient, validRunId, [realUserUid], []);
    assert.equal(res.authorized, false, 'Cuenta real no QA debió ser rechazada');
    assert.match(res.error || '', /cuenta real o no autorizada/i);
  });

  test('2.3 PRUEBA NEGATIVA: Encuentro ajeno perteneciente a otro host es rechazado', async () => {
    const foreignHostUid = crypto.randomUUID();
    const foreignEncounterId = crypto.randomUUID();

    const mockAdminClient = {
      auth: {
        admin: {
          getUserById: async (uid: string) => ({
            data: { user: { id: uid, is_anonymous: true } },
            error: null,
          }),
        },
      },
      from: (table: string) => ({
        select: () => ({
          in: async () => ({
            data: [
              {
                id: foreignEncounterId,
                host_id: foreignHostUid, // Host ajeno, NO en userIds del run
                titulo: 'Cumpleaños Familiar Privado', // Sin marcas QA
                descripcion: 'Encuentro real de usuario ajeno',
              },
            ],
            error: null,
          }),
        }),
      }),
    };

    const res = await verifyFixtureOwnership(mockAdminClient, validRunId, [validUser1], [foreignEncounterId]);
    assert.equal(res.authorized, false, 'Encuentro ajeno debió ser rechazado');
    assert.match(res.error || '', /no pertenece a los usuarios del run/i);
  });

  test('2.4 PRUEBA NEGATIVA: Referencias mixtas (válidas + 1 ajena) abortan la limpieza completa (fail-closed)', async () => {
    const foreignEncounterId = crypto.randomUUID();
    const mockAdminClient = {
      auth: {
        admin: {
          getUserById: async (uid: string) => ({
            data: { user: { id: uid, is_anonymous: true } },
            error: null,
          }),
        },
      },
      from: (table: string) => ({
        select: () => ({
          in: async () => ({
            data: [
              {
                id: validEncounter1,
                host_id: validUser1,
                titulo: `Fixture E2E Bridge [${validRunId}]`,
                descripcion: `Tagged runId: ${validRunId}`,
              },
              {
                id: foreignEncounterId,
                host_id: crypto.randomUUID(), // Host no autorizado
                titulo: 'Encuentro de Otro Entorno',
                descripcion: 'Sin tags',
              },
            ],
            error: null,
          }),
        }),
      }),
    };

    const res = await verifyFixtureOwnership(
      mockAdminClient,
      validRunId,
      [validUser1],
      [validEncounter1, foreignEncounterId] // Mixto
    );

    assert.equal(res.authorized, false, 'Lote mixto debe abortar completamente sin borrados parciales');
    assert.match(res.error || '', /no pertenece a los usuarios del run/i);
  });

  // -------------------------------------------------------------------------
  // 3. Prueba de cleanAuthorizedManifest con Manifiesto en Disco
  // -------------------------------------------------------------------------
  test('3.1 cleanAuthorizedManifest aborta y preserva el archivo si el manifiesto fue manipulado', async () => {
    const testTamperedRunId = 'bridge-e2e-1794158888888-c4d3e2f1';
    const manifestPath = path.resolve(process.cwd(), `recovery-manifest-staging-${testTamperedRunId}.json`);

    // Escribir archivo manipulado intencionalmente
    const tamperedPayload = {
      runId: testTamperedRunId,
      timestamp: new Date().toISOString(),
      trackedUserIds: [validUser1],
      trackedEncounterIds: [validEncounter1],
      trackedTicketHashes: [validTicketHash1],
      provenanceSignature: 'bad_signature_0000000000000000000000000000000000000000000000000000',
    };
    fs.writeFileSync(manifestPath, JSON.stringify(tamperedPayload, null, 2), 'utf8');

    let deleteCalled = false;
    const mockAdminClient = {
      from: () => ({
        delete: () => {
          deleteCalled = true;
          return { in: async () => ({ error: null }) };
        },
      }),
    };

    try {
      const ok = await cleanAuthorizedManifest(mockAdminClient, testTamperedRunId);
      assert.equal(ok, false, 'cleanAuthorizedManifest debió retornar false ante firma inválida');
      assert.equal(deleteCalled, false, 'No debió ejecutarse NINGÚN delete destructivo');
      assert.equal(fs.existsSync(manifestPath), true, 'El manifiesto debe preservarse para evidencia forense');
    } finally {
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
      }
    }
  });
});
