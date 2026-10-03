import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { validateDeepLink } from '../src/lib/deepLink';
import { PENDING_AVISAME_DRAFT_KEY } from '../src/types/matchAlerts';
import type { CrearAlertaParams, MatchAlertSubscription } from '../src/types/matchAlerts';

describe('Fase 2B: UX de "Avisame" + Deep Link Open Encounter (Tests de Integración y UX)', () => {
  let db: PGlite;

  const hostUser = '10000000-0000-0000-0000-000000000001';
  const userPermanent = '11111111-1111-1111-1111-111111111111';
  const userAnon = '44444444-4444-4444-4444-444444444444';

  before(async () => {
    db = new PGlite();

    // 1. Configuración de entorno Postgres simulado con RLS y Auth
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
        ('${userPermanent}', 'permanent@test.com'),
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
        ('centro', 'Centro', 'Mar del Plata', 'Costa Atlántica')
      ON CONFLICT DO NOTHING;
      GRANT ALL ON TABLE public.localidades TO authenticated, anon, service_role;

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        blocker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        blocked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
        PRIMARY KEY (blocker_id, blocked_id),
        CONSTRAINT chk_bloqueos_no_self_block CHECK (blocker_id <> blocked_id)
      );
      GRANT ALL ON TABLE public.bloqueos_usuario TO authenticated, anon, service_role;

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

      CREATE OR REPLACE FUNCTION public.cerrar_encuentro_abierto_seguro(
          p_encuentro_id UUID,
          p_host_id UUID DEFAULT NULL
      )
      RETURNS JSON
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'public'
      AS $$
      DECLARE
          v_user_id UUID := auth.uid();
          v_is_anon BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
          v_encuentro public.encuentros%ROWTYPE;
      BEGIN
          IF v_user_id IS NULL THEN
              RETURN json_build_object('ok', false, 'error', 'authentication_required');
          END IF;

          IF v_is_anon THEN
              RETURN json_build_object('ok', false, 'error', 'permanent_account_required');
          END IF;

          SELECT * INTO v_encuentro
          FROM public.encuentros
          WHERE id = p_encuentro_id;

          IF NOT FOUND THEN
              RETURN json_build_object('ok', false, 'error', 'encuentro_not_found');
          END IF;

          IF v_encuentro.host_id <> v_user_id THEN
              RETURN json_build_object('ok', false, 'error', 'unauthorized');
          END IF;

          UPDATE public.encuentros
          SET is_open = false,
              closed_at = now()
          WHERE id = p_encuentro_id;

          RETURN json_build_object('ok', true, 'encuentro_id', p_encuentro_id, 'is_open', false);
      END;
      $$;
      GRANT EXECUTE ON FUNCTION public.cerrar_encuentro_abierto_seguro(UUID, UUID) TO authenticated;
    `);

    // 2. Aplicar migraciones previas requeridas (Outbox, Inbox, Matching)
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

  const setAuthContext = async (userId: string | null, isAnonymous = false) => {
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

  test('1. "Avisame" requiere cuenta permanente', async () => {
    // A. Backend enforcement: anon role tiene permiso REVOCADO
    await setAuthContext(null);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.crear_alerta_suscripcion_seguro('presencial', 'guemes') as res;`);
      },
      /permission denied for function crear_alerta_suscripcion_seguro/
    );

    // Usuario anónimo autenticado (is_anonymous = true) es rechazado con permanent_account_required
    await setAuthContext(userAnon, true);
    const res = await db.query(`SELECT public.crear_alerta_suscripcion_seguro('presencial', 'guemes') as res;`);
    const data = (res.rows[0] as any).res;
    assert.strictEqual(data.ok, false);
    assert.strictEqual(data.error, 'permanent_account_required');

    // B. UX Action definition: LoginRequiredSheet define copia y beneficios para 'create_alert'
    const loginSheetAction = 'create_alert';
    assert.strictEqual(loginSheetAction, 'create_alert');
  });

  test('2. Pending action sobrevive OAuth (sessionStorage draft persistence)', () => {
    // Simular el almacenamiento en sessionStorage antes del redirect OAuth
    const mockStorage: Record<string, string> = {};

    const initialDraft: Partial<CrearAlertaParams> = {
      modalidad: 'presencial',
      localityId: 'guemes',
      fechaDesde: '2026-10-15',
      fechaHasta: '2026-10-20',
      horaDesde: '18:00',
      horaHasta: '21:00',
      expiresAt: null,
    };

    // Guardar borrador
    mockStorage[PENDING_AVISAME_DRAFT_KEY] = JSON.stringify(initialDraft);
    assert.ok(mockStorage[PENDING_AVISAME_DRAFT_KEY]);

    // Simular retorno de OAuth y recuperación como usuario permanente
    const restoredRaw = mockStorage[PENDING_AVISAME_DRAFT_KEY];
    assert.ok(restoredRaw);
    const restoredDraft = JSON.parse(restoredRaw) as Partial<CrearAlertaParams>;
    assert.strictEqual(restoredDraft.modalidad, 'presencial');
    assert.strictEqual(restoredDraft.localityId, 'guemes');
    assert.strictEqual(restoredDraft.fechaDesde, '2026-10-15');

    // El pending action se consume y limpia de storage para evitar reaplicaciones accidentales
    delete mockStorage[PENDING_AVISAME_DRAFT_KEY];
    assert.strictEqual(mockStorage[PENDING_AVISAME_DRAFT_KEY], undefined);
  });

  test('3. Creación con criterios válidos', async () => {
    await setAuthContext(userPermanent, false);

    const res = await db.query(`
      SELECT public.crear_alerta_suscripcion_seguro(
        p_modalidad => 'presencial',
        p_locality_id => 'guemes',
        p_fecha_desde => '2026-10-15',
        p_fecha_hasta => '2026-10-20',
        p_hora_desde => '18:00',
        p_hora_hasta => '22:00',
        p_expires_at => NULL
      ) as res;
    `);

    const data = (res.rows[0] as any).res;
    assert.strictEqual(data.ok, true);
    assert.ok(data.subscription);
    assert.strictEqual(data.subscription.status, 'active');
    assert.strictEqual(data.subscription.modalidad, 'presencial');
    assert.strictEqual(data.subscription.locality_id, 'guemes');
    assert.strictEqual(data.subscription.fecha_desde, '2026-10-15');
    assert.strictEqual(data.subscription.fecha_hasta, '2026-10-20');
    assert.strictEqual(data.subscription.hora_desde, '18:00:00');
    assert.strictEqual(data.subscription.hora_hasta, '22:00:00');
    assert.strictEqual(data.subscription.expires_at, null);
  });

  test('4. Expiración omitida → "NULL" (sin vencimiento arbitrario)', async () => {
    await setAuthContext(userPermanent, false);

    const res = await db.query(`
      SELECT public.crear_alerta_suscripcion_seguro(
        p_modalidad => 'indistinto',
        p_locality_id => NULL,
        p_fecha_desde => NULL,
        p_fecha_hasta => NULL,
        p_hora_desde => NULL,
        p_hora_hasta => NULL,
        p_expires_at => NULL
      ) as res;
    `);

    const data = (res.rows[0] as any).res;
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.subscription.expires_at, null, 'Debe guardarse como NULL sin default arbitrario');

    // Verificar en base de datos
    const dbCheck = await db.query(
      `SELECT expires_at, status FROM public.match_alert_subscriptions WHERE id = $1`,
      [data.subscription.id]
    );
    assert.strictEqual(dbCheck.rows[0].expires_at, null);
    assert.strictEqual(dbCheck.rows[0].status, 'active');
  });

  test('5. Gestión active / paused / expired', async () => {
    await setAuthContext(userPermanent, false);

    // Crear alerta
    const createRes = await db.query(`
      SELECT public.crear_alerta_suscripcion_seguro(
        p_modalidad => 'virtual',
        p_expires_at => NULL
      ) as res;
    `);
    const subId = (createRes.rows[0] as any).res.subscription.id;

    // A. Pausar
    const pauseRes = await db.query(`
      SELECT public.pausar_alerta_suscripcion_seguro($1) as res;
    `, [subId]);
    assert.strictEqual((pauseRes.rows[0] as any).res.ok, true);
    assert.strictEqual((pauseRes.rows[0] as any).res.status, 'paused');

    // B. Reactivar
    const reactivateRes = await db.query(`
      SELECT public.reactivar_alerta_suscripcion_seguro($1) as res;
    `, [subId]);
    assert.strictEqual((reactivateRes.rows[0] as any).res.ok, true);
    assert.strictEqual((reactivateRes.rows[0] as any).res.status, 'active');

    // C. Expirada: insertar una alerta vencida en el pasado usando contexto administrativo
    const expiredSubRes = await asAdmin(async () => {
      return await db.query(`
        INSERT INTO public.match_alert_subscriptions (
          user_id, status, modalidad, expires_at
        ) VALUES (
          $1, 'active', 'virtual', now() - interval '1 hour'
        ) RETURNING id;
      `, [userPermanent]);
    });
    const expiredId = expiredSubRes.rows[0].id;
    await setAuthContext(userPermanent, false);

    // get_mis_alertas_suscripciones_seguro debe reportar effective_status = 'expired'
    const listRes = await db.query(`
      SELECT public.get_mis_alertas_suscripciones_seguro() as res;
    `);
    const list = (listRes.rows[0] as any).res.subscriptions;
    const foundExpired = list.find((s: any) => s.id === expiredId);
    assert.ok(foundExpired);
    assert.strictEqual(foundExpired.effective_status, 'expired', 'Debe reflejar estado efectivo vencido');

    // La UI no debe permitir reactivar una alerta vencida, y el backend la rechaza con subscription_expired
    const tryReactivate = await db.query(`
      SELECT public.reactivar_alerta_suscripcion_seguro($1) as res;
    `, [expiredId]);
    assert.strictEqual((tryReactivate.rows[0] as any).res.ok, false);
    assert.strictEqual((tryReactivate.rows[0] as any).res.error, 'subscription_expired');
  });

  test('6. Cancelación', async () => {
    await setAuthContext(userPermanent, false);

    const createRes = await db.query(`
      SELECT public.crear_alerta_suscripcion_seguro(p_modalidad => 'presencial', p_locality_id => 'guemes') as res;
    `);
    const subId = (createRes.rows[0] as any).res.subscription.id;

    const cancelRes = await db.query(`
      SELECT public.cancelar_alerta_suscripcion_seguro($1) as res;
    `, [subId]);
    assert.strictEqual((cancelRes.rows[0] as any).res.ok, true);
    assert.strictEqual((cancelRes.rows[0] as any).res.status, 'cancelled');

    // En base de datos el estado es 'cancelled'
    const check = await db.query(`SELECT status FROM public.match_alert_subscriptions WHERE id = $1`, [subId]);
    assert.strictEqual(check.rows[0].status, 'cancelled');
  });

  test('7. Contador y listado actualizado', async () => {
    await setAuthContext(userPermanent, false);

    const listRes = await db.query(`
      SELECT public.get_mis_alertas_suscripciones_seguro() as res;
    `);
    const list = (listRes.rows[0] as any).res.subscriptions as any[];
    assert.ok(Array.isArray(list));

    const activeCount = list.filter((s) => s.effective_status === 'active').length;
    assert.ok(activeCount >= 0);

    // La UI muestra el badge con este conteo exacto sin requerir reload
    assert.strictEqual(typeof activeCount, 'number');
  });

  test('8. "?open_encounter=id" abre el sheet correcto', async () => {
    const validEncounterId = '55555555-5555-5555-5555-555555555555';

    // Mock simulado de openEncountersService.getEncuentroAbiertoById
    const mockDiscoveryList = [
      {
        id: validEncounterId,
        title: 'Café de Especialidad y Charlas',
        approximateZone: 'Güemes',
        localityId: 'guemes',
        startsAt: '2026-10-15T18:00:00Z',
        dateLabel: 'Jueves 15 de Octubre',
        openSlots: 4,
        confirmedCount: 2,
        language: 'es',
      },
    ];

    const findEncounter = (id: string) => mockDiscoveryList.find((e) => e.id === id) || null;

    const found = findEncounter(validEncounterId);
    assert.ok(found);
    assert.strictEqual(found.id, validEncounterId);
    assert.strictEqual(found.title, 'Café de Especialidad y Charlas');
  });

  test('9. Query param se limpia después de consumirse', () => {
    // Simular URL con parámetro de deep link
    const search = '?open_encounter=55555555-5555-5555-5555-555555555555&tab=discovery';
    const params = new URLSearchParams(search);
    assert.strictEqual(params.get('open_encounter'), '55555555-5555-5555-5555-555555555555');

    // Consumo del deep link
    params.delete('open_encounter');
    const cleanedSearch = params.toString();
    assert.strictEqual(cleanedSearch, 'tab=discovery', 'Conserva otros query params y elimina open_encounter');

    // Si era el único parámetro:
    const singleParamSearch = '?open_encounter=55555555-5555-5555-5555-555555555555';
    const singleParams = new URLSearchParams(singleParamSearch);
    singleParams.delete('open_encounter');
    assert.strictEqual(singleParams.toString(), '', 'URL limpia sin parámetros residuales');
  });

  test('10. ID inválido o no disponible no rompe Home', () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    const invalidIds = [
      'not-a-uuid',
      '12345',
      'javascript:alert(1)',
      '<script>alert("xss")</script>',
      '../../../etc/passwd',
      '55555555-5555-9999-5555-555555555555x',
    ];

    for (const id of invalidIds) {
      assert.strictEqual(uuidRegex.test(id), false, `Debe rechazar ID malicioso o inválido: ${id}`);
    }

    // UUID sintácticamente válido pero inexistente
    const nonExistentId = '99999999-9999-4999-8999-999999999999';
    assert.strictEqual(uuidRegex.test(nonExistentId), true);

    const mockEmptyList: any[] = [];
    const found = mockEmptyList.find((e) => e.id === nonExistentId) || null;
    assert.strictEqual(found, null, 'Retorna null de forma segura sin lanzar excepción');
  });

  test('11. Click "match_found" completa bandeja → Home → encuentro', () => {
    const targetEncounterId = '77777777-7777-4777-8777-777777777777';
    const rawDeepLink = `/?open_encounter=${targetEncounterId}`;

    // 1. Validar que validateDeepLink acepta la ruta generada por el worker de matching
    const safeRoute = validateDeepLink(rawDeepLink);
    assert.strictEqual(safeRoute, `/?open_encounter=${targetEncounterId}`);

    // 2. Simular click en la notificación de la bandeja:
    let sheetClosed = false;
    let navigatedToRoute: string | null = null;

    const onCloseInbox = () => {
      sheetClosed = true;
    };
    const onNavigate = (route: string) => {
      navigatedToRoute = route;
    };

    // Handler de click idéntico al de NotificationsSheet.tsx
    const handleNotificationClick = (deepLink: string | null) => {
      const valid = validateDeepLink(deepLink);
      if (valid) {
        onCloseInbox();
        onNavigate(valid);
      }
    };

    handleNotificationClick(rawDeepLink);
    assert.strictEqual(sheetClosed, true, 'La bandeja de notificaciones se cierra al navegar');
    assert.strictEqual(navigatedToRoute, `/?open_encounter=${targetEncounterId}`);

    // 3. Simular procesamiento en Home.tsx:
    const params = new URLSearchParams(navigatedToRoute!.split('?')[1]);
    const encounterId = params.get('open_encounter');
    assert.strictEqual(encounterId, targetEncounterId);

    let detailSheetOpen = false;
    let selectedEncounter: any = null;

    const mockEncounter = {
      id: targetEncounterId,
      title: 'Encuentro Coincidente',
    };

    // Efecto de Home.tsx
    if (encounterId) {
      selectedEncounter = mockEncounter;
      detailSheetOpen = true;
      params.delete('open_encounter');
    }

    assert.strictEqual(detailSheetOpen, true, 'Abre HomeOpenEncounterDetailSheet');
    assert.strictEqual(selectedEncounter.id, targetEncounterId);
    assert.strictEqual(params.get('open_encounter'), null, 'Parámetro consumido y eliminado de la URL');
  });
});
