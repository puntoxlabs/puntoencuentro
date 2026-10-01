-- Migration: 20261001080000_normalize_production_schema_parity.sql
-- Purpose:
-- 1. Normalize public.encuentros.host_id to NULLABLE (guaranteeing parity between fresh replay, Staging, and Production).
-- 2. Drop 7 legacy MVP policies on encuentros and participantes using exact quoted identifiers.
-- 3. Version and harden public.get_encuentros_participados_por_tokens(text[]) for guest participation lookup.

-- ============================================================================
-- 1. Normalizar host_id a NULLABLE
-- ============================================================================
ALTER TABLE public.encuentros
    ALTER COLUMN host_id DROP NOT NULL;

-- ============================================================================
-- 2. Eliminar policies legadas del MVP usando nombres exactos entre comillas
-- ============================================================================
DROP POLICY IF EXISTS "Enable insert for anyone" ON public.encuentros;
DROP POLICY IF EXISTS "Enable read access for anyone" ON public.encuentros;
DROP POLICY IF EXISTS "update encuentros" ON public.encuentros;
DROP POLICY IF EXISTS "delete encuentros" ON public.encuentros;

DROP POLICY IF EXISTS "Enable insert for participants" ON public.participantes;
DROP POLICY IF EXISTS "Enable read for participants" ON public.participantes;
DROP POLICY IF EXISTS "Enable update for participants" ON public.participantes;

-- ============================================================================
-- 3. Versionar y endurecer get_encuentros_participados_por_tokens
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_encuentros_participados_por_tokens(p_tokens text[])
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_valid_tokens uuid[] := ARRAY[]::uuid[];
    v_token        text;
    v_uuid_token   uuid;
    v_result       json;
BEGIN
    IF p_tokens IS NOT NULL THEN
        FOREACH v_token IN ARRAY p_tokens LOOP
            BEGIN
                v_uuid_token := v_token::uuid;
                v_valid_tokens := pg_catalog.array_append(v_valid_tokens, v_uuid_token);
            EXCEPTION WHEN invalid_text_representation THEN
                NULL;
            END;
        END LOOP;
    END IF;

    IF pg_catalog.array_length(v_valid_tokens, 1) IS NULL THEN
        RETURN '[]'::json;
    END IF;

    IF pg_catalog.array_length(v_valid_tokens, 1) > 50 THEN
        v_valid_tokens := v_valid_tokens[1:50];
    END IF;

    SELECT pg_catalog.json_agg(
        pg_catalog.json_build_object(
            'id',                    e.id,
            'titulo',                e.titulo,
            'descripcion',           e.descripcion,
            'fecha',                 e.fecha,
            'hora',                  e.hora,
            'modalidad',             e.modalidad,
            'lugar_texto',           e.lugar_texto,
            'estado',                e.estado,
            'tema',                  e.tema,
            'tema_invitacion',       COALESCE(e.tema_invitacion, 'classic'),
            'invitation_template',   e.invitation_template,
            'creado_en',             e.creado_en,
            'date_mode',             e.date_mode,
            'coordination_status',   e.coordination_status,
            'tipo_invitacion',       e.tipo_invitacion,
            '_mi_estado',            p.estado,
            '_mi_mensaje',           p.mensaje_respuesta,
            '_mi_token_invitacion',  p.token_invitacion,
            'link_virtual', CASE
                WHEN p.estado = 'confirmado' AND e.modalidad = 'virtual'
                THEN e.link_virtual
                ELSE NULL
            END
        )
        ORDER BY e.creado_en DESC
    )
    INTO v_result
    FROM public.participantes p
    JOIN public.encuentros e ON e.id = p.encuentro_id
    WHERE p.token_invitacion = ANY(v_valid_tokens);

    RETURN COALESCE(v_result, '[]'::json);
END;
$$;

REVOKE ALL ON FUNCTION public.get_encuentros_participados_por_tokens(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_encuentros_participados_por_tokens(text[]) TO anon, authenticated;
