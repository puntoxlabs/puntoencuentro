import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

/**
 * Favoritos / Repetir encuentro V1 — Backend & RLS (PGlite).
 *
 * Carga las migraciones reales de Invitaciones Internas V1 (+hardening) y la
 * migración de plantillas, y ejerce las RPCs bajo `SET ROLE authenticated` para
 * validar también los GRANT/REVOKE reales.
 */
describe('Favoritos / Repetir encuentro V1 — Backend, RLS & Privacidad (PGlite)', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const guestUser = '22222222-2222-2222-2222-222222222222'; // registrado
  const otherUser = '33333333-3333-3333-3333-333333333333'; // otro organizador
  const anonymousUser = '44444444-4444-4444-4444-444444444444';
  const blockedByHostUser = '55555555-5555-5555-5555-555555555555';
  const blockerOfHostUser = '66666666-6666-6666-6666-666666666666';

  let fixedEncId: string;
  let coordEncId: string;
  let openEncId: string;
  let cancelledEncId: string;
  let othersEncId: string;

  const setAuth = async (userId: string | null, isAnon = false) => {
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId ?? ''}', false);`);
    await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '${isAnon ? 'true' : 'false'}', false);`);
  };

  const parse = (raw: any): any => {
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return raw; }
    }
    return raw;
  };

  /** Ejecuta una expresión SQL que devuelve JSON como `authenticated` con el usuario dado. */
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

  const saveTpl = (encId: string, name: string, withGuests: boolean, userId = hostUser, isAnon = false) =>
    rpc(`public.guardar_plantilla_encuentro_seguro('${encId}', '${name.replace(/'/g, "''")}', ${withGuests})`, userId, isAnon);

  const sendInvite = (encId: string, email: string, userId = hostUser) =>
    rpc(`public.enviar_invitacion_interna_seguro('${encId}', '${email}', NULL)`, userId);

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
        RETURN jsonb_build_object('allowed', true);
      END;
      $$ LANGUAGE plpgsql;

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        blocker_id UUID NOT NULL,
        blocked_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );

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
        tema_invitacion TEXT,
        invitation_template TEXT,
        date_mode TEXT NOT NULL DEFAULT 'fixed',
        max_participants INT,
        duration_minutes INT,
        mostrar_respuestas_a_invitados BOOLEAN NOT NULL DEFAULT false,
        visibilidad_respuestas_invitados TEXT NOT NULL DEFAULT 'hidden',
        response_deadline TIMESTAMPTZ,
        is_open BOOLEAN NOT NULL DEFAULT false,
        open_public_title TEXT,
        open_description TEXT,
        open_public_zone TEXT,
        locality_id UUID,
        reemplaza_a UUID,
        cancellation_reason TEXT,
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

      CREATE OR REPLACE FUNCTION public.insertar_inbox_notification_seguro(
        p_recipient_user_id UUID, p_notification_type TEXT, p_target_type TEXT, p_target_id UUID,
        p_deep_link TEXT, p_title TEXT, p_body TEXT, p_payload JSONB DEFAULT '{}'::jsonb,
        p_dedup_key TEXT DEFAULT NULL, p_expires_at TIMESTAMPTZ DEFAULT NULL
      ) RETURNS JSONB AS $$
      BEGIN
        RETURN jsonb_build_object('ok', true);
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;

      INSERT INTO auth.users (id, email, is_anonymous, raw_user_meta_data) VALUES
        ('${hostUser}', 'host@puntoencuentro.com', false, '{"full_name": "Host Organizador"}'::jsonb),
        ('${guestUser}', 'invitado@puntoencuentro.com', false, '{"full_name": "Invitado Registrado"}'::jsonb),
        ('${otherUser}', 'otro@puntoencuentro.com', false, '{"full_name": "Otro Organizador"}'::jsonb),
        ('${anonymousUser}', 'anon@puntoencuentro.com', true, '{"full_name": "Anonimo"}'::jsonb),
        ('${blockedByHostUser}', 'bloqueado@puntoencuentro.com', false, '{"full_name": "Bloqueado"}'::jsonb),
        ('${blockerOfHostUser}', 'meblockeo@puntoencuentro.com', false, '{"full_name": "Me Bloqueó"}'::jsonb);
    `);

    // Migraciones reales bajo prueba (en orden)
    for (const file of [
      '20261018180000_internal_invitations_v1.sql',
      '20261018200000_harden_internal_invitations_direct_select.sql',
      '20261019150000_encounter_templates_favorites_v1.sql',
    ]) {
      await db.exec(fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations', file), 'utf-8'));
    }

    // Permisos de esquema equivalentes a Supabase para el rol de cliente
    await db.exec(`
      GRANT USAGE ON SCHEMA public TO authenticated, anon;
      GRANT USAGE ON SCHEMA auth TO authenticated, anon;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
      GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated, anon;
    `);

    // Encuentros de prueba
    const fixed = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, descripcion, host_id, fecha, hora, modalidad, lugar_texto, link_virtual,
                                     tipo_invitacion, tema, tema_invitacion, invitation_template, date_mode, max_participants)
      VALUES ('Asado de los jueves', 'Traer bebida', '${hostUser}', (CURRENT_DATE + 3), '20:30:00', 'virtual',
              'Casa de Ana', 'https://meet.example.com/secreto-abc', 'individual', 'blue', 'friends', 'friends_1', 'fixed', 8)
      RETURNING id;
    `);
    fixedEncId = fixed.rows[0].id;

    const coord = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, descripcion, host_id, modalidad, lugar_texto, tipo_invitacion, date_mode,
                                     duration_minutes, mostrar_respuestas_a_invitados, visibilidad_respuestas_invitados,
                                     response_deadline)
      VALUES ('Coordinación Reunión', 'Definamos fecha', '${hostUser}', 'presencial', 'Oficina', 'link_general', 'coordination',
              90, true, 'summary', now() + interval '2 days')
      RETURNING id;
    `);
    coordEncId = coord.rows[0].id;

    const open = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, descripcion, host_id, fecha, hora, modalidad, lugar_texto, tipo_invitacion,
                                     date_mode, is_open, open_public_title, open_description, open_public_zone, max_participants)
      VALUES ('Fútbol privado título', 'Detalle', '${hostUser}', (CURRENT_DATE + 5), '19:00:00', 'presencial', 'Cancha 5',
              'link_general', 'fixed', true, 'Fútbol abierto Palermo', 'Descripción pública', 'Palermo', 10)
      RETURNING id;
    `);
    openEncId = open.rows[0].id;

    const cancelled = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, fecha, hora, modalidad, lugar_texto, date_mode, estado, cancellation_reason)
      VALUES ('Cumple cancelado', '${hostUser}', (CURRENT_DATE - 10), '21:00:00', 'presencial', 'Salón', 'fixed', 'cancelado', 'Lluvia')
      RETURNING id;
    `);
    cancelledEncId = cancelled.rows[0].id;

    const others = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, host_id, fecha, hora, modalidad, lugar_texto, date_mode)
      VALUES ('Encuentro ajeno', '${otherUser}', (CURRENT_DATE + 7), '10:00:00', 'presencial', 'Ajeno 123', 'fixed')
      RETURNING id;
    `);
    othersEncId = others.rows[0].id;

    // El organizador bloqueó a "bloqueado@" y "meblockeo@" lo bloqueó a él
    await db.exec(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id) VALUES
        ('${hostUser}', '${blockedByHostUser}'),
        ('${blockerOfHostUser}', '${hostUser}');
    `);
  });

  // ────────────────────────────────────────────────────────────────
  // Seed de invitaciones previas del organizador al encuentro fijo
  // ────────────────────────────────────────────────────────────────
  describe('Preparación: invitaciones internas previas', () => {
    test('0. El organizador invita a varias personas (registrada, inexistente, bloqueada, que lo bloqueó)', async () => {
      for (const email of [
        'invitado@puntoencuentro.com', // registrada → invitación real
        'noexiste@test.com',           // inexistente → solo solicitud
        'rechaza@test.com',            // luego "rechazada"
        'cancela@test.com',            // luego "cancelada"
        'bloqueado@puntoencuentro.com',// bloqueada por el host
        'meblockeo@puntoencuentro.com',// me bloqueó (no debe filtrarse)
      ]) {
        const r = await sendInvite(fixedEncId, email);
        assert.equal(r.ok, true, `envío a ${email}`);
      }
      await db.exec(`
        UPDATE public.solicitudes_invitacion_interna SET estado = 'rechazada' WHERE destinatario_email = 'rechaza@test.com';
        UPDATE public.solicitudes_invitacion_interna SET estado = 'cancelada' WHERE destinatario_email = 'cancela@test.com';
      `);

      // Participante manual por nombre (sin correo) + participante generico con respuesta
      await db.exec(`
        INSERT INTO public.participantes (encuentro_id, nombre_invitado, tipo_invitacion, token_invitacion, estado, mensaje_respuesta)
        VALUES ('${fixedEncId}', 'Tía Marta Secreta', 'individual', gen_random_uuid(), 'confirmado', 'Voy con mi pareja'),
               ('${fixedEncId}', 'Solicitante Discovery', 'generico', gen_random_uuid(), 'confirmado', 'Quiero sumarme');
      `);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Guardado de favoritos
  // ────────────────────────────────────────────────────────────────
  describe('Guardado de favoritos', () => {
    test('1. Rechaza usuarios no autenticados y anónimos en todas las RPCs de plantillas', async () => {
      const unauth = await saveTpl(fixedEncId, 'X', false, null as any);
      assert.equal(unauth.ok, false);
      assert.equal(unauth.error, 'not_authenticated');

      const anon = await saveTpl(fixedEncId, 'X', false, anonymousUser, true);
      assert.equal(anon.ok, false);
      assert.equal(anon.error, 'anonymous_user_not_allowed');

      const list = await rpc(`public.listar_plantillas_encuentro_seguro()`, anonymousUser, true);
      assert.equal(list.error, 'anonymous_user_not_allowed');

      const get = await rpc(`public.get_plantilla_encuentro_seguro('${fixedEncId}', false)`, anonymousUser, true);
      assert.equal(get.error, 'anonymous_user_not_allowed');

      const ren = await rpc(`public.renombrar_plantilla_encuentro_seguro('${fixedEncId}', 'Z')`, anonymousUser, true);
      assert.equal(ren.error, 'anonymous_user_not_allowed');

      const del = await rpc(`public.eliminar_plantilla_encuentro_seguro('${fixedEncId}')`, anonymousUser, true);
      assert.equal(del.error, 'anonymous_user_not_allowed');
    });

    test('2. Solo plantilla (fijo): guarda configuración saneada, sin ids, tokens, fecha ni estados', async () => {
      const res = await saveTpl(fixedEncId, 'Asado semanal', false);
      assert.equal(res.ok, true);
      assert.equal(res.invitados_count, 0);

      const row = await db.query<any>(`SELECT * FROM public.plantillas_encuentro WHERE id = '${res.id}'`);
      const tpl = row.rows[0];
      assert.equal(tpl.owner_id, hostUser);
      assert.equal(tpl.date_mode, 'fixed');
      assert.deepEqual(tpl.invitados_emails, [], 'Solo plantilla no persiste correos');

      const cfg = typeof tpl.config === 'string' ? JSON.parse(tpl.config) : tpl.config;
      assert.deepEqual(Object.keys(cfg).sort(), [
        'descripcion', 'duration_minutes', 'hora', 'invitation_template', 'link_virtual', 'lugar_texto',
        'modalidad', 'mostrar_respuestas_a_invitados', 'tema', 'tema_invitacion', 'tipo_invitacion',
        'titulo', 'visibilidad_respuestas_invitados',
      ].sort());
      assert.equal(cfg.titulo, 'Asado de los jueves');
      assert.equal(cfg.hora, '20:30');
      assert.equal(cfg.tema_invitacion, 'friends');

      const serialized = JSON.stringify(tpl);
      for (const forbidden of ['public_token', 'token_invitacion', 'host_id', '"estado"', '"fecha"', 'mensaje_respuesta', 'respondido', 'Tía Marta', 'Discovery']) {
        assert.ok(!serialized.includes(forbidden), `La plantilla no debe contener "${forbidden}"`);
      }
    });

    test('3. Con invitados: solo correos recuperables y autorizados (excluye rechazadas, canceladas y bloqueadas por el host)', async () => {
      const res = await saveTpl(fixedEncId, 'Asado con invitados', true);
      assert.equal(res.ok, true);

      const row = await db.query<any>(`SELECT invitados_emails FROM public.plantillas_encuentro WHERE id = '${res.id}'`);
      const emails: string[] = row.rows[0].invitados_emails;

      assert.deepEqual([...emails].sort(), [
        'invitado@puntoencuentro.com',
        'meblockeo@puntoencuentro.com', // quien bloqueó al host NO se filtra (no revela el bloqueo)
        'noexiste@test.com',            // no revela si existe la cuenta
      ].sort());
      assert.equal(res.invitados_count, 3);
      assert.ok(!emails.includes('rechaza@test.com'));
      assert.ok(!emails.includes('cancela@test.com'));
      assert.ok(!emails.includes('bloqueado@puntoencuentro.com'));
      assert.ok(!emails.includes('host@puntoencuentro.com'));
    });

    test('4. Privacidad de participantes: nombres/respuestas de participantes y solicitantes jamás entran a la plantilla', async () => {
      const all = await db.query<any>(`SELECT row_to_json(p)::text AS j FROM public.plantillas_encuentro p`);
      for (const r of all.rows) {
        assert.ok(!r.j.includes('Tía Marta'));
        assert.ok(!r.j.includes('Solicitante Discovery'));
        assert.ok(!r.j.includes('Voy con mi pareja'));
        assert.ok(!r.j.includes('Quiero sumarme'));
      }
    });

    test('5. No se puede guardar a partir de un encuentro ajeno ni inexistente (respuesta idéntica, sin enumeración)', async () => {
      const others = await saveTpl(othersEncId, 'Robado', true);
      const missing = await saveTpl('00000000-0000-0000-0000-000000000000', 'Robado', true);
      assert.equal(others.ok, false);
      assert.equal(others.error, 'encuentro_not_found_or_not_owner');
      assert.deepEqual(others, missing);
    });

    test('6. Validación de nombre y unicidad (sin distinguir mayúsculas)', async () => {
      for (const bad of ['', '   ', 'x'.repeat(81)]) {
        const r = await saveTpl(fixedEncId, bad, false);
        assert.equal(r.error, 'invalid_template_name');
      }
      const dup = await saveTpl(fixedEncId, '  ASADO SEMANAL ', false);
      assert.equal(dup.ok, false);
      assert.equal(dup.error, 'template_name_taken');

      // Otro usuario puede usar el mismo nombre
      const otherOk = await saveTpl(othersEncId, 'Asado semanal', false, otherUser);
      assert.equal(otherOk.ok, true);
    });

    test('7. Compatibilidad abiertos: el encuentro abierto se guarda SIN flags/título/zonas públicas (nace privado)', async () => {
      const res = await saveTpl(openEncId, 'Fútbol', false);
      assert.equal(res.ok, true);
      const row = await db.query<any>(`SELECT config FROM public.plantillas_encuentro WHERE id = '${res.id}'`);
      const cfg = typeof row.rows[0].config === 'string' ? JSON.parse(row.rows[0].config) : row.rows[0].config;
      assert.equal(cfg.titulo, 'Fútbol privado título', 'Usa el título privado');
      const serialized = JSON.stringify(cfg);
      for (const forbidden of ['is_open', 'open_public_title', 'Fútbol abierto Palermo', 'open_description', 'Descripción pública', 'Palermo', 'max_participants', 'locality_id']) {
        assert.ok(!serialized.includes(forbidden), `No debe copiar "${forbidden}"`);
      }
    });

    test('8. Coordinación: guarda duración y visibilidad, sin opciones de fecha ni plazo', async () => {
      const res = await saveTpl(coordEncId, 'Reunión coordinada', false);
      assert.equal(res.ok, true);
      const row = await db.query<any>(`SELECT date_mode, config FROM public.plantillas_encuentro WHERE id = '${res.id}'`);
      assert.equal(row.rows[0].date_mode, 'coordination');
      const cfg = typeof row.rows[0].config === 'string' ? JSON.parse(row.rows[0].config) : row.rows[0].config;
      assert.equal(cfg.duration_minutes, 90);
      assert.equal(cfg.visibilidad_respuestas_invitados, 'summary');
      assert.equal(cfg.mostrar_respuestas_a_invitados, true);
      assert.equal(cfg.hora, null);
      assert.ok(!('fecha' in cfg) && !('response_deadline' in cfg) && !('opciones' in cfg));
    });

    test('9. Límite de 30 favoritos por usuario', async () => {
      for (let i = 0; i < 40; i++) {
        const r = await saveTpl(othersEncId, `Bulk ${i}`, false, otherUser);
        if (!r.ok) {
          assert.equal(r.error, 'template_limit_reached');
          const cnt = await db.query<{ c: string }>(`SELECT count(*) AS c FROM public.plantillas_encuentro WHERE owner_id = '${otherUser}'`);
          assert.equal(parseInt(cnt.rows[0].c, 10), 30);
          return;
        }
      }
      assert.fail('Debió alcanzar el límite de 30');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Listado y recuperación
  // ────────────────────────────────────────────────────────────────
  describe('Listado, recuperación y administración', () => {
    test('10. El listado devuelve solo plantillas propias, en formato resumido (sin correos ni enlaces)', async () => {
      const list = await rpc(`public.listar_plantillas_encuentro_seguro()`, hostUser);
      assert.equal(list.ok, true);
      const names = list.plantillas.map((p: any) => p.nombre);
      assert.ok(names.includes('Asado semanal') && names.includes('Asado con invitados') && names.includes('Fútbol'));
      assert.equal(list.plantillas.length, 4);

      const serialized = JSON.stringify(list);
      assert.ok(!serialized.includes('@'), 'El listado no expone correos');
      assert.ok(!serialized.includes('meet.example.com'), 'El listado no expone enlaces virtuales');
      const withGuests = list.plantillas.find((p: any) => p.nombre === 'Asado con invitados');
      assert.equal(withGuests.invitados_count, 3);

      const other = await rpc(`public.listar_plantillas_encuentro_seguro()`, guestUser);
      assert.deepEqual(other.plantillas, [], 'Un usuario sin plantillas no ve las ajenas');
    });

    test('11. get_plantilla: correos solo si se piden; ajena → template_not_found', async () => {
      const list = await rpc(`public.listar_plantillas_encuentro_seguro()`, hostUser);
      const withGuests = list.plantillas.find((p: any) => p.nombre === 'Asado con invitados');

      const solo = await rpc(`public.get_plantilla_encuentro_seguro('${withGuests.id}', false)`, hostUser);
      assert.equal(solo.ok, true);
      assert.deepEqual(solo.plantilla.invitados, []);
      assert.equal(solo.plantilla.invitados_count, 3);
      assert.equal(solo.plantilla.config.link_virtual, 'https://meet.example.com/secreto-abc');

      const full = await rpc(`public.get_plantilla_encuentro_seguro('${withGuests.id}', true)`, hostUser);
      assert.equal(full.plantilla.invitados.length, 3);

      const foreign = await rpc(`public.get_plantilla_encuentro_seguro('${withGuests.id}', true)`, otherUser);
      assert.equal(foreign.ok, false);
      assert.equal(foreign.error, 'template_not_found');
      const missing = await rpc(`public.get_plantilla_encuentro_seguro('00000000-0000-0000-0000-000000000000', true)`, otherUser);
      assert.deepEqual(foreign, missing, 'Ajena e inexistente son indistinguibles');
    });

    test('12. Renombrar: propietario sí, otro usuario no, nombre duplicado/ inválido rechazado', async () => {
      const list = await rpc(`public.listar_plantillas_encuentro_seguro()`, hostUser);
      const tpl = list.plantillas.find((p: any) => p.nombre === 'Fútbol');

      const foreign = await rpc(`public.renombrar_plantilla_encuentro_seguro('${tpl.id}', 'Hackeado')`, otherUser);
      assert.equal(foreign.error, 'template_not_found');

      const dup = await rpc(`public.renombrar_plantilla_encuentro_seguro('${tpl.id}', 'asado semanal')`, hostUser);
      assert.equal(dup.error, 'template_name_taken');

      const bad = await rpc(`public.renombrar_plantilla_encuentro_seguro('${tpl.id}', '   ')`, hostUser);
      assert.equal(bad.error, 'invalid_template_name');

      const ok = await rpc(`public.renombrar_plantilla_encuentro_seguro('${tpl.id}', 'Fútbol de los martes')`, hostUser);
      assert.equal(ok.ok, true);
      const check = await db.query<any>(`SELECT nombre FROM public.plantillas_encuentro WHERE id = '${tpl.id}'`);
      assert.equal(check.rows[0].nombre, 'Fútbol de los martes');
    });

    test('13. Eliminar: otro usuario no puede; el propietario borra físicamente plantilla y correos', async () => {
      const list = await rpc(`public.listar_plantillas_encuentro_seguro()`, hostUser);
      const tpl = list.plantillas.find((p: any) => p.nombre === 'Asado con invitados');

      const foreign = await rpc(`public.eliminar_plantilla_encuentro_seguro('${tpl.id}')`, otherUser);
      assert.equal(foreign.error, 'template_not_found');
      const still = await db.query<any>(`SELECT 1 FROM public.plantillas_encuentro WHERE id = '${tpl.id}'`);
      assert.equal(still.rows.length, 1, 'No se borró por el otro usuario');

      const ok = await rpc(`public.eliminar_plantilla_encuentro_seguro('${tpl.id}')`, hostUser);
      assert.equal(ok.ok, true);
      const gone = await db.query<any>(`SELECT 1 FROM public.plantillas_encuentro WHERE id = '${tpl.id}'`);
      assert.equal(gone.rows.length, 0, 'Borrado físico (incluye correos persistidos)');

      const again = await rpc(`public.eliminar_plantilla_encuentro_seguro('${tpl.id}')`, hostUser);
      assert.equal(again.error, 'template_not_found');
    });

    test('14. Borrar el encuentro de origen no borra el favorito (origen_encuentro_id → NULL)', async () => {
      const tmp = await db.query<{ id: string }>(`
        INSERT INTO public.encuentros (titulo, host_id, fecha, hora, modalidad, lugar_texto, date_mode)
        VALUES ('Efímero', '${hostUser}', (CURRENT_DATE + 9), '11:00:00', 'presencial', 'Lugar', 'fixed') RETURNING id;
      `);
      const saved = await saveTpl(tmp.rows[0].id, 'Sobrevive al origen', false);
      assert.equal(saved.ok, true);
      await db.exec(`DELETE FROM public.encuentros WHERE id = '${tmp.rows[0].id}'`);
      const row = await db.query<any>(`SELECT origen_encuentro_id FROM public.plantillas_encuentro WHERE id = '${saved.id}'`);
      assert.equal(row.rows.length, 1);
      assert.equal(row.rows[0].origen_encuentro_id, null);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Repetición directa de un encuentro propio
  // ────────────────────────────────────────────────────────────────
  describe('Repetir encuentro (get_repeticion_encuentro_seguro)', () => {
    test('15. Solo plantilla: devuelve configuración reutilizable y cantidad, sin correos', async () => {
      const r = await rpc(`public.get_repeticion_encuentro_seguro('${fixedEncId}', false)`, hostUser);
      assert.equal(r.ok, true);
      assert.equal(r.plantilla.origen, 'encuentro');
      assert.equal(r.plantilla.date_mode, 'fixed');
      assert.deepEqual(r.plantilla.invitados, []);
      assert.equal(r.plantilla.invitados_count, 3);
      assert.equal(r.plantilla.config.titulo, 'Asado de los jueves');
      assert.ok(!('fecha' in r.plantilla.config));
      const ser = JSON.stringify(r);
      assert.ok(!ser.includes('@'));
      assert.ok(!ser.includes(fixedEncId), 'No expone el id del encuentro de origen');
      assert.ok(!ser.includes('public_token'));
    });

    test('16. Con invitados: devuelve correos autorizados', async () => {
      const r = await rpc(`public.get_repeticion_encuentro_seguro('${fixedEncId}', true)`, hostUser);
      assert.equal(r.ok, true);
      assert.equal(r.plantilla.invitados.length, 3);
    });

    test('17. Funciona sobre encuentros cancelados y abiertos (cualquier estado)', async () => {
      const c = await rpc(`public.get_repeticion_encuentro_seguro('${cancelledEncId}', false)`, hostUser);
      assert.equal(c.ok, true);
      assert.equal(c.plantilla.config.titulo, 'Cumple cancelado');
      assert.ok(!JSON.stringify(c).includes('Lluvia'), 'No copia el motivo de cancelación');
      assert.ok(!JSON.stringify(c).includes('"estado"') && !JSON.stringify(c).includes('cancellation'));

      const o = await rpc(`public.get_repeticion_encuentro_seguro('${openEncId}', false)`, hostUser);
      assert.equal(o.ok, true);
      assert.ok(!JSON.stringify(o).includes('is_open'));
      assert.ok(!JSON.stringify(o).includes('Palermo'));
    });

    test('18. Aislamiento: ajeno e inexistente son indistinguibles', async () => {
      const foreign = await rpc(`public.get_repeticion_encuentro_seguro('${fixedEncId}', true)`, otherUser);
      const missing = await rpc(`public.get_repeticion_encuentro_seguro('00000000-0000-0000-0000-000000000000', true)`, otherUser);
      assert.equal(foreign.ok, false);
      assert.equal(foreign.error, 'encuentro_not_found_or_not_owner');
      assert.deepEqual(foreign, missing);
      const unauth = await rpc(`public.get_repeticion_encuentro_seguro('${fixedEncId}', false)`, null as any);
      assert.equal(unauth.error, 'not_authenticated');
    });

    test('19. Sesión anónima: puede repetir solo plantilla (sin correos) pero no con invitados', async () => {
      const anonEnc = await db.query<{ id: string }>(`
        INSERT INTO public.encuentros (titulo, host_id, fecha, hora, modalidad, lugar_texto, date_mode)
        VALUES ('Anon enc', '${anonymousUser}', (CURRENT_DATE + 2), '12:00:00', 'presencial', 'Plaza', 'fixed') RETURNING id;
      `);
      const solo = await rpc(`public.get_repeticion_encuentro_seguro('${anonEnc.rows[0].id}', false)`, anonymousUser, true);
      assert.equal(solo.ok, true);
      assert.equal(solo.plantilla.invitados_count, 0);
      assert.deepEqual(solo.plantilla.invitados, []);

      const withGuests = await rpc(`public.get_repeticion_encuentro_seguro('${anonEnc.rows[0].id}', true)`, anonymousUser, true);
      assert.equal(withGuests.ok, false);
      assert.equal(withGuests.error, 'anonymous_user_not_allowed');
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Reutilización de las RPC de invitación existentes
  // ────────────────────────────────────────────────────────────────
  describe('Reutilización de RPCs existentes y no-duplicación', () => {
    test('20. Recuperar plantilla/correos NO envía invitaciones; el envío ocurre solo al invocar enviar_invitacion_interna_seguro', async () => {
      const newEnc = await db.query<{ id: string }>(`
        INSERT INTO public.encuentros (titulo, host_id, fecha, hora, modalidad, lugar_texto, date_mode, tipo_invitacion)
        VALUES ('Asado de los jueves', '${hostUser}', (CURRENT_DATE + 10), '20:30:00', 'presencial', 'Casa de Ana', 'fixed', 'individual')
        RETURNING id;
      `);
      const newId = newEnc.rows[0].id;
      assert.notEqual(newId, fixedEncId, 'La repetición genera un encuentro con ID propio');

      const before = await db.query<any>(`SELECT
        (SELECT count(*) FROM public.solicitudes_invitacion_interna WHERE encuentro_id = '${newId}')::int AS sol,
        (SELECT count(*) FROM public.invitaciones_internas WHERE encuentro_id = '${newId}')::int AS inv,
        (SELECT count(*) FROM public.participantes WHERE encuentro_id = '${newId}')::int AS part`);
      assert.deepEqual(before.rows[0], { sol: 0, inv: 0, part: 0 });

      const rep = await rpc(`public.get_repeticion_encuentro_seguro('${fixedEncId}', true)`, hostUser);
      assert.equal(rep.ok, true);

      const afterRead = await db.query<any>(`SELECT count(*)::int AS c FROM public.solicitudes_invitacion_interna WHERE encuentro_id = '${newId}'`);
      assert.equal(afterRead.rows[0].c, 0, 'La lectura jamás envía invitaciones');

      // Acción expresa del organizador: reutiliza la RPC existente (con todas sus validaciones)
      for (const email of rep.plantilla.invitados as string[]) {
        const r = await sendInvite(newId, email);
        assert.equal(r.ok, true);
        assert.equal(r.sent, undefined, 'Respuesta neutra: no revela existencia de cuenta');
      }

      const afterSend = await db.query<any>(`SELECT
        (SELECT count(*) FROM public.solicitudes_invitacion_interna WHERE encuentro_id = '${newId}')::int AS sol,
        (SELECT count(*) FROM public.invitaciones_internas WHERE encuentro_id = '${newId}')::int AS inv`);
      assert.equal(afterSend.rows[0].sol, 3);
      // invitado@ (registrada) → real; meblockeo@ (bloqueo) y noexiste@ → solo solicitud neutra
      assert.equal(afterSend.rows[0].inv, 1);
    });

    test('21. No duplica tokens, respuestas ni confirmaciones del encuentro original', async () => {
      const newEnc = await db.query<{ id: string }>(`
        SELECT id FROM public.encuentros WHERE host_id = '${hostUser}' AND fecha = (CURRENT_DATE + 10) LIMIT 1;
      `);
      const newId = newEnc.rows[0].id;

      const oldTokens = await db.query<any>(`SELECT token_invitacion::text AS t FROM public.participantes WHERE encuentro_id = '${fixedEncId}'`);
      const newParts = await db.query<any>(`SELECT token_invitacion::text AS t, estado, mensaje_respuesta, respondido_en FROM public.participantes WHERE encuentro_id = '${newId}'`);
      const oldSet = new Set(oldTokens.rows.map((r: any) => r.t));
      for (const p of newParts.rows) {
        assert.ok(!oldSet.has(p.t), 'Los tokens del nuevo encuentro son nuevos');
        assert.equal(p.estado, 'pendiente', 'Nace sin confirmaciones');
        assert.equal(p.mensaje_respuesta, null, 'No hereda respuestas');
        assert.equal(p.respondido_en, null);
      }
      assert.ok(!newParts.rows.some((p: any) => p.estado === 'confirmado'));

      const oldEnc = await db.query<any>(`SELECT public_token::text AS t FROM public.encuentros WHERE id = '${fixedEncId}'`);
      const newEncRow = await db.query<any>(`SELECT public_token::text AS t, is_open, reemplaza_a FROM public.encuentros WHERE id = '${newId}'`);
      assert.notEqual(oldEnc.rows[0].t, newEncRow.rows[0].t);
      assert.equal(newEncRow.rows[0].is_open, false, 'Nace privado');
      assert.equal(newEncRow.rows[0].reemplaza_a, null);

      // El original no se alteró
      const oldParts = await db.query<any>(`SELECT count(*)::int AS c FROM public.participantes WHERE encuentro_id = '${fixedEncId}' AND estado = 'confirmado'`);
      assert.equal(oldParts.rows[0].c, 2);
    });

    test('22. Respeta bloqueos: reenviar a quien bloqueó al organizador no crea invitación real ni revela el bloqueo', async () => {
      const inv = await db.query<any>(`SELECT 1 FROM public.invitaciones_internas WHERE destinatario_email = 'meblockeo@puntoencuentro.com'`);
      assert.equal(inv.rows.length, 0);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // RLS y privilegios
  // ────────────────────────────────────────────────────────────────
  describe('Seguridad: RLS, privilegios y aislamiento', () => {
    test('23. RLS SELECT directo: el propietario ve solo lo suyo; otro usuario y anónimo no ven nada', async () => {
      await setAuth(hostUser, false);
      await db.exec(`SET ROLE authenticated;`);
      let ownRows: any[];
      try {
        ownRows = (await db.query<any>(`SELECT owner_id FROM public.plantillas_encuentro`)).rows;
      } finally { await db.exec(`RESET ROLE;`); }
      assert.ok(ownRows.length > 0);
      assert.ok(ownRows.every(r => r.owner_id === hostUser));

      await setAuth(guestUser, false);
      await db.exec(`SET ROLE authenticated;`);
      try {
        const rows = (await db.query<any>(`SELECT * FROM public.plantillas_encuentro`)).rows;
        assert.equal(rows.length, 0, 'Otro usuario no ve filas ajenas');
      } finally { await db.exec(`RESET ROLE;`); }

      await setAuth(anonymousUser, true);
      await db.exec(`SET ROLE authenticated;`);
      try {
        const rows = (await db.query<any>(`SELECT * FROM public.plantillas_encuentro`)).rows;
        assert.equal(rows.length, 0, 'Sesión anónima no ve plantillas');
      } finally { await db.exec(`RESET ROLE;`); }

      await db.exec(`SET ROLE anon;`);
      try {
        await assert.rejects(async () => { await db.query(`SELECT * FROM public.plantillas_encuentro`); }, /permission denied/);
      } finally { await db.exec(`RESET ROLE;`); }
    });

    test('24. Sin escritura directa: INSERT/UPDATE/DELETE por clientes están denegados', async () => {
      await setAuth(hostUser, false);
      await db.exec(`SET ROLE authenticated;`);
      try {
        await assert.rejects(async () => {
          await db.query(`INSERT INTO public.plantillas_encuentro (owner_id, nombre, date_mode, config) VALUES ('${hostUser}', 'directo', 'fixed', '{"x":1}')`);
        }, /permission denied/);
        await assert.rejects(async () => {
          await db.query(`UPDATE public.plantillas_encuentro SET config = '{}'::jsonb`);
        }, /permission denied/);
        await assert.rejects(async () => {
          await db.query(`DELETE FROM public.plantillas_encuentro`);
        }, /permission denied/);
      } finally { await db.exec(`RESET ROLE;`); }
    });

    test('25. anon no puede ejecutar RPCs; helpers internos no son ejecutables por clientes', async () => {
      await setAuth(null);
      await db.exec(`SET ROLE anon;`);
      try {
        await assert.rejects(async () => {
          await db.query(`SELECT public.listar_plantillas_encuentro_seguro()`);
        }, /permission denied/);
        await assert.rejects(async () => {
          await db.query(`SELECT public.guardar_plantilla_encuentro_seguro('${fixedEncId}', 'x', false)`);
        }, /permission denied/);
      } finally { await db.exec(`RESET ROLE;`); }

      await setAuth(hostUser, false);
      await db.exec(`SET ROLE authenticated;`);
      try {
        await assert.rejects(async () => {
          await db.query(`SELECT public.obtener_invitados_reutilizables_interno('${hostUser}', '${fixedEncId}')`);
        }, /permission denied/);
        await assert.rejects(async () => {
          await db.query(`SELECT public.construir_config_plantilla_interno(e) FROM public.encuentros e LIMIT 1`);
        }, /permission denied/);
      } finally { await db.exec(`RESET ROLE;`); }
    });

    test('26. Las funciones usan search_path vacío y SECURITY DEFINER; identidad solo desde auth.uid()', async () => {
      const fns = await db.query<any>(`
        SELECT p.proname, p.prosecdef, p.proconfig::text AS cfg
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN (
          'guardar_plantilla_encuentro_seguro','listar_plantillas_encuentro_seguro','get_plantilla_encuentro_seguro',
          'renombrar_plantilla_encuentro_seguro','eliminar_plantilla_encuentro_seguro','get_repeticion_encuentro_seguro',
          'obtener_invitados_reutilizables_interno')`);
      assert.equal(fns.rows.length, 7);
      for (const f of fns.rows) {
        assert.equal(f.prosecdef, true, `${f.proname} debe ser SECURITY DEFINER`);
        assert.ok(/search_path=""|search_path=''/.test(f.cfg) || f.cfg.includes('search_path'), `${f.proname} fija search_path`);
      }
      // Ninguna RPC acepta un parámetro de identidad enviado por el cliente
      const params = await db.query<any>(`
        SELECT p.proname, pg_get_function_arguments(p.oid) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname IN (
          'guardar_plantilla_encuentro_seguro','listar_plantillas_encuentro_seguro','get_plantilla_encuentro_seguro',
          'renombrar_plantilla_encuentro_seguro','eliminar_plantilla_encuentro_seguro','get_repeticion_encuentro_seguro')`);
      for (const p of params.rows) {
        assert.ok(!/user_id|owner_id|host_id/.test(p.args), `${p.proname} no recibe identidad del cliente`);
      }
    });

    test('27. Eliminar el usuario propietario elimina en cascada sus plantillas (y los correos)', async () => {
      await db.exec(`DELETE FROM public.plantillas_encuentro WHERE owner_id = '${otherUser}'`);
      const tmpUser = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      await db.exec(`INSERT INTO auth.users (id, email, is_anonymous) VALUES ('${tmpUser}', 'tmp@test.com', false)`);
      const enc = await db.query<{ id: string }>(`
        INSERT INTO public.encuentros (titulo, host_id, fecha, hora, modalidad, lugar_texto, date_mode)
        VALUES ('Tmp', '${tmpUser}', (CURRENT_DATE + 2), '10:00:00', 'presencial', 'X', 'fixed') RETURNING id;
      `);
      const saved = await saveTpl(enc.rows[0].id, 'Tmp tpl', false, tmpUser);
      assert.equal(saved.ok, true);
      await db.exec(`DELETE FROM auth.users WHERE id = '${tmpUser}'`);
      const gone = await db.query<any>(`SELECT 1 FROM public.plantillas_encuentro WHERE owner_id = '${tmpUser}'`);
      assert.equal(gone.rows.length, 0);
    });
  });
});
