-- ==============================================================================
-- Migración: 20261020140000_encounter_messages_retention_and_purge_v1.sql
-- Propósito: Sprint 3 — Retención y purga segura de mensajes del encuentro V1
--
-- Contenido:
--   1. Columna persistente messages_purged_at e índices de soporte para retención.
--   2. Actualización de resolver_actor_encuentro:
--      - Privacy-first: validación de identidad y autorización ANTES de revelar estados de ciclo de vida.
--      - Corte exacto de retención: 90 días post-inicio (realizados) y 30 días post-cancelación (organizador).
--      - Cálculos temporales canónicos en TIMESTAMPTZ con zona America/Argentina/Buenos_Aires.
--      - Marca persistente messages_purged_at que impide reactivar historiales purgados ante reprogramación.
--      - Protección estricta ante anomalías: cancelled_at IS NULL no usa creado_en y excluye de purga automática.
--   3. Endurecimiento de eliminar_mensaje_encuentro_seguro con scrubbing inmediato de contenido sensible
--      y sanitización retroactiva de mensajes previamente borrados sin denuncias pendientes.
--   4. Función interna de mantenimiento public.purgar_mensajes_encuentro_vencidos_seguro:
--      - Modo dry-run, batches acotados, FOR UPDATE SKIP LOCKED, circuit breaker.
--      - Excepción estricta de conservación: NUNCA destruir evidencia mientras existan denuncias formalmente abiertas.
--      - Umbral de 60 días como alerta administrativa (reportes_stale_pendientes), sin destruir evidencia.
--   5. Función desacoplada public.purgar_rate_limits_participantes_seguro (> 48h).
--
-- NOTA DE ACTIVACIÓN:
--   El cron NO se programa ni se habilita en esta migración (requiere autorización y migración posterior).
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. TABLA: public.encuentros — MARCA PERSISTENTE DE PURGA E ÍNDICES
-- ==============================================================================
ALTER TABLE public.encuentros
    ADD COLUMN IF NOT EXISTS messages_purged_at TIMESTAMPTZ DEFAULT NULL;

-- Índices parciales para consultas de retención eficientes sin full-table scan
CREATE INDEX IF NOT EXISTS idx_encuentros_retencion_realizados
    ON public.encuentros (fecha, hora)
    WHERE estado <> 'cancelado' AND messages_purged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_encuentros_retencion_cancelados
    ON public.encuentros (cancelled_at)
    WHERE estado = 'cancelado' AND messages_purged_at IS NULL;

-- Índice para limpieza rápida de rate limit buckets por antigüedad
CREATE INDEX IF NOT EXISTS idx_participante_rate_limit_buckets_updated
    ON public.participante_rate_limit_buckets (updated_at);


