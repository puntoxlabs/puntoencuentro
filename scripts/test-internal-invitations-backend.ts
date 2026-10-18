import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Invitaciones Internas V1 — Backend & Migración Tests (PGlite)', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const recipientUser = '22222222-2222-2222-2222-222222222222';
  const otherUser = '33333333-3333-3333-3333-333333333333';
  const anonymousUser = '44444444-4444-4444-4444-444444444444';

  let fixedEncuentroId: string;
  let coordEncuentroId: string;

  const setAuthContext = async (userId: string | null, isAnon: boolean = false) => {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '${isAnon ? 'true' : 'false'}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', 'false', false);`);
    }
  };

  const parseResult = (raw: any): any => {
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  };

  before(async () => {
    db = new PGlite();

    // 1. Roles y Funciones Auth Básicas
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
        is_anonymous BOOLEAN DEFAULT false,
        raw_user_meta_data JSONB DEFAULT '{}'::jsonb
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

      -- Base rate limiting & bloqueo tables
      CREATE TABLE IF NOT EXISTS public.rate_limit_policies (
        action TEXT PRIMARY KEY,
        max_tokens NUMERIC NOT NULL,
        refill_rate_per_second NUMERIC NOT NULL,
        bucket_capacity NUMERIC NOT NULL,
        window_seconds INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE OR REPLACE FUNCTION public.verificar_y_consumir_rate_limit(
        p_user_id UUID,
        p_action TEXT,
        p_max INT DEFAULT 5,
        p_window INTERVAL DEFAULT INTERVAL '1 hour'
      ) RETURNS JSONB AS $$
      BEGIN
        RETURN jsonb_build_object('allowed', true);
      END;
      $$ LANGUAGE plpgsql;

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        blocker_id UUID NOT NULL,
        blocked_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      -- Base tablas encuentros y participantes
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
        host_id UUID NOT NULL,
        public_token UUID DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'activo',
        tema TEXT DEFAULT 'blue',
        date_mode TEXT DEFAULT 'fixed',
        max_participants INT,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT NOT NULL CHECK (tipo_invitacion IN ('individual', 'generico')),
        token_invitacion UUID UNIQUE,
        estado TEXT NOT NULL DEFAULT 'pendiente',
        user_id UUID,
        mensaje_respuesta TEXT,
        respondido_en TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      -- Notifications & Outbox base
      CREATE TABLE IF NOT EXISTS public.domain_events_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type TEXT NOT NULL,
        event_version INTEGER NOT NULL DEFAULT 1,
        aggregate_type TEXT NOT NULL,
        aggregate_id UUID NOT NULL,
        actor_user_id UUID,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        dedup_key TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
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
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        dedup_key TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        CONSTRAINT uq_inbox_recipient_dedup UNIQUE (recipient_user_id, dedup_key)
      );

      CREATE OR REPLACE FUNCTION public.insertar_inbox_notification_seguro(
        p_recipient_user_id UUID,
        p_notification_type TEXT,
        p_target_type TEXT,
        p_target_id UUID,
        p_deep_link TEXT,
        p_title TEXT,
        p_body TEXT,
        p_payload JSONB DEFAULT '{}'::jsonb,
        p_dedup_key TEXT DEFAULT NULL,
        p_expires_at TIMESTAMPTZ DEFAULT NULL
      ) RETURNS JSONB AS $$
      DECLARE
        v_dedup TEXT := COALESCE(p_dedup_key, p_notification_type || ':' || p_target_id);
        v_expires TIMESTAMPTZ := COALESCE(p_expires_at, timezone('utc', now()) + INTERVAL '14 days');
        v_id UUID;
      BEGIN
        INSERT INTO public.inbox_notifications (
          recipient_user_id, notification_type, target_type, target_id, deep_link, title, body, payload, dedup_key, expires_at
        ) VALUES (
          p_recipient_user_id, p_notification_type, p_target_type, p_target_id, p_deep_link, p_title, p_body, COALESCE(p_payload, '{}'::jsonb), v_dedup, v_expires
        ) ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING
        RETURNING id INTO v_id;

        RETURN jsonb_build_object('ok', true, 'notification_id', v_id);
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;

      -- Insert test users
      INSERT INTO auth.users (id, email, is_anonymous, raw_user_meta_data) VALUES
        ('${hostUser}', 'host@puntoencuentro.com', false, '{"full_name": "Host Organizador"}'::jsonb),
        ('${recipientUser}', 'invitado@puntoencuentro.com', false, '{"full_name": "Invitado Registrado"}'::jsonb),
        ('${otherUser}', 'otro@puntoencuentro.com', false, '{"full_name": "Otro Usuario"}'::jsonb),
        ('${anonymousUser}', 'anon@puntoencuentro.com', true, '{"full_name": "Anonimo"}'::jsonb);
    `);

    // 2. Ejecutar la migración bajo prueba
    const migPath = path.resolve(process.cwd(), 'supabase/migrations/20261018180000_internal_invitations_v1.sql');
    await db.exec(fs.readFileSync(migPath, 'utf-8'));

    // 3. Crear encuentros de prueba
    const fixedRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, fecha, hora, modalidad, lugar_texto, date_mode, max_participants)
      VALUES ('Picnic de Primavera', '${hostUser}', (CURRENT_DATE + 3), '15:00:00', 'presencial', 'Plaza Central', 'fixed', 5)
      RETURNING id;
    `);
    fixedEncuentroId = fixedRes.rows[0].id;

    const coordRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, modalidad, date_mode)
      VALUES ('Coordinación Asado', '${hostUser}', 'presencial', 'coordination')
      RETURNING id;
    `);
    coordEncuentroId = coordRes.rows[0].id;
  });

  test('1. Rechaza envío si el usuario es anónimo o no autenticado', async () => {
    // No autenticado
    await setAuthContext(null);
    const unauthRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'invitado@puntoencuentro.com', 'Hola'
      ) as result;
    `);
    const res1 = parseResult(unauthRes.rows[0].result);
    assert.equal(res1.ok, false);
    assert.equal(res1.error, 'not_authenticated');

    // Usuario anónimo
    await setAuthContext(anonymousUser, true);
    const anonRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'invitado@puntoencuentro.com', 'Hola'
      ) as result;
    `);
    const res2 = parseResult(anonRes.rows[0].result);
    assert.equal(res2.ok, false);
    assert.equal(res2.error, 'anonymous_user_not_allowed');
  });

  test('2. Rechaza envío si el encuentro no existe o no es del host', async () => {
    await setAuthContext(otherUser, false);
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const fakeRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fakeId}', 'invitado@puntoencuentro.com', 'Hola'
      ) as result;
    `);
    const res = parseResult(fakeRes.rows[0].result);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'encuentro_not_found_or_not_owner');
  });

  test('3. No revela existencia de cuenta: respuesta y estructura 100% neutras para correo inexistente o anónimo', async () => {
    await setAuthContext(hostUser, false);
    // Correo inexistente
    const inexRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'noexiste@test.com', 'Hola'
      ) as result;
    `);
    const res1 = parseResult(inexRes.rows[0].result);
    assert.equal(res1.ok, true);
    assert.equal(res1.sent, undefined, 'No debe exponer la clave sent');
    assert.equal(res1.recipient_id, undefined, 'No debe exponer recipient_id');
    assert.ok(typeof res1.invitation_id === 'string', 'Debe exponer un invitation_id válido');
    assert.ok(typeof res1.request_id === 'string', 'Debe exponer un request_id válido');
    assert.match(res1.message, /Si el correo corresponde a una cuenta registrada/);

    // Correo anónimo
    const anonTargetRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'anon@puntoencuentro.com', 'Hola'
      ) as result;
    `);
    const res2 = parseResult(anonTargetRes.rows[0].result);
    assert.equal(res2.ok, true);
    assert.equal(res2.sent, undefined);
    assert.equal(res2.recipient_id, undefined);
    assert.ok(typeof res2.invitation_id === 'string');
    assert.equal(res2.message, res1.message);

    // Comprobar que en la tabla de invitaciones reales NO se insertó nada para el inexistente ni el anónimo
    const invCount = await db.query<{ count: string }>(`
      SELECT count(*) as count FROM public.invitaciones_internas
      WHERE destinatario_email IN ('noexiste@test.com', 'anon@puntoencuentro.com');
    `);
    assert.equal(parseInt(invCount.rows[0].count, 10), 0, 'No debe crear registros en invitaciones_internas');

    // Pero en solicitudes_invitacion_interna sí se registraron ambas solicitudes para el host
    const solCount = await db.query<{ count: string }>(`
      SELECT count(*) as count FROM public.solicitudes_invitacion_interna
      WHERE destinatario_email IN ('noexiste@test.com', 'anon@puntoencuentro.com');
    `);
    assert.equal(parseInt(solCount.rows[0].count, 10), 2, 'Debe registrar las solicitudes del organizador');
  });

  test('4. Previene auto-invitación', async () => {
    await setAuthContext(hostUser, false);
    const selfRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'host@puntoencuentro.com', 'Hola'
      ) as result;
    `);
    const res = parseResult(selfRes.rows[0].result);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'self_invitation_not_allowed');
  });

  test('5. Envío exitoso a usuario registrado crea solicitud, invitación real, participante pendiente, outbox e inbox', async () => {
    await setAuthContext(hostUser, false);
    const sendRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'invitado@puntoencuentro.com', '¡Sumate al picnic!'
      ) as result;
    `);
    const res = parseResult(sendRes.rows[0].result);
    assert.equal(res.ok, true);
    assert.equal(res.sent, undefined, 'No debe exponer sent');
    const requestId = res.invitation_id;
    assert.ok(requestId);

    // Verificar tabla de solicitudes
    const solRow = await db.query<any>(`
      SELECT * FROM public.solicitudes_invitacion_interna WHERE id = '${requestId}';
    `);
    assert.equal(solRow.rows.length, 1);
    assert.equal(solRow.rows[0].estado, 'pendiente');
    assert.equal(solRow.rows[0].destinatario_email, 'invitado@puntoencuentro.com');
    const realInvId = solRow.rows[0].invitacion_id;
    assert.ok(realInvId, 'Debe vincular a la invitación real');

    // Verificar tabla invitaciones_internas
    const invRow = await db.query<any>(`
      SELECT * FROM public.invitaciones_internas WHERE id = '${realInvId}';
    `);
    assert.equal(invRow.rows.length, 1);
    assert.equal(invRow.rows[0].estado, 'pendiente');
    assert.equal(invRow.rows[0].destinatario_id, recipientUser);
    assert.equal(invRow.rows[0].solicitud_id, requestId);

    // Verificar participante vinculado
    const partId = invRow.rows[0].participante_id;
    assert.ok(partId);
    const partRow = await db.query<any>(`
      SELECT * FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partRow.rows.length, 1);
    assert.equal(partRow.rows[0].estado, 'pendiente');
    assert.equal(partRow.rows[0].user_id, recipientUser);

    // Verificar outbox event
    const outboxRow = await db.query<any>(`
      SELECT * FROM public.domain_events_outbox WHERE aggregate_id = '${realInvId}';
    `);
    assert.equal(outboxRow.rows.length, 1);
    assert.equal(outboxRow.rows[0].event_type, 'internal_invitation.created.v1');

    // Verificar inbox notification
    const inboxRow = await db.query<any>(`
      SELECT * FROM public.inbox_notifications WHERE recipient_user_id = '${recipientUser}';
    `);
    assert.ok(inboxRow.rows.length >= 1);
    const notif = inboxRow.rows[0];
    assert.equal(notif.notification_type, 'internal_invitation');
    assert.equal(notif.deep_link, `/invitation/${realInvId}`);
  });

  test('6. Previene invitación duplicada pendiente para el mismo encuentro y correo (registrado e inexistente)', async () => {
    await setAuthContext(hostUser, false);
    // Para correo registrado
    const dupResReg = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'invitado@puntoencuentro.com', 'Segundo intento'
      ) as result;
    `);
    const resReg = parseResult(dupResReg.rows[0].result);
    assert.equal(resReg.ok, false);
    assert.equal(resReg.error, 'invitation_already_pending');

    // Para correo inexistente ya pendiente (enviado en test 3)
    const dupResInex = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'noexiste@test.com', 'Segundo intento'
      ) as result;
    `);
    const resInex = parseResult(dupResInex.rows[0].result);
    assert.equal(resInex.ok, false);
    assert.equal(resInex.error, 'invitation_already_pending');
    assert.equal(resInex.message, resReg.message, 'El mensaje de error ante duplicado pendiente debe ser 100% idéntico');
  });

  test('7. Detalle de invitación accesible por host y destinatario, con máscaras de privacidad mientras esté pendiente', async () => {
    // Obtener id de la invitación real pendiente
    const invRes = await db.query<any>(`
      SELECT id FROM public.invitaciones_internas WHERE destinatario_id = '${recipientUser}' AND estado = 'pendiente' LIMIT 1;
    `);
    const invId = invRes.rows[0].id;

    // Destinatario consulta detalle
    await setAuthContext(recipientUser, false);
    const destDetail = await db.query<{ result: any }>(`
      SELECT public.get_detalle_invitacion_interna_seguro('${invId}') as result;
    `);
    const res1 = parseResult(destDetail.rows[0].result);
    assert.equal(res1.ok, true);
    assert.equal(res1.invitacion.id, invId);
    assert.equal(res1.encuentro.titulo, 'Picnic de Primavera');
    // Invariante de Privacidad: lugar_texto debe ser NULL mientras la invitación esté pendiente
    assert.equal(res1.encuentro.lugar_texto, null);
    assert.equal(res1.invitacion.token_invitacion, null);

    // Host sí puede ver la logística completa en el detalle
    await setAuthContext(hostUser, false);
    const hostDetail = await db.query<{ result: any }>(`
      SELECT public.get_detalle_invitacion_interna_seguro('${invId}') as result;
    `);
    const resHost = parseResult(hostDetail.rows[0].result);
    assert.equal(resHost.ok, true);
    assert.equal(resHost.encuentro.lugar_texto, 'Plaza Central');

    // Tercero no autorizado
    await setAuthContext(otherUser, false);
    const unauthDetail = await db.query<{ result: any }>(`
      SELECT public.get_detalle_invitacion_interna_seguro('${invId}') as result;
    `);
    const res2 = parseResult(unauthDetail.rows[0].result);
    assert.equal(res2.ok, false);
    assert.equal(res2.error, 'unauthorized');
  });

  test('8. Destinatario acepta invitación -> participante confirmado y solicitud actualizada a aceptada', async () => {
    const invRes = await db.query<any>(`
      SELECT id, solicitud_id, participante_id FROM public.invitaciones_internas WHERE destinatario_id = '${recipientUser}' AND estado = 'pendiente' LIMIT 1;
    `);
    const invId = invRes.rows[0].id;
    const solId = invRes.rows[0].solicitud_id;
    const partId = invRes.rows[0].participante_id;

    // Destinatario responde
    await setAuthContext(recipientUser, false);
    const acceptRes = await db.query<{ result: any }>(`
      SELECT public.responder_invitacion_interna_seguro('${invId}', 'aceptada', '¡Genial, ahí estaré!') as result;
    `);
    const res = parseResult(acceptRes.rows[0].result);
    assert.equal(res.ok, true);
    assert.equal(res.estado, 'aceptada');

    // Comprobar que una vez aceptada, el invitado ahora SÍ tiene acceso a lugar_texto
    const acceptedDetail = await db.query<{ result: any }>(`
      SELECT public.get_detalle_invitacion_interna_seguro('${invId}') as result;
    `);
    const resAcceptedDetail = parseResult(acceptedDetail.rows[0].result);
    assert.equal(resAcceptedDetail.ok, true);
    assert.equal(resAcceptedDetail.encuentro.lugar_texto, 'Plaza Central');
    assert.ok(resAcceptedDetail.invitacion.token_invitacion);

    // Comprobar estado en tabla invitaciones_internas
    const updatedInv = await db.query<any>(`
      SELECT * FROM public.invitaciones_internas WHERE id = '${invId}';
    `);
    assert.equal(updatedInv.rows[0].estado, 'aceptada');

    // Comprobar que la solicitud del organizador también pasó a 'aceptada'
    const updatedSol = await db.query<any>(`
      SELECT * FROM public.solicitudes_invitacion_interna WHERE id = '${solId}';
    `);
    assert.equal(updatedSol.rows[0].estado, 'aceptada');
    assert.equal(updatedSol.rows[0].mensaje, '¡Genial, ahí estaré!');

    // Comprobar participante confirmado
    const updatedPart = await db.query<any>(`
      SELECT * FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(updatedPart.rows[0].estado, 'confirmado');
    assert.equal(updatedPart.rows[0].mensaje_respuesta, '¡Genial, ahí estaré!');

    // Comprobar notificación al host en inbox
    const hostInbox = await db.query<any>(`
      SELECT * FROM public.inbox_notifications WHERE recipient_user_id = '${hostUser}' AND notification_type = 'invitation_accepted';
    `);
    assert.equal(hostInbox.rows.length, 1);
  });

  test('9. No se puede responder dos veces a una invitación ya respondida', async () => {
    const invRes = await db.query<any>(`
      SELECT id FROM public.invitaciones_internas WHERE destinatario_id = '${recipientUser}' AND estado = 'aceptada' LIMIT 1;
    `);
    const invId = invRes.rows[0].id;

    await setAuthContext(recipientUser, false);
    const secondResp = await db.query<{ result: any }>(`
      SELECT public.responder_invitacion_interna_seguro('${invId}', 'rechazada') as result;
    `);
    const res = parseResult(secondResp.rows[0].result);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'invitation_not_pending');
  });

  test('10. Flujo de rechazo de invitación -> participante eliminado y solicitud actualizada a rechazada', async () => {
    // Enviar una nueva invitación a otherUser
    await setAuthContext(hostUser, false);
    const sendRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'otro@puntoencuentro.com', 'Vení al picnic'
      ) as result;
    `);
    const resSend = parseResult(sendRes.rows[0].result);
    const solId = resSend.invitation_id;
    assert.ok(solId);

    // Obtener la invitación real vinculada y su participante
    const solRow = await db.query<any>(`
      SELECT invitacion_id FROM public.solicitudes_invitacion_interna WHERE id = '${solId}';
    `);
    const newInvId = solRow.rows[0].invitacion_id;
    assert.ok(newInvId);

    const invBefore = await db.query<any>(`
      SELECT participante_id FROM public.invitaciones_internas WHERE id = '${newInvId}';
    `);
    const partId = invBefore.rows[0].participante_id;
    assert.ok(partId);

    // otherUser rechaza
    await setAuthContext(otherUser, false);
    const declineRes = await db.query<{ result: any }>(`
      SELECT public.responder_invitacion_interna_seguro('${newInvId}', 'rechazada', 'No puedo ese día') as result;
    `);
    const resDecline = parseResult(declineRes.rows[0].result);
    assert.equal(resDecline.ok, true);
    assert.equal(resDecline.estado, 'rechazada');

    const invRow = await db.query<any>(`
      SELECT * FROM public.invitaciones_internas WHERE id = '${newInvId}';
    `);
    assert.equal(invRow.rows[0].estado, 'rechazada');

    // Solicitud del host actualizada a 'rechazada'
    const solUpdated = await db.query<any>(`
      SELECT * FROM public.solicitudes_invitacion_interna WHERE id = '${solId}';
    `);
    assert.equal(solUpdated.rows[0].estado, 'rechazada');

    // Participante pendiente eliminado
    const partRow = await db.query<any>(`
      SELECT * FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partRow.rows.length, 0);

    // Host recibe notificación de rechazo
    const hostInbox = await db.query<any>(`
      SELECT * FROM public.inbox_notifications WHERE recipient_user_id = '${hostUser}' AND notification_type = 'invitation_declined';
    `);
    assert.equal(hostInbox.rows.length, 1);
  });

  test('11. Flujo de cancelación por parte del host -> cancela solicitud y elimina participante pendiente', async () => {
    // Nueva invitación para probar cancelación
    await setAuthContext(hostUser, false);
    const sendRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${coordEncuentroId}', 'otro@puntoencuentro.com', 'Asado'
      ) as result;
    `);
    const resSend = parseResult(sendRes.rows[0].result);
    const solId = resSend.invitation_id;
    assert.ok(solId);

    const solRow = await db.query<any>(`
      SELECT invitacion_id FROM public.solicitudes_invitacion_interna WHERE id = '${solId}';
    `);
    const invId = solRow.rows[0].invitacion_id;

    const invBefore = await db.query<any>(`
      SELECT participante_id FROM public.invitaciones_internas WHERE id = '${invId}';
    `);
    const partId = invBefore.rows[0].participante_id;
    assert.ok(partId);

    // Cancelar usando el ID de la solicitud (lo que hace la UI del host)
    const cancelRes = await db.query<{ result: any }>(`
      SELECT public.cancelar_invitacion_interna_seguro('${solId}') as result;
    `);
    const resCancel = parseResult(cancelRes.rows[0].result);
    assert.equal(resCancel.ok, true);
    assert.equal(resCancel.estado, 'cancelada');

    // Verificar que solicitud e invitación pasaron a 'cancelada'
    const solAfter = await db.query<any>(`
      SELECT estado FROM public.solicitudes_invitacion_interna WHERE id = '${solId}';
    `);
    assert.equal(solAfter.rows[0].estado, 'cancelada');

    const invAfter = await db.query<any>(`
      SELECT estado FROM public.invitaciones_internas WHERE id = '${invId}';
    `);
    assert.equal(invAfter.rows[0].estado, 'cancelada');

    // Verificar que participante pendiente fue eliminado
    const partRow = await db.query<any>(`
      SELECT * FROM public.participantes WHERE id = '${partId}';
    `);
    assert.equal(partRow.rows.length, 0);

    // Intentar responder después de cancelada
    await setAuthContext(otherUser, false);
    const respAfterCancel = await db.query<{ result: any }>(`
      SELECT public.responder_invitacion_interna_seguro('${invId}', 'aceptada') as result;
    `);
    const resResp = parseResult(respAfterCancel.rows[0].result);
    assert.equal(resResp.ok, false);
    assert.equal(resResp.error, 'invitation_not_pending');
  });

  test('12. Encuentro con coordinación de fecha: aceptar invitación devuelve token de disponibilidad sin confirmar fecha inexistente', async () => {
    await setAuthContext(hostUser, false);
    const sendRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${coordEncuentroId}', 'otro@puntoencuentro.com', 'Coordinemos el asado'
      ) as result;
    `);
    const resSend = parseResult(sendRes.rows[0].result);
    const solId = resSend.invitation_id;
    assert.ok(solId);

    const solRow = await db.query<any>(`
      SELECT invitacion_id FROM public.solicitudes_invitacion_interna WHERE id = '${solId}';
    `);
    const invId = solRow.rows[0].invitacion_id;

    await setAuthContext(otherUser, false);
    const acceptRes = await db.query<{ result: any }>(`
      SELECT public.responder_invitacion_interna_seguro('${invId}', 'aceptada') as result;
    `);
    const resAccept = parseResult(acceptRes.rows[0].result);
    assert.equal(resAccept.ok, true);
    assert.equal(resAccept.estado, 'aceptada');
    assert.equal(resAccept.date_mode, 'coordination');
    assert.ok(resAccept.token_invitacion);

    // Participante en coordinación sigue 'pendiente' hasta que vote disponibilidad
    const invRow = await db.query<any>(`
      SELECT * FROM public.invitaciones_internas WHERE id = '${invId}';
    `);
    const partRow = await db.query<any>(`
      SELECT * FROM public.participantes WHERE id = '${invRow.rows[0].participante_id}';
    `);
    assert.equal(partRow.rows[0].estado, 'pendiente');
    assert.equal(partRow.rows[0].user_id, otherUser);
  });

  test('13. Cancelación del encuentro cancela automáticamente solicitudes e invitaciones pendientes vía trigger', async () => {
    // Crear un nuevo encuentro y una invitación pendiente
    await setAuthContext(hostUser, false);
    const newEncRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, fecha, hora, modalidad, lugar_texto)
      VALUES ('Encuentro que se cancelará', '${hostUser}', (CURRENT_DATE + 5), '19:00:00', 'presencial', 'Café')
      RETURNING id;
    `);
    const encId = newEncRes.rows[0].id;

    const sendRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${encId}', 'otro@puntoencuentro.com', 'Vení al café'
      ) as result;
    `);
    const resSend = parseResult(sendRes.rows[0].result);
    const solId = resSend.invitation_id;
    assert.ok(solId);

    // Cancelar el encuentro
    await db.query(`
      UPDATE public.encuentros SET estado = 'cancelado' WHERE id = '${encId}';
    `);

    // Comprobar que el trigger canceló la solicitud y la invitación interna
    const solRow = await db.query<any>(`
      SELECT estado FROM public.solicitudes_invitacion_interna WHERE id = '${solId}';
    `);
    assert.equal(solRow.rows[0].estado, 'cancelada');

    const invRow = await db.query<any>(`
      SELECT estado FROM public.invitaciones_internas WHERE encuentro_id = '${encId}';
    `);
    assert.equal(invRow.rows[0].estado, 'cancelada');
  });

  test('14. Expiración de invitación impide su aceptación en solicitudes e invitaciones', async () => {
    await setAuthContext(hostUser, false);
    const newEncRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, fecha, hora, modalidad)
      VALUES ('Encuentro con invitación vencida', '${hostUser}', (CURRENT_DATE + 5), '19:00:00', 'virtual')
      RETURNING id;
    `);
    const encId = newEncRes.rows[0].id;

    const sendRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${encId}', 'otro@puntoencuentro.com', 'Test expiración'
      ) as result;
    `);
    const resSend = parseResult(sendRes.rows[0].result);
    const solId = resSend.invitation_id;
    assert.ok(solId);

    const solRow = await db.query<any>(`
      SELECT invitacion_id FROM public.solicitudes_invitacion_interna WHERE id = '${solId}';
    `);
    const invId = solRow.rows[0].invitacion_id;

    // Forzar expiración simulando paso del tiempo en la DB
    await db.exec(`
      UPDATE public.solicitudes_invitacion_interna
      SET expira_en = timezone('utc', now()) - INTERVAL '1 minute'
      WHERE id = '${solId}';

      UPDATE public.invitaciones_internas
      SET expira_en = timezone('utc', now()) - INTERVAL '1 minute'
      WHERE id = '${invId}';
    `);

    // Destinatario intenta responder
    await setAuthContext(otherUser, false);
    const respRes = await db.query<{ result: any }>(`
      SELECT public.responder_invitacion_interna_seguro('${invId}', 'aceptada') as result;
    `);
    const resResp = parseResult(respRes.rows[0].result);
    assert.equal(resResp.ok, false);
    assert.equal(resResp.error, 'invitation_expired');

    // Comprobar estado transicionado a expirada en ambas tablas
    const invAfter = await db.query<any>(`
      SELECT estado FROM public.invitaciones_internas WHERE id = '${invId}';
    `);
    assert.equal(invAfter.rows[0].estado, 'expirada');

    const solAfter = await db.query<any>(`
      SELECT estado FROM public.solicitudes_invitacion_interna WHERE id = '${solId}';
    `);
    assert.equal(solAfter.rows[0].estado, 'expirada');
  });

  // =========================================================================
  // SUITE EXHAUSTIVA DE NO-ENUMERACIÓN Y COMPARACIÓN DE CONTRATOS (PRUEBAS OBLIGATORIAS)
  // =========================================================================

  describe('Pruebas comparativas obligatorias: Correo registrado vs Correo inexistente', () => {
    let compEncuentroId: string;
    const registeredEmail = 'invitado@puntoencuentro.com';
    const nonExistentEmail = 'totalmente_inexistente_98765@example.com';
    let registeredResp: any;
    let nonExistentResp: any;

    before(async () => {
      await setAuthContext(hostUser, false);
      const res = await db.query<{ id: string }>(`
        INSERT INTO public.encuentros (titulo, host_id, fecha, hora, modalidad, lugar_texto, max_participants)
        VALUES ('Encuentro Auditoría Comparativa', '${hostUser}', (CURRENT_DATE + 10), '20:00:00', 'presencial', 'Punto Seguro', 10)
        RETURNING id;
      `);
      compEncuentroId = res.rows[0].id;
    });

    test('C1. Respuesta RPC: idéntica estructura de claves, tipos e información expuesta', async () => {
      await setAuthContext(hostUser, false);

      const r1 = await db.query<{ result: any }>(`
        SELECT public.enviar_invitacion_interna_seguro('${compEncuentroId}', '${registeredEmail}', 'Comparativa A') as result;
      `);
      registeredResp = parseResult(r1.rows[0].result);

      const r2 = await db.query<{ result: any }>(`
        SELECT public.enviar_invitacion_interna_seguro('${compEncuentroId}', '${nonExistentEmail}', 'Comparativa B') as result;
      `);
      nonExistentResp = parseResult(r2.rows[0].result);

      // 1. Ambas respuestas deben ser ok: true
      assert.equal(registeredResp.ok, true);
      assert.equal(nonExistentResp.ok, true);

      // 2. Estructura exacta de claves JSON (sin diferencias de esquema)
      const keys1 = Object.keys(registeredResp).sort();
      const keys2 = Object.keys(nonExistentResp).sort();
      assert.deepEqual(keys1, keys2, 'Las claves del objeto de respuesta deben ser exactamente idénticas');

      // 3. Claves esperadas
      assert.deepEqual(keys1, ['invitation_id', 'message', 'ok', 'request_id']);

      // 4. Prohibición de enumeración: 'sent', 'recipient_id' no deben existir
      assert.equal(registeredResp.sent, undefined);
      assert.equal(nonExistentResp.sent, undefined);
      assert.equal(registeredResp.recipient_id, undefined);
      assert.equal(nonExistentResp.recipient_id, undefined);

      // 5. Mensaje de usuario idéntico
      assert.equal(registeredResp.message, nonExistentResp.message);

      // 6. Ambos IDs deben ser UUIDs válidos
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      assert.match(registeredResp.invitation_id, uuidRegex);
      assert.match(nonExistentResp.invitation_id, uuidRegex);
      assert.match(registeredResp.request_id, uuidRegex);
      assert.match(nonExistentResp.request_id, uuidRegex);
    });

    test('C2. Listado del organizador: ambas solicitudes aparecen indistinguibles en estado pendiente', async () => {
      await setAuthContext(hostUser, false);
      const listRes = await db.query<{ result: any }>(`
        SELECT public.get_invitaciones_internas_encuentro_seguro('${compEncuentroId}') as result;
      `);
      const listData = parseResult(listRes.rows[0].result);
      assert.equal(listData.ok, true);
      assert.ok(Array.isArray(listData.invitaciones));
      assert.equal(listData.invitaciones.length, 2, 'Deben listarse exactamente las 2 solicitudes');

      const itemReg = listData.invitaciones.find((i: any) => i.destinatario_email === registeredEmail);
      const itemInex = listData.invitaciones.find((i: any) => i.destinatario_email === nonExistentEmail);

      assert.ok(itemReg, 'La solicitud al correo registrado debe figurar en la lista');
      assert.ok(itemInex, 'La solicitud al correo inexistente debe figurar en la lista');

      // Comparación de esquema de campos en los ítems
      const itemKeysReg = Object.keys(itemReg).sort();
      const itemKeysInex = Object.keys(itemInex).sort();
      assert.deepEqual(itemKeysReg, itemKeysInex, 'Ambos ítems de la lista deben exponer las mismas propiedades');

      // Ambos deben figurar como 'pendiente'
      assert.equal(itemReg.estado, 'pendiente');
      assert.equal(itemInex.estado, 'pendiente');

      // Ninguno revela destinatario_id ni existencia de cuenta en la base
      assert.equal(itemReg.destinatario_id, undefined);
      assert.equal(itemInex.destinatario_id, undefined);
      assert.equal(itemReg.respondido_en, null);
      assert.equal(itemInex.respondido_en, null);
      assert.equal(itemReg.cancelado_en, null);
      assert.equal(itemInex.cancelado_en, null);
    });

    test('C3. Comportamiento idéntico ante reintentos de envío mientras están pendientes', async () => {
      await setAuthContext(hostUser, false);

      const retryReg = await db.query<{ result: any }>(`
        SELECT public.enviar_invitacion_interna_seguro('${compEncuentroId}', '${registeredEmail}', 'Reintento 1') as result;
      `);
      const resReg = parseResult(retryReg.rows[0].result);

      const retryInex = await db.query<{ result: any }>(`
        SELECT public.enviar_invitacion_interna_seguro('${compEncuentroId}', '${nonExistentEmail}', 'Reintento 2') as result;
      `);
      const resInex = parseResult(retryInex.rows[0].result);

      // Ambos deben fallar con exactamente el mismo error
      assert.equal(resReg.ok, false);
      assert.equal(resInex.ok, false);
      assert.equal(resReg.error, 'invitation_already_pending');
      assert.equal(resInex.error, 'invitation_already_pending');
      assert.equal(resReg.message, resInex.message);
    });

    test('C4. Cancelación por el organizador: idéntico contrato y transición a cancelada', async () => {
      await setAuthContext(hostUser, false);

      // Cancelar solicitud de correo registrado
      const cancelReg = await db.query<{ result: any }>(`
        SELECT public.cancelar_invitacion_interna_seguro('${registeredResp.invitation_id}') as result;
      `);
      const resReg = parseResult(cancelReg.rows[0].result);

      // Cancelar solicitud de correo inexistente
      const cancelInex = await db.query<{ result: any }>(`
        SELECT public.cancelar_invitacion_interna_seguro('${nonExistentResp.invitation_id}') as result;
      `);
      const resInex = parseResult(cancelInex.rows[0].result);

      assert.equal(resReg.ok, true);
      assert.equal(resInex.ok, true);
      assert.equal(resReg.estado, 'cancelada');
      assert.equal(resInex.estado, 'cancelada');

      // Verificar en la lista del anfitrión
      const listAfter = await db.query<{ result: any }>(`
        SELECT public.get_invitaciones_internas_encuentro_seguro('${compEncuentroId}') as result;
      `);
      const items = parseResult(listAfter.rows[0].result).invitaciones;
      const itemRegAfter = items.find((i: any) => i.id === registeredResp.invitation_id);
      const itemInexAfter = items.find((i: any) => i.id === nonExistentResp.invitation_id);

      assert.equal(itemRegAfter.estado, 'cancelada');
      assert.equal(itemInexAfter.estado, 'cancelada');
      assert.ok(itemRegAfter.cancelado_en);
      assert.ok(itemInexAfter.cancelado_en);
    });

    test('C5. Expiración uniforme: tanto solicitud registrada como inexistente reconcilian a expirada', async () => {
      await setAuthContext(hostUser, false);

      // Crear nuevo encuentro para prueba de expiración
      const resEnc = await db.query<{ id: string }>(`
        INSERT INTO public.encuentros (titulo, host_id, fecha, hora, modalidad)
        VALUES ('Encuentro Comparativo Expiración', '${hostUser}', (CURRENT_DATE + 5), '21:00:00', 'virtual')
        RETURNING id;
      `);
      const encId = resEnc.rows[0].id;

      const r1 = await db.query<{ result: any }>(`
        SELECT public.enviar_invitacion_interna_seguro('${encId}', '${registeredEmail}') as result;
      `);
      const r2 = await db.query<{ result: any }>(`
        SELECT public.enviar_invitacion_interna_seguro('${encId}', '${nonExistentEmail}') as result;
      `);
      const idReg = parseResult(r1.rows[0].result).invitation_id;
      const idInex = parseResult(r2.rows[0].result).invitation_id;

      // Simular paso del tiempo pasado el expira_en
      await db.query(`
        UPDATE public.solicitudes_invitacion_interna
        SET expira_en = timezone('utc', now()) - INTERVAL '5 minutes'
        WHERE id IN ('${idReg}', '${idInex}');
      `);

      // Consultar listado: reconciliación automática de ambas
      const listRes = await db.query<{ result: any }>(`
        SELECT public.get_invitaciones_internas_encuentro_seguro('${encId}') as result;
      `);
      const items = parseResult(listRes.rows[0].result).invitaciones;

      const item1 = items.find((i: any) => i.id === idReg);
      const item2 = items.find((i: any) => i.id === idInex);

      assert.equal(item1.estado, 'expirada');
      assert.equal(item2.estado, 'expirada');
    });

    test('C6. Inexistencia de registros ficticios ni colaterales para correos inexistentes', async () => {
      // 1. Cero registros en invitaciones_internas para correos inexistentes
      const fakeInvs = await db.query<any>(`
        SELECT * FROM public.invitaciones_internas WHERE destinatario_email = '${nonExistentEmail}';
      `);
      assert.equal(fakeInvs.rows.length, 0, 'No debe haber filas en invitaciones_internas para correos inexistentes');

      // 2. Cero participantes para correos inexistentes
      const fakeParts = await db.query<any>(`
        SELECT * FROM public.participantes WHERE nombre_invitado LIKE '%totalmente_inexistente%';
      `);
      assert.equal(fakeParts.rows.length, 0, 'No debe haber participantes creados para correos inexistentes');

      // 3. Cero usuarios creados en auth.users
      const fakeUsers = await db.query<any>(`
        SELECT * FROM auth.users WHERE email = '${nonExistentEmail}';
      `);
      assert.equal(fakeUsers.rows.length, 0, 'Jamás deben crearse usuarios ficticios en auth.users');
    });

    test('C7. Retención limitada y purga segura de solicitudes antiguas en estado terminal', async () => {
      await setAuthContext(hostUser, false);

      // Simular que una solicitud cancelada fue actualizada hace 45 días
      await db.query(`
        UPDATE public.solicitudes_invitacion_interna
        SET updated_at = timezone('utc', now()) - INTERVAL '45 days'
        WHERE id = '${nonExistentResp.invitation_id}';
      `);

      // Ejecutar purga de solicitudes > 30 días
      const purgeRes = await db.query<{ result: any }>(`
        SELECT public.purgar_solicitudes_invitaciones_antiguas_seguro(INTERVAL '30 days') as result;
      `);
      const purgeData = parseResult(purgeRes.rows[0].result);
      assert.equal(purgeData.ok, true);
      assert.ok(purgeData.deleted_count >= 1, 'Debe haber purgado al menos la solicitud vieja');

      // Comprobar que físicamente se eliminó de solicitudes_invitacion_interna
      const purgedCheck = await db.query<any>(`
        SELECT * FROM public.solicitudes_invitacion_interna WHERE id = '${nonExistentResp.invitation_id}';
      `);
      assert.equal(purgedCheck.rows.length, 0, 'La solicitud vieja debe haber sido eliminada físicamente');
    });
  });
});
