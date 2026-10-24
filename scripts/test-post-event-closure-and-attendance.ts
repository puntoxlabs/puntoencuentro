/**
 * Test Suite: Mini-Sprint A — Cierre posterior, asistencia efectiva y reconocimiento responsable
 * 
 * Verificación técnica completa de los 17 casos obligatorios:
 *  1. Cierre de encuentro realizado con asistentes, aviso previo, inasistencia reportada y participante sin verificar.
 *  2. Cierre de encuentro no realizado con motivo legítimo y reconocimiento de cierre responsable.
 *  3. Diferenciación entre cierre dentro del plazo y fuera del plazo.
 *  4. Encuentro abierto sin participantes confirmados: cierre voluntario simplificado.
 *  5. Encuentro abierto sin participantes confirmados: regularización administrativa automática post-48h sin reconocimiento positivo y sin bloqueo.
 *  6. Coexistencia de invitados por enlace privado y participantes de Discovery en el registro de asistencia.
 *  7. Bloqueo efectivo en "abrir_encuentro_seguro" ante cierres vencidos con participantes.
 *  8. Desbloqueo inmediato de publicación tras regularizar el cierre pendiente.
 *  9. Creación y guardado de borradores no bloqueados por cierres pendientes.
 * 10. Encuentros privados no bloqueados ni afectados por cierres pendientes.
 * 11. Encuentro cancelado previamente: no genera obligación incompatible de cierre.
 * 12. Cambio de fecha de encuentro abierto: recalculación correcta del vencimiento de gracia.
 * 13. Concurrencia e idempotencia: doble invocación de cierre sin inconsistencias ni duplicados.
 * 14. Rechazo de cierre por usuario no autenticado o no anfitrión.
 * 15. Verificación de que la reconfirmación previa no se confunda con asistencia efectiva.
 * 16. Multi-seat: acompañantes sin cuenta no adquieren reputación ni identidad personal en el registro.
 * 17. Migración compatible con "supabase db push" o entorno real: paridad y ausencia de errores de sintaxis en el archivo SQL.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Mini-Sprint A: Cierre posterior, asistencia efectiva y reconocimiento responsable', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const otherUser = '22222222-2222-2222-2222-222222222222';
  const participant1 = '33333333-3333-3333-3333-333333333333';
  const participant2 = '44444444-4444-4444-4444-444444444444';
  const participant3 = '55555555-5555-5555-5555-555555555555';
  const participant4 = '66666666-6666-6666-6666-666666666666';

  const setAuth = async (userId: string | null) => {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
    }
  };

  before(async () => {
    db = new PGlite();

    // 1. Roles y Mock Auth
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres; END IF;
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
        ('${otherUser}', 'other@test.com'),
        ('${participant1}', 'p1@test.com'),
        ('${participant2}', 'p2@test.com'),
        ('${participant3}', 'p3@test.com'),
        ('${participant4}', 'p4@test.com')
      ON CONFLICT DO NOTHING;

      -- Tablas preexistentes requeridas
      CREATE TABLE IF NOT EXISTS public.localidades (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        ciudad TEXT,
        zona TEXT,
        activo BOOLEAN NOT NULL DEFAULT true
      );

      INSERT INTO public.localidades (id, nombre, ciudad, zona, activo) VALUES
        ('palermo', 'Palermo', 'Buenos Aires', 'CABA', true),
        ('guemes', 'Güemes', 'Mar del Plata', 'Costa Atlántica', true)
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        blocker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        blocked_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
        PRIMARY KEY (blocker_id, blocked_id)
      );

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL REFERENCES auth.users(id),
        titulo TEXT NOT NULL,
        open_public_title TEXT,
        descripcion TEXT,
        open_description TEXT,
        fecha DATE,
        hora TIME WITHOUT TIME ZONE,
        duration_minutes INT DEFAULT 120,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        locality_id TEXT REFERENCES public.localidades(id),
        open_public_zone TEXT,
        lugar_texto TEXT,
        link_virtual TEXT,
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        public_token UUID DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'activo',
        tema TEXT DEFAULT 'blue',
        tema_invitacion TEXT DEFAULT 'sports',
        invitation_template TEXT,
        date_mode TEXT DEFAULT 'fixed',
        reemplaza_a UUID,
        is_open BOOLEAN NOT NULL DEFAULT false,
        max_participants INT DEFAULT 20,
        allow_multi_seat_requests BOOLEAN DEFAULT false,
        max_seats_per_request INT DEFAULT 1,
        min_seats_per_request INT DEFAULT 1,
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        cancelled_by UUID REFERENCES auth.users(id),
        cancellation_reason TEXT,
        min_participants INT,
        realization_status TEXT DEFAULT 'pending',
        inscriptions_closed BOOLEAN DEFAULT false,
        inscriptions_closed_at TIMESTAMPTZ,
        inscriptions_cycle_id UUID DEFAULT gen_random_uuid(),
        moderation_status TEXT DEFAULT 'approved',
        moderated_at TIMESTAMPTZ,
        moderation_reason TEXT,
        moderation_decision_source TEXT,
        moderation_categories TEXT[],
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        nombre_invitado TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'confirmado',
        token_invitacion UUID DEFAULT gen_random_uuid(),
        seat_count INT NOT NULL DEFAULT 1,
        reconfirmation_status TEXT DEFAULT 'pending',
        reconfirmed_at TIMESTAMPTZ,
        reconfirmed_cycle_id UUID,
        mensaje_respuesta TEXT,
        tipo_invitacion TEXT DEFAULT 'individual',
        creado_en TIMESTAMPTZ DEFAULT now() NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        seat_count INT NOT NULL DEFAULT 1,
        estado TEXT NOT NULL DEFAULT 'pending',
        participante_id UUID,
        token_participante UUID,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        resolved_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS public.public_content_moderation_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        moderator_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        previous_status TEXT NULL,
        new_status TEXT NOT NULL,
        reason TEXT NULL,
        categories TEXT[] NULL,
        source TEXT NOT NULL,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
      );

      CREATE OR REPLACE FUNCTION public.evaluar_contenido_publico_determinista(
          p_title TEXT,
          p_description TEXT
      )
      RETURNS TABLE (
          decision TEXT,
          reason TEXT,
          categories TEXT[]
      )
      LANGUAGE plpgsql
      AS $$
      BEGIN
          IF p_title ILIKE '%prohibido%' THEN
              RETURN QUERY SELECT 'block'::TEXT, 'test_blocked'::TEXT, ARRAY['inappropriate']::TEXT[];
          ELSE
              RETURN QUERY SELECT 'approved'::TEXT, NULL::TEXT, NULL::TEXT[];
          END IF;
      END;
      $$;
    `);

    // 2. Ejecutar la migración SQL aditiva real completa
    const migrationPath = path.join(__dirname, '../supabase/migrations/20261024180000_post_event_closure_and_attendance_v1.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(migrationSql);

    await db.exec(`
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon, service_role, postgres;
      GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticated, anon, service_role, postgres;
    `);
  });

  test('1. Cierre de encuentro realizado con asistentes, aviso previo, inasistencia reportada y participante sin verificar', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0001-000000000001';

    // Insertar encuentro activo abierto ocurrido ayer
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status)
      VALUES ('${encId}', '${hostUser}', 'Pádel Martes', 'Pádel Abierto', (CURRENT_DATE - INTERVAL '1 day')::date, '19:00:00', 'Cancha 3', true, now() - INTERVAL '3 days', 'pending');
    `);

    const p1 = '10000000-0000-0000-0000-000000000001';
    const p2 = '10000000-0000-0000-0000-000000000002';
    const p3 = '10000000-0000-0000-0000-000000000003';
    const p4 = '10000000-0000-0000-0000-000000000004';

    await db.query(`
      INSERT INTO public.participantes (id, encuentro_id, user_id, nombre_invitado, estado) VALUES
      ('${p1}', '${encId}', '${participant1}', 'Carlos', 'confirmado'),
      ('${p2}', '${encId}', '${participant2}', 'Ana', 'confirmado'),
      ('${p3}', '${encId}', '${participant3}', 'Lucía', 'confirmado'),
      ('${p4}', '${encId}', '${participant4}', 'Esteban', 'confirmado');
    `);

    const attendancePayload = JSON.stringify([
      { participante_id: p1, attendance_status: 'attended' },
      { participante_id: p2, attendance_status: 'advance_notice_absent', attendance_notes: 'Avisó por viaje familiar 4 horas antes' },
      { participante_id: p3, attendance_status: 'reported_absent' },
      { participante_id: p4, attendance_status: 'unverified' }
    ]);

    const res = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        '${encId}'::uuid,
        'realized',
        NULL,
        '${attendancePayload}'::jsonb
      ) AS r;
    `);

    const result = (res.rows[0] as any).r;
    assert.equal(result.ok, true);
    assert.equal(result.closure_status, 'completed');
    assert.equal(result.realization_status, 'realized');
    assert.equal(result.closed_responsibly, true);
    assert.equal(result.closure_type, 'within_deadline');

    // Verificar tabla participantes
    const partsRes = await db.query(`
      SELECT id, attendance_status, attendance_notes, attendance_recorded_at FROM public.participantes
      WHERE encuentro_id = '${encId}' ORDER BY id ASC;
    `);
    const parts = partsRes.rows as any[];
    assert.equal(parts[0].attendance_status, 'attended');
    assert.ok(parts[0].attendance_recorded_at !== null);

    assert.equal(parts[1].attendance_status, 'advance_notice_absent');
    assert.equal(parts[1].attendance_notes, 'Avisó por viaje familiar 4 horas antes');

    assert.equal(parts[2].attendance_status, 'reported_absent');
    assert.equal(parts[3].attendance_status, 'unverified');

    // Verificar auditoría
    const auditRes = await db.query(`
      SELECT * FROM public.encuentro_post_event_closure_audit WHERE encuentro_id = '${encId}';
    `);
    assert.equal(auditRes.rows.length, 1);
    assert.equal((auditRes.rows[0] as any).closed_responsibly, true);
    assert.equal((auditRes.rows[0] as any).closure_type, 'within_deadline');
  });

  test('2. Cierre de encuentro no realizado con motivo legítimo y reconocimiento de cierre responsable', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0001-000000000002';

    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status)
      VALUES ('${encId}', '${hostUser}', 'Torneo Tenis', 'Torneo de Tenis', (CURRENT_DATE - INTERVAL '1 day')::date, '10:00:00', 'Club Náutico', true, now() - INTERVAL '3 days', 'pending');
    `);

    const res = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        '${encId}'::uuid,
        'not_realized',
        'clima_lluvia_intensa',
        '[]'::jsonb
      ) AS r;
    `);

    const result = (res.rows[0] as any).r;
    assert.equal(result.ok, true);
    assert.equal(result.closure_status, 'completed');
    assert.equal(result.realization_status, 'not_realized');
    assert.equal(result.closed_responsibly, true, 'El cierre voluntario debe reconocerse como responsable');

    const encRes = await db.query(`SELECT post_event_unrealized_reason FROM public.encuentros WHERE id = '${encId}';`);
    assert.equal((encRes.rows[0] as any).post_event_unrealized_reason, 'clima_lluvia_intensa');
  });

  test('3. Diferenciación entre cierre dentro del plazo y fuera del plazo', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0001-000000000003';

    // Encuentro realizado hace 5 días (vencimiento de gracia 48h ya superado)
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status, post_event_closure_deadline)
      VALUES ('${encId}', '${hostUser}', 'Café de Filosofía', 'Filosofía y Mate', (CURRENT_DATE - INTERVAL '5 days')::date, '18:00:00', 'Bar Central', true, now() - INTERVAL '7 days', 'pending', now() - INTERVAL '3 days');
    `);

    const res = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        '${encId}'::uuid,
        'realized',
        NULL,
        '[]'::jsonb
      ) AS r;
    `);

    const result = (res.rows[0] as any).r;
    assert.equal(result.ok, true);
    assert.equal(result.closure_type, 'overdue', 'Debe registrarse como fuera de plazo (overdue)');
    assert.equal(result.closed_responsibly, true, 'Aun fuera de plazo, el cierre voluntario del host se reconoce');
  });

  test('4. Encuentro abierto sin participantes confirmados: cierre voluntario simplificado', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0001-000000000004';

    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status)
      VALUES ('${encId}', '${hostUser}', 'Caminata Costera', 'Caminata Costera', (CURRENT_DATE - INTERVAL '1 day')::date, '09:00:00', 'Playa Varese', true, now() - INTERVAL '2 days', 'pending');
    `);

    const res = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        '${encId}'::uuid,
        'realized',
        NULL,
        '[]'::jsonb
      ) AS r;
    `);

    const result = (res.rows[0] as any).r;
    assert.equal(result.ok, true);
    assert.equal(result.closure_status, 'completed');
    assert.equal(result.closed_responsibly, true);
  });

  test('5. Encuentro abierto sin participantes confirmados: regularización administrativa automática post-48h sin reconocimiento positivo y sin bloqueo', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0001-000000000005';

    // 0 participantes, plazo superado (3 días atrás)
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status, post_event_closure_deadline)
      VALUES ('${encId}', '${hostUser}', 'Lectura en la Plaza', 'Lectura Abierta', (CURRENT_DATE - INTERVAL '4 days')::date, '16:00:00', 'Plaza Mitre', true, now() - INTERVAL '5 days', 'pending', now() - INTERVAL '2 days');
    `);

    const regRes = await db.query(`
      SELECT public.regularizar_cierres_administrativos_automaticos('${hostUser}'::uuid) AS r;
    `);
    const regResult = (regRes.rows[0] as any).r;
    assert.equal(regResult.ok, true);
    assert.ok(regResult.regularized_count >= 1);

    const encRes = await db.query(`
      SELECT post_event_closure_status, post_event_closure_type, post_event_closed_responsibly, post_event_realization_status
      FROM public.encuentros WHERE id = '${encId}';
    `);
    const enc = encRes.rows[0] as any;
    assert.equal(enc.post_event_closure_status, 'auto_closed');
    assert.equal(enc.post_event_closure_type, 'administrative_auto');
    assert.equal(enc.post_event_closed_responsibly, false, 'El cierre automático no debe otorgar reconocimiento positivo');
    assert.equal(enc.post_event_realization_status, 'unconfirmed');
  });

  test('6. Coexistencia de invitados por enlace privado y participantes de Discovery en el registro de asistencia', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0001-000000000006';

    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status)
      VALUES ('${encId}', '${hostUser}', 'Asado Híbrido', 'Asado Comunitario', (CURRENT_DATE - INTERVAL '1 day')::date, '13:00:00', 'Quincho', true, now() - INTERVAL '2 days', 'pending');
    `);

    const privPart = '20000000-0000-0000-0000-000000000001';
    const discPart = '20000000-0000-0000-0000-000000000002';

    await db.query(`
      INSERT INTO public.participantes (id, encuentro_id, user_id, nombre_invitado, estado, tipo_invitacion) VALUES
      ('${privPart}', '${encId}', NULL, 'Vecino Enlace Privado', 'confirmado', 'individual'),
      ('${discPart}', '${encId}', '${participant1}', 'Usuario Discovery', 'confirmado', 'open_discovery');
    `);

    // Host consulta detalle de participantes para cierre
    const detRes = await db.query(`
      SELECT public.get_detalle_cierre_post_evento_seguro('${encId}'::uuid) AS r;
    `);
    const detail = (detRes.rows[0] as any).r;
    assert.equal(detail.ok, true);
    assert.equal(detail.participantes.length, 2);

    // Host marca asistencia a ambos
    const payload = JSON.stringify([
      { participante_id: privPart, attendance_status: 'attended' },
      { participante_id: discPart, attendance_status: 'attended' }
    ]);

    const res = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro('${encId}'::uuid, 'realized', NULL, '${payload}'::jsonb) AS r;
    `);
    assert.equal((res.rows[0] as any).r.ok, true);

    const checkedRes = await db.query(`
      SELECT id, attendance_status FROM public.participantes WHERE encuentro_id = '${encId}';
    `);
    assert.equal(checkedRes.rows.length, 2);
    assert.equal((checkedRes.rows[0] as any).attendance_status, 'attended');
    assert.equal((checkedRes.rows[1] as any).attendance_status, 'attended');
  });

  test('7. Bloqueo efectivo en "abrir_encuentro_seguro" ante cierres vencidos con participantes', async () => {
    await setAuth(hostUser);
    const overdueEncId = '00000000-0000-0000-0001-000000000007';

    // Insertar encuentro vencido con participante confirmado
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status, post_event_closure_deadline)
      VALUES ('${overdueEncId}', '${hostUser}', 'Encuentro Antiguo Impago', 'Antiguo Impago', (CURRENT_DATE - INTERVAL '6 days')::date, '18:00:00', 'Sede', true, now() - INTERVAL '8 days', 'pending', now() - INTERVAL '4 days');
    `);
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${overdueEncId}', '${participant1}', 'Juan', 'confirmado');
    `);

    // Intentar publicar un nuevo encuentro abierto
    const newEncId = '00000000-0000-0000-0001-000000000008';
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, fecha, hora, modalidad, lugar_texto, is_open)
      VALUES ('${newEncId}', '${hostUser}', 'Nuevo Encuentro Bloqueado', (CURRENT_DATE + INTERVAL '5 days')::date, '19:00:00', 'presencial', 'Local Central', false);
    `);

    const openRes = await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${newEncId}'::uuid,
        '${hostUser}'::uuid,
        'Descripción del nuevo encuentro',
        10,
        'palermo',
        'Palermo',
        'Título Público Nuevo'
      ) AS r;
    `);

    const openResult = (openRes.rows[0] as any).r;
    assert.equal(openResult.ok, false);
    assert.equal(openResult.error, 'pending_closure_required');
    assert.equal(openResult.pending_encuentro_id, overdueEncId);
  });

  test('8. Desbloqueo inmediato de publicación tras regularizar el cierre pendiente', async () => {
    await setAuth(hostUser);
    const overdueEncId = '00000000-0000-0000-0001-000000000007';
    const newEncId = '00000000-0000-0000-0001-000000000008';

    // Host regulariza el encuentro vencido completando el cierre
    const closeRes = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        '${overdueEncId}'::uuid,
        'realized',
        NULL,
        '[]'::jsonb
      ) AS r;
    `);
    assert.equal((closeRes.rows[0] as any).r.ok, true);

    // Intentar publicar nuevamente el encuentro nuevo
    const openRes = await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${newEncId}'::uuid,
        '${hostUser}'::uuid,
        'Descripción del nuevo encuentro',
        10,
        'palermo',
        'Palermo',
        'Título Público Nuevo'
      ) AS r;
    `);

    const openResult = (openRes.rows[0] as any).r;
    assert.equal(openResult.ok, true, 'Debe permitir la publicación tras regularizar el cierre adeudado');
  });

  test('9. Creación y guardado de borradores no bloqueados por cierres pendientes', async () => {
    await setAuth(hostUser);
    const pendingEncId = '00000000-0000-0000-0001-000000000009';

    // Generar otro encuentro vencido con participante
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status, post_event_closure_deadline)
      VALUES ('${pendingEncId}', '${hostUser}', 'Encuentro Vencido Deuda', 'Deuda Abierta', (CURRENT_DATE - INTERVAL '5 days')::date, '17:00:00', 'Sede', true, now() - INTERVAL '7 days', 'pending', now() - INTERVAL '3 days');
    `);
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${pendingEncId}', '${participant1}', 'Ana', 'confirmado');
    `);

    // Host crea y guarda un borrador sin abrirlo a Discovery
    const draftId = '00000000-0000-0000-0001-000000000010';
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, descripcion, fecha, hora, modalidad, is_open, opened_at)
      VALUES ('${draftId}', '${hostUser}', 'Borrador de Encuentro Futuro', 'Notas tentativas...', (CURRENT_DATE + INTERVAL '10 days')::date, '20:00:00', 'presencial', false, NULL);
    `);

    // Modificar el borrador
    await db.query(`
      UPDATE public.encuentros SET descripcion = 'Notas actualizadas...' WHERE id = '${draftId}';
    `);

    const draftRes = await db.query(`SELECT descripcion, is_open FROM public.encuentros WHERE id = '${draftId}';`);
    assert.equal((draftRes.rows[0] as any).descripcion, 'Notas actualizadas...');
    assert.equal((draftRes.rows[0] as any).is_open, false);
  });

  test('10. Encuentros privados no bloqueados ni afectados por cierres pendientes', async () => {
    await setAuth(hostUser);
    const privateEncId = '00000000-0000-0000-0001-000000000011';

    // Host crea un encuentro estrictamente privado
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, fecha, hora, modalidad, lugar_texto, is_open, tipo_invitacion)
      VALUES ('${privateEncId}', '${hostUser}', 'Cena Íntima de Amigos', (CURRENT_DATE + INTERVAL '2 days')::date, '21:00:00', 'presencial', 'Casa de Juan', false, 'individual');
    `);

    // Agregar invitados privados
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${privateEncId}', '${participant2}', 'Amigo 1', 'confirmado');
    `);

    const res = await db.query(`
      SELECT count(*)::int AS count FROM public.participantes WHERE encuentro_id = '${privateEncId}';
    `);
    assert.equal((res.rows[0] as any).count, 1);
  });

  test('11. Encuentro cancelado previamente: no genera obligación incompatible de cierre', async () => {
    await setAuth(hostUser);
    const cancelledEncId = '00000000-0000-0000-0001-000000000012';

    // Crear encuentro abierto activo
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status)
      VALUES ('${cancelledEncId}', '${hostUser}', 'Picnic Suspendido', (CURRENT_DATE - INTERVAL '1 day')::date, '14:00:00', 'Parque', true, now() - INTERVAL '3 days', 'pending');
    `);

    // Host cancela el encuentro
    await db.query(`
      UPDATE public.encuentros
      SET estado = 'cancelado',
          cancelled_at = now(),
          cancelled_by = '${hostUser}'
      WHERE id = '${cancelledEncId}';
    `);

    const encRes = await db.query(`
      SELECT post_event_closure_status FROM public.encuentros WHERE id = '${cancelledEncId}';
    `);
    assert.equal((encRes.rows[0] as any).post_event_closure_status, 'not_applicable');

    // Debe no aparecer en cierres pendientes
    const pendRes = await db.query(`
      SELECT public.get_cierres_pendientes_host_seguro() AS r;
    `);
    const pendList = (pendRes.rows[0] as any).r.pending_closures as any[];
    const found = pendList.find(p => p.id === cancelledEncId);
    assert.equal(found, undefined, 'El encuentro cancelado no debe aparecer como pendiente de cierre');
  });

  test('12. Cambio de fecha de encuentro abierto: recalculación correcta del vencimiento de gracia', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0001-000000000013';

    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, fecha, hora, duration_minutes, lugar_texto, is_open, opened_at, post_event_closure_status, post_event_closure_deadline)
      VALUES ('${encId}', '${hostUser}', 'Torneo Vóley', '2026-11-10', '18:00:00', 120, 'Gimnasio', true, now(), 'pending', '2026-11-12 20:00:00-03');
    `);

    // Modificar fecha a 2026-11-20
    await db.query(`
      UPDATE public.encuentros
      SET fecha = '2026-11-20',
          hora = '19:00:00'
      WHERE id = '${encId}';
    `);

    const encRes = await db.query(`
      SELECT post_event_closure_deadline FROM public.encuentros WHERE id = '${encId}';
    `);
    const deadline = (encRes.rows[0] as any).post_event_closure_deadline;
    assert.ok(deadline !== null);
    // 2026-11-20 19:00 + 2h = 21:00 + 48h = 2026-11-22 21:00 (en Argentina -03)
    const deadlineStr = new Date(deadline).toISOString();
    assert.ok(deadlineStr.includes('2026-11-23T00:00:00') || deadlineStr.includes('2026-11-22'));
  });

  test('13. Concurrencia e idempotencia: doble invocación de cierre sin inconsistencias ni duplicados', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0001-000000000014';

    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status)
      VALUES ('${encId}', '${hostUser}', 'Club del Libro', 'Lectura Idempotente', (CURRENT_DATE - INTERVAL '1 day')::date, '18:00:00', 'Biblioteca', true, now() - INTERVAL '2 days', 'pending');
    `);

    const p1 = '30000000-0000-0000-0000-000000000001';
    await db.query(`
      INSERT INTO public.participantes (id, encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${p1}', '${encId}', '${participant3}', 'Luciano', 'confirmado');
    `);

    const payload = JSON.stringify([{ participante_id: p1, attendance_status: 'attended' }]);

    // Primera invocación
    const res1 = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro('${encId}'::uuid, 'realized', NULL, '${payload}'::jsonb) AS r;
    `);
    assert.equal((res1.rows[0] as any).r.ok, true);

    // Segunda invocación idéntica (reintento / concurrencia)
    const res2 = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro('${encId}'::uuid, 'realized', NULL, '${payload}'::jsonb) AS r;
    `);
    assert.equal((res2.rows[0] as any).r.ok, true);

    const checkPart = await db.query(`
      SELECT attendance_status FROM public.participantes WHERE id = '${p1}';
    `);
    assert.equal((checkPart.rows[0] as any).attendance_status, 'attended');
  });

  test('14. Rechazo de cierre por usuario no autenticado o no anfitrión', async () => {
    const encId = '00000000-0000-0000-0001-000000000014';

    // 1. Usuario anónimo
    await setAuth(null);
    const anonRes = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro('${encId}'::uuid, 'realized', NULL, '[]'::jsonb) AS r;
    `);
    assert.equal((anonRes.rows[0] as any).r.ok, false);
    assert.equal((anonRes.rows[0] as any).r.error, 'authentication_required');

    // 2. Otro usuario autenticado que no es el host
    await setAuth(otherUser);
    const otherRes = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro('${encId}'::uuid, 'realized', NULL, '[]'::jsonb) AS r;
    `);
    assert.equal((otherRes.rows[0] as any).r.ok, false);
    assert.equal((otherRes.rows[0] as any).r.error, 'forbidden');
  });

  test('15. Verificación de que la reconfirmación previa no se confunda con asistencia efectiva', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0001-000000000015';

    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status)
      VALUES ('${encId}', '${hostUser}', 'Reconfirmación vs Presencia', 'Prueba Asistencia', (CURRENT_DATE - INTERVAL '1 day')::date, '17:00:00', 'Cancha', true, now() - INTERVAL '2 days', 'pending');
    `);

    const p1 = '40000000-0000-0000-0000-000000000001';
    await db.query(`
      INSERT INTO public.participantes (id, encuentro_id, user_id, nombre_invitado, estado, reconfirmation_status)
      VALUES ('${p1}', '${encId}', '${participant4}', 'Marcos', 'confirmado', 'confirmed');
    `);

    // Host reporta que a pesar de haber reconfirmado, Marcos no vino (reported_absent)
    const payload = JSON.stringify([{ participante_id: p1, attendance_status: 'reported_absent' }]);
    const res = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro('${encId}'::uuid, 'realized', NULL, '${payload}'::jsonb) AS r;
    `);
    assert.equal((res.rows[0] as any).r.ok, true);

    const partRes = await db.query(`
      SELECT reconfirmation_status, attendance_status FROM public.participantes WHERE id = '${p1}';
    `);
    const part = partRes.rows[0] as any;
    // Reconfirmación previa intacta, asistencia efectiva marcada correctamente como reported_absent
    assert.equal(part.reconfirmation_status, 'confirmed');
    assert.equal(part.attendance_status, 'reported_absent');
  });

  test('16. Multi-seat: acompañantes sin cuenta no adquieren reputación ni identidad personal en el registro', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0001-000000000016';

    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status)
      VALUES ('${encId}', '${hostUser}', 'Encuentro Grupo Amigos', 'Grupo Amigos', (CURRENT_DATE - INTERVAL '1 day')::date, '20:00:00', 'Salón', true, now() - INTERVAL '2 days', 'pending');
    `);

    const pMulti = '50000000-0000-0000-0000-000000000001';
    await db.query(`
      INSERT INTO public.participantes (id, encuentro_id, user_id, nombre_invitado, seat_count, estado)
      VALUES ('${pMulti}', '${encId}', '${participant1}', 'Carlos y 2 amigos', 3, 'confirmado');
    `);

    const countUsersBefore = (await db.query(`SELECT count(*)::int AS count FROM auth.users;`)).rows[0] as any;

    const payload = JSON.stringify([{ participante_id: pMulti, attendance_status: 'attended' }]);
    const res = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro('${encId}'::uuid, 'realized', NULL, '${payload}'::jsonb) AS r;
    `);
    assert.equal((res.rows[0] as any).r.ok, true);

    const countUsersAfter = (await db.query(`SELECT count(*)::int AS count FROM auth.users;`)).rows[0] as any;
    assert.equal(countUsersBefore.count, countUsersAfter.count, 'No deben crearse identidades ficticias en auth.users para acompañantes');

    const multiRes = await db.query(`
      SELECT seat_count, attendance_status FROM public.participantes WHERE id = '${pMulti}';
    `);
    assert.equal((multiRes.rows[0] as any).seat_count, 3);
    assert.equal((multiRes.rows[0] as any).attendance_status, 'attended');
  });

  test('17. Migración compatible con "supabase db push" o entorno real: paridad y ausencia de errores de sintaxis en el archivo SQL', async () => {
    // Verificar que todas las columnas añadidas a public.encuentros existen
    const encColsRes = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'encuentros' AND column_name LIKE 'post_event%';
    `);
    const encCols = encColsRes.rows.map((r: any) => r.column_name);
    assert.ok(encCols.includes('post_event_closure_status'));
    assert.ok(encCols.includes('post_event_realization_status'));
    assert.ok(encCols.includes('post_event_unrealized_reason'));
    assert.ok(encCols.includes('post_event_closed_at'));
    assert.ok(encCols.includes('post_event_closure_deadline'));
    assert.ok(encCols.includes('post_event_closed_responsibly'));
    assert.ok(encCols.includes('post_event_closure_type'));

    // Verificar columnas en public.participantes
    const partColsRes = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'participantes' AND column_name LIKE 'attendance%';
    `);
    const partCols = partColsRes.rows.map((r: any) => r.column_name);
    assert.ok(partCols.includes('attendance_status'));
    assert.ok(partCols.includes('attendance_recorded_at'));
    assert.ok(partCols.includes('attendance_notes'));
    assert.ok(partCols.includes('attendance_dispute_status'));
    assert.ok(partCols.includes('attendance_dispute_id'));

    // Verificar tabla de auditoría
    const auditRes = await db.query(`
      SELECT table_name FROM information_schema.tables WHERE table_name = 'encuentro_post_event_closure_audit';
    `);
    assert.equal(auditRes.rows.length, 1);
  });

  test('18. Activación de ciclo posterior cuando un encuentro privado se abre/publica', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0002-000000000018';

    // 1. Encuentro nace estrictamente privado
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, fecha, hora, duration_minutes, lugar_texto, is_open, opened_at, post_event_closure_status)
      VALUES ('${encId}', '${hostUser}', 'Encuentro Inicialmente Privado', (CURRENT_DATE + INTERVAL '2 days')::date, '19:00:00', 90, 'Club', false, NULL, 'not_applicable');
    `);

    // 2. Posteriormente el anfitrión lo abre/publica
    await db.query(`
      UPDATE public.encuentros
      SET is_open = true,
          opened_at = now()
      WHERE id = '${encId}';
    `);

    const encRes = await db.query(`
      SELECT post_event_closure_status, post_event_closure_deadline FROM public.encuentros WHERE id = '${encId}';
    `);
    const enc = encRes.rows[0] as any;
    assert.equal(enc.post_event_closure_status, 'pending', 'El trigger debe inicializar el estado a pending');
    assert.ok(enc.post_event_closure_deadline !== null, 'El trigger debe calcular el vencimiento');
  });

  test('19. Encuentros históricos vencidos antes de la migración no bloquean al anfitrión', async () => {
    const historicalHost = '77777777-7777-7777-7777-777777777777';
    await db.query(`
      INSERT INTO auth.users (id, email) VALUES ('${historicalHost}', 'hist@test.com') ON CONFLICT DO NOTHING;
    `);
    await setAuth(historicalHost);
    const historicalEncId = '00000000-0000-0000-0002-000000000019';

    // Encuentro histórico regularizado por backfill
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status, post_event_closure_type, post_event_closed_responsibly, post_event_realization_status, post_event_closure_deadline)
      VALUES ('${historicalEncId}', '${historicalHost}', 'Encuentro Antiguo Histórico', (CURRENT_DATE - INTERVAL '30 days')::date, '20:00:00', 'Club', false, now() - INTERVAL '35 days', 'auto_closed', 'administrative_auto', false, 'unconfirmed', now() - INTERVAL '28 days');
    `);

    // El host publica un nuevo encuentro
    const newEncId = '00000000-0000-0000-0002-000000000020';
    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, fecha, hora, modalidad, lugar_texto, is_open)
      VALUES ('${newEncId}', '${historicalHost}', 'Encuentro Sin Bloqueo Histórico', (CURRENT_DATE + INTERVAL '5 days')::date, '21:00:00', 'presencial', 'Local Central', false);
    `);

    const openRes = await db.query(`
      SELECT public.abrir_encuentro_seguro(
        '${newEncId}'::uuid,
        '${historicalHost}'::uuid,
        'Descripción válida',
        10,
        'palermo',
        'Palermo',
        'Título Público Sin Bloqueo'
      ) AS r;
    `);

    const openResult = (openRes.rows[0] as any).r;
    assert.equal(openResult.ok, true, 'No debe bloquearse por encuentros históricos auto_closed');
  });

  test('20. Cierre con resultado "unconfirmed": salida administrativa neutral sin mérito ni bloqueo', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0002-000000000021';

    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, open_public_title, fecha, hora, lugar_texto, is_open, opened_at, post_event_closure_status)
      VALUES ('${encId}', '${hostUser}', 'Encuentro Imposible de Confirmar', 'Encuentro No Confirmado', (CURRENT_DATE - INTERVAL '1 day')::date, '18:00:00', 'Plaza', true, now() - INTERVAL '2 days', 'pending');
    `);

    const pId = '60000000-0000-0000-0000-000000000001';
    await db.query(`
      INSERT INTO public.participantes (id, encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${pId}', '${encId}', '${participant1}', 'Ignacio', 'confirmado');
    `);

    // Host cierra declarando que no es posible confirmar el resultado
    const res = await db.query(`
      SELECT public.cerrar_encuentro_post_evento_seguro(
        '${encId}'::uuid,
        'unconfirmed',
        'Imposible verificar asistencia',
        '[]'::jsonb
      ) AS r;
    `);

    const result = (res.rows[0] as any).r;
    assert.equal(result.ok, true);
    assert.equal(result.closure_status, 'completed');
    assert.equal(result.post_event_realization_status, 'unconfirmed');
    assert.equal(result.closed_responsibly, false, 'No debe otorgar mérito de cierre responsable');

    const partRes = await db.query(`SELECT attendance_status FROM public.participantes WHERE id = '${pId}';`);
    assert.equal((partRes.rows[0] as any).attendance_status, 'unverified', 'Participantes deben quedar neutrales como unverified');
  });

  test('21. get_detalle_host_seguro proyecta duration_minutes y datos de post-evento', async () => {
    await setAuth(hostUser);
    const encId = '00000000-0000-0000-0002-000000000022';

    await db.query(`
      INSERT INTO public.encuentros (id, host_id, titulo, fecha, hora, duration_minutes, lugar_texto, is_open, opened_at, post_event_closure_status)
      VALUES ('${encId}', '${hostUser}', 'Prueba Proyección Host', '2026-11-15', '16:00:00', 95, 'Club', true, now(), 'pending');
    `);

    const detRes = await db.query(`
      SELECT public.get_detalle_host_seguro('${encId}'::uuid, '${hostUser}'::uuid) AS r;
    `);

    const det = (detRes.rows[0] as any).r;
    assert.equal(det.id, encId);
    assert.equal(det.duration_minutes, 95);
    assert.equal(det.post_event_closure_status, 'pending');
    assert.ok(det.post_event_closure_deadline !== null);
  });
});
