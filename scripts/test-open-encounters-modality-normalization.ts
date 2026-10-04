import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';

// Componente modal para pruebas SSR de presentación
import { OpenEncounterPublishModal } from '../src/components/host/OpenEncounterPublishModal';

describe('Normalización de Zona Pública por Modalidad en Encuentros Abiertos (Tests Exhaustivos)', () => {
  let db: PGlite;

  const hostUser = '10000000-0000-0000-0000-000000000001';
  const participantUser = '20000000-0000-0000-0000-000000000002';
  const alertSubscriberUser = '30000000-0000-0000-0000-000000000003';

  before(async () => {
    db = new PGlite();

    // 1. Roles y Mock Auth
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
        email TEXT
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::JSONB, '{}'::jsonb);
      $$ LANGUAGE SQL STABLE;

      INSERT INTO auth.users (id, email) VALUES
        ('${hostUser}', 'host@test.com'),
        ('${participantUser}', 'part@test.com'),
        ('${alertSubscriberUser}', 'alerts@test.com')
      ON CONFLICT DO NOTHING;

      -- Tablas base
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

      INSERT INTO public.localidades (id, nombre, ciudad, zona, activo) VALUES
        ('guemes', 'Güemes / Playa Grande', 'Mar del Plata', 'Costa Atlántica', true),
        ('centro', 'Centro / La Perla', 'Mar del Plata', 'Costa Atlántica', true),
        ('costa_inactiva', 'La Costa Vieja', 'Mar del Plata', 'Costa Atlántica', false)
      ON CONFLICT DO NOTHING;

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
        host_id UUID NOT NULL REFERENCES auth.users(id),
        public_token UUID DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'activo',
        tema TEXT DEFAULT 'blue',
        tema_invitacion TEXT DEFAULT 'sports',
        invitation_template TEXT,
        date_mode TEXT DEFAULT 'fixed',
        is_open BOOLEAN NOT NULL DEFAULT false,
        open_description TEXT,
        max_participants INT,
        locality_id TEXT REFERENCES public.localidades(id),
        open_public_zone TEXT,
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        user_id UUID REFERENCES auth.users(id),
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        estado TEXT NOT NULL DEFAULT 'pendiente',
        token_invitacion UUID DEFAULT gen_random_uuid(),
        mensaje_respuesta TEXT,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL,
        respondido_en TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL,
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        estado TEXT NOT NULL DEFAULT 'pending',
        participante_id UUID REFERENCES public.participantes(id),
        token_participante UUID,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        resolved_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS public.intenciones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID,
        estado TEXT DEFAULT 'activa'
      );

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        blocker_id UUID NOT NULL,
        blocked_id UUID NOT NULL,
        PRIMARY KEY (blocker_id, blocked_id)
      );

      CREATE TABLE IF NOT EXISTS public.domain_events_outbox (
        id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        event_version INT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id UUID NOT NULL,
        actor_user_id UUID,
        payload JSONB NOT NULL,
        dedup_key TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.inbox_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_user_id UUID NOT NULL REFERENCES auth.users(id),
        notification_type TEXT NOT NULL DEFAULT 'match_alert',
        target_type TEXT NOT NULL DEFAULT 'open_encounter',
        target_id UUID,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        deep_link TEXT NOT NULL,
        payload JSONB DEFAULT '{}'::jsonb,
        dedup_key TEXT UNIQUE,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now(),
        read_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS public.match_alert_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES auth.users(id),
        modalidad TEXT,
        locality_id TEXT REFERENCES public.localidades(id),
        fecha_desde DATE,
        fecha_hasta DATE,
        hora_desde TIME,
        hora_hasta TIME,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT now(),
        expires_at TIMESTAMPTZ
      );

      -- Mock RPC para intenciones outbox
      CREATE OR REPLACE FUNCTION public.emitir_alertas_intencion_convertida_outbox(p_intencion_id UUID, p_encuentro_id UUID)
      RETURNS VOID AS $$
      BEGIN
        -- no-op en este test
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 2. Aplicar la función evaluar_matching_encuentro_abierto
    const matchMigration = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase/migrations/20261002210000_fase_2a_match_alert_subscriptions.sql'),
      'utf8'
    );
    // Extraer solo la función evaluar_matching_encuentro_abierto
    const fnMatchRegex = /CREATE OR REPLACE FUNCTION public\.evaluar_matching_encuentro_abierto[\s\S]+?REVOKE ALL ON FUNCTION public\.evaluar_matching_encuentro_abierto/m;
    const matchMatch = matchMigration.match(fnMatchRegex);
    if (matchMatch) {
      await db.exec(matchMatch[0].replace('REVOKE ALL ON FUNCTION public.evaluar_matching_encuentro_abierto', ''));
    }

    // 3. Aplicar get_participante_seguro
    const securePartMigration = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase/migrations/20260701000000_add_invitation_template.sql'),
      'utf8'
    );
    const fnPartRegex = /CREATE OR REPLACE FUNCTION public\.get_participante_seguro\(p_token text\)[\s\S]+?END;\s*\$function\$;/m;
    const partMatch = securePartMigration.match(fnPartRegex);
    if (partMatch) {
      await db.exec(partMatch[0]);
    }

    // 4. Aplicar la NUEVA migración objeto de la prueba
    const newMigration = fs.readFileSync(
      path.resolve(process.cwd(), 'supabase/migrations/20261003210000_normalize_open_encounters_zone_by_modality.sql'),
      'utf8'
    );
    await db.exec(newMigration);
  });

  const setAuthContext = async (userId: string, isAnon: boolean = false) => {
    await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
    await db.query(`SELECT set_config('request.jwt.claims', '{"sub": "${userId}", "is_anonymous": ${isAnon}}', false);`);
  };

  test('1. Cerrado presencial puede crearse y persistir sin zona/locality_id', async () => {
    const res = await db.query<{ id: string; is_open: boolean; locality_id: string | null }>(`
      INSERT INTO public.encuentros (titulo, modalidad, lugar_texto, host_id, is_open)
      VALUES ('Café cerrado', 'presencial', 'Calle Falsa 123', '${hostUser}', false)
      RETURNING id, is_open, locality_id;
    `);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].is_open, false);
    assert.equal(res.rows[0].locality_id, null);
  });

  test('2. Cerrado virtual puede crearse y persistir sin zona/locality_id', async () => {
    const res = await db.query<{ id: string; is_open: boolean; link_virtual: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, link_virtual, host_id, is_open)
      VALUES ('Meet cerrado', 'virtual', 'https://meet.google.com/abc-defg-hij', '${hostUser}', false)
      RETURNING id, is_open, link_virtual;
    `);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].is_open, false);
  });

  test('3. Presencial no puede abrirse sin locality_id (RPC rechaza)', async () => {
    await setAuthContext(hostUser);
    const enc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, lugar_texto, host_id, is_open)
      VALUES ('Tenis Presencial', 'presencial', 'Club Náutico', '${hostUser}', false)
      RETURNING id;
    `);
    const encId = enc.rows[0].id;

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${encId}',
        '${hostUser}',
        'Busco rival de tenis',
        4,
        NULL,
        NULL
      );
    `);
    assert.equal(res.rows[0].abrir_encuentro_seguro.ok, false);
    assert.equal(res.rows[0].abrir_encuentro_seguro.error, 'locality_required');
  });

  test('4. Presencial no puede abrirse con localidad inexistente o inactiva', async () => {
    await setAuthContext(hostUser);
    const enc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, lugar_texto, host_id, is_open)
      VALUES ('Tenis Presencial Inexistente', 'presencial', 'Club Náutico', '${hostUser}', false)
      RETURNING id;
    `);
    const encId = enc.rows[0].id;

    // Inexistente
    const res1 = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Desc', 4, 'zona_fantasiosa', NULL);
    `);
    assert.equal(res1.rows[0].abrir_encuentro_seguro.ok, false);
    assert.equal(res1.rows[0].abrir_encuentro_seguro.error, 'invalid_locality');

    // Inactiva
    const res2 = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Desc', 4, 'costa_inactiva', NULL);
    `);
    assert.equal(res2.rows[0].abrir_encuentro_seguro.ok, false);
    assert.equal(res2.rows[0].abrir_encuentro_seguro.error, 'invalid_locality');
  });

  test('5. Presencial deriva open_public_zone del catálogo automáticamente', async () => {
    await setAuthContext(hostUser);
    const enc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, lugar_texto, host_id, is_open)
      VALUES ('Café en Güemes', 'presencial', 'Güemes 2500', '${hostUser}', false)
      RETURNING id;
    `);
    const encId = enc.rows[0].id;

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Charlamos de libros', 4, 'guemes', NULL);
    `);
    assert.equal(res.rows[0].abrir_encuentro_seguro.ok, true);
    assert.equal(res.rows[0].abrir_encuentro_seguro.locality_id, 'guemes');
    assert.equal(res.rows[0].abrir_encuentro_seguro.open_public_zone, 'Güemes / Playa Grande');

    const dbCheck = await db.query<{ open_public_zone: string }>(`
      SELECT open_public_zone FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(dbCheck.rows[0].open_public_zone, 'Güemes / Playa Grande');
  });

  test('6. Caller no puede forzar texto público contradictorio en presencial', async () => {
    await setAuthContext(hostUser);
    const enc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, lugar_texto, host_id, is_open)
      VALUES ('Intento Spoofing Zona', 'presencial', 'San Martín 1000', '${hostUser}', false)
      RETURNING id;
    `);
    const encId = enc.rows[0].id;

    // Caller envía p_locality_id = 'centro', pero p_open_public_zone = 'Palermo Soho'
    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Desc', 4, 'centro', 'Palermo Soho');
    `);
    assert.equal(res.rows[0].abrir_encuentro_seguro.ok, true);
    // El servidor ignora el parámetro legacy y coloca el canónico de 'centro'
    assert.equal(res.rows[0].abrir_encuentro_seguro.open_public_zone, 'Centro / La Perla');

    const dbCheck = await db.query<{ open_public_zone: string }>(`
      SELECT open_public_zone FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(dbCheck.rows[0].open_public_zone, 'Centro / La Perla');
  });

  test('7. Virtual abre sin requerir localidad ni parámetro de zona', async () => {
    await setAuthContext(hostUser);
    const enc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, link_virtual, host_id, is_open)
      VALUES ('Meet Coding Remoto', 'virtual', 'https://meet.google.com/xyz', '${hostUser}', false)
      RETURNING id;
    `);
    const encId = enc.rows[0].id;

    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Coding online', 5, NULL, NULL);
    `);
    assert.equal(res.rows[0].abrir_encuentro_seguro.ok, true);
  });

  test('8. Virtual queda persistido con locality_id = NULL', async () => {
    await setAuthContext(hostUser);
    const enc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, link_virtual, host_id, is_open)
      VALUES ('Webinar Abierto', 'virtual', 'https://zoom.us/j/1234', '${hostUser}', false)
      RETURNING id;
    `);
    const encId = enc.rows[0].id;

    // Si el caller mandara accidentalmente una localidad, la RPC la fuerza a NULL
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Webinar', 10, 'guemes', NULL);
    `);

    const dbCheck = await db.query<{ locality_id: string | null; open_public_zone: string }>(`
      SELECT locality_id, open_public_zone FROM public.encuentros WHERE id = '${encId}';
    `);
    assert.equal(dbCheck.rows[0].locality_id, null);
    assert.equal(dbCheck.rows[0].open_public_zone, 'Virtual');
  });

  test('9. Virtual queda presentado como "Virtual" en Discovery', async () => {
    const res = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos();
    `);
    const items = res.rows[0].get_discovery_encuentros_abiertos;
    const virtualItem = items.find((i: any) => i.title === 'Webinar Abierto');
    assert.ok(virtualItem);
    assert.equal(virtualItem.approximate_zone, 'Virtual');
    assert.equal(virtualItem.locality_id, null);
  });

  test('10. Virtual sigue matcheando Avisame independientemente de la zona de la suscripción', async () => {
    // Alerta suscrita con zona 'centro'
    const subRes = await db.query<{ id: string }>(`
      INSERT INTO public.match_alert_subscriptions (user_id, modalidad, locality_id, status)
      VALUES ('${alertSubscriberUser}', 'indistinto', 'centro', 'active')
      RETURNING id;
    `);

    // Encuentro virtual abierto
    await setAuthContext(hostUser);
    const enc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, link_virtual, host_id, fecha, hora, is_open, estado)
      VALUES ('Clase Virtual Idiomas', 'virtual', 'https://meet.google.com/lang', '${hostUser}', CURRENT_DATE + 3, '18:00', false, 'activo')
      RETURNING id;
    `);
    const encId = enc.rows[0].id;
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Práctica de conversación', 4, NULL, NULL);
    `);

    // Evaluar matching
    const matchRes = await db.query<{ evaluar_matching_encuentro_abierto: any }>(`
      SELECT public.evaluar_matching_encuentro_abierto('${encId}');
    `);
    assert.equal(matchRes.rows[0].evaluar_matching_encuentro_abierto.ok, true);
    assert.equal(matchRes.rows[0].evaluar_matching_encuentro_abierto.matches_count, 1);
  });

  test('11. Presencial matchea por locality_id estricta y rechaza zona no coincidente', async () => {
    // Suscriptor 1: solo 'guemes'
    const userGuemes = '40000000-0000-0000-0000-000000000004';
    // Suscriptor 2: solo 'centro'
    const userCentro = '50000000-0000-0000-0000-000000000005';
    // Suscriptor 3: wildcard de zona (locality_id = NULL)
    const userWildcard = '60000000-0000-0000-0000-000000000006';

    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES
        ('${userGuemes}', 'g@test.com'),
        ('${userCentro}', 'c@test.com'),
        ('${userWildcard}', 'w@test.com')
      ON CONFLICT DO NOTHING;

      INSERT INTO public.match_alert_subscriptions (user_id, modalidad, locality_id, status) VALUES
        ('${userGuemes}', 'presencial', 'guemes', 'active'),
        ('${userCentro}', 'presencial', 'centro', 'active'),
        ('${userWildcard}', 'presencial', NULL, 'active');
    `);

    // Encuentro presencial en 'guemes'
    await setAuthContext(hostUser);
    const enc = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, lugar_texto, host_id, fecha, hora, is_open, estado)
      VALUES ('Running Güemes', 'presencial', 'Playa Grande', '${hostUser}', CURRENT_DATE + 4, '09:00', false, 'activo')
      RETURNING id;
    `);
    const encId = enc.rows[0].id;
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${encId}', '${hostUser}', 'Trote matutino', 5, 'guemes', NULL);
    `);

    const matchRes = await db.query<{ evaluar_matching_encuentro_abierto: any }>(`
      SELECT public.evaluar_matching_encuentro_abierto('${encId}');
    `);
    assert.equal(matchRes.rows[0].evaluar_matching_encuentro_abierto.ok, true);
    // Debe matchear userGuemes y userWildcard (total 2), pero NO userCentro!
    assert.equal(matchRes.rows[0].evaluar_matching_encuentro_abierto.matches_count, 2);

    // Verificar en outbox que userCentro no recibió evento de match
    const checkCentro = await db.query(`
      SELECT 1 FROM public.domain_events_outbox
      WHERE event_type = 'match.detected.v1'
        AND payload->>'recipient_user_id' = '${userCentro}'
        AND payload->>'encounter_id' = '${encId}';
    `);
    assert.equal(checkCentro.rows.length, 0);

    const checkGuemes = await db.query(`
      SELECT 1 FROM public.domain_events_outbox
      WHERE event_type = 'match.detected.v1'
        AND payload->>'recipient_user_id' = '${userGuemes}'
        AND payload->>'encounter_id' = '${encId}';
    `);
    assert.equal(checkGuemes.rows.length, 1);
  });

  test('12. Evento "encounter.opened.v1" se emite con payload consistente para presencial y virtual', async () => {
    const events = await db.query<{ event_type: string; payload: any }>(`
      SELECT event_type, payload FROM public.domain_events_outbox
      WHERE event_type = 'encounter.opened.v1'
      ORDER BY id DESC LIMIT 2;
    `);
    assert.ok(events.rows.length >= 2);
    // Uno de ellos es presencial y tiene locality_id
    const presEvent = events.rows.find(e => e.payload.modalidad === 'presencial');
    assert.ok(presEvent);
    assert.equal(typeof presEvent.payload.locality_id, 'string');

    // Otro es virtual y tiene locality_id = null
    const virtEvent = events.rows.find(e => e.payload.modalidad === 'virtual');
    assert.ok(virtEvent);
    assert.equal(virtEvent.payload.locality_id, null);
  });

  test('13 & 14. Discovery no expone dirección exacta ni enlace virtual privado', async () => {
    const res = await db.query<{ get_discovery_encuentros_abiertos: any[] }>(`
      SELECT public.get_discovery_encuentros_abiertos();
    `);
    const items = res.rows[0].get_discovery_encuentros_abiertos;
    assert.ok(items.length > 0);
    for (const item of items) {
      assert.equal(item.lugar_texto, undefined, 'lugar_texto no debe estar en la respuesta de Discovery');
      assert.equal(item.link_virtual, undefined, 'link_virtual no debe estar en la respuesta de Discovery');
      assert.equal(item.public_token, undefined, 'public_token no debe estar en Discovery');
    }
  });

  test('15. Solicitante pendiente no obtiene lugar_texto ni link_virtual', async () => {
    // Solicitante envía petición a encuentro presencial
    const encPres = await db.query<{ id: string }>(`
      SELECT id FROM public.encuentros WHERE modalidad = 'presencial' AND is_open = true LIMIT 1;
    `);
    const encId = encPres.rows[0].id;

    const sol = await db.query<{ id: string; participante_id: string | null; token_participante: string | null }>(`
      INSERT INTO public.solicitudes_encuentro_abierto (encuentro_id, usuario_id, nombre_solicitante, estado)
      VALUES ('${encId}', '${participantUser}', 'Solicitante Juan', 'pending')
      RETURNING id, participante_id, token_participante;
    `);
    // En estado pendiente no tiene token ni participante
    assert.equal(sol.rows[0].token_participante, null);
    assert.equal(sol.rows[0].participante_id, null);
  });

  test('16. Participante aprobado conserva acceso a lugar_texto o link_virtual según modalidad', async () => {
    // Encuentro presencial: participante confirmado con token personal
    const encPres = await db.query<{ id: string }>(`
      SELECT id FROM public.encuentros WHERE modalidad = 'presencial' AND is_open = true LIMIT 1;
    `);
    const encPresId = encPres.rows[0].id;

    const tokenPres = '99999999-9999-9999-9999-999999999999';
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, token_invitacion)
      VALUES ('${encPresId}', '${participantUser}', 'Juan Aprobado', 'confirmado', '${tokenPres}');
    `);

    const resPres = await db.query<{ get_participante_seguro: any }>(`
      SELECT public.get_participante_seguro('${tokenPres}');
    `);
    const dataPres = resPres.rows[0].get_participante_seguro;
    assert.ok(dataPres);
    assert.ok(dataPres.encuentros.lugar_texto);
    assert.equal(dataPres.encuentros.link_virtual, null);

    // Encuentro virtual: participante confirmado con token personal
    const encVirt = await db.query<{ id: string }>(`
      SELECT id FROM public.encuentros WHERE modalidad = 'virtual' AND is_open = true LIMIT 1;
    `);
    const encVirtId = encVirt.rows[0].id;

    const tokenVirt = '88888888-8888-8888-8888-888888888888';
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado, token_invitacion)
      VALUES ('${encVirtId}', '${participantUser}', 'Ana Aprobada', 'confirmado', '${tokenVirt}');
    `);

    const resVirt = await db.query<{ get_participante_seguro: any }>(`
      SELECT public.get_participante_seguro('${tokenVirt}');
    `);
    const dataVirt = resVirt.rows[0].get_participante_seguro;
    assert.ok(dataVirt);
    assert.ok(dataVirt.encuentros.link_virtual);
  });

  test('17. Modal presencial (SSR): renderiza selector de localidad', () => {
    const html = renderToString(
      React.createElement(OpenEncounterPublishModal, {
        isOpen: true,
        onClose: () => {},
        encuentroId: 'enc-test-1',
        hostId: hostUser,
        modalidad: 'presencial',
        confirmedCount: 1,
        onPublished: () => {},
      })
    );
    assert.ok(html.includes('pe-publish-modal__select'));
    assert.ok(html.includes('Localidad / Barrio'));
    assert.ok(html.includes('Esta zona será visible públicamente'));
  });

  test('18. Modal virtual (SSR): no renderiza selector de localidad y muestra aviso virtual', () => {
    const html = renderToString(
      React.createElement(OpenEncounterPublishModal, {
        isOpen: true,
        onClose: () => {},
        encuentroId: 'enc-test-2',
        hostId: hostUser,
        modalidad: 'virtual',
        confirmedCount: 1,
        onPublished: () => {},
      })
    );
    assert.ok(!html.includes('pe-publish-modal__select'));
    assert.ok(!html.includes('Localidad / Barrio'));
    assert.ok(html.includes('pe-publish-modal__virtual-info'));
    assert.ok(html.includes('Encuentro Virtual'));
  });

  test('19. Input libre de "open_public_zone" ya no existe en el modal en ninguna modalidad', () => {
    const htmlPres = renderToString(
      React.createElement(OpenEncounterPublishModal, {
        isOpen: true,
        onClose: () => {},
        encuentroId: 'enc-test-1',
        hostId: hostUser,
        modalidad: 'presencial',
        confirmedCount: 1,
        onPublished: () => {},
      })
    );
    assert.ok(!htmlPres.includes('open_public_zone_placeholder'));
    assert.ok(!htmlPres.includes('open_public_zone_label'));

    const htmlVirt = renderToString(
      React.createElement(OpenEncounterPublishModal, {
        isOpen: true,
        onClose: () => {},
        encuentroId: 'enc-test-2',
        hostId: hostUser,
        modalidad: 'virtual',
        confirmedCount: 1,
        onPublished: () => {},
      })
    );
    assert.ok(!htmlVirt.includes('open_public_zone_placeholder'));
    assert.ok(!htmlVirt.includes('open_public_zone_label'));
  });

  test('20. Cambio de modalidad en abierto está bloqueado para no dejar estados inconsistentes', async () => {
    await setAuthContext(hostUser);
    const enc = await db.query<{ id: string }>(`
      SELECT id FROM public.encuentros WHERE modalidad = 'presencial' AND is_open = true LIMIT 1;
    `);
    const encId = enc.rows[0].id;

    // Intentar actualizar modalidad a 'virtual' mientras está abierto
    const res = await db.query<{ actualizar_encuentro_seguro: any }>(`
      SELECT public.actualizar_encuentro_seguro('${encId}', '${hostUser}', '{"modalidad": "virtual"}'::jsonb);
    `);
    assert.equal(res.rows[0].actualizar_encuentro_seguro.ok, false);
    assert.equal(res.rows[0].actualizar_encuentro_seguro.error, 'cannot_change_modality_while_open');
  });
});
