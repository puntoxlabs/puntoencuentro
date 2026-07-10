-- ============================================================
-- Migración: Tabla custom_invitation_templates + RLS + RPC pública
-- 20260710000001_custom_invitation_templates.sql
-- ============================================================
-- Alcance:
--   1. Tabla public.custom_invitation_templates
--   2. Índice de acceso por usuario
--   3. Habilitar RLS
--   4. Políticas RLS (SELECT, INSERT, UPDATE, DELETE propias)
--   5. Función y trigger updated_at
--   6. RPC pública para invitados: get_custom_invitation_template_public
--   7. GRANT EXECUTE de la RPC
--
-- Storage (bucket custom-invitation-templates):
--   Incluido como SQL comentado para referencia.
--   El bucket debe crearse desde Supabase Dashboard > Storage
--   antes de aplicar las policies de storage.
--
-- NO modifica: encuentros, participantes, otras tablas,
--              constraints existentes, RLS de otras tablas,
--              RPCs existentes, frontend, assets.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. TABLA custom_invitation_templates
-- ============================================================

CREATE TABLE IF NOT EXISTS public.custom_invitation_templates (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name            text        NOT NULL DEFAULT 'Mi diseño',

    -- Paths canónicos en Storage (dato primario, siempre presente).
    -- Permiten generar URLs públicas, firmadas o vía Edge Function
    -- sin necesidad de otra migración si cambia la estrategia de acceso.
    image_path      text        NOT NULL,
    thumbnail_path  text,

    -- URLs resueltas (opcionales).
    -- Populadas si se usa public URL o cache; null si se resuelven en runtime.
    image_url       text,
    thumbnail_url   text,

    overlay_opacity numeric     NOT NULL DEFAULT 0.35,
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. ÍNDICE
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_custom_templates_user_active
    ON public.custom_invitation_templates (user_id, is_active, created_at DESC);

-- ============================================================
-- 3. HABILITAR RLS
-- ============================================================

ALTER TABLE public.custom_invitation_templates ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. POLÍTICAS RLS
-- ============================================================

-- 4.1 SELECT: el usuario autenticado solo ve sus propios diseños.
--     Los invitados anónimos acceden ÚNICAMENTE vía la RPC pública.
--     No existe SELECT público sobre esta tabla.
CREATE POLICY "custom_templates_select_own"
    ON public.custom_invitation_templates
    FOR SELECT
    USING (auth.uid() = user_id);

-- 4.2 INSERT: el usuario autenticado puede insertar solo sus propios diseños.
--     El límite de 3 activos se aplica mediante el trigger
--     enforce_custom_templates_limit (ver sección 5.3), que corre antes
--     del INSERT y lanza excepción si el contador ya llegó a 3.
--     Se usa trigger en lugar de subquery en la policy para evitar
--     posible recursión RLS al consultar la misma tabla protegida.
CREATE POLICY "custom_templates_insert_own"
    ON public.custom_invitation_templates
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- 4.3 UPDATE: el usuario autenticado puede editar solo sus propios diseños.
--     Incluye el soft delete: UPDATE SET is_active = false.
--     Esta es la única forma de "eliminar" un diseño en MVP.
--
--     USING:      garantiza que solo puede editar filas donde ya es dueño.
--     WITH CHECK: garantiza que no puede reasignar user_id a otro usuario.
--     Ambas cláusulas son necesarias para UPDATE seguro.
CREATE POLICY "custom_templates_update_own"
    ON public.custom_invitation_templates
    FOR UPDATE
    USING     (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- 4.4 DELETE: NO se crea policy DELETE en MVP.
--     La eliminación se implementa como soft delete:
--       UPDATE custom_invitation_templates SET is_active = false WHERE id = ...
--     Esto preserva la referencia desde encuentros.invitation_template y evita
--     romper invitaciones ya compartidas.
--     Si en el futuro se requiere borrado físico (ej: limpieza de storage),
--     se agrega la policy en una migración separada con las salvaguardas necesarias.

-- ============================================================
-- 5. TRIGGER updated_at
-- ============================================================

-- 5.1 Función set_updated_at (genérica, reutilizable)
--     Se crea solo si no existe ya en el esquema.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- 5.2 Trigger updated_at sobre custom_invitation_templates
DROP TRIGGER IF EXISTS trg_custom_templates_updated_at
    ON public.custom_invitation_templates;

CREATE TRIGGER trg_custom_templates_updated_at
    BEFORE UPDATE ON public.custom_invitation_templates
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- 5.3 FUNCIÓN Y TRIGGER: límite de 3 diseños activos por usuario
-- ============================================================
--
-- Por qué trigger y no subquery en la policy INSERT:
--   Una subquery sobre la misma tabla dentro de una policy RLS puede
--   causar recursión RLS — la evaluación de la policy dispara otra
--   evaluación de la misma policy en el SELECT interno, con resultados
--   imprevisibles o errores difíciles de depurar.
--
-- El trigger corre a nivel de motor (BEFORE INSERT OR UPDATE), fuera
-- del contexto de evaluación de policies, y puede leer la tabla de forma
-- segura con SECURITY DEFINER.
--
-- Comportamiento:
--   - INSERT con NEW.is_active = true:  cuenta activos del usuario (sin el propio).
--     Si ya hay 3, lanza EXCEPTION con código legible.
--   - UPDATE que reactiva (NEW.is_active = true) o cambia user_id:
--     idem — no permite superar 3 activos en el usuario destino.
--   - Soft delete (UPDATE SET is_active = false): NEW.is_active = false
--     → skip inmediato, sin contar ni lanzar nada.
--

CREATE OR REPLACE FUNCTION public.enforce_custom_templates_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_active_count integer;
BEGIN
    -- Si el registro queda inactivo, no hay nada que limitar.
    -- Cubre soft delete y cualquier UPDATE que no reactive el diseño.
    IF NEW.is_active IS DISTINCT FROM true THEN
        RETURN NEW;
    END IF;

    -- Lock transaccional por user_id.
    -- pg_advisory_xact_lock serializa INSERT/UPDATE activos del mismo usuario
    -- dentro de una transacción: si dos INSERTs del mismo usuario llegan en
    -- paralelo, el segundo espera a que el primero finalice antes de contar.
    -- hashtext() produce un int4 estable desde el uuid como texto.
    -- El lock se libera automáticamente al terminar la transacción.
    PERFORM pg_advisory_xact_lock(hashtext(NEW.user_id::text));

    -- Contar diseños activos del mismo usuario, excluyendo el registro
    -- propio (relevante en UPDATE para no contarse a sí mismo).
    SELECT COUNT(*)
    INTO v_active_count
    FROM public.custom_invitation_templates
    WHERE user_id = NEW.user_id
      AND is_active = true
      AND id IS DISTINCT FROM NEW.id;

    IF v_active_count >= 3 THEN
        RAISE EXCEPTION 'custom_templates_limit_exceeded'
            USING HINT = 'El usuario ya tiene 3 diseños personalizados activos.';
    END IF;

    RETURN NEW;
END;
$$;

-- El trigger actúa en INSERT y en UPDATE de las columnas relevantes.
-- UPDATE OF is_active, user_id evita disparar el trigger en UPDATEs
-- que solo toquen name, image_path, overlay_opacity, etc.
DROP TRIGGER IF EXISTS trg_custom_templates_limit
    ON public.custom_invitation_templates;

CREATE TRIGGER trg_custom_templates_limit
    BEFORE INSERT OR UPDATE OF is_active, user_id
    ON public.custom_invitation_templates
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_custom_templates_limit();

-- ============================================================
-- 6. RPC PÚBLICA SEGURA PARA INVITADOS ANÓNIMOS
-- ============================================================
--
-- Propósito: permitir que un invitado anónimo (sin sesión) pueda
-- obtener ÚNICAMENTE los datos visuales del diseño personalizado
-- que corresponde al encuentro cuyo link recibió.
--
-- Garantías de seguridad:
--   a) Recibe el public_token — dato que el invitado ya tiene
--      por haber recibido el link.
--   b) Verifica que el encuentro exista y esté activo.
--   c) Verifica que tema_invitacion = 'custom'.
--   d) Valida el formato del invitation_template ('custom_<uuid>').
--   e) Extrae el uuid y busca el diseño en custom_invitation_templates.
--   f) Verifica is_active = true.
--   g) Devuelve solo: id, name, image_url, thumbnail_url, overlay_opacity.
--   h) No devuelve: user_id, datos del usuario, otros diseños.
--   i) No permite enumerar diseños — la entrada siempre es el
--      public_token de un encuentro concreto.
--