-- ==============================================================================
-- 2. FUNCIÓN AUXILIAR: resolver_actor_encuentro (AUTORIZACIÓN PRIMERO + RETENCIÓN)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.resolver_actor_encuentro(
    p_encuentro_id UUID,
    p_token_invitacion UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_encuentro RECORD;
    v_part RECORD;
    v_is_host BOOLEAN := false;
    v_actor_type TEXT := NULL;
    v_user_id UUID := NULL;
    v_participante_id UUID := NULL;
    v_autor_nombre TEXT := NULL;
    v_can_write BOOLEAN := false;
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_inicio_timestamptz TIMESTAMPTZ;
    v_limite_escritura TIMESTAMPTZ;
    v_limite_retencion_realizado TIMESTAMPTZ;
    v_limite_retencion_cancelado TIMESTAMPTZ;
BEGIN
    -- 1. Validar parámetros de entrada
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_parameters');
    END IF;

    SELECT id, host_id, titulo, estado, fecha, hora, date_mode, coordination_status, cancelled_at, messages_purged_at
    INTO v_encuentro
    FROM public.encuentros
    WHERE id = p_encuentro_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_not_found');
    END IF;

    -- 2. PRIVACIDAD Y AUTORIZACIÓN PRIMERO:
    -- Validar rigurosamente la identidad y la relación del invocador con el encuentro
    -- ANTES de exponer cualquier estado temporal o de ciclo de vida (history_retention_expired, history_purged).

    -- A. Organizador del encuentro (sesión permanente o anónima)
    IF v_auth_uid IS NOT NULL AND v_auth_uid = v_encuentro.host_id THEN
        v_is_host := true;
        v_user_id := v_auth_uid;
        
        BEGIN
            v_autor_nombre := COALESCE(
                NULLIF(pg_catalog.current_setting('request.jwt.claim.user_metadata', true)::jsonb->>'full_name', ''),
                NULLIF(pg_catalog.current_setting('request.jwt.claim.user_metadata', true)::jsonb->>'name', ''),
                'Organizador'
            );
        EXCEPTION WHEN OTHERS THEN
            v_autor_nombre := 'Organizador';
        END;

        IF pg_catalog.current_setting('request.jwt.claim.is_anonymous', true) = 'true' THEN
            v_actor_type := 'host_anon';
        ELSE
            v_actor_type := 'host_permanent';
        END IF;

    -- B. Participante registrado con sesión de Supabase (user_id = auth.uid())
    ELSIF v_auth_uid IS NOT NULL THEN
        -- Verificar bloqueo bilateral entre participante y host
        IF EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = v_auth_uid AND blocked_id = v_encuentro.host_id)
               OR (blocker_id = v_encuentro.host_id AND blocked_id = v_auth_uid)
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'blocked_user');
        END IF;

        SELECT id, nombre_invitado, estado, user_id, token_invitacion
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND user_id = v_auth_uid
        ORDER BY (estado = 'confirmado') DESC, creado_en DESC
        LIMIT 1;

        IF NOT FOUND THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
        END IF;

        IF v_part.estado <> 'confirmado' THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'participant_not_confirmed');
        END IF;

        v_actor_type := 'participant_registered';
        v_user_id := v_auth_uid;
        v_participante_id := v_part.id;
        v_autor_nombre := v_part.nombre_invitado;

    -- C. Participante con token de invitación individual
    ELSIF p_token_invitacion IS NOT NULL THEN
        SELECT id, nombre_invitado, estado, user_id, token_invitacion
        INTO v_part
        FROM public.participantes
        WHERE encuentro_id = p_encuentro_id
          AND token_invitacion = p_token_invitacion;

        IF NOT FOUND THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
        END IF;

        IF v_part.estado <> 'confirmado' THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'participant_not_confirmed');
        END IF;

        IF v_part.user_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.bloqueos_usuario
            WHERE (blocker_id = v_part.user_id AND blocked_id = v_encuentro.host_id)
               OR (blocker_id = v_encuentro.host_id AND blocked_id = v_part.user_id)
        ) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'blocked_user');
        END IF;

        v_actor_type := 'guest_token';
        v_user_id := v_part.user_id;
        v_participante_id := v_part.id;
        v_autor_nombre := v_part.nombre_invitado;

    ELSE
        -- Solicitud no autenticada y sin token: denegar inmediatamente
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    -- 3. ESTADOS DE CICLO DE VIDA Y RETENCIÓN (Solo accesibles para actores autorizados)

    -- A. Marca persistente de purga ejecutada:
    -- Si los mensajes ya fueron purgados físicamente, el historial no se reabre bajo ninguna circunstancia
    IF v_encuentro.messages_purged_at IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'history_purged',
            'purged_at', v_encuentro.messages_purged_at
        );
    END IF;

    -- B. Regla de activación: Coordinación de fechas
    -- Exige estado 'closed' y fecha/hora definitivas
    IF v_encuentro.date_mode = 'coordination' AND (
        v_encuentro.coordination_status IS DISTINCT FROM 'closed' OR
        v_encuentro.fecha IS NULL OR
        v_encuentro.hora IS NULL
    ) THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'coordination_not_closed');
    END IF;

    -- Debe existir fecha y hora válidas para habilitar el panel
    IF v_encuentro.fecha IS NULL OR v_encuentro.hora IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'missing_schedule');
    END IF;

    -- C. Cálculo temporal en zona canónica (America/Argentina/Buenos_Aires) con TIMESTAMPTZ
    v_inicio_timestamptz := ((v_encuentro.fecha::text || ' ' || v_encuentro.hora::text)::timestamp) AT TIME ZONE 'America/Argentina/Buenos_Aires';
    v_limite_escritura := v_inicio_timestamptz + interval '24 hours';
    v_limite_retencion_realizado := v_inicio_timestamptz + interval '90 days';

    -- D. Manejo de encuentros cancelados
    IF v_encuentro.estado = 'cancelado' THEN
        -- Si el actor NO es el organizador (es participante), denegar inmediatamente
        IF NOT v_is_host THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'meeting_cancelled');
        END IF;

        -- El actor es el organizador en un encuentro cancelado:
        -- Si cuenta con cancelled_at confiable, verificar límite de 30 días
        IF v_encuentro.cancelled_at IS NOT NULL THEN
            v_limite_retencion_cancelado := v_encuentro.cancelled_at + interval '30 days';
            IF v_now > v_limite_retencion_cancelado THEN
                RETURN pg_catalog.jsonb_build_object(
                    'ok', false,
                    'error', 'history_retention_expired',
                    'retention_type', 'cancelled_30d'
                );
            END IF;
        END IF;
        -- Si cancelled_at IS NULL (anomalía), por regla 2.A no usar creado_en; el host mantiene lectura temporal

        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'actor_type', v_actor_type,
            'is_host', true,
            'user_id', v_user_id,
            'participante_id', NULL,
            'autor_nombre', v_autor_nombre,
            'can_write', false,
            'encuentro_estado', v_encuentro.estado,
            'writing_window_closed', true,
            'retention_expired', false
        );
    END IF;

    -- E. Encuentro activo/no cancelado: Verificar retención de 90 días
    IF v_now > v_limite_retencion_realizado THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', false,
            'error', 'history_retention_expired',
            'retention_type', 'active_90d'
        );
    END IF;

    -- F. Ventana de escritura de 24 horas
    IF v_now <= v_limite_escritura THEN
        v_can_write := true;
    ELSE
        v_can_write := false;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'actor_type', v_actor_type,
        'is_host', v_is_host,
        'user_id', v_user_id,
        'participante_id', v_participante_id,
        'autor_nombre', v_autor_nombre,
        'can_write', v_can_write,
        'encuentro_estado', v_encuentro.estado,
        'writing_window_closed', (v_now > v_limite_escritura),
        'retention_expired', false
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_actor_encuentro(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolver_actor_encuentro(UUID, UUID) TO anon, authenticated, service_role;


-- ==============================================================================
-- 3. ENDURECIMIENTO: eliminar_mensaje_encuentro_seguro (SCRUBBING INMEDIATO Y RETROACTIVO)
-- Reemplaza inmediatamente el contenido por un marcador neutral manteniendo el tombstone.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.eliminar_mensaje_encuentro_seguro(
    p_mensaje_id UUID,
    p_token_invitacion UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_mensaje RECORD;
    v_actor JSONB;
    v_is_host BOOLEAN;
    v_user_id UUID;
    v_part_id UUID;
    v_can_write BOOLEAN;
    v_tipo_eliminacion TEXT := NULL;
BEGIN
    SELECT id, encuentro_id, autor_user_id, autor_participante_id, es_organizador, eliminado_en
    INTO v_mensaje
    FROM public.mensajes_encuentro
    WHERE id = p_mensaje_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'message_not_found');
    END IF;

    IF v_mensaje.eliminado_en IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', true, 'already_deleted', true);
    END IF;

    v_actor := public.resolver_actor_encuentro(v_mensaje.encuentro_id, p_token_invitacion);
    IF (v_actor->>'ok')::boolean IS NOT true THEN
        RETURN v_actor;
    END IF;

    v_is_host := (v_actor->>'is_host')::boolean;
    v_user_id := (v_actor->>'user_id')::uuid;
    v_part_id := (v_actor->>'participante_id')::uuid;
    v_can_write := (v_actor->>'can_write')::boolean;

    -- Moderación por el organizador (incluso fuera de la ventana de escritura del encuentro)
    IF v_is_host THEN
        v_tipo_eliminacion := 'organizador';
    -- Eliminación de mensaje propio por el autor (requiere ventana activa de escritura)
    ELSIF v_can_write AND (
        (v_user_id IS NOT NULL AND v_mensaje.autor_user_id = v_user_id) OR
        (v_part_id IS NOT NULL AND v_mensaje.autor_participante_id = v_part_id)
    ) THEN
        v_tipo_eliminacion := 'autor';
    ELSE
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'unauthorized_delete');
    END IF;

    -- Scrubbing inmediato: sobreescribe el texto sensible original por el marcador neutral
    UPDATE public.mensajes_encuentro
    SET contenido = '[Mensaje eliminado]',
        eliminado_en = pg_catalog.now(),
        eliminado_por_tipo = v_tipo_eliminacion,
        destacado = false,
        destacado_en = NULL,
        destacado_por = NULL
    WHERE id = p_mensaje_id;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'mensaje_id', p_mensaje_id,
        'tipo', v_tipo_eliminacion
    );
