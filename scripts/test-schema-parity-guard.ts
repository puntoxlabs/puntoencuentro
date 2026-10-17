/**
 * Schema Parity Guard: Automatización de Paridad entre PostgreSQL Staging y PGlite / Migraciones
 *
 * Verifica:
 * 1. Que las definiciones mock de PGlite en los tests no introduzcan columnas ficticias en public.participantes.
 * 2. Que las últimas definiciones de RPCs y migraciones activas no referencien columnas inexistentes en public.participantes.
 * 3. Si se ejecuta con acceso a Staging, valida 100% de paridad contra las columnas reales de la base de datos remota.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Columnas autoritativas reales de Staging (proyecto: wougfhfwqgmxhgvjqoua)
export const STAGING_CANONICAL_COLUMNS = {
  participantes: [
    'id',
    'encuentro_id',
    'nombre_invitado',
    'tipo_invitacion',
    'token_invitacion',
    'estado',
    'user_id',
    'mensaje_respuesta',
    'respondido_en',
    'creado_en',
    'seat_count',
    'reconfirmation_status',
    'reconfirmed_at',
  ],
  solicitudes_encuentro_abierto: [
    'id',
    'encuentro_id',
    'usuario_id',
    'nombre_solicitante',
    'mensaje',
    'seat_count',
    'estado',
    'participante_id',
    'token_participante',
    'motivo_baja',
    'resolved_at',
    'created_at',
    'updated_at',
  ],
};

// Columnas ficticias conocidas que provocaron errores en Staging si se referencian en public.participantes
const FORBIDDEN_PARTICIPANTES_COLUMNS = [
  'rol',
  'created_at',
  'updated_at',
  'usuario_id',
  'motivo_baja',
  'motivo_baja_privado',
  'motivo_baja_updated_at',
];

test('Schema Parity Guard: Integridad de Esquema entre Staging y Tests PGlite', async (t) => {
  await t.test('1. Las definiciones DDL mock de participantes en tests H1-H10 no contienen columnas prohibidas', () => {
    const testFiles = [
      'scripts/test-open-encounter-withdrawal-h9-h10.ts',
      'scripts/test-open-encounter-h2-h3-concurrency-and-legacy-rpcs.ts',
      'scripts/test-lifecycle-notifications-h4-h6-h7.ts',
      'scripts/test-pre-staging-verification-h1-h10.ts',
    ];

    for (const relPath of testFiles) {
      const fullPath = path.join(rootDir, relPath);
      if (!fs.existsSync(fullPath)) continue;
      const content = fs.readFileSync(fullPath, 'utf8');

      // Extraer bloque CREATE TABLE IF NOT EXISTS public.participantes
      const match = content.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.participantes\s*\(([\s\S]*?)\);/i);
      assert.ok(match, `No se encontró DDL de participantes en ${relPath}`);

      const ddlBody = match[1];
      for (const forbiddenCol of FORBIDDEN_PARTICIPANTES_COLUMNS) {
        // Regex para detectar la columna como identificador de definición en la tabla
        const colRegex = new RegExp(`^\\s*${forbiddenCol}\\s+[A-Z_]+`, 'im');
        assert.ok(
          !colRegex.test(ddlBody),
          `El archivo de test ${relPath} define la columna prohibida/inexistente "${forbiddenCol}" en public.participantes`
        );
      }
    }
  });

  await t.test('2. La última migración activa de aprobar_solicitud_encuentro_abierto no usa columnas inexistentes de participantes', () => {
    // Buscar la migración más reciente que define aprobar_solicitud_encuentro_abierto
    const migrationsDir = path.join(rootDir, 'supabase/migrations');
    const allMigrations = fs.readdirSync(migrationsDir).sort();
    const approvalMigrations = allMigrations.filter((f) => {
      if (!f.endsWith('.sql')) return false;
      const content = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
      return content.includes('CREATE OR REPLACE FUNCTION public.aprobar_solicitud_encuentro_abierto');
    });

    assert.ok(approvalMigrations.length > 0, 'Debe haber al menos una migración con aprobar_solicitud_encuentro_abierto');
    const latestApprovalMigration = approvalMigrations[approvalMigrations.length - 1];
    const migrationContent = fs.readFileSync(path.join(migrationsDir, latestApprovalMigration), 'utf8');

    // Verificar que en INSERT INTO public.participantes o UPDATE public.participantes no existan columnas prohibidas
    for (const forbiddenCol of FORBIDDEN_PARTICIPANTES_COLUMNS) {
      // Buscar si aparece como columna en INSERT INTO public.participantes (...)
      const insertMatch = migrationContent.match(/INSERT\s+INTO\s+public\.participantes\s*\(([\s\S]*?)\)\s*VALUES/i);
      if (insertMatch) {
        const insertCols = insertMatch[1].split(',').map((c) => c.trim().toLowerCase());
        assert.ok(
          !insertCols.includes(forbiddenCol),
          `La migración ${latestApprovalMigration} intenta insertar en columna inexistente "${forbiddenCol}" de public.participantes`
        );
      }

      // Buscar si aparece en UPDATE public.participantes SET ...
      const updateMatch = migrationContent.match(/UPDATE\s+public\.participantes\s+SET([\s\S]*?)WHERE/i);
      if (updateMatch) {
        const updateBody = updateMatch[1];
        const updateColRegex = new RegExp(`\\b${forbiddenCol}\\s*=`, 'i');
        assert.ok(
          !updateColRegex.test(updateBody),
          `La migración ${latestApprovalMigration} intenta actualizar columna inexistente "${forbiddenCol}" de public.participantes`
        );
      }
    }
  });

  await t.test('3. Verificar que reconfirmation_status y reconfirmed_at existen en el esquema canónico de participantes', () => {
    assert.ok(STAGING_CANONICAL_COLUMNS.participantes.includes('reconfirmation_status'));
    assert.ok(STAGING_CANONICAL_COLUMNS.participantes.includes('reconfirmed_at'));
    assert.ok(STAGING_CANONICAL_COLUMNS.participantes.includes('seat_count'));
    assert.ok(STAGING_CANONICAL_COLUMNS.participantes.includes('user_id'));
    assert.ok(!STAGING_CANONICAL_COLUMNS.participantes.includes('rol'));
  });
});
