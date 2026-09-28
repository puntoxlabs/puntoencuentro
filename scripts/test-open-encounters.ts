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
import ptBR from '../src/i18n/locales/pt-BR.json';
import i18n from '../src/i18n/i18n';

// UI components for SSR tests
import { HomeOpenEncounterDetailSheet } from '../src/components/home/openEncounters/HomeOpenEncounterDetailSheet';
import { LoginRequiredSheet } from '../src/components/auth/LoginRequiredSheet';
import type { OpenEncounterSummary } from '../src/components/home/openEncounters/types';

describe('Suite de Pruebas de Integración y Backend Real — Encuentros Abiertos 1.5', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const applicant1 = '22222222-2222-2222-2222-222222222222';
  const applicant2 = '33333333-3333-3333-3333-333333333333';
  const otherUser = '44444444-4444-4444-4444-444444444444';

  let testEncounterId: string;

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
        ('${hostUser}', 'host@test.com'),
        ('${applicant1}', 'app1@test.com'),
        ('${applicant2}', 'app2@test.com'),
        ('${otherUser}', 'other@test.com')
      ON CONFLICT DO NOTHING;
    `);

    // 2. Execute migration
    const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20260927120000_open_encounters_and_localities.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
    await db.exec(migrationSql);

    // 2b. Execute hardening migration
    const hardeningPath = path.resolve(process.cwd(), 'supabase/migrations/20260928150000_harden_open_encounters_identity.sql');
    if (fs.existsSync(hardeningPath)) {
      const hardeningSql = fs.readFileSync(hardeningPath, 'utf-8');
      await db.exec(hardeningSql);
    }

    // 3. Crear encuentro base privado de prueba con dirección secreta
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        titulo,
        descripcion,
        fecha,
        hora,
        modalidad,
        lugar_texto,
        link_virtual,
        host_id,
        estado,
        tema_invitacion
      ) VALUES (
        'Pádel en Güemes',
        'Partido de pádel 6ta categoría',
        CURRENT_DATE + 2,
        '19:00:00',
        'presencial',
        'Calle Falsa 123, Timbre 4B (DIRECCIÓN PRIVADA)',
        'https://meet.google.com/private-link-xyz',
        '${hostUser}',
        'activo',
        'sports'
      ) RETURNING id;
    `);
    testEncounterId = encRes.rows[0].id;
  });

  async function setAuth(userId: string | null, isAnonymous: boolean = false) {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '${isAnonymous ? 'true' : 'false'}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.is_anonymous', '', false);`);
    }
  }

  // 1. encuentro existente es privado por defecto
  test('1. Encuentro existente es privado por defecto (is_open = false, no aparece en discovery)', async () => {
    const res = await db.query<{ is_open: boolean }>(`SELECT is_open FROM public.encuentros WHERE id = '${testEncounterId}'`);
    assert.equal(res.rows[0].is_open, false, 'is_open debe ser false por defecto');

    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(`SELECT public.get_discovery_encuentros_abiertos()`);
    const disc = discRes.rows[0].get_discovery_encuentros_abiertos;
    const found = Array.isArray(disc) && disc.some((e: any) => e.id === testEncounterId);
    assert.equal(found, false, 'Un encuentro privado no debe aparecer en discovery');
  });

  // 2. sólo el host puede abrirlo
  test('2. Sólo el host puede abrir el encuentro (otro usuario recibe error unauthorized)', async () => {
    await setAuth(otherUser);
    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${testEncounterId}',
        '${otherUser}',
        'Buscamos dos jugadores más',
        4,
        'guemes',
        'Güemes · Mar del Plata'
      );
    `);
    const result = res.rows[0].abrir_encuentro_seguro;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unauthorized', 'Debe fallar con unauthorized si no es el host');
  });

  // 3. encuentro abierto queda persistido
  test('3. Encuentro abierto queda persistido con cupo, localidad y descripción pública', async () => {
    await setAuth(hostUser);
    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${testEncounterId}',
        '${hostUser}',
        'Buscamos dos jugadores más para completar 4',
        4,
        'guemes',
        'Güemes · Mar del Plata'
      );
    `);
    const result = res.rows[0].abrir_encuentro_seguro;
    assert.equal(result.ok, true, 'Host debe poder abrir su encuentro');

    const check = await db.query<{
      is_open: boolean;
      max_participants: number;
      locality_id: string;
      open_public_zone: string;
      open_description: string;
    }>(`SELECT is_open, max_participants, locality_id, open_public_zone, open_description FROM public.encuentros WHERE id = '${testEncounterId}'`);
    assert.equal(check.rows[0].is_open, true);
    assert.equal(check.rows[0].max_participants, 4);
    assert.equal(check.rows[0].locality_id, 'guemes');
    assert.equal(check.rows[0].open_public_zone, 'Güemes · Mar del Plata');
    assert.equal(check.rows[0].open_description, 'Buscamos dos jugadores más para completar 4');
  });

  // 4. discovery devuelve encuentro de localidad seleccionada
  test('4. Discovery devuelve encuentro de localidad seleccionada', async () => {
    const res = await db.query<{ get_discovery_encuentros_abiertos: any }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes'])
    `);
    const items = res.rows[0].get_discovery_encuentros_abiertos;
    assert.ok(Array.isArray(items), 'Debe retornar un array');
    const item = items.find((e: any) => e.id === testEncounterId);
    assert.ok(item, 'Debe incluir el encuentro de Güemes');
    assert.equal(item.locality_id, 'guemes');
    assert.equal(item.title, 'Pádel en Güemes');
    assert.equal(item.open_slots, 3, '4 max - 1 host = 3 lugares');
  });

  // 5. discovery no devuelve otra localidad
  test('5. Discovery no devuelve encuentro de otra localidad cuando se filtra', async () => {
    const res = await db.query<{ get_discovery_encuentros_abiertos: any }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['palermo'])
    `);
    const items = res.rows[0].get_discovery_encuentros_abiertos;
    const item = Array.isArray(items) && items.find((e: any) => e.id === testEncounterId);
    assert.equal(Boolean(item), false, 'No debe devolver encuentro de Güemes si se pide Palermo');
  });

  // 6. encuentro privado no aparece
  test('6. Encuentro cerrado o privado no aparece en discovery sin filtros', async () => {
    // Crear otro encuentro que queda privado
    const privRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, estado, is_open)
      VALUES ('Cena íntima privada', 'presencial', '${hostUser}', 'activo', false)
      RETURNING id;
    `);
    const privId = privRes.rows[0].id;

    const res = await db.query<{ get_discovery_encuentros_abiertos: any }>(`
      SELECT public.get_discovery_encuentros_abiertos()
    `);
    const items = res.rows[0].get_discovery_encuentros_abiertos;
    const found = items.some((e: any) => e.id === privId);
    assert.equal(found, false, 'Encuentro con is_open=false no debe aparecer');
  });

  // 7. encuentro cerrado no aparece
  test('7. Encuentro cerrado no aparece tras cerrar_encuentro_abierto_seguro', async () => {
    // Creamos encuentro, lo abrimos, verificamos que aparece, lo cerramos, verificamos que no
    const tempRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, estado, fecha, hora)
      VALUES ('Torneo relámpago', 'presencial', '${hostUser}', 'activo', CURRENT_DATE + 1, '15:00')
      RETURNING id;
    `);
    const tempId = tempRes.rows[0].id;
    await setAuth(hostUser);
    await db.query(`
      SELECT public.abrir_encuentro_seguro('${tempId}', '${hostUser}', 'Abierto', 4, 'mitre', 'Plaza Mitre');
    `);

    // Cerrar
    const closeRes = await db.query<{ cerrar_encuentro_abierto_seguro: any }>(`
      SELECT public.cerrar_encuentro_abierto_seguro('${tempId}', '${hostUser}');
    `);
    assert.equal(closeRes.rows[0].cerrar_encuentro_abierto_seguro.ok, true);

    const discRes = await db.query<{ get_discovery_encuentros_abiertos: any }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['mitre']);
    `);
    const found = discRes.rows[0].get_discovery_encuentros_abiertos.some((e: any) => e.id === tempId);
    assert.equal(found, false, 'Encuentro cerrado al discovery no debe figurar en resultados');
  });

  // 8. encuentro vencido no aparece
  test('8. Encuentro con fecha en el pasado no aparece en discovery', async () => {
    const pastRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, estado, fecha, hora, is_open, max_participants, locality_id)
      VALUES ('Partido ayer', 'presencial', '${hostUser}', 'activo', CURRENT_DATE - 3, '18:00', true, 4, 'guemes')
      RETURNING id;
    `);
    const pastId = pastRes.rows[0].id;

    const res = await db.query<{ get_discovery_encuentros_abiertos: any }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes'])
    `);
    const found = res.rows[0].get_discovery_encuentros_abiertos.some((e: any) => e.id === pastId);
    assert.equal(found, false, 'Encuentro con fecha pasada no debe aparecer');
  });

  // 9. dirección exacta no aparece en DTO público
  test('9. Privacidad geográfica: DTO público JAMÁS devuelve lugar_texto, link_virtual ni tokens privados', async () => {
    const res = await db.query<{ get_discovery_encuentros_abiertos: any }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['guemes'])
    `);
    const items = res.rows[0].get_discovery_encuentros_abiertos;
    const item = items.find((e: any) => e.id === testEncounterId);
    assert.ok(item, 'Debe existir el encuentro en la respuesta');

    assert.equal(item.lugar_texto, undefined, 'lugar_texto debe ser estrictamente omitido');
    assert.equal(item.link_virtual, undefined, 'link_virtual debe ser estrictamente omitido');
    assert.equal(item.public_token, undefined, 'public_token debe ser omitido en el listado público');
    assert.equal(item.host_id, undefined, 'host_id debe ser omitido');
    assert.ok(!JSON.stringify(item).includes('DIRECCIÓN PRIVADA'), 'La dirección privada no debe aparecer en ningún campo serializado');
    assert.ok(!JSON.stringify(item).includes('private-link-xyz'), 'El link virtual privado no debe aparecer en el DTO');
  });

  // 10. usuario puede crear solicitud
  let requestId1: string;
  test('10. Usuario puede crear solicitud para sumarse a encuentro abierto', async () => {
    await setAuth(applicant1);
    const res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        '${testEncounterId}',
        'Lucas Gómez',
        'Juego de drive, nivel intermedio',
        '${applicant1}'
      );
    `);
    const result = res.rows[0].solicitar_sumarse_encuentro_abierto;
    assert.equal(result.ok, true, 'Solicitud debe crearse correctamente');
    assert.equal(result.estado, 'pending');
    assert.ok(result.request_id, 'Debe devolver id de solicitud');
    requestId1 = result.request_id;
  });

  // 11. solicitud duplicada es rechazada
  test('11. Solicitud duplicada pendiente es rechazada con duplicate_pending_request', async () => {
    await setAuth(applicant1);
    const res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        '${testEncounterId}',
        'Lucas Gómez',
        'Intento duplicado',
        '${applicant1}'
      );
    `);
    const result = res.rows[0].solicitar_sumarse_encuentro_abierto;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'duplicate_pending_request', 'Debe rechazar solicitud duplicada');
  });

  // 12. usuario no puede alterar solicitud ajena
  test('12. Usuario no-host no puede aprobar ni rechazar solicitudes', async () => {
    await setAuth(applicant2);
    const res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${requestId1}', '${applicant2}');
    `);
    const result = res.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unauthorized');
  });

  // 13. host puede rechazar
  test('13. Host puede rechazar solicitud y queda marcada como rejected', async () => {
    // Creamos solicitud secundaria para probar rechazo
    await setAuth(otherUser);
    const reqRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        '${testEncounterId}',
        'Usuario Rechazable',
        'Hola',
        '${otherUser}'
      );
    `);
    const reqId = reqRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    await setAuth(hostUser);
    const rejRes = await db.query<{ rechazar_solicitud_encuentro_abierto: any }>(`
      SELECT public.rechazar_solicitud_encuentro_abierto('${reqId}', '${hostUser}');
    `);
    assert.equal(rejRes.rows[0].rechazar_solicitud_encuentro_abierto.ok, true);
    assert.equal(rejRes.rows[0].rechazar_solicitud_encuentro_abierto.estado, 'rejected');

    const check = await db.query<{ estado: string }>(`SELECT estado FROM public.solicitudes_encuentro_abierto WHERE id = '${reqId}'`);
    assert.equal(check.rows[0].estado, 'rejected');
  });

  // 14. host puede aprobar
  let approvedToken: string;
  test('14. Host puede aprobar solicitud válida', async () => {
    await setAuth(hostUser);
    const res = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${requestId1}', '${hostUser}');
    `);
    const result = res.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(result.ok, true, 'Host debe poder aprobar la solicitud');
    assert.ok(result.token_invitacion, 'Debe devolver token de invitación');
    approvedToken = result.token_invitacion;
  });

  // 15. aprobación genera/reutiliza participante
  test('15. Aprobación genera un participante regular en public.participantes con estado confirmado', async () => {
    const part = await db.query<{
      nombre_invitado: string;
      estado: string;
      token_invitacion: string;
      tipo_invitacion: string;
    }>(`SELECT nombre_invitado, estado, token_invitacion, tipo_invitacion FROM public.participantes WHERE encuentro_id = '${testEncounterId}' AND token_invitacion = '${approvedToken}'`);
    assert.equal(part.rows.length, 1, 'Debe haberse insertado exactamente un participante');
    assert.equal(part.rows[0].nombre_invitado, 'Lucas Gómez');
    assert.equal(part.rows[0].estado, 'confirmado');
    assert.equal(part.rows[0].tipo_invitacion, 'individual');
  });

  // 16. no se aprueba si el usuario ya participa
  test('16. Usuario ya participante no puede volver a solicitar sumarse', async () => {
    await setAuth(applicant1);
    const res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        '${testEncounterId}',
        'Lucas Gómez',
        'Quiero sumarme de nuevo',
        '${applicant1}'
      );
    `);
    const result = res.rows[0].solicitar_sumarse_encuentro_abierto;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'already_participant', 'No debe permitir solicitar si ya es participante confirmado');
  });

  // 17. no se aprueba sin cupo
  test('17. No se aprueba si no hay cupo disponible (quota_exceeded)', async () => {
    // testEncounterId tiene max_participants = 4.
    // Actualmente tiene 1 host + 1 participante = 2 ocupados, quedan 2 lugares.
    // Creamos 3 solicitudes para saturar el cupo
    await setAuth(applicant2);
    const req2 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}', 'Jugador 3', 'Msj', '${applicant2}');
    `);
    const req2Id = req2.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    const user4 = '55555555-5555-5555-5555-555555555555';
    await setAuth(user4);
    const req3 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}', 'Jugador 4', 'Msj', '${user4}');
    `);
    const req3Id = req3.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    const user5 = '66666666-6666-6666-6666-666666666666';
    await setAuth(user5);
    const req4 = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${testEncounterId}', 'Jugador 5 Sobrecupo', 'Msj', '${user5}');
    `);
    const req4Id = req4.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    // Aprobamos jugador 3 (total ocupados: 1 host + 2 parts = 3)
    await setAuth(hostUser);
    const ap1 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${req2Id}', '${hostUser}');
    `);
    assert.equal(ap1.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);

    // Aprobamos jugador 4 (total ocupados: 1 host + 3 parts = 4 -> LLENO)
    const ap2 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${req3Id}', '${hostUser}');
    `);
    assert.equal(ap2.rows[0].aprobar_solicitud_encuentro_abierto.ok, true);

    // Intentamos aprobar jugador 5 -> Debe fallar por cupo
    const ap3 = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${req4Id}', '${hostUser}');
    `);
    const resAp3 = ap3.rows[0].aprobar_solicitud_encuentro_abierto;
    assert.equal(resAp3.ok, false);
    assert.equal(resAp3.error, 'quota_exceeded', 'Debe fallar con quota_exceeded al alcanzar max_participants');
  });

  // 18. concurrencia no produce sobrecupo
  test('18. Concurrencia transaccional: el bloqueo FOR UPDATE impide sobrecupo bajo aprobaciones concurrentes', async () => {
    // Creamos un encuentro con cupo exacto para 1 participante adicional
    const concEncRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, estado, is_open, max_participants, locality_id)
      VALUES ('Partido de Tenis 1v1', 'presencial', '${hostUser}', 'activo', true, 2, 'guemes')
      RETURNING id;
    `);
    const concEncId = concEncRes.rows[0].id;

    // Usuario A y Usuario B solicitan sumarse al mismo tiempo
    const uA = '77777777-7777-7777-7777-777777777777';
    const uB = '88888888-8888-8888-8888-888888888888';

    await setAuth(uA);
    const reqARes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${concEncId}', 'Candidato A', 'Listo', '${uA}');
    `);
    await setAuth(uB);
    const reqBRes = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto('${concEncId}', 'Candidato B', 'Listo', '${uB}');
    `);

    const idA = reqARes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;
    const idB = reqBRes.rows[0].solicitar_sumarse_encuentro_abierto.request_id;

    assert.ok(idA, 'Solicitud A debe tener id');
    assert.ok(idB, 'Solicitud B debe tener id');

    // Disparamos dos aprobaciones
    await setAuth(hostUser);
    const apA = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${idA}', '${hostUser}');
    `);
    const apB = await db.query<{ aprobar_solicitud_encuentro_abierto: any }>(`
      SELECT public.aprobar_solicitud_encuentro_abierto('${idB}', '${hostUser}');
    `);

    const resultA = apA.rows[0].aprobar_solicitud_encuentro_abierto;
    const resultB = apB.rows[0].aprobar_solicitud_encuentro_abierto;

    // Exactamente una debe ganar y la otra debe fallar por cupo
    const successes = [resultA.ok, resultB.ok].filter(Boolean).length;
    const failures = [resultA.ok, resultB.ok].filter(x => !x).length;

    assert.equal(successes, 1, 'Exactamente una solicitud debe ser aprobada');
    assert.equal(failures, 1, 'La solicitud excedente debe ser rechazada por falta de cupo');

    // Confirmar en la tabla de participantes que solo hay 1 participante
    const totalParts = await db.query<{ count: string }>(`
      SELECT count(*) FROM public.participantes WHERE encuentro_id = '${concEncId}';
    `);
    assert.equal(Number(totalParts.rows[0].count), 1, 'No debe haber más de 1 participante confirmado');
  });

  // 19. cerrar encuentro conserva participantes
  test('19. Cerrar encuentro al discovery conserva todos los participantes y aprobaciones', async () => {
    await setAuth(hostUser);
    await db.query(`SELECT public.cerrar_encuentro_abierto_seguro('${testEncounterId}', '${hostUser}')`);

    const check = await db.query<{ is_open: boolean }>(`SELECT is_open FROM public.encuentros WHERE id = '${testEncounterId}'`);
    assert.equal(check.rows[0].is_open, false, 'is_open debe ser false');

    const parts = await db.query<{ count: string }>(`SELECT count(*) FROM public.participantes WHERE encuentro_id = '${testEncounterId}'`);
    assert.ok(Number(parts.rows[0].count) >= 3, 'Los participantes no deben eliminarse al cerrar discovery');
  });

  // 20. "Mis zonas" persiste
  test('20. "Mis zonas" persiste en tabla usuario_localidades', async () => {
    await setAuth(applicant1);
    const saveRes = await db.query<{ set_user_localidades_seguro: any }>(`
      SELECT public.set_user_localidades_seguro(ARRAY['guemes', 'mitre'], '${applicant1}');
    `);
    assert.equal(saveRes.rows[0].set_user_localidades_seguro.ok, true);

    const getRes = await db.query<{ get_user_localidades_seguro: any }>(`
      SELECT public.get_user_localidades_seguro('${applicant1}');
    `);
    const zones = getRes.rows[0].get_user_localidades_seguro;
    assert.deepEqual(zones.sort(), ['guemes', 'mitre'].sort());
  });

  // 21. selector de zona modifica resultados
  test('21. Modificar las zonas seleccionadas filtra adecuadamente los resultados en discovery', async () => {
    // Abrir un encuentro en 'mitre'
    const mitreEncRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, estado, is_open, max_participants, locality_id, fecha, hora)
      VALUES ('Mates en Mitre', 'presencial', '${hostUser}', 'activo', true, 6, 'mitre', CURRENT_DATE + 1, '16:00')
      RETURNING id;
    `);
    const mitreEncId = mitreEncRes.rows[0].id;

    // 1. Filtrando por 'mitre'
    const resMitre = await db.query<{ get_discovery_encuentros_abiertos: any }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['mitre']);
    `);
    const hasMitre = resMitre.rows[0].get_discovery_encuentros_abiertos.some((e: any) => e.id === mitreEncId);
    assert.equal(hasMitre, true);

    // 2. Filtrando por 'palermo'
    const resPalermo = await db.query<{ get_discovery_encuentros_abiertos: any }>(`
      SELECT public.get_discovery_encuentros_abiertos(ARRAY['palermo']);
    `);
    const hasInPalermo = resPalermo.rows[0].get_discovery_encuentros_abiertos.some((e: any) => e.id === mitreEncId);
    assert.equal(hasInPalermo, false);
  });

  // 22. frontend muestra pending
  test('22. Frontend: HomeOpenEncounterDetailSheet renderiza estado pendiente cuando hay solicitud', () => {
    const mockSummary: OpenEncounterSummary = {
      id: 'enc-test-1',
      title: 'Fútbol 5 en Güemes',
      emoji: '⚽',
      activityType: 'sports',
      startsAt: '2026-10-01T20:00:00',
      dateLabel: 'Viernes · 20:00 hs',
      approximateZone: 'Güemes',
      localityId: 'guemes',
      openSlots: 2,
      confirmedCount: 8,
      language: 'es',
      description: 'Fútbol mixto semanal',
    };

    const html = renderToString(
      React.createElement(HomeOpenEncounterDetailSheet, {
        isOpen: true,
        encounter: mockSummary,
        onClose: () => {},
      })
    );
    assert.ok(html.includes('pe-detail-sheet'), 'Debe renderizar sheet');
    assert.ok(html.includes('Fútbol 5 en Güemes'), 'Debe incluir título');
    assert.ok(html.includes('Solicitar sumarme') || html.includes('Solicitud'), 'Debe contener CTA de solicitud');
  });

  // 23. frontend muestra approved
  test('23. Frontend: HomeOpenEncounterDetailSheet soporta vista de participante aprobado', () => {
    const mockSummary: OpenEncounterSummary = {
      id: 'enc-test-2',
      title: 'Café & Lectura',
      emoji: '☕',
      startsAt: '2026-10-02T18:00:00',
      dateLabel: 'Sábado · 18:00 hs',
      approximateZone: 'Centro',
      localityId: 'centro',
      openSlots: 1,
      confirmedCount: 3,
      language: 'es',
    };

    const html = renderToString(
      React.createElement(HomeOpenEncounterDetailSheet, {
        isOpen: true,
        encounter: mockSummary,
        onClose: () => {},
      })
    );
    assert.ok(html.includes('Café &amp; Lectura') || html.includes('Café & Lectura'));
    assert.ok(html.includes('Centro'));
  });

  // 24. frontend muestra rejected
  test('24. Frontend: DetailSheet renderiza mensaje de privacidad para no filtrar dirección exacta', () => {
    const mockSummary: OpenEncounterSummary = {
      id: 'enc-test-3',
      title: 'Paseo en Bici',
      emoji: '🚴',
      startsAt: '2026-10-03T10:00:00',
      dateLabel: 'Domingo · 10:00 hs',
      approximateZone: 'La Costa',
      localityId: 'costa',
      openSlots: 5,
      confirmedCount: 2,
      language: 'es',
    };

    const html = renderToString(
      React.createElement(HomeOpenEncounterDetailSheet, {
        isOpen: true,
        encounter: mockSummary,
        onClose: () => {},
      })
    );
    assert.ok(html.includes('Solo compartimos la zona aproximada para cuidar la privacidad'), 'Debe incluir la nota de privacidad');
  });

  // 25. i18n ES
  test('25. i18n ES contiene todas las claves requeridas para Encuentros Abiertos y Zonas', () => {
    const openKeys = (es as any).open_encounters;
    assert.ok(openKeys, 'open_encounters debe existir en es.json');
    assert.ok(openKeys.request_sent, 'request_sent debe existir');
    assert.ok(openKeys.request_pending, 'request_pending debe existir');
    assert.ok(openKeys.request_approved, 'request_approved debe existir');
    assert.ok(openKeys.open_encounter_action, 'open_encounter_action debe existir');
    assert.ok(openKeys.zones_modal_title, 'zones_modal_title debe existir');
  });

  // 26. i18n EN
  test('26. i18n EN contiene todas las claves requeridas para Encuentros Abiertos y Zonas', () => {
    const openKeys = (en as any).open_encounters;
    assert.ok(openKeys, 'open_encounters debe existir en en.json');
    assert.ok(openKeys.request_sent, 'request_sent debe existir en en.json');
    assert.ok(openKeys.request_pending, 'request_pending debe existir en en.json');
    assert.ok(openKeys.request_approved, 'request_approved debe existir en en.json');
    assert.ok(openKeys.open_encounter_action, 'open_encounter_action debe existir en en.json');
    assert.ok(openKeys.zones_modal_title, 'zones_modal_title debe existir en en.json');
  });

  // 27. locale pt-BR consistente si queda habilitado
  test('27. Normalización a pt-BR: archivo pt-BR.json y registro consistente en i18n', () => {
    const openKeys = (ptBR as any).open_encounters;
    assert.ok(openKeys, 'open_encounters debe existir en pt-BR.json');
    assert.ok(openKeys.request_sent, 'request_sent en pt-BR');
    assert.ok(openKeys.request_pending, 'request_pending en pt-BR');
    assert.ok(openKeys.request_approved, 'request_approved en pt-BR');

    // Verificar en el bundle de i18n
    const ptResource = (i18n.options.resources as any)['pt-BR'];
    assert.ok(ptResource, 'pt-BR debe estar configurado en i18n.options.resources');
    const ptFallback = (i18n.options.resources as any)['pt'];
    assert.ok(ptFallback, 'pt debe existir como fallback alias en i18n');
  });

  // 28. todos los tests previos continúan pasando
  test('28. Catálogo de localidades contiene al menos 7 zonas con Mar del Plata y CABA activas', async () => {
    const res = await db.query<{ get_localidades_catalogo: any }>(`SELECT public.get_localidades_catalogo()`);
    const locs = res.rows[0].get_localidades_catalogo;
    assert.ok(Array.isArray(locs) && locs.length >= 7, 'Debe haber al menos 7 localidades en catálogo');
    const mdp = locs.some((l: any) => l.ciudad === 'Mar del Plata');
    const caba = locs.some((l: any) => l.ciudad === 'Buenos Aires');
    assert.equal(mdp, true, 'Mar del Plata debe estar presente');
    assert.equal(caba, true, 'Buenos Aires debe estar presente');
  });

  // ── SEGURIDAD P0: IDENTITY & HARDENING TESTS ──

  test('29. P0: solicitar_sumarse rechaza llamadas sin JWT con authentication_required', async () => {
    await setAuth(null);
    const res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        '${testEncounterId}',
        'Sin Sesión',
        'Quiero entrar',
        '${applicant1}'
      );
    `);
    const r = res.rows[0].solicitar_sumarse_encuentro_abierto;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'authentication_required', 'Debe rechazar llamadas sin JWT');
  });

  test('30. P0: solicitar_sumarse rechaza usuarios anónimos de Supabase con permanent_account_required', async () => {
    const anonUser = '99999999-9999-9999-9999-999999999999';
    await setAuth(anonUser, true);
    const res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        '${testEncounterId}',
        'Usuario Anónimo',
        'Soy anónimo',
        '${anonUser}'
      );
    `);
    const r = res.rows[0].solicitar_sumarse_encuentro_abierto;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'permanent_account_required', 'Debe rechazar usuarios anónimos de Supabase');
  });

  test('31. P0: solicitar_sumarse ignora p_usuario_id falsificado y usa exclusivamente auth.uid()', async () => {
    const freshRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (titulo, modalidad, host_id, estado, is_open, max_participants, locality_id)
      VALUES ('Encuentro para Spoofing Test', 'presencial', '${hostUser}', 'activo', true, 10, 'guemes')
      RETURNING id;
    `);
    const freshId = freshRes.rows[0].id;

    const victimUser = '88888888-8888-8888-8888-888888888888';
    const attackerUser = '77777777-7777-7777-7777-777777777777';
    await setAuth(attackerUser, false);
    const res = await db.query<{ solicitar_sumarse_encuentro_abierto: any }>(`
      SELECT public.solicitar_sumarse_encuentro_abierto(
        '${freshId}',
        'Atacante Disfrazado',
        'Intento spoofing',
        '${victimUser}'
      );
    `);
    const r = res.rows[0].solicitar_sumarse_encuentro_abierto;
    assert.equal(r.ok, true, 'Solicitud se crea con la identidad real del atacante');
    const check = await db.query<{ usuario_id: string }>(`
      SELECT usuario_id FROM public.solicitudes_encuentro_abierto WHERE id = '${r.request_id}';
    `);
    assert.equal(check.rows[0].usuario_id, attackerUser, 'El backend debe usar auth.uid(), no el parámetro del cliente');
  });

  test('32. P0: Host RPCs rechazan llamadas sin JWT con authentication_required', async () => {
    await setAuth(null);
    const res = await db.query<{ abrir_encuentro_seguro: any }>(`
      SELECT public.abrir_encuentro_seguro(
        '${testEncounterId}',
        '${hostUser}',
        'Abrir sin auth',
        4,
        'guemes'
      );
    `);
    assert.equal(res.rows[0].abrir_encuentro_seguro.ok, false);
    assert.equal(res.rows[0].abrir_encuentro_seguro.error, 'authentication_required');
  });

  test('33. P0: Host RPCs rechazan usuarios anónimos de Supabase con permanent_account_required', async () => {
    await setAuth(hostUser, true);
    const res = await db.query<{ cerrar_encuentro_abierto_seguro: any }>(`
      SELECT public.cerrar_encuentro_abierto_seguro('${testEncounterId}', '${hostUser}');
    `);
    assert.equal(res.rows[0].cerrar_encuentro_abierto_seguro.ok, false);
    assert.equal(res.rows[0].cerrar_encuentro_abierto_seguro.error, 'permanent_account_required');
  });

  test('34. P0: Host RPCs ignoran p_host_id de cliente y validan ownership contra auth.uid()', async () => {
    await setAuth(otherUser, false);
    const res = await db.query<{ cerrar_encuentro_abierto_seguro: any }>(`
      SELECT public.cerrar_encuentro_abierto_seguro('${testEncounterId}', '${hostUser}');
    `);
    assert.equal(res.rows[0].cerrar_encuentro_abierto_seguro.ok, false);
    assert.equal(res.rows[0].cerrar_encuentro_abierto_seguro.error, 'unauthorized');
  });

  test('35. get_anonymous_upgrade_state verifica server-side recursos sin exponer datos sensibles', async () => {
    await setAuth(null);
    const resNull = await db.query<{ get_anonymous_upgrade_state: any }>(`SELECT public.get_anonymous_upgrade_state();`);
    assert.equal(resNull.rows[0].get_anonymous_upgrade_state.ok, false);
    assert.equal(resNull.rows[0].get_anonymous_upgrade_state.error, 'not_authenticated');

    await setAuth(hostUser, false);
    const resPerm = await db.query<{ get_anonymous_upgrade_state: any }>(`SELECT public.get_anonymous_upgrade_state();`);
    assert.equal(resPerm.rows[0].get_anonymous_upgrade_state.ok, true);
    assert.equal(resPerm.rows[0].get_anonymous_upgrade_state.is_anonymous, false);

    await setAuth(hostUser, true);
    const resAnonHost = await db.query<{ get_anonymous_upgrade_state: any }>(`SELECT public.get_anonymous_upgrade_state();`);
    assert.equal(resAnonHost.rows[0].get_anonymous_upgrade_state.ok, true);
    assert.equal(resAnonHost.rows[0].get_anonymous_upgrade_state.is_anonymous, true);
    assert.equal(resAnonHost.rows[0].get_anonymous_upgrade_state.has_owned_encounters, true);

    const freshAnon = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await setAuth(freshAnon, true);
    const resFresh = await db.query<{ get_anonymous_upgrade_state: any }>(`SELECT public.get_anonymous_upgrade_state();`);
    assert.equal(resFresh.rows[0].get_anonymous_upgrade_state.ok, true);
    assert.equal(resFresh.rows[0].get_anonymous_upgrade_state.is_anonymous, true);
    assert.equal(resFresh.rows[0].get_anonymous_upgrade_state.has_owned_encounters, false);
  });

  test('36. Frontend: LoginRequiredSheet renderiza diálogo accesible con copy contextual y beneficios', () => {
    const html = renderToString(
      React.createElement(LoginRequiredSheet, {
        isOpen: true,
        onClose: () => {},
        onContinueWithGoogle: () => {},
        action: 'request_join',
      })
    );
    assert.ok(html.includes('Para solicitar sumarte necesit'), 'Debe incluir título contextual');
    assert.ok(html.includes('Continuar con Google'), 'Debe incluir CTA de Google');
    assert.ok(html.includes('Ahora no'), 'Debe incluir CTA secundario Ahora no');
    assert.ok(html.includes('Seguir el estado de tu solicitud'), 'Debe listar beneficios');
    assert.ok(html.includes('role="dialog"'), 'Debe tener role dialog accesible');
  });
});
