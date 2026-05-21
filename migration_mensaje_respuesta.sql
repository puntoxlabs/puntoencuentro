-- Migración para añadir el mensaje opcional del invitado en la respuesta
ALTER TABLE public.participantes 
ADD COLUMN IF NOT EXISTS mensaje_respuesta TEXT;
