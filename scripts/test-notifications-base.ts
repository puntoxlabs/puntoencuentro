import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 1: Infraestructura Base de Notificaciones e Inbox (Tests Nivel A - PGlite)', () => {
  let db: PGlite;
  const userA = '11111111-1111-1111-1111-111111111111';
  const userB = '22222222-2222-2222-2222-222222222222';
  const userAnon = '33333333-3333-3333-3333-333333333333';

  before(async () => {
    db = new PGlite();

    // 1. Configuración de entorno Supabase simulado en PGlite
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

      INSERT INTO auth.users (id, email) VALUES
        ('${userA}', 'userA@test.com'),
        ('${userB}', 'userB@test.com'),
        ('${userAnon}', 'anon@test.com')
      ON CONFLICT DO NOTHING;
    `);

    // 2. Ejecutar la migración bajo prueba
    const migPath = path.resolve(
      process.cwd(),
      'supabase/migrations/20261002180000_notifications_inbox_and_outbox_base.sql'
    );
    await db.exec(fs.readFileSync(migPath, 'utf-8'));
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

  const setServiceRole = async () => {
    await db.query(`SET ROLE service_role;`);
  };

  // ============================================================
  // BLOQUE 1: DOMAIN EVENTS OUTBOX
  // ============================================================

  test('Outbox 1: Inserción de evento con valores default y estado pending', async () => {
    await setServiceRole();
    const aggregateId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const res = await db.query(`
      INSERT INTO public.domain_events_outbox (
        event_type, aggregate_type, aggregate_id, actor_user_id, dedup_key, payload
      ) VALUES (
        'encounter.opened.v1', 'encounter', '${aggregateId}', '${userA}', 'encounter:${aggregateId}:opened', '{"titulo":"Pádel"}'::jsonb
      ) RETURNING id, status, attempt_count, max_attempts, event_version;
    `);

    assert.equal(res.rows.length, 1);
    const row = res.rows[0] as any;
    assert.equal(row.status, 'pending');
    assert.equal(row.attempt_count, 0);
    assert.equal(row.max_attempts, 3);
    assert.equal(row.event_version, 1);
  });

  test('Outbox 2: Deduplicación por dedup_key rechaza inserción duplicada', async () => {
    await setServiceRole();
    const aggregateId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await assert.rejects(
      async () => {
        await db.query(`
          INSERT INTO public.domain_events_outbox (
            event_type, aggregate_type, aggregate_id, actor_user_id, dedup_key
          ) VALUES (
            'encounter.opened.v1', 'encounter', '${aggregateId}', '${userA}', 'encounter:${aggregateId}:opened'
          );
        `);
      },
      /uq_domain_events_dedup/
    );
  });

  test('Outbox 3: Constraint de estado rechaza estados no permitidos', async () => {
    await setServiceRole();
    await assert.rejects(
      async () => {
        await db.query(`
          INSERT INTO public.domain_events_outbox (
            event_type, aggregate_type, aggregate_id, dedup_key, status
          ) VALUES (
            'encounter.opened.v1', 'encounter', gen_random_uuid(), 'dedup:invalid_status', 'in_progress'
          );
        `);
      },
      /domain_events_outbox_status_check/
    );
  });

  test('Outbox 4: claim_domain_events_seguro reclama atómicamente eventos pendientes y actualiza a processing', async () => {
    await setServiceRole();
    const res = await db.query(`
      SELECT public.claim_domain_events_seguro(5, 'test-worker') AS result;
    `);
    const result = (res.rows[0] as any).result;
    assert.equal(result.ok, true);
    assert.ok(result.count >= 1);

    const claimedEvent = result.events[0];
    assert.equal(claimedEvent.event_type, 'encounter.opened.v1');
    assert.equal(claimedEvent.attempt_count, 1);

    // Verificar en BD que el estado cambió a processing
    const check = await db.query(`
      SELECT status, attempt_count, processing_started_at
      FROM public.domain_events_outbox WHERE id = '${claimedEvent.id}';
    `);
    const row = check.rows[0] as any;
    assert.equal(row.status, 'processing');
    assert.equal(row.attempt_count, 1);
    assert.ok(row.processing_started_at !== null);
  });

  test('Outbox 5: fallar_domain_event_seguro con retryable aplica backoff exponencial y regresa a pending', async () => {
    await setServiceRole();
    // Obtener el evento actualmente en processing
    const ev = await db.query(`
      SELECT id, attempt_count FROM public.domain_events_outbox WHERE status = 'processing' LIMIT 1;
    `);
    const eventId = (ev.rows[0] as any).id;

    const res = await db.query(`
      SELECT public.fallar_domain_event_seguro('${eventId}', 'Error temporal de red', true) AS result;
    `);
    const result = (res.rows[0] as any).result;
    assert.equal(result.ok, true);
    assert.equal(result.status, 'pending');

    // Comprobar que en BD tiene available_at posterior y last_error sanitizado
    const check = await db.query(`
      SELECT status, available_at, last_error FROM public.domain_events_outbox WHERE id = '${eventId}';
    `);
    const row = check.rows[0] as any;
    assert.equal(row.status, 'pending');
    assert.equal(row.last_error, 'Error temporal de red');
    assert.ok(new Date(row.available_at).getTime() > Date.now());
  });

  test('Outbox 6: fallar_domain_event_seguro con is_retryable=false marca inmediatamente como failed', async () => {
    await setServiceRole();
    const insertRes = await db.query(`
      INSERT INTO public.domain_events_outbox (
        event_type, aggregate_type, aggregate_id, dedup_key, status
      ) VALUES (
        'unknown.unsupported.v1', 'test', gen_random_uuid(), 'dedup:unsupported', 'pending'
      ) RETURNING id;
    `);
    const eventId = (insertRes.rows[0] as any).id;

    const res = await db.query(`
      SELECT public.fallar_domain_event_seguro('${eventId}', 'Tipo no soportado', false) AS result;
    `);
    const result = (res.rows[0] as any).result;
    assert.equal(result.ok, true);
    assert.equal(result.status, 'failed');

    const check = await db.query(`
      SELECT status, last_error FROM public.domain_events_outbox WHERE id = '${eventId}';
    `);
    assert.equal((check.rows[0] as any).status, 'failed');
    assert.equal((check.rows[0] as any).last_error, 'Tipo no soportado');
  });

  test('Outbox 7: completar_domain_event_seguro marca exitosamente como processed', async () => {
    await setServiceRole();
    const insertRes = await db.query(`
      INSERT INTO public.domain_events_outbox (
        event_type, aggregate_type, aggregate_id, dedup_key, status
      ) VALUES (
        'encounter.updated.v1', 'encounter', gen_random_uuid(), 'dedup:success_test', 'processing'
      ) RETURNING id;
    `);
    const eventId = (insertRes.rows[0] as any).id;

    const res = await db.query(`
      SELECT public.completar_domain_event_seguro('${eventId}') AS result;
    `);
    const result = (res.rows[0] as any).result;
    assert.equal(result.ok, true);

    const check = await db.query(`
      SELECT status, processed_at, last_error FROM public.domain_events_outbox WHERE id = '${eventId}';
    `);
    const row = check.rows[0] as any;
    assert.equal(row.status, 'processed');
    assert.ok(row.processed_at !== null);
    assert.equal(row.last_error, null);
  });

  test('Outbox 8: reconciliar_domain_events_seguro recupera eventos en processing colgados', async () => {
    await setServiceRole();
    // Insertar un evento con processing_started_at de hace 10 minutos
    await db.query(`
      INSERT INTO public.domain_events_outbox (
        event_type, aggregate_type, aggregate_id, dedup_key, status, processing_started_at
      ) VALUES (
        'encounter.opened.v1', 'encounter', gen_random_uuid(), 'dedup:stuck_worker', 'processing',
        timezone('utc', now()) - INTERVAL '10 minutes'
      );
    `);

    const res = await db.query(`
      SELECT public.reconciliar_domain_events_seguro() AS result;
    `);
    const result = (res.rows[0] as any).result;
    assert.equal(result.ok, true);
    assert.ok(result.recovered_events_count >= 1);

    const check = await db.query(`
      SELECT status, last_error FROM public.domain_events_outbox WHERE dedup_key = 'dedup:stuck_worker';
    `);
    const row = check.rows[0] as any;
    assert.equal(row.status, 'pending');
    assert.equal(row.last_error, 'Recovered from abandoned worker');
  });

  // ============================================================
  // BLOQUE 2: INBOX NOTIFICATIONS & IDEMPOTENCIA
  // ============================================================

  test('Inbox 1: insertar_inbox_notification_seguro crea registro con valores correctos', async () => {
    await setServiceRole();
    const encounterId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const res = await db.query(`
      SELECT public.insertar_inbox_notification_seguro(
        '${userA}',
        'match_found',
        'encounter',
        '${encounterId}',
        '/meet/${encounterId}',
        '🎾 Nuevo Pádel en Güemes',
        'Hay un nuevo encuentro que coincide con tu alerta.',
        '{"encounterTitle":"Pádel"}'::jsonb,
        'match:alert1:${encounterId}',
        timezone('utc', now()) + INTERVAL '7 days'
      ) AS result;
    `);

    const result = (res.rows[0] as any).result;
    assert.equal(result.ok, true);
    assert.equal(result.inserted, true);
    assert.ok(result.notification_id !== null);
  });

  test('Inbox 2: Idempotencia - inserción duplicada con mismo recipient y dedup_key se ignora (ON CONFLICT DO NOTHING)', async () => {
    await setServiceRole();
    const encounterId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const res = await db.query(`
      SELECT public.insertar_inbox_notification_seguro(
        '${userA}',
        'match_found',
        'encounter',
        '${encounterId}',
        '/meet/${encounterId}',
        '🎾 Nuevo Pádel en Güemes',
        'Hay un nuevo encuentro que coincide con tu alerta.',
        '{"encounterTitle":"Pádel"}'::jsonb,
        'match:alert1:${encounterId}',
        timezone('utc', now()) + INTERVAL '7 days'
      ) AS result;
    `);

    const result = (res.rows[0] as any).result;
    assert.equal(result.ok, true);
    assert.equal(result.inserted, false); // No insertó porque ya existía

    // Verificar que solo existe exactamente 1 registro en la tabla
    const countRes = await db.query(`
      SELECT COUNT(*) AS c FROM public.inbox_notifications
      WHERE recipient_user_id = '${userA}' AND dedup_key = 'match:alert1:${encounterId}';
    `);
    assert.equal((countRes.rows[0] as any).c, 1);
  });

  test('Inbox 3: Escenario de fallo de worker antes de cerrar outbox (Idempotencia End-to-End)', async () => {
    await setServiceRole();
    const encounterId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const dedupKeyOutbox = 'outbox:crash_test';
    const dedupKeyInbox = `match:alert2:${encounterId}`;

    // Paso A: Se crea el evento en outbox
    const evRes = await db.query(`
      INSERT INTO public.domain_events_outbox (
        event_type, aggregate_type, aggregate_id, dedup_key, status
      ) VALUES (
        'match.detected.v1', 'encounter', '${encounterId}', '${dedupKeyOutbox}', 'pending'
      ) RETURNING id;
    `);
    const eventId = (evRes.rows[0] as any).id;

    // Paso B: Worker 1 reclama el evento e inserta la notificación en inbox
    await db.query(`
      SELECT public.insertar_inbox_notification_seguro(
        '${userA}', 'match_found', 'encounter', '${encounterId}', '/meet/${encounterId}',
        'Título Test', 'Cuerpo Test', '{}'::jsonb, '${dedupKeyInbox}', timezone('utc', now()) + INTERVAL '1 day'
      );
    `);

    // Worker 1 "cae" antes de llamar a completar_domain_event_seguro (el evento queda en pending o processing).
    // Paso C: Worker 2 reintenta procesar el mismo evento y vuelve a llamar a insertar_inbox_notification_seguro
    const retryInsert = await db.query(`
      SELECT public.insertar_inbox_notification_seguro(
        '${userA}', 'match_found', 'encounter', '${encounterId}', '/meet/${encounterId}',
        'Título Test', 'Cuerpo Test', '{}'::jsonb, '${dedupKeyInbox}', timezone('utc', now()) + INTERVAL '1 day'
      ) AS result;
    `);
    assert.equal((retryInsert.rows[0] as any).result.inserted, false);

    // Paso D: Worker 2 completa exitosamente el evento
    const completeRes = await db.query(`
      SELECT public.completar_domain_event_seguro('${eventId}') AS result;
    `);
    assert.equal((completeRes.rows[0] as any).result.ok, true);

    // Verificación: Solo existe 1 notificación creada para el usuario A
    const finalCount = await db.query(`
      SELECT COUNT(*) AS c FROM public.inbox_notifications WHERE dedup_key = '${dedupKeyInbox}';
    `);
    assert.equal((finalCount.rows[0] as any).c, 1);
  });

  // ============================================================
  // BLOQUE 3: RPCS PÚBLICAS Y SEGURIDAD RLS
  // ============================================================

  test('RPC 1: get_contador_notificaciones_no_leidas_seguro calcula correctamente para el usuario llamador', async () => {
    // Usuario A tiene notificaciones no leídas
    await setAuthContext(userA);
    const resA = await db.query(`
      SELECT public.get_contador_notificaciones_no_leidas_seguro() AS result;
    `);
    const resultA = (resA.rows[0] as any).result;
    assert.equal(resultA.ok, true);
    assert.ok(resultA.unread_count >= 2);

    // Usuario B no tiene notificaciones
    await setAuthContext(userB);
    const resB = await db.query(`
      SELECT public.get_contador_notificaciones_no_leidas_seguro() AS result;
    `);
    const resultB = (resB.rows[0] as any).result;
    assert.equal(resultB.ok, true);
    assert.equal(resultB.unread_count, 0);
  });

  test('RPC 2: marcar_notificacion_leida_seguro marca como leída y actualiza contador', async () => {
    await setAuthContext(userA);

    // Obtener una notificación de userA
    const notifRes = await db.query(`
      SELECT id FROM public.inbox_notifications WHERE recipient_user_id = '${userA}' AND read_at IS NULL LIMIT 1;
    `);
    const notifId = (notifRes.rows[0] as any).id;

    // Marcar como leída
    const markRes = await db.query(`
      SELECT public.marcar_notificacion_leida_seguro('${notifId}') AS result;
    `);
    const markResult = (markRes.rows[0] as any).result;
    assert.equal(markResult.ok, true);
    assert.equal(markResult.notification_id, notifId);
    assert.ok(markResult.read_at !== null);

    // Llamada idempotente repetida no falla
    const markRes2 = await db.query(`
      SELECT public.marcar_notificacion_leida_seguro('${notifId}') AS result;
    `);
    assert.equal((markRes2.rows[0] as any).result.ok, true);
  });

  test('RPC 3: Seguridad - usuario B no puede marcar notificación de usuario A', async () => {
    await setServiceRole();
    const notifRes = await db.query(`
      SELECT id FROM public.inbox_notifications WHERE recipient_user_id = '${userA}' LIMIT 1;
    `);
    const notifIdA = (notifRes.rows[0] as any).id;

    // Cambiar a usuario B
    await setAuthContext(userB);
    const markRes = await db.query(`
      SELECT public.marcar_notificacion_leida_seguro('${notifIdA}') AS result;
    `);
    const markResult = (markRes.rows[0] as any).result;
    assert.equal(markResult.ok, false);
    assert.equal(markResult.error, 'unauthorized');
  });

  test('RPC 4: marcar_todas_notificaciones_leidas_seguro actualiza únicamente notificaciones propias', async () => {
    // Insertar una notificación para usuario B
    await setServiceRole();
    await db.query(`
      SELECT public.insertar_inbox_notification_seguro(
        '${userB}', 'internal_invitation', 'encounter', gen_random_uuid(), '/meet/123',
        'Invitación B', 'Cuerpo B', '{}'::jsonb, 'invite:userB:1'
      );
    `);

    // Usuario A marca todas como leídas
    await setAuthContext(userA);
    const resA = await db.query(`
      SELECT public.marcar_todas_notificaciones_leidas_seguro() AS result;
    `);
    const resultA = (resA.rows[0] as any).result;
    assert.equal(resultA.ok, true);
    assert.ok(resultA.updated_count >= 1);

    // Verificar que contador de A es ahora 0
    const countA = await db.query(`
      SELECT public.get_contador_notificaciones_no_leidas_seguro() AS result;
    `);
    assert.equal((countA.rows[0] as any).result.unread_count, 0);

    // Verificar que la notificación de B sigue sin leerse
    await setAuthContext(userB);
    const countB = await db.query(`
      SELECT public.get_contador_notificaciones_no_leidas_seguro() AS result;
    `);
    assert.equal((countB.rows[0] as any).result.unread_count, 1);
  });

  test('RPC 5: get_mis_notificaciones_inbox_seguro con paginación cursor y exclusión de expiradas', async () => {
    await setServiceRole();
    // Insertar una notificación ya expirada
    await db.query(`
      SELECT public.insertar_inbox_notification_seguro(
        '${userA}', 'match_found', 'encounter', gen_random_uuid(), '/meet/old',
        'Notificación Antigua', 'Cuerpo', '{}'::jsonb, 'dedup:expired_notif',
        timezone('utc', now()) - INTERVAL '1 day'
      );
    `);

    // Insertar varias notificaciones activas para userA
    for (let i = 1; i <= 5; i++) {
      await db.query(`
        SELECT public.insertar_inbox_notification_seguro(
          '${userA}', 'match_found', 'encounter', gen_random_uuid(), '/meet/${i}',
          'Notificación Activa ${i}', 'Cuerpo ${i}', '{}'::jsonb, 'dedup:active_${i}',
          timezone('utc', now()) + INTERVAL '3 days'
        );
      `);
    }

    await setAuthContext(userA);

    // Página 1 con límite 3
    const p1Res = await db.query(`
      SELECT public.get_mis_notificaciones_inbox_seguro(3, NULL, NULL) AS result;
    `);
    const p1 = (p1Res.rows[0] as any).result;
    assert.equal(p1.ok, true);
    assert.equal(p1.data.length, 3);
    assert.equal(p1.has_more, true);
    assert.ok(p1.next_cursor !== null);

    // Página 2 usando cursor
    const p2Res = await db.query(`
      SELECT public.get_mis_notificaciones_inbox_seguro(3, '${p1.next_cursor.created_at}', '${p1.next_cursor.id}') AS result;
    `);
    const p2 = (p2Res.rows[0] as any).result;
    assert.equal(p2.ok, true);
    assert.ok(p2.data.length >= 1);

    // Asegurar que ninguna notificación devuelta sea la expirada
    const allTitles = [...p1.data, ...p2.data].map((n: any) => n.title);
    assert.ok(!allTitles.includes('Notificación Antigua'));
  });

  test('RPC 6: Rechazo estricto de usuarios anónimos y sin sesión', async () => {
    // 1. Sin sesión (anon role)
    await setAuthContext(null);
    const unauthRes = await db.query(`
      SELECT public.get_mis_notificaciones_inbox_seguro() AS result;
    `);
    assert.equal((unauthRes.rows[0] as any).result.ok, false);
    assert.equal((unauthRes.rows[0] as any).result.error, 'authentication_required');

    // 2. Usuario anónimo de Supabase (is_anonymous = true)
    await setAuthContext(userAnon, true);
    const anonRes = await db.query(`
      SELECT public.get_mis_notificaciones_inbox_seguro() AS result;
    `);
    assert.equal((anonRes.rows[0] as any).result.ok, false);
    assert.equal((anonRes.rows[0] as any).result.error, 'permanent_account_required');
  });

  test('RLS 7: Aislamiento estricto en tabla inbox_notifications', async () => {
    // Usuario A autenticado ejecuta SELECT directo sobre la tabla
    await setAuthContext(userA);
    const selectA = await db.query(`
      SELECT id, recipient_user_id FROM public.inbox_notifications;
    `);
    // Todas las filas devueltas deben pertenecer exclusivamente a userA
    for (const row of selectA.rows as any[]) {
      assert.equal(row.recipient_user_id, userA);
    }

    // Usuario B no ve ninguna de las filas de userA
    await setAuthContext(userB);
    const selectB = await db.query(`
      SELECT id, recipient_user_id FROM public.inbox_notifications;
    `);
    for (const row of selectB.rows as any[]) {
      assert.equal(row.recipient_user_id, userB);
    }
  });

  test('Seguridad 8: domain_events_outbox es inaccesible para usuarios autenticados', async () => {
    await setAuthContext(userA);
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.domain_events_outbox;`);
      },
      /permission denied/
    );
  });
});
