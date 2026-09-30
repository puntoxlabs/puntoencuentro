import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-C1 (T2): Preservación de evidencia de moderación en reportes_encuentro', () => {
  let db;
  const hostUser = '11111111-1111-1111-1111-111111111111';
  const applicantUser = '22222222-2222-2222-2222-222222222222';
  const otherApplicantUser = '22222222-2222-2222-2222-333333333333';
  const thirdPartyUser = '33333333-3333-3333-3333-333333333333';

  let encounterWithoutReportId;
  let solicitudWithoutReportId;

  let encounterWithReportId;
  let solicitudWithReportId;
  let reportId;

  before(async () => {
    db = new PGlite();

    // 1. Setup base tables & functions
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

      INSERT INTO auth.users (id, email, created_at) VALUES
        ('${hostUser}', 'host@test.com', '2026-03-10 12:00:00Z'),
        ('${applicantUser}', 'applicant@test.com', '2026-07-20 14:30:00Z'),
        ('${otherApplicantUser}', 'otherapplicant@test.com', '2026-07-22 14:30:00Z'),
        ('${thirdPartyUser}', 'other@test.com', '2026-08-01 09:00:00Z')
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
        host_id UUID NOT NULL,
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha DATE,
        hora TIME,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        lugar_texto TEXT,
        link_virtual TEXT,
        public_token UUID NOT NULL DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'activo',
        is_open BOOLEAN NOT NULL DEFAULT false,
        open_description TEXT,
        open_public_zone TEXT,
        max_participants INT,
        duration_minutes INT,
        post_event_active_minutes INT NOT NULL DEFAULT 45,
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        locality_id TEXT REFERENCES public.localidades(id),
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        nombre TEXT NOT NULL,
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.participante_disponibilidades (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        participante_id UUID REFERENCES public.participantes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS public.encuentro_opciones_fecha (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL,
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        estado TEXT NOT NULL DEFAULT 'pending',
        participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
        token_participante UUID,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        resolved_at TIMESTAMPTZ
      );

      -- RPC eliminar_encuentro_seguro simulada según implementación de producción
      CREATE OR REPLACE FUNCTION public.eliminar_encuentro_seguro(
        p_encuentro_id uuid,
        p_host_id uuid
      )
      RETURNS json
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $$
      DECLARE
        v_user_id uuid := auth.uid();
        v_encuentro public.encuentros%ROWTYPE;
      BEGIN
        IF v_user_id IS NULL THEN
          RETURN json_build_object('ok', false, 'error', 'unauthorized');
        END IF;

        SELECT * INTO v_encuentro FROM public.encuentros WHERE id = p_encuentro_id;
        IF NOT FOUND THEN
          RETURN json_build_object('ok', false, 'error', 'not_found');
        END IF;

        IF v_encuentro.host_id <> v_user_id THEN
          RETURN json_build_object('ok', false, 'error', 'unauthorized');
        END IF;

        DELETE FROM public.participante_disponibilidades WHERE encuentro_id = p_encuentro_id;
        DELETE FROM public.encuentro_opciones_fecha WHERE encuentro_id = p_encuentro_id;
        DELETE FROM public.participantes WHERE encuentro_id = p_encuentro_id;
        DELETE FROM public.encuentros WHERE id = p_encuentro_id;

        RETURN json_build_object('ok', true, 'id', p_encuentro_id);
      END;
      $$;
    `);

    // 2. Aplicar migraciones históricas de reportes
    const mig1 = path.resolve(process.cwd(), 'supabase/migrations/20260930130000_fase_20c1_trust_contextual_reports.sql');
    await db.exec(fs.readFileSync(mig1, 'utf-8'));

    const mig2 = path.resolve(process.cwd(), 'supabase/migrations/20260930133000_fix_fase_20c1_trust_report_context_and_temporal.sql');
    await db.exec(fs.readFileSync(mig2, 'utf-8'));

    // 3. Aplicar la nueva migración aditiva de preservación de reportes
    const mig3 = path.resolve(process.cwd(), 'supabase/migrations/20260930140000_fix_fase_20c1_trust_preserve_reports_on_delete.sql');
    await db.exec(fs.readFileSync(mig3, 'utf-8'));

    // 4. Crear fixtures
    // Caso 1: Encuentro y solicitud sin reportes
    const resEnc1 = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora, duration_minutes)
      VALUES ('${hostUser}', 'Encuentro Sin Reporte', true, now(), CURRENT_DATE + interval '5 days', '19:00', 90)
      RETURNING id;
    `);
    encounterWithoutReportId = resEnc1.rows[0].id;

    const resSol1 = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encounterWithoutReportId}', '${applicantUser}', 'Applicant Sin Reporte', 'pending')
      RETURNING id;
    `);
    solicitudWithoutReportId = resSol1.rows[0].id;

    // Caso 2: Encuentro y solicitud con reporte creado
    const resEnc2 = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora, duration_minutes)
      VALUES ('${hostUser}', 'Encuentro Con Reporte', true, now(), CURRENT_DATE + interval '5 days', '19:00', 90)
      RETURNING id;
    `);
    encounterWithReportId = resEnc2.rows[0].id;

    const resSol2 = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encounterWithReportId}', '${applicantUser}', 'Applicant Con Reporte', 'pending')
      RETURNING id;
    `);
    solicitudWithReportId = resSol2.rows[0].id;

    // Insertar reporte usando crear_reporte_seguro con el host autenticado
    await db.exec(`SET request.jwt.claim.sub = '${hostUser}';`);
    await db.exec(`SET request.jwt.claims = '{"sub": "${hostUser}", "is_anonymous": false}';`);
    const resRpc = await db.query(`
      SELECT public.crear_reporte_seguro(
        '${solicitudWithReportId}'::uuid,
        'pre_solicitud',
        'commercial_spam',
        'Detalle de spam'
      ) as result;
    `);
    assert.equal(resRpc.rows[0].result.ok, true);

    const resRep = await db.query(`SELECT id FROM public.reportes_encuentro WHERE solicitud_id = '${solicitudWithReportId}';`);
    assert.equal(resRep.rows.length, 1);
    reportId = resRep.rows[0].id;
  });

  // A. encuentro sin reporte → comportamiento de borrado previo preservado.
  test('A. Encuentro sin reporte: eliminación normal funciona y se preserva el comportamiento previo', async () => {
    // Actuar como host
    await db.exec(`SET request.jwt.claim.sub = '${hostUser}';`);
    await db.exec(`SET request.jwt.claims = '{"sub": "${hostUser}", "is_anonymous": false}';`);

    const res = await db.query(`
      SELECT public.eliminar_encuentro_seguro('${encounterWithoutReportId}'::uuid, '${hostUser}'::uuid) as result;
    `);
    assert.equal(res.rows[0].result.ok, true);
    assert.equal(res.rows[0].result.id, encounterWithoutReportId);

    // Verificar que encuentro y solicitud fueron eliminados
    const checkEnc = await db.query(`SELECT * FROM public.encuentros WHERE id = '${encounterWithoutReportId}';`);
    assert.equal(checkEnc.rows.length, 0);

    const checkSol = await db.query(`SELECT * FROM public.solicitudes_encuentro_abierto WHERE id = '${solicitudWithoutReportId}';`);
    assert.equal(checkSol.rows.length, 0);
  });

  // B. encuentro con reporte → DELETE rechazado; reporte permanece.
  test('B. Encuentro con reporte: DELETE físico de encuentro es RECHAZADO por RESTRICT y reporte permanece intacto', async () => {
    // Intento 1: Vía RPC eliminar_encuentro_seguro
    await db.exec(`SET request.jwt.claim.sub = '${hostUser}';`);
    await db.exec(`SET request.jwt.claims = '{"sub": "${hostUser}", "is_anonymous": false}';`);

    await assert.rejects(
      async () => {
        await db.query(`
          SELECT public.eliminar_encuentro_seguro('${encounterWithReportId}'::uuid, '${hostUser}'::uuid);
        `);
      },
      (err) => {
        assert.match(err.message, /violates foreign key constraint|reportes_encuentro/);
        return true;
      },
      'Debe fallar con violación de foreign key restrict'
    );

    // Intento 2: Direct DELETE sobre encuentros
    await assert.rejects(
      async () => {
        await db.query(`DELETE FROM public.encuentros WHERE id = '${encounterWithReportId}';`);
      },
      (err) => {
        assert.match(err.message, /violates foreign key constraint|reportes_encuentro/);
        return true;
      }
    );

    // Verificar que el reporte y el encuentro siguen intactos
    const checkRep = await db.query(`SELECT * FROM public.reportes_encuentro WHERE id = '${reportId}';`);
    assert.equal(checkRep.rows.length, 1);
    assert.equal(checkRep.rows[0].estado, 'pending');

    const checkEnc = await db.query(`SELECT * FROM public.encuentros WHERE id = '${encounterWithReportId}';`);
    assert.equal(checkEnc.rows.length, 1);
  });

  // C. solicitud con reporte → DELETE rechazado; reporte permanece.
  test('C. Solicitud con reporte: DELETE físico de solicitud es RECHAZADO por RESTRICT y reporte permanece', async () => {
    await assert.rejects(
      async () => {
        await db.query(`DELETE FROM public.solicitudes_encuentro_abierto WHERE id = '${solicitudWithReportId}';`);
      },
      (err) => {
        assert.match(err.message, /violates .*foreign key constraint "reportes_encuentro_solicitud_id_fkey"/);
        return true;
      }
    );

    // Reporte permanece
    const checkRep = await db.query(`SELECT * FROM public.reportes_encuentro WHERE id = '${reportId}';`);
    assert.equal(checkRep.rows.length, 1);
  });

  // D. reporter con reporte → DELETE rechazado.
  test('D. Reporter con reporte: DELETE físico de usuario en auth.users es RECHAZADO por RESTRICT', async () => {
    await assert.rejects(
      async () => {
        await db.query(`DELETE FROM auth.users WHERE id = '${hostUser}';`);
      },
      (err) => {
        assert.match(err.message, /violates .*foreign key constraint "reportes_encuentro_reporter_id_fkey"/);
        return true;
      }
    );

    // Reporte permanece
    const checkRep = await db.query(`SELECT * FROM public.reportes_encuentro WHERE id = '${reportId}';`);
    assert.equal(checkRep.rows.length, 1);
  });

  // E. reported con reporte → DELETE rechazado.
  test('E. Reported con reporte: DELETE físico de usuario reportado en auth.users es RECHAZADO por RESTRICT', async () => {
    await assert.rejects(
      async () => {
        await db.query(`DELETE FROM auth.users WHERE id = '${applicantUser}';`);
      },
      (err) => {
        assert.match(err.message, /violates .*foreign key constraint "reportes_encuentro_reported_id_fkey"/);
        return true;
      }
    );

    // Reporte permanece
    const checkRep = await db.query(`SELECT * FROM public.reportes_encuentro WHERE id = '${reportId}';`);
    assert.equal(checkRep.rows.length, 1);
  });

  // F. UPDATE de estado de solicitud (pending/rejected/withdrawn/approved) → sigue permitido; reporte permanece.
  test('F. UPDATE de estado de solicitud (pending -> approved -> rejected -> withdrawn): sigue permitido y reporte permanece', async () => {
    for (const estado of ['approved', 'rejected', 'withdrawn', 'pending']) {
      await db.query(`
        UPDATE public.solicitudes_encuentro_abierto
        SET estado = '${estado}', updated_at = now()
        WHERE id = '${solicitudWithReportId}';
      `);

      const sol = await db.query(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${solicitudWithReportId}';`);
      assert.equal(sol.rows[0].estado, estado);

      const rep = await db.query(`SELECT estado FROM public.reportes_encuentro WHERE id = '${reportId}';`);
      assert.equal(rep.rows.length, 1);
      assert.equal(rep.rows[0].estado, 'pending');
    }
  });

  // G. crear_reporte_seguro → sigue funcionando normalmente.
  test('G. crear_reporte_seguro: sigue funcionando normalmente con las nuevas constraints RESTRICT', async () => {
    // Crear un nuevo encuentro y solicitud
    const resEnc = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora, duration_minutes)
      VALUES ('${hostUser}', 'Otro Encuentro', true, now(), CURRENT_DATE + interval '3 days', '18:00', 60)
      RETURNING id;
    `);
    const newEncId = resEnc.rows[0].id;

    const resSol = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${newEncId}', '${otherApplicantUser}', 'Other Applicant', 'pending')
      RETURNING id;
    `);
    const newSolId = resSol.rows[0].id;

    // Crear reporte
    await db.exec(`SET request.jwt.claim.sub = '${hostUser}';`);
    await db.exec(`SET request.jwt.claims = '{"sub": "${hostUser}", "is_anonymous": false}';`);

    const resRpc = await db.query(`
      SELECT public.crear_reporte_seguro(
        '${newSolId}'::uuid,
        'pre_solicitud',
        'inappropriate_behavior',
        'Mensaje hostil'
      ) as result;
    `);
    assert.equal(resRpc.rows[0].result.ok, true);
    assert.equal(resRpc.rows[0].result.estado, 'pending');

    const resRep = await db.query(`
      SELECT * FROM public.reportes_encuentro
      WHERE solicitud_id = '${newSolId}' AND contexto = 'pre_solicitud';
    `);
    assert.equal(resRep.rows.length, 1);
    assert.equal(resRep.rows[0].motivo, 'inappropriate_behavior');
    assert.equal(resRep.rows[0].reported_id, otherApplicantUser);
    assert.equal(resRep.rows[0].reporter_id, hostUser);
  });
});
