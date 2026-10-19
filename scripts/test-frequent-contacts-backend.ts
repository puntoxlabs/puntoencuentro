import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

/**
 * Contactos frecuentes V1 — Backend, RLS, Privacidad, Sugerencias e Integración (PGlite).
 *
 * Carga las migraciones reales de:
 *   - Invitaciones Internas V1 (+ hardening)
 *   - Favoritos / Repetir encuentro V1
 *   - Contactos frecuentes V1 (20261019200000_frequent_contacts_v1.sql)
 * y ejecuta las RPCs bajo `SET ROLE authenticated`.
 */
describe('Contactos frecuentes V1 — Backend, RLS & Integración (PGlite)', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const registeredGuest = '22222222-2222-2222-2222-222222222222';
  const otherOrganizer = '33333333-3333-3333-3333-333333333333';
  const anonymousUser = '44444444-4444-4444-4444-444444444444';
  const blockedUser = '55555555-5555-5555-5555-555555555555';
  const rejectedGuest = '66666666-6666-6666-6666-666666666666';

  let enc1Id: string;
  let enc2Id: string;
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
        ('${rejectedGuest}', 'rechazo@puntoencuentro.com', false, '{"full_name": "Invitado Rechaza"}');
    `);

    const f1 = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
    const f2 = new Date(Date.now() + 14 * 86400 * 1000).toISOString().slice(0, 10);

    const r1 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, date_mode)
      VALUES ('${hostUser}', 'Asado Encuentro 1', 'Descripción 1', '${f1}', '21:00', 'presencial', 'Palermo', 'fixed')
      RETURNING id;
    `);
    enc1Id = r1.rows[0].id;

    const r2 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, date_mode)
      VALUES ('${hostUser}', 'Asado Encuentro 2', 'Descripción 2', '${f2}', '21:00', 'presencial', 'Belgrano', 'fixed')
      RETURNING id;
    `);
    enc2Id = r2.rows[0].id;

    const rOther = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, date_mode)
      VALUES ('${otherOrganizer}', 'Encuentro Ajeno', 'De otro host', '${f1}', '20:00', 'presencial', 'Caballito', 'fixed')
      RETURNING id;
    `);
    otherEncId = rOther.rows[0].id;
  });

  test('1. Restricción para usuarios no autenticados y anónimos en todas las RPCs de contactos', async () => {
    const rUnauth = await rpc(
      `public.guardar_contacto_usuario_seguro('Ana', 'ana@ejemplo.com', false, NULL)`,
      null
    );
    assert.equal(rUnauth.ok, false);
    assert.equal(rUnauth.error, 'not_authenticated');

    const rAnonSave = await rpc(
      `public.guardar_contacto_usuario_seguro('Ana', 'ana@ejemplo.com', false, NULL)`,
      anonymousUser,
      true
    );
    assert.equal(rAnonSave.ok, false);
    assert.equal(rAnonSave.error, 'anonymous_user_not_allowed');

    const rAnonList = await rpc(
      `public.listar_contactos_y_sugerencias_seguro(NULL)`,
      anonymousUser,
      true
    );
    assert.equal(rAnonList.ok, false);
    assert.equal(rAnonList.error, 'anonymous_user_not_allowed');
  });

  test('2. CRUD de contactos, normalización, deduplicación por propietario y marcado de favoritos', async () => {
    // Crear contacto (no registrado en auth.users — no exige cuenta registrada ni revela estado)
    const c1 = await rpc(
      `public.guardar_contacto_usuario_seguro('  Martín (Fútbol)  ', '  MARTIN.FUTBOL@Correo.com ', false, NULL)`,
      hostUser
    );
    assert.equal(c1.ok, true);
    assert.equal(c1.contacto.nombre, 'Martín (Fútbol)');
    assert.equal(c1.contacto.email, 'martin.futbol@correo.com');
    assert.equal(c1.contacto.es_favorito, false);

    // Intentar duplicar el mismo correo con mayúsculas distintas -> rechazado con contact_email_taken
    const cDup = await rpc(
      `public.guardar_contacto_usuario_seguro('Otro Nombre', 'martin.futbol@CORREO.com', true, NULL)`,
      hostUser
    );
    assert.equal(cDup.ok, false);
    assert.equal(cDup.error, 'contact_email_taken');

    // Crear segundo contacto como favorito
    const c2 = await rpc(
      `public.guardar_contacto_usuario_seguro('Lucía Trabajo', 'lucia@empresa.com', true, NULL)`,
      hostUser
    );
    assert.equal(c2.ok, true);
    assert.equal(c2.contacto.es_favorito, true);

    // Editar nombre y correo de c1
    const c1Edit = await rpc(
      `public.guardar_contacto_usuario_seguro('Martín Arquero', 'martin.arquero@correo.com', false, '${c1.contacto.id}')`,
      hostUser
    );
    assert.equal(c1Edit.ok, true);
    assert.equal(c1Edit.contacto.nombre, 'Martín Arquero');
    assert.equal(c1Edit.contacto.email, 'martin.arquero@correo.com');

    // Editar c1 intentando usar el correo de c2 -> contact_email_taken
    const c1Collision = await rpc(
      `public.guardar_contacto_usuario_seguro('Martín', 'lucia@empresa.com', false, '${c1.contacto.id}')`,
      hostUser
    );
    assert.equal(c1Collision.ok, false);
    assert.equal(c1Collision.error, 'contact_email_taken');

    // Alternar favorito de c1 a true
    const favToggle = await rpc(
      `public.alternar_favorito_contacto_usuario_seguro('${c1.contacto.id}', true)`,
      hostUser
    );
    assert.equal(favToggle.ok, true);
    assert.equal(favToggle.es_favorito, true);

    // Verificar listado ordenado (ambos favoritos, orden alfabético: Lucía Trabajo, Martín Arquero)
    const list1 = await rpc(`public.listar_contactos_y_sugerencias_seguro(NULL)`, hostUser);
    assert.equal(list1.ok, true);
    assert.equal(list1.contactos.length, 2);
    assert.equal(list1.contactos[0].nombre, 'Lucía Trabajo');
    assert.equal(list1.contactos[1].nombre, 'Martín Arquero');

    // Eliminar un contacto temporal
    const cTemp = await rpc(
      `public.guardar_contacto_usuario_seguro('Temporal', 'temp@correo.com', false, NULL)`,
      hostUser
    );
    assert.equal(cTemp.ok, true);
    const delRes = await rpc(
      `public.eliminar_contacto_usuario_seguro('${cTemp.contacto.id}')`,
      hostUser
    );
    assert.equal(delRes.ok, true);

    // Verificar que guardar/editar contactos JAMÁS envió invitaciones
    const invCount = await db.query<{ cnt: number }>(
      `SELECT count(*)::int AS cnt FROM public.solicitudes_invitacion_interna WHERE host_id = '${hostUser}';`
    );
    assert.equal(invCount.rows[0].cnt, 0, 'Guardar contactos nunca debe enviar invitaciones');
  });

  test('3. Aislamiento estricto entre usuarios (RLS y RPCs)', async () => {
    const hostList = await rpc(`public.listar_contactos_y_sugerencias_seguro(NULL)`, hostUser);
    const targetContactId = hostList.contactos[0].id;

    // Otro organizador puede guardar el mismo email en su propia agenda independiente
    const otherSaveSameEmail = await rpc(
      `public.guardar_contacto_usuario_seguro('Lucía de Otro', 'lucia@empresa.com', false, NULL)`,
      otherOrganizer
    );
    assert.equal(otherSaveSameEmail.ok, true);

    // Otro organizador NO puede editar, marcar favorito ni eliminar el contacto de hostUser
    const hijackEdit = await rpc(
      `public.guardar_contacto_usuario_seguro('Hackeado', 'hack@empresa.com', false, '${targetContactId}')`,
      otherOrganizer
    );
    assert.equal(hijackEdit.ok, false);
    assert.equal(hijackEdit.error, 'contact_not_found');

    const hijackFav = await rpc(
      `public.alternar_favorito_contacto_usuario_seguro('${targetContactId}', false)`,
      otherOrganizer
    );
    assert.equal(hijackFav.ok, false);
    assert.equal(hijackFav.error, 'contact_not_found');

    const hijackDel = await rpc(
      `public.eliminar_contacto_usuario_seguro('${targetContactId}')`,
      otherOrganizer
    );
    assert.equal(hijackDel.ok, false);
    assert.equal(hijackDel.error, 'contact_not_found');

    // SELECT directo bajo RLS solo devuelve los contactos propios
    await setAuth(otherOrganizer, false);
    await db.exec(`SET ROLE authenticated;`);
    const rlsRows = await db.query<{ owner_id: string; nombre: string }>(
      `SELECT owner_id, nombre FROM public.contactos_usuario;`
    );
    await db.exec(`RESET ROLE;`);
    assert.equal(rlsRows.rows.length, 1);
    assert.equal(rlsRows.rows[0].owner_id, otherOrganizer);
    assert.equal(rlsRows.rows[0].nombre, 'Lucía de Otro');

    // No puede listar pasando encuentro_id ajeno
    const wrongEnc = await rpc(
      `public.listar_contactos_y_sugerencias_seguro('${otherEncId}')`,
      hostUser
    );
    assert.equal(wrongEnc.ok, false);
    assert.equal(wrongEnc.error, 'encuentro_not_found_or_not_owner');
  });

  test('4. Sugerencias del historial: frecuentes/recientes, exclusión de rechazadas, canceladas, bloqueados y ya agendados', async () => {
    // Enviar invitaciones reales en enc1 y enc2
    // a) registrado@puntoencuentro.com invitado en enc1 y enc2 (2 veces -> frecuente)
    await rpc(`public.enviar_invitacion_interna_seguro('${enc1Id}', 'registrado@puntoencuentro.com', NULL)`, hostUser);
    await rpc(`public.enviar_invitacion_interna_seguro('${enc2Id}', 'registrado@puntoencuentro.com', NULL)`, hostUser);

    // b) externo.reciente@no-registrado.com invitado en enc1 (1 vez -> reciente)
    await rpc(`public.enviar_invitacion_interna_seguro('${enc1Id}', 'externo.reciente@no-registrado.com', NULL)`, hostUser);

    // c) lucia@empresa.com invitada en enc1, pero YA está en contactos_usuario -> NO debe duplicarse en sugerencias
    await rpc(`public.enviar_invitacion_interna_seguro('${enc1Id}', 'lucia@empresa.com', NULL)`, hostUser);

    // d) rechazo@puntoencuentro.com invitado en enc1 y rechaza la invitación -> excluido de sugerencias
    await rpc(`public.enviar_invitacion_interna_seguro('${enc1Id}', 'rechazo@puntoencuentro.com', NULL)`, hostUser);
    const rejInv = await db.query<{ id: string }>(
      `SELECT id FROM public.invitaciones_internas WHERE encuentro_id = '${enc1Id}' AND destinatario_id = '${rejectedGuest}';`
    );
    await rpc(
      `public.responder_invitacion_interna_seguro('${rejInv.rows[0].id}', 'rechazada', 'No puedo')`,
      rejectedGuest
    );

    // e) cancelado@no-registrado.com invitado en enc1 y cancelado por el organizador -> excluido de sugerencias
    await rpc(`public.enviar_invitacion_interna_seguro('${enc1Id}', 'cancelado@no-registrado.com', NULL)`, hostUser);
    const cancSol = await db.query<{ id: string }>(
      `SELECT id FROM public.solicitudes_invitacion_interna WHERE encuentro_id = '${enc1Id}' AND destinatario_email = 'cancelado@no-registrado.com';`
    );
    await rpc(`public.cancelar_invitacion_interna_seguro('${cancSol.rows[0].id}')`, hostUser);

    // f) bloqueado@puntoencuentro.com invitado en enc1 y luego bloqueado por el organizador -> excluido de sugerencias
    await rpc(`public.enviar_invitacion_interna_seguro('${enc1Id}', 'bloqueado@puntoencuentro.com', NULL)`, hostUser);
    await db.exec(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id)
      VALUES ('${hostUser}', '${blockedUser}');
    `);

    const res = await rpc(`public.listar_contactos_y_sugerencias_seguro('${enc1Id}')`, hostUser);
    assert.equal(res.ok, true);

    const sugEmails = res.sugerencias.map((s: any) => s.email);
    assert.deepEqual(
      sugEmails,
      ['registrado@puntoencuentro.com', 'externo.reciente@no-registrado.com'],
      'Sugerencias deben ordenar por frecuencia y excluir ya agendados, rechazados, cancelados y bloqueados'
    );
    assert.equal(res.sugerencias[0].veces_invitado, 2);
    assert.equal(res.sugerencias[1].veces_invitado, 1);

    // Verificar que ya_invitados_encuentro incluye los pendientes/aceptados de enc1
    assert.ok(res.ya_invitados_encuentro.includes('registrado@puntoencuentro.com'));
    assert.ok(res.ya_invitados_encuentro.includes('lucia@empresa.com'));
    assert.ok(!res.ya_invitados_encuentro.includes('cancelado@no-registrado.com'));

    // Guardar una sugerencia como contacto -> pasa a `contactos` y desaparece de `sugerencias`
    const saveFromHist = await rpc(
      `public.guardar_contacto_usuario_seguro('Invitado Frecuente', 'registrado@puntoencuentro.com', true, NULL)`,
      hostUser
    );
    assert.equal(saveFromHist.ok, true);

    const resAfterSave = await rpc(`public.listar_contactos_y_sugerencias_seguro('${enc1Id}')`, hostUser);
    assert.deepEqual(
      resAfterSave.sugerencias.map((s: any) => s.email),
      ['externo.reciente@no-registrado.com'],
      'Al agendar una sugerencia como contacto deja de aparecer en sugerencias'
    );
  });

  test('5. Integración con Favoritos/Repetir encuentro y No regresión de Invitaciones Internas V1', async () => {
    // Guardar favorito con invitados desde enc1
    const fav = await rpc(
      `public.guardar_plantilla_encuentro_seguro('${enc1Id}', 'Asado Favorito Con Contactos', true)`,
      hostUser
    );
    assert.equal(fav.ok, true);

    const tpl = await rpc(
      `public.get_plantilla_encuentro_seguro('${fav.id}', true)`,
      hostUser
    );
    assert.equal(tpl.ok, true);
    const recoveredEmails: string[] = tpl.plantilla.invitados;
    assert.ok(recoveredEmails.includes('registrado@puntoencuentro.com'));
    assert.ok(!recoveredEmails.includes('rechazo@puntoencuentro.com'));
    assert.ok(!recoveredEmails.includes('bloqueado@puntoencuentro.com'));

    // Crear un encuentro nuevo (repetido) y enviar invitaciones combinando recuperados + un nuevo contacto de la agenda
    const f3 = new Date(Date.now() + 21 * 86400 * 1000).toISOString().slice(0, 10);
    const r3 = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, descripcion, fecha, hora, modalidad, lugar_texto, date_mode)
      VALUES ('${hostUser}', 'Asado Repetido 3', 'Descripción 3', '${f3}', '21:00', 'presencial', 'Palermo', 'fixed')
      RETURNING id;
    `);
    const newEncId = r3.rows[0].id;

    // Enviar invitación al contacto de la agenda 'martin.arquero@correo.com' y al recuperado 'registrado@puntoencuentro.com'
    const send1 = await rpc(
      `public.enviar_invitacion_interna_seguro('${newEncId}', 'martin.arquero@correo.com', '¡Sumate al nuevo asado!')`,
      hostUser
    );
    assert.equal(send1.ok, true);

    const send2 = await rpc(
      `public.enviar_invitacion_interna_seguro('${newEncId}', 'registrado@puntoencuentro.com', '¡Sumate al nuevo asado!')`,
      hostUser
    );
    assert.equal(send2.ok, true);

    // Reintento duplicado al mismo encuentro es rechazado por enviar_invitacion_interna_seguro
    const sendDup = await rpc(
      `public.enviar_invitacion_interna_seguro('${newEncId}', 'martin.arquero@correo.com', NULL)`,
      hostUser
    );
    assert.equal(sendDup.ok, false);
    assert.equal(sendDup.error, 'invitation_already_pending');

    // Rate limit de agenda de contactos funciona correctamente
    await db.query(`SELECT set_config('test.force_rate_limit', 'true', false);`);
    const rlBlocked = await rpc(
      `public.guardar_contacto_usuario_seguro('Bloqueado RL', 'rl@correo.com', false, NULL)`,
      hostUser
    );
    await db.query(`SELECT set_config('test.force_rate_limit', 'false', false);`);
    assert.equal(rlBlocked.ok, false);
    assert.equal(rlBlocked.error, 'rate_limit_exceeded');
  });
});
