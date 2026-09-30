-- ============================================================
-- Migración: 20260930170000_fase_20c1_trust_enforce_alerts_blocking.sql
-- Módulo: Fase 2.0-C1 Seguridad y Confianza — T3-A2.1
-- Enforcement bilateral de bloqueos en Alertas In-App
-- ============================================================

BEGIN;

-- ============================================================
-- RPC DE LECTURA: get_mis_alertas_seguro
-- Excluye silenciosamente alertas de compatibilidad cuando existe un bloqueo bilateral
-- entre el usuario receptor (a.user_id) y el anfitrión del encuentro objetivo (e.host_id).
-- Preserva la fila de alerta intacta (sin borrar, sin cambiar estado ni timestamps).
-- NUNCA expone public_token, host_id, lugar_texto exacto, link_virtual privado ni emails.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_mis_alertas_seguro()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_result JSONB;
BEGIN
    -- 1. Validar autenticación
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    -- 2. Rechazar cuentas anónimas
    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    -- 3. Consultar alertas propias ordenadas cronológicamente (más recientes primero)
    -- Sólo expone encuentros públicamente accesibles (is_open = true y estado = 'activo')
    -- NUNCA expone public_token, host_id, lugar_texto exacto, link_virtual privado ni emails.
    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'id', a.id,
            'tipo', a.tipo,
            'source_intencion_id', a.source_intencion_id,
            'target_encuentro_id', a.target_encuentro_id,
            'leida', a.leida,
            'created_at', a.created_at,
            'encuentro_titulo', e.titulo,
            'encuentro_fecha', e.fecha,
            'encuentro_hora', e.hora,
            'encuentro_modalidad', e.modalidad,
            'encuentro_approximate_zone', COALESCE(e.open_public_zone, l.nombre, 'Zona aproximada'),
            'encuentro', pg_catalog.jsonb_build_object(
                'id', e.id,
                'titulo', e.titulo,
                'descripcion', COALESCE(e.open_description, e.descripcion),
                'fecha', e.fecha,
                'hora', e.hora,
                'modalidad', e.modalidad,
                'approximate_zone', COALESCE(e.open_public_zone, l.nombre, 'Zona aproximada'),
                'locality_id', e.locality_id,
                'is_open', e.is_open
            )
        ) ORDER BY a.created_at DESC
    ), '[]'::jsonb)
    INTO v_result
    FROM public.alertas_compatibilidad a
    JOIN public.encuentros e ON a.target_encuentro_id = e.id
    LEFT JOIN public.localidades l ON e.locality_id = l.id
    WHERE a.user_id = v_user_id
      AND e.is_open = true
      AND e.estado = 'activo'
      -- Filtrar bloqueos bilaterales entre el receptor de la alerta y el host del encuentro
      AND NOT EXISTS (
          SELECT 1 FROM public.bloqueos_usuario b
          WHERE (b.blocker_id = v_user_id AND b.blocked_id = e.host_id)
             OR (b.blocker_id = e.host_id AND b.blocked_id = v_user_id)
      );

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'alertas', v_result,
        'data', v_result
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_mis_alertas_seguro() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mis_alertas_seguro() TO authenticated;

COMMIT;
