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

  test('2. Rechaza envío si quien invita no es el host del encuentro', async () => {
    await setAuthContext(otherUser, false);
    const notOwnerRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'invitado@puntoencuentro.com', 'Hola'
      ) as result;
    `);
    const res = parseResult(notOwnerRes.rows[0].result);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'encuentro_not_found_or_not_owner');
  });

  test('3. No revela existencia de cuenta ante correo no registrado o anónimo', async () => {
    await setAuthContext(hostUser, false);
    // Correo inexistente
    const inexRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'noexiste@test.com', 'Hola'
      ) as result;
    `);
    const res1 = parseResult(inexRes.rows[0].result);
    assert.equal(res1.ok, true);
    assert.equal(res1.sent, false);

    // Correo anónimo
    const anonTargetRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'anon@puntoencuentro.com', 'Hola'
      ) as result;
    `);
    const res2 = parseResult(anonTargetRes.rows[0].result);
    assert.equal(res2.ok, true);
    assert.equal(res2.sent, false);
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

  test('5. Envío exitoso crea invitación interna, participante pendiente, outbox event e inbox notification', async () => {
    await setAuthContext(hostUser, false);
    const sendRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'invitado@puntoencuentro.com', '¡Sumate al picnic!'
      ) as result;
    `);
    const res = parseResult(sendRes.rows[0].result);
    assert.equal(res.ok, true);
    assert.equal(res.sent, true);
    const invitationId = res.invitation_id;
    assert.ok(invitationId);

    // Verificar tabla invitaciones_internas
    const invRow = await db.query<any>(`
      SELECT * FROM public.invitaciones_internas WHERE id = '${invitationId}';
    `);
    assert.equal(invRow.rows.length, 1);
    assert.equal(invRow.rows[0].estado, 'pendiente');
    assert.equal(invRow.rows[0].destinatario_id, recipientUser);

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
      SELECT * FROM public.domain_events_outbox WHERE aggregate_id = '${invitationId}';
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
    assert.equal(notif.deep_link, `/invitation/${invitationId}`);
  });

  test('6. Previene invitación duplicada pendiente para el mismo encuentro y usuario', async () => {
    await setAuthContext(hostUser, false);
    const dupRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'invitado@puntoencuentro.com', 'Segundo intento'
      ) as result;
    `);
    const res = parseResult(dupRes.rows[0].result);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'invitation_already_pending');
  });

  test('7. Detalle de invitación accesible por host y destinatario, pero denegado a terceros', async () => {
    // Obtener id de la invitación pendiente
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

  test('8. Destinatario acepta invitación en encuentro de fecha fija -> participante confirmado y notificación a host', async () => {
    const invRes = await db.query<any>(`
      SELECT id, participante_id FROM public.invitaciones_internas WHERE destinatario_id = '${recipientUser}' AND estado = 'pendiente' LIMIT 1;
    `);
    const invId = invRes.rows[0].id;
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

  test('10. Flujo de rechazo de invitación -> participante rechazado y notificación al host', async () => {
    // Enviar una nueva invitación a otherUser
    await setAuthContext(hostUser, false);
    const sendRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${fixedEncuentroId}', 'otro@puntoencuentro.com', 'Vení al picnic'
      ) as result;
    `);
    const resSend = parseResult(sendRes.rows[0].result);
    const newInvId = resSend.invitation_id;
    assert.ok(newInvId);

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

    const partRow = await db.query<any>(`
      SELECT * FROM public.participantes WHERE id = '${invRow.rows[0].participante_id}';
    `);
    assert.equal(partRow.rows[0].estado, 'rechazado');

    // Host recibe notificación de rechazo
    const hostInbox = await db.query<any>(`
      SELECT * FROM public.inbox_notifications WHERE recipient_user_id = '${hostUser}' AND notification_type = 'invitation_declined';
    `);
    assert.equal(hostInbox.rows.length, 1);
  });

  test('11. Flujo de cancelación por parte del host -> elimina participante pendiente', async () => {
    // Nueva invitación para probar cancelación
    await setAuthContext(hostUser, false);
    const sendRes = await db.query<{ result: any }>(`
      SELECT public.enviar_invitacion_interna_seguro(
        '${coordEncuentroId}', 'otro@puntoencuentro.com', 'Asado'
      ) as result;
    `);
    const resSend = parseResult(sendRes.rows[0].result);
    const invId = resSend.invitation_id;
    assert.ok(invId);

    const invBefore = await db.query<any>(`
      SELECT participante_id FROM public.invitaciones_internas WHERE id = '${invId}';
    `);
    const partId = invBefore.rows[0].participante_id;
    assert.ok(partId);

    const cancelRes = await db.query<{ result: any }>(`
      SELECT public.cancelar_invitacion_interna_seguro('${invId}') as result;
    `);
    const resCancel = parseResult(cancelRes.rows[0].result);
    assert.equal(resCancel.ok, true);
    assert.equal(resCancel.estado, 'cancelada');

    // Verificar que participante pendiente fue eliminado
    const invRow = await db.query<any>(`
      SELECT * FROM public.invitaciones_internas WHERE id = '${invId}';
    `);
    assert.equal(invRow.rows[0].estado, 'cancelada');

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
    const invId = resSend.invitation_id;
    assert.ok(invId);

    await setAuthContext(otherUser, false);
    const acceptRes = await db.query<{ result: any }>(`
      SELECT public.responder_invitacion_interna_seguro('${invId}', 'aceptada') as result;
    `);
    const resAccept = parseResult(acceptRes.rows[0].result);
    assert.equal(resAccept.ok, true);
    assert.equal(resAccept.estado, 'aceptada');
    assert.equal(resAccept.date_mode, 'coordination');
    assert.ok(resAccept.token_invitacion);

    // Participante en coordinación sigue 'pendiente' hasta que vote disponibilidad o se cierre la fecha
    const invRow = await db.query<any>(`
      SELECT * FROM public.invitaciones_internas WHERE id = '${invId}';
    `);
    const partRow = await db.query<any>(`
      SELECT * FROM public.participantes WHERE id = '${invRow.rows[0].participante_id}';
    `);
    assert.equal(partRow.rows[0].estado, 'pendiente');
    assert.equal(partRow.rows[0].user_id, otherUser);
  });

  test('13. Cancelación del encuentro cancela automáticamente invitaciones pendientes vía trigger', async () => {
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
    const invId = resSend.invitation_id;
    assert.ok(invId);

    // Cancelar el encuentro
    await db.query(`
      UPDATE public.encuentros SET estado = 'cancelado' WHERE id = '${encId}';
    `);

    // Comprobar que el trigger canceló la invitación interna
    const invRow = await db.query<any>(`
      SELECT estado FROM public.invitaciones_internas WHERE id = '${invId}';
    `);
    assert.equal(invRow.rows[0].estado, 'cancelada');
  });

  test('14. Expiración de invitación impide su aceptación', async () => {
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
    const invId = resSend.invitation_id;
    assert.ok(invId);

    // Forzar expiración simulando paso del tiempo en la DB
    await db.query(`
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

    // Comprobar estado transicionado a expirada
    const invRow = await db.query<any>(`
      SELECT estado FROM public.invitaciones_internas WHERE id = '${invId}';
    `);
    assert.equal(invRow.rows[0].estado, 'expirada');
  });
});
