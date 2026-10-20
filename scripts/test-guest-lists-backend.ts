import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

/**
 * Listas reutilizables de invitados V1 — Backend, RLS, Privacidad, Sugerencias e Integración (PGlite).
 *
 * Carga las migraciones reales de:
 *   - Invitaciones Internas V1 (+ hardening)
 *   - Favoritos / Repetir encuentro V1
 *   - Contactos frecuentes V1 (20261019200000_frequent_contacts_v1.sql)
 *   - Listas reutilizables de invitados V1 (20261019220000_reusable_guest_lists_v1.sql)
 * y ejecuta las RPCs bajo `SET ROLE authenticated`.
 */
describe('Listas reutilizables de invitados V1 — Backend, RLS & Integración (PGlite)', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const registeredGuest = '22222222-2222-2222-2222-222222222222';
  const otherOrganizer = '33333333-3333-3333-3333-333333333333';
  const anonymousUser = '44444444-4444-4444-4444-444444444444';
  const blockedUser = '55555555-5555-5555-5555-555555555555';
  const rejectedGuest = '66666666-6666-6666-6666-666666666666';
  const reverseBlockedUser = '77777777-7777-7777-7777-777777777777';

  let enc1Id: string;
  let enc2Id: string;
  let enc3Id: string;
  let otherEncId: string;

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

      CREATE TABLE IF NOT EXISTS public.rate_limit_policies (
        action TEXT PRIMARY KEY,
        max_requests INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL,
        enabled BOOLEAN DEFAULT true,
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE OR REPLACE FUNCTION public.verificar_y_consumir_rate_limit(
        p_user_id UUID, p_action TEXT, p_max INT DEFAULT 5, p_window INTERVAL DEFAULT INTERVAL '1 hour'
      ) RETURNS JSONB AS $$
      BEGIN
        IF current_setting('test.force_rate_limit', true) = 'true' THEN
          RETURN jsonb_build_object('allowed', false, 'reason', 'rate_limit_exceeded');
        END IF;
        RETURN jsonb_build_object('allowed', true);
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        blocker_id UUID NOT NULL,
        blocked_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
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
        tema_invitacion TEXT DEFAULT 'classic',
        invitation_template TEXT,
        estado TEXT NOT NULL DEFAULT 'activo',
        date_mode TEXT NOT NULL DEFAULT 'fixed',
        coordination_status TEXT,
        response_deadline TIMESTAMPTZ,
        selected_option_id UUID,
        duration_minutes INT,
        mostrar_respuestas_a_invitados BOOLEAN DEFAULT false,
        visibilidad_respuestas_invitados TEXT DEFAULT 'hidden',
        max_participants INT,
        is_open BOOLEAN NOT NULL DEFAULT false,
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
        seat_count INT NOT NULL DEFAULT 1,
        mensaje_respuesta TEXT,
        respondido_en TIMESTAMPTZ,
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
        dedup_key TEXT,
        read_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE OR REPLACE FUNCTION public.insertar_inbox_notification_seguro(
        p_recipient_user_id UUID, p_notification_type TEXT, p_target_type TEXT, p_target_id UUID,
        p_deep_link TEXT, p_title TEXT, p_body TEXT, p_payload JSONB DEFAULT '{}'::jsonb,
        p_dedup_key TEXT DEFAULT NULL, p_expires_at TIMESTAMPTZ DEFAULT NULL
      ) RETURNS JSONB AS $$
      BEGIN
        RETURN jsonb_build_object('ok', true);
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;

      CREATE TABLE IF NOT EXISTS public.domain_events_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type TEXT NOT NULL,
        event_version INTEGER NOT NULL DEFAULT 1,
        aggregate_type TEXT NOT NULL,
        aggregate_id UUID NOT NULL,
        actor_user_id UUID,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        dedup_key TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now()
      );

      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT SELECT ON TABLE auth.users TO anon, authenticated, service_role;
      GRANT SELECT ON TABLE public.encuentros TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.participantes TO authenticated;
    `);

    const migrations = [
      '20261018180000_internal_invitations_v1.sql',
      '20261018200000_harden_internal_invitations_direct_select.sql',
      '20261019150000_encounter_templates_favorites_v1.sql',
      '20261019200000_frequent_contacts_v1.sql',
      '20261019220000_reusable_guest_lists_v1.sql',
    ];
    for (const file of migrations) {
      const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations', file), 'utf8');
      await db.exec(sql);
    }

    await db.exec(`
      GRANT USAGE ON SCHEMA public TO authenticated, anon;
      GRANT USAGE ON SCHEMA auth TO authenticated, anon;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
      GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated, anon;
    `);

    await db.exec(`
      INSERT INTO auth.users (id, email, is_anonymous, raw_user_meta_data) VALUES
        ('${hostUser}', 'host@puntoencuentro.com', false, '{"full_name": "Host Principal"}'),
        ('${registeredGuest}', 'registrado@puntoencuentro.com', false, '{"full_name": "Invitado Registrado"}'),
        ('${otherOrganizer}', 'otro@puntoencuentro.com', false, '{"full_name": "Otro Organizador"}'),
        ('${anonymousUser}', NULL, true, '{}'),
        ('${blockedUser}', 'bloqueado@puntoencuentro.com', false, '{"full_name": "Usuario Bloqueado"}'),
        ('${rejectedGuest}', 'rechazo@puntoencuentro.com', false, '{"full_name": "Invitado Rechaza"}'),
        ('${reverseBlockedUser}', 'me.bloqueo@puntoencuentro.com', false, '{"full_name": "Usuario Que Bloquea Al Host"}');
    `);

    const f1 = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
    const f2 = new Date(Date.now() + 14 * 86400 * 1000).toISOString().slice(0, 10);
    const f3 = new Date(Date.now() + 21 * 86400 * 1000).toISOString().slice(0, 10);

    const r1 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, date_mode)
      VALUES ('${hostUser}', 'Fútbol de los Jueves', 'Cancha 1', '${f1}', '20:00', 'presencial', 'Palermo', 'fixed')
      RETURNING id;
    `);
    enc1Id = r1.rows[0].id;

    const r2 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, date_mode)
      VALUES ('${hostUser}', 'Fútbol Revancha', 'Cancha 2', '${f2}', '20:00', 'presencial', 'Palermo', 'fixed')
      RETURNING id;
    `);
    enc2Id = r2.rows[0].id;

    const r3 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, date_mode)
      VALUES ('${hostUser}', 'Asado de Fin de Año', 'Quincho', '${f3}', '21:30', 'presencial', 'Belgrano', 'fixed')
      RETURNING id;
    `);
    enc3Id = r3.rows[0].id;

    const rOther = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, date_mode)
      VALUES ('${otherOrganizer}', 'Encuentro Ajeno', 'Host distinto', '${f1}', '19:00', 'presencial', 'Caballito', 'fixed')
      RETURNING id;
    `);
    otherEncId = rOther.rows[0].id;
  });

  test('1. Bloqueo estricto para anónimos y no autenticados en RPCs de listas', async () => {
    const rUnauth = await rpc(
      `public.guardar_lista_invitados_seguro('Familia', ARRAY['mama@correo.com', 'papa@correo.com'], NULL)`,
      null
    );
    assert.equal(rUnauth.ok, false);
    assert.equal(rUnauth.error, 'not_authenticated');

    const rAnonSave = await rpc(
      `public.guardar_lista_invitados_seguro('Familia', ARRAY['mama@correo.com', 'papa@correo.com'], NULL)`,
      anonymousUser,
      true
    );
    assert.equal(rAnonSave.ok, false);
    assert.equal(rAnonSave.error, 'anonymous_user_not_allowed');

    const rAnonList = await rpc(
      `public.listar_listas_invitados_seguro(NULL)`,
      anonymousUser,
      true
    );
    assert.equal(rAnonList.ok, false);
    assert.equal(rAnonList.error, 'anonymous_user_not_allowed');

    const rAnonRename = await rpc(
      `public.renombrar_lista_invitados_seguro('00000000-0000-0000-0000-000000000000', 'Nuevo Nombre')`,
      anonymousUser,
      true
    );
    assert.equal(rAnonRename.ok, false);
    assert.equal(rAnonRename.error, 'anonymous_user_not_allowed');

    const rAnonDel = await rpc(
      `public.eliminar_lista_invitados_seguro('00000000-0000-0000-0000-000000000000')`,
      anonymousUser,
      true
    );
    assert.equal(rAnonDel.ok, false);
    assert.equal(rAnonDel.error, 'anonymous_user_not_allowed');
  });

  test('2. CRUD de listas, normalización, deduplicación de correos e independencia de contactos_usuario', async () => {
    // a) Crear lista con espacios, mayúsculas y correos duplicados -> normaliza y deduplica en servidor
    const createRes = await rpc(
      `public.guardar_lista_invitados_seguro(
        '  Amigos del fútbol  ',
        ARRAY[
          '  LUCAS.GOMEZ@Correo.com  ',
          'mateo@club.com',
          'lucas.gomez@correo.COM',
          '  martin@futbol.com '
        ],
        NULL
      )`,
      hostUser
    );
    assert.equal(createRes.ok, true);
    assert.equal(createRes.lista.nombre, 'Amigos del fútbol');
    assert.equal(createRes.lista.destinatarios_count, 3);
    assert.deepEqual(createRes.lista.destinatarios_emails, [
      'lucas.gomez@correo.com',
      'mateo@club.com',
      'martin@futbol.com',
    ]);
    const lista1Id = createRes.lista.id;

    // b) Validaciones de límites y formato
    // Nombre vacío o > 80
    const errNameEmpty = await rpc(
      `public.guardar_lista_invitados_seguro('   ', ARRAY['a@b.com'], NULL)`,
      hostUser
    );
    assert.equal(errNameEmpty.ok, false);
    assert.equal(errNameEmpty.error, 'invalid_list_name');

    const errNameLong = await rpc(
      `public.guardar_lista_invitados_seguro('${'A'.repeat(81)}', ARRAY['a@b.com'], NULL)`,
      hostUser
    );
    assert.equal(errNameLong.ok, false);
    assert.equal(errNameLong.error, 'invalid_list_name');

    // Lista vacía
    const errEmptyRecipients = await rpc(
      `public.guardar_lista_invitados_seguro('Vacia', '{}'::text[], NULL)`,
      hostUser
    );
    assert.equal(errEmptyRecipients.ok, false);
    assert.equal(errEmptyRecipients.error, 'list_empty_recipients');

    // Correo inválido
    const errInvalidEmail = await rpc(
      `public.guardar_lista_invitados_seguro('Mala', ARRAY['no-es-correo'], NULL)`,
      hostUser
    );
    assert.equal(errInvalidEmail.ok, false);
    assert.equal(errInvalidEmail.error, 'invalid_email');

    // c) Unicidad de nombre por propietario (insensible a mayúsculas y espacios)
    const errDupName = await rpc(
      `public.guardar_lista_invitados_seguro('  amigos del FÚTBOL ', ARRAY['otro@club.com'], NULL)`,
      hostUser
    );
    assert.equal(errDupName.ok, false);
    assert.equal(errDupName.error, 'list_name_taken');

    // d) Renombrar lista
    const renRes = await rpc(
      `public.renombrar_lista_invitados_seguro('${lista1Id}', 'Fútbol Jueves Noche')`,
      hostUser
    );
    assert.equal(renRes.ok, true);
    assert.equal(renRes.lista.nombre, 'Fútbol Jueves Noche');

    // e) Editar integrantes de la lista existente
    const editRes = await rpc(
      `public.guardar_lista_invitados_seguro(
        'Fútbol Jueves Noche',
        ARRAY['lucas.gomez@correo.com', 'nuevo.arquero@correo.com'],
        '${lista1Id}'
      )`,
      hostUser
    );
    assert.equal(editRes.ok, true);
    assert.equal(editRes.lista.destinatarios_count, 2);
    assert.deepEqual(editRes.lista.destinatarios_emails, [
      'lucas.gomez@correo.com',
      'nuevo.arquero@correo.com',
    ]);

    // f) Crear segunda lista y verificar listado ordenado alfabéticamente
    const create2 = await rpc(
      `public.guardar_lista_invitados_seguro('Compañeros de Trabajo', ARRAY['colleague1@corp.com', 'colleague2@corp.com'], NULL)`,
      hostUser
    );
    assert.equal(create2.ok, true);

    const listados = await rpc(`public.listar_listas_invitados_seguro(NULL)`, hostUser);
    assert.equal(listados.ok, true);
    assert.equal(listados.listas.length, 2);
    assert.equal(listados.listas[0].nombre, 'Compañeros de Trabajo');
    assert.equal(listados.listas[1].nombre, 'Fútbol Jueves Noche');

    // g) Validaciones de edición y renombrado seguro:
    // Intento de renombrar a nombre ya existente del mismo usuario -> list_name_taken
    const renConflict = await rpc(
      `public.renombrar_lista_invitados_seguro('${create2.lista.id}', 'Fútbol Jueves Noche')`,
      hostUser
    );
    assert.equal(renConflict.ok, false);
    assert.equal(renConflict.error, 'list_name_taken');

    // Renombrado con ID inexistente -> list_not_found
    const renMissing = await rpc(
      `public.renombrar_lista_invitados_seguro('00000000-0000-0000-0000-000000000099', 'Cualquiera')`,
      hostUser
    );
    assert.equal(renMissing.ok, false);
    assert.equal(renMissing.error, 'list_not_found');

    // Edición con ID inexistente -> list_not_found
    const editMissing = await rpc(
      `public.guardar_lista_invitados_seguro('Inexistente', ARRAY['test@test.com'], '00000000-0000-0000-0000-000000000099')`,
      hostUser
    );
    assert.equal(editMissing.ok, false);
    assert.equal(editMissing.error, 'list_not_found');

    // Renombrado válido
    const renOk = await rpc(
      `public.renombrar_lista_invitados_seguro('${create2.lista.id}', 'Compañeros de Oficina')`,
      hostUser
    );
    assert.equal(renOk.ok, true);
    assert.equal(renOk.lista.nombre, 'Compañeros de Oficina');

    // h) INDEPENDENCIA DEL REGISTRO DE CONTACTOS:
    // Agendar lucas.gomez@correo.com como contacto, luego editarlo/eliminarlo de contactos
    // no debe modificar ni borrar los correos guardados en la lista.
    const cLucas = await rpc(
      `public.guardar_contacto_usuario_seguro('Lucas Delantero', 'lucas.gomez@correo.com', false, NULL)`,
      hostUser
    );
    assert.equal(cLucas.ok, true);

    // Editar contacto para cambiar su correo y nombre
    await rpc(
      `public.guardar_contacto_usuario_seguro('Lucas Nuevo Correo', 'lucas.nuevo@correo.com', false, '${cLucas.contacto.id}')`,
      hostUser
    );

    // Eliminar el contacto
    await rpc(`public.eliminar_contacto_usuario_seguro('${cLucas.contacto.id}')`, hostUser);

    // La lista de invitados conserva exactamente 'lucas.gomez@correo.com' sin alteración
    const listCheck = await rpc(`public.listar_listas_invitados_seguro(NULL)`, hostUser);
    const targetLista = listCheck.listas.find((l: any) => l.id === lista1Id);
    assert.deepEqual(
      targetLista.destinatarios_emails,
      ['lucas.gomez@correo.com', 'nuevo.arquero@correo.com'],
      'La edición o eliminación de un contacto nunca altera silenciosamente los integrantes de una lista'
    );

    // h) Eliminar lista
    const delRes = await rpc(
      `public.eliminar_lista_invitados_seguro('${create2.lista.id}')`,
      hostUser
    );
    assert.equal(delRes.ok, true);

    // i) Guardar, renombrar o eliminar listas JAMÁS envía invitaciones
    const invCount = await db.query<{ cnt: number }>(
      `SELECT count(*)::int AS cnt FROM public.solicitudes_invitacion_interna WHERE host_id = '${hostUser}';`
    );
    assert.equal(invCount.rows[0].cnt, 0, 'Operaciones con listas nunca envían invitaciones');
  });

  test('3. Aislamiento estricto de listas entre usuarios (RLS y RPCs)', async () => {
    const hostLists = await rpc(`public.listar_listas_invitados_seguro(NULL)`, hostUser);
    const hostListaId = hostLists.listas[0].id;

    // Otro usuario puede tener una lista con el mismo nombre y correos en su propia cuenta
    const otherSave = await rpc(
      `public.guardar_lista_invitados_seguro('Fútbol Jueves Noche', ARRAY['otro.amigo@correo.com', 'lucas.gomez@correo.com'], NULL)`,
      otherOrganizer
    );
    assert.equal(otherSave.ok, true);

    // Otro usuario NO puede editar, renombrar ni eliminar la lista de hostUser
    const hijackEdit = await rpc(
      `public.guardar_lista_invitados_seguro('Hack', ARRAY['hack@correo.com'], '${hostListaId}')`,
      otherOrganizer
    );
    assert.equal(hijackEdit.ok, false);
    assert.equal(hijackEdit.error, 'list_not_found');

    const hijackRename = await rpc(
      `public.renombrar_lista_invitados_seguro('${hostListaId}', 'Nombre Hackeado')`,
      otherOrganizer
    );
    assert.equal(hijackRename.ok, false);
    assert.equal(hijackRename.error, 'list_not_found');

    const hijackDelete = await rpc(
      `public.eliminar_lista_invitados_seguro('${hostListaId}')`,
      otherOrganizer
    );
    assert.equal(hijackDelete.ok, false);
    assert.equal(hijackDelete.error, 'list_not_found');

    // SELECT directo bajo RLS solo devuelve las filas del propietario permanente
    await setAuth(otherOrganizer, false);
    await db.exec(`SET ROLE authenticated;`);
    const rlsRows = await db.query<{ owner_id: string; nombre: string }>(
      `SELECT owner_id, nombre FROM public.listas_invitados_usuario;`
    );
    await db.exec(`RESET ROLE;`);
    assert.equal(rlsRows.rows.length, 1);
    assert.equal(rlsRows.rows[0].owner_id, otherOrganizer);

    // SELECT directo bajo RLS con cuenta anónima devuelve 0 filas
    await setAuth(anonymousUser, true);
    await db.exec(`SET ROLE authenticated;`);
    const anonRows = await db.query<{ id: string }>(
      `SELECT id FROM public.listas_invitados_usuario;`
    );
    await db.exec(`RESET ROLE;`);
    assert.equal(anonRows.rows.length, 0);

    // Escrituras directas denegadas desde rol authenticated
    await setAuth(hostUser, false);
    await db.exec(`SET ROLE authenticated;`);
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.listas_invitados_usuario (owner_id, nombre, destinatarios_emails)
           VALUES ('${hostUser}', 'Directa', ARRAY['directo@correo.com']);`
        );
      },
      /permission denied/i
    );
    await assert.rejects(
      async () => {
        await db.query(
          `UPDATE public.listas_invitados_usuario SET nombre = 'Directa' WHERE id = '${hostListaId}';`
        );
      },
      /permission denied/i
    );
    await assert.rejects(
      async () => {
        await db.query(`DELETE FROM public.listas_invitados_usuario WHERE id = '${hostListaId}';`);
      },
      /permission denied/i
    );
    await db.exec(`RESET ROLE;`);

    // No puede consultar listas pasando encuentro_id ajeno
    const wrongEnc = await rpc(
      `public.listar_listas_invitados_seguro('${otherEncId}')`,
      hostUser
    );
    assert.equal(wrongEnc.ok, false);
    assert.equal(wrongEnc.error, 'encuentro_not_found_or_not_owner');
  });

  test('4. Sugerencias de grupos implícitos desde historial propio: 2+ integrantes, frecuencias, exclusión de rechazados/cancelados/bloqueados y ya guardados', async () => {
    // Escenario de invitaciones en encuentros propios de hostUser:
    // En enc1 (Fútbol de los Jueves):
    //   - ana@futbol.com (pendiente)
    //   - beto@futbol.com (aceptada)
    //   - carlos@futbol.com (aceptada)
    //   - rechazo@puntoencuentro.com (rechazada -> debe excluirse)
    //   - bloqueado@puntoencuentro.com (bloqueado por hostUser -> debe excluirse)
    //
    // En enc2 (Fútbol Revancha):
    //   - ana@futbol.com (aceptada)
    //   - beto@futbol.com (aceptada)
    //   - carlos@futbol.com (aceptada)
    //   -> Conjunto [ana, beto, carlos] reutilizado en 2 encuentros! (frecuente)
    //
    // En enc3 (Asado de Fin de Año):
    //   - mama@asado.com (aceptada)
    //   - papa@asado.com (aceptada)
    //   - solo.uno@asado.com (cancelada)
    //   -> Conjunto [mama, papa] en 1 encuentro reciente (reciente)
    //
    // Invitación de otro organizador:
    //   - no debe aparecer jamás en sugerencias de hostUser.

    // 1. Invitación de otro organizador
    await rpc(`public.enviar_invitacion_interna_seguro('${otherEncId}', 'amigo.ajeno1@mail.com', NULL)`, otherOrganizer);
    await rpc(`public.enviar_invitacion_interna_seguro('${otherEncId}', 'amigo.ajeno2@mail.com', NULL)`, otherOrganizer);

    // 2. Invitaciones de hostUser en enc1
    await rpc(`public.enviar_invitacion_interna_seguro('${enc1Id}', 'ana@futbol.com', NULL)`, hostUser);
    await rpc(`public.enviar_invitacion_interna_seguro('${enc1Id}', 'beto@futbol.com', NULL)`, hostUser);
    await rpc(`public.enviar_invitacion_interna_seguro('${enc1Id}', 'carlos@futbol.com', NULL)`, hostUser);

    // Invitación rechazada en enc1
    await rpc(`public.enviar_invitacion_interna_seguro('${enc1Id}', 'rechazo@puntoencuentro.com', NULL)`, hostUser);
    const rejInv = await db.query<{ id: string }>(
      `SELECT id FROM public.invitaciones_internas WHERE encuentro_id = '${enc1Id}' AND destinatario_id = '${rejectedGuest}';`
    );
    await rpc(
      `public.responder_invitacion_interna_seguro('${rejInv.rows[0].id}', 'rechazada', 'No puedo ir')`,
      rejectedGuest
    );

    // Invitación con bloqueo unilateral por parte del host
    await rpc(`public.enviar_invitacion_interna_seguro('${enc1Id}', 'bloqueado@puntoencuentro.com', NULL)`, hostUser);
    await db.exec(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${hostUser}', '${blockedUser}')
      ON CONFLICT DO NOTHING;
    `);

    // Invitación con bloqueo bilateral inverso (el destinatario bloqueó al host)
    await rpc(`public.enviar_invitacion_interna_seguro('${enc1Id}', 'me.bloqueo@puntoencuentro.com', NULL)`, hostUser);
    await db.exec(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${reverseBlockedUser}', '${hostUser}')
      ON CONFLICT DO NOTHING;
    `);

    // 3. Invitaciones de hostUser en enc2 (mismo trío ana, beto, carlos)
    await rpc(`public.enviar_invitacion_interna_seguro('${enc2Id}', 'ana@futbol.com', NULL)`, hostUser);
    await rpc(`public.enviar_invitacion_interna_seguro('${enc2Id}', 'beto@futbol.com', NULL)`, hostUser);
    await rpc(`public.enviar_invitacion_interna_seguro('${enc2Id}', 'carlos@futbol.com', NULL)`, hostUser);

    // 4. Invitaciones de hostUser en enc3 (dúo mama, papa + una cancelada)
    await rpc(`public.enviar_invitacion_interna_seguro('${enc3Id}', 'mama@asado.com', NULL)`, hostUser);
    await rpc(`public.enviar_invitacion_interna_seguro('${enc3Id}', 'papa@asado.com', NULL)`, hostUser);
    await rpc(`public.enviar_invitacion_interna_seguro('${enc3Id}', 'solo.cancelado@asado.com', NULL)`, hostUser);
    const cancSol = await db.query<{ id: string }>(
      `SELECT id FROM public.solicitudes_invitacion_interna WHERE encuentro_id = '${enc3Id}' AND destinatario_email = 'solo.cancelado@asado.com';`
    );
    await rpc(`public.cancelar_invitacion_interna_seguro('${cancSol.rows[0].id}')`, hostUser);

    // Consultar listar_listas_invitados_seguro
    const res = await rpc(`public.listar_listas_invitados_seguro('${enc1Id}')`, hostUser);
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.sugerencias_listas));
    assert.equal(res.sugerencias_listas.length, 2, 'Deben sugerirse 2 conjuntos de 2+ destinatarios');

    // Primer sugerencia: el conjunto reutilizado 2 veces [ana, beto, carlos]
    const sug1 = res.sugerencias_listas[0];
    assert.deepEqual(sug1.emails, ['ana@futbol.com', 'beto@futbol.com', 'carlos@futbol.com']);
    assert.equal(sug1.destinatarios_count, 3);
    assert.equal(sug1.veces_usado, 2, 'Priorizado por reutilización (2 encuentros)');
    assert.equal(sug1.nombre_sugerido, 'Fútbol Revancha');

    // Segunda sugerencia: [mama@asado.com, papa@asado.com] (1 vez)
    const sug2 = res.sugerencias_listas[1];
    assert.deepEqual(sug2.emails, ['mama@asado.com', 'papa@asado.com']);
    assert.equal(sug2.destinatarios_count, 2);
    assert.equal(sug2.veces_usado, 1);
    assert.equal(sug2.nombre_sugerido, 'Asado de Fin de Año');

    // Exclusiones verificadas:
    // - rechazo@puntoencuentro.com NO está en ningún conjunto sugerido
    // - bloqueado@puntoencuentro.com NO está
    // - solo.cancelado@asado.com NO está
    // - amigos del otro organizador NO están
    for (const sug of res.sugerencias_listas) {
      assert.ok(!sug.emails.includes('rechazo@puntoencuentro.com'));
      assert.ok(!sug.emails.includes('bloqueado@puntoencuentro.com'));
      assert.ok(!sug.emails.includes('me.bloqueo@puntoencuentro.com'), 'Exclusión bilateral: quien bloqueó al host no se sugiere');
      assert.ok(!sug.emails.includes('solo.cancelado@asado.com'));
      assert.ok(!sug.emails.includes('amigo.ajeno1@mail.com'));
    }

    // ya_invitados_encuentro contiene los activos de enc1
    assert.ok(res.ya_invitados_encuentro.includes('ana@futbol.com'));
    assert.ok(res.ya_invitados_encuentro.includes('beto@futbol.com'));
    assert.ok(res.ya_invitados_encuentro.includes('carlos@futbol.com'));
    assert.ok(!res.ya_invitados_encuentro.includes('rechazo@puntoencuentro.com'));

    // Guardar sug1 como lista -> debe desaparecer de sugerencias para evitar duplicados
    const saveSug = await rpc(
      `public.guardar_lista_invitados_seguro(
        'Grupo Fútbol Oficial',
        ARRAY['carlos@futbol.com', 'ana@futbol.com', 'beto@futbol.com'],
        NULL
      )`,
      hostUser
    );
    assert.equal(saveSug.ok, true);

    const resAfterSave = await rpc(`public.listar_listas_invitados_seguro('${enc1Id}')`, hostUser);
    assert.equal(resAfterSave.sugerencias_listas.length, 1);
    assert.deepEqual(resAfterSave.sugerencias_listas[0].emails, ['mama@asado.com', 'papa@asado.com']);
  });

  test('5. Límites orientativos V1, concurrencia y rate limit', async () => {
    // a) Límite de 50 destinatarios por lista
    const emails51 = Array.from({ length: 51 }, (_, i) => `user${i + 1}@ejemplo.com`);
    const rTooManyRecipients = await rpc(
      `public.guardar_lista_invitados_seguro('Gigante', ARRAY[${emails51.map((e) => `'${e}'`).join(',')}], NULL)`,
      hostUser
    );
    assert.equal(rTooManyRecipients.ok, false);
    assert.equal(rTooManyRecipients.error, 'list_recipient_limit_reached');

    // 50 destinatarios exactos se acepta
    const emails50 = Array.from({ length: 50 }, (_, i) => `user${i + 1}@ejemplo.com`);
    const r50Ok = await rpc(
      `public.guardar_lista_invitados_seguro('Lista de 50', ARRAY[${emails50.map((e) => `'${e}'`).join(',')}], NULL)`,
      hostUser
    );
    assert.equal(r50Ok.ok, true);
    assert.equal(r50Ok.lista.destinatarios_count, 50);

    // b) Límite de 30 listas por usuario
    // Ya creamos varias listas con hostUser. Creemos hasta llegar a 30 con otherOrganizer.
    for (let i = 1; i <= 29; i++) {
      const cr = await rpc(
        `public.guardar_lista_invitados_seguro('Lista Lote ${i}', ARRAY['amigo${i}@mail.com'], NULL)`,
        otherOrganizer
      );
      assert.equal(cr.ok, true);
    }
    // La 31-ésima lista es rechazada con list_limit_reached (recordar que otherOrganizer ya tenía 1 lista creada en test 3)
    const rLimitReached = await rpc(
      `public.guardar_lista_invitados_seguro('Lista 31 Excedida', ARRAY['extra@mail.com'], NULL)`,
      otherOrganizer
    );
    assert.equal(rLimitReached.ok, false);
    assert.equal(rLimitReached.error, 'list_limit_reached');

    // c) Rate limiting manage_guest_list
    await db.query(`SELECT set_config('test.force_rate_limit', 'true', false);`);
    const rlBlocked = await rpc(
      `public.guardar_lista_invitados_seguro('Bloqueada RL', ARRAY['amigo@mail.com'], NULL)`,
      hostUser
    );
    await db.query(`SELECT set_config('test.force_rate_limit', 'false', false);`);
    assert.equal(rlBlocked.ok, false);
    assert.equal(rlBlocked.error, 'rate_limit_exceeded');
  });
});
