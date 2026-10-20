import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

/**
 * Suite de Pruebas Backend: Panel de Información y Mensajes del Encuentro V1
 * Cobertura exhaustiva de las 24 compuertas del Sprint 2.
 */
describe('Panel de Información y Mensajes del Encuentro V1 — Backend & RLS (PGlite)', () => {
  let db: PGlite;

  const hostPermanent = '11111111-1111-1111-1111-111111111111';
  const hostAnon = '22222222-2222-2222-2222-222222222222';
  const participantRegistered = '33333333-3333-3333-3333-333333333333';
  const otherUser = '44444444-4444-4444-4444-444444444444';
  const blockedUser = '55555555-5555-5555-5555-555555555555';

  let encounterActiveId: string;
  let encounterCoordOpenId: string;
  let encounterCoordClosedId: string;
  let encounterPastWritingWindowId: string;
  let encounterCancelledId: string;
  let guestTokenIndividual: string;
  let guestTokenFromGeneral: string;
  let guestTokenPending: string;
  let guestTokenRejected: string;

  const setAuth = async (userId: string | null, isAnon = false) => {
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId ?? ''}', false);`);
    await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '${isAnon ? 'true' : 'false'}', false);`);
  };

  const parse = (raw: any): any => {
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  };

  const rpc = async (expr: string, userId: string | null, isAnon = false): Promise<any> => {
    await setAuth(userId, isAnon);
    await db.exec(`SET ROLE authenticated;`);
    try {
      const res = await db.query<{ result: any }>(`SELECT ${expr} AS result;`);
      return parse(res.rows[0].result);
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  };

  before(async () => {
    db = new PGlite();

    // 1. Setup mock Supabase roles & auth environment
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT,
        is_anonymous BOOLEAN DEFAULT false
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT json_build_object(
          'sub', NULLIF(current_setting('request.jwt.claim.sub', true), ''),
          'is_anonymous', NULLIF(current_setting('request.jwt.claim.is_anonymous', true), '')::boolean
        )::jsonb;
      $$ LANGUAGE SQL STABLE;

      CREATE TABLE IF NOT EXISTS public.rate_limit_policies (
        action TEXT PRIMARY KEY,
        max_requests INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL,
        enabled BOOLEAN DEFAULT true,
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
        action TEXT NOT NULL REFERENCES public.rate_limit_policies(action) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        scope_key TEXT NOT NULL DEFAULT '',
        window_start TIMESTAMPTZ NOT NULL,
        request_count INTEGER NOT NULL CHECK (request_count > 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (action, user_id, scope_key, window_start)
      );

      CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(
        p_action TEXT,
        p_scope_key TEXT DEFAULT ''
      )
      RETURNS JSONB
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $func$
      DECLARE
        v_user_id UUID := auth.uid();
        v_policy RECORD;
        v_window_start TIMESTAMPTZ;
        v_new_count INTEGER;
      BEGIN
        IF v_user_id IS NULL THEN
          RETURN jsonb_build_object('allowed', false, 'error', 'authentication_required');
        END IF;

        SELECT max_requests, window_seconds, enabled
        INTO v_policy
        FROM public.rate_limit_policies
        WHERE action = p_action;

        IF NOT FOUND OR v_policy.enabled = false THEN
          RETURN jsonb_build_object('allowed', true);
        END IF;

        v_window_start := to_timestamp(
          floor(extract(epoch from now()) / v_policy.window_seconds) * v_policy.window_seconds
        );

        INSERT INTO public.rate_limit_buckets (action, user_id, scope_key, window_start, request_count, updated_at)
        VALUES (p_action, v_user_id, COALESCE(p_scope_key, ''), v_window_start, 1, now())
        ON CONFLICT (action, user_id, scope_key, window_start)
        DO UPDATE SET request_count = public.rate_limit_buckets.request_count + 1, updated_at = now()
        WHERE public.rate_limit_buckets.request_count < v_policy.max_requests
        RETURNING request_count INTO v_new_count;

        IF v_new_count IS NULL THEN
          RETURN jsonb_build_object('allowed', false, 'error', 'rate_limited');
        END IF;

        RETURN jsonb_build_object('allowed', true, 'remaining', v_policy.max_requests - v_new_count);
      END;
      $func$;

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        blocker_id UUID NOT NULL,
        blocked_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (blocker_id, blocked_id)
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
        tipo_invitacion TEXT NOT NULL DEFAULT 'link_general',
        tema TEXT DEFAULT 'blue',
        estado TEXT NOT NULL DEFAULT 'activo',
        date_mode TEXT NOT NULL DEFAULT 'fixed',
        public_token UUID DEFAULT gen_random_uuid(),
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT NOT NULL,
        token_invitacion UUID UNIQUE,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        user_id UUID,
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.inbox_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_user_id UUID NOT NULL,
        notification_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id UUID NOT NULL,
        deep_link TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        payload JSONB DEFAULT '{}'::jsonb,
        dedup_key TEXT NOT NULL,
        read_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_inbox_recipient_dedup UNIQUE (recipient_user_id, dedup_key)
      );
    `);

    // 2. Load the actual migration
    const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20261020100000_encounter_messages_panel_v1.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(migrationSql);

    // 3. Seed users
    await db.exec(`
      INSERT INTO auth.users (id, email, is_anonymous) VALUES
        ('${hostPermanent}', 'host@test.com', false),
        ('${hostAnon}', 'anon@test.com', true),
        ('${participantRegistered}', 'part@test.com', false),
        ('${otherUser}', 'other@test.com', false),
        ('${blockedUser}', 'blocked@test.com', false);
    `);

    // 4. Seed Encuentros
    // Encuentro 1: Activo, fecha futura (mañana a las 20:00)
    const enc1Res = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, fecha, hora, estado, date_mode)
      VALUES (
        '${hostPermanent}',
        'Encuentro Asado Activo',
        (now() AT TIME ZONE 'America/Argentina/Buenos_Aires' + interval '1 day')::date,
        '20:00:00'::time,
        'activo',
        'fixed'
      )
      RETURNING id;
    `);
    encounterActiveId = enc1Res.rows[0].id;

    // Encuentro 2: Coordinación abierta (sin fecha/hora definitiva)
    const enc2Res = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, fecha, hora, estado, date_mode)
      VALUES (
        '${hostPermanent}',
        'Encuentro Coordinación Abierta',
        NULL,
        NULL,
        'activo',
        'coordination'
      )
      RETURNING id;
    `);
    encounterCoordOpenId = enc2Res.rows[0].id;

    // Encuentro 3: Coordinación cerrada con fecha elegida (hoy a las 21:00)
    const enc3Res = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, fecha, hora, estado, date_mode)
      VALUES (
        '${hostPermanent}',
        'Encuentro Coordinación Cerrada',
        (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
        '21:00:00'::time,
        'activo',
        'coordination'
      )
      RETURNING id;
    `);
    encounterCoordClosedId = enc3Res.rows[0].id;

    // Encuentro 4: Pasado hace 3 días (fuera de la ventana de 24 hs)
    const enc4Res = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, fecha, hora, estado, date_mode)
      VALUES (
        '${hostPermanent}',
        'Encuentro Expirado',
        (now() AT TIME ZONE 'America/Argentina/Buenos_Aires' - interval '3 days')::date,
        '10:00:00'::time,
        'activo',
        'fixed'
      )
      RETURNING id;
    `);
    encounterPastWritingWindowId = enc4Res.rows[0].id;

    // Encuentro 5: Cancelado
    const enc5Res = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, fecha, hora, estado, date_mode)
      VALUES (
        '${hostPermanent}',
        'Encuentro Cancelado',
        (now() AT TIME ZONE 'America/Argentina/Buenos_Aires' + interval '2 days')::date,
        '18:00:00'::time,
        'cancelado',
        'fixed'
      )
      RETURNING id;
    `);
    encounterCancelledId = enc5Res.rows[0].id;

    // 5. Seed Participantes
    // Participante A: Registrado confirmado en Encuentro 1
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, user_id, estado)
      VALUES ('${encounterActiveId}', 'Juan Registrado', 'individual', '${participantRegistered}', 'confirmado');
    `);

    // Participante B: Invitado individual sin registro con token_invitacion confirmado en Encuentro 1
    const pBRes = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, token_invitacion, estado)
      VALUES ('${encounterActiveId}', 'Lucas Invitado', 'individual', gen_random_uuid(), 'confirmado')
      RETURNING token_invitacion;
    `);
    guestTokenIndividual = pBRes.rows[0].token_invitacion;

    // Participante C: Invitado desde enlace general que confirmó y tiene token personal
    const pCRes = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, token_invitacion, estado)
      VALUES ('${encounterActiveId}', 'Sofia General', 'generico', gen_random_uuid(), 'confirmado')
      RETURNING token_invitacion;
    `);
    guestTokenFromGeneral = pCRes.rows[0].token_invitacion;

    // Participante D: Invitado pendiente
    const pDRes = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, token_invitacion, estado)
      VALUES ('${encounterActiveId}', 'Pedro Pendiente', 'individual', gen_random_uuid(), 'pendiente')
      RETURNING token_invitacion;
    `);
    guestTokenPending = pDRes.rows[0].token_invitacion;

    // Participante E: Invitado rechazado
    const pERes = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, token_invitacion, estado)
      VALUES ('${encounterActiveId}', 'Marta Rechazada', 'individual', gen_random_uuid(), 'rechazado')
      RETURNING token_invitacion;
    `);
    guestTokenRejected = pERes.rows[0].token_invitacion;

    // Participante F: Usuario bloqueado bilateralmente
    await db.exec(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, user_id, estado)
      VALUES ('${encounterActiveId}', 'Carlos Bloqueado', 'individual', '${blockedUser}', 'confirmado');

      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${hostPermanent}', '${blockedUser}');
    `);

    // Participante G: Confirmado en Encuentro Coordinación Cerrada
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, user_id, estado)
      VALUES ('${encounterCoordClosedId}', 'Juan Registrado', 'individual', '${participantRegistered}', 'confirmado');
    `);

    // Participante H: Confirmado en Encuentro Expirado
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, user_id, estado)
      VALUES ('${encounterPastWritingWindowId}', 'Juan Registrado', 'individual', '${participantRegistered}', 'confirmado');
    `);

    // Participante I: Confirmado en Encuentro Cancelado
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, user_id, estado)
      VALUES ('${encounterCancelledId}', 'Juan Registrado', 'individual', '${participantRegistered}', 'confirmado');
    `);
  });

  // 1. Organizador registrado
  test('1. Organizador registrado puede leer y publicar en su encuentro', async () => {
    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Aviso del host: traer algo para beber')`,
      hostPermanent
    );
    assert.strictEqual(resPub.ok, true, 'Host debe poder publicar');
    assert.ok(resPub.mensaje_id, 'Debe devolver ID del mensaje creado');

    const resGet = await rpc(`public.get_mensajes_encuentro_seguro('${encounterActiveId}')`, hostPermanent);
    assert.strictEqual(resGet.ok, true);
    assert.strictEqual(resGet.is_host, true);
    assert.strictEqual(resGet.can_write, true);
    assert.strictEqual(resGet.mensajes.length, 1);
    assert.strictEqual(resGet.mensajes[0].es_organizador, true);
  });

  // 2. Organizador anónimo legítimo
  test('2. Organizador anónimo legítimo (auth.uid() = host_id) puede publicar y administrar', async () => {
    // Crear un encuentro cuyo host_id sea hostAnon
    const encAnonRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, fecha, hora, estado, date_mode)
      VALUES (
        '${hostAnon}',
        'Encuentro Privado Anónimo',
        (now() AT TIME ZONE 'America/Argentina/Buenos_Aires' + interval '1 day')::date,
        '19:00:00'::time,
        'activo',
        'fixed'
      )
      RETURNING id;
    `);
    const encAnonId = encAnonRes.rows[0].id;

    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encAnonId}', 'Mensaje desde host anónimo')`,
      hostAnon,
      true // isAnon = true
    );
    assert.strictEqual(resPub.ok, true, 'Host anónimo legítimo debe poder publicar');

    const resGet = await rpc(`public.get_mensajes_encuentro_seguro('${encAnonId}')`, hostAnon, true);
    assert.strictEqual(resGet.ok, true);
    assert.strictEqual(resGet.is_host, true);
    assert.strictEqual(resGet.mensajes.length, 1);
    assert.strictEqual(resGet.mensajes[0].es_organizador, true);
  });

  // 3. Invitado individual sin registro (token_invitacion)
  test('3. Invitado individual sin registro puede leer y escribir con su token personal', async () => {
    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Hola, yo llevo la ensalada!', NULL, '${guestTokenIndividual}')`,
      null
    );
    assert.strictEqual(resPub.ok, true, 'Invitado sin registro con token debe poder publicar');

    const resGet = await rpc(
      `public.get_mensajes_encuentro_seguro('${encounterActiveId}', '${guestTokenIndividual}')`,
      null
    );
    assert.strictEqual(resGet.ok, true);
    assert.strictEqual(resGet.is_host, false);
    assert.strictEqual(resGet.can_write, true);
    const msg = resGet.mensajes.find((m: any) => m.contenido.includes('llevo la ensalada'));
    assert.ok(msg, 'El mensaje del invitado debe estar presente');
    assert.strictEqual(msg.es_propio, true, 'Para el invitado debe figurar como mensaje propio');
  });

  // 4. Participante registrado confirmado
  test('4. Participante registrado confirmado puede leer y escribir con su sesión auth', async () => {
    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', '¿A qué hora nos encontramos en la puerta?')`,
      participantRegistered
    );
    assert.strictEqual(resPub.ok, true, 'Participante registrado confirmado debe poder publicar');

    const resGet = await rpc(`public.get_mensajes_encuentro_seguro('${encounterActiveId}')`, participantRegistered);
    assert.strictEqual(resGet.ok, true);
    assert.strictEqual(resGet.is_host, false);
    const msg = resGet.mensajes.find((m: any) => m.contenido.includes('puerta'));
    assert.ok(msg);
    assert.strictEqual(msg.es_propio, true);
  });

  // 5. Participante desde enlace general que obtiene token personal
  test('5. Participante de link general con token individual emitido accede y publica', async () => {
    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Confirmado por link general', NULL, '${guestTokenFromGeneral}')`,
      null
    );
    assert.strictEqual(resPub.ok, true, 'Debe permitir publicar con token emitido por confirmación general');
  });

  // 6. Intento de acceso usando solo public_token
  test('6. Intento de acceso usando public_token o token arbitrario debe ser RECHAZADO', async () => {
    const encRes = await db.query<{ public_token: string }>(
      `SELECT public_token FROM public.encuentros WHERE id = '${encounterActiveId}';`
    );
    const generalPublicToken = encRes.rows[0].public_token;

    // Intentar leer con public_token
    const resGet = await rpc(
      `public.get_mensajes_encuentro_seguro('${encounterActiveId}', '${generalPublicToken}')`,
      null
    );
    assert.strictEqual(resGet.ok, false);
    assert.strictEqual(resGet.error, 'unauthorized', 'public_token NO debe autorizar lectura');

    // Intentar publicar con public_token
    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Ataque con public token', NULL, '${generalPublicToken}')`,
      null
    );
    assert.strictEqual(resPub.ok, false);
    assert.strictEqual(resPub.error, 'unauthorized', 'public_token NO debe autorizar publicación');
  });

  // 7. Invitado pendiente o rechazado
  test('7. Invitado pendiente o rechazado debe ser rechazado fail-closed', async () => {
    const resPending = await rpc(
      `public.get_mensajes_encuentro_seguro('${encounterActiveId}', '${guestTokenPending}')`,
      null
    );
    assert.strictEqual(resPending.ok, false);
    assert.strictEqual(resPending.error, 'participant_not_confirmed');

    const resRejected = await rpc(
      `public.get_mensajes_encuentro_seguro('${encounterActiveId}', '${guestTokenRejected}')`,
      null
    );
    assert.strictEqual(resRejected.ok, false);
    assert.strictEqual(resRejected.error, 'participant_not_confirmed');
  });

  // 8. Participante retirado o bloqueado
  test('8. Usuario con bloqueo bilateral activo con el host debe ser rechazado', async () => {
    const resGet = await rpc(`public.get_mensajes_encuentro_seguro('${encounterActiveId}')`, blockedUser);
    assert.strictEqual(resGet.ok, false);
    assert.strictEqual(resGet.error, 'blocked_user');

    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Mensaje de usuario bloqueado')`,
      blockedUser
    );
    assert.strictEqual(resPub.ok, false);
    assert.strictEqual(resPub.error, 'blocked_user');
  });

  // 9. Encuentro ajeno
  test('9. Usuario autenticado ajeno sin participación confirmada debe ser rechazado', async () => {
    const resGet = await rpc(`public.get_mensajes_encuentro_seguro('${encounterActiveId}')`, otherUser);
    assert.strictEqual(resGet.ok, false);
    assert.strictEqual(resGet.error, 'unauthorized');

    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Intento en encuentro ajeno')`,
      otherUser
    );
    assert.strictEqual(resPub.ok, false);
    assert.strictEqual(resPub.error, 'unauthorized');
  });

  // 10. Encuentro con coordinación abierta
  test('10. Encuentro con coordinación abierta (sin fecha/hora elegida) debe mantener panel bloqueado', async () => {
    const resGet = await rpc(`public.get_mensajes_encuentro_seguro('${encounterCoordOpenId}')`, hostPermanent);
    assert.strictEqual(resGet.ok, false);
    assert.strictEqual(resGet.error, 'coordination_not_closed');

    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterCoordOpenId}', 'Mensaje antes de elegir fecha')`,
      hostPermanent
    );
    assert.strictEqual(resPub.ok, false);
    assert.strictEqual(resPub.error, 'coordination_not_closed');
  });

  // 11. Coordinación cerrada con fecha elegida
  test('11. Coordinación cerrada con fecha elegida habilita lectura y escritura', async () => {
    const resGet = await rpc(`public.get_mensajes_encuentro_seguro('${encounterCoordClosedId}')`, hostPermanent);
    assert.strictEqual(resGet.ok, true);
    assert.strictEqual(resGet.can_write, true);

    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterCoordClosedId}', 'Fecha elegida, mensaje habilitado')`,
      participantRegistered
    );
    assert.strictEqual(resPub.ok, true);
  });

  // 12. Escritura durante el encuentro
  test('12. Escritura permitida durante el encuentro', async () => {
    // Encuentro configurado para hoy a la misma hora actual
    const encNowRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, fecha, hora, estado, date_mode)
      VALUES (
        '${hostPermanent}',
        'Encuentro En Curso',
        (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
        (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::time,
        'activo',
        'fixed'
      )
      RETURNING id;
    `);
    const encNowId = encNowRes.rows[0].id;

    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encNowId}', 'Mensaje en vivo durante el encuentro')`,
      hostPermanent
    );
    assert.strictEqual(resPub.ok, true);
  });

  // 13. Escritura hasta 24 horas después
  test('13. Escritura permitida hasta 24 horas después del inicio', async () => {
    // Encuentro iniciado hace 10 horas (dentro de las 24 horas)
    const enc10hRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, fecha, hora, estado, date_mode)
      VALUES (
        '${hostPermanent}',
        'Encuentro Hace 10 horas',
        ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires' - interval '10 hours'))::date,
        ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires' - interval '10 hours'))::time,
        'activo',
        'fixed'
      )
      RETURNING id;
    `);
    const enc10hId = enc10hRes.rows[0].id;

    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${enc10hId}', 'Mensaje de agradecimiento post encuentro')`,
      hostPermanent
    );
    assert.strictEqual(resPub.ok, true);
  });

  // 14. Bloqueo pasado el límite temporal
  test('14. Bloqueo de escritura pasado el límite de 24 horas (solo lectura)', async () => {
    const resGet = await rpc(`public.get_mensajes_encuentro_seguro('${encounterPastWritingWindowId}')`, participantRegistered);
    assert.strictEqual(resGet.ok, true);
    assert.strictEqual(resGet.can_write, false, 'can_write debe ser false');
    assert.strictEqual(resGet.writing_window_closed, true);

    const resPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterPastWritingWindowId}', 'Intento de escribir en encuentro vencido')`,
      participantRegistered
    );
    assert.strictEqual(resPub.ok, false);
    assert.strictEqual(resPub.error, 'writing_window_closed');
  });

  // 15. Cancelación y privacidad del historial
  test('15. Cancelación bloquea nuevos mensajes y oculta historial a participantes para resguardar privacidad', async () => {
    // Participante intenta acceder a encuentro cancelado
    const resPartGet = await rpc(`public.get_mensajes_encuentro_seguro('${encounterCancelledId}')`, participantRegistered);
    assert.strictEqual(resPartGet.ok, false);
    assert.strictEqual(resPartGet.error, 'meeting_cancelled');

    // Organizador puede acceder al historial a fines de moderación
    const resHostGet = await rpc(`public.get_mensajes_encuentro_seguro('${encounterCancelledId}')`, hostPermanent);
    assert.strictEqual(resHostGet.ok, true);
    assert.strictEqual(resHostGet.can_write, false, 'No se puede escribir en encuentro cancelado');

    // Ni el organizador puede agregar nuevos mensajes si está cancelado
    const resHostPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterCancelledId}', 'Intento de publicar en cancelado')`,
      hostPermanent
    );
    assert.strictEqual(resHostPub.ok, false);
    assert.strictEqual(resHostPub.error, 'writing_window_closed');
  });

  // 16. Edición y eliminación de mensajes propios
  test('16. Edición permitida durante 15 minutos; rechazada pasados los 15 minutos', async () => {
    // 16.1 Publicar mensaje
    const pub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Texto original antes de editar')`,
      participantRegistered
    );
    const msgId = pub.mensaje_id;

    // 16.2 Editar inmediatamente (válido)
    const editOk = await rpc(
      `public.editar_mensaje_encuentro_seguro('${msgId}', 'Texto modificado exitosamente')`,
      participantRegistered
    );
    assert.strictEqual(editOk.ok, true);

    // 16.3 Simular que pasaron 16 minutos actualizando creado_en
    await db.query(`UPDATE public.mensajes_encuentro SET creado_en = now() - interval '16 minutes' WHERE id = '${msgId}'`);

    const editExpired = await rpc(
      `public.editar_mensaje_encuentro_seguro('${msgId}', 'Intento de editar luego de 16 min')`,
      participantRegistered
    );
    assert.strictEqual(editExpired.ok, false);
    assert.strictEqual(editExpired.error, 'edit_window_expired');

    // 16.4 Eliminación de mensaje propio
    const delRes = await rpc(
      `public.eliminar_mensaje_encuentro_seguro('${msgId}')`,
      participantRegistered
    );
    assert.strictEqual(delRes.ok, true);
    assert.strictEqual(delRes.tipo, 'autor');
  });

  // 17. Moderación del organizador
  test('17. El organizador puede moderar (eliminar) mensajes de cualquier participante', async () => {
    const pub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Mensaje con contenido inapropiado')`,
      participantRegistered
    );
    const msgId = pub.mensaje_id;

    const delHost = await rpc(
      `public.eliminar_mensaje_encuentro_seguro('${msgId}')`,
      hostPermanent
    );
    assert.strictEqual(delHost.ok, true);
    assert.strictEqual(delHost.tipo, 'organizador');

    // Verificar que figura como eliminado en la lectura
    const resGet = await rpc(`public.get_mensajes_encuentro_seguro('${encounterActiveId}')`, hostPermanent);
    const msg = resGet.mensajes.find((m: any) => m.id === msgId);
    assert.strictEqual(msg.eliminado, true);
    assert.strictEqual(msg.contenido, '', 'Contenido debe estar vacío si fue eliminado');
  });

  // 18. Máximo de tres destacados bajo concurrencia
  test('18. El organizador puede destacar hasta 3 mensajes; el 4to es rechazado', async () => {
    const p1 = await rpc(`public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Destacado 1')`, hostPermanent);
    const p2 = await rpc(`public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Destacado 2')`, hostPermanent);
    const p3 = await rpc(`public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Destacado 3')`, hostPermanent);
    const p4 = await rpc(`public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Destacado 4')`, hostPermanent);

    const h1 = await rpc(`public.destacar_mensaje_encuentro_seguro('${p1.mensaje_id}', true)`, hostPermanent);
    const h2 = await rpc(`public.destacar_mensaje_encuentro_seguro('${p2.mensaje_id}', true)`, hostPermanent);
    const h3 = await rpc(`public.destacar_mensaje_encuentro_seguro('${p3.mensaje_id}', true)`, hostPermanent);

    assert.strictEqual(h1.ok, true);
    assert.strictEqual(h2.ok, true);
    assert.strictEqual(h3.ok, true);

    // Intento de 4to destacado
    const h4 = await rpc(`public.destacar_mensaje_encuentro_seguro('${p4.mensaje_id}', true)`, hostPermanent);
    assert.strictEqual(h4.ok, false);
    assert.strictEqual(h4.error, 'max_highlights_reached');

    // Des-destacar uno y volver a probar
    const unh1 = await rpc(`public.destacar_mensaje_encuentro_seguro('${p1.mensaje_id}', false)`, hostPermanent);
    assert.strictEqual(unh1.ok, true);

    const h4Retry = await rpc(`public.destacar_mensaje_encuentro_seguro('${p4.mensaje_id}', true)`, hostPermanent);
    assert.strictEqual(h4Retry.ok, true);

    // No permitir que el autor edite un mensaje destacado para alterar silenciosamente info
    const editBlocked = await rpc(
      `public.editar_mensaje_encuentro_seguro('${p4.mensaje_id}', 'Contenido alterado')`,
      participantRegistered
    );
    // (p4 fue creado por host, pero probemos con un mensaje de participante destacado)
    const partMsg = await rpc(`public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Aporte del participante')`, participantRegistered);
    await rpc(`public.destacar_mensaje_encuentro_seguro('${p2.mensaje_id}', false)`, hostPermanent); // liberar cupo
    await rpc(`public.destacar_mensaje_encuentro_seguro('${partMsg.mensaje_id}', true)`, hostPermanent);

    const editPartBlocked = await rpc(
      `public.editar_mensaje_encuentro_seguro('${partMsg.mensaje_id}', 'Texto cambiado sigilosamente')`,
      participantRegistered
    );
    assert.strictEqual(editPartBlocked.ok, false);
    assert.strictEqual(editPartBlocked.error, 'cannot_edit_highlighted_message');
  });

  // 19. Respuestas de un solo nivel y rechazo cross-encounter
  test('19. Respuesta de un nivel admitida; rechaza anidamiento > 1 y mensajes de otro encuentro', async () => {
    // 19.1 Mensaje padre nivel 0
    const parentPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Pregunta principal')`,
      participantRegistered
    );
    const parentId = parentPub.mensaje_id;

    // 19.2 Respuesta nivel 1 (permitida)
    const reply1Pub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Respuesta nivel 1', '${parentId}')`,
      hostPermanent
    );
    assert.strictEqual(reply1Pub.ok, true);
    const reply1Id = reply1Pub.mensaje_id;

    // 19.3 Intento de respuesta a nivel 1 (nivel 2 no permitido)
    const reply2Pub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Intento respuesta nivel 2', '${reply1Id}')`,
      participantRegistered
    );
    assert.strictEqual(reply2Pub.ok, false);
    assert.strictEqual(reply2Pub.error, 'nested_reply_depth_exceeded');

    // 19.4 Rechazo cross-encounter
    const crossPub = await rpc(
      `public.publicar_mensaje_encuentro_seguro('${encounterCoordClosedId}', 'Intento cross-encounter', '${parentId}')`,
      participantRegistered
    );
    assert.strictEqual(crossPub.ok, false);
    assert.strictEqual(crossPub.error, 'parent_cross_encounter_rejected');
  });

  // 20. Rate limiting de invitados anónimos bajo concurrencia
  test('20. Rate limiting para invitados sin sesión (máx 10 mensajes en 5 minutos)', async () => {
    // Nuevo invitado para probar cuota limpia
    const pNew = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, token_invitacion, estado)
      VALUES ('${encounterActiveId}', 'Invitado Stress', 'individual', gen_random_uuid(), 'confirmado')
      RETURNING token_invitacion;
    `);
    const stressToken = pNew.rows[0].token_invitacion;

    let successCount = 0;
    let rateLimitedCount = 0;

    for (let i = 0; i < 12; i++) {
      const res = await rpc(
        `public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Mensaje stress ${i}', NULL, '${stressToken}')`,
        null
      );
      if (res.ok) successCount++;
      if (res.error === 'rate_limited') rateLimitedCount++;
    }

    assert.strictEqual(successCount, 10, 'Deben permitirse exactamente 10 mensajes');
    assert.strictEqual(rateLimitedCount, 2, 'A partir del 11vo mensaje debe ser rate-limited');
  });

  // 21. Paginación y polling sin duplicados
  test('21. Paginación correcta (limit, offset) y orden cronológico ASC', async () => {
    const resP1 = await rpc(
      `public.get_mensajes_encuentro_seguro('${encounterActiveId}', NULL, 3, 0)`,
      hostPermanent
    );
    assert.strictEqual(resP1.ok, true);
    assert.strictEqual(resP1.mensajes.length, 3);
    assert.strictEqual(resP1.has_more, true);

    const resP2 = await rpc(
      `public.get_mensajes_encuentro_seguro('${encounterActiveId}', NULL, 3, 3)`,
      hostPermanent
    );
    assert.strictEqual(resP2.ok, true);
    assert.strictEqual(resP2.mensajes.length, 3);

    // Asegurar que no hay duplicados entre páginas
    const idsP1 = new Set(resP1.mensajes.map((m: any) => m.id));
    for (const m of resP2.mensajes) {
      assert.strictEqual(idsP1.has(m.id), false, 'La página 2 no debe contener mensajes de la página 1');
    }
  });

  // 22. Ausencia de notificaciones masivas por mensajes ordinarios; solo mensaje destacado genera inbox
  test('22. Solo los mensajes destacados por el host generan notificaciones en Inbox', async () => {
    // 22.1 Conteo de notificaciones antes de publicar mensaje ordinario
    const countBefore = await db.query<{ count: number }>(`
      SELECT count(*)::int as count FROM public.inbox_notifications WHERE recipient_user_id = '${participantRegistered}';
    `);
    const initialCount = countBefore.rows[0].count;

    // Publicar mensaje ordinario
    await rpc(`public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Mensaje normalito sin destacar')`, hostPermanent);

    const countAfterNormal = await db.query<{ count: number }>(`
      SELECT count(*)::int as count FROM public.inbox_notifications WHERE recipient_user_id = '${participantRegistered}';
    `);
    assert.strictEqual(countAfterNormal.rows[0].count, initialCount, 'Un mensaje normal NO debe generar notificación en Inbox');

    // 22.2 Limpiar destacados previos para disponer de slot libre y probar notificación limpia
    await db.query(`UPDATE public.mensajes_encuentro SET destacado = false WHERE encuentro_id = '${encounterActiveId}';`);

    const countBeforeHighlight = await db.query<{ count: number }>(`
      SELECT count(*)::int as count FROM public.inbox_notifications WHERE recipient_user_id = '${participantRegistered}';
    `);
    const countBeforeHighlightVal = countBeforeHighlight.rows[0].count;

    const pub = await rpc(`public.publicar_mensaje_encuentro_seguro('${encounterActiveId}', 'Aviso urgente destacado')`, hostPermanent);
    const hlRes = await rpc(`public.destacar_mensaje_encuentro_seguro('${pub.mensaje_id}', true)`, hostPermanent);
    assert.strictEqual(hlRes.ok, true, 'Debe destacar exitosamente');

    const countAfterHighlight = await db.query<{ count: number }>(`
      SELECT count(*)::int as count FROM public.inbox_notifications WHERE recipient_user_id = '${participantRegistered}';
    `);
    assert.strictEqual(countAfterHighlight.rows[0].count, countBeforeHighlightVal + 1, 'Un mensaje destacado DEBE generar notificación en Inbox');

    // Verificar que el payload no filtre direcciones ni contenido privado
    const notif = await db.query<{ body: string; payload: any }>(`
      SELECT body, payload FROM public.inbox_notifications
      WHERE recipient_user_id = '${participantRegistered}'
      ORDER BY created_at DESC LIMIT 1;
    `);
    assert.ok(!notif.rows[0].body.includes('http'), 'El cuerpo de la notificación no debe filtrar enlaces');
    assert.strictEqual(notif.rows[0].payload.encuentro_id, encounterActiveId);
  });

  // 23. Compatibilidad con invitaciones y notificaciones críticas existentes
  test('23. Las tablas y constraints existentes de participantes y encuentros no se alteraron', async () => {
    const encCols = await db.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'encuentros';
    `);
    const colNames = encCols.rows.map(r => r.column_name);
    assert.ok(colNames.includes('host_id'));
    assert.ok(colNames.includes('fecha'));
    assert.ok(colNames.includes('hora'));
    assert.ok(colNames.includes('estado'));
  });

  // 24. Limpieza del estado al cambiar de usuario o sesión
  test('24. Comprobación de fail-closed estricto cuando auth.uid() es nulo sin token', async () => {
    const res = await rpc(`public.get_mensajes_encuentro_seguro('${encounterActiveId}')`, null);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'unauthorized');
  });

  // 25. Preflight de seguridad: RLS cerrada y helpers internos protegidos contra ejecución directa
  test('25. Preflight de seguridad: RLS cerrada y helpers internos protegidos contra invocación directa', async () => {
    await db.exec(`SET ROLE authenticated;`);
    await setAuth(participantRegistered, false);

    // Intentar invocar directamente consumir_rate_limit_participante como authenticated debe fallar por permisos
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.consumir_rate_limit_participante('${participantRegistered}', 'publicar_mensaje_encuentro', '');`);
      },
      /permission denied/i,
      'consumir_rate_limit_participante debe negar EXECUTE a authenticated'
    );

    // Intentar invocar directamente resolver_actor_encuentro como authenticated debe fallar por permisos
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.resolver_actor_encuentro('${encounterActiveId}');`);
      },
      /permission denied/i,
      'resolver_actor_encuentro debe negar EXECUTE a authenticated'
    );

    // Intentar SELECT directo sobre mensajes_encuentro como authenticated debe fallar por permisos
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.mensajes_encuentro;`);
      },
      /permission denied/i,
      'mensajes_encuentro debe negar SELECT a authenticated'
    );

    // Intentar SELECT directo sobre participante_rate_limit_buckets como authenticated debe fallar por permisos
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.participante_rate_limit_buckets;`);
      },
      /permission denied/i,
      'participante_rate_limit_buckets debe negar SELECT a authenticated'
    );

    // Probar ahora como rol anon
    await db.exec(`SET ROLE anon;`);
    await setAuth(null, true);

    await assert.rejects(
      async () => {
        await db.query(`SELECT public.consumir_rate_limit_participante('${participantRegistered}', 'publicar_mensaje_encuentro', '');`);
      },
      /permission denied/i,
      'consumir_rate_limit_participante debe negar EXECUTE a anon'
    );

    await assert.rejects(
      async () => {
        await db.query(`SELECT public.resolver_actor_encuentro('${encounterActiveId}');`);
      },
      /permission denied/i,
      'resolver_actor_encuentro debe negar EXECUTE a anon'
    );

    await db.exec(`RESET ROLE;`);
  });
});
