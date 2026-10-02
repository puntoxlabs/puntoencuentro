import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2A: Backend de "Avisame" + Matching Determinístico (Tests Nivel A - PGlite)', () => {
  let db: PGlite;

  const hostUser = '10000000-0000-0000-0000-000000000001';
  const userA = '11111111-1111-1111-1111-111111111111';
  const userB = '22222222-2222-2222-2222-222222222222';
  const userBlocked = '33333333-3333-3333-3333-333333333333';
  const userAnon = '44444444-4444-4444-4444-444444444444';

  before(async () => {
    db = new PGlite();

    // 1. Configuración de entorno Postgres simulado
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;

      ALTER ROLE service_role BYPASSRLS;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION public.set_updated_at()
      RETURNS trigger AS $$
      BEGIN
          NEW.updated_at = pg_catalog.timezone('utc', pg_catalog.now());
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      INSERT INTO auth.users (id, email) VALUES
        ('${hostUser}', 'host@test.com'),
        ('${userA}', 'userA@test.com'),
        ('${userB}', 'userB@test.com'),
        ('${userBlocked}', 'blocked@test.com'),
        ('${userAnon}', 'anon@test.com')
      ON CONFLICT DO NOTHING;

      -- Base localidades
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
        ('guemes', 'Güemes', 'Mar del Plata', 'Costa Atlántica'),
        ('palermo', 'Palermo', 'Buenos Aires', 'CABA')
      ON CONFLICT DO NOTHING;
      GRANT ALL ON TABLE public.localidades TO authenticated, anon, service_role;

      -- Base bloqueos_usuario
      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        blocker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        blocked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
        PRIMARY KEY (blocker_id, blocked_id),
        CONSTRAINT chk_bloqueos_no_self_block CHECK (blocker_id <> blocked_id)
      );
      GRANT ALL ON TABLE public.bloqueos_usuario TO authenticated, anon, service_role;

      -- Base intenciones e intencion_intereses (para compatibilidad de abrir_encuentro_seguro)
      CREATE TABLE IF NOT EXISTS public.intenciones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID
      );
      CREATE TABLE IF NOT EXISTS public.intencion_intereses (
        intencion_id UUID,
        user_id UUID
      );
      CREATE TABLE IF NOT EXISTS public.alertas_compatibilidad (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        tipo TEXT,
        source_intencion_id UUID,
        target_encuentro_id UUID,
        UNIQUE (user_id, tipo, source_intencion_id, target_encuentro_id)
      );

      -- Base encuentros
      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha DATE,
        hora TIME WITHOUT TIME ZONE,
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
      GRANT ALL ON TABLE public.encuentros TO authenticated, anon, service_role;

      -- Base participantes
      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        estado TEXT NOT NULL DEFAULT 'confirmado',
        user_id UUID,
        creado_en TIMESTAMPTZ DEFAULT now()
      );
      GRANT ALL ON TABLE public.participantes TO authenticated, anon, service_role;
    `);

    // 2. Cargar migraciones de notificaciones y la nueva migración de Fase 2A
    const migrations = [
      'supabase/migrations/20261002180000_notifications_inbox_and_outbox_base.sql',
      'supabase/migrations/20261002200000_harden_inbox_rpc_grants.sql',
      'supabase/migrations/20261002210000_fase_2a_match_alert_subscriptions.sql',
    ];

    for (const mig of migrations) {
      const sql = fs.readFileSync(path.join(process.cwd(), mig), 'utf8');
      await db.exec(sql);
    }
  });

  const setAuthContext = async (userId: string | null, isAnonymous: boolean = false) => {
    if (!userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
      await db.query(`SET ROLE anon;`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": ${isAnonymous}}', false);`);
      await db.query(`SET ROLE authenticated;`);
    }
  };

  const asAdmin = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.query(`SET ROLE service_role;`);
    try {
      return await fn();
    } finally {
      // noop
    }
  };

  test('1. Crear alerta válida con criterios explícitos', async () => {
    await setAuthContext(userA, false);

    const res = await db.query(`
      SELECT public.crear_alerta_suscripcion_seguro(
        p_modalidad := 'presencial',
        p_locality_id := 'guemes',
        p_fecha_desde := '2026-10-10',
        p_fecha_hasta := '2026-10-20',
        p_hora_desde := '18:00:00',
        p_hora_hasta := '22:00:00',
        p_activity_slug := 'padel'
      ) AS result;
    `);

    const result = (res.rows[0] as any).result;
    assert.equal(result.ok, true);
    assert.ok(result.subscription.id);
    assert.equal(result.subscription.status, 'active');
    assert.equal(result.subscription.modalidad, 'presencial');
    assert.equal(result.subscription.locality_id, 'guemes');
    assert.equal(result.subscription.fecha_desde, '2026-10-10');
    assert.equal(result.subscription.fecha_hasta, '2026-10-20');
  });

  test('2. Rechazo de anon y usuarios anónimos de Supabase', async () => {
    // a) Anon role sin sesión
    await setAuthContext(null);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.crear_alerta_suscripcion_seguro(p_modalidad := 'presencial') AS result;`);
      },
      /permission denied/
    );

    // b) Authenticated anónimo (is_anonymous = true)
    await setAuthContext(userAnon, true);
    const anonRes = await db.query(`
      SELECT public.crear_alerta_suscripcion_seguro(p_modalidad := 'presencial') AS result;
    `);
    assert.equal((anonRes.rows[0] as any).result.ok, false);
    assert.equal((anonRes.rows[0] as any).result.error, 'permanent_account_required');
  });

  test('3. Aislamiento entre usuarios (RLS y RPCs)', async () => {
    // User A crea una suscripción
    await setAuthContext(userA, false);
    const createRes = await db.query(`
      SELECT public.crear_alerta_suscripcion_seguro(p_modalidad := 'virtual') AS result;
    `);
    const subAId = (createRes.rows[0] as any).result.subscription.id;

    // User B intenta consultar alertas (solo debe ver las suyas, no las de A)
    await setAuthContext(userB, false);
    const listB = await db.query(`
      SELECT public.get_mis_alertas_suscripciones_seguro() AS result;
    `);
    const subsB = (listB.rows[0] as any).result.subscriptions;
    assert.ok(!subsB.some((s: any) => s.id === subAId));

    // User B intenta pausar la suscripción de User A
    const pauseFail = await db.query(`
      SELECT public.pausar_alerta_suscripcion_seguro('${subAId}') AS result;
    `);
    assert.equal((pauseFail.rows[0] as any).result.ok, false);
    assert.equal((pauseFail.rows[0] as any).result.error, 'unauthorized');
  });

  test('4. Lifecycle: pausar, reactivar y cancelar', async () => {
    await setAuthContext(userA, false);
    const createRes = await db.query(`
      SELECT public.crear_alerta_suscripcion_seguro(p_modalidad := 'indistinto') AS result;
    `);
    const subId = (createRes.rows[0] as any).result.subscription.id;

    // Pausar
    const pauseRes = await db.query(`
      SELECT public.pausar_alerta_suscripcion_seguro('${subId}') AS result;
    `);
    assert.equal((pauseRes.rows[0] as any).result.ok, true);
    assert.equal((pauseRes.rows[0] as any).result.status, 'paused');

    // Reactivar
    const reactivateRes = await db.query(`
      SELECT public.reactivar_alerta_suscripcion_seguro('${subId}') AS result;
    `);
    assert.equal((reactivateRes.rows[0] as any).result.ok, true);
    assert.equal((reactivateRes.rows[0] as any).result.status, 'active');

    // Cancelar
    const cancelRes = await db.query(`
      SELECT public.cancelar_alerta_suscripcion_seguro('${subId}') AS result;
    `);
    assert.equal((cancelRes.rows[0] as any).result.ok, true);
    assert.equal((cancelRes.rows[0] as any).result.status, 'cancelled');

    // No se puede reactivar una alerta cancelada
    const reactivateAfterCancel = await db.query(`
      SELECT public.reactivar_alerta_suscripcion_seguro('${subId}') AS result;
    `);
    assert.equal((reactivateAfterCancel.rows[0] as any).result.ok, false);
    assert.equal((reactivateAfterCancel.rows[0] as any).result.error, 'already_cancelled');
  });

  test('5. Alerta expirada no participa en el matching', async () => {
    const subExpiredId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const encId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    await asAdmin(async () => {
      await db.exec(`
        INSERT INTO public.match_alert_subscriptions (
          id, user_id, status, modalidad, locality_id, expires_at
        ) VALUES (
          '${subExpiredId}', '${userA}', 'active', 'presencial', 'guemes', now() - INTERVAL '1 day'
        );

        INSERT INTO public.encuentros (
          id, host_id, titulo, modalidad, locality_id, is_open, estado, fecha, hora
        ) VALUES (
          '${encId}', '${hostUser}', 'Pádel Mañanero', 'presencial', 'guemes', true, 'activo', '2026-10-15', '10:00:00'
        );
      `);
    });

    await setAuthContext(hostUser, false);
    await db.query(`
      SELECT public.evaluar_matching_encuentro_abierto('${encId}') AS result;
    `);

    // No debe hacer match con la alerta expirada
    await asAdmin(async () => {
      const outboxRes = await db.query(`
        SELECT * FROM public.domain_events_outbox
        WHERE dedup_key = 'match:${subExpiredId}:${encId}:v1';
      `);
      assert.equal(outboxRes.rows.length, 0);
    });
  });

  test('6. Matching determinístico por modalidad (presencial vs virtual)', async () => {
    const subPresencial = '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const subVirtual = '22222222-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const encPresencial = '33333333-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    await asAdmin(async () => {
      await db.exec(`
        INSERT INTO public.match_alert_subscriptions (id, user_id, status, modalidad) VALUES
          ('${subPresencial}', '${userA}', 'active', 'presencial'),
          ('${subVirtual}', '${userA}', 'active', 'virtual');

        INSERT INTO public.encuentros (
          id, host_id, titulo, modalidad, locality_id, is_open, estado
        ) VALUES (
          '${encPresencial}', '${hostUser}', 'Encuentro Presencial en Güemes', 'presencial', 'guemes', true, 'activo'
        );
      `);
    });

    await setAuthContext(hostUser, false);
    await db.query(`SELECT public.evaluar_matching_encuentro_abierto('${encPresencial}');`);

    await asAdmin(async () => {
      // subPresencial DEBE haber recibido evento
      const matchPres = await db.query(`
        SELECT * FROM public.domain_events_outbox WHERE dedup_key = 'match:${subPresencial}:${encPresencial}:v1';
      `);
      assert.equal(matchPres.rows.length, 1);

      // subVirtual NO debe haber recibido evento para encuentro presencial
      const matchVirt = await db.query(`
        SELECT * FROM public.domain_events_outbox WHERE dedup_key = 'match:${subVirtual}:${encPresencial}:v1';
      `);
      assert.equal(matchVirt.rows.length, 0);
    });
  });

  test('7. Matching determinístico por rango de fechas', async () => {
    const subDates = '44444444-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const encValidDate = '55555555-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const encOutDate = '66666666-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    await asAdmin(async () => {
      await db.exec(`
        INSERT INTO public.match_alert_subscriptions (
          id, user_id, status, fecha_desde, fecha_hasta
        ) VALUES (
          '${subDates}', '${userA}', 'active', '2026-11-01', '2026-11-10'
        );

        INSERT INTO public.encuentros (
          id, host_id, titulo, modalidad, is_open, estado, fecha
        ) VALUES (
          '${encValidDate}', '${hostUser}', 'Encuentro en Noviembre', 'virtual', true, 'activo', '2026-11-05'
        ), (
          '${encOutDate}', '${hostUser}', 'Encuentro Tardío', 'virtual', true, 'activo', '2026-11-15'
        );
      `);
    });

    await setAuthContext(hostUser, false);
    await db.query(`SELECT public.evaluar_matching_encuentro_abierto('${encValidDate}');`);
    await db.query(`SELECT public.evaluar_matching_encuentro_abierto('${encOutDate}');`);

    await asAdmin(async () => {
      const matchValid = await db.query(`
        SELECT * FROM public.domain_events_outbox WHERE dedup_key = 'match:${subDates}:${encValidDate}:v1';
      `);
      assert.equal(matchValid.rows.length, 1);

      const matchOut = await db.query(`
        SELECT * FROM public.domain_events_outbox WHERE dedup_key = 'match:${subDates}:${encOutDate}:v1';
      `);
      assert.equal(matchOut.rows.length, 0);
    });
  });

  test('8. Matching determinístico por zona/localidad', async () => {
    const subPalermo = '77777777-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const encGuemes = '88888888-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const encPalermo = '99999999-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    await asAdmin(async () => {
      await db.exec(`
        INSERT INTO public.match_alert_subscriptions (
          id, user_id, status, modalidad, locality_id
        ) VALUES (
          '${subPalermo}', '${userB}', 'active', 'presencial', 'palermo'
        );

        INSERT INTO public.encuentros (
          id, host_id, titulo, modalidad, locality_id, is_open, estado
        ) VALUES (
          '${encGuemes}', '${hostUser}', 'Presencial en Güemes', 'presencial', 'guemes', true, 'activo'
        ), (
          '${encPalermo}', '${hostUser}', 'Presencial en Palermo', 'presencial', 'palermo', true, 'activo'
        );
      `);
    });

    await setAuthContext(hostUser, false);
    await db.query(`SELECT public.evaluar_matching_encuentro_abierto('${encGuemes}');`);
    await db.query(`SELECT public.evaluar_matching_encuentro_abierto('${encPalermo}');`);

    await asAdmin(async () => {
      // En Güemes no debe matchear con alerta de Palermo
      const matchNo = await db.query(`
        SELECT * FROM public.domain_events_outbox WHERE dedup_key = 'match:${subPalermo}:${encGuemes}:v1';
      `);
      assert.equal(matchNo.rows.length, 0);

      // En Palermo sí debe matchear
      const matchYes = await db.query(`
        SELECT * FROM public.domain_events_outbox WHERE dedup_key = 'match:${subPalermo}:${encPalermo}:v1';
      `);
      assert.equal(matchYes.rows.length, 1);
    });
  });

  test('9. Auto-match evitado: host con alerta no se auto-notifica', async () => {
    const subHost = 'aaaaaaaa-1111-1111-1111-111111111111';
    const encHost = 'bbbbbbbb-1111-1111-1111-111111111111';

    await asAdmin(async () => {
      await db.exec(`
        INSERT INTO public.match_alert_subscriptions (
          id, user_id, status, modalidad, locality_id
        ) VALUES (
          '${subHost}', '${hostUser}', 'active', 'presencial', 'guemes'
        );

        INSERT INTO public.encuentros (
          id, host_id, titulo, modalidad, locality_id, is_open, estado
        ) VALUES (
          '${encHost}', '${hostUser}', 'Mi propio encuentro', 'presencial', 'guemes', true, 'activo'
        );
      `);
    });

    await setAuthContext(hostUser, false);
    await db.query(`SELECT public.evaluar_matching_encuentro_abierto('${encHost}');`);

    await asAdmin(async () => {
      const outboxHost = await db.query(`
        SELECT * FROM public.domain_events_outbox WHERE dedup_key = 'match:${subHost}:${encHost}:v1';
      `);
      assert.equal(outboxHost.rows.length, 0);
    });
  });

  test('10. Bloqueo bilateral evita generación de match', async () => {
    const subBlocked = 'cccccccc-1111-1111-1111-111111111111';
    const encBlockedCheck = 'dddddddd-1111-1111-1111-111111111111';

    await asAdmin(async () => {
      await db.exec(`
        INSERT INTO public.match_alert_subscriptions (
          id, user_id, status, modalidad, locality_id
        ) VALUES (
          '${subBlocked}', '${userBlocked}', 'active', 'presencial', 'guemes'
        );

        INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id) VALUES
          ('${hostUser}', '${userBlocked}')
        ON CONFLICT DO NOTHING;

        INSERT INTO public.encuentros (
          id, host_id, titulo, modalidad, locality_id, is_open, estado
        ) VALUES (
          '${encBlockedCheck}', '${hostUser}', 'Encuentro con Host Bloqueador', 'presencial', 'guemes', true, 'activo'
        );
      `);
    });

    await setAuthContext(hostUser, false);
    await db.query(`SELECT public.evaluar_matching_encuentro_abierto('${encBlockedCheck}');`);

    await asAdmin(async () => {
      const outboxBlocked = await db.query(`
        SELECT * FROM public.domain_events_outbox WHERE dedup_key = 'match:${subBlocked}:${encBlockedCheck}:v1';
      `);
      assert.equal(outboxBlocked.rows.length, 0);
    });
  });

  test('11. Deduplicación e Idempotencia en Outbox', async () => {
    const subDedup = 'eeeeeeee-1111-1111-1111-111111111111';
    const encDedup = 'ffffffff-1111-1111-1111-111111111111';

    await asAdmin(async () => {
      await db.exec(`
        INSERT INTO public.match_alert_subscriptions (
          id, user_id, status, modalidad, locality_id
        ) VALUES (
          '${subDedup}', '${userA}', 'active', 'presencial', 'palermo'
        );

        INSERT INTO public.encuentros (
          id, host_id, titulo, modalidad, locality_id, is_open, estado
        ) VALUES (
          '${encDedup}', '${hostUser}', 'Encuentro para test de Dedup', 'presencial', 'palermo', true, 'activo'
        );
      `);
    });

    await setAuthContext(hostUser, false);
    // Primera evaluación: genera evento(s)
    const eval1 = await db.query(`SELECT public.evaluar_matching_encuentro_abierto('${encDedup}') AS result;`);
    assert.ok((eval1.rows[0] as any).result.matches_count >= 1);

    // Segunda evaluación inmediata: dedup_key idéntica debe ignorarse (0 nuevos eventos insertados)
    const eval2 = await db.query(`SELECT public.evaluar_matching_encuentro_abierto('${encDedup}') AS result;`);
    assert.equal((eval2.rows[0] as any).result.matches_count, 0);

    await asAdmin(async () => {
      const countEvents = await db.query(`
        SELECT COUNT(*) as count FROM public.domain_events_outbox WHERE dedup_key = 'match:${subDedup}:${encDedup}:v1';
      `);
      assert.equal(Number((countEvents.rows[0] as any).count), 1);
    });
  });

  test('12. Integración Outbox -> Inbox (Simulación Worker match.detected.v1)', async () => {
    let event: any;
    let payload: any;

    await asAdmin(async () => {
      const eventRes = await db.query(`
        SELECT * FROM public.domain_events_outbox
        WHERE event_type = 'match.detected.v1' AND status = 'pending'
        LIMIT 1;
      `);
      assert.ok(eventRes.rows.length > 0, 'Debe haber al menos 1 evento pendiente');
      event = eventRes.rows[0];
      payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;

      // Simulación del worker con service_role / postgres: insertar en inbox_notifications vía RPC interna
      const inboxInsert = await db.query(`
        SELECT public.insertar_inbox_notification_seguro(
          p_recipient_user_id := '${payload.recipient_user_id}',
          p_notification_type := 'match_found',
          p_target_type := 'encounter',
          p_target_id := '${payload.encounter_id}',
          p_deep_link := '${payload.deep_link}',
          p_title := '${payload.title}',
          p_body := '${payload.body}',
          p_payload := '${JSON.stringify(payload)}'::jsonb,
          p_dedup_key := '${payload.dedup_key}'
        ) AS result;
      `);

      const insertResult = (inboxInsert.rows[0] as any).result;
      assert.equal(insertResult.ok, true);
      assert.equal(insertResult.inserted, true);

      // Marcar evento outbox como procesado
      await db.query(`SELECT public.completar_domain_event_seguro('${event.id}');`);
    });

    // Verificar que el usuario receptor ve la notificación en su bandeja
    await setAuthContext(payload.recipient_user_id, false);
    const userInbox = await db.query(`
      SELECT public.get_mis_notificaciones_inbox_seguro() AS result;
    `);
    const inboxData = (userInbox.rows[0] as any).result;
    assert.equal(inboxData.ok, true);
    assert.ok(inboxData.data.some((n: any) => n.notification_type === 'match_found' && n.target_id === payload.encounter_id));

    // Reintento de inserción idéntica: idempotencia en inbox
    await asAdmin(async () => {
      const duplicateInboxInsert = await db.query(`
        SELECT public.insertar_inbox_notification_seguro(
          p_recipient_user_id := '${payload.recipient_user_id}',
          p_notification_type := 'match_found',
          p_target_type := 'encounter',
          p_target_id := '${payload.encounter_id}',
          p_deep_link := '${payload.deep_link}',
          p_title := '${payload.title}',
          p_body := '${payload.body}',
          p_payload := '${JSON.stringify(payload)}'::jsonb,
          p_dedup_key := '${payload.dedup_key}'
        ) AS result;
      `);
      assert.equal((duplicateInboxInsert.rows[0] as any).result.inserted, false);
    });
  });

  test('13. abrir_encuentro_seguro emite encounter.opened.v1 y evalúa matching automáticamente', async () => {
    const subGuemesAuto = '12121212-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const encAuto = '13131313-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    await asAdmin(async () => {
      await db.exec(`
        INSERT INTO public.match_alert_subscriptions (
          id, user_id, status, modalidad, locality_id
        ) VALUES (
          '${subGuemesAuto}', '${userA}', 'active', 'presencial', 'guemes'
        ) ON CONFLICT (id) DO NOTHING;

        INSERT INTO public.encuentros (
          id, host_id, titulo, modalidad, locality_id, is_open, estado, max_participants
        ) VALUES (
          '${encAuto}', '${hostUser}', 'Torneo Pádel Apertura', 'presencial', 'guemes', false, 'activo', 4
        );
      `);
    });

    // Host llama a abrir_encuentro_seguro
    await setAuthContext(hostUser, false);
    const openRes = await db.query(`
      SELECT public.abrir_encuentro_seguro(
        p_encuentro_id := '${encAuto}',
        p_host_id := '${hostUser}',
        p_open_description := 'Abierto a todos',
        p_max_participants := 4,
        p_locality_id := 'guemes'
      ) AS result;
    `);
    assert.equal((openRes.rows[0] as any).result.ok, true);

    await asAdmin(async () => {
      // Verificar que se emitió encounter.opened.v1 en el outbox
      const openedEvent = await db.query(`
        SELECT * FROM public.domain_events_outbox
        WHERE event_type = 'encounter.opened.v1' AND aggregate_id = '${encAuto}';
      `);
      assert.equal(openedEvent.rows.length, 1);

      // Verificar que se evaluó matching y se emitió match.detected.v1 para userA
      const matchEvent = await db.query(`
        SELECT * FROM public.domain_events_outbox
        WHERE dedup_key = 'match:${subGuemesAuto}:${encAuto}:v1';
      `);
      assert.equal(matchEvent.rows.length, 1);
    });
  });
});