END;
$$;

REVOKE ALL ON FUNCTION public.eliminar_mensaje_encuentro_seguro(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eliminar_mensaje_encuentro_seguro(UUID, UUID) TO anon, authenticated, service_role;

-- Scrubbing retroactivo para datos preexistentes:
-- Limpia contenido sensible de mensajes eliminados previamente sin denuncias pendientes.
UPDATE public.mensajes_encuentro m
SET contenido = '[Mensaje eliminado]'
WHERE m.eliminado_en IS NOT NULL
  AND m.contenido <> '[Mensaje eliminado]'
  AND NOT EXISTS (
    SELECT 1 FROM public.reportes_encuentro r
    WHERE r.encuentro_id = m.encuentro_id
      AND r.estado = 'pending'
    UNION ALL
    SELECT 1 FROM public.public_content_reports pr
    WHERE pr.encuentro_id = m.encuentro_id
      AND pr.status = 'pending'
  );


-- ==============================================================================
-- 4. FUNCIÓN INTERNA DE PURGA: public.purgar_mensajes_encuentro_vencidos_seguro
-- Operación idempotente por lotes acotados con FOR UPDATE SKIP LOCKED y circuit breaker.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.purgar_mensajes_encuentro_vencidos_seguro(
    p_batch_size INT DEFAULT 500,
    p_dry_run BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.now();
    v_enc RECORD;
    v_encuentros_procesados INT := 0;
    v_mensajes_eliminados INT := 0;
    v_conservados_moderacion INT := 0;
    v_reportes_stale_pendientes INT := 0;
    v_anomalias_cancelled_at_null INT := 0;
    v_circuit_breaker BOOLEAN := false;
    v_max_mensajes INT := 10000;
    v_max_encuentros INT := LEAST(GREATEST(COALESCE(p_batch_size, 50), 1), 100);
    v_start_time TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_duracion_ms NUMERIC;
    v_tiene_reporte BOOLEAN;
    v_tiene_stale BOOLEAN;
    v_deleted_count INT;
BEGIN
    -- 1. Detección y conteo de anomalías: encuentros cancelados sin cancelled_at
    -- Por regla 2.A: EXCLUIRLOS de la purga automática y reportar en métricas
    SELECT pg_catalog.count(*)
    INTO v_anomalias_cancelled_at_null
    FROM public.encuentros
    WHERE estado = 'cancelado'
      AND cancelled_at IS NULL
      AND messages_purged_at IS NULL;

    -- 2. Recorrer candidatos vencidos con lock pesimista SKIP LOCKED
    FOR v_enc IN
        SELECT id, estado, fecha, hora, cancelled_at
        FROM public.encuentros
        WHERE messages_purged_at IS NULL
          AND (
            -- Encuentros realizados/activos con más de 90 días exactos desde su inicio en hora canónica
            (
              estado <> 'cancelado'
              AND fecha IS NOT NULL
              AND hora IS NOT NULL
              AND (((fecha::text || ' ' || hora::text)::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') + interval '90 days') < v_now
            )
            OR
            -- Encuentros cancelados con cancelled_at con más de 30 días exactos desde la cancelación
            (
              estado = 'cancelado'
              AND cancelled_at IS NOT NULL
              AND (cancelled_at + interval '30 days') < v_now
            )
          )
        ORDER BY id
        LIMIT v_max_encuentros
        FOR UPDATE SKIP LOCKED
    LOOP
        -- 3. Excepción de conservación por moderación formalmente abierta:
        -- Si existe reporte pendiente en public.reportes_encuentro o public.public_content_reports,
        -- NUNCA destruir evidencia automáticamente mientras la investigación continúe formalmente abierta.
        SELECT EXISTS (
            SELECT 1 FROM public.reportes_encuentro
            WHERE encuentro_id = v_enc.id
              AND estado = 'pending'
            UNION ALL
            SELECT 1 FROM public.public_content_reports
            WHERE encuentro_id = v_enc.id
              AND status = 'pending'
        ) INTO v_tiene_reporte;

        IF v_tiene_reporte THEN
            v_conservados_moderacion := v_conservados_moderacion + 1;

            -- Umbral de alerta administrativa (reportes pendientes con más de 60 días sin resolución)
            -- No autoriza la purga de evidencia; solo contabiliza la alerta administrativa.
            SELECT EXISTS (
                SELECT 1 FROM public.reportes_encuentro
                WHERE encuentro_id = v_enc.id
                  AND estado = 'pending'
                  AND created_at <= (v_now - interval '60 days')
                UNION ALL
                SELECT 1 FROM public.public_content_reports
                WHERE encuentro_id = v_enc.id
                  AND status = 'pending'
                  AND created_at <= (v_now - interval '60 days')
            ) INTO v_tiene_stale;

            IF v_tiene_stale THEN
                v_reportes_stale_pendientes := v_reportes_stale_pendientes + 1;
            END IF;

            CONTINUE;
        END IF;

        IF p_dry_run THEN
            -- Modo simulación: contar sin alterar
            SELECT pg_catalog.count(*)
            INTO v_deleted_count
            FROM public.mensajes_encuentro
            WHERE encuentro_id = v_enc.id;

            v_mensajes_eliminados := v_mensajes_eliminados + v_deleted_count;
            v_encuentros_procesados := v_encuentros_procesados + 1;
        ELSE
            -- Modo ejecución: eliminar en cascada segura por encuentro completo
            DELETE FROM public.mensajes_encuentro
            WHERE encuentro_id = v_enc.id;

            GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
            v_mensajes_eliminados := v_mensajes_eliminados + v_deleted_count;

            -- Registrar marca persistente de purga
            UPDATE public.encuentros
            SET messages_purged_at = v_now
            WHERE id = v_enc.id;

            v_encuentros_procesados := v_encuentros_procesados + 1;
        END IF;

        -- Circuit breaker de seguridad por corrida
        IF v_mensajes_eliminados >= v_max_mensajes THEN
            v_circuit_breaker := true;
            EXIT;
        END IF;
    END LOOP;

    v_duracion_ms := pg_catalog.round(
        (pg_catalog.date_part('epoch', pg_catalog.clock_timestamp() - v_start_time) * 1000)::numeric, 
        2
    );

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'dry_run', p_dry_run,
        'encuentros_procesados', v_encuentros_procesados,
        'mensajes_eliminados', v_mensajes_eliminados,
        'encuentros_conservados_moderacion', v_conservados_moderacion,
        'reportes_stale_pendientes', v_reportes_stale_pendientes,
        'anomalias_cancelled_at_null', v_anomalias_cancelled_at_null,
        'circuit_breaker_triggered', v_circuit_breaker,
        'duracion_ms', v_duracion_ms
    );
END;
$$;

REVOKE ALL ON FUNCTION public.purgar_mensajes_encuentro_vencidos_seguro(INT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purgar_mensajes_encuentro_vencidos_seguro(INT, BOOLEAN) TO postgres, service_role;


-- ==============================================================================
-- 5. FUNCIÓN INTERNA: public.purgar_rate_limits_participantes_seguro
-- Subrutina independiente de mantenimiento para limpiar cuotas de más de 48 horas.
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.purgar_rate_limits_participantes_seguro(
    p_batch_size INT DEFAULT 1000,
    p_dry_run BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_cutoff TIMESTAMPTZ := pg_catalog.now() - interval '48 hours';
    v_count INT := 0;
    v_start_time TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_duracion_ms NUMERIC;
BEGIN
    IF p_dry_run THEN
        SELECT pg_catalog.count(*)
        INTO v_count
        FROM public.participante_rate_limit_buckets
        WHERE updated_at < v_cutoff;
    ELSE
        WITH candidates AS (
            SELECT action, participante_id, scope_key, window_start
            FROM public.participante_rate_limit_buckets
            WHERE updated_at < v_cutoff
            LIMIT p_batch_size
            FOR UPDATE SKIP LOCKED
        ),
        deleted AS (
            DELETE FROM public.participante_rate_limit_buckets b
            USING candidates c
            WHERE b.action = c.action
              AND b.participante_id = c.participante_id
              AND b.scope_key = c.scope_key
              AND b.window_start = c.window_start
            RETURNING 1
        )
        SELECT pg_catalog.count(*) INTO v_count FROM deleted;
    END IF;

    v_duracion_ms := pg_catalog.round(
        (pg_catalog.date_part('epoch', pg_catalog.clock_timestamp() - v_start_time) * 1000)::numeric, 
        2
    );

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'dry_run', p_dry_run,
        'buckets_eliminados', v_count,
        'duracion_ms', v_duracion_ms
    );
END;
$$;

REVOKE ALL ON FUNCTION public.purgar_rate_limits_participantes_seguro(INT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purgar_rate_limits_participantes_seguro(INT, BOOLEAN) TO postgres, service_role;

-- ==============================================================================
-- 6. NOTA DE PROGRAMACIÓN (pg_cron)
-- ==============================================================================
-- El cron NO se programa en esta migración según directiva expresa del Sprint 3.
-- Se activará posteriormente mediante migración independiente sujeta a aprobación.

COMMIT;
