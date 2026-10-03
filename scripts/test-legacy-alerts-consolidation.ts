import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { validateDeepLink } from '../src/lib/deepLink';

describe('Consolidación de Alertas Legacy en Inbox (Fase Consolidación)', () => {
  let db: PGlite;

  const hostUser = '10000000-0000-0000-0000-000000000001';
  const userA = '11111111-1111-1111-1111-111111111111'; // Interesado 1
  const userB = '22222222-2222-2222-2222-222222222222'; // Interesado 2
  const userBlocked = '33333333-3333-3333-3333-333333333333'; // Bloqueado bilateral
  const userNoInterest = '44444444-4444-4444-4444-444444444444'; // Sin interés
  const userAnon = '55555555-5555-5555-5555-555555555555';

  let openEncounterId: string;
  let privateEncounterId: string;
  let intentionOpenId: string;
  let intentionPrivateId: string;

  before(async () => {
    db = new PGlite();

    // 1. Roles y funciones base de Postgres simulado
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
        ('${userNoInterest}', 'nointerest@test.com'),
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
        ('caba_palermo', 'Palermo', 'Buenos Aires', 'CABA Norte')
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

      -- Configurar bloqueo bilateral entre hostUser y userBlocked
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id) VALUES
        ('${hostUser}', '${userBlocked}')
      ON CONFLICT DO NOTHING;

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

    // 2. Aplicar migraciones ordenadas
    const migrations = [
      'supabase/migrations/20260929170000_fase_20a_intenciones_core.sql',
      'supabase/migrations/20260929180000_fase_20a_intenciones_conversion.sql',
      'supabase/migrations/20260929190000_fase_20b_discovery_intenciones.sql',
      'supabase/migrations/20260929200000_fase_20b_set_interes_intencion.sql',
      'supabase/migrations/20260929210000_fase_20c1_alertas_caso_c.sql',
      'supabase/migrations/20260930093500_fix_fase_20c1_alertas_open_encounter.sql',
      'supabase/migrations/20261002180000_notifications_inbox_and_outbox_base.sql',
      'supabase/migrations/20261002200000_harden_inbox_rpc_grants.sql',
      'supabase/migrations/20261002210000_fase_2a_match_alert_subscriptions.sql',
      'supabase/migrations/20261003100000_consolidate_legacy_alerts_to_inbox.sql',
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

  // Helper para simular el procesamiento del worker de un evento outbox
  const processWorkerEvent = async (event: any) => {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    if (event.event_type === 'intention.converted_to_encounter.v1') {
      await asAdmin(async () => {
        await db.query(`
          SELECT public.insertar_inbox_notification_seguro(
            '${payload.recipient_user_id}',
            'interes_convertido',
            'encounter',
            '${payload.encounter_id}',
            '${payload.deep_link}',
            '${payload.title}',
            '${payload.body}',
            '${JSON.stringify(payload)}'::jsonb,
            '${payload.dedup_key}'
          );
        `);
      });
    } else if (event.event_type === 'match.detected.v1') {
      await asAdmin(async () => {
        await db.query(`
          SELECT public.insertar_inbox_notification_seguro(
            '${payload.recipient_user_id}',
            'match_found',
            'encounter',
            '${payload.encounter_id}',
            '${payload.deep_link}',
            '${payload.title}',
            '${payload.body}',
            '${JSON.stringify(payload)}'::jsonb,
            '${payload.dedup_key}'
          );
        `);
      });
    }
  };

  test('1. Setup de fixtures: intenciones, intereses y encuentros', async () => {
    // Host crea intención 1
    await setAuthContext(hostUser, false);
    const { rows: intRows1 }: any = await db.query(`
      SELECT public.crear_intencion_segura(
        'Jugar al Pádel Sábado',
        'Busco 3 personas para armar partido en Palermo',
        'Este fin de semana',
        '2026-10-15',
        '2026-10-15',
        'presencial',
        'caba_palermo'
      ) AS res;
    `);
    assert.equal(intRows1[0].res.ok, true);
    intentionOpenId = intRows1[0].res.id;

    // Host crea intención 2 (para el caso diferido a encuentro privado)
    const { rows: intRows2 }: any = await db.query(`
      SELECT public.crear_intencion_segura(
        'Café y Juegos de Mesa',
        'Buscamos gente para tarde de juegos',
        'El domingo por la tarde',
        '2026-10-16',
        '2026-10-16',
        'presencial',
        'caba_palermo'
      ) AS res;
    `);
    assert.equal(intRows2[0].res.ok, true);
    intentionPrivateId = intRows2[0].res.id;

    // User A marca interés en ambas
    await setAuthContext(userA, false);
    await db.query(`SELECT public.set_interes_intencion('${intentionOpenId}', true);`);
    await db.query(`SELECT public.set_interes_intencion('${intentionPrivateId}', true);`);

    // User B marca interés en ambas
    await setAuthContext(userB, false);
    await db.query(`SELECT public.set_interes_intencion('${intentionOpenId}', true);`);
    await db.query(`SELECT public.set_interes_intencion('${intentionPrivateId}', true);`);

    // User Blocked marca interés en intención 1
    await setAuthContext(userBlocked, false);
    await db.query(`SELECT public.set_interes_intencion('${intentionOpenId}', true);`);

    // Host crea encuentro abierto 1 (is_open = true)
    await asAdmin(async () => {
      const { rows: encRows1 }: any = await db.query(`
        INSERT INTO public.encuentros (
          host_id, titulo, descripcion, fecha, hora, modalidad, locality_id, is_open, max_participants
        ) VALUES (
          '${hostUser}', 'Pádel Abierto Palermo', 'Torneo relámpago', '2026-10-15', '18:00', 'presencial', 'caba_palermo', true, 4
        ) RETURNING id;
      `);
      openEncounterId = encRows1[0].id;

      // Host crea encuentro privado 2 (is_open = false)
      const { rows: encRows2 }: any = await db.query(`
        INSERT INTO public.encuentros (
          host_id, titulo, descripcion, fecha, hora, modalidad, locality_id, is_open, max_participants
        ) VALUES (
          '${hostUser}', 'Café & Juegos Privado', 'Reunión privada de prueba', '2026-10-16', '16:00', 'presencial', 'caba_palermo', false, 4
        ) RETURNING id;
      `);
      privateEncounterId = encRows2[0].id;
    });

    assert.ok(openEncounterId);
    assert.ok(privateEncounterId);
  });

  test('2. Conversión con encuentro ya abierto → genera evento Outbox moderno para interesados', async () => {
    await setAuthContext(hostUser, false);
    const { rows: convRes }: any = await db.query(`
      SELECT public.convertir_intencion_a_encuentro('${intentionOpenId}', '${openEncounterId}') AS res;
    `);
    assert.equal(convRes[0].res.ok, true);
    assert.equal(convRes[0].res.estado, 'convertida');

    // Comprobar que NO se insertó en tabla legacy alertas_compatibilidad
    await asAdmin(async () => {
      const legacyCount = await db.query(`
        SELECT count(*) as count FROM public.alertas_compatibilidad
        WHERE source_intencion_id = '${intentionOpenId}';
      `);
      assert.equal(parseInt((legacyCount.rows[0] as any).count, 10), 0, 'No deben generarse filas en alertas_compatibilidad');

      // Comprobar que se insertaron exactamente 2 eventos en domain_events_outbox (User A y User B)
      const outboxEvents = await db.query(`
        SELECT * FROM public.domain_events_outbox
        WHERE event_type = 'intention.converted_to_encounter.v1'
          AND aggregate_id = '${openEncounterId}'
        ORDER BY created_at ASC;
      `);
      assert.equal(outboxEvents.rows.length, 2, 'Deben existir exactamente 2 eventos outbox');

      const recipients = outboxEvents.rows.map((r: any) => {
        const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        return payload.recipient_user_id;
      });
      assert.ok(recipients.includes(userA), 'User A debe ser destinatario');
      assert.ok(recipients.includes(userB), 'User B debe ser destinatario');
      assert.ok(!recipients.includes(hostUser), 'Host no debe recibir notificación');
      assert.ok(!recipients.includes(userBlocked), 'Usuario bloqueado bilateralmente no debe recibir notificación');
      assert.ok(!recipients.includes(userNoInterest), 'Usuario sin interés no debe recibir notificación');

      // Simular worker: procesa eventos a inbox_notifications
      for (const ev of outboxEvents.rows) {
        await processWorkerEvent(ev);
      }

      // Validar inbox_notifications
      const inboxRowsA = await db.query(`
        SELECT * FROM public.inbox_notifications
        WHERE recipient_user_id = '${userA}' AND notification_type = 'interes_convertido';
      `);
      assert.equal(inboxRowsA.rows.length, 1);
      assert.equal(inboxRowsA.rows[0].deep_link, `/?open_encounter=${openEncounterId}`);
      assert.ok(validateDeepLink(inboxRowsA.rows[0].deep_link));
      assert.equal(inboxRowsA.rows[0].read_at, null);

      const inboxRowsB = await db.query(`
        SELECT * FROM public.inbox_notifications
        WHERE recipient_user_id = '${userB}' AND notification_type = 'interes_convertido';
      `);
      assert.equal(inboxRowsB.rows.length, 1);
    });
  });

  test('3. Conversión a encuentro privado (is_open = false) → NO notifica prematuramente', async () => {
    await setAuthContext(hostUser, false);
    const { rows: convRes }: any = await db.query(`
      SELECT public.convertir_intencion_a_encuentro('${intentionPrivateId}', '${privateEncounterId}') AS res;
    `);
    assert.equal(convRes[0].res.ok, true);
    assert.equal(convRes[0].res.estado, 'convertida');

    await asAdmin(async () => {
      // 0 eventos outbox para este encuentro privado
      const outboxRows = await db.query(`
        SELECT count(*) as count FROM public.domain_events_outbox
        WHERE event_type = 'intention.converted_to_encounter.v1'
          AND aggregate_id = '${privateEncounterId}';
      `);
      assert.equal(parseInt((outboxRows.rows[0] as any).count, 10), 0, 'No debe emitir eventos si el encuentro es privado');
    });
  });

  test('4. Posterior apertura del encuentro privado vía abrir_encuentro_seguro → emite exactamente una notificación por interesado', async () => {
    await setAuthContext(hostUser, false);
    const { rows: openRes }: any = await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${privateEncounterId}',
        '${hostUser}',
        'Abierto ahora a toda la comunidad',
        4,
        'caba_palermo',
        'Palermo Soho'
      ) AS res;
    `);
    assert.equal(openRes[0].res.ok, true);
    assert.equal(openRes[0].res.is_open, true);

    await asAdmin(async () => {
      // Se emitieron los eventos outbox para la intención convertida previamente
      const outboxEvents = await db.query(`
        SELECT * FROM public.domain_events_outbox
        WHERE event_type = 'intention.converted_to_encounter.v1'
          AND aggregate_id = '${privateEncounterId}';
      `);
      assert.equal(outboxEvents.rows.length, 2, 'Deben emitirse exactamente 2 eventos al abrir el encuentro');

      for (const ev of outboxEvents.rows) {
        await processWorkerEvent(ev);
      }

      const inboxRowsA = await db.query(`
        SELECT * FROM public.inbox_notifications
        WHERE recipient_user_id = '${userA}' AND target_id = '${privateEncounterId}';
      `);
      assert.equal(inboxRowsA.rows.length, 1);
      assert.equal(inboxRowsA.rows[0].deep_link, `/?open_encounter=${privateEncounterId}`);
    });
  });

  test('5. Retry / repetición de apertura → idempotencia estricta sin duplicados', async () => {
    await setAuthContext(hostUser, false);
    // Invocación repetida sobre el encuentro ya abierto
    const { rows: reopenRes }: any = await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${privateEncounterId}',
        '${hostUser}',
        'Abierto ahora a toda la comunidad (actualizado)',
        6,
        'caba_palermo',
        'Palermo Soho'
      ) AS res;
    `);
    assert.equal(reopenRes[0].res.ok, true);

    await asAdmin(async () => {
      const outboxEvents = await db.query(`
        SELECT count(*) as count FROM public.domain_events_outbox
        WHERE event_type = 'intention.converted_to_encounter.v1'
          AND aggregate_id = '${privateEncounterId}';
      `);
      assert.equal(parseInt((outboxEvents.rows[0] as any).count, 10), 2, 'No se deben generar nuevos eventos outbox');

      const inboxRowsA = await db.query(`
        SELECT count(*) as count FROM public.inbox_notifications
        WHERE recipient_user_id = '${userA}' AND target_id = '${privateEncounterId}';
      `);
      assert.equal(parseInt((inboxRowsA.rows[0] as any).count, 10), 1, 'No debe duplicarse la fila en inbox_notifications');
    });
  });

  test('6. Migración/Backfill de alertas legacy existentes a inbox_notifications', async () => {
    const legacyAlertIdUnread = '90000000-0000-0000-0000-000000000001';
    const legacyAlertIdRead = '90000000-0000-0000-0000-000000000002';

    // Insertar registros en tabla legacy simulando estado pre-consolidación
    await asAdmin(async () => {
      await db.query(`
        INSERT INTO public.alertas_compatibilidad (
          id, user_id, tipo, source_intencion_id, target_encuentro_id, leida, created_at
        ) VALUES
          ('${legacyAlertIdUnread}', '${userA}', 'interes_convertido', '${intentionOpenId}', '${privateEncounterId}', false, now() - INTERVAL '1 day'),
          ('${legacyAlertIdRead}', '${userB}', 'interes_convertido', '${intentionOpenId}', '${privateEncounterId}', true, now() - INTERVAL '2 days')
        ON CONFLICT DO NOTHING;
      `);

      // Ejecutar backfill idempotente
      await db.query(`
        INSERT INTO public.inbox_notifications (
            recipient_user_id,
            notification_type,
            target_type,
            target_id,
            deep_link,
            title,
            body,
            payload,
            read_at,
            dedup_key,
            expires_at,
            created_at
        )
        SELECT
            a.user_id,
            'interes_convertido',
            'encounter',
            a.target_encuentro_id,
            pg_catalog.format('/?open_encounter=%s', a.target_encuentro_id),
            'Intención convertida en encuentro',
            COALESCE('Una intención que te interesaba se convirtió en un encuentro abierto: ' || e.titulo, 'Una intención que te interesaba se convirtió en un encuentro abierto.'),
            pg_catalog.jsonb_build_object(
                'source_intencion_id', a.source_intencion_id,
                'target_encuentro_id', a.target_encuentro_id,
                'legacy_alert_id', a.id
            ),
            CASE WHEN a.leida THEN a.created_at ELSE NULL END,
            pg_catalog.format('intention:%s:encounter:%s', a.source_intencion_id, a.target_encuentro_id),
            a.created_at + INTERVAL '14 days',
            a.created_at
        FROM public.alertas_compatibilidad a
        LEFT JOIN public.encuentros e ON e.id = a.target_encuentro_id
        WHERE a.created_at >= (pg_catalog.clock_timestamp() - INTERVAL '14 days')
        ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;
      `);
    });
  });

  test('7. Preservación de estado leído / no leído tras backfill', async () => {
    const legacyAlertIdUnread = '90000000-0000-0000-0000-000000000001';
    const legacyAlertIdRead = '90000000-0000-0000-0000-000000000002';

    await asAdmin(async () => {
      const backfilledUnread = await db.query(`
        SELECT * FROM public.inbox_notifications
        WHERE recipient_user_id = '${userA}'
          AND payload->>'legacy_alert_id' = '${legacyAlertIdUnread}';
      `);
      assert.equal(backfilledUnread.rows.length, 1);
      assert.equal(backfilledUnread.rows[0].read_at, null, 'Alerta legacy no leída conserva read_at = NULL');

      const backfilledRead = await db.query(`
        SELECT * FROM public.inbox_notifications
        WHERE recipient_user_id = '${userB}'
          AND payload->>'legacy_alert_id' = '${legacyAlertIdRead}';
      `);
      assert.equal(backfilledRead.rows.length, 1);
      assert.notEqual(backfilledRead.rows[0].read_at, null, 'Alerta legacy leída conserva read_at no nulo');
    });
  });

  test('8. Badge y contador: utiliza exclusivamente RPC segura get_contador_notificaciones_no_leidas_seguro', async () => {
    // Para userA
    await setAuthContext(userA, false);
    const { rows: countResA }: any = await db.query(`
      SELECT public.get_contador_notificaciones_no_leidas_seguro() AS res;
    `);
    assert.equal(countResA[0].res.ok, true);
    assert.ok(countResA[0].res.unread_count >= 1, 'User A debe tener notificaciones no leídas');
    const initialUnreadA = countResA[0].res.unread_count;

    // Obtener una notificación no leída de User A
    const { rows: notifRes }: any = await db.query(`
      SELECT public.get_mis_notificaciones_inbox_seguro(1) AS res;
    `);
    assert.equal(notifRes[0].res.ok, true);
    const notifId = notifRes[0].res.data[0].id;

    // Marcar como leída
    const { rows: markRes }: any = await db.query(`
      SELECT public.marcar_notificacion_leida_seguro('${notifId}') AS res;
    `);
    assert.equal(markRes[0].res.ok, true);

    // Contador decrementado
    const { rows: countResA2 }: any = await db.query(`
      SELECT public.get_contador_notificaciones_no_leidas_seguro() AS res;
    `);
    assert.equal(countResA2[0].res.unread_count, initialUnreadA - 1, 'Contador debe decrementarse');
  });

  test('9. Coexistencia sin regresión: match_found continúa funcionando de forma paralela', async () => {
    // Simular un evento match.detected.v1
    const matchEvent = {
      event_type: 'match.detected.v1',
      payload: {
        recipient_user_id: userA,
        encounter_id: openEncounterId,
        encounter_title: 'Pádel Abierto Palermo',
        title: 'Nuevo encuentro compatible',
        body: 'Hay un nuevo encuentro compatible: Pádel Abierto Palermo',
        deep_link: `/?open_encounter=${openEncounterId}`,
        dedup_key: `match:sub123:${openEncounterId}`,
      },
    };

    await processWorkerEvent(matchEvent);

    await setAuthContext(userA, false);
    const { rows: listRes }: any = await db.query(`
      SELECT public.get_mis_notificaciones_inbox_seguro(10) AS res;
    `);
    assert.equal(listRes[0].res.ok, true);
    const items = listRes[0].res.data;

    const hasMatchFound = items.some((item: any) => item.notification_type === 'match_found');
    const hasInteresConvertido = items.some((item: any) => item.notification_type === 'interes_convertido');

    assert.ok(hasMatchFound, 'Debe coexistir notificación match_found');
    assert.ok(hasInteresConvertido, 'Debe coexistir notificación interes_convertido');
  });

  test('10. Ambas notificaciones utilizan deep links canónicos seguros hacia open_encounter', async () => {
    await setAuthContext(userA, false);
    const { rows: listRes }: any = await db.query(`
      SELECT public.get_mis_notificaciones_inbox_seguro(10) AS res;
    `);
    const items = listRes[0].res.data;

    for (const item of items) {
      assert.ok(item.deep_link.startsWith('/?open_encounter='), 'El deep link debe apuntar a /?open_encounter=');
      const safe = validateDeepLink(item.deep_link);
      assert.ok(safe, 'El deep link debe pasar la validación estricta de seguridad');
    }
  });

  test('11. Deduplicación backfill ↔ worker: legacy backfill + posterior evento moderno = una sola inbox notification', async () => {
    const testIntentionId = intentionOpenId;
    const testEncounterId = openEncounterId;
    const testLegacyId = '90000000-0000-0000-0000-000000000003';

    await asAdmin(async () => {
      // 1. Simular alerta legacy previa migrada por backfill
      await db.query(`
        INSERT INTO public.alertas_compatibilidad (
          id, user_id, tipo, source_intencion_id, target_encuentro_id, leida, created_at
        ) VALUES (
          '${testLegacyId}', '${userA}', 'interes_convertido', '${testIntentionId}', '${testEncounterId}', false, now() - INTERVAL '3 days'
        ) ON CONFLICT DO NOTHING;
      `);

      // Ejecutar backfill para esta alerta
      await db.query(`
        INSERT INTO public.inbox_notifications (
          recipient_user_id,
          notification_type,
          target_type,
          target_id,
          deep_link,
          title,
          body,
          payload,
          read_at,
          dedup_key,
          expires_at,
          created_at
        ) VALUES (
          '${userA}',
          'interes_convertido',
          'encounter',
          '${testEncounterId}',
          '/?open_encounter=${testEncounterId}',
          'Intención convertida en encuentro',
          'Una intención que te interesaba se convirtió en un encuentro abierto.',
          jsonb_build_object('source_intencion_id', '${testIntentionId}', 'target_encuentro_id', '${testEncounterId}'),
          NULL,
          'intention:${testIntentionId}:encounter:${testEncounterId}',
          now() + INTERVAL '11 days',
          now() - INTERVAL '3 days'
        ) ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;
      `);

      // 2. Verificar que existe exactamente 1 notificación de este par
      const beforeEvent = await db.query(`
        SELECT count(*) as count FROM public.inbox_notifications
        WHERE recipient_user_id = '${userA}'
          AND dedup_key = 'intention:${testIntentionId}:encounter:${testEncounterId}';
      `);
      assert.equal(parseInt((beforeEvent.rows[0] as any).count, 10), 1);

      // 3. Simular que el worker procesa posteriormente el evento moderno intention.converted_to_encounter.v1
      const modernEvent = {
        event_type: 'intention.converted_to_encounter.v1',
        aggregate_id: testEncounterId,
        dedup_key: `intention_conversion:intention:${testIntentionId}:encounter:${testEncounterId}:user:${userA}`,
        payload: {
          recipient_user_id: userA,
          intencion_id: testIntentionId,
          encounter_id: testEncounterId,
          encounter_title: 'Pádel Abierto Palermo',
          title: 'Intención convertida en encuentro',
          body: 'Una intención que te interesaba se convirtió en un encuentro abierto: Pádel Abierto Palermo',
          deep_link: `/?open_encounter=${testEncounterId}`,
          dedup_key: `intention:${testIntentionId}:encounter:${testEncounterId}`,
        },
      };

      await processWorkerEvent(modernEvent);

      // 4. Verificar que SIGUE habiendo exactamente 1 sola fila en inbox_notifications
      const afterEvent = await db.query(`
        SELECT count(*) as count FROM public.inbox_notifications
        WHERE recipient_user_id = '${userA}'
          AND dedup_key = 'intention:${testIntentionId}:encounter:${testEncounterId}';
      `);
      assert.equal(parseInt((afterEvent.rows[0] as any).count, 10), 1, 'La deduplicación debe evitar registros duplicados');
    });
  });

  test('12. Retención del backfill: alertas legacy > 14 días no se migran al inbox activo y permanecen en histórico', async () => {
    const expiredLegacyId = '90000000-0000-0000-0000-000000000004';
    const oldIntentionId = intentionOpenId;

    await asAdmin(async () => {
      // 1. Insertar alerta de hace 20 días en alertas_compatibilidad
      await db.query(`
        INSERT INTO public.alertas_compatibilidad (
          id, user_id, tipo, source_intencion_id, target_encuentro_id, leida, created_at
        ) VALUES (
          '${expiredLegacyId}', '${userNoInterest}', 'interes_convertido', '${oldIntentionId}', '${openEncounterId}', false, now() - INTERVAL '20 days'
        ) ON CONFLICT DO NOTHING;
      `);

      // 2. Ejecutar la query de migración/backfill que aplica la política de 14 días
      await db.query(`
        INSERT INTO public.inbox_notifications (
            recipient_user_id,
            notification_type,
            target_type,
            target_id,
            deep_link,
            title,
            body,
            payload,
            read_at,
            dedup_key,
            expires_at,
            created_at
        )
        SELECT
            a.user_id,
            'interes_convertido',
            'encounter',
            a.target_encuentro_id,
            pg_catalog.format('/?open_encounter=%s', a.target_encuentro_id),
            'Intención convertida en encuentro',
            COALESCE('Una intención que te interesaba se convirtió en un encuentro abierto: ' || e.titulo, 'Una intención que te interesaba se convirtió en un encuentro abierto.'),
            pg_catalog.jsonb_build_object(
                'source_intencion_id', a.source_intencion_id,
                'target_encuentro_id', a.target_encuentro_id,
                'legacy_alert_id', a.id
            ),
            CASE WHEN a.leida THEN a.created_at ELSE NULL END,
            pg_catalog.format('intention:%s:encounter:%s', a.source_intencion_id, a.target_encuentro_id),
            a.created_at + INTERVAL '14 days',
            a.created_at
        FROM public.alertas_compatibilidad a
        LEFT JOIN public.encuentros e ON e.id = a.target_encuentro_id
        WHERE a.created_at >= (pg_catalog.clock_timestamp() - INTERVAL '14 days')
        ON CONFLICT (recipient_user_id, dedup_key) DO NOTHING;
      `);

      // 3. Verificar que la alerta antigua NO se insertó en inbox_notifications
      const inboxCheck = await db.query(`
        SELECT count(*) as count FROM public.inbox_notifications
        WHERE recipient_user_id = '${userNoInterest}'
          AND payload->>'legacy_alert_id' = '${expiredLegacyId}';
      `);
      assert.equal(parseInt((inboxCheck.rows[0] as any).count, 10), 0, 'Alerta > 14 días no debe migrarse al inbox activo');

      // 4. Verificar que permanece intacta en alertas_compatibilidad como histórico
      const legacyCheck = await db.query(`
        SELECT count(*) as count FROM public.alertas_compatibilidad
        WHERE id = '${expiredLegacyId}';
      `);
      assert.equal(parseInt((legacyCheck.rows[0] as any).count, 10), 1, 'Alerta legacy debe preservarse en tabla original');
    });

    // 5. Verificar que para userNoInterest el inbox no contiene elementos
    await setAuthContext(userNoInterest, false);
    const { rows: inboxRes }: any = await db.query(`
      SELECT public.get_mis_notificaciones_inbox_seguro(10) AS res;
    `);
    assert.equal(inboxRes[0].res.data.length, 0, 'La bandeja activa moderna debe estar limpia');
  });
});
