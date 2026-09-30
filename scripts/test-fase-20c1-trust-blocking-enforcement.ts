import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-C1 (T3-A2): Enforcement Bilateral de Bloqueos — Backend Tests', () => {
  let db: PGlite;

  const userA = '11111111-1111-1111-1111-111111111111'; // Host / Author A
  const userB = '22222222-2222-2222-2222-222222222222'; // Solicitante / Author B
  const userC = '33333333-3333-3333-3333-333333333333'; // Third party
  const anonUser = '44444444-4444-4444-4444-444444444444';

  let encounterAId: string;
  let encounterBId: string;
  let encounterCId: string;
  let intentionAId: string;
  let intentionBId: string;
  let intentionCId: string;
  let requestAtoBId: string;

  before(async () => {
    db = new PGlite();

    // 1. Configuración de entorno base
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
        ('${userA}', 'userA@test.com'),
        ('${userB}', 'userB@test.com'),
        ('${userC}', 'userC@test.com'),
        ('${anonUser}', 'anon@test.com')
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
        tema_invitacion TEXT DEFAULT 'social',
        reemplaza_a UUID NULL REFERENCES public.encuentros(id),
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL,
        date_mode TEXT DEFAULT 'fixed',
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

      CREATE TABLE IF NOT EXISTS public.alertas_compatibilidad (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        source_intencion_id UUID NOT NULL REFERENCES public.intenciones(id) ON DELETE CASCADE,
        target_encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        tipo TEXT NOT NULL DEFAULT 'compatibilidad_intencion',
        leida BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_alertas_compatibilidad UNIQUE (user_id, source_intencion_id, target_encuentro_id)
      );
    `);

    // 2. Aplicar migraciones T2-A, T3-A1, T3-A2 y T3-A2.1
    const migrationT2Path = path.resolve(
      process.cwd(),
      'supabase/migrations/20260930133000_fix_fase_20c1_trust_report_context_and_temporal.sql'
    );
    await db.exec(fs.readFileSync(migrationT2Path, 'utf-8'));

    const migrationT3A1Path = path.resolve(
      process.cwd(),
      'supabase/migrations/20260930160000_fase_20c1_trust_user_blocking_core.sql'
    );
    await db.exec(fs.readFileSync(migrationT3A1Path, 'utf-8'));

    const migrationT3A2Path = path.resolve(
      process.cwd(),
      'supabase/migrations/20260930163000_fase_20c1_trust_enforce_bilateral_blocking.sql'
    );
    await db.exec(fs.readFileSync(migrationT3A2Path, 'utf-8'));

    const migrationAlertsPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20260930170000_fase_20c1_trust_enforce_alerts_blocking.sql'
    );
    await db.exec(fs.readFileSync(migrationAlertsPath, 'utf-8'));
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
    await db.exec(`
      DELETE FROM public.bloqueos_usuario;
      DELETE FROM public.alertas_compatibilidad;
      DELETE FROM public.reportes_encuentro;
      DELETE FROM public.intencion_intereses;
      DELETE FROM public.intenciones;
      DELETE FROM public.solicitudes_encuentro_abierto;
      DELETE FROM public.participantes;
      DELETE FROM public.encuentros;
    `);

    // Crear encuentros abiertos para A, B y C
    const encARes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, host_id, is_open, estado, locality_id, max_participants, opened_at, fecha, hora
      ) VALUES (
        'Encuentro de User A', '${userA}', true, 'activo', 'caba_palermo', 5, now(), CURRENT_DATE + 2, '18:00:00'
      ) RETURNING id;
    `);
    encounterAId = encARes.rows[0].id;

    const encBRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, host_id, is_open, estado, locality_id, max_participants, opened_at, fecha, hora
      ) VALUES (
        'Encuentro de User B', '${userB}', true, 'activo', 'caba_palermo', 5, now(), CURRENT_DATE + 2, '18:00:00'
      ) RETURNING id;
    `);
    encounterBId = encBRes.rows[0].id;

    const encCRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, host_id, is_open, estado, locality_id, max_participants, opened_at, fecha, hora
      ) VALUES (
        'Encuentro de User C', '${userC}', true, 'activo', 'caba_palermo', 5, now(), CURRENT_DATE + 2, '18:00:00'
      ) RETURNING id;
    `);
    encounterCId = encCRes.rows[0].id;

    // Crear intenciones para A, B y C
    const intARes = await db.query<{ id: string }>(`
      INSERT INTO public.intenciones (
        titulo, descripcion, user_id, estado, locality_id, modalidad
      ) VALUES (
        'Intención de User A', 'Vamos a jugar tenis', '${userA}', 'activa', 'caba_palermo', 'presencial'
      ) RETURNING id;
    `);
    intentionAId = intARes.rows[0].id;

    const intBRes = await db.query<{ id: string }>(`
      INSERT INTO public.intenciones (
        titulo, descripcion, user_id, estado, locality_id, modalidad
      ) VALUES (
        'Intención de User B', 'Vamos a tomar café', '${userB}', 'activa', 'caba_palermo', 'presencial'
      ) RETURNING id;
    `);
    intentionBId = intBRes.rows[0].id;

    const intCRes = await db.query<{ id: string }>(`
      INSERT INTO public.intenciones (
        titulo, descripcion, user_id, estado, locality_id, modalidad
      ) VALUES (
        'Intención de User C', 'Vamos a programar', '${userC}', 'activa', 'caba_palermo', 'presencial'
      ) RETURNING id;
    `);
    intentionCId = intCRes.rows[0].id;
  });

  // ============================================================
  // TEST SUITE 1: Discovery Encuentros Abiertos
  // ============================================================
  test('1. Discovery Encuentros: sin bloqueo todos ven todos los encuentros', async () => {
    await setAuthContext(userA);
    const resA = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const itemsA = resA.rows[0].get_discovery_encuentros_abiertos;
    assert.equal(itemsA.length, 3);

    // Anónimo también ve todos
    await setAuthContext(null);
    const resAnon = await db.query<{ get_discovery_encuentros_abiertos: any }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    assert.equal(resAnon.rows[0].get_discovery_encuentros_abiertos.length, 3);
  });

  test('2. Discovery Encuentros: filtrado bilateral silencioso cuando A bloquea a B', async () => {
    // Establecer bloqueo A -> B
    await db.exec(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${userA}', '${userB}');
    `);

    // A consulta discovery: no debe ver el encuentro de B, sí el de A y C
    await setAuthContext(userA);
    const resA = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const idsA = resA.rows[0].get_discovery_encuentros_abiertos.map((x: any) => x.id);
    assert.ok(idsA.includes(encounterAId), 'A ve su propio encuentro');
    assert.ok(idsA.includes(encounterCId), 'A ve el encuentro de C');
    assert.ok(!idsA.includes(encounterBId), 'A NO debe ver el encuentro del bloqueado B');

    // B consulta discovery: no debe ver el encuentro de A, sí el de B y C (bilateral)
    await setAuthContext(userB);
    const resB = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const idsB = resB.rows[0].get_discovery_encuentros_abiertos.map((x: any) => x.id);
    assert.ok(idsB.includes(encounterBId), 'B ve su propio encuentro');
    assert.ok(idsB.includes(encounterCId), 'B ve el encuentro de C');
    assert.ok(!idsB.includes(encounterAId), 'B NO debe ver el encuentro de quien lo bloqueó (A)');

    // C (tercero no involucrado) ve todos
    await setAuthContext(userC);
    const resC = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const idsC = resC.rows[0].get_discovery_encuentros_abiertos.map((x: any) => x.id);
    assert.ok(idsC.includes(encounterAId), 'C ve el de A');
    assert.ok(idsC.includes(encounterBId), 'C ve el de B');
    assert.ok(idsC.includes(encounterCId), 'C ve el de C');

    // Anónimo ve todos
    await setAuthContext(null);
    const resAnon = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    assert.equal(resAnon.rows[0].get_discovery_encuentros_abiertos.length, 3);
  });

  test('3. Discovery Encuentros: restauración tras desbloqueo', async () => {
    // Bloquear y luego desbloquear
    await db.exec(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${userA}', '${userB}');
    `);

    await setAuthContext(userA);
    const resBlocked = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    assert.equal(resBlocked.rows[0].get_discovery_encuentros_abiertos.length, 2);

    // Desbloquear
    await db.exec(`
      DELETE FROM public.bloqueos_usuario
      WHERE blocker_id = '${userA}' AND blocked_id = '${userB}';
    `);

    const resUnblocked = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    assert.equal(resUnblocked.rows[0].get_discovery_encuentros_abiertos.length, 3);
  });

  // ============================================================
  // TEST SUITE 2: Discovery Intenciones Activas
  // ============================================================
  test('4. Discovery Intenciones: filtrado bilateral silencioso cuando B bloquea a A', async () => {
    // Bloqueo inverso B -> A
    await db.exec(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${userB}', '${userA}');
    `);

    // A consulta intenciones: no ve la intención de B
    await setAuthContext(userA);
    const resA = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() AS get_discovery_intenciones_activas;`
    );
    const idsA = resA.rows[0].get_discovery_intenciones_activas.map((x: any) => x.id);
    assert.ok(idsA.includes(intentionAId), 'A ve su propia intención');
    assert.ok(idsA.includes(intentionCId), 'A ve la intención de C');
    assert.ok(!idsA.includes(intentionBId), 'A NO ve la intención de B');

    // B consulta intenciones: no ve la intención de A
    await setAuthContext(userB);
    const resB = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() AS get_discovery_intenciones_activas;`
    );
    const idsB = resB.rows[0].get_discovery_intenciones_activas.map((x: any) => x.id);
    assert.ok(idsB.includes(intentionBId), 'B ve su propia intención');
    assert.ok(idsB.includes(intentionCId), 'B ve la intención de C');
    assert.ok(!idsB.includes(intentionAId), 'B NO ve la intención de A');

    // C ve todas
    await setAuthContext(userC);
    const resC = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() AS get_discovery_intenciones_activas;`
    );
    assert.equal(resC.rows[0].get_discovery_intenciones_activas.length, 3);

    // Anon ve todas
    await setAuthContext(null);
    const resAnon = await db.query<{ get_discovery_intenciones_activas: any[] }>(
      `SELECT public.get_discovery_intenciones_activas() AS get_discovery_intenciones_activas;`
    );
    assert.equal(resAnon.rows[0].get_discovery_intenciones_activas.length, 3);
  });

  // ============================================================
  // TEST SUITE 3: Solicitar Sumarse a Encuentro Abierto
  // ============================================================
  test('5. Solicitar sumarse: rechazo fail-closed genérico cuando existe bloqueo bilateral', async () => {
    // Bloqueo A -> B
    await db.exec(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${userA}', '${userB}');
    `);

    // B intenta solicitar sumarse al encuentro de A
    await setAuthContext(userB);
    const resB = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encounterAId}', 'Usuario B', 'Hola quiero sumarme'
      ) AS solicitar_sumarse_encuentro_abierto;`
    );
    const resultB = resB.rows[0].solicitar_sumarse_encuentro_abierto;
    assert.equal(resultB.ok, false);
    assert.equal(resultB.error, 'encuentro_not_open', 'Error genérico e indistinguible de no abierto');

    // Verificar que no se insertó ninguna fila en solicitudes
    const countRes = await db.query<{ count: string }>(
      `SELECT count(*) FROM public.solicitudes_encuentro_abierto WHERE usuario_id = '${userB}';`
    );
    assert.equal(parseInt(countRes.rows[0].count, 10), 0);

    // Intentar también en la otra dirección: si B bloqueó a A, A intentando sumarse a B también falla
    await db.exec(`
      DELETE FROM public.bloqueos_usuario;
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${userB}', '${userA}');
    `);

    await setAuthContext(userA);
    const resA = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encounterBId}', 'Usuario A', 'Hola quiero sumarme'
      ) AS solicitar_sumarse_encuentro_abierto;`
    );
    const resultA = resA.rows[0].solicitar_sumarse_encuentro_abierto;
    assert.equal(resultA.ok, false);
    assert.equal(resultA.error, 'encuentro_not_open');
  });

  test('6. Solicitar sumarse: éxito cuando no hay bloqueo', async () => {
    await setAuthContext(userB);
    const res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encounterAId}', 'Usuario B', 'Hola quiero sumarme'
      ) AS solicitar_sumarse_encuentro_abierto;`
    );
    const result = res.rows[0].solicitar_sumarse_encuentro_abierto;
    assert.equal(result.ok, true);
    assert.equal(result.estado, 'pending');
    assert.ok(result.request_id);
  });

  // ============================================================
  // TEST SUITE 4: Aprobar Solicitud con Guard Concurrente
  // ============================================================
  test('7. Aprobar solicitud: guard concurrente rechaza si surgió bloqueo previo a aprobación', async () => {
    // 1. Crear solicitud legítima de B hacia A
    await setAuthContext(userB);
    const solRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encounterAId}', 'Usuario B', 'Hola quiero sumarme'
      ) AS solicitar_sumarse_encuentro_abierto;`
    );
    const reqId = solRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    // 2. Surge un bloqueo concurrente B -> A antes de que A apruebe
    await db.exec(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${userB}', '${userA}');
    `);

    // 3. Host A intenta aprobar: debe ser rechazado con request_not_available
    await setAuthContext(userA);
    const aprRes = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
      `SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}') AS aprobar_solicitud_encuentro_abierto;`
    );
    const aprResult = aprRes.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(aprResult.ok, false);
    assert.equal(aprResult.error, 'request_not_available');

    // 4. Verificar que no se creó participante
    const partCount = await db.query<{ count: string }>(
      `SELECT count(*) FROM public.participantes WHERE encuentro_id = '${encounterAId}';`
    );
    assert.equal(parseInt(partCount.rows[0].count, 10), 0);

    // 5. Verificar que la solicitud continúa estrictamente en estado 'pending'
    const reqCheck = await db.query<{ estado: string; participante_id: string | null; token_participante: string | null }>(
      `SELECT estado, participante_id, token_participante FROM public.solicitudes_encuentro_abierto WHERE id = '${reqId}';`
    );
    assert.equal(reqCheck.rows[0].estado, 'pending', 'Solicitud continúa pending tras el guard');
    assert.equal(reqCheck.rows[0].participante_id, null, 'NO se creó participante');
    assert.equal(reqCheck.rows[0].token_participante, null, 'NO se generó token');
  });

  test('8. Aprobar solicitud: normal preserva user_id del solicitante', async () => {
    // 1. Crear solicitud de B hacia A
    await setAuthContext(userB);
    const solRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encounterAId}', 'Usuario B', 'Hola quiero sumarme'
      ) AS solicitar_sumarse_encuentro_abierto;`
    );
    const reqId = solRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    // 2. A aprueba
    await setAuthContext(userA);
    const aprRes = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(
      `SELECT public.aprobar_solicitud_encuentro_abierto('${reqId}') AS aprobar_solicitud_encuentro_abierto;`
    );
    const aprResult = aprRes.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(aprResult.ok, true);
    assert.ok(aprResult.participante_id);
    assert.ok(aprResult.token_invitacion);

    // 3. Verificar que participante tiene user_id = userB (preservación de T2-B2-P)
    const partRes = await db.query<{ user_id: string; token_invitacion: string }>(
      `SELECT user_id, token_invitacion FROM public.participantes WHERE id = '${aprResult.participante_id}';`
    );
    assert.equal(partRes.rows[0].user_id, userB);
    assert.equal(partRes.rows[0].token_invitacion, aprResult.token_invitacion);
  });

  // ============================================================
  // TEST SUITE 5: set_interes_intencion con Enforcement
  // ============================================================
  test('9. Marcar interés: rechaza fail-closed genérico cuando existe bloqueo bilateral', async () => {
    // Bloqueo A -> B
    await db.exec(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${userA}', '${userB}');
    `);

    // B intenta marcar interés en intención de A
    await setAuthContext(userB);
    const resB = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('${intentionAId}', true) AS set_interes_intencion;`
    );
    const resultB = resB.rows[0].set_interes_intencion;
    assert.equal(resultB.ok, false);
    assert.equal(resultB.error, 'intention_not_found_or_inactive');

    // A intenta marcar interés en intención de B
    await setAuthContext(userA);
    const resA = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('${intentionBId}', true) AS set_interes_intencion;`
    );
    const resultA = resA.rows[0].set_interes_intencion;
    assert.equal(resultA.ok, false);
    assert.equal(resultA.error, 'intention_not_found_or_inactive');

    // Desmarcar interés (p_interesado = false) no debe arrojar error por bloqueo
    const resUnmark = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('${intentionBId}', false) AS set_interes_intencion;`
    );
    assert.equal(resUnmark.rows[0].set_interes_intencion.ok, true);
    assert.equal(resUnmark.rows[0].set_interes_intencion.interesado, false);
  });

  test('10. Marcar interés: éxito normal cuando no hay bloqueo', async () => {
    await setAuthContext(userB);
    const res = await db.query<{ set_interes_intencion: any }>(
      `SELECT public.set_interes_intencion('${intentionAId}', true) AS set_interes_intencion;`
    );
    const result = res.rows[0].set_interes_intencion;
    assert.equal(result.ok, true);
    assert.equal(result.interesado, true);
    assert.equal(result.interested_count, 1);
  });

  // ============================================================
  // TEST SUITE 6: Coexistencia con Reportes y Preservación Histórica
  // ============================================================
  test('11. Preservación histórica y reportes: un bloqueo no impide reporte pre-solicitud', async () => {
    // 1. B solicita sumarse a A
    await setAuthContext(userB);
    const solRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encounterAId}', 'Usuario B', 'Mensaje con spam o sospechoso'
      ) AS solicitar_sumarse_encuentro_abierto;`
    );
    const reqId = solRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    // 2. A bloquea a B usando la RPC segura de T3-A1
    await setAuthContext(userA);
    const blockRes = await db.query<{ bloquear_desde_solicitud_seguro: any }>(
      `SELECT public.bloquear_desde_solicitud_seguro('${reqId}') AS bloquear_desde_solicitud_seguro;`
    );
    assert.equal(blockRes.rows[0].bloquear_desde_solicitud_seguro.ok, true);

    // 3. A emite reporte pre_solicitud contra la solicitud bloqueada: DEBE FUNCIONAR
    const repRes = await db.query<{ crear_reporte_seguro: any }>(
      `SELECT public.crear_reporte_seguro(
        '${reqId}', 'pre_solicitud', 'inappropriate_behavior', 'Detalle de conducta inadecuada'
      ) AS crear_reporte_seguro;`
    );
    const repResult = repRes.rows[0].crear_reporte_seguro;
    assert.equal(repResult.ok, true);
    assert.equal(repResult.estado, 'pending');

    // 4. Verificar fila de reporte
    const reportRow = await db.query<{ reporter_id: string; reported_id: string; contexto: string }>(
      `SELECT reporter_id, reported_id, contexto FROM public.reportes_encuentro WHERE solicitud_id = '${reqId}';`
    );
    assert.equal(reportRow.rows[0].reporter_id, userA);
    assert.equal(reportRow.rows[0].reported_id, userB);
    assert.equal(reportRow.rows[0].contexto, 'pre_solicitud');
  });

  test('12. Desbloqueo no revive solicitudes resueltas/canceladas históricas', async () => {
    // 1. B solicita a A
    await setAuthContext(userB);
    const solRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encounterAId}', 'Usuario B', 'Hola'
      ) AS solicitar_sumarse_encuentro_abierto;`
    );
    const reqId = solRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    // 2. A bloquea a B (la solicitud pasa a rejected)
    await setAuthContext(userA);
    await db.query(`SELECT public.bloquear_desde_solicitud_seguro('${reqId}');`);

    // 3. A desbloquea a B
    const unblockRes = await db.query<{ desbloquear_usuario_seguro: any }>(
      `SELECT public.desbloquear_usuario_seguro('${userB}') AS desbloquear_usuario_seguro;`
    );
    assert.equal(unblockRes.rows[0].desbloquear_usuario_seguro.ok, true);

    // 4. La solicitud anterior debe seguir 'rejected', NUNCA reactivada a 'pending'
    const solRow = await db.query<{ estado: string }>(
      `SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${reqId}';`
    );
    assert.equal(solRow.rows[0].estado, 'rejected');

    // 5. Pero ahora B puede enviar una NUEVA solicitud limpia si lo desea
    await setAuthContext(userB);
    const newSolRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(
      `SELECT public.solicitar_sumarse_encuentro_abierto(
        '${encounterAId}', 'Usuario B', 'Nueva solicitud tras desbloqueo'
      ) AS solicitar_sumarse_encuentro_abierto;`
    );
    assert.equal(newSolRes.rows[0].solicitar_sumarse_encuentro_abierto.ok, true);
  });

  // ============================================================
  // TEST SUITE 7: Alertas In-App — Enforcement Bilateral de Bloqueos
  // ============================================================
  test('13. Alertas: visible sin bloqueo y filtrado bilateral (receptor bloquea o host bloquea)', async () => {
    // 1. Insertar alerta de compatibilidad para User A sobre Encuentro de User B (host: userB)
    const alertRes = await db.query<{ id: string; created_at: string }>(`
      INSERT INTO public.alertas_compatibilidad (
        user_id, source_intencion_id, target_encuentro_id, tipo, leida
      ) VALUES (
        '${userA}', '${intentionAId}', '${encounterBId}', 'interes_convertido', false
      ) RETURNING id, created_at;
    `);
    const alertId = alertRes.rows[0].id;
    const originalCreatedAt = alertRes.rows[0].created_at;

    // A. Alerta válida sin bloqueo -> visible
    await setAuthContext(userA);
    const resInitial = await db.query<{ get_mis_alertas_seguro: any }>(
      `SELECT public.get_mis_alertas_seguro() AS get_mis_alertas_seguro;`
    );
    const initialAlerts = resInitial.rows[0].get_mis_alertas_seguro.alertas;
    assert.equal(initialAlerts.length, 1);
    assert.equal(initialAlerts[0].id, alertId);

    // H. DTO sigue sin exponer: public_token, host_id, lugar_texto, datos privados
    const alertDto = initialAlerts[0];
    assert.equal(alertDto.public_token, undefined, 'DTO no debe exponer public_token');
    assert.equal(alertDto.host_id, undefined, 'DTO no debe exponer host_id');
    assert.equal(alertDto.lugar_texto, undefined, 'DTO no debe exponer lugar_texto');
    assert.equal(alertDto.encuentro.public_token, undefined, 'DTO anidado no debe exponer public_token');
    assert.equal(alertDto.encuentro.host_id, undefined, 'DTO anidado no debe exponer host_id');
    assert.equal(alertDto.encuentro.lugar_texto, undefined, 'DTO anidado no debe exponer lugar_texto');

    // B. Receptor (userA) bloquea al host del encuentro objetivo (userB) -> alerta NO visible
    await db.exec(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${userA}', '${userB}');
    `);

    const resBlockedByReceptor = await db.query<{ get_mis_alertas_seguro: any }>(
      `SELECT public.get_mis_alertas_seguro() AS get_mis_alertas_seguro;`
    );
    assert.equal(resBlockedByReceptor.rows[0].get_mis_alertas_seguro.alertas.length, 0, 'Alerta oculta tras bloqueo de receptor');

    // F & G. La fila en alertas_compatibilidad permanece intacta (no borrada, leida y created_at inalterados)
    const checkRow1 = await db.query<{ count: string; leida: boolean; created_at: string }>(
      `SELECT count(*) OVER() as count, leida, created_at FROM public.alertas_compatibilidad WHERE id = '${alertId}';`
    );
    assert.equal(parseInt(checkRow1.rows[0].count, 10), 1, 'Fila de alerta preservada');
    assert.equal(checkRow1.rows[0].leida, false, 'leida inalterado');
    assert.equal(new Date(checkRow1.rows[0].created_at).getTime(), new Date(originalCreatedAt).getTime(), 'created_at inalterado');

    // C. Host (userB) bloquea al receptor (userA) -> alerta NO visible
    await db.exec(`
      DELETE FROM public.bloqueos_usuario;
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${userB}', '${userA}');
    `);

    const resBlockedByHost = await db.query<{ get_mis_alertas_seguro: any }>(
      `SELECT public.get_mis_alertas_seguro() AS get_mis_alertas_seguro;`
    );
    assert.equal(resBlockedByHost.rows[0].get_mis_alertas_seguro.alertas.length, 0, 'Alerta oculta tras bloqueo de host');

    // D. Tercero sin relación de bloqueo (userC) no afecta la alerta
    await db.exec(`
      DELETE FROM public.bloqueos_usuario;
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${userC}', '${userB}');
    `);

    // El bloqueo C -> B no debe afectar la alerta de A con B
    const resThirdPartyBlock = await db.query<{ get_mis_alertas_seguro: any }>(
      `SELECT public.get_mis_alertas_seguro() AS get_mis_alertas_seguro;`
    );
    assert.equal(resThirdPartyBlock.rows[0].get_mis_alertas_seguro.alertas.length, 1, 'Bloqueo de tercero no afecta la alerta de A');

    // E. Desbloqueo -> alerta vuelve a ser visible si continúa siendo válida
    await db.exec(`
      DELETE FROM public.bloqueos_usuario;
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${userA}', '${userB}');
    `);
    // Primero confirmamos que bajo bloqueo está oculta
    const resBlocked = await db.query<{ get_mis_alertas_seguro: any }>(
      `SELECT public.get_mis_alertas_seguro() AS get_mis_alertas_seguro;`
    );
    assert.equal(resBlocked.rows[0].get_mis_alertas_seguro.alertas.length, 0);

    // Desbloquear
    await db.exec(`
      DELETE FROM public.bloqueos_usuario
      WHERE blocker_id = '${userA}' AND blocked_id = '${userB}';
    `);

    const resRestored = await db.query<{ get_mis_alertas_seguro: any }>(
      `SELECT public.get_mis_alertas_seguro() AS get_mis_alertas_seguro;`
    );
    assert.equal(resRestored.rows[0].get_mis_alertas_seguro.alertas.length, 1, 'Alerta restaurada tras desbloqueo');
    assert.equal(resRestored.rows[0].get_mis_alertas_seguro.alertas[0].id, alertId);
  });
});
