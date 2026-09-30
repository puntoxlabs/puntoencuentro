import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-C1 (T1): Ficha Factual de Actividad del Solicitante — Backend Tests', () => {
  let db: PGlite;
  const hostUser = '11111111-1111-1111-1111-111111111111';
  const applicantUser = '22222222-2222-2222-2222-222222222222';
  const thirdPartyUser = '33333333-3333-3333-3333-333333333333';
  const anonUser = '44444444-4444-4444-4444-444444444444';

  let currentEncuentroId: string;
  let currentSolicitudId: string;
  let pastEncuentroId1: string;
  let pastEncuentroId2: string;
  let futureEncuentroId: string;
  let pastHostedOpenEncuentroId: string;
  let pastHostedPrivateEncuentroId: string;

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
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        locality_id TEXT REFERENCES public.localidades(id),
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        token_invitacion UUID UNIQUE,
        estado TEXT NOT NULL DEFAULT 'confirmado',
        user_id UUID,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
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
    `);

    // 2. Aplicar la migración aditiva bajo prueba
    const migrationPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20260930120000_fase_20c1_trust_applicant_profile.sql'
    );
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    await db.exec(sql);

    // 3. Crear fixtures
    // A. Encuentro abierto actual del host
    const resCurr = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora)
      VALUES ('${hostUser}', 'Encuentro Actual Host', true, now(), '2026-10-20', '19:00')
      RETURNING id;
    `);
    currentEncuentroId = resCurr.rows[0].id;

    // B. Solicitud actual del applicant
    const resSol = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, mensaje, estado)
      VALUES ('${currentEncuentroId}', '${applicantUser}', 'Juan Perez', 'Hola, me sumo!', 'pending')
      RETURNING id;
    `);
    currentSolicitudId = resSol.rows[0].id;

    // C. Encuentros pasados de terceros (fecha < CURRENT_DATE)
    const resPast1 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora)
      VALUES ('${thirdPartyUser}', 'Pádel Pasado', true, now() - interval '10 days', '2026-08-10', '18:00')
      RETURNING id;
    `);
    pastEncuentroId1 = resPast1.rows[0].id;

    const resPast2 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora)
      VALUES ('${thirdPartyUser}', 'Ajedrez Pasado', true, now() - interval '5 days', '2026-08-20', '18:00')
      RETURNING id;
    `);
    pastEncuentroId2 = resPast2.rows[0].id;

    // D. Encuentro futuro de tercero
    const resFut = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora)
      VALUES ('${thirdPartyUser}', 'Futuro Evento', true, now(), '2026-12-01', '18:00')
      RETURNING id;
    `);
    futureEncuentroId = resFut.rows[0].id;

    // E. Encuentros donde el applicant fue host
    // E1: Abierto (opened_at IS NOT NULL) y pasado
    const resHostOpen = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora)
      VALUES ('${applicantUser}', 'Café Tecnológico', false, now() - interval '20 days', '2026-08-01', '10:00')
      RETURNING id;
    `);
    pastHostedOpenEncuentroId = resHostOpen.rows[0].id;

    // E2: Privado (opened_at IS NULL) y pasado
    const resHostPriv = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, opened_at, fecha, hora)
      VALUES ('${applicantUser}', 'Cena Privada Familiar', false, NULL, '2026-08-05', '21:00')
      RETURNING id;
    `);
    pastHostedPrivateEncuentroId = resHostPriv.rows[0].id;
  });

  async function callAsUser(userId: string, isAnon: boolean, solicitudId: string) {
    await db.exec(`
      SET request.jwt.claim.sub = '${userId}';
      SET request.jwt.claims = '{"is_anonymous": ${isAnon}}';
    `);
    const res = await db.query<{ get_perfil_confianza_solicitante: any }>(`
      SELECT public.get_perfil_confianza_solicitante('${solicitudId}') AS get_perfil_confianza_solicitante;
    `);
    return res.rows[0].get_perfil_confianza_solicitante;
  }

  test('1. Host legítimo puede consultar el perfil factual del solicitante', async () => {
    const res = await callAsUser(hostUser, false, currentSolicitudId);
    assert.equal(res.ok, true, 'Debe responder ok=true');
    assert.ok(res.data, 'Debe incluir data');
    assert.equal(res.data.member_since_month, '2026-07', 'Mes de alta correcto');
    assert.equal(res.data.approved_open_encounters_previous, 0, 'Sin admisiones pasadas aún');
    assert.equal(res.data.no_prior_open_history, true, 'no_prior_open_history es true');
    assert.equal(res.data.hosted_open_encounters_previous, 1, 'Cuenta 1 abierto organizado previo');
  });

  test('2. Usuario ajeno recibe error unauthorized', async () => {
    const res = await callAsUser(thirdPartyUser, false, currentSolicitudId);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unauthorized');
  });

  test('3. El propio solicitante recibe error unauthorized (solo el host puede evaluar)', async () => {
    const res = await callAsUser(applicantUser, false, currentSolicitudId);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unauthorized');
  });

  test('4. Usuario anónimo es rechazado con permanent_account_required', async () => {
    const res = await callAsUser(anonUser, true, currentSolicitudId);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'permanent_account_required');
  });

  test('5. Solicitud inexistente devuelve request_not_found', async () => {
    const res = await callAsUser(hostUser, false, '00000000-0000-0000-0000-000000000000');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'request_not_found');
  });

  test('6. admisiones previas: suma 1 si fue approved en un encuentro pasado', async () => {
    // Insertar solicitud approved en pastEncuentroId1
    await db.exec(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${pastEncuentroId1}', '${applicantUser}', 'Juan Perez', 'approved');
    `);

    const res = await callAsUser(hostUser, false, currentSolicitudId);
    assert.equal(res.ok, true);
    assert.equal(res.data.approved_open_encounters_previous, 1);
    assert.equal(res.data.no_prior_open_history, false, 'Ya tiene historial');
  });

  test('7. pending, rejected y withdrawn NO suman a admisiones pasadas', async () => {
    // Insertar solicitudes en pastEncuentroId2 con otros estados
    await db.exec(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES
        ('${pastEncuentroId2}', '${applicantUser}', 'Juan Perez', 'rejected'),
        ('${pastEncuentroId2}', '${applicantUser}', 'Juan Perez', 'withdrawn');
    `);

    const res = await callAsUser(hostUser, false, currentSolicitudId);
    assert.equal(res.ok, true);
    // Debe seguir en 1 (solo la approved de pastEncuentroId1)
    assert.equal(res.data.approved_open_encounters_previous, 1);
  });

  test('8. Encuentro futuro aprobado NO suma (aún no transcurrió)', async () => {
    await db.exec(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${futureEncuentroId}', '${applicantUser}', 'Juan Perez', 'approved');
    `);

    const res = await callAsUser(hostUser, false, currentSolicitudId);
    assert.equal(res.ok, true);
    assert.equal(res.data.approved_open_encounters_previous, 1);
  });

  test('9. El encuentro actual NO se cuenta a sí mismo aunque cambie a approved', async () => {
    await db.exec(`
      UPDATE public.solicitudes_encuentro_abierto
      SET estado = 'approved'
      WHERE id = '${currentSolicitudId}';
    `);

    const res = await callAsUser(hostUser, false, currentSolicitudId);
    assert.equal(res.ok, true);
    assert.equal(res.data.approved_open_encounters_previous, 1);

    // Restaurar a pending para consistencia
    await db.exec(`
      UPDATE public.solicitudes_encuentro_abierto
      SET estado = 'pending'
      WHERE id = '${currentSolicitudId}';
    `);
  });

  test('10. Varios encuentros pasados aprobados usan COUNT DISTINCT por encuentro', async () => {
    // Agregar approved a pastEncuentroId2
    await db.exec(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${pastEncuentroId2}', '${applicantUser}', 'Juan Perez', 'approved');
    `);

    const res = await callAsUser(hostUser, false, currentSolicitudId);
    assert.equal(res.ok, true);
    assert.equal(res.data.approved_open_encounters_previous, 2);
    assert.equal(res.data.no_prior_open_history, false);
  });

  test('11. Historial de host: solo cuenta encuentros con opened_at IS NOT NULL (excluye privados)', async () => {
    const res = await callAsUser(hostUser, false, currentSolicitudId);
    assert.equal(res.ok, true);
    // pastHostedOpenEncuentroId tiene opened_at NOT NULL -> suma 1
    // pastHostedPrivateEncuentroId tiene opened_at NULL -> no suma
    assert.equal(res.data.hosted_open_encounters_previous, 1);
  });

  test('12. Privacidad y sanitización: no expone user_id, emails, teléfonos, títulos ni UUIDs', async () => {
    const res = await callAsUser(hostUser, false, currentSolicitudId);
    assert.equal(res.ok, true);
    const data = res.data;

    // Verificar que solo contiene las 4 claves permitidas
    const keys = Object.keys(data).sort();
    assert.deepEqual(keys, [
      'approved_open_encounters_previous',
      'hosted_open_encounters_previous',
      'member_since_month',
      'no_prior_open_history',
    ]);

    assert.equal((data as any).user_id, undefined);
    assert.equal((data as any).email, undefined);
    assert.equal((data as any).public_token, undefined);
    assert.equal((data as any).titulos, undefined);
    assert.equal((data as any).encuentros, undefined);
  });
});
