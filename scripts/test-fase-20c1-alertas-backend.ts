import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

describe('Fase 2.0-C1: Infraestructura de Alertas + Caso C (Interés -> Conversión)', () => {
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
        locality_id TEXT REFERENCES public.localidades(id),
        creado_en TIMESTAMPTZ DEFAULT now()
      );
      GRANT ALL ON TABLE public.encuentros TO authenticated, anon, service_role;
    `);

    // 2. Cargar migraciones en orden
    const migrations = [
      'supabase/migrations/20260929170000_fase_20a_intenciones_core.sql',
      'supabase/migrations/20260929180000_fase_20a_intenciones_conversion.sql',
      'supabase/migrations/20260929190000_fase_20b_discovery_intenciones.sql',
      'supabase/migrations/20260929200000_fase_20b_set_interes_intencion.sql',
      'supabase/migrations/20260929210000_fase_20c1_alertas_caso_c.sql'
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

  test('1. Setup previo: User A crea intención, User B y C marcan interés, User D no marca', async () => {
    // A crea intención
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
    assert.ok(sharedIntencionId, 'Debe devolver UUID de intención');

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

    // A crea encuentro
    await setAuthContext(userA, false);
    const { rows: encRows }: any = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo, descripcion, fecha, hora, modalidad, locality_id, is_open)
      VALUES ('${userA}', 'Torneo Pádel Palermo', 'Nos juntamos a jugar', '2026-10-05', '18:00', 'presencial', 'caba_palermo', true)
      RETURNING id;
    `);
    sharedEncuentroId = encRows[0].id;
    assert.ok(sharedEncuentroId, 'Debe devolver UUID de encuentro');
  });

  test('2. Conversión genera exactamente 2 alertas para los 2 interesados', async () => {
    await setAuthContext(userA, false);
    const { rows: convRows }: any = await db.query(`
      SELECT public.convertir_intencion_a_encuentro('${sharedIntencionId}', '${sharedEncuentroId}') AS res;
    `);
    assert.equal(convRows[0].res.ok, true);
    assert.equal(convRows[0].res.estado, 'convertida');

    // Comprobar total en base de datos
    await db.query(`SET ROLE service_role;`);
    const { rows: totalRows }: any = await db.query(`
      SELECT count(*) as count FROM public.alertas_compatibilidad
      WHERE source_intencion_id = '${sharedIntencionId}' AND target_encuentro_id = '${sharedEncuentroId}';
    `);
    assert.equal(parseInt(totalRows[0].count, 10), 2, 'Deben existir exactamente 2 alertas');
  });

  test('3. Propietario de intención (User A) no recibe alerta', async () => {
    await db.query(`SET ROLE service_role;`);
    const { rows }: any = await db.query(`
      SELECT count(*) as count FROM public.alertas_compatibilidad WHERE user_id = '${userA}';
    `);
    assert.equal(parseInt(rows[0].count, 10), 0, 'User A no debe recibir alerta');
  });

  test('4. Usuario sin interés (User D) no recibe alerta', async () => {
    await db.query(`SET ROLE service_role;`);
    const { rows }: any = await db.query(`
      SELECT count(*) as count FROM public.alertas_compatibilidad WHERE user_id = '${userD}';
    `);
    assert.equal(parseInt(rows[0].count, 10), 0, 'User D no debe recibir alerta');
  });

  test('5. Retry de conversión con el mismo encuentro es idempotente y no duplica alertas', async () => {
    await setAuthContext(userA, false);
    const { rows: retryRows }: any = await db.query(`
      SELECT public.convertir_intencion_a_encuentro('${sharedIntencionId}', '${sharedEncuentroId}') AS res;
    `);
    assert.equal(retryRows[0].res.ok, true);
    assert.equal(retryRows[0].res.idempotent, true);

    await db.query(`SET ROLE service_role;`);
    const { rows: totalRows }: any = await db.query(`
      SELECT count(*) as count FROM public.alertas_compatibilidad
      WHERE source_intencion_id = '${sharedIntencionId}' AND target_encuentro_id = '${sharedEncuentroId}';
    `);
    assert.equal(parseInt(totalRows[0].count, 10), 2, 'No se deben duplicar alertas tras retry');
  });

  test('6. Dos interesados permanecen independientes y alertas referencian intención y encuentro correctos', async () => {
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

  test('7. Privacidad RLS: User A no puede leer alertas de User B ni en tabla directa', async () => {
    await setAuthContext(userA, false);
    const { rows: aReadB }: any = await db.query(`
      SELECT * FROM public.alertas_compatibilidad WHERE user_id = '${userB}';
    `);
    assert.equal(aReadB.length, 0, 'RLS debe ocultar alertas de otros');

    await setAuthContext(userB, false);
    const { rows: bReadOwn }: any = await db.query(`
      SELECT * FROM public.alertas_compatibilidad;
    `);
    assert.equal(bReadOwn.length, 1);
    assert.equal(bReadOwn[0].user_id, userB);
  });

  test('8. RPC get_mis_alertas_seguro: sólo devuelve propias con DTO público y seguro (sin host_id ni campos privados)', async () => {
    // User B ve su alerta
    await setAuthContext(userB, false);
    const { rows: bRes }: any = await db.query(`
      SELECT public.get_mis_alertas_seguro() AS res;
    `);
    assert.equal(bRes[0].res.ok, true);
    const alertasB = bRes[0].res.alertas;
    assert.equal(alertasB.length, 1);
    const aB = alertasB[0];
    assert.equal(aB.id, alertaBId);
    assert.equal(aB.tipo, 'interes_convertido');
    assert.equal(aB.source_intencion_id, sharedIntencionId);
    assert.equal(aB.target_encuentro_id, sharedEncuentroId);
    assert.equal(aB.leida, false);
    assert.equal(aB.encuentro_titulo, 'Torneo Pádel Palermo');
    assert.equal(aB.encuentro.titulo, 'Torneo Pádel Palermo');

    // Invariantes de privacidad
    assert.equal(aB.host_id, undefined);
    assert.equal(aB.encuentro.host_id, undefined);
    assert.equal(aB.lugar_texto, undefined);
    assert.equal(aB.encuentro.lugar_texto, undefined);
    assert.equal(aB.link_virtual, undefined);
    assert.equal(aB.encuentro.link_virtual, undefined);

    // User A no ve alertas
    await setAuthContext(userA, false);
    const { rows: aRes }: any = await db.query(`
      SELECT public.get_mis_alertas_seguro() AS res;
    `);
    assert.equal(aRes[0].res.ok, true);
    assert.equal(aRes[0].res.alertas.length, 0);

    // User D no ve alertas
    await setAuthContext(userD, false);
    const { rows: dRes }: any = await db.query(`
      SELECT public.get_mis_alertas_seguro() AS res;
    `);
    assert.equal(dRes[0].res.ok, true);
    assert.equal(dRes[0].res.alertas.length, 0);
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
    // User B marca su alerta
    await setAuthContext(userB, false);
    const { rows: m1 }: any = await db.query(`
      SELECT public.marcar_alerta_leida_seguro('${alertaBId}') AS res;
    `);
    assert.equal(m1[0].res.ok, true);
    assert.equal(m1[0].res.leida, true);
    assert.equal(m1[0].res.idempotent, false);

    // En get_mis_alertas_seguro ahora figura leida = true
    const { rows: getRes }: any = await db.query(`
      SELECT public.get_mis_alertas_seguro() AS res;
    `);
    assert.equal(getRes[0].res.alertas[0].leida, true);

    // Retry de marcado es idempotente
    const { rows: m2 }: any = await db.query(`
      SELECT public.marcar_alerta_leida_seguro('${alertaBId}') AS res;
    `);
    assert.equal(m2[0].res.ok, true);
    assert.equal(m2[0].res.leida, true);
    assert.equal(m2[0].res.idempotent, true);

    // Alerta de User C permanece no leída (independencia)
    await setAuthContext(userC, false);
    const { rows: cRes }: any = await db.query(`
      SELECT public.get_mis_alertas_seguro() AS res;
    `);
    assert.equal(cRes[0].res.alertas[0].leida, false);
  });

  test('11. Cuentas anónimas son rechazadas por ambas RPCs', async () => {
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

  test('12. Invariantes previas de convertir_intencion_a_encuentro se preservan', async () => {
    // Crear intención de B
    await setAuthContext(userB, false);
    const { rows: intRows }: any = await db.query(`
      SELECT public.crear_intencion_segura('Intención de B', 'Descripción') AS res;
    `);
    const intBId = intRows[0].res.id;

    // Crear encuentro de B
    const { rows: encRows }: any = await db.query(`
      INSERT INTO public.encuentros (host_id, titulo) VALUES ('${userB}', 'Encuentro de B') RETURNING id;
    `);
    const encBId = encRows[0].id;

    // User A intenta convertir la intención de User B -> unauthorized
    await setAuthContext(userA, false);
    const { rows: convUnauthorized }: any = await db.query(`
      SELECT public.convertir_intencion_a_encuentro('${intBId}', '${sharedEncuentroId}') AS res;
    `);
    assert.equal(convUnauthorized[0].res.ok, false);
    assert.equal(convUnauthorized[0].res.error, 'unauthorized');

    // User B intenta convertir a un encuentro de User A -> unauthorized_encounter
    await setAuthContext(userB, false);
    const { rows: encUnauthorized }: any = await db.query(`
      SELECT public.convertir_intencion_a_encuentro('${intBId}', '${sharedEncuentroId}') AS res;
    `);
    assert.equal(encUnauthorized[0].res.ok, false);
    assert.equal(encUnauthorized[0].res.error, 'unauthorized_encounter');

    // User B convierte exitosamente a su encuentro
    const { rows: convOk }: any = await db.query(`
      SELECT public.convertir_intencion_a_encuentro('${intBId}', '${encBId}') AS res;
    `);
    assert.equal(convOk[0].res.ok, true);
    assert.equal(convOk[0].res.estado, 'convertida');

    // Como nadie tenía interés en intBId, no genera alertas adicionales
    await db.query(`SET ROLE service_role;`);
    const { rows: countRows }: any = await db.query(`
      SELECT count(*) as count FROM public.alertas_compatibilidad WHERE source_intencion_id = '${intBId}';
    `);
    assert.equal(parseInt(countRows[0].count, 10), 0);
  });
});
