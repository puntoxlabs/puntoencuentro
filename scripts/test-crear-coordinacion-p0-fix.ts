import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { validateCoordinationCreateResult } from '../src/services/encuentrosService';
import { applyReusablePayload } from '../src/lib/repeatEncounter';
import { useCoordinationWizardStore } from '../src/store/coordinationWizardStore';
import { useRepeatEncounterStore } from '../src/store/repeatEncounterStore';

/**
 * Suite de verificación P0: public.crear_encuentro_con_opciones_seguro(jsonb, jsonb)
 *
 * Verifica la corrección de la regresión introducida en 20261015150000_moderation_v1_1_quality_and_anti_spam.sql
 * mediante la migración aditiva 20261019180000_fix_crear_encuentro_con_opciones_seguro.sql,
 * ejecutando la RPC real en PGlite bajo el rol `authenticated`.
 */
describe('Corrección P0: crear_encuentro_con_opciones_seguro (PGlite RPC real)', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const guestUser = '22222222-2222-2222-2222-222222222222';
  const otherUser = '33333333-3333-3333-3333-333333333333';
  const anonUser = '44444444-4444-4444-4444-444444444444';

  const futureDate = (daysAhead: number): string => {
    const d = new Date(Date.now() + daysAhead * 86_400_000);
    return d.toISOString().split('T')[0];
  };

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

  const callCrearCoordinacion = async (
    pData: Record<string, any> | null,
    pOpciones: any,
    userId: string | null = hostUser,
    isAnon = false
  ): Promise<any> => {
    await setAuth(userId, isAnon);
    await db.exec(`SET ROLE authenticated;`);
    try {
      const dataSql = pData === null ? 'NULL::jsonb' : `'${JSON.stringify(pData).replace(/'/g, "''")}'::jsonb`;
      const optSql = pOpciones === null ? 'NULL::jsonb' : `'${JSON.stringify(pOpciones).replace(/'/g, "''")}'::jsonb`;
      const res = await db.query<{ result: any }>(
        `SELECT public.crear_encuentro_con_opciones_seguro(${dataSql}, ${optSql}) AS result;`
      );
      return parse(res.rows[0].result);
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  };

  const callCrearFechaFija = async (
    pData: Record<string, any>,
    userId: string | null = hostUser,
    isAnon = false
  ): Promise<any> => {
    await setAuth(userId, isAnon);
    await db.exec(`SET ROLE authenticated;`);
    try {
      const dataSql = `'${JSON.stringify(pData).replace(/'/g, "''")}'::jsonb`;
      const res = await db.query<{ result: any }>(
        `SELECT public.crear_encuentro_seguro(${dataSql}) AS result;`
      );
      return parse(res.rows[0].result);
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  };

  const getRateLimitCount = async (userId: string): Promise<number> => {
    const res = await db.query<{ total: number }>(
      `SELECT COALESCE(SUM(request_count), 0)::int AS total FROM public.rate_limit_buckets WHERE action = 'create_encounter' AND user_id = '${userId}';`
    );
    return res.rows[0]?.total ?? 0;
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

      CREATE TABLE IF NOT EXISTS public.localidades (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        provincia TEXT NOT NULL DEFAULT 'Buenos Aires',
        pais TEXT NOT NULL DEFAULT 'AR',
        activo BOOLEAN NOT NULL DEFAULT true
      );

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
        coordination_status TEXT,
        response_deadline TIMESTAMPTZ,
        selected_option_id UUID,
        duration_minutes INT,
        mostrar_respuestas_a_invitados BOOLEAN NOT NULL DEFAULT false,
        visibilidad_respuestas_invitados TEXT NOT NULL DEFAULT 'hidden',
        post_event_active_minutes INT NOT NULL DEFAULT 45,
        max_participants INT,
        allow_multi_seat_requests BOOLEAN NOT NULL DEFAULT false,
        max_seats_per_request INT NOT NULL DEFAULT 1,
        min_seats_per_request INT NOT NULL DEFAULT 1,
        is_open BOOLEAN NOT NULL DEFAULT false,
        open_public_title TEXT,
        open_description TEXT,
        open_public_zone TEXT,
        locality_id TEXT,
        moderation_status TEXT,
        moderation_reason TEXT,
        reemplaza_a UUID,
        cancellation_reason TEXT,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.encuentro_opciones_fecha (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        fecha DATE NOT NULL,
        hora_inicio TIME NOT NULL,
        orden INT NOT NULL,
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
        seat_count INT NOT NULL DEFAULT 1,
        mensaje_respuesta TEXT,
        respondido_en TIMESTAMPTZ,
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.intenciones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        titulo TEXT NOT NULL,
        nota TEXT,
        estado TEXT NOT NULL DEFAULT 'activa',
        is_public BOOLEAN NOT NULL DEFAULT false,
        locality_id TEXT,
        public_zone TEXT,
        moderation_status TEXT,
        moderation_reason TEXT,
        encuentro_id UUID,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.public_content_moderation_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        target_type TEXT,
        encuentro_id UUID,
        intencion_id UUID,
        actor_user_id UUID,
        decision TEXT NOT NULL,
        reason TEXT,
        source TEXT NOT NULL DEFAULT 'deterministic',
        metadata JSONB DEFAULT '{}'::jsonb,
        reviewed_by UUID,
        reviewed_at TIMESTAMPTZ,
        review_notes TEXT,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.moderation_authorized_users (
        user_id UUID PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'moderator',
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
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

      CREATE OR REPLACE FUNCTION public.emitir_alertas_encuentro_abierto_outbox(p_encuentro_id UUID)
      RETURNS VOID AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION public.emitir_alertas_intencion_convertida_outbox(p_intencion_id UUID, p_encuentro_id UUID)
      RETURNS VOID AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;

      CREATE OR REPLACE FUNCTION public.verificar_y_consumir_rate_limit(
        p_user_id UUID, p_action TEXT, p_max INT DEFAULT 5, p_window INTERVAL DEFAULT INTERVAL '1 hour'
      ) RETURNS JSONB AS $$
      BEGIN
        RETURN jsonb_build_object('allowed', true);
      END;
      $$ LANGUAGE plpgsql;

      INSERT INTO auth.users (id, email, is_anonymous, raw_user_meta_data) VALUES
        ('${hostUser}', 'host@puntoencuentro.com', false, '{"full_name": "Host Coordinador"}'::jsonb),
        ('${guestUser}', 'invitado@puntoencuentro.com', false, '{"full_name": "Invitado Uno"}'::jsonb),
        ('${otherUser}', 'otro@puntoencuentro.com', false, '{"full_name": "Otro Usuario"}'::jsonb),
        ('${anonUser}', 'anon@puntoencuentro.com', true, '{"full_name": "Usuario Anonimo"}'::jsonb);
    `);

    // Cargar migraciones reales en orden cronológico:
    // 1) Rate limiter genérico
    // 2) Enforcement de rate limits
    // 3) Orden de validación de rate limit (20260930213000)
    // 4) Moderación v1.1 (20261015150000 - que introdujo la regresión en crear_encuentro_con_opciones_seguro)
    // 5) Invitaciones internas v1 + hardening
    // 6) Plantillas y favoritos v1
    // 7) Corrección P0 de crear_encuentro_con_opciones_seguro (20261019180000)
    for (const file of [
      '20260930200000_fase_20c1_trust_generic_rate_limiting.sql',
      '20260930203000_fix_generic_rate_limiter_hardening.sql',
      '20260930210000_fase_20c1_trust_enforce_rate_limits_core_actions.sql',
      '20260930213000_fix_rate_limit_validation_order.sql',
      '20261015150000_moderation_v1_1_quality_and_anti_spam.sql',
      '20261018180000_internal_invitations_v1.sql',
      '20261018200000_harden_internal_invitations_direct_select.sql',
      '20261019150000_encounter_templates_favorites_v1.sql',
      '20261019180000_fix_crear_encuentro_con_opciones_seguro.sql',
    ]) {
      await db.exec(fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations', file), 'utf-8'));
    }

    // Ampliar umbral de create_encounter para poder ejecutar todos los escenarios válidos y luego probar el tope
    await db.exec(`
      UPDATE public.rate_limit_policies SET max_requests = 50 WHERE action = 'create_encounter';
      GRANT USAGE ON SCHEMA public TO authenticated, anon;
      GRANT USAGE ON SCHEMA auth TO authenticated, anon;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
      GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated, anon;
      GRANT SELECT ON public.encuentros TO authenticated;
      GRANT SELECT ON public.encuentro_opciones_fecha TO authenticated;
    `);
  });

  test('1. Crear coordinación con 2 y 3 opciones futuras (incluyendo ordenamiento cronológico automático)', async () => {
    const d1 = futureDate(5);
    const d2 = futureDate(6);
    const d3 = futureDate(7);

    // A. Con 2 opciones futuras
    const res2 = await callCrearCoordinacion(
      {
        titulo: 'Cena de equipo (2 opciones)',
        descripcion: 'Coordinemos qué día vamos',
        modalidad: 'presencial',
        lugar_texto: 'Parrilla El Encuentro',
        tipo_invitacion: 'individual',
        tema: 'blue',
        tema_invitacion: 'friends',
        invitation_template: 'friends_1',
        duration_minutes: 120,
      },
      [
        { fecha: d1, hora_inicio: '20:30' },
        { fecha: d2, hora_inicio: '21:00' },
      ]
    );

    assert.equal(res2.ok, true, `Creación con 2 opciones falló: ${JSON.stringify(res2)}`);
    assert.equal(res2.date_mode, 'coordination');
    assert.equal(res2.opciones_count, 2);
    const validated2 = validateCoordinationCreateResult(res2);
    assert.equal(validated2.ok, true);

    const opts2 = await db.query<{ fecha: string; hora_inicio: string; orden: number }>(
      `SELECT fecha::text, hora_inicio::text, orden FROM public.encuentro_opciones_fecha WHERE encuentro_id = '${res2.id}' ORDER BY orden ASC;`
    );
    assert.equal(opts2.rows.length, 2);
    assert.deepEqual(opts2.rows.map((r) => r.orden), [1, 2]);

    // B. Con 3 opciones futuras enviadas desordenadas -> se persisten en orden cronológico
    const res3 = await callCrearCoordinacion(
      {
        titulo: 'Torneo de pádel (3 opciones)',
        modalidad: 'presencial',
        lugar_texto: 'Club Centro',
        tipo_invitacion: 'link_general',
        duration_minutes: 90,
      },
      [
        { fecha: d3, hora_inicio: '19:00' },
        { fecha: d1, hora_inicio: '18:00' },
        { fecha: d2, hora_inicio: '20:00' },
      ]
    );

    assert.equal(res3.ok, true, `Creación con 3 opciones falló: ${JSON.stringify(res3)}`);
    assert.equal(res3.opciones_count, 3);

    const opts3 = await db.query<{ fecha: string; hora_inicio: string; orden: number }>(
      `SELECT fecha::text, hora_inicio::text, orden FROM public.encuentro_opciones_fecha WHERE encuentro_id = '${res3.id}' ORDER BY orden ASC;`
    );
    assert.equal(opts3.rows.length, 3);
    assert.deepEqual(opts3.rows.map((r) => r.fecha), [d1, d2, d3], 'Las opciones deben guardarse ordenadas cronológicamente');
    assert.deepEqual(opts3.rows.map((r) => r.orden), [1, 2, 3]);
  });

  test('2. Crear con plazo explícito (response_deadline)', async () => {
    const d1 = futureDate(6);
    const d2 = futureDate(7);
    const explicitDeadline = new Date(Date.now() + 2 * 86_400_000).toISOString();

    const res = await callCrearCoordinacion(
      {
        titulo: 'Reunión con plazo explícito',
        modalidad: 'virtual',
        link_virtual: 'https://meet.example.com/sala-1',
        tipo_invitacion: 'individual',
        response_deadline: explicitDeadline,
        duration_minutes: 60,
      },
      [
        { fecha: d1, hora_inicio: '19:00' },
        { fecha: d2, hora_inicio: '19:00' },
      ]
    );

    assert.equal(res.ok, true, `Fallo creando con plazo explícito: ${JSON.stringify(res)}`);
    const row = await db.query<{ response_deadline: string }>(
      `SELECT response_deadline FROM public.encuentros WHERE id = '${res.id}';`
    );
    assert.ok(row.rows[0]?.response_deadline, 'response_deadline debe haberse persistido');
    assert.equal(
      new Date(row.rows[0].response_deadline).getTime(),
      new Date(explicitDeadline).getTime(),
      'El plazo guardado debe coincidir exactamente con el enviado'
    );
  });

  test('3. Crear sin plazo explícito (response_deadline: null / omitido) deja response_deadline IS NULL sin error pg_catalog.least', async () => {
    const d1 = futureDate(5);
    const d2 = futureDate(6);

    // A. Con response_deadline: null (como envía Step4Review.tsx cuando no se define plazo)
    const resNull = await callCrearCoordinacion(
      {
        titulo: 'Coordinación sin plazo (null)',
        modalidad: 'presencial',
        lugar_texto: 'Café del Puerto',
        tipo_invitacion: 'individual',
        response_deadline: null,
      },
      [
        { fecha: d1, hora_inicio: '18:00' },
        { fecha: d2, hora_inicio: '18:00' },
      ]
    );
    assert.equal(resNull.ok, true, `Fallo con response_deadline null: ${JSON.stringify(resNull)}`);

    const rowNull = await db.query<{ response_deadline: string | null }>(
      `SELECT response_deadline FROM public.encuentros WHERE id = '${resNull.id}';`
    );
    assert.equal(rowNull.rows[0].response_deadline, null, 'response_deadline debe quedar NULL cuando no se especifica plazo');

    // B. Con clave response_deadline omitida
    const resOmitted = await callCrearCoordinacion(
      {
        titulo: 'Coordinación sin plazo (omitido)',
        modalidad: 'presencial',
        lugar_texto: 'Café del Puerto',
        tipo_invitacion: 'individual',
      },
      [
        { fecha: d1, hora_inicio: '19:30' },
        { fecha: d2, hora_inicio: '19:30' },
      ]
    );
    assert.equal(resOmitted.ok, true, `Fallo con response_deadline omitido: ${JSON.stringify(resOmitted)}`);
    const rowOmitted = await db.query<{ response_deadline: string | null }>(
      `SELECT response_deadline FROM public.encuentros WHERE id = '${resOmitted.id}';`
    );
    assert.equal(rowOmitted.rows[0].response_deadline, null);
  });

  test('4. Guardar correctamente visibilidad de respuestas (hidden, summary, detail y fallback legacy)', async () => {
    const d1 = futureDate(5);
    const d2 = futureDate(6);
    const opts = [
      { fecha: d1, hora_inicio: '20:00' },
      { fecha: d2, hora_inicio: '20:00' },
    ];

    for (const mode of ['hidden', 'summary', 'detail'] as const) {
      const res = await callCrearCoordinacion(
        {
          titulo: `Visibilidad ${mode}`,
          modalidad: 'presencial',
          lugar_texto: 'Sede Social',
          tipo_invitacion: 'individual',
          visibilidad_respuestas_invitados: mode,
        },
        opts
      );
      assert.equal(res.ok, true);
      const row = await db.query<{
        visibilidad_respuestas_invitados: string;
        mostrar_respuestas_a_invitados: boolean;
      }>(
        `SELECT visibilidad_respuestas_invitados, mostrar_respuestas_a_invitados FROM public.encuentros WHERE id = '${res.id}';`
      );
      assert.equal(row.rows[0].visibilidad_respuestas_invitados, mode);
      assert.equal(row.rows[0].mostrar_respuestas_a_invitados, mode !== 'hidden');
    }

    // Fallback legacy: mostrar_respuestas_a_invitados = true sin visibilidad_respuestas_invitados
    const resLegacy = await callCrearCoordinacion(
      {
        titulo: 'Visibilidad legacy boolean',
        modalidad: 'presencial',
        lugar_texto: 'Sede Social',
        tipo_invitacion: 'individual',
        mostrar_respuestas_a_invitados: true,
      },
      opts
    );
    assert.equal(resLegacy.ok, true);
    const rowLegacy = await db.query<{
      visibilidad_respuestas_invitados: string;
      mostrar_respuestas_a_invitados: boolean;
    }>(
      `SELECT visibilidad_respuestas_invitados, mostrar_respuestas_a_invitados FROM public.encuentros WHERE id = '${resLegacy.id}';`
    );
    assert.equal(rowLegacy.rows[0].visibilidad_respuestas_invitados, 'summary');
    assert.equal(rowLegacy.rows[0].mostrar_respuestas_a_invitados, true);
  });

  test('5. Rechazar opciones pasadas, duplicadas o inválidas y validaciones de plazo/campos sin consumir rate limit', async () => {
    const countBefore = await getRateLimitCount(hostUser);
    const d1 = futureDate(5);
    const d2 = futureDate(6);
    const d3 = futureDate(7);
    const d4 = futureDate(8);
    const pastDate = '2020-01-01';

    const baseData = {
      titulo: 'Prueba validaciones',
      modalidad: 'presencial',
      lugar_texto: 'Lugar válido',
      tipo_invitacion: 'individual',
    };

    // Menos de 2 opciones
    const rMin = await callCrearCoordinacion(baseData, [{ fecha: d1, hora_inicio: '18:00' }]);
    assert.deepEqual(rMin, { ok: false, error: 'minimum_two_options' });

    // Más de 3 opciones
    const rMax = await callCrearCoordinacion(baseData, [
      { fecha: d1, hora_inicio: '18:00' },
      { fecha: d2, hora_inicio: '18:00' },
      { fecha: d3, hora_inicio: '18:00' },
      { fecha: d4, hora_inicio: '18:00' },
    ]);
    assert.deepEqual(rMax, { ok: false, error: 'maximum_three_options' });

    // Opción en el pasado
    const rPast = await callCrearCoordinacion(baseData, [
      { fecha: pastDate, hora_inicio: '18:00' },
      { fecha: d1, hora_inicio: '18:00' },
    ]);
    assert.deepEqual(rPast, { ok: false, error: 'option_in_past' });

    // Opciones duplicadas
    const rDup = await callCrearCoordinacion(baseData, [
      { fecha: d1, hora_inicio: '18:00' },
      { fecha: d1, hora_inicio: '18:00' },
    ]);
    assert.deepEqual(rDup, { ok: false, error: 'duplicate_options' });

    // Opción incompleta / fecha inválida / hora inválida
    const rFmt = await callCrearCoordinacion(baseData, [
      { fecha: d1 },
      { fecha: d2, hora_inicio: '18:00' },
    ]);
    assert.deepEqual(rFmt, { ok: false, error: 'invalid_option_format' });

    const rBadDate = await callCrearCoordinacion(baseData, [
      { fecha: 'fecha-invalida', hora_inicio: '18:00' },
      { fecha: d2, hora_inicio: '18:00' },
    ]);
    assert.deepEqual(rBadDate, { ok: false, error: 'invalid_option_date' });

    const rBadTime = await callCrearCoordinacion(baseData, [
      { fecha: d1, hora_inicio: '99:99' },
      { fecha: d2, hora_inicio: '18:00' },
    ]);
    assert.deepEqual(rBadTime, { ok: false, error: 'invalid_option_time' });

    // Plazo en el pasado
    const rDlPast = await callCrearCoordinacion(
      { ...baseData, response_deadline: '2020-01-01T12:00:00Z' },
      [
        { fecha: d1, hora_inicio: '18:00' },
        { fecha: d2, hora_inicio: '18:00' },
      ]
    );
    assert.deepEqual(rDlPast, { ok: false, error: 'deadline_in_past' });

    // Plazo posterior a la primera opción
    const rDlAfter = await callCrearCoordinacion(
      { ...baseData, response_deadline: `${d2}T18:00:00-03:00` },
      [
        { fecha: d1, hora_inicio: '18:00' },
        { fecha: d2, hora_inicio: '18:00' },
      ]
    );
    assert.deepEqual(rDlAfter, { ok: false, error: 'deadline_after_options' });

    // Plazo con formato inválido
    const rDlBad = await callCrearCoordinacion(
      { ...baseData, response_deadline: 'no-es-un-timestamp' },
      [
        { fecha: d1, hora_inicio: '18:00' },
        { fecha: d2, hora_inicio: '18:00' },
      ]
    );
    assert.deepEqual(rDlBad, { ok: false, error: 'invalid_deadline' });

    // Duración inválida
    const rDur = await callCrearCoordinacion(
      { ...baseData, duration_minutes: 10 },
      [
        { fecha: d1, hora_inicio: '18:00' },
        { fecha: d2, hora_inicio: '18:00' },
      ]
    );
    assert.deepEqual(rDur, { ok: false, error: 'invalid_duration_minutes' });

    // Modalidad y logística requerida
    const rLoc = await callCrearCoordinacion(
      { ...baseData, lugar_texto: '   ' },
      [
        { fecha: d1, hora_inicio: '18:00' },
        { fecha: d2, hora_inicio: '18:00' },
      ]
    );
    assert.deepEqual(rLoc, { ok: false, error: 'location_required' });

    const rVirt = await callCrearCoordinacion(
      { ...baseData, modalidad: 'virtual', link_virtual: '' },
      [
        { fecha: d1, hora_inicio: '18:00' },
        { fecha: d2, hora_inicio: '18:00' },
      ]
    );
    assert.deepEqual(rVirt, { ok: false, error: 'virtual_link_required' });

    const countAfter = await getRateLimitCount(hostUser);
    assert.equal(countAfter, countBefore, 'Ninguna llamada inválida debe consumir rate limit');
  });

  test('6. Rechazar usuario anónimo y llamadas sin autenticación', async () => {
    const d1 = futureDate(5);
    const d2 = futureDate(6);
    const validPayload = {
      titulo: 'Intento anónimo',
      modalidad: 'presencial',
      lugar_texto: 'Plaza Mitre',
      tipo_invitacion: 'individual',
    };
    const validOpts = [
      { fecha: d1, hora_inicio: '18:00' },
      { fecha: d2, hora_inicio: '18:00' },
    ];

    // Sesión anónima (authenticated con is_anonymous = true)
    const rAnon = await callCrearCoordinacion(validPayload, validOpts, anonUser, true);
    assert.deepEqual(rAnon, { ok: false, error: 'permanent_account_required' });

    // Sin auth.uid()
    const rUnauth = await callCrearCoordinacion(validPayload, validOpts, null, false);
    assert.deepEqual(rUnauth, { ok: false, error: 'not_authenticated' });

    // Rol anon tiene REVOKE EXECUTE
    await setAuth(null, false);
    await db.exec(`SET ROLE anon;`);
    try {
      await assert.rejects(
        async () => {
          await db.query(`SELECT public.crear_encuentro_con_opciones_seguro('{}'::jsonb, '[]'::jsonb);`);
        },
        /permission denied/
      );
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  });

  test('7. Rechazar intentos de inyectar ID, public_token o host_id desde el cliente', async () => {
    const d1 = futureDate(5);
    const d2 = futureDate(6);
    const injectedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const injectedToken = 'ffffffff-1111-2222-3333-444444444444';

    const res = await callCrearCoordinacion(
      {
        id: injectedId,
        public_token: injectedToken,
        host_id: otherUser,
        titulo: 'Prueba anti-inyección de IDs',
        modalidad: 'presencial',
        lugar_texto: 'Club Náutico',
        tipo_invitacion: 'individual',
      },
      [
        { fecha: d1, hora_inicio: '18:00' },
        { fecha: d2, hora_inicio: '19:00' },
      ],
      hostUser,
      false
    );

    assert.equal(res.ok, true);
    assert.notEqual(res.id, injectedId, 'El servidor NUNCA debe aceptar un id provisto por el cliente');
    assert.notEqual(res.public_token, injectedToken, 'El servidor NUNCA debe aceptar un public_token provisto por el cliente');

    const row = await db.query<{ id: string; public_token: string; host_id: string }>(
      `SELECT id, public_token, host_id FROM public.encuentros WHERE id = '${res.id}';`
    );
    assert.equal(row.rows[0].host_id, hostUser, 'host_id debe provenir exclusivamente de auth.uid()');
    assert.equal(row.rows[0].public_token, res.public_token);

    const injectedRow = await db.query(`SELECT 1 FROM public.encuentros WHERE id = '${injectedId}';`);
    assert.equal(injectedRow.rows.length, 0, 'El ID inyectado no debe existir en la tabla');
  });

  test('8. Comprobar creación completa y atómica del encuentro y sus opciones con todas las columnas de coordinación', async () => {
    const d1 = futureDate(8);
    const d2 = futureDate(9);
    const deadline = new Date(Date.now() + 3 * 86_400_000).toISOString();

    const res = await callCrearCoordinacion(
      {
        titulo: 'Coordinación Completa Atómica',
        descripcion: 'Descripción detallada',
        modalidad: 'virtual',
        link_virtual: 'https://meet.example.com/atomica',
        tipo_invitacion: 'individual',
        tema: 'green',
        tema_invitacion: 'celebration',
        invitation_template: 'celebration_1',
        response_deadline: deadline,
        duration_minutes: 150,
        visibilidad_respuestas_invitados: 'detail',
        post_event_active_minutes: 90,
      },
      [
        { fecha: d1, hora_inicio: '20:00' },
        { fecha: d2, hora_inicio: '21:30' },
      ]
    );

    assert.equal(res.ok, true);
    const enc = (
      await db.query<any>(`SELECT * FROM public.encuentros WHERE id = '${res.id}';`)
    ).rows[0];

    assert.equal(enc.titulo, 'Coordinación Completa Atómica');
    assert.equal(enc.descripcion, 'Descripción detallada');
    assert.equal(enc.modalidad, 'virtual');
    assert.equal(enc.link_virtual, 'https://meet.example.com/atomica');
    assert.equal(enc.lugar_texto, null);
    assert.equal(enc.host_id, hostUser);
    assert.equal(enc.estado, 'activo');
    assert.equal(enc.date_mode, 'coordination');
    assert.equal(enc.coordination_status, 'open');
    assert.equal(enc.selected_option_id, null);
    assert.equal(enc.fecha, null);
    assert.equal(enc.hora, null);
    assert.equal(enc.duration_minutes, 150);
    assert.equal(enc.visibilidad_respuestas_invitados, 'detail');
    assert.equal(enc.mostrar_respuestas_a_invitados, true);
    assert.equal(enc.post_event_active_minutes, 90);
    assert.equal(enc.is_open, false);

    const opciones = (
      await db.query<any>(
        `SELECT fecha::text, hora_inicio::text, orden FROM public.encuentro_opciones_fecha WHERE encuentro_id = '${res.id}' ORDER BY orden ASC;`
      )
    ).rows;
    assert.equal(opciones.length, 2);
    assert.equal(opciones[0].fecha, d1);
    assert.equal(opciones[0].hora_inicio, '20:00:00');
    assert.equal(opciones[0].orden, 1);
    assert.equal(opciones[1].fecha, d2);
    assert.equal(opciones[1].hora_inicio, '21:30:00');
    assert.equal(opciones[1].orden, 2);
  });

  test('9. Repetir un encuentro con coordinación desde Favoritos utilizando el flujo real de creación', async () => {
    const d1 = futureDate(4);
    const d2 = futureDate(5);
    const dNew1 = futureDate(11);
    const dNew2 = futureDate(12);

    // 1. Crear encuentro de coordinación original usando la RPC real
    const origCreate = await callCrearCoordinacion(
      {
        titulo: 'Coordinación Mensual de Producto',
        descripcion: 'Elegir mejor horario',
        modalidad: 'presencial',
        lugar_texto: 'Cowork Güemes',
        tipo_invitacion: 'individual',
        tema: 'blue',
        tema_invitacion: 'formal',
        invitation_template: 'formal_minimal',
        duration_minutes: 75,
        visibilidad_respuestas_invitados: 'detail',
        post_event_active_minutes: 60,
      },
      [
        { fecha: d1, hora_inicio: '18:30' },
        { fecha: d2, hora_inicio: '19:30' },
      ],
      hostUser
    );
    assert.equal(origCreate.ok, true);
    const origId: string = origCreate.id;

    // 2. Enviar invitación interna en el encuentro original
    await setAuth(hostUser, false);
    await db.exec(`SET ROLE authenticated;`);
    let invRes: any;
    let saveFavRes: any;
    let getFavRes: any;
    try {
      invRes = parse(
        (
          await db.query<{ r: any }>(
            `SELECT public.enviar_invitacion_interna_seguro('${origId}', 'invitado@puntoencuentro.com', 'Sumate') AS r;`
          )
        ).rows[0].r
      );
      assert.equal(invRes.ok, true);

      // 3. Guardar como favorito con invitados
      saveFavRes = parse(
        (
          await db.query<{ r: any }>(
            `SELECT public.guardar_plantilla_encuentro_seguro('${origId}', 'Coordinación Producto Favorita', true) AS r;`
          )
        ).rows[0].r
      );
      assert.equal(saveFavRes.ok, true);
      assert.equal(saveFavRes.invitados_count, 1);

      // 4. Obtener plantilla para repetir
      getFavRes = parse(
        (
          await db.query<{ r: any }>(
            `SELECT public.get_plantilla_encuentro_seguro('${saveFavRes.id}', true) AS r;`
          )
        ).rows[0].r
      );
      assert.equal(getFavRes.ok, true);
    } finally {
      await db.exec(`RESET ROLE;`);
    }

    const reusablePayload = getFavRes.plantilla;
    assert.equal(reusablePayload.date_mode, 'coordination');
    assert.deepEqual(reusablePayload.invitados, ['invitado@puntoencuentro.com']);

    // 5. Hidratar store de coordinación mediante applyReusablePayload (flujo real del frontend)
    useCoordinationWizardStore.getState().resetDraft();
    useRepeatEncounterStore.getState().reset();

    const { route } = applyReusablePayload(reusablePayload, {
      ownerUserId: hostUser,
      includeGuests: true,
    });
    assert.equal(route, '/create/coordination');

    // El organizador define las nuevas opciones futuras en el wizard
    useCoordinationWizardStore.getState().setOptions([
      { localId: 'opt-1', date: dNew1, time: '19:00' },
      { localId: 'opt-2', date: dNew2, time: '20:00' },
    ]);

    const wizardDraft = useCoordinationWizardStore.getState().draft;
    assert.equal(wizardDraft.title, 'Coordinación Mensual de Producto');
    assert.equal(wizardDraft.durationMinutes, 75);
    assert.equal(wizardDraft.visibilidadRespuestas, 'detail');
    assert.equal(wizardDraft.responseDeadline, null);

    // 6. Ejecutar la RPC real crear_encuentro_con_opciones_seguro con el payload producido por el wizard
    const newCoordRes = await callCrearCoordinacion(
      {
        titulo: wizardDraft.title,
        descripcion: wizardDraft.description || null,
        modalidad: wizardDraft.modality,
        lugar_texto: wizardDraft.modality === 'presencial' ? wizardDraft.locationText || null : null,
        link_virtual: wizardDraft.modality === 'virtual' ? wizardDraft.virtualLink || null : null,
        tipo_invitacion: wizardDraft.invitationType,
        tema: 'blue',
        tema_invitacion: wizardDraft.invitationTheme || null,
        invitation_template: wizardDraft.invitationTemplate || null,
        response_deadline: wizardDraft.responseDeadline || null,
        duration_minutes: wizardDraft.durationMinutes,
        mostrar_respuestas_a_invitados: wizardDraft.mostrarRespuestasAInvitados,
        visibilidad_respuestas_invitados: wizardDraft.visibilidadRespuestas,
      },
      wizardDraft.options.map((o) => ({ fecha: o.date, hora_inicio: o.time })),
      hostUser
    );

    assert.equal(newCoordRes.ok, true, `Creación repetida falló: ${JSON.stringify(newCoordRes)}`);
    assert.notEqual(newCoordRes.id, origId, 'El encuentro repetido debe tener un ID nuevo');
    assert.notEqual(newCoordRes.public_token, origCreate.public_token, 'El encuentro repetido debe tener un public_token nuevo');

    // Vincular sesión de repetición al nuevo encuentro (tal como hace Step4Review.tsx)
    const bound = useRepeatEncounterStore.getState().bindEncuentro(newCoordRes.id, wizardDraft.repeatToken);
    assert.equal(bound, true, 'Los invitados quedan vinculados al nuevo encuentro para confirmación explícita');
    assert.equal(useRepeatEncounterStore.getState().targetEncuentroId, newCoordRes.id);
    assert.deepEqual(useRepeatEncounterStore.getState().guestEmails, ['invitado@puntoencuentro.com']);

    // Verificar que en BD NO se envió ninguna invitación automática al crear el nuevo encuentro
    const autoInvCount = await db.query<{ cnt: number }>(
      `SELECT count(*)::int AS cnt FROM public.solicitudes_invitacion_interna WHERE encuentro_id = '${newCoordRes.id}';`
    );
    assert.equal(autoInvCount.rows[0].cnt, 0, 'CERO invitaciones enviadas automáticamente');

    // Verificar que el encuentro original sigue intacto con sus opciones originales
    const origOpts = await db.query<{ fecha: string }>(
      `SELECT fecha::text FROM public.encuentro_opciones_fecha WHERE encuentro_id = '${origId}' ORDER BY orden ASC;`
    );
    assert.deepEqual(origOpts.rows.map((r) => r.fecha), [d1, d2]);
  });

  test('10. Validaciones antiabuso en link_general y no regresión en crear_encuentro_seguro (fecha fija) + rate limit', async () => {
    const d1 = futureDate(5);
    const d2 = futureDate(6);
    const countBefore = await getRateLimitCount(hostUser);

    // A. Antiabuso en crear_encuentro_con_opciones_seguro con link_general (phishing y XSS) -> bloqueado sin consumir rate limit
    const rPhishing = await callCrearCoordinacion(
      {
        titulo: 'Actualización de seguridad bancaria',
        descripcion: 'Ingresá tu contraseña y verificá tu clave bancaria antes de asistir',
        modalidad: 'presencial',
        lugar_texto: 'Centro',
        tipo_invitacion: 'link_general',
      },
      [
        { fecha: d1, hora_inicio: '18:00' },
        { fecha: d2, hora_inicio: '18:00' },
      ]
    );
    assert.equal(rPhishing.ok, false);
    assert.equal(rPhishing.error, 'private_content_blocked');
    assert.equal(rPhishing.reason, 'credential_theft');

    const rXss = await callCrearCoordinacion(
      {
        titulo: 'Reunión <script>alert(1)</script>',
        descripcion: 'Traer equipo',
        modalidad: 'presencial',
        lugar_texto: 'Centro',
        tipo_invitacion: 'link_general',
      },
      [
        { fecha: d1, hora_inicio: '18:00' },
        { fecha: d2, hora_inicio: '18:00' },
      ]
    );
    assert.equal(rXss.ok, false);
    assert.equal(rXss.error, 'private_content_blocked');
    assert.equal(rXss.reason, 'malicious_payload');

    const countAfterBlocked = await getRateLimitCount(hostUser);
    assert.equal(countAfterBlocked, countBefore, 'Bloqueo antiabuso no debe consumir rate limit');

    // B. Creación de encuentro de fecha fija (crear_encuentro_seguro) funciona sin regresión
    const rFixed = await callCrearFechaFija({
      titulo: 'Asado de fecha fija',
      descripcion: 'Nos vemos el viernes',
      fecha: d1,
      hora: '21:00',
      modalidad: 'presencial',
      lugar_texto: 'Quincho',
      tipo_invitacion: 'link_general',
      tema_invitacion: 'friends',
      post_event_active_minutes: 60,
    });
    assert.equal(rFixed.ok, true);
    assert.ok(rFixed.id);
    assert.ok(rFixed.public_token);

    // C. Rate limit enforcement cuando se alcanza el tope del bucket compartido
    await db.exec(`UPDATE public.rate_limit_policies SET max_requests = 1 WHERE action = 'create_encounter';`);
    const rRateLimited = await callCrearCoordinacion(
      {
        titulo: 'Encuentro que supera rate limit',
        modalidad: 'presencial',
        lugar_texto: 'Centro',
        tipo_invitacion: 'individual',
      },
      [
        { fecha: d1, hora_inicio: '18:00' },
        { fecha: d2, hora_inicio: '18:00' },
      ]
    );
    assert.deepEqual(rRateLimited, { ok: false, error: 'rate_limit_exceeded' });
  });
});
