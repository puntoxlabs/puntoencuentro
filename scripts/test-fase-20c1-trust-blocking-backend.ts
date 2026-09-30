import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-C1 (T3-A1): Núcleo Seguro de Bloqueo — Backend Tests', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const applicantUser = '22222222-2222-2222-2222-222222222222';
  const thirdPartyUser = '33333333-3333-3333-3333-333333333333';
  const anonUser = '44444444-4444-4444-4444-444444444444';
  const bystanderUser = '55555555-5555-5555-5555-555555555555';

  let currentEncuentroId: string;
  let secondEncuentroId: string;
  let reverseEncuentroId: string;
  let currentSolicitudId: string;
  let secondSolicitudId: string;
  let reverseSolicitudId: string;
  let approvedSolicitudId: string;
  let participantToken: string;
  let intentionHostId: string;
  let intentionApplicantId: string;
  let intentionBystanderId: string;
  let existingReportId: string;

  before(async () => {
    db = new PGlite();

    // 1. Configuración de entorno Postgres simulado
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
        ('${thirdPartyUser}', 'other@test.com', '2026-08-01 09:00:00Z'),
        ('${anonUser}', 'anon@test.com', '2026-09-01 10:00:00Z'),
        ('${bystanderUser}', 'bystander@test.com', '2026-09-02 10:00:00Z')
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
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha DATE,
        hora TIME,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        lugar_texto TEXT,
        link_virtual TEXT,
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        host_id UUID NOT NULL REFERENCES auth.users(id),
        public_token UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'activo',
        tema TEXT NOT NULL DEFAULT 'blue',
        reemplaza_a UUID NULL REFERENCES public.encuentros(id),
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL,
        is_open BOOLEAN DEFAULT false,
        max_participants INT DEFAULT 10,
        locality_id TEXT REFERENCES public.localidades(id),
        open_description TEXT,
        open_public_zone TEXT,
        opened_at TIMESTAMPTZ,
        duration_minutes INT DEFAULT 45
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        token_invitacion UUID UNIQUE,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        user_id UUID REFERENCES auth.users(id),
        mensaje_respuesta TEXT,
        respondido_en TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL REFERENCES auth.users(id),
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        estado TEXT NOT NULL DEFAULT 'pending',
        participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
        token_participante UUID,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        resolved_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS public.intenciones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        titulo TEXT NOT NULL,
        descripcion TEXT,
        temporalidad_texto TEXT,
        fecha_desde DATE,
        fecha_hasta DATE,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        locality_id TEXT REFERENCES public.localidades(id) ON DELETE SET NULL,
        estado TEXT NOT NULL DEFAULT 'activa',
        encuentro_id UUID REFERENCES public.encuentros(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.intencion_intereses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        intencion_id UUID NOT NULL REFERENCES public.intenciones(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_intencion_intereses UNIQUE (intencion_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS public.reportes_encuentro (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        solicitud_id UUID REFERENCES public.solicitudes_encuentro_abierto(id) ON DELETE SET NULL,
        encuentro_id UUID REFERENCES public.encuentros(id) ON DELETE SET NULL,
        reporter_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        reported_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        contexto TEXT NOT NULL,
        motivo TEXT NOT NULL,
        detalle TEXT,
        estado TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );
    `);

    // 2. Aplicar la migración T3-A1 bajo prueba
    const migrationPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20260930160000_fase_20c1_trust_user_blocking_core.sql'
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
    await db.exec(migrationSql);
  });

  const setAuthContext = async (userId: string | null, isAnon: boolean = false) => {
    if (!userId) {
      await db.exec(`
        RESET request.jwt.claim.sub;
        RESET request.jwt.claims;
      `);
    } else {
      await db.exec(`
        SET request.jwt.claim.sub = '${userId}';
        SET request.jwt.claims = '{"sub": "${userId}", "is_anonymous": ${isAnon}}';
      `);
    }
  };

  beforeEach(async () => {
    // Reset data
    await db.exec(`
      DELETE FROM public.bloqueos_usuario;
      DELETE FROM public.reportes_encuentro;
      DELETE FROM public.intencion_intereses;
      DELETE FROM public.intenciones;
      DELETE FROM public.solicitudes_encuentro_abierto;
      DELETE FROM public.participantes;
      DELETE FROM public.encuentros;
    `);

    // 1. Encuentro de hostUser
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, fecha, hora, host_id, is_open)
      VALUES ('Café de debate', '2026-10-15', '18:00', '${hostUser}', true)
      RETURNING id;
    `);
    currentEncuentroId = encRes.rows[0].id;

    // 2. Segundo encuentro de hostUser (para probar múltiples pending simultáneas)
    const encRes2 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, fecha, hora, host_id, is_open)
      VALUES ('Segundo Café', '2026-10-20', '19:00', '${hostUser}', true)
      RETURNING id;
    `);
    secondEncuentroId = encRes2.rows[0].id;

    // 3. Encuentro inverso donde applicantUser es host
    const encResRev = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, fecha, hora, host_id, is_open)
      VALUES ('Encuentro de Applicant', '2026-10-25', '20:00', '${applicantUser}', true)
      RETURNING id;
    `);
    reverseEncuentroId = encResRev.rows[0].id;

    // 4. Solicitud pending de applicantUser hacia primer encuentro de hostUser
    const solRes = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${currentEncuentroId}', '${applicantUser}', 'Carlos Solicitante', 'pending')
      RETURNING id;
    `);
    currentSolicitudId = solRes.rows[0].id;

    // 5. Segunda solicitud pending de applicantUser hacia segundo encuentro de hostUser
    const solRes2 = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${secondEncuentroId}', '${applicantUser}', 'Carlos Solicitante', 'pending')
      RETURNING id;
    `);
    secondSolicitudId = solRes2.rows[0].id;

    // 6. Solicitud pending inversa de hostUser hacia encuentro de applicantUser
    const solResRev = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${reverseEncuentroId}', '${hostUser}', 'Host Solicitando', 'pending')
      RETURNING id;
    `);
    reverseSolicitudId = solResRev.rows[0].id;

    // 7. Solicitud ya approved entre hostUser y applicantUser
    participantToken = '99999999-9999-9999-9999-999999999999';
    const partRes = await db.query<{ id: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, token_invitacion, estado, user_id)
      VALUES ('${currentEncuentroId}', 'Carlos Aprobado', '${participantToken}', 'confirmado', '${applicantUser}')
      RETURNING id;
    `);
    const partId = partRes.rows[0].id;

    const solAppRes = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado, participante_id, token_participante)
      VALUES ('${currentEncuentroId}', '${applicantUser}', 'Carlos Aprobado', 'approved', '${partId}', '${participantToken}')
      RETURNING id;
    `);
    approvedSolicitudId = solAppRes.rows[0].id;

    // 8. Solicitudes históricas (rejected y withdrawn)
    await db.exec(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES
        ('${currentEncuentroId}', '${applicantUser}', 'Carlos Rechazado Previo', 'rejected'),
        ('${currentEncuentroId}', '${applicantUser}', 'Carlos Retirado Previo', 'withdrawn');
    `);

    // 9. Intenciones y relaciones de interés mutuo
    const intH = await db.query<{ id: string }>(`
      INSERT INTO public.intenciones (user_id, titulo, estado)
      VALUES ('${hostUser}', 'Intencion de Host', 'activa')
      RETURNING id;
    `);
    intentionHostId = intH.rows[0].id;

    const intA = await db.query<{ id: string }>(`
      INSERT INTO public.intenciones (user_id, titulo, estado)
      VALUES ('${applicantUser}', 'Intencion de Applicant', 'activa')
      RETURNING id;
    `);
    intentionApplicantId = intA.rows[0].id;

    const intB = await db.query<{ id: string }>(`
      INSERT INTO public.intenciones (user_id, titulo, estado)
      VALUES ('${bystanderUser}', 'Intencion de Tercero', 'activa')
      RETURNING id;
    `);
    intentionBystanderId = intB.rows[0].id;

    // Interés cruzado A ↔ B y un tercero independiente
    await db.exec(`
      INSERT INTO public.intencion_intereses (intencion_id, user_id)
      VALUES
        ('${intentionHostId}', '${applicantUser}'),     -- applicant interesado en host
        ('${intentionApplicantId}', '${hostUser}'),      -- host interesado en applicant
        ('${intentionBystanderId}', '${applicantUser}'), -- applicant interesado en tercero
        ('${intentionHostId}', '${bystanderUser}');      -- tercero interesado en host
    `);

    // 10. Reporte de moderación preexistente
    const repRes = await db.query<{ id: string }>(`
      INSERT INTO public.reportes_encuentro (solicitud_id, encuentro_id, reporter_id, reported_id, contexto, motivo, detalle)
      VALUES ('${currentSolicitudId}', '${currentEncuentroId}', '${hostUser}', '${applicantUser}', 'pre_solicitud', 'commercial_spam', 'Spam previo')
      RETURNING id;
    `);
    existingReportId = repRes.rows[0].id;
  });

  // ========================================================
  // 1. DERIVACIÓN Y AUTORIZACIÓN DE BLOQUEO
  // ========================================================
  describe('1. Derivación y Autorización de Bloqueo', () => {
    test('A. Host bloquea solicitante derivando contraparte server-side', async () => {
      await setAuthContext(hostUser);

      const res = await db.query<{ bloquear_desde_solicitud_seguro: any }>(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}') AS bloquear_desde_solicitud_seguro;
      `);

      const result = res.rows[0].bloquear_desde_solicitud_seguro;
      assert.equal(result.ok, true);
      assert.equal(result.blocked, true);
      assert.equal(result.blocked_id, undefined, 'Jamás debe retornar blocked_id');

      // Verificar fila en DB
      const blockRow = await db.query(`
        SELECT * FROM public.bloqueos_usuario
        WHERE blocker_id = '${hostUser}' AND blocked_id = '${applicantUser}';
      `);
      assert.equal(blockRow.rows.length, 1);
    });

    test('B. Solicitante bloquea host derivando contraparte server-side', async () => {
      await setAuthContext(applicantUser);

      const res = await db.query<{ bloquear_desde_solicitud_seguro: any }>(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}') AS bloquear_desde_solicitud_seguro;
      `);

      const result = res.rows[0].bloquear_desde_solicitud_seguro;
      assert.equal(result.ok, true);
      assert.equal(result.blocked, true);

      // Verificar fila en DB: blocker es applicant, blocked es host
      const blockRow = await db.query(`
        SELECT * FROM public.bloqueos_usuario
        WHERE blocker_id = '${applicantUser}' AND blocked_id = '${hostUser}';
      `);
      assert.equal(blockRow.rows.length, 1);
    });

    test('C. Tercero no puede usar solicitud ajena para bloquear', async () => {
      await setAuthContext(thirdPartyUser);

      const res = await db.query<{ bloquear_desde_solicitud_seguro: any }>(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}') AS bloquear_desde_solicitud_seguro;
      `);

      const result = res.rows[0].bloquear_desde_solicitud_seguro;
      assert.equal(result.ok, false);
      assert.equal(result.error, 'unauthorized');

      const count = await db.query(`SELECT COUNT(*) as c FROM public.bloqueos_usuario;`);
      assert.equal(count.rows[0].c, 0);
    });

    test('D. Self-block es imposible tanto por validación como por constraint', async () => {
      // 1. Crear solicitud anómala donde host = applicant
      const anomalySol = await db.query<{ id: string }>(`
        INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
        VALUES ('${currentEncuentroId}', '${hostUser}', 'Auto Solicitud', 'pending')
        RETURNING id;
      `);
      const anomalySolId = anomalySol.rows[0].id;

      await setAuthContext(hostUser);
      const res = await db.query<{ bloquear_desde_solicitud_seguro: any }>(`
        SELECT public.bloquear_desde_solicitud_seguro('${anomalySolId}') AS bloquear_desde_solicitud_seguro;
      `);
      assert.equal(res.rows[0].bloquear_desde_solicitud_seguro.ok, false);
      assert.equal(res.rows[0].bloquear_desde_solicitud_seguro.error, 'cannot_block_self');

      // 2. Intentar INSERT directo con self-block para verificar CHECK constraint
      let constraintError = false;
      try {
        await db.exec(`
          INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
          VALUES ('${hostUser}', '${hostUser}');
        `);
      } catch (err: any) {
        constraintError = true;
        assert.ok(err.message.includes('chk_bloqueos_no_self_block'));
      }
      assert.equal(constraintError, true, 'CHECK constraint chk_bloqueos_no_self_block debe abortar');
    });

    test('E. Usuario anónimo o no autenticado es rechazado', async () => {
      await setAuthContext(null);
      const unauth = await db.query<{ bloquear_desde_solicitud_seguro: any }>(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}') AS bloquear_desde_solicitud_seguro;
      `);
      assert.equal(unauth.rows[0].bloquear_desde_solicitud_seguro.error, 'authentication_required');

      await setAuthContext(anonUser, true);
      const anon = await db.query<{ bloquear_desde_solicitud_seguro: any }>(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}') AS bloquear_desde_solicitud_seguro;
      `);
      assert.equal(anon.rows[0].bloquear_desde_solicitud_seguro.error, 'permanent_account_required');
    });

    test('E. Bloqueo duplicado es idempotente y no genera error', async () => {
      await setAuthContext(hostUser);

      const first = await db.query<{ bloquear_desde_solicitud_seguro: any }>(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}') AS bloquear_desde_solicitud_seguro;
      `);
      assert.equal(first.rows[0].bloquear_desde_solicitud_seguro.ok, true);

      const second = await db.query<{ bloquear_desde_solicitud_seguro: any }>(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}') AS bloquear_desde_solicitud_seguro;
      `);
      assert.equal(second.rows[0].bloquear_desde_solicitud_seguro.ok, true);
      assert.equal(second.rows[0].bloquear_desde_solicitud_seguro.blocked, true);

      const count = await db.query(`SELECT COUNT(*) as c FROM public.bloqueos_usuario;`);
      assert.equal(count.rows[0].c, 1);
    });
  });

  // ========================================================
  // 2. RESOLUCIÓN DE SOLICITUDES PENDING
  // ========================================================
  describe('2. Resolución Automática de Solicitudes Pending', () => {
    test('F. Host bloquea -> solicitudes pending del bloqueado pasan a rejected con resolved_at', async () => {
      await setAuthContext(hostUser);

      await db.exec(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}');
      `);

      const sol1 = await db.query<{ estado: string; resolved_at: string }>(`
        SELECT estado, resolved_at FROM public.solicitudes_encuentro_abierto WHERE id = '${currentSolicitudId}';
      `);
      assert.equal(sol1.rows[0].estado, 'rejected');
      assert.ok(sol1.rows[0].resolved_at !== null);

      const sol2 = await db.query<{ estado: string; resolved_at: string }>(`
        SELECT estado, resolved_at FROM public.solicitudes_encuentro_abierto WHERE id = '${secondSolicitudId}';
      `);
      assert.equal(sol2.rows[0].estado, 'rejected', 'Todas las solicitudes pending ante el host deben pasar a rejected');
      assert.ok(sol2.rows[0].resolved_at !== null);
    });

    test('G. Solicitante bloquea -> sus solicitudes pending pasan a withdrawn con resolved_at', async () => {
      await setAuthContext(applicantUser);

      await db.exec(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}');
      `);

      const sol1 = await db.query<{ estado: string; resolved_at: string }>(`
        SELECT estado, resolved_at FROM public.solicitudes_encuentro_abierto WHERE id = '${currentSolicitudId}';
      `);
      assert.equal(sol1.rows[0].estado, 'withdrawn');
      assert.ok(sol1.rows[0].resolved_at !== null);

      const sol2 = await db.query<{ estado: string; resolved_at: string }>(`
        SELECT estado, resolved_at FROM public.solicitudes_encuentro_abierto WHERE id = '${secondSolicitudId}';
      `);
      assert.equal(sol2.rows[0].estado, 'withdrawn');
      assert.ok(sol2.rows[0].resolved_at !== null);
    });

    test('H. Solicitudes cruzadas (ambos eran hosts en distintos encuentros) se resuelven coherentemente', async () => {
      // hostUser tiene solicitud pending hacia encuentro de applicantUser (reverseSolicitudId)
      // applicantUser tiene solicitudes pending hacia encuentros de hostUser (currentSolicitudId, secondSolicitudId)
      await setAuthContext(hostUser);

      await db.exec(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}');
      `);

      // 1. Como hostUser es HOST en currentSolicitudId, la solicitud de applicantUser pasa a rejected:
      const solApplicant = await db.query<{ estado: string }>(`
        SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${currentSolicitudId}';
      `);
      assert.equal(solApplicant.rows[0].estado, 'rejected');

      // 2. Como hostUser es SOLICITANTE en reverseSolicitudId, su propia solicitud ante applicantUser pasa a withdrawn:
      const solHost = await db.query<{ estado: string }>(`
        SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${reverseSolicitudId}';
      `);
      assert.equal(solHost.rows[0].estado, 'withdrawn');
    });
  });

  // ========================================================
  // 3. PRESERVACIÓN DE APPROVED Y REGISTROS HISTÓRICOS
  // ========================================================
  describe('3. Preservación de Approved, Participantes e Historial', () => {
    test('I & J & K. Solicitud approved, participante y token permanecen intactos tras el bloqueo', async () => {
      await setAuthContext(hostUser);

      await db.exec(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}');
      `);

      const solApp = await db.query<{ estado: string; token_participante: string }>(`
        SELECT estado, token_participante FROM public.solicitudes_encuentro_abierto WHERE id = '${approvedSolicitudId}';
      `);
      assert.equal(solApp.rows[0].estado, 'approved', 'Solicitud approved debe permanecer approved');
      assert.equal(solApp.rows[0].token_participante, participantToken, 'Token en solicitud no debe modificarse');

      const part = await db.query<{ estado: string; user_id: string }>(`
        SELECT estado, user_id FROM public.participantes WHERE token_invitacion = '${participantToken}';
      `);
      assert.equal(part.rows.length, 1);
      assert.equal(part.rows[0].estado, 'confirmado', 'Participante confirmado debe mantenerse');
      assert.equal(part.rows[0].user_id, applicantUser, 'user_id de participante debe mantenerse');
    });

    test('L. Solicitudes históricas (rejected/withdrawn previas) no cambian de estado', async () => {
      await setAuthContext(hostUser);

      await db.exec(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}');
      `);

      const histRej = await db.query<{ estado: string }>(`
        SELECT estado FROM public.solicitudes_encuentro_abierto WHERE nombre_solicitante = 'Carlos Rechazado Previo';
      `);
      assert.equal(histRej.rows[0].estado, 'rejected');

      const histWit = await db.query<{ estado: string }>(`
        SELECT estado FROM public.solicitudes_encuentro_abierto WHERE nombre_solicitante = 'Carlos Retirado Previo';
      `);
      assert.equal(histWit.rows[0].estado, 'withdrawn');
    });
  });

  // ========================================================
  // 4. INTERESES EN INTENCIONES
  // ========================================================
  describe('4. Limpieza Silenciosa de Intereses en Intenciones', () => {
    test('M & N & O. Elimina intereses mutuos entre ambas partes y preserva los de terceros', async () => {
      await setAuthContext(hostUser);

      await db.exec(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}');
      `);

      // M: Interés de applicant en intención de host debe haber sido eliminado
      const intH_A = await db.query(`
        SELECT * FROM public.intencion_intereses WHERE intencion_id = '${intentionHostId}' AND user_id = '${applicantUser}';
      `);
      assert.equal(intH_A.rows.length, 0, 'Interés de applicant en intención de host debe ser eliminado');

      // N: Interés de host en intención de applicant debe haber sido eliminado
      const intA_H = await db.query(`
        SELECT * FROM public.intencion_intereses WHERE intencion_id = '${intentionApplicantId}' AND user_id = '${hostUser}';
      `);
      assert.equal(intA_H.rows.length, 0, 'Interés de host en intención de applicant debe ser eliminado');

      // O: Interés de applicant en intención de tercero DEBE conservarse
      const intB_A = await db.query(`
        SELECT * FROM public.intencion_intereses WHERE intencion_id = '${intentionBystanderId}' AND user_id = '${applicantUser}';
      `);
      assert.equal(intB_A.rows.length, 1, 'Interés hacia un tercero no involucrado no debe tocarse');

      // O: Interés de tercero en intención de host DEBE conservarse
      const intH_B = await db.query(`
        SELECT * FROM public.intencion_intereses WHERE intencion_id = '${intentionHostId}' AND user_id = '${bystanderUser}';
      `);
      assert.equal(intH_B.rows.length, 1, 'Interés de un tercero no involucrado no debe tocarse');
    });
  });

  // ========================================================
  // 5. REPORTES DE MODERACIÓN
  // ========================================================
  describe('5. Coexistencia con Reportes de Moderación', () => {
    test('P. Reporte existente permanece intacto al bloquear', async () => {
      await setAuthContext(hostUser);

      await db.exec(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}');
      `);

      const report = await db.query<{ id: string; estado: string }>(`
        SELECT id, estado FROM public.reportes_encuentro WHERE id = '${existingReportId}';
      `);
      assert.equal(report.rows.length, 1);
      assert.equal(report.rows[0].estado, 'pending', 'El estado del reporte de moderación debe permanecer inalterado');
    });
  });

  // ========================================================
  // 6. DESBLOQUEO
  // ========================================================
  describe('6. Desbloqueo Seguro y No-Restauración', () => {
    test('Q & R & S. Desbloqueo elimina únicamente el bloqueo propio y NO revive solicitudes ni intereses', async () => {
      await setAuthContext(hostUser);

      // 1. Bloquear
      await db.exec(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}');
      `);

      // Confirmar que existe el bloqueo
      const b1 = await db.query(`SELECT COUNT(*) as c FROM public.bloqueos_usuario;`);
      assert.equal(b1.rows[0].c, 1);

      // 2. Desbloquear
      const unblockRes = await db.query<{ desbloquear_usuario_seguro: any }>(`
        SELECT public.desbloquear_usuario_seguro('${applicantUser}') AS desbloquear_usuario_seguro;
      `);
      assert.equal(unblockRes.rows[0].desbloquear_usuario_seguro.ok, true);
      assert.equal(unblockRes.rows[0].desbloquear_usuario_seguro.unblocked, true);

      // Confirmar que se eliminó el bloqueo
      const b2 = await db.query(`SELECT COUNT(*) as c FROM public.bloqueos_usuario;`);
      assert.equal(b2.rows[0].c, 0);

      // R: Solicitudes que pasaron a rejected NO deben revivir
      const sol = await db.query<{ estado: string }>(`
        SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${currentSolicitudId}';
      `);
      assert.equal(sol.rows[0].estado, 'rejected', 'Las solicitudes resueltas no deben revivir a pending');

      // S: Intereses eliminados NO deben recrearse
      const intH_A = await db.query(`
        SELECT * FROM public.intencion_intereses WHERE intencion_id = '${intentionHostId}' AND user_id = '${applicantUser}';
      `);
      assert.equal(intH_A.rows.length, 0, 'Los intereses eliminados no deben restaurarse');
    });

    test('Un usuario no puede desbloquear un bloqueo que otro le aplicó a él', async () => {
      // hostUser bloquea a applicantUser
      await setAuthContext(hostUser);
      await db.exec(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}');
      `);

      // applicantUser intenta desbloquear a hostUser
      await setAuthContext(applicantUser);
      const res = await db.query<{ desbloquear_usuario_seguro: any }>(`
        SELECT public.desbloquear_usuario_seguro('${hostUser}') AS desbloquear_usuario_seguro;
      `);
      assert.equal(res.rows[0].desbloquear_usuario_seguro.ok, true);

      // El bloqueo impuesto por hostUser debe seguir intacto en la base de datos
      const check = await db.query(`
        SELECT * FROM public.bloqueos_usuario WHERE blocker_id = '${hostUser}' AND blocked_id = '${applicantUser}';
      `);
      assert.equal(check.rows.length, 1, 'El bloqueo creado por hostUser debe persistir');
    });
  });

  // ========================================================
  // 7. PRIVACIDAD Y CONSULTA DE BLOQUEOS
  // ========================================================
  describe('7. Privacidad e Invariantes de Seguridad', () => {
    test('T. Consultas directas a la tabla bloqueos_usuario no están permitidas para usuarios', async () => {
      // La tabla no tiene permisos de SELECT otorgados a anon ni authenticated
      const tablePerms = await db.query(`
        SELECT grantee, privilege_type 
        FROM information_schema.role_table_grants 
        WHERE table_name = 'bloqueos_usuario'
          AND grantee IN ('anon', 'authenticated');
      `);
      assert.equal(tablePerms.rows.length, 0, 'No debe existir ningún grant a anon ni authenticated');
    });

    test('U. get_mis_bloqueos_seguro solo expone bloqueos emitidos por el usuario, nunca recibidos', async () => {
      // 1. hostUser bloquea a applicantUser
      await setAuthContext(hostUser);
      await db.exec(`
        SELECT public.bloquear_desde_solicitud_seguro('${currentSolicitudId}');
      `);

      // 2. hostUser consulta sus bloqueos -> ve applicantUser
      const hostList = await db.query<{ get_mis_bloqueos_seguro: any }>(`
        SELECT public.get_mis_bloqueos_seguro() AS get_mis_bloqueos_seguro;
      `);
      const hData = hostList.rows[0].get_mis_bloqueos_seguro;
      assert.equal(hData.ok, true);
      assert.equal(hData.bloqueos.length, 1);
      assert.equal(hData.bloqueos[0].blocked_id, applicantUser);

      // 3. applicantUser consulta sus bloqueos -> debe estar VACÍO (no sabe que fue bloqueado)
      await setAuthContext(applicantUser);
      const appList = await db.query<{ get_mis_bloqueos_seguro: any }>(`
        SELECT public.get_mis_bloqueos_seguro() AS get_mis_bloqueos_seguro;
      `);
      const aData = appList.rows[0].get_mis_bloqueos_seguro;
      assert.equal(aData.ok, true);
      assert.deepEqual(aData.bloqueos, [], 'Un usuario bloqueado no debe ver ningún registro en sus bloqueos');
    });
  });
});
