import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { whatsappContactService } from '../src/services/whatsappContactService';

describe('Mini-sprint C2: Contacto voluntario e instrucciones definitivas', () => {
  let db: PGlite;
  const hostUser = '11111111-1111-1111-1111-111111111111';
  const confirmedUser = '22222222-2222-2222-2222-222222222222';
  const pendingUser = '33333333-3333-3333-3333-333333333333';
  const rejectedUser = '44444444-4444-4444-4444-444444444444';
  const blockedUser = '55555555-5555-5555-5555-555555555555';
  const otherUser = '66666666-6666-6666-6666-666666666666';

  let encounterId: string;
  let cancelledEncounterId: string;
  let coordOpenEncounterId: string;
  let guestTokenConfirmed: string;
  let guestTokenPending: string;
  let guestTokenRejected: string;
  let guestTokenCancelled: string;

  let virtualEncounterId: string;
  let guestTokenVirtualConf: string;
  let guestTokenVirtualPend: string;
  let guestTokenVirtualRech: string;
  let guestTokenVirtualCanc: string;

  before(async () => {
    db = new PGlite();

    // 1. Roles & Schema base mock
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN
          CREATE ROLE postgres;
        END IF;
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
        SELECT jsonb_build_object(
          'sub', current_setting('request.jwt.claim.sub', true),
          'is_anonymous', current_setting('request.jwt.claim.is_anonymous', true) = 'true'
        );
      $$ LANGUAGE SQL STABLE;

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
        estado TEXT NOT NULL DEFAULT 'activo',
        tema TEXT,
        tema_invitacion TEXT DEFAULT 'classic',
        invitation_template TEXT,
        date_mode TEXT DEFAULT 'fixed',
        coordination_status TEXT,
        min_participants INT,
        realization_status TEXT DEFAULT 'confirmed',
        is_open BOOLEAN DEFAULT false,
        inscriptions_closed BOOLEAN DEFAULT false,
        open_public_title TEXT,
        open_description TEXT,
        open_public_zone TEXT,
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id),
        user_id UUID,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT DEFAULT 'individual',
        estado TEXT NOT NULL CHECK (estado IN ('pendiente', 'confirmado', 'rechazado', 'cancelado', 'asistio')),
        token_invitacion UUID UNIQUE DEFAULT gen_random_uuid(),
        mensaje_respuesta TEXT,
        seat_count INT DEFAULT 1,
        reconfirmation_status TEXT DEFAULT 'pending',
        respondido_en TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        blocker_id UUID NOT NULL,
        blocked_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (blocker_id, blocked_id)
      );
    `);

    // 2. Aplicar la migración de Mini-sprint C2 y el microfix de privacidad
    const migrationPathC2 = path.resolve(
      process.cwd(),
      'supabase/migrations/20261021180000_voluntary_whatsapp_contact_and_instructions_c2.sql'
    );
    const sqlContentC2 = fs.readFileSync(migrationPathC2, 'utf8');
    await db.exec(sqlContentC2);

    const migrationPathFix = path.resolve(
      process.cwd(),
      'supabase/migrations/20261021190000_fix_c2_privacy_pending_guest_logistics.sql'
    );
    const sqlContentFix = fs.readFileSync(migrationPathFix, 'utf8');
    await db.exec(sqlContentFix);

    const migrationPathAdjust = path.resolve(
      process.cwd(),
      'supabase/migrations/20261021235500_adjust_v1_privacy_and_logistics_by_encounter_type.sql'
    );
    const sqlContentAdjust = fs.readFileSync(migrationPathAdjust, 'utf8');
    await db.exec(sqlContentAdjust);

    // 3. Insertar datos de prueba
    // Encuentro activo estándar
    const resEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, link_virtual, estado
      ) VALUES (
        $1, 'Cumpleaños de Martín', 'Festejo en casa', '2026-11-15', '19:00', 'presencial', 'Av. Colón 1234, 4to B', NULL, 'activo'
      ) RETURNING id;
    `, [hostUser]);
    encounterId = resEnc.rows[0].id;

    // Encuentro cancelado
    const resCanc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, link_virtual, estado
      ) VALUES (
        $1, 'Cena de Fin de Año', 'Cancelado por lluvia', '2026-11-20', '21:00', 'presencial', 'Quinta Los Ombúes', NULL, 'cancelado'
      ) RETURNING id;
    `, [hostUser]);
    cancelledEncounterId = resCanc.rows[0].id;

    // Coordinación de fechas aún abierta
    const resCoord = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, modalidad, estado, date_mode, coordination_status, fecha, hora
      ) VALUES (
        $1, 'Reunión de Equipo', 'virtual', 'activo', 'coordination', 'open', NULL, NULL
      ) RETURNING id;
    `, [hostUser]);
    coordOpenEncounterId = resCoord.rows[0].id;

    // Participantes del encuentro activo
    // A) Confirmado con usuario
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ($1, $2, 'Laura Confirmo', 'confirmado');
    `, [encounterId, confirmedUser]);

    // B) Pendiente con usuario
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ($1, $2, 'Pedro Pendiente', 'pendiente');
    `, [encounterId, pendingUser]);

    // C) Rechazado con usuario
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ($1, $2, 'Roberto Rechazo', 'rechazado');
    `, [encounterId, rejectedUser]);

    // D) Bloqueado (usuario que tiene bloqueo bilateral con el host)
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ($1, $2, 'Bruno Bloqueado', 'confirmado');
    `, [encounterId, blockedUser]);
    await db.query(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ($1, $2);
    `, [hostUser, blockedUser]);

    // E) Participantes con tokens individuales de invitación
    const pConf = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, estado)
      VALUES ($1, 'Invitado Token Conf', 'confirmado')
      RETURNING token_invitacion;
    `, [encounterId]);
    guestTokenConfirmed = pConf.rows[0].token_invitacion;

    const pPend = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, estado)
      VALUES ($1, 'Invitado Token Pend', 'pendiente')
      RETURNING token_invitacion;
    `, [encounterId]);
    guestTokenPending = pPend.rows[0].token_invitacion;

    const pRech = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, estado)
      VALUES ($1, 'Invitado Token Rech', 'rechazado')
      RETURNING token_invitacion;
    `, [encounterId]);
    guestTokenRejected = pRech.rows[0].token_invitacion;

    const pCanc = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, estado)
      VALUES ($1, 'Invitado Token Canc', 'cancelado')
      RETURNING token_invitacion;
    `, [encounterId]);
    guestTokenCancelled = pCanc.rows[0].token_invitacion;

    // F) Encuentro virtual activo con participantes
    const resVirt = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, link_virtual, estado
      ) VALUES (
        $1, 'Webinar de Diseño', 'Taller online', '2026-11-25', '18:00', 'virtual', NULL, 'https://meet.jit.si/puntoencuentro-test', 'activo'
      ) RETURNING id;
    `, [hostUser]);
    virtualEncounterId = resVirt.rows[0].id;

    const pvConf = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, estado)
      VALUES ($1, 'Invitado Virtual Conf', 'confirmado')
      RETURNING token_invitacion;
    `, [virtualEncounterId]);
    guestTokenVirtualConf = pvConf.rows[0].token_invitacion;

    const pvPend = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, estado)
      VALUES ($1, 'Invitado Virtual Pend', 'pendiente')
      RETURNING token_invitacion;
    `, [virtualEncounterId]);
    guestTokenVirtualPend = pvPend.rows[0].token_invitacion;

    const pvRech = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, estado)
      VALUES ($1, 'Invitado Virtual Rech', 'rechazado')
      RETURNING token_invitacion;
    `, [virtualEncounterId]);
    guestTokenVirtualRech = pvRech.rows[0].token_invitacion;

    const pvCanc = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (encuentro_id, nombre_invitado, estado)
      VALUES ($1, 'Invitado Virtual Canc', 'cancelado')
      RETURNING token_invitacion;
    `, [virtualEncounterId]);
    guestTokenVirtualCanc = pvCanc.rows[0].token_invitacion;
  });

  const setAuthContext = async (uid: string | null, isAnon = false) => {
    if (!uid) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', 'false', false);`);
      await db.query(`SET ROLE anon;`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${uid}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${uid}", "is_anonymous": ${isAnon}}', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '${isAnon ? 'true' : 'false'}', false);`);
      await db.query(`SET ROLE authenticated;`);
    }
  };

  test('1. Normalización y validación estricta de teléfono internacional', async () => {
    // Casos válidos con formatos diversos
    const validCases = [
      { input: '+54 9 11 1234-5678', expected: '5491112345678' },
      { input: '0054 9 11 12345678', expected: '5491112345678' },
      { input: '+1 (555) 234-5678', expected: '15552345678' },
      { input: '+55 11 91234-5678', expected: '5511912345678' },
      { input: '12345678', expected: '12345678' }, // mínimo 8 dígitos
      { input: '123456789012345', expected: '123456789012345' }, // máximo 15 dígitos
    ];

    for (const c of validCases) {
      const res = await db.query<{ norm: string | null }>(
        `SELECT public.normalizar_telefono_whatsapp($1) AS norm;`,
        [c.input]
      );
      assert.strictEqual(res.rows[0].norm, c.expected, `Fallo en normalización de: ${c.input}`);

      const clientVal = whatsappContactService.validarTelefonoCliente(c.input);
      assert.strictEqual(clientVal.valid, true);
      assert.strictEqual(clientVal.normalized, c.expected);
    }

    // Casos inválidos (muy corto, muy largo, sólo ceros, texto sin números)
    const invalidCases = [
      '1234567', // 7 dígitos (< 8)
      '1234567890123456', // 16 dígitos (> 15)
      '0000000000', // sólo ceros
      'hola mundo', // sin dígitos
      '', // vacío
      null, // nulo
    ];

    for (const inv of invalidCases) {
      const res = await db.query<{ norm: string | null }>(
        `SELECT public.normalizar_telefono_whatsapp($1) AS norm;`,
        [inv]
      );
      assert.strictEqual(res.rows[0].norm, null, `Debería ser nulo para caso inválido: ${inv}`);

      if (inv !== null) {
        const clientVal = whatsappContactService.validarTelefonoCliente(inv);
        assert.strictEqual(clientVal.valid, false);
      }
    }
  });

  test('2. Guardado y opt-in por parte del anfitrión', async () => {
    await setAuthContext(hostUser);

    // Guardar número internacional válido
    const resSave = await db.query<{ res: any }>(
      `SELECT public.guardar_contacto_whatsapp_host_seguro($1, $2, $3) AS res;`,
      [encounterId, '+54 9 11 9999-8888', true]
    );
    assert.strictEqual(resSave.rows[0].res.ok, true);
    assert.strictEqual(resSave.rows[0].res.opt_in, true);
    assert.strictEqual(resSave.rows[0].res.telefono, '5491199998888');

    // Comprobar que un teléfono inválido es rechazado
    const resInvalid = await db.query<{ res: any }>(
      `SELECT public.guardar_contacto_whatsapp_host_seguro($1, $2, $3) AS res;`,
      [encounterId, '123', true]
    );
    assert.strictEqual(resInvalid.rows[0].res.ok, false);
    assert.strictEqual(resInvalid.rows[0].res.error, 'invalid_phone_number');

    // Desactivar opt-in
    const resDisable = await db.query<{ res: any }>(
      `SELECT public.guardar_contacto_whatsapp_host_seguro($1, $2, $3) AS res;`,
      [encounterId, null, false]
    );
    assert.strictEqual(resDisable.rows[0].res.ok, true);
    assert.strictEqual(resDisable.rows[0].res.opt_in, false);

    // Reactivar con nuevo número
    const resReenable = await db.query<{ res: any }>(
      `SELECT public.guardar_contacto_whatsapp_host_seguro($1, $2, $3) AS res;`,
      [encounterId, '+54 9 11 5555-4444', true]
    );
    assert.strictEqual(resReenable.rows[0].res.ok, true);
    assert.strictEqual(resReenable.rows[0].res.opt_in, true);
    assert.strictEqual(resReenable.rows[0].res.telefono, '5491155554444');
  });

  test('3. Seguridad y autorización en modificación: no anfitriones y anónimos rechazados', async () => {
    // Usuario autenticado pero que NO es el anfitrión
    await setAuthContext(otherUser);
    const resUnauthorized = await db.query<{ res: any }>(
      `SELECT public.guardar_contacto_whatsapp_host_seguro($1, $2, $3) AS res;`,
      [encounterId, '+54 9 11 1111-2222', true]
    );
    assert.strictEqual(resUnauthorized.rows[0].res.ok, false);
    assert.strictEqual(resUnauthorized.rows[0].res.error, 'unauthorized');

    // Retiro por un no anfitrión
    const resRetireUnauth = await db.query<{ res: any }>(
      `SELECT public.retirar_contacto_whatsapp_host_seguro($1) AS res;`,
      [encounterId]
    );
    assert.strictEqual(resRetireUnauth.rows[0].res.ok, false);
    assert.strictEqual(resRetireUnauth.rows[0].res.error, 'unauthorized');

    // Sin autenticación (rol anon denegado por GRANT EXECUTE a nivel PostgreSQL)
    await setAuthContext(null);
    await assert.rejects(
      async () => {
        await db.query<{ res: any }>(
          `SELECT public.guardar_contacto_whatsapp_host_seguro($1, $2, $3) AS res;`,
          [encounterId, '+54 9 11 1111-2222', true]
        );
      },
      (err: any) => err.code === '42501' || err.message.includes('permission denied')
    );

    // Intentar modificar en un encuentro cancelado
    await setAuthContext(hostUser);
    const resCancelled = await db.query<{ res: any }>(
      `SELECT public.guardar_contacto_whatsapp_host_seguro($1, $2, $3) AS res;`,
      [cancelledEncounterId, '+54 9 11 1111-2222', true]
    );
    assert.strictEqual(resCancelled.rows[0].res.ok, false);
    assert.strictEqual(resCancelled.rows[0].res.error, 'encounter_cancelled');
  });

  test('4. Consulta autorizada: anfitrión y participantes confirmados vs no autorizados', async () => {
    // A) El anfitrión consulta su propio encuentro -> recibe datos de host
    await setAuthContext(hostUser);
    const resHost = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, NULL) AS res;`,
      [encounterId]
    );
    assert.strictEqual(resHost.rows[0].res.ok, true);
    assert.strictEqual(resHost.rows[0].res.is_host, true);
    assert.strictEqual(resHost.rows[0].res.has_contact, true);
    assert.strictEqual(resHost.rows[0].res.opt_in, true);
    assert.strictEqual(resHost.rows[0].res.telefono, '5491155554444');
    assert.strictEqual(resHost.rows[0].res.wa_link, 'https://wa.me/5491155554444');

    // B) Participante confirmado autenticado -> recibe el link de WhatsApp
    await setAuthContext(confirmedUser);
    const resPart = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, NULL) AS res;`,
      [encounterId]
    );
    assert.strictEqual(resPart.rows[0].res.ok, true);
    assert.strictEqual(resPart.rows[0].res.is_host, false);
    assert.strictEqual(resPart.rows[0].res.has_contact, true);
    assert.strictEqual(resPart.rows[0].res.wa_link, 'https://wa.me/5491155554444');

    // C) Participante pendiente autenticado -> rechazado fail-closed
    await setAuthContext(pendingUser);
    const resPend = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, NULL) AS res;`,
      [encounterId]
    );
    assert.strictEqual(resPend.rows[0].res.ok, false);
    assert.strictEqual(resPend.rows[0].res.error, 'participant_not_confirmed');

    // D) Participante rechazado autenticado -> rechazado fail-closed
    await setAuthContext(rejectedUser);
    const resRech = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, NULL) AS res;`,
      [encounterId]
    );
    assert.strictEqual(resRech.rows[0].res.ok, false);
    assert.strictEqual(resRech.rows[0].res.error, 'participant_not_confirmed');

    // E) Usuario ajeno sin relación -> unauthorized
    await setAuthContext(otherUser);
    const resOther = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, NULL) AS res;`,
      [encounterId]
    );
    assert.strictEqual(resOther.rows[0].res.ok, false);
    assert.strictEqual(resOther.rows[0].res.error, 'unauthorized');
  });

  test('5. Consulta mediante token de invitación individual', async () => {
    // Sesión anónima o sin sesión usando tokens individuales
    await setAuthContext(null);

    // Token confirmado -> autorizado
    const resTokenConf = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, $2) AS res;`,
      [encounterId, guestTokenConfirmed]
    );
    assert.strictEqual(resTokenConf.rows[0].res.ok, true);
    assert.strictEqual(resTokenConf.rows[0].res.has_contact, true);
    assert.strictEqual(resTokenConf.rows[0].res.wa_link, 'https://wa.me/5491155554444');

    // Token pendiente -> rechazado
    const resTokenPend = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, $2) AS res;`,
      [encounterId, guestTokenPending]
    );
    assert.strictEqual(resTokenPend.rows[0].res.ok, false);
    assert.strictEqual(resTokenPend.rows[0].res.error, 'participant_not_confirmed');

    // Token rechazado -> rechazado
    const resTokenRech = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, $2) AS res;`,
      [encounterId, guestTokenRejected]
    );
    assert.strictEqual(resTokenRech.rows[0].res.ok, false);
    assert.strictEqual(resTokenRech.rows[0].res.error, 'participant_not_confirmed');

    // Token inexistente o aleatorio -> unauthorized
    const resTokenFake = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, 'a0000000-0000-0000-0000-000000000000') AS res;`,
      [encounterId]
    );
    assert.strictEqual(resTokenFake.rows[0].res.ok, false);
    assert.strictEqual(resTokenFake.rows[0].res.error, 'unauthorized');
  });

  test('6. Respeto estricto de Bloqueos Bilaterales en WhatsApp y Logística', async () => {
    // A) Bloqueo bilateral bloquea la lectura de WhatsApp aunque esté confirmado
    await setAuthContext(blockedUser);
    const resBlockedWa = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, NULL) AS res;`,
      [encounterId]
    );
    assert.strictEqual(resBlockedWa.rows[0].res.ok, false);
    assert.strictEqual(resBlockedWa.rows[0].res.error, 'blocked_user');

    // B) Bloqueo bilateral bloquea get_encuentro_participante_autorizado
    const resBlockedLogistics = await db.query<{ res: any }>(
      `SELECT public.get_encuentro_participante_autorizado($1) AS res;`,
      [encounterId]
    );
    assert.strictEqual(resBlockedLogistics.rows[0].res.ok, false);
    assert.strictEqual(resBlockedLogistics.rows[0].res.error, 'blocked_user');
  });

  test('7. Revocación inmediata en caso de cancelación y coordinaciones abiertas', async () => {
    // Si el encuentro está cancelado, el participante confirmado NO puede obtener WhatsApp
    await setAuthContext(confirmedUser);
    const resCancelWa = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, NULL) AS res;`,
      [cancelledEncounterId]
    );
    assert.strictEqual(resCancelWa.rows[0].res.ok, false);
    assert.strictEqual(resCancelWa.rows[0].res.error, 'meeting_cancelled');

    // Si es coordinación abierta, WhatsApp está bloqueado
    const resCoordWa = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, NULL) AS res;`,
      [coordOpenEncounterId]
    );
    assert.strictEqual(resCoordWa.rows[0].res.ok, false);
    assert.strictEqual(resCoordWa.rows[0].res.error, 'coordination_not_closed');
  });

  test('8. Retiro definitivo del número por el anfitrión', async () => {
    await setAuthContext(hostUser);
    const resRetire = await db.query<{ res: any }>(
      `SELECT public.retirar_contacto_whatsapp_host_seguro($1) AS res;`,
      [encounterId]
    );
    assert.strictEqual(resRetire.rows[0].res.ok, true);

    // Participante confirmado ahora consulta y no hay contacto
    await setAuthContext(confirmedUser);
    const resAfterRetire = await db.query<{ res: any }>(
      `SELECT public.obtener_contacto_whatsapp_seguro($1, NULL) AS res;`,
      [encounterId]
    );
    assert.strictEqual(resAfterRetire.rows[0].res.ok, true);
    assert.strictEqual(resAfterRetire.rows[0].res.has_contact, false);
    assert.strictEqual(resAfterRetire.rows[0].res.telefono, null);
    assert.strictEqual(resAfterRetire.rows[0].res.wa_link, null);
  });

  test('9. get_participante_seguro: privacidad estricta de logística privada (pendiente, confirmado, rechazado, cancelado y revocación)', async () => {
    await setAuthContext(null);

    // --- ENCUENTRO PRESENCIAL PRIVADO ---
    // A) Participante pendiente SÍ ve la dirección exacta al abrir enlace privado (Regla 1)
    const resPend = await db.query<{ res: any }>(
      `SELECT public.get_participante_seguro($1) AS res;`,
      [guestTokenPending]
    );
    assert.ok(resPend.rows[0].res !== null);
    assert.strictEqual(resPend.rows[0].res.estado, 'pendiente');
    assert.strictEqual(resPend.rows[0].res.encuentros.lugar_texto, 'Av. Colón 1234, 4to B', 'Privado pendiente ve dirección exacta');
    assert.strictEqual(resPend.rows[0].res.encuentros.link_virtual, null);
    // Preservar datos indispensables para decidir
    assert.strictEqual(resPend.rows[0].res.encuentros.titulo, 'Cumpleaños de Martín');
    assert.strictEqual(resPend.rows[0].res.encuentros.descripcion, 'Festejo en casa');
    assert.strictEqual(resPend.rows[0].res.encuentros.fecha, '2026-11-15');
    assert.strictEqual(resPend.rows[0].res.encuentros.hora, '19:00:00');
    assert.strictEqual(resPend.rows[0].res.encuentros.modalidad, 'presencial');
    assert.strictEqual(resPend.rows[0].res.encuentros.estado, 'activo');

    // A.bis) En encuentro abierto (is_open = true), participante pendiente NO ve lugar_texto (Regla 3)
    await db.exec(`SET ROLE postgres;`);
    const resOpenEnc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, is_open, open_public_zone, estado
      ) VALUES (
        $1, 'Mates en la plaza', 'Charla abierta', '2026-11-16', '18:00', 'presencial', 'Plaza San Martín, Banco 4', true, 'Palermo', 'activo'
      ) RETURNING id;
    `, [hostUser]);
    const openEncId = resOpenEnc.rows[0].id;

    const resPartOpen = await db.query<{ token_invitacion: string }>(`
      INSERT INTO public.participantes (
        encuentro_id, nombre_invitado, estado
      ) VALUES (
        $1, 'Interesado Abierto', 'pendiente'
      ) RETURNING token_invitacion;
    `, [openEncId]);
    const openPendingToken = resPartOpen.rows[0].token_invitacion;

    await setAuthContext(null);
    const resOpenPend = await db.query<{ res: any }>(
      `SELECT public.get_participante_seguro($1) AS res;`,
      [openPendingToken]
    );
    assert.ok(resOpenPend.rows[0].res !== null);
    assert.strictEqual(resOpenPend.rows[0].res.estado, 'pendiente');
    assert.strictEqual(resOpenPend.rows[0].res.encuentros.lugar_texto, null, 'Abierto pendiente NO debe ver dirección exacta');
    assert.strictEqual(resOpenPend.rows[0].res.encuentros.open_public_zone, 'Palermo');

    // B) Participante confirmado SÍ ve la dirección exacta
    const resConf = await db.query<{ res: any }>(
      `SELECT public.get_participante_seguro($1) AS res;`,
      [guestTokenConfirmed]
    );
    assert.ok(resConf.rows[0].res !== null);
    assert.strictEqual(resConf.rows[0].res.estado, 'confirmado');
    assert.strictEqual(resConf.rows[0].res.encuentros.lugar_texto, 'Av. Colón 1234, 4to B');
    assert.strictEqual(resConf.rows[0].res.encuentros.link_virtual, null);

    // C) Participante rechazado NO ve la dirección exacta (null)
    const resRech = await db.query<{ res: any }>(
      `SELECT public.get_participante_seguro($1) AS res;`,
      [guestTokenRejected]
    );
    assert.ok(resRech.rows[0].res !== null);
    assert.strictEqual(resRech.rows[0].res.estado, 'rechazado');
    assert.strictEqual(resRech.rows[0].res.encuentros.lugar_texto, null);
    assert.strictEqual(resRech.rows[0].res.encuentros.link_virtual, null);

    // D) Participante cancelado / retirado NO ve la dirección exacta (null)
    const resCanc = await db.query<{ res: any }>(
      `SELECT public.get_participante_seguro($1) AS res;`,
      [guestTokenCancelled]
    );
    assert.ok(resCanc.rows[0].res !== null);
    assert.strictEqual(resCanc.rows[0].res.estado, 'cancelado');
    assert.strictEqual(resCanc.rows[0].res.encuentros.lugar_texto, null);
    assert.strictEqual(resCanc.rows[0].res.encuentros.link_virtual, null);

    // --- ENCUENTRO VIRTUAL ---
    // E) Participante virtual pendiente NO ve link_virtual, pero ve datos públicos
    const resVirtPend = await db.query<{ res: any }>(
      `SELECT public.get_participante_seguro($1) AS res;`,
      [guestTokenVirtualPend]
    );
    assert.ok(resVirtPend.rows[0].res !== null);
    assert.strictEqual(resVirtPend.rows[0].res.estado, 'pendiente');
    assert.strictEqual(resVirtPend.rows[0].res.encuentros.link_virtual, null, 'Pendiente virtual no debe ver enlace');
    assert.strictEqual(resVirtPend.rows[0].res.encuentros.lugar_texto, null);
    assert.strictEqual(resVirtPend.rows[0].res.encuentros.titulo, 'Webinar de Diseño');
    assert.strictEqual(resVirtPend.rows[0].res.encuentros.modalidad, 'virtual');

    // F) Participante virtual confirmado SÍ ve link_virtual
    const resVirtConf = await db.query<{ res: any }>(
      `SELECT public.get_participante_seguro($1) AS res;`,
      [guestTokenVirtualConf]
    );
    assert.ok(resVirtConf.rows[0].res !== null);
    assert.strictEqual(resVirtConf.rows[0].res.estado, 'confirmado');
    assert.strictEqual(resVirtConf.rows[0].res.encuentros.link_virtual, 'https://meet.jit.si/puntoencuentro-test');

    // G) Participante virtual rechazado NO ve link_virtual
    const resVirtRech = await db.query<{ res: any }>(
      `SELECT public.get_participante_seguro($1) AS res;`,
      [guestTokenVirtualRech]
    );
    assert.ok(resVirtRech.rows[0].res !== null);
    assert.strictEqual(resVirtRech.rows[0].res.encuentros.link_virtual, null);

    // H) Participante virtual cancelado NO ve link_virtual
    const resVirtCanc = await db.query<{ res: any }>(
      `SELECT public.get_participante_seguro($1) AS res;`,
      [guestTokenVirtualCanc]
    );
    assert.ok(resVirtCanc.rows[0].res !== null);
    assert.strictEqual(resVirtCanc.rows[0].res.encuentros.link_virtual, null);

    // --- REVOCACIÓN POR CANCELACIÓN DEL ENCUENTRO ---
    // I) Si se cancela el encuentro presencial, el confirmado pierde el acceso a lugar_texto
    await db.exec(`SET ROLE postgres;`);
    await db.query(`UPDATE public.encuentros SET estado = 'cancelado' WHERE id = $1;`, [encounterId]);
    await setAuthContext(null);

    const resCancelledPres = await db.query<{ res: any }>(
      `SELECT public.get_participante_seguro($1) AS res;`,
      [guestTokenConfirmed]
    );
    assert.ok(resCancelledPres.rows[0].res !== null);
    assert.strictEqual(resCancelledPres.rows[0].res.encuentros.lugar_texto, null, 'Revocación por cancelación presencial');
    assert.strictEqual(resCancelledPres.rows[0].res.encuentros.link_virtual, null);

    // J) Si se cancela el encuentro virtual, el confirmado pierde el acceso a link_virtual
    await db.exec(`SET ROLE postgres;`);
    await db.query(`UPDATE public.encuentros SET estado = 'cancelado' WHERE id = $1;`, [virtualEncounterId]);
    await setAuthContext(null);

    const resCancelledVirt = await db.query<{ res: any }>(
      `SELECT public.get_participante_seguro($1) AS res;`,
      [guestTokenVirtualConf]
    );
    assert.ok(resCancelledVirt.rows[0].res !== null);
    assert.strictEqual(resCancelledVirt.rows[0].res.encuentros.link_virtual, null, 'Revocación por cancelación virtual');
  });

  test('10. Consistencia de i18n completa en ES, EN, PT y PT-BR', () => {
    const es = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/es.json'), 'utf8'));
    const en = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/en.json'), 'utf8'));
    const pt = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/pt.json'), 'utf8'));
    const ptBr = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/locales/pt-BR.json'), 'utf8'));

    const requiredKeys = [
      'attendance_info_title',
      'pinned_instructions',
      'pinned_instructions_hint',
      'whatsapp_contact_title',
      'whatsapp_contact_btn',
      'whatsapp_disclaimer_participant',
      'whatsapp_host_status_active',
      'whatsapp_host_status_inactive',
      'whatsapp_host_share_btn',
      'whatsapp_host_edit_btn',
      'whatsapp_host_remove_btn',
      'whatsapp_remove_confirm',
      'whatsapp_modal_title',
      'whatsapp_modal_desc',
      'whatsapp_modal_input_label',
      'whatsapp_modal_input_placeholder',
      'whatsapp_modal_save',
      'whatsapp_modal_cancel',
      'whatsapp_invalid_phone',
    ];

    for (const k of requiredKeys) {
      assert.ok(es.encounter_messages?.[k], `Clave faltante en es.json: encounter_messages.${k}`);
      assert.ok(en.encounter_messages?.[k], `Clave faltante en en.json: encounter_messages.${k}`);
      assert.ok(pt.encounter_messages?.[k], `Clave faltante en pt.json: encounter_messages.${k}`);
      assert.ok(ptBr.encounter_messages?.[k], `Clave faltante en pt-BR.json: encounter_messages.${k}`);
    }
  });
});
