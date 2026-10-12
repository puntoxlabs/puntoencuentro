import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 20D: Matching Mis Ganas + Activity Relevance (27 Casos Obligatorios)', () => {
  let db: PGlite;

  const userHost = '10000000-0000-0000-0000-000000000001';
  const userA = '11111111-1111-1111-1111-111111111111';
  const userB = '22222222-2222-2222-2222-222222222222';
  const userBlocked = '33333333-3333-3333-3333-333333333333';
  const userAnon = '44444444-4444-4444-4444-444444444444';

  before(async () => {
    db = new PGlite();

    // 1. Setup Supabase mock environment
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
        ('${userHost}', 'host@test.com'),
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

      -- Base encuentros
      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL,
        open_title TEXT,
        descripcion TEXT,
        open_description TEXT,
        open_public_zone TEXT,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        locality_id TEXT REFERENCES public.localidades(id),
        fecha DATE,
        hora TIME,
        is_open BOOLEAN NOT NULL DEFAULT true,
        estado TEXT NOT NULL DEFAULT 'activo',
        moderation_status TEXT NOT NULL DEFAULT 'approved',
        opened_at TIMESTAMPTZ DEFAULT now(),
        closed_at TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );
      GRANT ALL ON TABLE public.encuentros TO authenticated, anon, service_role;
    `);

    // 2. Cargar migraciones base requeridas
    const baseMigrations = [
      'supabase/migrations/20260929170000_fase_20a_intenciones_core.sql',
      'supabase/migrations/20261002180000_notifications_inbox_and_outbox_base.sql',
      'supabase/migrations/20261002200000_harden_inbox_rpc_grants.sql',
      'supabase/migrations/20261002210000_fase_2a_match_alert_subscriptions.sql',
    ];

    for (const mig of baseMigrations) {
      const sql = fs.readFileSync(path.join(process.cwd(), mig), 'utf8');
      await db.exec(sql);
    }

    // 3. Cargar las migraciones de Taxonomía y Matching de Mis Ganas
    const targetMigrations = [
      'supabase/migrations/20261012010000_fase_20d_matching_mis_ganas_activity_relevance.sql',
      'supabase/migrations/20261012010500_fix_activity_relevance_coalesce.sql',
      'supabase/migrations/20261012011000_fix_activity_relevance_trim.sql',
    ];

    for (const mig of targetMigrations) {
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

  const resetAuthContext = async () => {
    await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
    await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
    await db.query(`SET ROLE postgres;`);
  };

  beforeEach(async () => {
    await resetAuthContext();
    await db.exec(`
      DELETE FROM public.match_discoveries;
      DELETE FROM public.domain_events_outbox;
      DELETE FROM public.inbox_notifications;
      DELETE FROM public.match_alert_subscriptions;
      DELETE FROM public.intenciones;
      DELETE FROM public.encuentros;
      DELETE FROM public.bloqueos_usuario;
    `);
  });

  // ============================================================
  // CASO 1: padel ↔ padel => MATCH
  // ============================================================
  test('Caso 1: padel ↔ padel => MATCH', async () => {
    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, descripcion, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel', 'Jugamos en pareja', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);
    const encounterId = encRes.rows[0].id;

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { ok: boolean; matches_found_count: number; matched_encounter_ids: string[] } }>(`
      SELECT public.crear_intencion_segura(
        'Jugar al pádel',
        'Busco partido en Güemes',
        'este finde',
        NULL,
        NULL,
        'presencial',
        'guemes'
      ) AS crear_intencion_segura;
    `);

    const result = res.rows[0].crear_intencion_segura;
    assert.equal(result.ok, true);
    assert.equal(result.matches_found_count, 1);
    assert.equal(result.matched_encounter_ids.length, 1);
    assert.equal(result.matched_encounter_ids[0], encounterId);

    // Verificar match_discoveries (requiere rol de sistema/postgres)
    await resetAuthContext();
    const disco = await db.query(`
      SELECT * FROM public.match_discoveries WHERE user_id = '${userA}' AND encounter_id = '${encounterId}';
    `);
    assert.equal(disco.rows.length, 1);
    assert.equal(disco.rows[0].activity_canonical, 'padel');
    assert.equal(disco.rows[0].primary_source, 'intention');

    // Verificar outbox
    const outbox = await db.query(`
      SELECT * FROM public.domain_events_outbox WHERE dedup_key = 'match:${userA}:${encounterId}:v1';
    `);
    assert.equal(outbox.rows.length, 1);
    assert.equal(outbox.rows[0].event_type, 'match.detected.v1');
  });

  // ============================================================
  // CASO 2: padel ↔ cafe => NO MATCH
  // ============================================================
  test('Caso 2: padel ↔ cafe => NO MATCH', async () => {
    await setAuthContext(userHost);
    await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, descripcion, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Tomar un café', 'En cafetería linda', 'presencial', 'guemes', true, 'activo', 'approved');
    `);

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { ok: boolean; matches_found_count: number } }>(`
      SELECT public.crear_intencion_segura('Jugar al pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 0);
    await resetAuthContext();
    const disco = await db.query(`SELECT count(*) as cnt FROM public.match_discoveries;`);
    assert.equal(Number(disco.rows[0].cnt), 0);
  });

  // ============================================================
  // CASO 3: yoga ↔ idiomas por 'clase' => NO MATCH
  // ============================================================
  test('Caso 3: yoga ↔ idiomas por "clase" => NO MATCH', async () => {
    await setAuthContext(userHost);
    await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Clase de conversación en inglés', 'presencial', 'guemes', true, 'activo', 'approved');
    `);

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { ok: boolean; matches_found_count: number } }>(`
      SELECT public.crear_intencion_segura('Clase de yoga por la mañana', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 0);
  });

  // ============================================================
  // CASO 4: caminar/charlar ↔ cafe/charlar => NO MATCH
  // ============================================================
  test('Caso 4: caminar/charlar ↔ cafe/charlar => NO MATCH', async () => {
    await setAuthContext(userHost);
    await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Tomar un café y charlar', 'presencial', 'guemes', true, 'activo', 'approved');
    `);

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { ok: boolean; matches_found_count: number } }>(`
      SELECT public.crear_intencion_segura('Salir a caminar y charlar', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 0);
  });

  // ============================================================
  // CASO 5: ceramica ↔ ceramica => MATCH
  // ============================================================
  test('Caso 5: ceramica ↔ ceramica => MATCH', async () => {
    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Hacer cerámica juntos', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { ok: boolean; matches_found_count: number; matched_encounter_ids: string[] } }>(`
      SELECT public.crear_intencion_segura('Taller de cerámica', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 1);
    assert.equal(res.rows[0].crear_intencion_segura.matched_encounter_ids[0], encRes.rows[0].id);
  });

  // ============================================================
  // CASO 6: caminata ↔ senderismo => NO MATCH V1
  // ============================================================
  test('Caso 6: caminata ↔ senderismo => NO MATCH V1 (identidad escalar estricta)', async () => {
    await setAuthContext(userHost);
    await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Senderismo en la sierra', 'presencial', 'guemes', true, 'activo', 'approved');
    `);

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { ok: boolean; matches_found_count: number } }>(`
      SELECT public.crear_intencion_segura('Salir a caminar por la costa', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 0);
  });

  // ============================================================
  // CASO 7: genérica ('Hacer algo') => no eligible
  // ============================================================
  test('Caso 7: genérica ("Hacer algo") => no eligible', async () => {
    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { ok: boolean; id: string } }>(`
      SELECT public.crear_intencion_segura('Hacer algo divertido el sábado', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    const intId = res.rows[0].crear_intencion_segura.id;
    const row = await db.query(`
      SELECT activity_canonical, activity_matching_eligible, match_ineligible_reason FROM public.intenciones WHERE id = '${intId}';
    `);

    assert.equal(row.rows[0].activity_canonical, null);
    assert.equal(row.rows[0].activity_matching_eligible, false);
    assert.equal(row.rows[0].match_ineligible_reason, 'no_activity_detected');
  });

  // ============================================================
  // CASO 8: ES ↔ EN ('Walking this weekend' ↔ 'Salir a caminar') => MATCH
  // ============================================================
  test('Caso 8: ES ↔ EN ("Walking this weekend" ↔ "Salir a caminar") => MATCH', async () => {
    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Salir a caminar', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { ok: boolean; matches_found_count: number; matched_encounter_ids: string[] } }>(`
      SELECT public.crear_intencion_segura('Walking this weekend', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 1);
    assert.equal(res.rows[0].crear_intencion_segura.matched_encounter_ids[0], encRes.rows[0].id);
  });

  // ============================================================
  // CASO 9: PT ↔ ES ('Quero fazer uma trilha' ↔ 'Senderismo') => MATCH
  // ============================================================
  test('Caso 9: PT ↔ ES ("Quero fazer uma trilha" ↔ "Senderismo") => MATCH', async () => {
    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Senderismo en la sierra', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { ok: boolean; matches_found_count: number; matched_encounter_ids: string[] } }>(`
      SELECT public.crear_intencion_segura('Quero fazer uma trilha', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 1);
    assert.equal(res.rows[0].crear_intencion_segura.matched_encounter_ids[0], encRes.rows[0].id);
  });

  // ============================================================
  // CASO 10: multi-activity ('Caminar y tomar café') => no eligible
  // ============================================================
  test('Caso 10: multi-activity ("Caminar y tomar café") => no eligible (multiple_activities)', async () => {
    await setAuthContext(userHost);
    await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Caminata por la costa', 'presencial', 'guemes', true, 'activo', 'approved');
    `);

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { ok: boolean; matches_found_count: number; id: string } }>(`
      SELECT public.crear_intencion_segura('Caminar y tomar un café', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 0);
    const intId = res.rows[0].crear_intencion_segura.id;
    const row = await db.query(`
      SELECT activity_canonical, activity_matching_eligible, match_ineligible_reason FROM public.intenciones WHERE id = '${intId}';
    `);
    assert.equal(row.rows[0].activity_canonical, null);
    assert.equal(row.rows[0].activity_matching_eligible, false);
    assert.equal(row.rows[0].match_ineligible_reason, 'multiple_activities');
  });

  // ============================================================
  // CASO 11: activa + Avisame equivalente => una sola notificación (dedupe canónico)
  // ============================================================
  test('Caso 11: activa + Avisame equivalente => una sola notificación (dedupe canónico)', async () => {
    // Usuario A crea intención activa de padel
    await setAuthContext(userA);
    await db.query(`
      SELECT public.crear_intencion_segura('Jugar al pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes');
    `);

    // Usuario A también crea suscripción Avisame (manual_alert)
    await resetAuthContext();
    await db.query(`
      INSERT INTO public.match_alert_subscriptions (user_id, status, modalidad, locality_id)
      VALUES ('${userA}', 'active', 'presencial', 'guemes');
    `);

    // Host abre encuentro de pádel
    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);
    const encounterId = encRes.rows[0].id;

    // Ejecutar evaluación de encuentro abierto
    await resetAuthContext();
    const evalRes = await db.query<{ evaluar_matching_encuentro_abierto: { ok: boolean; matches_count: number } }>(`
      SELECT public.evaluar_matching_encuentro_abierto('${encounterId}') AS evaluar_matching_encuentro_abierto;
    `);

    assert.equal(evalRes.rows[0].evaluar_matching_encuentro_abierto.matches_count, 1);

    // Exactamente 1 registro en match_discoveries
    const disco = await db.query(`
      SELECT * FROM public.match_discoveries WHERE user_id = '${userA}' AND encounter_id = '${encounterId}';
    `);
    assert.equal(disco.rows.length, 1);
    assert.equal(disco.rows[0].primary_source, 'intention');

    // Exactamente 1 evento en outbox
    const outbox = await db.query(`
      SELECT * FROM public.domain_events_outbox WHERE dedup_key = 'match:${userA}:${encounterId}:v1';
    `);
    assert.equal(outbox.rows.length, 1);
  });

  // ============================================================
  // CASO 12: dos intenciones similares => una sola notificación
  // ============================================================
  test('Caso 12: dos intenciones similares => una sola notificación', async () => {
    await setAuthContext(userA);
    await db.query(`SELECT public.crear_intencion_segura('Jugar al pádel el sábado', NULL, NULL, NULL, NULL, 'presencial', 'guemes');`);
    await db.query(`SELECT public.crear_intencion_segura('Partido de pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes');`);

    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Pádel en Güemes', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);
    const encounterId = encRes.rows[0].id;

    await resetAuthContext();
    const evalRes = await db.query<{ evaluar_matching_encuentro_abierto: { ok: boolean; matches_count: number } }>(`
      SELECT public.evaluar_matching_encuentro_abierto('${encounterId}') AS evaluar_matching_encuentro_abierto;
    `);

    assert.equal(evalRes.rows[0].evaluar_matching_encuentro_abierto.matches_count, 1);

    const disco = await db.query(`
      SELECT * FROM public.match_discoveries WHERE user_id = '${userA}' AND encounter_id = '${encounterId}';
    `);
    assert.equal(disco.rows.length, 1);
  });

  // ============================================================
  // CASO 13: match > 14 días en Inbox => no duplicar
  // ============================================================
  test('Caso 13: match > 14 días en Inbox => no duplicar (durable match_discoveries)', async () => {
    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);
    const encounterId = encRes.rows[0].id;

    // Simular un match histórico hace 20 días ya registrado en match_discoveries
    await resetAuthContext();
    await db.query(`
      INSERT INTO public.match_discoveries (user_id, encounter_id, primary_source, activity_canonical, match_reason, first_matched_at)
      VALUES ('${userA}', '${encounterId}', 'intention', 'padel', 'intention_canonical_exact_match', now() - INTERVAL '20 days');
    `);

    // Usuario A crea o reactiva intención ahora
    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { ok: boolean; matches_found_count: number } }>(`
      SELECT public.crear_intencion_segura('Jugar al pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    // No debe considerarse match nuevo ni emitir evento duplicado
    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 0);
    await resetAuthContext();
    const outbox = await db.query(`SELECT count(*) as cnt FROM public.domain_events_outbox;`);
    assert.equal(Number(outbox.rows[0].cnt), 0);
  });

  // ============================================================
  // CASO 14: pausada => no match
  // ============================================================
  test('Caso 14: pausada => no match', async () => {
    await setAuthContext(userA);
    const crRes = await db.query<{ crear_intencion_segura: { id: string } }>(`
      SELECT public.crear_intencion_segura('Jugar al pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);
    const intId = crRes.rows[0].crear_intencion_segura.id;

    // Pausar intención
    await db.query(`
      SELECT public.cambiar_estado_intencion_segura('${intId}', 'pausada');
    `);

    // Host abre encuentro
    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);

    await resetAuthContext();
    const evalRes = await db.query<{ evaluar_matching_encuentro_abierto: { matches_count: number } }>(`
      SELECT public.evaluar_matching_encuentro_abierto('${encRes.rows[0].id}') AS evaluar_matching_encuentro_abierto;
    `);

    assert.equal(evalRes.rows[0].evaluar_matching_encuentro_abierto.matches_count, 0);
  });

  // ============================================================
  // CASO 15: reactivada => evalúa existentes
  // ============================================================
  test('Caso 15: reactivada => evalúa existentes', async () => {
    // 1. Crear y pausar
    await setAuthContext(userA);
    const crRes = await db.query<{ crear_intencion_segura: { id: string } }>(`
      SELECT public.crear_intencion_segura('Jugar al pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);
    const intId = crRes.rows[0].crear_intencion_segura.id;
    await db.query(`SELECT public.cambiar_estado_intencion_segura('${intId}', 'pausada');`);

    // 2. Encuentro abierto mientras estaba pausada
    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);
    const encounterId = encRes.rows[0].id;

    // 3. Reactivar intención
    await setAuthContext(userA);
    const reactRes = await db.query<{ cambiar_estado_intencion_segura: { ok: boolean; matches_found_count: number; matched_encounter_ids: string[] } }>(`
      SELECT public.cambiar_estado_intencion_segura('${intId}', 'activa') AS cambiar_estado_intencion_segura;
    `);

    const result = reactRes.rows[0].cambiar_estado_intencion_segura;
    assert.equal(result.ok, true);
    assert.equal(result.matches_found_count, 1);
    assert.equal(result.matched_encounter_ids[0], encounterId);

    await resetAuthContext();
    const disco = await db.query(`
      SELECT * FROM public.match_discoveries WHERE user_id = '${userA}' AND encounter_id = '${encounterId}';
    `);
    assert.equal(disco.rows.length, 1);
  });

  // ============================================================
  // CASO 16: cerrada => no match
  // ============================================================
  test('Caso 16: cerrada => no match', async () => {
    await setAuthContext(userA);
    const crRes = await db.query<{ crear_intencion_segura: { id: string } }>(`
      SELECT public.crear_intencion_segura('Jugar al pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);
    const intId = crRes.rows[0].crear_intencion_segura.id;
    await db.query(`SELECT public.cambiar_estado_intencion_segura('${intId}', 'cerrada');`);

    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);

    await resetAuthContext();
    const evalRes = await db.query<{ evaluar_matching_encuentro_abierto: { matches_count: number } }>(`
      SELECT public.evaluar_matching_encuentro_abierto('${encRes.rows[0].id}') AS evaluar_matching_encuentro_abierto;
    `);

    assert.equal(evalRes.rows[0].evaluar_matching_encuentro_abierto.matches_count, 0);
  });

  // ============================================================
  // CASO 17: convertida => no match
  // ============================================================
  test('Caso 17: convertida => no match', async () => {
    await setAuthContext(userA);
    const crRes = await db.query<{ crear_intencion_segura: { id: string } }>(`
      SELECT public.crear_intencion_segura('Jugar al pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);
    const intId = crRes.rows[0].crear_intencion_segura.id;

    // Marcar como convertida desde el sistema
    await resetAuthContext();
    await db.query(`UPDATE public.intenciones SET estado = 'convertida' WHERE id = '${intId}';`);

    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);

    await resetAuthContext();
    const evalRes = await db.query<{ evaluar_matching_encuentro_abierto: { matches_count: number } }>(`
      SELECT public.evaluar_matching_encuentro_abierto('${encRes.rows[0].id}') AS evaluar_matching_encuentro_abierto;
    `);

    assert.equal(evalRes.rows[0].evaluar_matching_encuentro_abierto.matches_count, 0);
  });

  // ============================================================
  // CASO 18: moderación pendiente => no match
  // ============================================================
  test('Caso 18: moderación pendiente => no match', async () => {
    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel', 'presencial', 'guemes', true, 'activo', 'pending_review')
      RETURNING id;
    `);

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { matches_found_count: number } }>(`
      SELECT public.crear_intencion_segura('Jugar al pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 0);
  });

  // ============================================================
  // CASO 19: auto-hidden => no match
  // ============================================================
  test('Caso 19: auto-hidden => no match', async () => {
    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel', 'presencial', 'guemes', false, 'oculto', 'approved')
      RETURNING id;
    `);

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { matches_found_count: number } }>(`
      SELECT public.crear_intencion_segura('Jugar al pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 0);
  });

  // ============================================================
  // CASO 20: bloqueo bilateral => no match
  // ============================================================
  test('Caso 20: bloqueo bilateral => no match', async () => {
    // Usuario A bloqueó a UserHost
    await resetAuthContext();
    await db.query(`
      INSERT INTO public.bloqueos_usuario (blocker_id, blocked_id) VALUES ('${userA}', '${userHost}');
    `);

    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { matches_found_count: number } }>(`
      SELECT public.crear_intencion_segura('Jugar al pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 0);
  });

  // ============================================================
  // CASO 21: host => no match
  // ============================================================
  test('Caso 21: host => no match (no auto-notificación)', async () => {
    await setAuthContext(userA);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userA}', 'Torneo de pádel', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);

    // Usuario A crea una intención sobre la misma actividad
    const res = await db.query<{ crear_intencion_segura: { matches_found_count: number } }>(`
      SELECT public.crear_intencion_segura('Jugar al pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 0);
  });

  // ============================================================
  // CASO 22: virtual => sin localidad obligatoria
  // ============================================================
  test('Caso 22: virtual => sin localidad obligatoria', async () => {
    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de ajedrez online', 'virtual', NULL, true, 'activo', 'approved')
      RETURNING id;
    `);

    await setAuthContext(userA);
    // Intención virtual sin localidad
    const res = await db.query<{ crear_intencion_segura: { matches_found_count: number; matched_encounter_ids: string[] } }>(`
      SELECT public.crear_intencion_segura('Jugar al ajedrez', NULL, NULL, NULL, NULL, 'virtual', NULL) AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 1);
    assert.equal(res.rows[0].crear_intencion_segura.matched_encounter_ids[0], encRes.rows[0].id);
  });

  // ============================================================
  // CASO 23: presencial => respeta localidad
  // ============================================================
  test('Caso 23: presencial => respeta localidad', async () => {
    await setAuthContext(userHost);
    // Encuentro en Palermo
    await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel Palermo', 'presencial', 'palermo', true, 'activo', 'approved');
    `);
    // Encuentro en Güemes
    const guemesRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel Güemes', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);

    await setAuthContext(userA);
    // Intención en Güemes
    const res = await db.query<{ crear_intencion_segura: { matches_found_count: number; matched_encounter_ids: string[] } }>(`
      SELECT public.crear_intencion_segura('Jugar al pádel', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    assert.equal(res.rows[0].crear_intencion_segura.matches_found_count, 1);
    assert.equal(res.rows[0].crear_intencion_segura.matched_encounter_ids[0], guemesRes.rows[0].id);
  });

  // ============================================================
  // CASO 24: crear intención con encuentro compatible ya existente => match inmediato y count retornado
  // ============================================================
  test('Caso 24: crear intención con encuentro compatible ya existente => match inmediato y count retornado', async () => {
    await setAuthContext(userHost);
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Clase de yoga en la playa', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);

    await setAuthContext(userA);
    const res = await db.query<{ crear_intencion_segura: { ok: boolean; matches_found_count: number; matched_encounter_ids: string[] } }>(`
      SELECT public.crear_intencion_segura('Hacer yoga', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);

    const data = res.rows[0].crear_intencion_segura;
    assert.equal(data.ok, true);
    assert.equal(data.matches_found_count, 1);
    assert.deepEqual(data.matched_encounter_ids, [encRes.rows[0].id]);
  });

  // ============================================================
  // CASO 25: worker reintenta => idempotente
  // ============================================================
  test('Caso 25: worker reintenta => idempotente (inbox_notifications dedup_key)', async () => {
    const encounterId = '90000000-0000-0000-0000-000000000001';
    const dedupKey = `match:${userA}:${encounterId}:v1`;

    // Primera ejecución de insertar_inbox_notification_seguro
    await resetAuthContext();
    const res1 = await db.query<{ insertar_inbox_notification_seguro: { ok: boolean; inserted: boolean } }>(`
      SELECT public.insertar_inbox_notification_seguro(
        '${userA}',
        'match_found',
        'encounter',
        '${encounterId}',
        '/?open_encounter=${encounterId}',
        'Encontramos algo para vos',
        'Hay un encuentro que coincide con algo que tenés ganas de hacer.',
        '{}'::jsonb,
        '${dedupKey}',
        NULL
      ) AS insertar_inbox_notification_seguro;
    `);
    assert.equal(res1.rows[0].insertar_inbox_notification_seguro.ok, true);
    assert.equal(res1.rows[0].insertar_inbox_notification_seguro.inserted, true);

    // Segundo intento (simulando retry del domain-events-worker)
    const res2 = await db.query<{ insertar_inbox_notification_seguro: { ok: boolean; inserted: boolean } }>(`
      SELECT public.insertar_inbox_notification_seguro(
        '${userA}',
        'match_found',
        'encounter',
        '${encounterId}',
        '/?open_encounter=${encounterId}',
        'Encontramos algo para vos',
        'Hay un encuentro que coincide con algo que tenés ganas de hacer.',
        '{}'::jsonb,
        '${dedupKey}',
        NULL
      ) AS insertar_inbox_notification_seguro;
    `);
    assert.equal(res2.rows[0].insertar_inbox_notification_seguro.ok, true);
    assert.equal(res2.rows[0].insertar_inbox_notification_seguro.inserted, false);

    // Exactamente 1 fila en inbox_notifications
    const rows = await db.query(`SELECT count(*) as cnt FROM public.inbox_notifications WHERE dedup_key = '${dedupKey}';`);
    assert.equal(Number(rows.rows[0].cnt), 1);
  });

  // ============================================================
  // CASO 26: editar intención cambia canonical => nuevos matches sólo donde corresponda
  // ============================================================
  test('Caso 26: editar intención cambia canonical => trigger reclasifica y evalúa correctamente', async () => {
    await setAuthContext(userHost);
    const encPadel = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (host_id, titulo, modalidad, locality_id, is_open, estado, moderation_status)
      VALUES ('${userHost}', 'Torneo de pádel', 'presencial', 'guemes', true, 'activo', 'approved')
      RETURNING id;
    `);

    await setAuthContext(userA);
    // Intención original de ajedrez (sin encuentros de ajedrez existentes)
    const crRes = await db.query<{ crear_intencion_segura: { id: string; matches_found_count: number } }>(`
      SELECT public.crear_intencion_segura('Jugar al ajedrez', NULL, NULL, NULL, NULL, 'presencial', 'guemes') AS crear_intencion_segura;
    `);
    assert.equal(crRes.rows[0].crear_intencion_segura.matches_found_count, 0);
    const intId = crRes.rows[0].crear_intencion_segura.id;

    // Editar título a 'Jugar al pádel'
    await db.query(`
      UPDATE public.intenciones
      SET titulo = 'Jugar al pádel'
      WHERE id = '${intId}';
    `);

    // Verificar que el trigger reclasificó la intención
    const intRow = await db.query(`
      SELECT activity_canonical, activity_matching_eligible FROM public.intenciones WHERE id = '${intId}';
    `);
    assert.equal(intRow.rows[0].activity_canonical, 'padel');
    assert.equal(intRow.rows[0].activity_matching_eligible, true);

    // Al evaluar matching sobre la intención actualizada, ahora encuentra el encuentro de pádel
    await resetAuthContext();
    const evalRes = await db.query<{ evaluar_matching_intencion_activa: { ok: boolean; matches_found_count: number; matched_encounter_ids: string[] } }>(`
      SELECT public.evaluar_matching_intencion_activa('${intId}') AS evaluar_matching_intencion_activa;
    `);
    assert.equal(evalRes.rows[0].evaluar_matching_intencion_activa.matches_found_count, 1);
    assert.equal(evalRes.rows[0].evaluar_matching_intencion_activa.matched_encounter_ids[0], encPadel.rows[0].id);
  });

  // ============================================================
  // CASO 27: dos activities fuertes => multiple_activities / no eligible
  // ============================================================
  test('Caso 27: dos activities fuertes => multiple_activities / no eligible', async () => {
    const res = await db.query<{ fn_classify_activity: { activity_canonical: string | null; activity_matching_eligible: boolean; match_ineligible_reason: string } }>(`
      SELECT ROW_TO_JSON(c.*) AS fn_classify_activity
      FROM public.fn_classify_activity('Pádel o tenis este finde', NULL) c;
    `);

    const cls = res.rows[0].fn_classify_activity;
    assert.equal(cls.activity_canonical, null);
    assert.equal(cls.activity_matching_eligible, false);
    assert.equal(cls.match_ineligible_reason, 'multiple_activities');
  });
});
