// scripts/test-fase-20c1-trust-reports-backend.ts
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
describe("Fase 2.0-C1 (T2-A): Almacenamiento seguro de reportes contextuales \u2014 Backend Tests", () => {
  let db;
  const hostUser = "11111111-1111-1111-1111-111111111111";
  const applicantUser = "22222222-2222-2222-2222-222222222222";
  const otherApplicantUser = "22222222-2222-2222-2222-333333333333";
  const thirdPartyUser = "33333333-3333-3333-3333-333333333333";
  const anonUser = "44444444-4444-4444-4444-444444444444";
  let futureEncuentroId;
  let futureSolicitudPendingId;
  let futureSolicitudRejectedId;
  let pastEncuentroWithin72hId;
  let pastSolicitudApprovedId;
  let pastSolicitudPendingId;
  let pastEncuentroBeyond72hId;
  let pastSolicitudBeyond72hApprovedId;
  let otherHostEncuentroId;
  let otherHostSolicitudId;
  before(async () => {
    db = new PGlite();
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
        ('${thirdPartyUser}', 'other@test.com', '2026-08-01 09:00:00Z'),
        ('${anonUser}', 'anon@test.com', '2026-09-01 10:00:00Z')
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

      INSERT INTO public.localidades (id, nombre, ciudad, zona) VALUES
        ('caba_palermo', 'Palermo', 'CABA', 'CABA Norte')
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
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

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL,
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        estado TEXT NOT NULL DEFAULT 'pending',
        participante_id UUID,
        token_participante UUID,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        resolved_at TIMESTAMPTZ
      );
    `);
    const migrationPath = path.resolve(
      process.cwd(),
      "supabase/migrations/20260930130000_fase_20c1_trust_contextual_reports.sql"
    );
    await db.exec(fs.readFileSync(migrationPath, "utf-8"));
    const resFut = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora, duration_minutes)
      VALUES ('${hostUser}', 'Encuentro Futuro', true, now(), CURRENT_DATE + interval '5 days', '19:00', 90)
      RETURNING id;
    `);
    futureEncuentroId = resFut.rows[0].id;
    const resSolFut1 = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${futureEncuentroId}', '${applicantUser}', 'Applicant User', 'pending')
      RETURNING id;
    `);
    futureSolicitudPendingId = resSolFut1.rows[0].id;
    const resSolFut2 = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${futureEncuentroId}', '${otherApplicantUser}', 'Other Applicant', 'rejected')
      RETURNING id;
    `);
    futureSolicitudRejectedId = resSolFut2.rows[0].id;
    const resPast72 = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora, duration_minutes)
      VALUES ('${hostUser}', 'Encuentro Pasado Reciente', true, now() - interval '2 days', CURRENT_DATE - interval '1 day', '10:00', 60)
      RETURNING id;
    `);
    pastEncuentroWithin72hId = resPast72.rows[0].id;
    const resSolPastApp = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${pastEncuentroWithin72hId}', '${applicantUser}', 'Applicant User', 'approved')
      RETURNING id;
    `);
    pastSolicitudApprovedId = resSolPastApp.rows[0].id;
    const resSolPastPend = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${pastEncuentroWithin72hId}', '${otherApplicantUser}', 'Other Applicant', 'pending')
      RETURNING id;
    `);
    pastSolicitudPendingId = resSolPastPend.rows[0].id;
    const resPastOld = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora, duration_minutes)
      VALUES ('${hostUser}', 'Encuentro Antiguo Vencido', true, now() - interval '10 days', CURRENT_DATE - interval '6 days', '10:00', 60)
      RETURNING id;
    `);
    pastEncuentroBeyond72hId = resPastOld.rows[0].id;
    const resSolPastOld = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${pastEncuentroBeyond72hId}', '${applicantUser}', 'Applicant User', 'approved')
      RETURNING id;
    `);
    pastSolicitudBeyond72hApprovedId = resSolPastOld.rows[0].id;
    const resOtherHost = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora, duration_minutes)
      VALUES ('${thirdPartyUser}', 'Encuentro Otro Host', true, now(), CURRENT_DATE + interval '3 days', '18:00', 60)
      RETURNING id;
    `);
    otherHostEncuentroId = resOtherHost.rows[0].id;
    const resOtherSol = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${otherHostEncuentroId}', '${applicantUser}', 'Applicant User', 'pending')
      RETURNING id;
    `);
    otherHostSolicitudId = resOtherSol.rows[0].id;
  });
  async function callCrearReporte(userId, isAnon, solicitudId, contexto, motivo, detalle) {
    await db.exec(`
      SET request.jwt.claim.sub = '${userId}';
      SET request.jwt.claims = '{"is_anonymous": ${isAnon}}';
    `);
    const detalleVal = detalle === void 0 ? "NULL" : `'${detalle.replace(/'/g, "''")}'`;
    const res = await db.query(`
      SELECT public.crear_reporte_seguro(
        '${solicitudId}',
        '${contexto}',
        '${motivo}',
        ${detalleVal}
      ) AS crear_reporte_seguro;
    `);
    return res.rows[0].crear_reporte_seguro;
  }
  test("PRE 1. Host leg\xEDtimo puede reportar al solicitante real en pre_solicitud", async () => {
    const res = await callCrearReporte(
      hostUser,
      false,
      futureSolicitudPendingId,
      "pre_solicitud",
      "commercial_spam",
      "Mensaje con enlaces comerciales sospechosos"
    );
    assert.equal(res.ok, true);
    assert.equal(res.estado, "pending");
  });
  test("PRE 2. Target se deriva server-side desde la solicitud (reported_id = applicant)", async () => {
    const rows = await db.query(`
      SELECT * FROM public.reportes_encuentro
      WHERE solicitud_id = '${futureSolicitudPendingId}'
        AND contexto = 'pre_solicitud';
    `);
    assert.equal(rows.rows.length, 1);
    const rep = rows.rows[0];
    assert.equal(rep.reporter_id, hostUser);
    assert.equal(rep.reported_id, applicantUser);
    assert.equal(rep.encuentro_id, futureEncuentroId);
    assert.equal(rep.motivo, "commercial_spam");
    assert.equal(rep.estado, "pending");
    assert.equal(rep.detalle, "Mensaje con enlaces comerciales sospechosos");
  });
  test("PRE 3. Solicitante NO puede reportar al host mediante pre_solicitud", async () => {
    const res = await callCrearReporte(
      applicantUser,
      false,
      futureSolicitudPendingId,
      "pre_solicitud",
      "safety_concern",
      "El host me parece sospechoso"
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "report_relationship_invalid");
  });
  test("PRE 4. Tercero ajeno es rechazado en pre_solicitud", async () => {
    const res = await callCrearReporte(
      thirdPartyUser,
      false,
      futureSolicitudPendingId,
      "pre_solicitud",
      "inappropriate_behavior"
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "report_relationship_invalid");
  });
  test("PRE 5. Host no puede reportar una solicitud perteneciente a otro anfitri\xF3n", async () => {
    const res = await callCrearReporte(
      hostUser,
      false,
      otherHostSolicitudId,
      "pre_solicitud",
      "commercial_spam"
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "report_relationship_invalid");
  });
  test("PRE 6. Solicitud rechazada (rejected) sigue siendo reportable por el host antes del encuentro", async () => {
    const res = await callCrearReporte(
      hostUser,
      false,
      futureSolicitudRejectedId,
      "pre_solicitud",
      "inappropriate_behavior",
      "Insultos en el mensaje de solicitud rechazada"
    );
    assert.equal(res.ok, true);
    assert.equal(res.estado, "pending");
  });
  test('PRE 7. Motivo "other" es rechazado en pre_solicitud (post-only)', async () => {
    const res = await callCrearReporte(
      hostUser,
      false,
      futureSolicitudRejectedId,
      "pre_solicitud",
      "other",
      "Cualquier cosa"
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "report_reason_invalid");
  });
  test("PRE 8. Intento de reporte duplicado para la misma solicitud y contexto es rechazado", async () => {
    const res = await callCrearReporte(
      hostUser,
      false,
      futureSolicitudPendingId,
      "pre_solicitud",
      "safety_concern"
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "report_already_exists");
  });
  test('POST 1. Requiere solicitud "approved" (solicitud pending es rechazada)', async () => {
    const res = await callCrearReporte(
      hostUser,
      false,
      pastSolicitudPendingId,
      "post_encuentro",
      "inappropriate_behavior"
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "report_relationship_invalid");
  });
  test("POST 2. Intento de reporte post antes de que el encuentro ocurra es rechazado", async () => {
    const resAppFut = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${futureEncuentroId}', '${thirdPartyUser}', 'Third Party', 'approved')
      RETURNING id;
    `);
    const appFutId = resAppFut.rows[0].id;
    const res = await callCrearReporte(
      hostUser,
      false,
      appFutId,
      "post_encuentro",
      "inappropriate_behavior"
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "report_window_closed");
  });
  test("POST 3. Host puede reportar a un participante aprobado dentro de las 72h", async () => {
    const res = await callCrearReporte(
      hostUser,
      false,
      pastSolicitudApprovedId,
      "post_encuentro",
      "inappropriate_behavior",
      "Comportamiento disruptivo durante el evento"
    );
    assert.equal(res.ok, true);
    assert.equal(res.estado, "pending");
    const row = await db.query(`
      SELECT * FROM public.reportes_encuentro
      WHERE solicitud_id = '${pastSolicitudApprovedId}'
        AND contexto = 'post_encuentro'
        AND reporter_id = '${hostUser}';
    `);
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].reported_id, applicantUser);
  });
  test("POST 4. Participante aprobado puede reportar al host dentro de las 72h", async () => {
    const res = await callCrearReporte(
      applicantUser,
      false,
      pastSolicitudApprovedId,
      "post_encuentro",
      "safety_concern",
      "El lugar no contaba con medidas de seguridad m\xEDnimas"
    );
    assert.equal(res.ok, true);
    assert.equal(res.estado, "pending");
    const row = await db.query(`
      SELECT * FROM public.reportes_encuentro
      WHERE solicitud_id = '${pastSolicitudApprovedId}'
        AND contexto = 'post_encuentro'
        AND reporter_id = '${applicantUser}';
    `);
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].reported_id, hostUser);
  });
  test("POST 5. Tercero ajeno es rechazado en post_encuentro", async () => {
    const res = await callCrearReporte(
      thirdPartyUser,
      false,
      pastSolicitudApprovedId,
      "post_encuentro",
      "inappropriate_behavior"
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "report_relationship_invalid");
  });
  test("POST 6. Fuera de la ventana de 72h posteriores es rechazado con report_window_closed", async () => {
    const res = await callCrearReporte(
      hostUser,
      false,
      pastSolicitudBeyond72hApprovedId,
      "post_encuentro",
      "inappropriate_behavior"
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "report_window_closed");
  });
  test('POST 7. Motivo "other" sin detalle es rechazado con report_detail_required', async () => {
    const resNewApp = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${pastEncuentroWithin72hId}', '${thirdPartyUser}', 'Third Party User', 'approved')
      RETURNING id;
    `);
    const newAppId = resNewApp.rows[0].id;
    const res = await callCrearReporte(
      hostUser,
      false,
      newAppId,
      "post_encuentro",
      "other",
      "   "
      // sólo espacios -> se convierte en null
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "report_detail_required");
  });
  test('POST 8. Motivo "other" con detalle v\xE1lido es aceptado', async () => {
    const rowApp = await db.query(`
      SELECT id FROM public.solicitudes_encuentro_abierto
      WHERE encuentro_id = '${pastEncuentroWithin72hId}'
        AND usuario_id = '${thirdPartyUser}';
    `);
    const targetSolId = rowApp.rows[0].id;
    const res = await callCrearReporte(
      hostUser,
      false,
      targetSolId,
      "post_encuentro",
      "other",
      "Hubo una situaci\xF3n no prevista en las categor\xEDas predefinidas."
    );
    assert.equal(res.ok, true);
    assert.equal(res.estado, "pending");
  });
  test("POST 9. Detalle con longitud superior a 1000 caracteres es rechazado", async () => {
    const resApp4 = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${pastEncuentroWithin72hId}', '${otherApplicantUser}', 'Other 4', 'approved')
      RETURNING id;
    `);
    const solId4 = resApp4.rows[0].id;
    const hugeText = "a".repeat(1001);
    const res = await callCrearReporte(
      hostUser,
      false,
      solId4,
      "post_encuentro",
      "commercial_spam",
      hugeText
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "report_detail_too_long");
  });
  test("POST 10. Detalle con tags HTML es rechazado con report_detail_invalid", async () => {
    const rowApp = await db.query(`
      SELECT id FROM public.solicitudes_encuentro_abierto
      WHERE encuentro_id = '${pastEncuentroWithin72hId}'
        AND usuario_id = '${otherApplicantUser}';
    `);
    const solId = rowApp.rows[0].id;
    const res = await callCrearReporte(
      hostUser,
      false,
      solId,
      "post_encuentro",
      "commercial_spam",
      'Spam con link <a href="http://malicious.com">Click</a>'
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "report_detail_invalid");
  });
  test("PRIVACIDAD 1. Usuario an\xF3nimo es rechazado con permanent_account_required", async () => {
    const res = await callCrearReporte(
      anonUser,
      true,
      futureSolicitudPendingId,
      "pre_solicitud",
      "commercial_spam"
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "permanent_account_required");
  });
  test("PRIVACIDAD 2. Llamada sin autenticaci\xF3n es rechazada con authentication_required", async () => {
    await db.exec(`
      SET request.jwt.claim.sub = '';
      SET request.jwt.claims = '{}';
    `);
    const res = await db.query(`
      SELECT public.crear_reporte_seguro(
        '${futureSolicitudPendingId}',
        'pre_solicitud',
        'commercial_spam',
        NULL
      ) AS crear_reporte_seguro;
    `);
    assert.equal(res.rows[0].crear_reporte_seguro.ok, false);
    assert.equal(res.rows[0].crear_reporte_seguro.error, "authentication_required");
  });
  test("PRIVACIDAD 3. La respuesta RPC nunca retorna reported_id ni datos privados", async () => {
    const freshUser = "55555555-5555-5555-5555-555555555555";
    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES ('${freshUser}', 'fresh@test.com')
      ON CONFLICT DO NOTHING;
    `);
    const resFresh = await db.query(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${pastEncuentroWithin72hId}', '${freshUser}', 'Fresh User', 'approved')
      RETURNING id;
    `);
    const solId = resFresh.rows[0].id;
    const okRes = await callCrearReporte(
      hostUser,
      false,
      solId,
      "post_encuentro",
      "safety_concern",
      "Detalle seguro sin HTML"
    );
    assert.equal(okRes.ok, true);
    assert.deepEqual(Object.keys(okRes).sort(), ["estado", "ok"]);
    assert.equal(okRes.reported_id, void 0);
    assert.equal(okRes.reporter_id, void 0);
    assert.equal(okRes.email, void 0);
  });
  test("PRIVACIDAD 4. Tabla reportes_encuentro es privada y no accesible directamente por usuarios", async () => {
    await db.exec(`
      SET ROLE authenticated;
      SET request.jwt.claim.sub = '${applicantUser}';
      SET request.jwt.claims = '{"is_anonymous": false}';
    `);
    let errorThrown = false;
    try {
      await db.query(`SELECT * FROM public.reportes_encuentro;`);
    } catch (err) {
      errorThrown = true;
      assert.match(err.message, /permission denied/i);
    }
    assert.equal(errorThrown, true, "Debe denegar acceso directo SELECT a la tabla");
    await db.exec(`RESET ROLE;`);
  });
});
