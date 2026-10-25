import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Mini-Sprint D: Confianza bidireccional, base factual y trayectoria en Encuentros Abiertos', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const partUserA = '22222222-2222-2222-2222-222222222222';
  const partUserB = '33333333-3333-3333-3333-333333333333';
  const modUser = '44444444-4444-4444-4444-444444444444';
  const thirdPartyUser = '55555555-5555-5555-5555-555555555555';
  const newUser = '66666666-6666-6666-6666-666666666666';

  const setAuth = async (userId: string | null, isAnon: boolean = false) => {
    if (userId) {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${userId}","is_anonymous":${isAnon}}', false);`);
    } else {
      await db.query(`SELECT set_config('request.jwt.claim.sub', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claim.role', '', false);`);
      await db.query(`SELECT set_config('request.jwt.claims', '{}', false);`);
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
        ('${partUserA}', 'parta@test.com'),
        ('${partUserB}', 'partb@test.com'),
        ('${modUser}', 'mod@test.com'),
        ('${thirdPartyUser}', 'third@test.com'),
        ('${newUser}', 'new@test.com')
      ON CONFLICT DO NOTHING;

      -- Localidades y moderadores
      CREATE TABLE IF NOT EXISTS public.localidades (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        ciudad TEXT,
        zona TEXT,
        activo BOOLEAN DEFAULT true
      );
      INSERT INTO public.localidades (id, nombre, ciudad, zona)
      VALUES ('palermo', 'Palermo', 'Buenos Aires', 'Capital')
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.moderation_authorized_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'moderator',
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      INSERT INTO public.moderation_authorized_users (user_id, role, active)
      VALUES ('${modUser}', 'moderator', true)
      ON CONFLICT DO NOTHING;

      CREATE OR REPLACE FUNCTION public.is_moderation_authorized()
      RETURNS BOOLEAN AS $$
      BEGIN
        RETURN EXISTS (
          SELECT 1 FROM public.moderation_authorized_users
          WHERE user_id = auth.uid() AND active = true
        );
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;

      -- Tabla encuentros
      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL,
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha DATE,
        hora TIME,
        duration_minutes INT DEFAULT 120,
        modalidad TEXT DEFAULT 'presencial',
        lugar_texto TEXT,
        link_virtual TEXT,
        tipo_invitacion TEXT DEFAULT 'individual',
        max_participants INT DEFAULT 10,
        min_participants INT DEFAULT 1,
        is_open BOOLEAN DEFAULT false,
        opened_at TIMESTAMPTZ,
        open_public_title TEXT,
        open_public_zone TEXT,
        locality_id TEXT REFERENCES public.localidades(id),
        estado TEXT DEFAULT 'activo',
        moderation_status TEXT DEFAULT 'approved',
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        post_event_closure_status TEXT,
        post_event_realization_status TEXT,
        post_event_closed_at TIMESTAMPTZ,
        post_event_closure_type TEXT,
        post_event_closed_responsibly BOOLEAN,
        post_event_unrealized_reason TEXT
      );

      -- Tabla participantes
      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        user_id UUID,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT DEFAULT 'individual',
        token_invitacion UUID DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'confirmado',
        seat_count INT DEFAULT 1,
        reconfirmation_status TEXT,
        reconfirmed_at TIMESTAMPTZ,
        admission_source TEXT,
        attendance_status TEXT,
        attendance_recorded_at TIMESTAMPTZ,
        attendance_notes TEXT,
        attendance_dispute_status TEXT,
        attendance_dispute_id UUID,
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      -- Solicitudes de encuentro abierto
      CREATE TABLE IF NOT EXISTS public.solicitudes_encuentro_abierto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        usuario_id UUID NOT NULL,
        nombre_solicitante TEXT NOT NULL,
        mensaje TEXT,
        estado TEXT NOT NULL DEFAULT 'approved',
        participante_id UUID REFERENCES public.participantes(id) ON DELETE SET NULL,
        token_participante UUID,
        seat_count INT DEFAULT 1,
        motivo_baja TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        resolved_at TIMESTAMPTZ
      );

      -- Notificaciones y controversias
      CREATE TABLE IF NOT EXISTS public.inbox_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_user_id UUID NOT NULL,
        notification_type TEXT NOT NULL,
        target_type TEXT,
        target_id UUID,
        deep_link TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        payload JSONB DEFAULT '{}'::jsonb,
        dedup_key TEXT,
        is_read BOOLEAN DEFAULT false,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (recipient_user_id, dedup_key)
      );

      CREATE TABLE IF NOT EXISTS public.asistencia_controversias (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id),
        participante_id UUID REFERENCES public.participantes(id),
        iniciado_por UUID NOT NULL,
        involucrado_id UUID NOT NULL,
        tipo_controversia TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'in_human_review',
        motivo_iniciador TEXT NOT NULL,
        explicacion_contraparte TEXT,
        resolucion_tipo TEXT,
        resolucion_fundamentacion TEXT,
        resuelto_por UUID,
        resuelto_en TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.asistencia_controversia_auditoria (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        controversia_id UUID NOT NULL,
        accion TEXT NOT NULL,
        actor_id UUID,
        estado_anterior TEXT,
        estado_nuevo TEXT,
        notas TEXT,
        detalles JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Aplicar la migración de Mini-Sprint D
    const sprintDSqlPath = path.join(
      __dirname,
      '..',
      'supabase',
      'migrations',
      '20261025090000_open_encounters_factual_trajectory_v1.sql'
    );
    const sprintDSqlContent = fs.readFileSync(sprintDSqlPath, 'utf8');
    await db.exec(sprintDSqlContent);

    // Aplicar la corrección aditiva de Sprint D
    const fixDSqlPath = path.join(
      __dirname,
      '..',
      'supabase',
      'migrations',
      '20261025100000_factual_trajectory_provenance_and_realized_experiences_v1.sql'
    );
    if (fs.existsSync(fixDSqlPath)) {
      const fixDSqlContent = fs.readFileSync(fixDSqlPath, 'utf8');
      await db.exec(fixDSqlContent);
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Encuentro privado excluido
  // ---------------------------------------------------------------------------
  test('1. Encuentro privado excluido del historial reputacional', async () => {
    // Crear encuentro puramente privado (opened_at IS NULL, is_open = false)
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, is_open, opened_at, fecha, hora, estado
      ) VALUES (
        '${hostUser}', 'Encuentro Privado Asado', false, NULL,
        CURRENT_DATE - INTERVAL '3 days', '21:00:00', 'activo'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Participante en encuentro privado
    await db.query(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, attendance_status
      ) VALUES (
        '${encId}', '${partUserA}', 'Carlos Privado', 'confirmado', 'attended'
      );
    `);

    // Consultar trayectoria del host
    await setAuth(hostUser);
    const hostTrayRes = await db.query(`
      SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;
    `);
    const ht = (hostTrayRes.rows[0].res as any);
    assert.equal(ht.ok, true);
    assert.equal(ht.trayectoria_anfitrion.datos_objetivos.encuentros_abiertos_organizados, 0, 'Encuentro privado NO debe sumarse al host');

    // Consultar trayectoria del participante
    await setAuth(partUserA);
    const partTrayRes = await db.query(`
      SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;
    `);
    const pt = (partTrayRes.rows[0].res as any);
    assert.equal(pt.ok, true);
    assert.equal(pt.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 0, 'Encuentro privado NO debe sumarse al participante');
  });

  // ---------------------------------------------------------------------------
  // 2. Encuentro abierto incluido
  // ---------------------------------------------------------------------------
  test('2. Encuentro abierto incluido con métricas objetivas', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at, fecha, hora,
        post_event_closure_status, post_event_realization_status, post_event_closed_at, post_event_closed_responsibly
      ) VALUES (
        '${hostUser}', 'Cafe Filosofico', 'Cafe Filosofico', true, CURRENT_TIMESTAMP - INTERVAL '5 days',
        CURRENT_DATE - INTERVAL '2 days', '18:00:00',
        'closed_on_time', 'realized', CURRENT_TIMESTAMP - INTERVAL '1 day', true
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, attendance_status, creado_en
      ) VALUES (
        '${encId}', '${partUserA}', 'Carlos Open', 'confirmado', 'attended', CURRENT_TIMESTAMP - INTERVAL '4 days'
      );
    `);

    // Host
    await setAuth(hostUser);
    const hostRes = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const ht = (hostRes.rows[0].res as any);
    assert.equal(ht.trayectoria_anfitrion.datos_objetivos.encuentros_abiertos_organizados, 1);
    assert.equal(ht.trayectoria_anfitrion.datos_objetivos.cierres_a_tiempo, 1);
    assert.equal(ht.trayectoria_anfitrion.declaraciones_host.encuentros_declarados_realizados, 1);
    assert.equal(ht.trayectoria_anfitrion.datos_objetivos.participantes_recibidos_total, 1);

    // Participante
    await setAuth(partUserA);
    const partRes = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const pt = (partRes.rows[0].res as any);
    assert.equal(pt.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 1);
    assert.equal(pt.trayectoria_participante.declaraciones_anfitrion.asistencias_declaradas_host, 1);
  });

  // ---------------------------------------------------------------------------
  // 3. Conversión de privado a abierto: separación histórica correcta
  // ---------------------------------------------------------------------------
  test('3. Encuentro convertido de privado a abierto: actividad privada previa no se incorpora', async () => {
    const openTime = '2026-10-20T12:00:00Z';
    const priorTime = '2026-10-19T10:00:00Z';
    const postTime = '2026-10-21T15:00:00Z';

    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at, fecha, hora
      ) VALUES (
        '${hostUser}', 'Encuentro Mixto', 'Encuentro Mixto', true, '${openTime}',
        CURRENT_DATE - INTERVAL '1 day', '20:00:00'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Participante B se sumó cuando era PRIVADO (creado_en previo y admission_source private_general_link)
    await db.query(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, attendance_status, creado_en, admission_source
      ) VALUES (
        '${encId}', '${partUserB}', 'Beto Previo', 'confirmado', 'attended', '${priorTime}', 'private_general_link'
      );
    `);

    // Consultar trayectoria de Beto
    await setAuth(partUserB);
    const bRes = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const bt = (bRes.rows[0].res as any);
    assert.equal(bt.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 0, 'Participación privada previa no debe figurar en trayectoria abierta');

    // Ahora Beto se suma a un encuentro posterior cuando YA estaba abierto
    await db.query(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, attendance_status, creado_en, admission_source
      ) VALUES (
        '${encId}', '${partUserB}', 'Beto Posterior', 'confirmado', 'attended', '${postTime}', 'post_open_generic'
      );
    `);

    const bRes2 = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const bt2 = (bRes2.rows[0].res as any);
    assert.equal(bt2.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 1, 'Participación post-apertura sí se incorpora');
  });

  // ---------------------------------------------------------------------------
  // 4. Usuario sin antecedentes: tratamiento neutral
  // ---------------------------------------------------------------------------
  test('4. Usuario nuevo sin antecedentes recibe tratamiento neutral sin penalización', async () => {
    await setAuth(newUser);
    const res = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const t = (res.rows[0].res as any);
    assert.equal(t.ok, true);
    assert.equal(t.contexto_factual.total_experiencias_unicas, 0);
    assert.equal(t.contexto_factual.estado_muestra, 'sin_antecedentes');
    assert.equal(t.contexto_factual.muestra_suficiente, false);
    assert.equal(t.contexto_factual.tratamiento_neutral, true);
    assert.equal(t.contexto_factual.scoring_publico_habilitado, false);
    assert.equal((t.contexto_factual as any).score, undefined, 'No debe existir campo score');
  });

  // ---------------------------------------------------------------------------
  // 5. Anfitrión que también participa en otros encuentros: roles diferenciados
  // ---------------------------------------------------------------------------
  test('5. Roles segregados: anfitrión que también es participante en otro encuentro', async () => {
    // partUserA es anfitrión en su propio encuentro abierto
    const encPartRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at, fecha, hora,
        post_event_closure_status, post_event_realization_status, post_event_closed_at
      ) VALUES (
        '${partUserA}', 'Lectura Abierta Carlos', 'Lectura Abierta Carlos', true, CURRENT_TIMESTAMP - INTERVAL '3 days',
        CURRENT_DATE - INTERVAL '1 day', '19:00:00',
        'closed_on_time', 'realized', CURRENT_TIMESTAMP - INTERVAL '12 hours'
      ) RETURNING id;
    `);

    await setAuth(partUserA);
    const res = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const t = (res.rows[0].res as any);

    // Tiene métricas como host y como participante por separado
    assert.equal(t.trayectoria_anfitrion.datos_objetivos.encuentros_abiertos_organizados, 1);
    assert.equal(t.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 1);
    assert.ok(t.contexto_factual.total_experiencias_unicas >= 2);
  });

  // ---------------------------------------------------------------------------
  // 6. Multi-seat sin duplicar historial personal
  // ---------------------------------------------------------------------------
  test('6. Multi-seat: acompañante sin cuenta no figura ni duplica historial personal', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at, fecha, hora
      ) VALUES (
        '${hostUser}', 'Encuentro Multi-Seat', 'Multi-Seat', true, CURRENT_TIMESTAMP - INTERVAL '2 days',
        CURRENT_DATE - INTERVAL '1 day', '20:00:00'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Titular (partUserA) con seat_count = 3
    await db.query(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, seat_count, attendance_status, creado_en
      ) VALUES (
        '${encId}', '${partUserA}', 'Carlos Titular', 'confirmado', 3, 'attended', CURRENT_TIMESTAMP - INTERVAL '1 day'
      );
    `);

    // Acompañante sin user_id (user_id IS NULL)
    await db.query(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, seat_count, attendance_status, creado_en
      ) VALUES (
        '${encId}', NULL, 'Acompañante Juan (Sin Cuenta)', 'confirmado', 1, 'reported_absent', CURRENT_TIMESTAMP - INTERVAL '1 day'
      );
    `);

    // Carlos debe tener 1 encuentro confirmado más, sin triplicar por seats
    await setAuth(partUserA);
    const res = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const t = (res.rows[0].res as any);
    // Carlos participó en enc2 y encMultiSeat -> 2
    assert.equal(t.trayectoria_participante.datos_objetivos.encuentros_abiertos_confirmados, 2);
  });

  // ---------------------------------------------------------------------------
  // 7. Inasistencia reportada sin verificar: no es comprobada
  // ---------------------------------------------------------------------------
  test('7. Inasistencia reportada sin verificar no se considera corroborada', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at, fecha, hora
      ) VALUES (
        '${hostUser}', 'Encuentro Reporte Pendiente', 'Reporte Pendiente', true, CURRENT_TIMESTAMP - INTERVAL '2 days',
        CURRENT_DATE - INTERVAL '1 day', '19:00:00'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, attendance_status, attendance_dispute_status, creado_en
      ) VALUES (
        '${encId}', '${partUserB}', 'Beto Reportado', 'confirmado', 'reported_absent', 'awaiting_response', CURRENT_TIMESTAMP - INTERVAL '1 day'
      );
    `);

    await setAuth(partUserB);
    const res = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const t = (res.rows[0].res as any);

    // Debe figurar como declaración individual del host
    assert.equal(t.trayectoria_participante.declaraciones_anfitrion.inasistencias_reportadas_host, 1);
    // Pero NUNCA en hechos corroborados
    assert.equal(t.trayectoria_participante.hechos_corroborados.inasistencias_confirmadas_moderacion, 0);
    assert.equal(t.trayectoria_participante.hechos_corroborados.inasistencias_reconocidas_expresamente, 0);
  });

  // ---------------------------------------------------------------------------
  // 8. Inasistencia expresamente reconocida por el usuario
  // ---------------------------------------------------------------------------
  test('8. Inasistencia expresamente reconocida (confirmed_by_participant)', async () => {
    await db.query(`
      UPDATE public.participantes
      SET attendance_dispute_status = 'confirmed_by_participant'
      WHERE user_id = '${partUserB}' AND attendance_status = 'reported_absent';
    `);

    await setAuth(partUserB);
    const res = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const t = (res.rows[0].res as any);

    assert.equal(t.trayectoria_participante.hechos_corroborados.inasistencias_reconocidas_expresamente, 1);
    assert.equal(t.trayectoria_participante.hechos_corroborados.inasistencias_confirmadas_moderacion, 0);
  });

  // ---------------------------------------------------------------------------
  // 9. Resolución de moderación independiente
  // ---------------------------------------------------------------------------
  test('9. Resolución de moderación independiente clasifica correctamente', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at, fecha, hora
      ) VALUES (
        '${hostUser}', 'Encuentro Moderado', 'Encuentro Moderado', true, CURRENT_TIMESTAMP - INTERVAL '3 days',
        CURRENT_DATE - INTERVAL '2 days', '19:00:00'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    // Caso 1: inasistencia confirmada por moderador (resolved_unjustified)
    await db.query(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, attendance_status, attendance_dispute_status, creado_en
      ) VALUES (
        '${encId}', '${partUserB}', 'Beto Injustificado', 'confirmado', 'reported_absent', 'resolved_unjustified', CURRENT_TIMESTAMP - INTERVAL '2 days'
      );
    `);

    // Caso 2: inasistencia justificada por moderador (resolved_justified)
    await db.query(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, attendance_status, attendance_dispute_status, creado_en
      ) VALUES (
        '${encId}', '${partUserA}', 'Carlos Justificado', 'confirmado', 'reported_absent', 'resolved_justified', CURRENT_TIMESTAMP - INTERVAL '2 days'
      );
    `);

    await setAuth(partUserB);
    const resB = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const tb = (resB.rows[0].res as any);
    assert.equal(tb.trayectoria_participante.hechos_corroborados.inasistencias_confirmadas_moderacion, 1);

    await setAuth(partUserA);
    const resA = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const ta = (resA.rows[0].res as any);
    assert.equal(ta.trayectoria_participante.hechos_corroborados.inasistencias_justificadas, 1);
  });

  // ---------------------------------------------------------------------------
  // 10. Reclamo contra el anfitrión desestimado
  // ---------------------------------------------------------------------------
  test('10. Reclamo contra el anfitrión desestimado por evidencia insuficiente no genera hecho negativo', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at, fecha, hora
      ) VALUES (
        '${hostUser}', 'Encuentro Reclamo Desestimado', 'Desestimado', true, CURRENT_TIMESTAMP - INTERVAL '3 days',
        CURRENT_DATE - INTERVAL '2 days', '19:00:00'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.asistencia_controversias (
        encuentro_id, iniciado_por, involucrado_id, tipo_controversia, estado,
        motivo_iniciador, resolucion_tipo, resolucion_fundamentacion, resuelto_por, resuelto_en
      ) VALUES (
        '${encId}', '${partUserA}', '${hostUser}', 'host_no_show', 'dismissed_insufficient_evidence',
        'No vi al host', 'insufficient_evidence', 'No se aportan pruebas de ausencia.', '${modUser}', now()
      );
    `);

    await setAuth(hostUser);
    const res = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const t = (res.rows[0].res as any);

    assert.equal(t.trayectoria_anfitrion.observaciones_y_moderacion.reclamos_desestimados_insuficientes, 1);
    assert.equal(t.trayectoria_anfitrion.observaciones_y_moderacion.ausencias_anfitrion_acreditadas, 0, 'No debe figurar como ausencia acreditada');
  });

  // ---------------------------------------------------------------------------
  // 11. Reclamo contra el anfitrión confirmado: clasificación correcta
  // ---------------------------------------------------------------------------
  test('11. Reclamo contra anfitrión confirmado: se clasifica según el hecho concreto', async () => {
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at, fecha, hora
      ) VALUES (
        '${hostUser}', 'Encuentro Ausencia Acreditada', 'Ausencia', true, CURRENT_TIMESTAMP - INTERVAL '3 days',
        CURRENT_DATE - INTERVAL '2 days', '20:00:00'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.asistencia_controversias (
        encuentro_id, iniciado_por, involucrado_id, tipo_controversia, estado,
        motivo_iniciador, resolucion_tipo, resolucion_fundamentacion, resuelto_por, resuelto_en, metadata
      ) VALUES (
        '${encId}', '${partUserA}', '${hostUser}', 'host_no_show', 'resolved_justified',
        'El host faltó', 'confirmed', 'Acreditado por múltiples participantes', '${modUser}', now(),
        '{"confirmed_fact": "host_absence_confirmed"}'::jsonb
      );
    `);

    await setAuth(hostUser);
    const res = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const t = (res.rows[0].res as any);

    assert.equal(t.trayectoria_anfitrion.observaciones_y_moderacion.ausencias_anfitrion_acreditadas, 1);
    assert.equal(t.trayectoria_anfitrion.observaciones_y_moderacion.no_realizaciones_acreditadas, 0);
    assert.equal(t.trayectoria_anfitrion.observaciones_y_moderacion.errores_cierre_acreditados, 0);
  });

  // ---------------------------------------------------------------------------
  // 12. Rectificación posterior: proyección actualizada
  // ---------------------------------------------------------------------------
  test('12. Rectificación documental actualiza la proyección a hechos corroborados', async () => {
    // Carlos A tenía un registro con error que luego fue rectificado por moderador
    const encRes = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at, fecha, hora
      ) VALUES (
        '${hostUser}', 'Encuentro Rectificado', 'Rectificado', true, CURRENT_TIMESTAMP - INTERVAL '3 days',
        CURRENT_DATE - INTERVAL '2 days', '19:00:00'
      ) RETURNING id;
    `);
    const encId = encRes.rows[0].id;

    await db.query(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, attendance_status, attendance_dispute_status, creado_en
      ) VALUES (
        '${encId}', '${partUserA}', 'Carlos Rectificado', 'asistio', 'attended', 'resolved_registration_error', CURRENT_TIMESTAMP - INTERVAL '2 days'
      );
    `);

    await setAuth(partUserA);
    const res = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const t = (res.rows[0].res as any);

    assert.ok(t.trayectoria_participante.hechos_corroborados.asistencias_corroboradas >= 1);
  });

  // ---------------------------------------------------------------------------
  // 13. Terceros no autorizados: acceso denegado
  // ---------------------------------------------------------------------------
  test('13. Tercero no autorizado recibe error forbidden al consultar trayectoria ajena', async () => {
    await setAuth(thirdPartyUser);

    const res = await db.query(`
      SELECT public.get_trayectoria_encuentros_abiertos_seguro(p_user_id := '${hostUser}') AS res;
    `);
    const t = (res.rows[0].res as any);
    assert.equal(t.ok, false);
    assert.equal(t.error, 'forbidden');

    // Moderador autorizado sí puede consultar trayectoria de cualquier usuario
    await setAuth(modUser);
    const modQueryRes = await db.query(`
      SELECT public.get_trayectoria_encuentros_abiertos_seguro(p_user_id := '${hostUser}') AS res;
    `);
    const mt = (modQueryRes.rows[0].res as any);
    assert.equal(mt.ok, true);
    assert.equal(mt.user_id, hostUser);
  });

  // ---------------------------------------------------------------------------
  // 14. Preservación de retrocompatibilidad en get_historial_asistencia_factual_seguro
  // ---------------------------------------------------------------------------
  test('14. get_historial_asistencia_factual_seguro mantiene claves planas y subestructuras', async () => {
    await setAuth(hostUser);

    const flatRes = await db.query(`
      SELECT public.get_historial_asistencia_factual_seguro() AS res;
    `);
    const f = (flatRes.rows[0].res as any);
    assert.equal(f.ok, true);
    assert.equal(typeof f.total_encuentros_participados, 'number');
    assert.equal(typeof f.asistencias_declaradas_host, 'number');
    assert.equal(typeof f.asistencias_verificadas, 'number');
    assert.equal(typeof f.controversias_organizador_recibidas, 'number');
    assert.equal(typeof f.reclamos_ausencia_anfitrion_recibidos, 'number');

    // Subestructuras presentes
    assert.ok(f.trayectoria_anfitrion !== undefined);
    assert.ok(f.trayectoria_participante !== undefined);
    assert.ok(f.contexto_factual !== undefined);
  });

  // ---------------------------------------------------------------------------
  // 15. Uniformar exclusión de participantes privados anteriores a la apertura
  // ---------------------------------------------------------------------------
  test('15. Exclusión uniforme de invitados privados previos en participantes_recibidos y anfitriones_distintos', async () => {
    const encMixed = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at, fecha, hora, estado
      ) VALUES (
        '${hostUser}', 'Encuentro Test Procedencia', 'Test Procedencia', true, CURRENT_TIMESTAMP - INTERVAL '1 day',
        CURRENT_DATE - INTERVAL '1 day', '19:00:00', 'activo'
      ) RETURNING id;
    `);
    const encMixedId = encMixed.rows[0].id;

    // Participante C se unió ANTES de opened_at (privado previo)
    const priorUser = '00000000-0000-0000-0000-000000000009';
    await db.query(`INSERT INTO auth.users (id, email) VALUES ('${priorUser}', 'prior@test.com') ON CONFLICT DO NOTHING;`);
    await db.query(`
      INSERT INTO public.participantes (
        encuentro_id, user_id, nombre_invitado, estado, attendance_status, creado_en, admission_source
      ) VALUES (
        '${encMixedId}', '${priorUser}', 'Invitado Previo', 'confirmado', 'attended',
        CURRENT_TIMESTAMP - INTERVAL '2 days', 'private_general_link'
      );
    `);

    // Consultar trayectoria del host: NO debe sumar en participantes_recibidos_total
    await setAuth(hostUser);
    const hostRes = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const ht = (hostRes.rows[0].res as any);
    // El host solo recibió al participante que fue admitido como abierto (partUserA), no al priorUser
    assert.ok(ht.trayectoria_anfitrion.datos_objetivos.participantes_recibidos_total >= 1);

    // Consultar trayectoria del priorUser: NO debe sumar hostUser en anfitriones_distintos_interactuados
    await setAuth(priorUser);
    const priorRes = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const pt = (priorRes.rows[0].res as any);
    assert.equal(pt.contexto_factual.anfitriones_distintos_interactuados, 0);
  });

  // ---------------------------------------------------------------------------
  // 16. Diferenciación de experiencias efectivamente realizadas vs programadas/canceladas
  // ---------------------------------------------------------------------------
  test('16. Diferenciación de experiencias realizadas vs programadas futuros o canceladas', async () => {
    // Crear un encuentro futuro programado para el host
    await db.query(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at, fecha, hora, estado
      ) VALUES (
        '${hostUser}', 'Encuentro Futuro Programado', 'Futuro', true, CURRENT_TIMESTAMP,
        CURRENT_DATE + INTERVAL '5 days', '18:00:00', 'activo'
      );
    `);

    // Crear un encuentro cancelado para el host
    await db.query(`
      INSERT INTO public.encuentros (
        host_id, titulo, open_public_title, is_open, opened_at, fecha, hora, estado
      ) VALUES (
        '${hostUser}', 'Encuentro Cancelado', 'Cancelado', true, CURRENT_TIMESTAMP - INTERVAL '3 days',
        CURRENT_DATE - INTERVAL '2 days', '18:00:00', 'cancelado'
      );
    `);

    await setAuth(hostUser);
    const hostRes = await db.query(`SELECT public.get_trayectoria_encuentros_abiertos_seguro() AS res;`);
    const ht = (hostRes.rows[0].res as any);

    // Encuentros futuros programados y cancelados no suman a total_experiencias_unicas
    assert.ok(ht.trayectoria_anfitrion.datos_objetivos.encuentros_abiertos_programados_futuros >= 1);
    assert.ok(ht.trayectoria_anfitrion.datos_objetivos.encuentros_abiertos_cancelados >= 1);
    // total_experiencias_unicas solo cuenta los que efectivamente se realizaron
    assert.ok(ht.contexto_factual.total_experiencias_unicas < ht.trayectoria_anfitrion.datos_objetivos.encuentros_abiertos_organizados);
  });
});