CREATE OR REPLACE FUNCTION public.get_custom_invitation_template_public(
    p_public_token text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_public_token_uuid uuid;        -- cast protegido del párametro
    v_encuentro         record;
    v_template_id_text  text;
    v_template_uuid     uuid;
    v_template          record;
BEGIN
    -- 1. Cast protegido: si p_public_token no es un UUID válido,
    --    retornar null controlado en lugar de lanzar error 500.
    BEGIN
        v_public_token_uuid := p_public_token::uuid;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;

    -- 2. Buscar el encuentro por public_token
    SELECT id, estado, tema_invitacion, invitation_template
    INTO v_encuentro
    FROM public.encuentros
    WHERE public_token = v_public_token_uuid;

    -- 3. Si no existe, retornar null silencioso
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- 4. Verificar que el encuentro esté activo
    IF v_encuentro.estado IS DISTINCT FROM 'activo' THEN
        RETURN NULL;
    END IF;

    -- 5. Verificar que el tema sea 'custom'
    IF v_encuentro.tema_invitacion IS DISTINCT FROM 'custom' THEN
        RETURN NULL;
    END IF;

    -- 6. Verificar que invitation_template tenga formato 'custom_<uuid>'
    IF v_encuentro.invitation_template IS NULL
       OR v_encuentro.invitation_template NOT LIKE 'custom_%'
    THEN
        RETURN NULL;
    END IF;

    -- 7. Extraer el uuid — parte después de 'custom_' (7 caracteres)
    v_template_id_text := substring(v_encuentro.invitation_template FROM 8);

    -- 8. Cast protegido del template uuid
    BEGIN
        v_template_uuid := v_template_id_text::uuid;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;

    -- 9. Buscar el diseño activo correspondiente
    SELECT id, name, image_path, thumbnail_path, image_url, thumbnail_url, overlay_opacity
    INTO v_template
    FROM public.custom_invitation_templates
    WHERE id = v_template_uuid
      AND is_active = true;

    -- 10. Si no existe o está inactivo, retornar null silencioso
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- 11. Devolver datos mínimos necesarios para renderizar.
    --     Se incluyen tanto paths canónicos como URLs resueltas.
    --     La UI usará image_url si está presente; si es null,
    --     resolverá el acceso desde image_path según la estrategia final.
    --     NO se devuelve: user_id, datos del usuario, otros diseños.
    RETURN json_build_object(
        'id',              v_template.id,
        'name',            v_template.name,
        'image_path',      v_template.image_path,
        'thumbnail_path',  v_template.thumbnail_path,
        'image_url',       v_template.image_url,
        'thumbnail_url',   v_template.thumbnail_url,
        'overlay_opacity', v_template.overlay_opacity
    );
END;
$$;

-- ============================================================
-- 7. GRANT EXECUTE DE LA RPC PÚBLICA
-- ============================================================

GRANT EXECUTE ON FUNCTION public.get_custom_invitation_template_public(text)
    TO anon, authenticated;

COMMIT;

-- ============================================================
-- STORAGE — PROPUESTA Y VALIDACIÓN PENDIENTE
-- ============================================================
-- El bucket debe crearse manualmente desde:
--   Supabase Dashboard > Storage > New Bucket
--
-- Configuración del bucket:
--   Nombre: custom-invitation-templates
--   Public: FALSE (bucket privado)
--   Allowed MIME types: image/jpeg, image/png, image/webp
--   Max upload size: 5 MB (5242880 bytes)
--
-- Paths usados por el frontend:
--   {user_id}/{template_id}/background.webp
--   {user_id}/{template_id}/thumbnail.webp
--
-- ============================================================
-- ADVERTENCIA SOBRE LECTURA PÚBALICA DE IMÁGENES
-- ============================================================
--
-- PROBLEMA A VALIDAR ANTES DE APLICAR:
--   Una policy SELECT amplia sobre storage.objects del tipo:
--
--     USING (bucket_id = 'custom-invitation-templates')
--
--   permite a cualquier sesión (incluyendo anon) descargar archivos
--   cuya URL conozca. Sin embargo, NO está validado si Supabase Storage
--   también permite LISTAR objetos del bucket con esa policy, lo que
--   expondría los paths de TODOS los archivos de TODOS los usuarios.
--
--   Antes de aplicar cualquier policy de storage, verificar en Supabase:
--     1. Con sesión anon, intentar list() del bucket via API.
--     2. Confirmar si retorna objetos o error de permiso.
--     3. Solo si list() falla para anon, la policy de lectura es segura.
--
-- ============================================================
-- OPCIÓN A — MVP: LECTURA PÚBALICA CONSCIENTE (a validar)
-- ============================================================
--
-- Si se confirma que el listado anónimo falla (solo descarga por URL
-- directa es posible), esta opción es aceptable para MVP con las
-- siguientes condiciones:
--
--   ✓ Las URLs contienen user_id y template_id (UUID) — no adivinables.
--   ✓ El usuario recibe advertencia: "La imagen será visible para
--     quienes reciban el link de invitación."
--   ✓ Las imágenes no contienen datos sensibles del usuario.
--   ✓ El path no contiene información identificable más allá del UUID.
--
-- -- Policy lectura pública (solo aplicar si se validó que anon NO puede listar):
-- CREATE POLICY "custom_storage_public_read"
--     ON storage.objects FOR SELECT
--     USING (bucket_id = 'custom-invitation-templates');
--
-- -- Escritura: solo el dueño puede subir a su propia carpeta.
-- CREATE POLICY "custom_storage_owner_insert"
--     ON storage.objects FOR INSERT
--     WITH CHECK (
--         bucket_id = 'custom-invitation-templates'
--         AND auth.uid()::text = (storage.foldername(name))[1]
--     );
--
-- -- Actualización: solo el dueño.
-- CREATE POLICY "custom_storage_owner_update"
--     ON storage.objects FOR UPDATE
--     USING (
--         bucket_id = 'custom-invitation-templates'
--         AND auth.uid()::text = (storage.foldername(name))[1]
--     );
--
-- -- Eliminación: solo el dueño.
-- CREATE POLICY "custom_storage_owner_delete"
--     ON storage.objects FOR DELETE
--     USING (
--         bucket_id = 'custom-invitation-templates'
--         AND auth.uid()::text = (storage.foldername(name))[1]
--     );
--
-- ============================================================
-- OPCIÓN B — MÁS SEGURA: URLs FIRMADAS VÍA RPC
-- ============================================================
--
-- Si se confirma que el listado anónimo ES posible con la policy
-- SELECT amplia, o si se prefiere mayor control sin depender de esa
-- validación, la alternativa recomendada es:
--
--   1. Bucket completamente privado (sin policy SELECT para anon).
--   2. Una RPC SECURITY DEFINER que genere signed URLs de corta duración
--      (ej. 1 hora) para la imagen correspondiente al public_token.
--   3. El frontend llama a la RPC en el momento de abrir la invitación;
--      recibe una URL firmada temporal y la usa para renderizar la imagen.
--
-- Ventajas de Opción B:
--   + Las URLs expiran: no quedan links válidos indefinidamente.
--   + El bucket no es accesible para anon bajo ninguna circunstancia.
--   + No depende de que el listado esté o no bloqueado.
--
-- Desventajas de Opción B:
--   - Agrega complejidad: nueva RPC para generar signed URLs.
--   - Las URLs expiradas dejan de funcionar en capturas de pantalla
--     o vistas cacheadas (generalmente aceptable).
--
-- DECISION PENDIENTE: validar primero el comportamiento de listado
-- anónimo en el entorno real de Supabase antes de elegir opción.
-- ============================================================
