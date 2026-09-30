import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-C1 (T4-B1): Trazabilidad Mínima de Moderación para Soft Launch', () => {
  let db: PGlite;
  const hostUser = '11111111-1111-1111-1111-111111111111';
  const applicantUser = '22222222-2222-2222-2222-222222222222';
  const operatorUser = '99999999-9999-9999-9999-999999999999';

  let encounterId: string;
  let solicitudId: string;
  let existingReportId: string;

  before(async () => {
    db = new PGlite();

    // 1. Setup base roles, schemas and tables
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT,
        created_at TIMESTAMPTZ DEFAULT '2026-05-15 10:00:00Z'
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
      $$ LANGUAGE SQL STABLE;

      INSERT INTO auth.users (id, email) VALUES
        ('${hostUser}', 'host@test.com'),
        ('${applicantUser}', 'applicant@test.com'),
        ('${operatorUser}', 'operator@test.com')
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.localidades (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        ciudad TEXT NOT NULL,
        zona TEXT NOT NULL,
        pais TEXT NOT NULL DEFAULT 'AR',
        orden INT NOT NULL DEFAULT 1,
        activo BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL,
        fecha DATE,
        hora TIME,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        estado TEXT NOT NULL DEFAULT 'activo',
        is_open BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id),
        usuario_id UUID NOT NULL REFERENCES auth.users(id),
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        estado TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );
    `);

    // 2. Ejecutar migración histórica T2 de creación de reportes
    const t2MigrationPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20260930130000_fase_20c1_trust_contextual_reports.sql'
    );
    const t2Sql = fs.readFileSync(t2MigrationPath, 'utf-8');
    await db.exec(t2Sql);

    // 3. Ejecutar migración histórica de preservación RESTRICT
    const preservationPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20260930140000_fix_fase_20c1_trust_preserve_reports_on_delete.sql'
    );
    const preservationSql = fs.readFileSync(preservationPath, 'utf-8');
    await db.exec(preservationSql);

    // 4. Crear datos base y un reporte pending previo a la migración T4-B1
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, fecha, hora, modalidad, estado, is_open)
      VALUES ('${hostUser}', 'Encuentro Test Moderación', '2026-10-25', '18:00:00', 'presencial', 'activo', true)
      RETURNING id;
    `);
    encounterId = encRes.rows[0].id;

    const solRes = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, mensaje, estado)
      VALUES ('${encounterId}', '${applicantUser}', 'Solicitante Test', 'Quiero unirme', 'pending')
      RETURNING id;
    `);
    solicitudId = solRes.rows[0].id;

    const repRes = await db.query<{ id: string }>(`
      INSERT INTO public.reportes_encuentro (solicitud_id, encuentro_id, reporter_id, reported_id, contexto, motivo, detalle, estado)
      VALUES ('${solicitudId}', '${encounterId}', '${hostUser}', '${applicantUser}', 'pre_solicitud', 'commercial_spam', 'Detalle previo', 'pending')
      RETURNING id;
    `);
    existingReportId = repRes.rows[0].id;

    // 5. Aplicar la nueva migración aditiva T4-B1
    const t4b1MigrationPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20260930190000_fase_20c1_trust_moderation_soft_launch_audit.sql'
    );
    const t4b1Sql = fs.readFileSync(t4b1MigrationPath, 'utf-8');
    await db.exec(t4b1Sql);
  });

  test('A. Reporte pending existente antes de la migración sigue siendo válido', async () => {
    const res = await db.query<{ id: string; estado: string; reviewed_at: string | null; resolved_at: string | null }>(`
      SELECT id, estado, reviewed_at, resolved_at FROM public.reportes_encuentro WHERE id = '${existingReportId}';
    `);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].estado, 'pending');
    assert.equal(res.rows[0].reviewed_at, null);
    assert.equal(res.rows[0].resolved_at, null);
  });

  test('B. Pending con reviewed_at no nulo pero reviewed_by null es rechazado', async () => {
    await assert.rejects(
      async () => {
        await db.query(`
          UPDATE public.reportes_encuentro
          SET reviewed_at = now(), reviewed_by = NULL
          WHERE id = '${existingReportId}';
        `);
      },
      /reportes_encuentro_reviewed_pair/
    );
  });

  test('C. Reviewed sin metadata reviewed_at/by es rechazado', async () => {
    await assert.rejects(
      async () => {
        await db.query(`
          UPDATE public.reportes_encuentro
          SET estado = 'reviewed', reviewed_at = NULL, reviewed_by = NULL
          WHERE id = '${existingReportId}';
        `);
      },
      /reportes_encuentro_estado_coherence/
    );
  });

  test('D. Reviewed con metadata válida es aceptado', async () => {
    await db.query(`
      UPDATE public.reportes_encuentro
      SET estado = 'reviewed', reviewed_at = now(), reviewed_by = '${operatorUser}'
      WHERE id = '${existingReportId}';
    `);

    const res = await db.query<{ estado: string; reviewed_by: string }>(`
      SELECT estado, reviewed_by FROM public.reportes_encuentro WHERE id = '${existingReportId}';
    `);
    assert.equal(res.rows[0].estado, 'reviewed');
    assert.equal(res.rows[0].reviewed_by, operatorUser);
  });

  test('E. Dismissed sin review o sin resolution metadata es rechazado', async () => {
    // Falta resolved_at/by
    await assert.rejects(
      async () => {
        await db.query(`
          UPDATE public.reportes_encuentro
          SET estado = 'dismissed', resolved_at = NULL, resolved_by = NULL
          WHERE id = '${existingReportId}';
        `);
      },
      /reportes_encuentro_estado_coherence/
    );
  });

  test('F. Actioned sin resolution metadata es rechazado', async () => {
    await assert.rejects(
      async () => {
        await db.query(`
          UPDATE public.reportes_encuentro
          SET estado = 'actioned', resolved_at = NULL, resolved_by = NULL
          WHERE id = '${existingReportId}';
        `);
      },
      /reportes_encuentro_estado_coherence/
    );
  });

  test('G. Dismissed correcto (con review y resolution metadata) es aceptado', async () => {
    await db.query(`
      UPDATE public.reportes_encuentro
      SET estado = 'dismissed',
          resolved_at = now(),
          resolved_by = '${operatorUser}',
          resolution_note = 'Reporte evaluado: desacuerdo ordinario sin infracción.'
      WHERE id = '${existingReportId}';
    `);

    const res = await db.query<{ estado: string; resolution_note: string }>(`
      SELECT estado, resolution_note FROM public.reportes_encuentro WHERE id = '${existingReportId}';
    `);
    assert.equal(res.rows[0].estado, 'dismissed');
    assert.equal(res.rows[0].resolution_note, 'Reporte evaluado: desacuerdo ordinario sin infracción.');
  });

  test('H. Transición directa pending -> actioned con timestamps idénticos es aceptada', async () => {
    // Crear un nuevo reporte pending
    const repRes = await db.query<{ id: string }>(`
      INSERT INTO public.reportes_encuentro (
        solicitud_id, encuentro_id, reporter_id, reported_id, contexto, motivo, detalle, estado
      ) VALUES (
        '${solicitudId}', '${encounterId}', '${applicantUser}', '${hostUser}', 'post_encuentro', 'safety_concern', 'Comportamiento de riesgo', 'pending'
      ) RETURNING id;
    `);
    const newReportId = repRes.rows[0].id;

    // Transición directa a actioned
    const nowIso = new Date().toISOString();
    await db.query(`
      UPDATE public.reportes_encuentro
      SET estado = 'actioned',
          reviewed_at = '${nowIso}',
          reviewed_by = '${operatorUser}',
          resolved_at = '${nowIso}',
          resolved_by = '${operatorUser}',
          resolution_note = 'Contacto realizado con ambas partes. Registro archivado.'
      WHERE id = '${newReportId}';
    `);

    const check = await db.query<{ estado: string; resolution_note: string }>(`
      SELECT estado, resolution_note FROM public.reportes_encuentro WHERE id = '${newReportId}';
    `);
    assert.equal(check.rows[0].estado, 'actioned');
    assert.equal(check.rows[0].resolution_note, 'Contacto realizado con ambas partes. Registro archivado.');
  });

  test('I. resolution_note superior a 2000 caracteres es rechazada', async () => {
    const longNote = 'A'.repeat(2001);
    await assert.rejects(
      async () => {
        await db.query(`
          UPDATE public.reportes_encuentro
          SET resolution_note = '${longNote}'
          WHERE id = '${existingReportId}';
        `);
      },
      /reportes_encuentro_resolution_note_length/
    );
  });

  test('J. Role authenticated no tiene permisos de SELECT ni UPDATE directo', async () => {
    // Ejecutar como role authenticated
    await db.exec(`SET ROLE authenticated;`);
    try {
      await assert.rejects(
        async () => {
          await db.query(`SELECT * FROM public.reportes_encuentro;`);
        },
        /permission denied/
      );

      await assert.rejects(
        async () => {
          await db.query(`UPDATE public.reportes_encuentro SET estado = 'reviewed';`);
        },
        /permission denied/
      );
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  });

  test('K. Role anon no tiene acceso a reportes_encuentro', async () => {
    await db.exec(`SET ROLE anon;`);
    try {
      await assert.rejects(
        async () => {
          await db.query(`SELECT * FROM public.reportes_encuentro;`);
        },
        /permission denied/
      );
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  });

  test('L. FK ON DELETE RESTRICT impide borrar cuenta auth.users del operador asignado', async () => {
    await assert.rejects(
      async () => {
        await db.query(`DELETE FROM auth.users WHERE id = '${operatorUser}';`);
      },
      /foreign key constraint/
    );
  });

  test('M. Índice de cola operativa (estado, created_at) existe', async () => {
    const res = await db.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'reportes_encuentro' AND indexname = 'idx_reportes_encuentro_estado_created';
    `);
    assert.equal(res.rows.length, 1, 'Debe existir idx_reportes_encuentro_estado_created');
  });
});
