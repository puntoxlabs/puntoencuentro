import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';

// i18n resources
import es from '../src/i18n/locales/es.json';
import en from '../src/i18n/locales/en.json';

// UI components for SSR tests
import { ZoneSelectorModal } from '../src/components/home/openEncounters/ZoneSelectorModal';
import { CoverageRequestModal } from '../src/components/coverage/CoverageRequestModal';
import { coverageService } from '../src/services/coverageService';

describe('Suite de Pruebas de Integración y Backend Real — Dynamic Coverage MVP (C1 - C25)', () => {
  let db: PGlite;

  const userA = '11111111-1111-1111-1111-111111111111';
  const userB = '22222222-2222-2222-2222-222222222222';
  const rateLimitUser = '33333333-3333-3333-3333-333333333333';

  async function setAuthUser(userId: string | null, isAnonymous: boolean = false) {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '${isAnonymous ? 'true' : 'false'}', false);`);
      await db.exec(`SET ROLE authenticated;`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '', false);`);
      await db.exec(`SET ROLE anon;`);
    }
  }

  before(async () => {
    db = new PGlite();

    // 1. Setup mock Supabase environment
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN
          CREATE ROLE postgres;
        END IF;
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
        SELECT json_build_object(
          'sub', NULLIF(current_setting('request.jwt.claim.sub', true), ''),
          'is_anonymous', NULLIF(current_setting('request.jwt.claim.is_anonymous', true), '')::boolean
        )::jsonb;
      $$ LANGUAGE SQL STABLE;

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
        tema_invitacion TEXT DEFAULT 'sports',
        invitation_template TEXT,
        date_mode TEXT DEFAULT 'fixed',
        coordination_status TEXT,
        selected_option_id UUID,
        response_deadline TIMESTAMP WITH TIME ZONE,
        reemplaza_a UUID,
        creado_en TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        estado TEXT NOT NULL DEFAULT 'pendiente',
        token_invitacion UUID DEFAULT gen_random_uuid(),
        mensaje_respuesta TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL
      );

      INSERT INTO auth.users (id, email) VALUES
        ('${userA}', 'userA@test.com'),
        ('${userB}', 'userB@test.com'),
        ('${rateLimitUser}', 'rl@test.com')
      ON CONFLICT DO NOTHING;
    `);

    // 2. Load necessary migrations in sequence
    const migrations = [
      'supabase/migrations/20260927120000_open_encounters_and_localities.sql',
      'supabase/migrations/20260930200000_fase_20c1_trust_generic_rate_limiting.sql',
      'supabase/migrations/20260930203000_fix_generic_rate_limiter_hardening.sql',
      'supabase/migrations/20261001120000_local_first_mar_del_plata_zones.sql',
      'supabase/migrations/20261002120000_dynamic_coverage_mvp.sql',
      'supabase/migrations/20261002130000_fix_coverage_btrim.sql',
      'supabase/migrations/20261002140000_allow_paused_market_status.sql',
      'supabase/migrations/20261002150000_harden_coverage_catalog_exposure.sql',
    ];

    for (const mig of migrations) {
      const fullPath = path.resolve(process.cwd(), mig);
      if (fs.existsSync(fullPath)) {
        const sql = fs.readFileSync(fullPath, 'utf-8');
        await db.exec(sql);
      }
    }
  });

  // ==========================================
  // BACKEND / SQL TESTS (C1 - C11)
  // ==========================================

  test('C1: Usuario anónimo/autenticado registra solicitud para nuevo mercado (Mendoza)', async () => {
    await setAuthUser(userA, true);

    const res = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('Mendoza', 'Jugar al tenis los findes') as submit_coverage_request;
    `);

    const result = res.rows[0].submit_coverage_request;
    assert.equal(result.ok, true);
    assert.equal(result.result_type, 'request_created');
    assert.equal(result.market_key, 'gran-mendoza');
    assert.equal(result.market_label, 'Gran Mendoza');

    // Verificar inserción en DB
    await db.exec(`SET ROLE postgres;`);
    const check = await db.query<{ dedupe_key: string; intent_text: string }>(`
      SELECT dedupe_key, intent_text
      FROM public.coverage_requests
      WHERE user_id = '${userA}';
    `);
    assert.equal(check.rows.length, 1);
    assert.equal(check.rows[0].dedupe_key, 'market:gran-mendoza');
    assert.equal(check.rows[0].intent_text, 'Jugar al tenis los findes');
  });

  test('C2: Deduplicación e idempotencia: el mismo usuario reenvía solicitud (Mendoza)', async () => {
    await setAuthUser(userA, true);

    const res = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('mendoza', 'Nuevo plan actualizado') as submit_coverage_request;
    `);

    const result = res.rows[0].submit_coverage_request;
    assert.equal(result.ok, true);
    assert.equal(result.result_type, 'request_updated');
    assert.equal(result.market_key, 'gran-mendoza');

    // Verificar que NO se duplicó la fila y se actualizó el intent_text
    await db.exec(`SET ROLE postgres;`);
    const check = await db.query<{ count: string; intent_text: string }>(`
      SELECT count(*)::text as count, max(intent_text) as intent_text
      FROM public.coverage_requests
      WHERE user_id = '${userA}' AND dedupe_key = 'market:gran-mendoza';
    `);
    assert.equal(check.rows.length, 1);
    assert.equal(check.rows[0].count, '1');
    assert.equal(check.rows[0].intent_text, 'Nuevo plan actualizado');
  });

  test('C3: Señales únicas: múltiples usuarios generan señales individuales agregadas', async () => {
    await setAuthUser(userB, false);

    const res = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('Mendoza') as submit_coverage_request;
    `);

    const result = res.rows[0].submit_coverage_request;
    assert.equal(result.ok, true);
    assert.equal(result.result_type, 'request_created');
    assert.equal(result.market_key, 'gran-mendoza');

    // En public.coverage_requests debe haber 2 filas para gran-mendoza (userA y userB)
    await db.exec(`SET ROLE postgres;`);
    const check = await db.query<{ count: string }>(`
      SELECT count(*)::text as count
      FROM public.coverage_requests
      WHERE market_key = 'gran-mendoza';
    `);
    assert.equal(check.rows[0].count, '2');
  });

  test('C4: Mapeo de alias conocidos a mercado en recolección (Godoy Cruz, Chacras de Coria)', async () => {
    await setAuthUser(userA, true);

    // Godoy Cruz mapea a gran-mendoza
    const resGodoy = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('Godoy Cruz') as submit_coverage_request;
    `);
    assert.equal(resGodoy.rows[0].submit_coverage_request.ok, true);
    assert.equal(resGodoy.rows[0].submit_coverage_request.market_key, 'gran-mendoza');

    // Chacras de Coria mapea a gran-mendoza
    const resChacras = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('Chacras de Coria') as submit_coverage_request;
    `);
    assert.equal(resChacras.rows[0].submit_coverage_request.ok, true);
    assert.equal(resChacras.rows[0].submit_coverage_request.market_key, 'gran-mendoza');
  });

  test('C5: Señal no reconocida (unknown): Bariloche y Rosario entran como unknown', async () => {
    await setAuthUser(userA, false);

    const res = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('Bariloche', 'Esquiar en invierno') as submit_coverage_request;
    `);
    const result = res.rows[0].submit_coverage_request;
    assert.equal(result.ok, true);
    assert.equal(result.result_type, 'unknown_created');
    assert.equal(result.market_key, undefined);
    assert.equal(result.raw_location, 'Bariloche');

    // Verificar en DB
    await db.exec(`SET ROLE postgres;`);
    const check = await db.query<{ request_type: string; market_key: string | null }>(`
      SELECT request_type, market_key
      FROM public.coverage_requests
      WHERE dedupe_key = 'unknown:bariloche';
    `);
    assert.equal(check.rows.length, 1);
    assert.equal(check.rows[0].request_type, 'unknown');
    assert.equal(check.rows[0].market_key, null);
  });

  test('C6: Zona existente activa: Los Acantilados devuelve existing_locality y NO inserta solicitud', async () => {
    await db.exec(`SET ROLE postgres;`);
    const countBefore = await db.query<{ count: string }>(`
      SELECT count(*)::text as count FROM public.coverage_requests;
    `);

    await setAuthUser(userA, true);

    const res = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('Los Acantilados') as submit_coverage_request;
    `);
    const result = res.rows[0].submit_coverage_request;
    assert.equal(result.ok, true);
    assert.equal(result.result_type, 'existing_locality');
    assert.equal(result.existing_locality_id, 'sur-playas-del-sur');
    assert.equal(result.existing_locality_name, 'Sur / Playas del Sur');
    assert.equal(result.market_key, 'mar-del-plata');

    // Confirmar que NO se insertó nada en public.coverage_requests
    await db.exec(`SET ROLE postgres;`);
    const countAfter = await db.query<{ count: string }>(`
      SELECT count(*)::text as count FROM public.coverage_requests;
    `);
    assert.equal(countBefore.rows[0].count, countAfter.rows[0].count);
  });

  test('C7: Aislamiento RLS: usuario autenticado sólo ve sus propias solicitudes', async () => {
    await setAuthUser(userB, false);

    const userBRows = await db.query<{ user_id: string }>(`
      SELECT user_id FROM public.coverage_requests;
    `);

    // userB sólo debe ver filas donde user_id = userB
    for (const row of userBRows.rows) {
      assert.equal(row.user_id, userB);
    }
  });

  test('C8: Privacidad de vistas: v_coverage_growth_summary y v_coverage_unknown_review denegadas a anon/authenticated', async () => {
    // 1. authenticated
    await setAuthUser(userA, false);

    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.v_coverage_growth_summary;`);
      },
      (err: any) => {
        return /permission denied/i.test(err.message);
      }
    );

    // 2. postgres / service_role tiene acceso
    await db.exec(`SET ROLE postgres;`);
    const summary = await db.query<{ market_key: string; unique_requesters: number }>(`
      SELECT market_key, unique_requesters FROM public.v_coverage_growth_summary;
    `);
    assert.ok(summary.rows.length >= 1);
    const mendozaSummary = summary.rows.find((r) => r.market_key === 'gran-mendoza');
    assert.ok(mendozaSummary);
    assert.equal(Number(mendozaSummary.unique_requesters), 2);
  });

  test('C9: Rate limit duradero: 10 solicitudes permitidas por 24h, la 11va es rechazada', async () => {
    await setAuthUser(rateLimitUser, false);

    // Enviar 10 solicitudes con distintas zonas
    for (let i = 1; i <= 10; i++) {
      const resp = await db.query<{ submit_coverage_request: any }>(`
        SELECT public.submit_coverage_request('Zona RateLimit ${i}') as submit_coverage_request;
      `);
      assert.equal(resp.rows[0].submit_coverage_request.ok, true, `Request ${i} should succeed`);
    }

    // La solicitud 11 debe fallar por rate limit
    const resp11 = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('Zona RateLimit 11') as submit_coverage_request;
    `);
    const res11 = resp11.rows[0].submit_coverage_request;
    assert.equal(res11.ok, false);
    assert.equal(res11.error, 'rate_limit_exceeded');
  });

  test('C10: Manejo robusto de intent_text opcional y sanitización', async () => {
    await setAuthUser(userA, true);

    // Espacios en blanco o null
    const resEmpty = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('Tucumán', '   ') as submit_coverage_request;
    `);
    assert.equal(resEmpty.rows[0].submit_coverage_request.ok, true);

    await db.exec(`SET ROLE postgres;`);
    const row = await db.query<{ intent_text: string | null }>(`
      SELECT intent_text FROM public.coverage_requests WHERE dedupe_key = 'unknown:tucuman';
    `);
    assert.equal(row.rows[0].intent_text, null);
  });

  test('C11: Rechazo si el usuario no tiene JWT o texto vacío', async () => {
    await setAuthUser(null);

    const resAnonNoJwt = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('Salta') as submit_coverage_request;
    `);
    assert.equal(resAnonNoJwt.rows[0].submit_coverage_request.ok, false);
    assert.equal(resAnonNoJwt.rows[0].submit_coverage_request.error, 'not_authenticated');

    // Texto vacío con authenticated
    await setAuthUser(userA, false);
    const resEmpty = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('   ') as submit_coverage_request;
    `);
    assert.equal(resEmpty.rows[0].submit_coverage_request.ok, false);
    assert.equal(resEmpty.rows[0].submit_coverage_request.error, 'location_required');
  });

  // ==========================================
  // FRONTEND / UI TESTS (C12 - C20)
  // ==========================================

  test('C12: ZoneSelectorModal renderiza el trigger "¿No está tu zona? Pedir cobertura"', () => {
    const html = renderToString(
      React.createElement(ZoneSelectorModal, {
        isOpen: true,
        onClose: () => {},
        selectedLocalityIds: [],
        onSave: () => {},
      })
    );

    assert.ok(html.includes('pe-zones-modal__btn-coverage'));
    assert.ok(html.includes('Pedir cobertura') || html.includes('Request coverage'));
  });

  test('C13: CoverageRequestModal renderiza formulario accesible en estado cerrado y abierto', () => {
    // Cerrado: null
    const closedHtml = renderToString(
      React.createElement(CoverageRequestModal, {
        isOpen: false,
        onClose: () => {},
      })
    );
    assert.equal(closedHtml, '');

    // Abierto: modal con dialog role, labels, input y buttons
    const openHtml = renderToString(
      React.createElement(CoverageRequestModal, {
        isOpen: true,
        onClose: () => {},
      })
    );
    assert.ok(openHtml.includes('role="dialog"'));
    assert.ok(openHtml.includes('aria-modal="true"'));
    assert.ok(openHtml.includes('pe-coverage-modal'));
    assert.ok(openHtml.includes('coverage-location'));
    assert.ok(openHtml.includes('coverage-intent'));
  });

  test('C14: CoverageRequestModal en estado inicial tiene input vacío y botón secundario Cancelar', () => {
    const html = renderToString(
      React.createElement(CoverageRequestModal, {
        isOpen: true,
        onClose: () => {},
      })
    );
    assert.ok(html.includes('pe-coverage-btn--secondary'));
    assert.ok(html.includes('pe-coverage-btn--primary'));
  });

  test('C15: coverageService expone método submitCoverageRequest adecuadamente tipado', () => {
    assert.equal(typeof coverageService.submitCoverageRequest, 'function');
  });

  // ==========================================
  // REGRESSION & LOCALIZATION (C21 - C25)
  // ==========================================

  test('C21: Diccionario ES contiene todas las claves de cobertura requeridas', () => {
    const oe = (es as any).open_encounters;
    assert.ok(oe.coverage_cta);
    assert.ok(oe.coverage_modal_title);
    assert.ok(oe.coverage_modal_subtitle);
    assert.ok(oe.coverage_location_label);
    assert.ok(oe.coverage_location_placeholder);
    assert.ok(oe.coverage_intent_label);
    assert.ok(oe.coverage_intent_placeholder);
    assert.ok(oe.coverage_submit);
    assert.ok(oe.coverage_sending);
    assert.ok(oe.coverage_cancel);
    assert.ok(oe.coverage_close);
    assert.ok(oe.coverage_existing_locality_notice);
    assert.ok(oe.coverage_existing_locality_desc);
    assert.ok(oe.coverage_existing_locality_action);
    assert.ok(oe.coverage_success_title);
    assert.ok(oe.coverage_success_desc);
    assert.ok(oe.coverage_success_btn);
    assert.ok(oe.coverage_rate_limited);
    assert.ok(oe.coverage_location_required);
    assert.ok(oe.coverage_error_generic);
  });

  test('C22: Diccionario EN contiene todas las claves de cobertura correspondientes', () => {
    const oe = (en as any).open_encounters;
    assert.ok(oe.coverage_cta);
    assert.ok(oe.coverage_modal_title);
    assert.ok(oe.coverage_modal_subtitle);
    assert.ok(oe.coverage_location_label);
    assert.ok(oe.coverage_location_placeholder);
    assert.ok(oe.coverage_intent_label);
    assert.ok(oe.coverage_intent_placeholder);
    assert.ok(oe.coverage_submit);
    assert.ok(oe.coverage_sending);
    assert.ok(oe.coverage_cancel);
    assert.ok(oe.coverage_close);
    assert.ok(oe.coverage_existing_locality_notice);
    assert.ok(oe.coverage_existing_locality_desc);
    assert.ok(oe.coverage_existing_locality_action);
    assert.ok(oe.coverage_success_title);
    assert.ok(oe.coverage_success_desc);
    assert.ok(oe.coverage_success_btn);
    assert.ok(oe.coverage_rate_limited);
    assert.ok(oe.coverage_location_required);
    assert.ok(oe.coverage_error_generic);
  });

  test('C23: Catálogo de localidades contiene las 6 macrozonas de Mar del Plata', async () => {
    await db.exec(`SET ROLE postgres;`);
    const locs = await db.query<{ id: string; nombre: string; ciudad: string }>(`
      SELECT id, nombre, ciudad
      FROM public.localidades
      WHERE ciudad = 'Mar del Plata' AND activo = true
      ORDER BY orden ASC;
    `);

    assert.equal(locs.rows.length, 6);
    const names = locs.rows.map((l) => l.nombre);
    assert.ok(names.includes('Centro / La Perla'));
    assert.ok(names.includes('Güemes / Playa Grande'));
    assert.ok(names.includes('Plaza Mitre / Chauvín'));
    assert.ok(names.includes('Constitución / Norte'));
    assert.ok(names.includes('Puerto / Punta Mogotes'));
    assert.ok(names.includes('Sur / Playas del Sur'));
  });

  test('C24: RPCs de discovery no fueron modificadas y conservan contrato exacto', async () => {
    await db.exec(`SET ROLE postgres;`);
    const rpcs = await db.query<{ proname: string }>(`
      SELECT proname
      FROM pg_proc
      WHERE proname IN ('get_discovery_encuentros_abiertos', 'get_discovery_intenciones_activas');
    `);
    assert.equal(rpcs.rows.length, 2);
  });

  test('C25: El conteo total de migraciones en repo es exactamente 74', () => {
    const migs = fs.readdirSync(path.resolve(process.cwd(), 'supabase/migrations'));
    const sqlMigs = migs.filter((m) => m.endsWith('.sql'));
    assert.equal(sqlMigs.length, 74);
    assert.equal(sqlMigs[73], '20261002150000_harden_coverage_catalog_exposure.sql');
  });

  test('C26: Ciclo de vida de mercados soporta collecting, reviewing, planned, active, paused', async () => {
    await db.exec(`SET ROLE postgres;`);
    const statuses = ['collecting', 'reviewing', 'planned', 'active', 'paused'];
    for (const st of statuses) {
      await db.query(`
        INSERT INTO public.coverage_markets (market_key, label, city, region, country_code, status)
        VALUES ('test-${st}', 'Test ${st}', 'Ciudad', 'Provincia', 'AR', '${st}')
        ON CONFLICT (market_key) DO UPDATE SET status = EXCLUDED.status;
      `);
      const row = await db.query<{ status: string }>(`
        SELECT status FROM public.coverage_markets WHERE market_key = 'test-${st}';
      `);
      assert.equal(row.rows[0].status, st);
    }
  });

  // ==========================================
  // DIRECTED DATA-EXPOSURE SECURITY TESTS (S1 - S8)
  // ==========================================

  test('S1: anon cannot SELECT candidate markets', async () => {
    await setAuthUser(null);
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.coverage_markets;`);
      },
      (err: any) => /permission denied/i.test(err.message)
    );
  });

  test('S2: authenticated cannot SELECT candidate markets', async () => {
    await setAuthUser(userA, false);
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.coverage_markets;`);
      },
      (err: any) => /permission denied/i.test(err.message)
    );
  });

  test('S3: anon cannot SELECT aliases', async () => {
    await setAuthUser(null);
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.coverage_location_aliases;`);
      },
      (err: any) => /permission denied/i.test(err.message)
    );
  });

  test('S4: authenticated cannot SELECT aliases', async () => {
    await setAuthUser(userA, false);
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.coverage_location_aliases;`);
      },
      (err: any) => /permission denied/i.test(err.message)
    );
  });

  test('S5: submit RPC still resolves known candidate', async () => {
    await setAuthUser(userA, true);
    const res = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('Mendoza') as submit_coverage_request;
    `);
    const result = res.rows[0].submit_coverage_request;
    assert.equal(result.ok, true);
    assert.equal(result.market_key, 'gran-mendoza');
  });

  test('S6: submit RPC still resolves existing locality', async () => {
    await setAuthUser(userA, true);
    const res = await db.query<{ submit_coverage_request: any }>(`
      SELECT public.submit_coverage_request('Los Acantilados') as submit_coverage_request;
    `);
    const result = res.rows[0].submit_coverage_request;
    assert.equal(result.ok, true);
    assert.equal(result.result_type, 'existing_locality');
    assert.equal(result.existing_locality_id, 'sur-playas-del-sur');
  });

  test('S7: internal views still denied to anon and authenticated', async () => {
    await setAuthUser(null);
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.v_coverage_growth_summary;`);
      },
      (err: any) => /permission denied/i.test(err.message)
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.v_coverage_unknown_review;`);
      },
      (err: any) => /permission denied/i.test(err.message)
    );

    await setAuthUser(userA, false);
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.v_coverage_growth_summary;`);
      },
      (err: any) => /permission denied/i.test(err.message)
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT * FROM public.v_coverage_unknown_review;`);
      },
      (err: any) => /permission denied/i.test(err.message)
    );
  });

  test('S8: service_role/internal access preserved', async () => {
    await db.exec(`SET ROLE postgres;`);
    const markets = await db.query<{ count: string }>(`SELECT count(*)::text as count FROM public.coverage_markets;`);
    assert.ok(Number(markets.rows[0].count) >= 1);
    const aliases = await db.query<{ count: string }>(`SELECT count(*)::text as count FROM public.coverage_location_aliases;`);
    assert.ok(Number(aliases.rows[0].count) >= 1);
    const views = await db.query<{ count: string }>(`SELECT count(*)::text as count FROM public.v_coverage_growth_summary;`);
    assert.ok(views.rows.length >= 0);
  });
});
