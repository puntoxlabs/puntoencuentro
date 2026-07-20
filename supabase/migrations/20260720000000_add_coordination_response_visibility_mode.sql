-- ============================================================
-- Migración: add_coordination_response_visibility_mode
-- Propósito: Agregar campo visibilidad_respuestas_invitados ('hidden'|'summary'|'detail')
--            como evolución del boolean mostrar_respuestas_a_invitados.
-- Compatibilidad: no elimina el boolean existente — lo mantiene sincronizado.
-- ============================================================

BEGIN;

-- 1. Agregar columna nueva con DEFAULT 'hidden'
ALTER TABLE public.encuentros
ADD COLUMN IF NOT EXISTS visibilidad_respuestas_invitados text
NOT NULL DEFAULT 'hidden';

-- 2. Constraint CHECK para valores válidos
ALTER TABLE public.encuentros
DROP CONSTRAINT IF EXISTS encuentros_visibilidad_respuestas_invitados_check;

ALTER TABLE public.encuentros
ADD CONSTRAINT encuentros_visibilidad_respuestas_invitados_check
CHECK (visibilidad_respuestas_invitados IN ('hidden', 'summary', 'detail'));

-- 3. Migrar datos existentes desde el boolean
--    mostrar_respuestas_a_invitados = true  → 'summary'
--    mostrar_respuestas_a_invitados = false → 'hidden'
--    (nadie tiene 'detail' todavía — ese valor solo se asigna explícitamente)
UPDATE public.encuentros
SET visibilidad_respuestas_invitados = CASE
  WHEN mostrar_respuestas_a_invitados IS TRUE THEN 'summary'
  ELSE 'hidden'
END;

COMMIT;
