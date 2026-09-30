import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-C1: Micro-fix Momento de Alerta + Privacidad DTO', () => {
  let db: PGlite;
  const userA = '11111111-1111-1111-1111-111111111111'; // Creador intención y encuentro
  const userB = '22222222-2222-2222-2222-222222222222'; // Interesado 1
  const userC = '33333333-3333-3333-3333-333333333333'; // Interesado 2
  const userD = '44444444-4444-4444-4444-444444444444'; // Sin interés
  const userAnon = '55555555-5555-5555-5555-555555555555'; // Usuario anónimo

  let sharedIntencionId: string = '';
  let sharedEncuentroId: string = '';
  let alertaBId: string = '';
  let alertaCId: string = '';

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
          NEW.updated_at = now();
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      INSERT INTO auth.users (id, email) VALUES
        ('${userA}', 'userA@test.com'),
        ('${userB}', 'userB@test.com'),
        ('${userC}', 'userC@test.com'),
        ('${userD}', 'userD@test.com'),
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
        ('caba_palermo', 'Palermo', 'CABA', 'CABA Norte')
      ON CONFLICT DO NOTHING;

      -- Base encuentros table con soporte de columnas para alertas y discovery
      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha DATE,
        hora TIME,
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
        estado TEXT NOT NULL DEFAULT 'pendiente',
        user_id UUID,
        creado_en TIMESTAMPTZ DEFAULT now()
      );
      GRANT ALL ON TABLE public.participantes TO authenticated, anon, service_role;
    `);

    // 2. Cargar migraciones en orden cronológico
    const migrations = [
      'supabase/migrations/20260929170000_fase_20a_intenciones_core.sql',
      'supabase/migrations/20260929180000_fase_20a_intenciones_conversion.sql',
      'supabase/migrations/20260929190000_fase_20b_discovery_intenciones.sql',
      'supabase/migrations/20260929200000_fase_20b_set_interes_intencion.sql',
      'supabase/migrations/20260929210000_fase_20c1_alertas_caso_c.sql',
      'supabase/migrations/20260930093500_fix_fase_20c1_alertas_open_encounter.sql',
    ];

    for (const mig of migrations) {
      const sql = fs.readFileSync(path.join(process.cwd(), mig), 'utf8');
      await db.exec(sql);
    }

    await db.exec(`
      GRANT ALL ON TABLE public.intencion_intereses TO authenticated, service_role, postgres;
    `);
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

  test('1. Setup previo: User A crea intención, B y C marcan interés, D no marca', async () => {
    await setAuthContext(userA, false);
    const { rows: intRows }: any = await db.query(`
      SELECT public.crear_intencion_segura(
        'Jugar al Pádel Sábado',
        'Busco gente para completar pareja',
        'Este fin de semana',
        '2026-10-05',
        '2026-10-05',
        'presencial',
        'caba_palermo'
      ) AS res;
    `);
    assert.equal(intRows[0].res.ok, true);
    sharedIntencionId = intRows[0].res.id;

    // B marca interés
    await setAuthContext(userB, false);
    const { rows: bRows }: any = await db.query(`
      SELECT public.set_interes_intencion('${sharedIntencionId}', true) AS res;
    `);
    assert.equal(bRows[0].res.ok, true);
    assert.equal(bRows[0].res.interesado, true);

    // C marca interés
    await setAuthContext(userC, false);
    const { rows: cRows }: any = await db.query(`
      SELECT public.set_interes_intencion('${sharedIntencionId}', true) AS res;
    `);
    assert.equal(cRows[0].res.ok, true);
    assert.equal(cRows[0].res.interesado, true);

    // A crea un encuentro PRIVADO (is_open = false por defecto)
    await setAuthContext(userA, false);
    const { rows: encRows }: any = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, descripcion, fecha, hora, modalidad, locality_id, is_open)
      VALUES ('${userA}', 'Torneo Pádel Palermo', 'Nos juntamos a jugar', '2026-10-05', '18:00', 'presencial', 'caba_palermo', false)
      RETURNING id;
    `);
    sharedEncuentroId = encRows[0].id;
  });

  test('2. Conversión a encuentro privado (is_open = false): NO genera alertas pero vincula intención', async () => {
    await setAuthContext(userA, false);
    const { rows: convRows }: any = await db.query(`
      SELECT public.convertir_intencion_a_encuentro('${sharedIntencionId}', '${sharedEncuentroId}') AS res;
    `);
    assert.equal(convRows[0].res.ok, true);
    assert.equal(convRows[0].res.estado, 'convertida');

    // Comprobar que en DB NO se generó ninguna alerta porque el encuentro es privado
    await db.query(`SET ROLE service_role;`);
    const { rows: totalRows }: any = await db.query(`
      SELECT count(*) as count FROM public.alertas_compatibilidad
      WHERE source_intencion_id = '${sharedIntencionId}' AND target_encuentro_id = '${sharedEncuentroId}';
    `);
    assert.equal(parseInt(totalRows[0].count, 10), 0, 'No debe generarse alerta para encuentro privado');

    // Comprobar que el interés de B y C sigue registrado
    const { rows: intCount }: any = await db.query(`
      SELECT count(*) as count FROM public.intencion_intereses WHERE intencion_id = '${sharedIntencionId}';
    `);
    assert.equal(parseInt(intCount[0].count, 10), 2, 'Los 2 intereses deben preservarse');
  });

  test('3. Apertura posterior del encuentro vía abrir_encuentro_seguro: genera exactamente 2 alertas', async () => {
    await setAuthContext(userA, false);
    const { rows: openRows }: any = await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${sharedEncuentroId}',
        '${userA}',
        'Abierto a la comunidad',
        4,
        'caba_palermo',
        'Palermo Norte'
      ) AS res;
    `);
    assert.equal(openRows[0].res.ok, true);
    assert.equal(openRows[0].res.is_open, true);

    // Ahora sí deben existir exactamente 2 alertas
    await db.query(`SET ROLE service_role;`);
    const { rows: totalRows }: any = await db.query(`
      SELECT count(*) as count FROM public.alertas_compatibilidad
      WHERE source_intencion_id = '${sharedIntencionId}' AND target_encuentro_id = '${sharedEncuentroId}';
    `);
    assert.equal(parseInt(totalRows[0].count, 10), 2, 'Debe haber exactamente 2 alertas tras abrir el encuentro');
  });

  test('4. Propietario (User A) y usuario sin interés (User D) reciben 0 alertas', async () => {
    await db.query(`SET ROLE service_role;`);
    const { rows: aRows }: any = await db.query(`
      SELECT count(*) as count FROM public.alertas_compatibilidad WHERE user_id = '${userA}';
    `);
    assert.equal(parseInt(aRows[0].count, 10), 0);

    const { rows: dRows }: any = await db.query(`
      SELECT count(*) as count FROM public.alertas_compatibilidad WHERE user_id = '${userD}';
    `);
    assert.equal(parseInt(dRows[0].count, 10), 0);
  });

  test('5. Reapertura / retry de abrir_encuentro_seguro es idempotente y no duplica alertas', async () => {
    await setAuthContext(userA, false);
    const { rows: reopenRows }: any = await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${sharedEncuentroId}',
        '${userA}',
        'Abierto a la comunidad actualizado',
        6,
        'caba_palermo',
        'Palermo Norte'
      ) AS res;
    `);
    assert.equal(reopenRows[0].res.ok, true);

    await db.query(`SET ROLE service_role;`);
    const { rows: totalRows }: any = await db.query(`
      SELECT count(*) as count FROM public.alertas_compatibilidad
      WHERE source_intencion_id = '${sharedIntencionId}' AND target_encuentro_id = '${sharedEncuentroId}';
    `);
    assert.equal(parseInt(totalRows[0].count, 10), 2, 'No se deben duplicar alertas al reabrir el encuentro');
  });

  test('6. Dos interesados permanecen independientes', async () => {
    await db.query(`SET ROLE service_role;`);
    const { rows: bRows }: any = await db.query(`
      SELECT * FROM public.alertas_compatibilidad WHERE user_id = '${userB}';
    `);
    assert.equal(bRows.length, 1);
    assert.equal(bRows[0].tipo, 'interes_convertido');
    assert.equal(bRows[0].source_intencion_id, sharedIntencionId);
    assert.equal(bRows[0].target_encuentro_id, sharedEncuentroId);
    assert.equal(bRows[0].leida, false);
    alertaBId = bRows[0].id;

    const { rows: cRows }: any = await db.query(`
      SELECT * FROM public.alertas_compatibilidad WHERE user_id = '${userC}';
    `);
    assert.equal(cRows.length, 1);
    assert.equal(cRows[0].tipo, 'interes_convertido');
    assert.equal(cRows[0].source_intencion_id, sharedIntencionId);
    assert.equal(cRows[0].target_encuentro_id, sharedEncuentroId);
    assert.equal(cRows[0].leida, false);
    alertaCId = cRows[0].id;
  });

  test('7. Conversión de encuentro ya abierto (is_open = true) genera alerta deduplicada de inmediato', async () => {
    // Intención nueva de A
    await setAuthContext(userA, false);
    const { rows: intRows }: any = await db.query(`
      SELECT public.crear_intencion_segura('Yoga en el parque', 'Clase abierta') AS res;
    `);
    const yogaIntId = intRows[0].res.id;

    // B marca interés
    await setAuthContext(userB, false);
    await db.query(`SELECT public.set_interes_intencion('${yogaIntId}', true);`);

    // A crea un encuentro que YA está abierto
    await setAuthContext(userA, false);
    const { rows: encRows }: any = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, is_open, locality_id, max_participants)
      VALUES ('${userA}', 'Yoga Palermo', true, 'caba_palermo', 10)
      RETURNING id;
    `);
    const yogaEncId = encRows[0].id;

    // A convierte la intención al encuentro ya abierto
    const { rows: convRows }: any = await db.query(`
      SELECT public.convertir_intencion_a_encuentro('${yogaIntId}', '${yogaEncId}') AS res;
    `);
    assert.equal(convRows[0].res.ok, true);

    // B recibe la alerta de inmediato
    await db.query(`SET ROLE service_role;`);
    const { rows: alertCount }: any = await db.query(`
      SELECT count(*) as count FROM public.alertas_compatibilidad
      WHERE source_intencion_id = '${yogaIntId}' AND user_id = '${userB}';
    `);
    assert.equal(parseInt(alertCount[0].count, 10), 1, 'Debe generarse alerta directa si ya estaba abierto');
  });

  test('8. RPC get_mis_alertas_seguro: NO contiene public_token ni host_id ni campos privados', async () => {
    await setAuthContext(userB, false);
    const { rows }: any = await db.query(`
      SELECT public.get_mis_alertas_seguro() AS res;
    `);
    assert.equal(rows[0].res.ok, true);
    const alertas = rows[0].res.alertas;
    assert.ok(alertas.length >= 1);

    const alerta = alertas[0];
    assert.equal(alerta.tipo, 'interes_convertido');

    // PRIVACIDAD ESTRICTA
    assert.equal(alerta.public_token, undefined, 'No debe exponer public_token');
    assert.equal(alerta.encuentro.public_token, undefined, 'encuentro no debe exponer public_token');
    assert.equal(alerta.host_id, undefined, 'No debe exponer host_id');
    assert.equal(alerta.encuentro.host_id, undefined, 'encuentro no debe exponer host_id');
    assert.equal(alerta.lugar_texto, undefined, 'No debe exponer lugar_texto');
    assert.equal(alerta.encuentro.lugar_texto, undefined, 'encuentro no debe exponer lugar_texto');
    assert.equal(alerta.link_virtual, undefined, 'No debe exponer link_virtual');
    assert.equal(alerta.encuentro.link_virtual, undefined, 'encuentro no debe exponer link_virtual');
  });

  test('9. RPC marcar_alerta_leida_seguro: User A no puede marcar alerta de B', async () => {
    await setAuthContext(userA, false);
    const { rows }: any = await db.query(`
      SELECT public.marcar_alerta_leida_seguro('${alertaBId}') AS res;
    `);
    assert.equal(rows[0].res.ok, false);
    assert.equal(rows[0].res.error, 'unauthorized');
  });

  test('10. RPC marcar_alerta_leida_seguro: funciona y es idempotente', async () => {
    await setAuthContext(userB, false);
    const { rows: m1 }: any = await db.query(`
      SELECT public.marcar_alerta_leida_seguro('${alertaBId}') AS res;
    `);
    assert.equal(m1[0].res.ok, true);
    assert.equal(m1[0].res.leida, true);
    assert.equal(m1[0].res.idempotent, false);

    // Retry idempotente
    const { rows: m2 }: any = await db.query(`
      SELECT public.marcar_alerta_leida_seguro('${alertaBId}') AS res;
    `);
    assert.equal(m2[0].res.ok, true);
    assert.equal(m2[0].res.idempotent, true);

    // Alerta de User C permanece no leída
    await setAuthContext(userC, false);
    const { rows: cRes }: any = await db.query(`
      SELECT public.get_mis_alertas_seguro() AS res;
    `);
    assert.equal(cRes[0].res.alertas[0].leida, false);
  });

  test('11. Cleanup elimina alertas prematuras sobre encuentros privados', async () => {
    await db.query(`SET ROLE service_role;`);
    // Insertar manualmente una alerta prematura sobre un encuentro cerrado/privado
    const { rows: privateEnc }: any = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, is_open)
      VALUES ('${userA}', 'Encuentro Privado Viejo', false)
      RETURNING id;
    `);
    const pEncId = privateEnc[0].id;

    await db.query(`
      INSERT INTO public.alertas_compatibilidad (user_id, tipo, source_intencion_id, target_encuentro_id)
      VALUES ('${userB}', 'interes_convertido', '${sharedIntencionId}', '${pEncId}')
      ON CONFLICT DO NOTHING;
    `);

    // Ejecutar lógica de limpieza
    await db.query(`
      DELETE FROM public.alertas_compatibilidad a
      USING public.encuentros e
      WHERE a.target_encuentro_id = e.id
        AND a.tipo = 'interes_convertido'
        AND e.is_open = false;
    `);

    // Verificar que se eliminó
    const { rows: count }: any = await db.query(`
      SELECT count(*) as count FROM public.alertas_compatibilidad WHERE target_encuentro_id = '${pEncId}';
    `);
    assert.equal(parseInt(count[0].count, 10), 0, 'La alerta prematura debió ser eliminada');
  });

  test('12. Cuentas anónimas son rechazadas por ambas RPCs', async () => {
    await setAuthContext(userAnon, true);

    const { rows: getRes }: any = await db.query(`
      SELECT public.get_mis_alertas_seguro() AS res;
    `);
    assert.equal(getRes[0].res.ok, false);
    assert.equal(getRes[0].res.error, 'permanent_account_required');

    const { rows: markRes }: any = await db.query(`
      SELECT public.marcar_alerta_leida_seguro('${alertaBId}') AS res;
    `);
    assert.equal(markRes[0].res.ok, false);
    assert.equal(markRes[0].res.error, 'permanent_account_required');
  });
});
