import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-C1 (T3-B0): Contrato Contextual Seguro de Desbloqueo — Backend Tests', () => {
  let db: PGlite;

  const userA = '11111111-1111-1111-1111-111111111111'; // Host A
  const userB = '22222222-2222-2222-2222-222222222222'; // Solicitante B
  const userC = '33333333-3333-3333-3333-333333333333'; // Tercero C
  const anonUser = '44444444-4444-4444-4444-444444444444';

  let encounterAId: string;
  let encounterBId: string;
  let intentionAId: string;
  let intentionBId: string;
  let solicitudAtoBId: string; // Solicitud donde Host es A y solicitante es B

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
        tema_invitacion TEXT DEFAULT 'friends',
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
        tipo TEXT NOT NULL DEFAULT 'interes_convertido',
        leida BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_alertas_compatibilidad UNIQUE (user_id, source_intencion_id, target_encuentro_id)
      );
    `);

    // 2. Aplicar migraciones T2, T3-A1, T3-A2, alertas y T3-B0
    const migrations = [
      'supabase/migrations/20260930133000_fix_fase_20c1_trust_report_context_and_temporal.sql',
      'supabase/migrations/20260930160000_fase_20c1_trust_user_blocking_core.sql',
      'supabase/migrations/20260930163000_fase_20c1_trust_enforce_bilateral_blocking.sql',
      'supabase/migrations/20260930170000_fase_20c1_trust_enforce_alerts_blocking.sql',
      'supabase/migrations/20260930180000_fase_20c1_trust_contextual_unblock_contract.sql',
    ];

    for (const relPath of migrations) {
      const fullPath = path.resolve(process.cwd(), relPath);
      await db.exec(fs.readFileSync(fullPath, 'utf-8'));
    }
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

    // Encuentro de Host A
    const encARes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, host_id, is_open, estado, locality_id, max_participants, opened_at, fecha, hora
      ) VALUES (
        'Encuentro Host A', '${userA}', true, 'activo', 'caba_palermo', 5, now(), CURRENT_DATE + 2, '18:00:00'
      ) RETURNING id;
    `);
    encounterAId = encARes.rows[0].id;

    // Encuentro de Host B
    const encBRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo, host_id, is_open, estado, locality_id, max_participants, opened_at, fecha, hora
      ) VALUES (
        'Encuentro Host B', '${userB}', true, 'activo', 'caba_palermo', 5, now(), CURRENT_DATE + 2, '18:00:00'
      ) RETURNING id;
    `);
    encounterBId = encBRes.rows[0].id;

    // Intenciones
    const intARes = await db.query<{ id: string }>(`
      INSERT INTO public.intenciones (
        titulo, descripcion, user_id, estado, locality_id, modalidad
      ) VALUES (
        'Intención A', 'Tenis', '${userA}', 'activa', 'caba_palermo', 'presencial'
      ) RETURNING id;
    `);
    intentionAId = intARes.rows[0].id;

    const intBRes = await db.query<{ id: string }>(`
      INSERT INTO public.intenciones (
        titulo, descripcion, user_id, estado, locality_id, modalidad
      ) VALUES (
        'Intención B', 'Café', '${userB}', 'activa', 'caba_palermo', 'presencial'
      ) RETURNING id;
    `);
    intentionBId = intBRes.rows[0].id;

    // Solicitud legítima de User B hacia Encuentro de User A
    const solRes = await db.query<{ id: string }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (
        encuentro_id, usuario_id, nombre_solicitante, mensaje, estado
      ) VALUES (
        '${encounterAId}', '${userB}', 'Usuario B', 'Hola quiero sumarme', 'pending'
      ) RETURNING id;
    `);
    solicitudAtoBId = solRes.rows[0].id;
  });

  // ============================================================
  // SUITE 1: Consulta de Estado Contextual Propio
  // ============================================================
  test('1. Estado contextual: Host y Solicitante sin bloqueo ven blocked_by_me = false', async () => {
    // Host consulta
    await setAuthContext(userA);
    const resA = await db.query<{ get_estado_bloqueo_desde_solicitud_seguro: any }>(
      `SELECT public.get_estado_bloqueo_desde_solicitud_seguro('${solicitudAtoBId}') AS get_estado_bloqueo_desde_solicitud_seguro;`
    );
    const dataA = resA.rows[0].get_estado_bloqueo_desde_solicitud_seguro;
    assert.equal(dataA.ok, true);
    assert.equal(dataA.blocked_by_me, false);

    // Solicitante consulta
    await setAuthContext(userB);
    const resB = await db.query<{ get_estado_bloqueo_desde_solicitud_seguro: any }>(
      `SELECT public.get_estado_bloqueo_desde_solicitud_seguro('${solicitudAtoBId}') AS get_estado_bloqueo_desde_solicitud_seguro;`
    );
    const dataB = resB.rows[0].get_estado_bloqueo_desde_solicitud_seguro;
    assert.equal(dataB.ok, true);
    assert.equal(dataB.blocked_by_me, false);
  });

  test('2. Estado contextual: Host bloquea a Solicitante (unilateral)', async () => {
    // Host bloquea desde solicitud
    await setAuthContext(userA);
    await db.query(`SELECT public.bloquear_desde_solicitud_seguro('${solicitudAtoBId}');`);

    // Host consulta su estado: debe ver blocked_by_me = true
    const resA = await db.query<{ get_estado_bloqueo_desde_solicitud_seguro: any }>(
      `SELECT public.get_estado_bloqueo_desde_solicitud_seguro('${solicitudAtoBId}') AS get_estado_bloqueo_desde_solicitud_seguro;`
    );
    const dataA = resA.rows[0].get_estado_bloqueo_desde_solicitud_seguro;
    assert.equal(dataA.ok, true);
    assert.equal(dataA.blocked_by_me, true);

    // Solicitante consulta su estado: como B NO ha bloqueado a A, debe ver blocked_by_me = false
    await setAuthContext(userB);
    const resB = await db.query<{ get_estado_bloqueo_desde_solicitud_seguro: any }>(
      `SELECT public.get_estado_bloqueo_desde_solicitud_seguro('${solicitudAtoBId}') AS get_estado_bloqueo_desde_solicitud_seguro;`
    );
    const dataB = resB.rows[0].get_estado_bloqueo_desde_solicitud_seguro;
    assert.equal(dataB.ok, true);
    assert.equal(dataB.blocked_by_me, false, 'B no debe enterarse de que A lo bloqueó');
  });

  test('3. Estado contextual: Bloqueo bilateral (ambos se bloquean)', async () => {
    // Host A bloquea a Solicitante B
    await setAuthContext(userA);
    await db.query(`SELECT public.bloquear_desde_solicitud_seguro('${solicitudAtoBId}');`);

    // Solicitante B también bloquea a Host A
    await setAuthContext(userB);
    await db.query(`SELECT public.bloquear_desde_solicitud_seguro('${solicitudAtoBId}');`);

    // Cada uno debe ver blocked_by_me = true para su propio bloqueo
    const resB = await db.query<{ get_estado_bloqueo_desde_solicitud_seguro: any }>(
      `SELECT public.get_estado_bloqueo_desde_solicitud_seguro('${solicitudAtoBId}') AS get_estado_bloqueo_desde_solicitud_seguro;`
    );
    assert.equal(resB.rows[0].get_estado_bloqueo_desde_solicitud_seguro.blocked_by_me, true);

    await setAuthContext(userA);
    const resA = await db.query<{ get_estado_bloqueo_desde_solicitud_seguro: any }>(
      `SELECT public.get_estado_bloqueo_desde_solicitud_seguro('${solicitudAtoBId}') AS get_estado_bloqueo_desde_solicitud_seguro;`
    );
    assert.equal(resA.rows[0].get_estado_bloqueo_desde_solicitud_seguro.blocked_by_me, true);
  });

  // ============================================================
  // SUITE 2: Desbloqueo Contextual Idempotente
  // ============================================================
  test('4. Desbloqueo unilateral: A desbloquea a B', async () => {
    // A bloquea B
    await setAuthContext(userA);
    await db.query(`SELECT public.bloquear_desde_solicitud_seguro('${solicitudAtoBId}');`);

    // A ejecuta desbloqueo contextual
    const unblockRes = await db.query<{ desbloquear_desde_solicitud_seguro: any }>(
      `SELECT public.desbloquear_desde_solicitud_seguro('${solicitudAtoBId}') AS desbloquear_desde_solicitud_seguro;`
    );
    assert.equal(unblockRes.rows[0].desbloquear_desde_solicitud_seguro.ok, true);
    assert.equal(unblockRes.rows[0].desbloquear_desde_solicitud_seguro.blocked, false);

    // Estados posteriores
    const stateA = await db.query<{ get_estado_bloqueo_desde_solicitud_seguro: any }>(
      `SELECT public.get_estado_bloqueo_desde_solicitud_seguro('${solicitudAtoBId}') AS get_estado_bloqueo_desde_solicitud_seguro;`
    );
    assert.equal(stateA.rows[0].get_estado_bloqueo_desde_solicitud_seguro.blocked_by_me, false);

    await setAuthContext(userB);
    const stateB = await db.query<{ get_estado_bloqueo_desde_solicitud_seguro: any }>(
      `SELECT public.get_estado_bloqueo_desde_solicitud_seguro('${solicitudAtoBId}') AS get_estado_bloqueo_desde_solicitud_seguro;`
    );
    assert.equal(stateB.rows[0].get_estado_bloqueo_desde_solicitud_seguro.blocked_by_me, false);

    // Fila en bloqueos_usuario eliminada
    const count = await db.query<{ count: string }>(`SELECT count(*) FROM public.bloqueos_usuario;`);
    assert.equal(parseInt(count.rows[0].count, 10), 0);
  });

  test('5. Desbloqueo en caso bilateral: A desbloquea pero B aún bloquea a A', async () => {
    // Ambos bloquean
    await setAuthContext(userA);
    await db.query(`SELECT public.bloquear_desde_solicitud_seguro('${solicitudAtoBId}');`);

    await setAuthContext(userB);
    await db.query(`SELECT public.bloquear_desde_solicitud_seguro('${solicitudAtoBId}');`);

    // Confirmar 2 filas de bloqueo
    const countInit = await db.query<{ count: string }>(`SELECT count(*) FROM public.bloqueos_usuario;`);
    assert.equal(parseInt(countInit.rows[0].count, 10), 2);

    // A desbloquea a B
    await setAuthContext(userA);
    const unblockRes = await db.query<{ desbloquear_desde_solicitud_seguro: any }>(
      `SELECT public.desbloquear_desde_solicitud_seguro('${solicitudAtoBId}') AS desbloquear_desde_solicitud_seguro;`
    );
    assert.equal(unblockRes.rows[0].desbloquear_desde_solicitud_seguro.ok, true);

    // Debe eliminarse únicamente A -> B, quedando B -> A
    const blocks = await db.query<{ blocker_id: string; blocked_id: string }>(
      `SELECT blocker_id, blocked_id FROM public.bloqueos_usuario;`
    );
    assert.equal(blocks.rows.length, 1);
    assert.equal(blocks.rows[0].blocker_id, userB);
    assert.equal(blocks.rows[0].blocked_id, userA);

    // Estado A: blocked_by_me = false
    const stateA = await db.query<{ get_estado_bloqueo_desde_solicitud_seguro: any }>(
      `SELECT public.get_estado_bloqueo_desde_solicitud_seguro('${solicitudAtoBId}') AS get_estado_bloqueo_desde_solicitud_seguro;`
    );
    assert.equal(stateA.rows[0].get_estado_bloqueo_desde_solicitud_seguro.blocked_by_me, false);

    // Estado B: blocked_by_me = true (preservado)
    await setAuthContext(userB);
    const stateB = await db.query<{ get_estado_bloqueo_desde_solicitud_seguro: any }>(
      `SELECT public.get_estado_bloqueo_desde_solicitud_seguro('${solicitudAtoBId}') AS get_estado_bloqueo_desde_solicitud_seguro;`
    );
    assert.equal(stateB.rows[0].get_estado_bloqueo_desde_solicitud_seguro.blocked_by_me, true);

    // ENFORCEMENT BILATERAL PERSISTE: como B bloquea a A, A NO puede ver a B en Discovery
    await setAuthContext(userA);
    const discEncA = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(
      `SELECT public.get_discovery_encuentros_abiertos() AS get_discovery_encuentros_abiertos;`
    );
    const idsA = discEncA.rows[0].get_discovery_encuentros_abiertos.map((x: any) => x.id);
    assert.ok(!idsA.includes(encounterBId), 'A no debe ver encuentro de B porque B aún lo bloquea');
  });

  test('6. Idempotencia: llamar dos veces desbloquear_desde_solicitud_seguro', async () => {
    // Sin bloqueo previo, llamar desbloquear
    await setAuthContext(userA);
    const res1 = await db.query<{ desbloquear_desde_solicitud_seguro: any }>(
      `SELECT public.desbloquear_desde_solicitud_seguro('${solicitudAtoBId}') AS desbloquear_desde_solicitud_seguro;`
    );
    assert.equal(res1.rows[0].desbloquear_desde_solicitud_seguro.ok, true);
    assert.equal(res1.rows[0].desbloquear_desde_solicitud_seguro.blocked, false);

    // Segunda llamada consecutiva
    const res2 = await db.query<{ desbloquear_desde_solicitud_seguro: any }>(
      `SELECT public.desbloquear_desde_solicitud_seguro('${solicitudAtoBId}') AS desbloquear_desde_solicitud_seguro;`
    );
    assert.equal(res2.rows[0].desbloquear_desde_solicitud_seguro.ok, true);
    assert.equal(res2.rows[0].desbloquear_desde_solicitud_seguro.blocked, false);
  });

  // ============================================================
  // SUITE 3: Privacidad y Restricción a Terceros
  // ============================================================
  test('7. Privacidad: Tercero C no puede consultar estado ni desbloquear con solicitud ajena', async () => {
    await setAuthContext(userC);

    const stateRes = await db.query<{ get_estado_bloqueo_desde_solicitud_seguro: any }>(
      `SELECT public.get_estado_bloqueo_desde_solicitud_seguro('${solicitudAtoBId}') AS get_estado_bloqueo_desde_solicitud_seguro;`
    );
    assert.equal(stateRes.rows[0].get_estado_bloqueo_desde_solicitud_seguro.ok, false);
    assert.equal(stateRes.rows[0].get_estado_bloqueo_desde_solicitud_seguro.error, 'unauthorized');

    const unblockRes = await db.query<{ desbloquear_desde_solicitud_seguro: any }>(
      `SELECT public.desbloquear_desde_solicitud_seguro('${solicitudAtoBId}') AS desbloquear_desde_solicitud_seguro;`
    );
    assert.equal(unblockRes.rows[0].desbloquear_desde_solicitud_seguro.ok, false);
    assert.equal(unblockRes.rows[0].desbloquear_desde_solicitud_seguro.error, 'unauthorized');
  });

  test('8. Privacidad DTO: el payload de respuesta nunca contiene UUIDs ni direcciones', async () => {
    await setAuthContext(userA);
    const stateRes = await db.query<{ get_estado_bloqueo_desde_solicitud_seguro: any }>(
      `SELECT public.get_estado_bloqueo_desde_solicitud_seguro('${solicitudAtoBId}') AS get_estado_bloqueo_desde_solicitud_seguro;`
    );
    const payload = stateRes.rows[0].get_estado_bloqueo_desde_solicitud_seguro;
    const keys = Object.keys(payload);
    assert.deepEqual(keys.sort(), ['blocked_by_me', 'ok']);
    assert.equal(payload.blocked_id, undefined);
    assert.equal(payload.blocker_id, undefined);
    assert.equal(payload.host_id, undefined);
    assert.equal(payload.usuario_id, undefined);
    assert.equal(payload.blocked_by_other, undefined);
    assert.equal(payload.mutual_block, undefined);
  });

  // ============================================================
  // SUITE 4: Preservación Histórica y Reportes
  // ============================================================
  test('9. Desbloquear NO revive solicitudes ni intereses históricos y preserva approved', async () => {
    // 1. Establecer interés mutuo antes de bloquear
    await db.exec(`
      INSERT INTO public.intencion_intereses (intencion_id, user_id)
      VALUES ('${intentionAId}', '${userB}');
    `);

    // 2. A bloquea a B -> solicitud pasa a rejected, interés se elimina
    await setAuthContext(userA);
    await db.query(`SELECT public.bloquear_desde_solicitud_seguro('${solicitudAtoBId}');`);

    const solRejected = await db.query<{ estado: string }>(
      `SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${solicitudAtoBId}';`
    );
    assert.equal(solRejected.rows[0].estado, 'rejected');

    const intCount = await db.query<{ count: string }>(
      `SELECT count(*) FROM public.intencion_intereses WHERE user_id = '${userB}';`
    );
    assert.equal(parseInt(intCount.rows[0].count, 10), 0);

    // 3. A desbloquea a B
    await db.query(`SELECT public.desbloquear_desde_solicitud_seguro('${solicitudAtoBId}');`);

    // 4. La solicitud histórica debe continuar rejected (NO revivida)
    const solAfter = await db.query<{ estado: string }>(
      `SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${solicitudAtoBId}';`
    );
    assert.equal(solAfter.rows[0].estado, 'rejected');

    // 5. El interés eliminado NO reaparece automáticamente
    const intCountAfter = await db.query<{ count: string }>(
      `SELECT count(*) FROM public.intencion_intereses WHERE user_id = '${userB}';`
    );
    assert.equal(parseInt(intCountAfter.rows[0].count, 10), 0);
  });
});
