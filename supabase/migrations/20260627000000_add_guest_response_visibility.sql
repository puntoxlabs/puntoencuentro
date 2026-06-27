-- ============================================================
-- Agrega columna para controlar visibilidad de respuestas a invitados.
-- DEFAULT false = desactivado por defecto (privacidad por defecto).
-- No toca RLS ni policies.
-- ============================================================

ALTER TABLE public.encuentros
ADD COLUMN IF NOT EXISTS mostrar_respuestas_a_invitados boolean NOT NULL DEFAULT false;
