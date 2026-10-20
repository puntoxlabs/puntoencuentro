import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Suite de Pruebas: Retención y Purga Segura de Mensajes del Encuentro V1 (Sprint 3)
 * Cobertura de las compuertas de ciclo de vida temporal, retención, moderación y purga.
 */
describe('Sprint 3: Retención y Purga Segura de Mensajes V1 — Backend (PGlite)', () => {
  let db: PGlite;

  const hostUser = '11111111-1111-1111-1111-111111111111';
  const participantUser = '22222222-2222-2222-2222-222222222222';
  const otherUser = '33333333-3333-3333-3333-333333333333';

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

  const rpc = async (expr: string, userId: string | null, isAnon = false): Promise<any> => {
    await setAuth(userId, isAnon);
    await db.exec(`SET ROLE authenticated;`);
    try {
      const res = await db.query<{ result: any }>(`SELECT ${expr} AS result;`);
      return parse(res.rows[0].result);
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  };

  const rpcServiceRole = async (expr: string): Promise<any> => {
    await db.exec(`SET ROLE service_role;`);
    try {
      const res = await db.query<{ result: any }>(`SELECT ${expr} AS result;`);
      return parse(res.rows[0].result);
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  };

  before(async () => {
    db = new PGlite();

    // 1. Roles y esquemas base
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
        is_anonymous BOOLEAN DEFAULT false
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

      CREATE TABLE IF NOT EXISTS public.rate_limit_policies (
        action TEXT PRIMARY KEY,
        max_requests INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL,
        enabled BOOLEAN DEFAULT true,
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
        action TEXT NOT NULL REFERENCES public.rate_limit_policies(action) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        scope_key TEXT NOT NULL DEFAULT '',
        window_start TIMESTAMPTZ NOT NULL,
        request_count INTEGER NOT NULL CHECK (request_count > 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (action, user_id, scope_key, window_start)
      );

      CREATE OR REPLACE FUNCTION public.check_rate_limit_internal(
        p_action TEXT,
        p_scope_key TEXT DEFAULT ''
      )
      RETURNS JSONB
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $func$
      DECLARE
        v_user_id UUID := auth.uid();
        v_policy RECORD;
        v_window_start TIMESTAMPTZ;
        v_new_count INTEGER;
      BEGIN
        IF v_user_id IS NULL THEN
          RETURN jsonb_build_object('allowed', false, 'error', 'authentication_required');
        END IF;

        SELECT max_requests, window_seconds, enabled
        INTO v_policy
        FROM public.rate_limit_policies
        WHERE action = p_action;

        IF NOT FOUND OR v_policy.enabled = false THEN
          RETURN jsonb_build_object('allowed', true);
        END IF;

        v_window_start := to_timestamp(
          floor(extract(epoch from now()) / v_policy.window_seconds) * v_policy.window_seconds
        );

        INSERT INTO public.rate_limit_buckets (action, user_id, scope_key, window_start, request_count, updated_at)
        VALUES (p_action, v_user_id, COALESCE(p_scope_key, ''), v_window_start, 1, now())
        ON CONFLICT (action, user_id, scope_key, window_start)
        DO UPDATE SET request_count = public.rate_limit_buckets.request_count + 1, updated_at = now()
        WHERE public.rate_limit_buckets.request_count < v_policy.max_requests
        RETURNING request_count INTO v_new_count;

        IF v_new_count IS NULL THEN
          RETURN jsonb_build_object('allowed', false, 'error', 'rate_limited');
        END IF;

        RETURN jsonb_build_object('allowed', true, 'remaining', v_policy.max_requests - v_new_count);
      END;
      $func$;

      CREATE TABLE IF NOT EXISTS public.bloqueos_usuario (
        blocker_id UUID NOT NULL,
        blocked_id UUID NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (blocker_id, blocked_id)
      );

      CREATE TABLE IF NOT EXISTS public.encuentros (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id UUID NOT NULL,
        titulo TEXT NOT NULL,
        descripcion TEXT,
        fecha DATE,
        hora TIME,
        modalidad TEXT NOT NULL DEFAULT 'presencial',
        lugar_texto TEXT,
        link_virtual TEXT,
        tipo_invitacion TEXT NOT NULL DEFAULT 'link_general',
        tema TEXT DEFAULT 'blue',
        estado TEXT NOT NULL DEFAULT 'activo',
        date_mode TEXT NOT NULL DEFAULT 'fixed',
        coordination_status TEXT,
        cancelled_at TIMESTAMPTZ,
        cancelled_by UUID,
        cancellation_reason TEXT,
        messages_purged_at TIMESTAMPTZ DEFAULT NULL,
        public_token UUID DEFAULT gen_random_uuid(),
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.participantes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        nombre_invitado TEXT NOT NULL,
        tipo_invitacion TEXT NOT NULL DEFAULT 'individual',
        token_invitacion UUID UNIQUE DEFAULT gen_random_uuid(),
        estado TEXT NOT NULL DEFAULT 'pendiente',
        user_id UUID,
        creado_en TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.inbox_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_user_id UUID NOT NULL,
        notification_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id UUID NOT NULL,
        deep_link TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        payload JSONB DEFAULT '{}'::jsonb,
        dedup_key TEXT NOT NULL,
        read_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_inbox_recipient_dedup UNIQUE (recipient_user_id, dedup_key)
      );

      CREATE TABLE IF NOT EXISTS public.reportes_encuentro (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        solicitud_id UUID,
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        reporter_id UUID,
        reported_id UUID,
        estado TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.public_content_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
        reporter_id UUID,
        reason TEXT DEFAULT 'inappropriate_content',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        reviewed_at TIMESTAMPTZ,
        reviewed_by UUID,
        resolution_note TEXT
      );

      INSERT INTO auth.users (id, email) VALUES
        ('${hostUser}', 'host@test.com'),
        ('${participantUser}', 'part@test.com'),
        ('${otherUser}', 'other@test.com');
    `);

    // 2. Aplicar migraciones secuenciales
    const rootDir = path.resolve(__dirname, '..');
    const mig1 = fs.readFileSync(path.resolve(rootDir, 'supabase/migrations/20261020100000_encounter_messages_panel_v1.sql'), 'utf8');
    const mig2 = fs.readFileSync(path.resolve(rootDir, 'supabase/migrations/20261020120000_fix_encounter_messages_panel_hardening.sql'), 'utf8');
    const mig3 = fs.readFileSync(path.resolve(rootDir, 'supabase/migrations/20261020140000_encounter_messages_retention_and_purge_v1.sql'), 'utf8');

    await db.exec(mig1);
    await db.exec(mig2);

    // Pre-poblar mensajes eliminados legados antes de aplicar mig3 para verificar scrubbing retroactivo
    await db.exec(`
      INSERT INTO public.encuentros (id, host_id, titulo, fecha, hora, estado)
      VALUES 
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${hostUser}', 'Encuentro Legado 1', '2028-05-01', '18:00:00', 'activo'),
        ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '${hostUser}', 'Encuentro Legado Con Denuncia', '2028-05-01', '18:00:00', 'activo');

      INSERT INTO public.mensajes_encuentro (id, encuentro_id, autor_user_id, autor_nombre, es_organizador, contenido, eliminado_en)
      VALUES 
        ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${hostUser}', 'Organizador', true, 'Texto sensible legado a redactar', now() - interval '2 days'),
        ('22222222-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '${hostUser}', 'Organizador', true, 'Evidencia sensible con investigacion abierta', now() - interval '2 days');

      INSERT INTO public.reportes_encuentro (encuentro_id, estado, created_at)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'pending', now() - interval '5 days');
    `);

    await db.exec(mig3);
  });

  // Helper para crear un encuentro de prueba
  const createEncounter = async (opts: {
    titulo: string;
    fecha?: string | null;
    hora?: string | null;
    estado?: string;
    cancelled_at?: string | null;
    messages_purged_at?: string | null;
    creado_en?: string;
  }) => {
    const res = await db.query<{ id: string }>(`
      INSERT INTO public.encuentros (
        host_id, titulo, fecha, hora, estado, cancelled_at, messages_purged_at, creado_en
      )
      VALUES (
        '${hostUser}',
        '${opts.titulo}',
        ${opts.fecha ? `'${opts.fecha}'::date` : 'NULL'},
        ${opts.hora ? `'${opts.hora}'::time` : 'NULL'},
        '${opts.estado || 'activo'}',
        ${opts.cancelled_at ? `'${opts.cancelled_at}'::timestamptz` : 'NULL'},
        ${opts.messages_purged_at ? `'${opts.messages_purged_at}'::timestamptz` : 'NULL'},
        ${opts.creado_en ? `'${opts.creado_en}'::timestamptz` : 'now()'}
      )
      RETURNING id;
    `);
    const encId = res.rows[0].id;

    // Agregar participante confirmado
    await db.query(`
      INSERT INTO public.participantes (encuentro_id, user_id, nombre_invitado, estado)
      VALUES ('${encId}', '${participantUser}', 'Participante Test', 'confirmado');
    `);

    return encId;
  };

  // Helper para insertar mensaje directamente
  const insertMessage = async (encounterId: string, authorId: string, content: string, parentId?: string) => {
    const res = await db.query<{ id: string }>(`
      INSERT INTO public.mensajes_encuentro (
        encuentro_id, parent_id, autor_user_id, autor_nombre, es_organizador, contenido
      )
      VALUES (
        '${encounterId}',
        ${parentId ? `'${parentId}'` : 'NULL'},
        '${authorId}',
        '${authorId === hostUser ? 'Organizador' : 'Participante'}',
        ${authorId === hostUser},
        '${content}'
      )
      RETURNING id;
    `);
    return res.rows[0].id;
  };

  // 1. Encuentro futuro: escritura y lectura permitidas, no califica para retención ni purga
  test('1. Encuentro futuro: lectura y escritura habilitadas, no califica para purga', async () => {
    const encId = await createEncounter({
      titulo: 'Encuentro Futuro',
      fecha: '2028-12-01',
      hora: '18:00:00',
    });
    const msgId = await insertMessage(encId, hostUser, 'Mensaje previo al encuentro');

    const resHost = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, hostUser);
    assert.strictEqual(resHost.ok, true);
    assert.strictEqual(resHost.can_write, true);
    assert.strictEqual(resHost.writing_window_closed, false);
    assert.strictEqual(resHost.mensajes.length, 1);

    const resPart = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, participantUser);
    assert.strictEqual(resPart.ok, true);
    assert.strictEqual(resPart.can_write, true);
  });

  // 2. Encuentro en curso: escritura permitida
  test('2. Encuentro en curso: escritura permitida', async () => {
    // Fecha y hora actuales en Buenos Aires
    const resNow = await db.query<{ hoy: string; ahora: string }>(`
      SELECT 
        (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text as hoy,
        (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::time::text as ahora;
    `);
    const encId = await createEncounter({
      titulo: 'Encuentro En Curso',
      fecha: resNow.rows[0].hoy,
      hora: resNow.rows[0].ahora,
    });

    const res = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, hostUser);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.can_write, true);
    assert.strictEqual(res.writing_window_closed, false);
  });

  // 3. Encuentro terminado hace 24 horas: lectura permitida, escritura bloqueada (writing_window_closed)
  test('3. Encuentro terminado hace 25 horas: solo lectura (writing_window_closed)', async () => {
    const resPast = await db.query<{ fecha: string; hora: string }>(`
      SELECT 
        ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires') - interval '25 hours')::date::text as fecha,
        ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires') - interval '25 hours')::time::text as hora;
    `);
    const encId = await createEncounter({
      titulo: 'Encuentro Pasado 25h',
      fecha: resPast.rows[0].fecha,
      hora: resPast.rows[0].hora,
    });
    await insertMessage(encId, hostUser, 'Mensaje histórico');

    const res = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, participantUser);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.can_write, false);
    assert.strictEqual(res.writing_window_closed, true);
    assert.strictEqual(res.mensajes.length, 1);
  });

  // 4. Encuentro terminado hace 89 días: lectura permitida
  test('4. Encuentro terminado hace 89 días: lectura permitida en solo lectura', async () => {
    const res89 = await db.query<{ fecha: string; hora: string }>(`
      SELECT 
        ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires') - interval '89 days')::date::text as fecha,
        '18:00:00' as hora;
    `);
    const encId = await createEncounter({
      titulo: 'Encuentro Día 89',
      fecha: res89.rows[0].fecha,
      hora: res89.rows[0].hora,
    });
    await insertMessage(encId, hostUser, 'Mensaje casi por vencer');

    const res = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, participantUser);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.can_write, false);
    assert.strictEqual(res.writing_window_closed, true);
    assert.strictEqual(res.mensajes.length, 1);
  });

  // 5. Encuentro terminado hace exactamente 90 días: lectura permitida dentro de los 90 días
  test('5. Encuentro terminado hace 90 días menos 1 hora: lectura permitida', async () => {
    const res90 = await db.query<{ fecha: string; hora: string }>(`
      SELECT 
        ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires') - interval '89 days 23 hours')::date::text as fecha,
        ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires') - interval '89 days 23 hours')::time::text as hora;
    `);
    const encId = await createEncounter({
      titulo: 'Encuentro Límite 90d',
      fecha: res90.rows[0].fecha,
      hora: res90.rows[0].hora,
    });

    const res = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, participantUser);
    assert.strictEqual(res.ok, true);
  });

  // 6. Encuentro terminado hace 91 días: lectura rechazada con history_retention_expired
  test('6. Encuentro terminado hace 91 días: lectura rechazada con history_retention_expired', async () => {
    const res91 = await db.query<{ fecha: string; hora: string }>(`
      SELECT 
        ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires') - interval '91 days')::date::text as fecha,
        '18:00:00' as hora;
    `);
    const encId = await createEncounter({
      titulo: 'Encuentro Día 91',
      fecha: res91.rows[0].fecha,
      hora: res91.rows[0].hora,
    });
    await insertMessage(encId, hostUser, 'Mensaje vencido');

    // Participante denegado por retención vencida
    const resPart = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, participantUser);
    assert.strictEqual(resPart.ok, false);
    assert.strictEqual(resPart.error, 'history_retention_expired');
    assert.strictEqual(resPart.retention_type, 'active_90d');

    // Organizador también denegado por retención vencida
    const resHost = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, hostUser);
    assert.strictEqual(resHost.ok, false);
    assert.strictEqual(resHost.error, 'history_retention_expired');
  });

  // 7. Encuentro cancelado con cancelled_at < 30 días: host lee, participante bloqueado con meeting_cancelled
  test('7. Encuentro cancelado reciente (< 30d): host lee en solo lectura, participantes bloqueados', async () => {
    const encId = await createEncounter({
      titulo: 'Encuentro Cancelado Hace 10d',
      fecha: '2026-12-01',
      hora: '18:00:00',
      estado: 'cancelado',
      cancelled_at: new Date(Date.now() - 10 * 86400000).toISOString(),
    });
    await insertMessage(encId, hostUser, 'Aviso de cancelación');

    // Participante bloqueado de inmediato
    const resPart = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, participantUser);
    assert.strictEqual(resPart.ok, false);
    assert.strictEqual(resPart.error, 'meeting_cancelled');

    // Host puede consultar el historial en solo lectura durante 30 días
    const resHost = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, hostUser);
    assert.strictEqual(resHost.ok, true);
    assert.strictEqual(resHost.can_write, false);
    assert.strictEqual(resHost.writing_window_closed, true);
    assert.strictEqual(resHost.mensajes.length, 1);
  });

  // 8. Encuentro cancelado con cancelled_at > 30 días: host bloqueado con history_retention_expired
  test('8. Encuentro cancelado hace 35 días: host bloqueado con history_retention_expired', async () => {
    const encId = await createEncounter({
      titulo: 'Encuentro Cancelado Hace 35d',
      fecha: '2026-12-01',
      hora: '18:00:00',
      estado: 'cancelado',
      cancelled_at: new Date(Date.now() - 35 * 86400000).toISOString(),
    });
    await insertMessage(encId, hostUser, 'Aviso viejo');

    const resHost = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, hostUser);
    assert.strictEqual(resHost.ok, false);
    assert.strictEqual(resHost.error, 'history_retention_expired');
    assert.strictEqual(resHost.retention_type, 'cancelled_30d');
  });

  // 9. Cancelación reciente de un encuentro creado hace meses: el reloj de 30 días cuenta desde cancelled_at
  test('9. Cancelación reciente de encuentro creado hace 120 días: el reloj cuenta desde cancelled_at, NO desde creado_en', async () => {
    const encId = await createEncounter({
      titulo: 'Creado hace 120d pero cancelado hace 5d',
      fecha: '2026-12-01',
      hora: '18:00:00',
      estado: 'cancelado',
      creado_en: new Date(Date.now() - 120 * 86400000).toISOString(),
      cancelled_at: new Date(Date.now() - 5 * 86400000).toISOString(),
    });
    await insertMessage(encId, hostUser, 'Mensaje host');

    // Como cancelled_at fue hace 5 días (< 30d), el host debe tener acceso
    const resHost = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, hostUser);
    assert.strictEqual(resHost.ok, true);
    assert.strictEqual(resHost.can_write, false);
  });

  // 10. Encuentro cancelado con cancelled_at IS NULL (anomalía): excluido de la purga y contado en anomalías
  test('10. Encuentro cancelado con cancelled_at NULL: no usa creado_en, se excluye de purga automática', async () => {
    const encId = await createEncounter({
      titulo: 'Cancelado sin cancelled_at (anomalía)',
      fecha: '2026-01-01',
      hora: '18:00:00',
      estado: 'cancelado',
      cancelled_at: null,
      creado_en: new Date(Date.now() - 200 * 86400000).toISOString(),
    });
    await insertMessage(encId, hostUser, 'Mensaje en encuentro anómalo');

    // Ejecutar purga de prueba
    const purgeRes = await rpcServiceRole(`public.purgar_mensajes_encuentro_vencidos_seguro(100, true)`);
    assert.strictEqual(purgeRes.ok, true);
    assert.strictEqual(purgeRes.anomalias_cancelled_at_null >= 1, true);

    // Los mensajes del encuentro no se eliminan automáticamente
    const msgCount = await db.query<{ count: string }>(`
      SELECT count(*) as count FROM public.mensajes_encuentro WHERE encuentro_id = '${encId}';
    `);
    assert.strictEqual(parseInt(msgCount.rows[0].count, 10), 1);
  });

  // 11. Reprogramación posterior a una purga: messages_purged_at persiste y previene reactivación
  test('11. Reprogramación de fecha posterior a una purga: no reactiva el historial purgado (history_purged)', async () => {
    const encId = await createEncounter({
      titulo: 'Encuentro Purgado Previamente',
      fecha: '2025-01-01',
      hora: '18:00:00',
      messages_purged_at: new Date(Date.now() - 5 * 86400000).toISOString(),
    });

    // Simular que el host reprograma la fecha del encuentro hacia el futuro
    await db.query(`
      UPDATE public.encuentros 
      SET fecha = '2028-05-10'::date, hora = '20:00:00'::time
      WHERE id = '${encId}';
    `);

    // Intentar leer: resolver_actor_encuentro debe detectar messages_purged_at y rechazar con history_purged
    const resHost = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, hostUser);
    assert.strictEqual(resHost.ok, false);
    assert.strictEqual(resHost.error, 'history_purged');
    assert.ok(resHost.purged_at);
  });

  // 12. Diferencia entre retención vencida y purga física ejecutada
  test('12. Diferencia semántica: vencimiento retorna history_retention_expired; post-purga retorna history_purged', async () => {
    // Caso A: Solo vencido (> 90d), pero cron aún no corrió
    const encVencidoId = await createEncounter({
      titulo: 'Vencido Sin Purga',
      fecha: '2026-01-01',
      hora: '18:00:00',
      messages_purged_at: null,
    });
    const resVencido = await rpc(`public.get_mensajes_encuentro_seguro('${encVencidoId}')`, hostUser);
    assert.strictEqual(resVencido.ok, false);
    assert.strictEqual(resVencido.error, 'history_retention_expired');

    // Caso B: Purgado físicamente (messages_purged_at marcado)
    const encPurgadoId = await createEncounter({
      titulo: 'Purgado Físicamente',
      fecha: '2026-01-01',
      hora: '18:00:00',
      messages_purged_at: new Date().toISOString(),
    });
    const resPurgado = await rpc(`public.get_mensajes_encuentro_seguro('${encPurgadoId}')`, hostUser);
    assert.strictEqual(resPurgado.ok, false);
    assert.strictEqual(resPurgado.error, 'history_purged');
  });

  // 13. Mensajes borrados manualmente: texto reemplazado de inmediato por [Mensaje eliminado]
  test('13. Mensajes borrados manualmente: contenido reemplazado de inmediato por [Mensaje eliminado] (scrubbing)', async () => {
    const encId = await createEncounter({
      titulo: 'Encuentro Prueba Borrado',
      fecha: '2028-01-01',
      hora: '18:00:00',
    });
    const msgId = await insertMessage(encId, hostUser, 'Texto confidencial sensible: CBU 0123456789');

    // Verificar que en la DB el texto original existe
    const pre = await db.query<{ contenido: string }>(`
      SELECT contenido FROM public.mensajes_encuentro WHERE id = '${msgId}';
    `);
    assert.strictEqual(pre.rows[0].contenido, 'Texto confidencial sensible: CBU 0123456789');

    // Eliminar el mensaje vía RPC
    const delRes = await rpc(`public.eliminar_mensaje_encuentro_seguro('${msgId}')`, hostUser);
    assert.strictEqual(delRes.ok, true);

    // Verificar en la DB que el texto original fue completamente reemplazado por el marcador neutral
    const post = await db.query<{ contenido: string; eliminado_en: string }>(`
      SELECT contenido, eliminado_en FROM public.mensajes_encuentro WHERE id = '${msgId}';
    `);
    assert.strictEqual(post.rows[0].contenido, '[Mensaje eliminado]');
    assert.ok(post.rows[0].eliminado_en);

    // En la lectura para clientes, get_mensajes_encuentro_seguro devuelve contenido vacío y flag eliminado = true
    const readRes = await rpc(`public.get_mensajes_encuentro_seguro('${encId}')`, hostUser);
    assert.strictEqual(readRes.ok, true);
    assert.strictEqual(readRes.mensajes[0].eliminado, true);
    assert.strictEqual(readRes.mensajes[0].contenido, '');
  });

  // 14. Función purgar_mensajes_encuentro_vencidos_seguro en modo dry-run vs live
  test('14. Purga segura: dry_run = true cuenta sin borrar; live borra y marca messages_purged_at', async () => {
    const encVencido = await createEncounter({
      titulo: 'A Purgar 95d',
      fecha: '2025-10-01',
      hora: '18:00:00',
    });
    await insertMessage(encVencido, hostUser, 'Mensaje a ser purgado 1');
    await insertMessage(encVencido, hostUser, 'Mensaje a ser purgado 2');

    // 1. Dry run: debe reportar 2 mensajes a eliminar sin mutar
    const dryRes = await rpcServiceRole(`public.purgar_mensajes_encuentro_vencidos_seguro(50, true)`);
    assert.strictEqual(dryRes.ok, true);
    assert.strictEqual(dryRes.dry_run, true);
    assert.strictEqual(dryRes.mensajes_eliminados >= 2, true);

    // Verificar que los mensajes siguen en la DB
    const check1 = await db.query<{ count: string }>(`
      SELECT count(*) as count FROM public.mensajes_encuentro WHERE encuentro_id = '${encVencido}';
    `);
    assert.strictEqual(parseInt(check1.rows[0].count, 10), 2);

    // 2. Live run: debe eliminar los mensajes y fijar messages_purged_at
    const liveRes = await rpcServiceRole(`public.purgar_mensajes_encuentro_vencidos_seguro(50, false)`);
    assert.strictEqual(liveRes.ok, true);
    assert.strictEqual(liveRes.dry_run, false);
    assert.strictEqual(liveRes.mensajes_eliminados >= 2, true);

    // Verificar que los mensajes fueron eliminados físicamente
    const check2 = await db.query<{ count: string }>(`
      SELECT count(*) as count FROM public.mensajes_encuentro WHERE encuentro_id = '${encVencido}';
    `);
    assert.strictEqual(parseInt(check2.rows[0].count, 10), 0);

    // Verificar que encounters.messages_purged_at quedó grabado
    const checkEnc = await db.query<{ messages_purged_at: string }>(`
      SELECT messages_purged_at FROM public.encuentros WHERE id = '${encVencido}';
    `);
    assert.ok(checkEnc.rows[0].messages_purged_at);
  });

  // 15. Hilos anidados: eliminación atómica completa sin fallos de FK parent_id
  test('15. Hilos anidados: eliminación atómica a nivel encuentro sin errores de cascada o integridad', async () => {
    const encHilo = await createEncounter({
      titulo: 'Encuentro con Hilos',
      fecha: '2025-08-01',
      hora: '18:00:00',
    });
    const parentMsg = await insertMessage(encHilo, hostUser, 'Pregunta inicial del anfitrión');
    const childMsg = await insertMessage(encHilo, participantUser, 'Respuesta del participante', parentMsg);

    // Ejecutar purga física
    const resPurge = await rpcServiceRole(`public.purgar_mensajes_encuentro_vencidos_seguro(50, false)`);
    assert.strictEqual(resPurge.ok, true);

    // Verificar que ambos mensajes del hilo fueron eliminados limpiamente
    const check = await db.query<{ count: string }>(`
      SELECT count(*) as count FROM public.mensajes_encuentro WHERE encuentro_id = '${encHilo}';
    `);
    assert.strictEqual(parseInt(check.rows[0].count, 10), 0);
  });

  // 16. Excepción de moderación: reporte pendiente < 60 días pospone la purga
  test('16. Excepción de moderación: encuentro vencido con reporte pendiente (< 60d) pospone la purga', async () => {
    const encReportado = await createEncounter({
      titulo: 'Encuentro con Denuncia Activa',
      fecha: '2025-09-01',
      hora: '18:00:00',
    });
    await insertMessage(encReportado, hostUser, 'Mensaje objeto de investigación');

    // Insertar reporte en reportes_encuentro con estado 'pending' (hace 10 días)
    await db.query(`
      INSERT INTO public.reportes_encuentro (encuentro_id, estado, created_at)
      VALUES ('${encReportado}', 'pending', now() - interval '10 days');
    `);

    // Ejecutar purga: debe omitir este encuentro y sumar a encuentros_conservados_moderacion
    const purgeRes = await rpcServiceRole(`public.purgar_mensajes_encuentro_vencidos_seguro(50, false)`);
    assert.strictEqual(purgeRes.ok, true);
    assert.strictEqual(purgeRes.encuentros_conservados_moderacion >= 1, true);

    // Los mensajes del encuentro reportado siguen existiendo como evidencia
    const check = await db.query<{ count: string }>(`
      SELECT count(*) as count FROM public.mensajes_encuentro WHERE encuentro_id = '${encReportado}';
    `);
    assert.strictEqual(parseInt(check.rows[0].count, 10), 1);
  });

  // 17. Excepción de moderación resuelta: reporte en 'reviewed' ya no pospone la purga
  test('17. Excepción de moderación resuelta: reporte resuelto permite la purga normal', async () => {
    const encResuelto = await createEncounter({
      titulo: 'Encuentro con Denuncia Resuelta',
      fecha: '2025-09-01',
      hora: '18:00:00',
    });
    await insertMessage(encResuelto, hostUser, 'Mensaje que ya fue investigado');

    // Reporte resuelto ('reviewed')
    await db.query(`
      INSERT INTO public.public_content_reports (encuentro_id, status, created_at)
      VALUES ('${encResuelto}', 'reviewed', now() - interval '10 days');
    `);

    const purgeRes = await rpcServiceRole(`public.purgar_mensajes_encuentro_vencidos_seguro(50, false)`);
    assert.strictEqual(purgeRes.ok, true);

    // Mensajes eliminados
    const check = await db.query<{ count: string }>(`
      SELECT count(*) as count FROM public.mensajes_encuentro WHERE encuentro_id = '${encResuelto}';
    `);
    assert.strictEqual(parseInt(check.rows[0].count, 10), 0);
  });

  // 18. Moderación formalmente abierta: reporte pendiente > 60d NO se purga (evidencia protegida) y alerta en métricas
  test('18. Moderación formalmente abierta: reporte pendiente > 60d preserva evidencia y alerta en reportes_stale_pendientes', async () => {
    const encStale = await createEncounter({
      titulo: 'Encuentro con Denuncia Formalmente Abierta Prolongada',
      fecha: '2025-09-01',
      hora: '18:00:00',
    });
    await insertMessage(encStale, hostUser, 'Mensaje crucial para la investigación formal');

    // Reporte pendiente de más de 70 días (> 60d umbral de alerta administrativa)
    await db.query(`
      INSERT INTO public.reportes_encuentro (encuentro_id, estado, created_at)
      VALUES ('${encStale}', 'pending', now() - interval '70 days');
    `);

    // La purga NUNCA destruye evidencia de investigaciones abiertas, pero reporta la alerta administrativa
    const purgeRes = await rpcServiceRole(`public.purgar_mensajes_encuentro_vencidos_seguro(50, false)`);
    assert.strictEqual(purgeRes.ok, true);
    assert.strictEqual(purgeRes.encuentros_conservados_moderacion >= 1, true);
    assert.strictEqual(purgeRes.reportes_stale_pendientes >= 1, true);

    // Los mensajes del encuentro reportado siguen preservados en la DB
    const check1 = await db.query<{ count: string }>(`
      SELECT count(*) as count FROM public.mensajes_encuentro WHERE encuentro_id = '${encStale}';
    `);
    assert.strictEqual(parseInt(check1.rows[0].count, 10), 1);

    // Al resolver formalmente la denuncia ('reviewed'), la siguiente corrida sí lo purga
    await db.query(`
      UPDATE public.reportes_encuentro
      SET estado = 'reviewed'
      WHERE encuentro_id = '${encStale}';
    `);

    const purgeResPost = await rpcServiceRole(`public.purgar_mensajes_encuentro_vencidos_seguro(50, false)`);
    assert.strictEqual(purgeResPost.ok, true);

    const check2 = await db.query<{ count: string }>(`
      SELECT count(*) as count FROM public.mensajes_encuentro WHERE encuentro_id = '${encStale}';
    `);
    assert.strictEqual(parseInt(check2.rows[0].count, 10), 0);
  });

  // 19. Purga separada de rate limits: purgar_rate_limits_participantes_seguro
  test('19. Purga de participante_rate_limit_buckets: elimina buckets > 48h sin afectar buckets recientes', async () => {
    // Insertar política de rate limit si no existe
    await db.query(`
      INSERT INTO public.rate_limit_policies (action, max_requests, window_seconds, enabled)
      VALUES ('mensaje_participante', 10, 300, true)
      ON CONFLICT (action) DO NOTHING;
    `);

    // Obtener un participante_id real
    const partRow = await db.query<{ id: string }>(`
      SELECT id FROM public.participantes LIMIT 1;
    `);
    const partId = partRow.rows[0].id;

    // Insertar un bucket viejo (hace 72 horas) y uno reciente (hace 2 horas)
    await db.query(`
      INSERT INTO public.participante_rate_limit_buckets (
        action, participante_id, scope_key, window_start, request_count, updated_at
      )
      VALUES 
        ('mensaje_participante', '${partId}', '', now() - interval '72 hours', 5, now() - interval '72 hours'),
        ('mensaje_participante', '${partId}', '', now() - interval '2 hours', 3, now() - interval '2 hours');
    `);

    // Ejecutar purga de rate limits
    const rlPurge = await rpcServiceRole(`public.purgar_rate_limits_participantes_seguro(1000, false)`);
    assert.strictEqual(rlPurge.ok, true);
    assert.strictEqual(rlPurge.buckets_eliminados, 1);

    // Verificar que el bucket reciente sigue existiendo
    const remaining = await db.query<{ count: string }>(`
      SELECT count(*) as count FROM public.participante_rate_limit_buckets 
      WHERE participante_id = '${partId}';
    `);
    assert.strictEqual(parseInt(remaining.rows[0].count, 10), 1);
  });

  // 20. Permisos de seguridad: anon y authenticated no pueden invocar las funciones de purga
  test('20. Permisos de seguridad: funciones de purga denegadas a anon y authenticated (fail-closed)', async () => {
    await setAuth(participantUser, false);
    await db.exec(`SET ROLE authenticated;`);
    try {
      await assert.rejects(async () => {
        await db.query(`SELECT public.purgar_mensajes_encuentro_vencidos_seguro(50, true);`);
      }, /permission denied/);

      await assert.rejects(async () => {
        await db.query(`SELECT public.purgar_rate_limits_participantes_seguro(50, true);`);
      }, /permission denied/);
    } finally {
      await db.exec(`RESET ROLE;`);
    }
  });

  // 21. Privacy-First: Terceros no autorizados reciben 'unauthorized' sin revelar retención o purga
  test('21. Privacy-First: Terceros no autorizados reciben unauthorized sin filtrar history_retention_expired o history_purged', async () => {
    // Encuentro con retención expirada (> 90 días)
    const encVencido = await createEncounter({
      titulo: 'Encuentro Antiguo Para Test Privacidad',
      fecha: '2025-01-01',
      hora: '18:00:00',
    });

    // Encuentro purgado
    const encPurgado = await createEncounter({
      titulo: 'Encuentro Purgado Para Test Privacidad',
      fecha: '2025-01-01',
      hora: '18:00:00',
      messages_purged_at: new Date().toISOString(),
    });

    // Encuentro cancelado
    const encCancelado = await createEncounter({
      titulo: 'Encuentro Cancelado Para Test Privacidad',
      fecha: '2026-12-01',
      hora: '18:00:00',
      estado: 'cancelado',
      cancelled_at: new Date().toISOString(),
    });

    // 1. Invocación como otro usuario (autenticado en Supabase pero ajeno al encuentro)
    const resVencidoOther = await rpc(`public.get_mensajes_encuentro_seguro('${encVencido}')`, otherUser);
    assert.strictEqual(resVencidoOther.ok, false);
    assert.strictEqual(resVencidoOther.error, 'unauthorized');

    const resPurgadoOther = await rpc(`public.get_mensajes_encuentro_seguro('${encPurgado}')`, otherUser);
    assert.strictEqual(resPurgadoOther.ok, false);
    assert.strictEqual(resPurgadoOther.error, 'unauthorized');

    const resCanceladoOther = await rpc(`public.get_mensajes_encuentro_seguro('${encCancelado}')`, otherUser);
    assert.strictEqual(resCanceladoOther.ok, false);
    assert.strictEqual(resCanceladoOther.error, 'unauthorized');

    // 2. Invocación anónima no vinculada (sin token y sin sesión)
    const resVencidoAnon = await rpc(`public.get_mensajes_encuentro_seguro('${encVencido}')`, null, true);
    assert.strictEqual(resVencidoAnon.ok, false);
    assert.strictEqual(resVencidoAnon.error, 'unauthorized');

    const resPurgadoAnon = await rpc(`public.get_mensajes_encuentro_seguro('${encPurgado}')`, null, true);
    assert.strictEqual(resPurgadoAnon.ok, false);
    assert.strictEqual(resPurgadoAnon.error, 'unauthorized');
  });

  // 22. Invariante de zona horaria: Comportamiento idéntico bajo sesión UTC y America/Argentina/Buenos_Aires
  test('22. Invariante temporal: Comparaciones TIMESTAMPTZ idénticas bajo sesiones UTC y America/Argentina/Buenos_Aires', async () => {
    const encTz = await createEncounter({
      titulo: 'Encuentro Test Timezone Session',
      fecha: '2027-06-15',
      hora: '15:30:00',
    });
    await insertMessage(encTz, hostUser, 'Mensaje para auditoria horaria');

    // Sesión en UTC
    await db.exec(`SET timezone = 'UTC';`);
    const resUtc = await rpc(`public.get_mensajes_encuentro_seguro('${encTz}')`, hostUser);
    assert.strictEqual(resUtc.ok, true);
    assert.strictEqual(resUtc.can_write, true);
    assert.strictEqual(resUtc.writing_window_closed, false);

    // Sesión en America/Argentina/Buenos_Aires
    await db.exec(`SET timezone = 'America/Argentina/Buenos_Aires';`);
    const resBsAs = await rpc(`public.get_mensajes_encuentro_seguro('${encTz}')`, hostUser);
    assert.strictEqual(resBsAs.ok, true);
    assert.strictEqual(resBsAs.can_write, true);
    assert.strictEqual(resBsAs.writing_window_closed, false);

    // Resetear timezone de sesión al default
    await db.exec(`RESET timezone;`);
  });

  // 23. Scrubbing retroactivo ejecutado en la migración
  test('23. Scrubbing retroactivo de migración: redacta mensajes viejos eliminados sin denuncias pendientes', async () => {
    // Verificar que el mensaje preexistente sin denuncia fue scrubbeado a '[Mensaje eliminado]'
    const msg1 = await db.query<{ contenido: string; eliminado_en: string }>(`
      SELECT contenido, eliminado_en FROM public.mensajes_encuentro 
      WHERE id = '11111111-0000-0000-0000-000000000001';
    `);
    assert.strictEqual(msg1.rows[0].contenido, '[Mensaje eliminado]');
    assert.ok(msg1.rows[0].eliminado_en);

    // Verificar que el mensaje preexistente con denuncia pendiente abierta NO fue scrubbeado (evidencia intacta)
    const msg2 = await db.query<{ contenido: string; eliminado_en: string }>(`
      SELECT contenido, eliminado_en FROM public.mensajes_encuentro 
      WHERE id = '22222222-0000-0000-0000-000000000002';
    `);
    assert.strictEqual(msg2.rows[0].contenido, 'Evidencia sensible con investigacion abierta');
    assert.ok(msg2.rows[0].eliminado_en);
  });
});
