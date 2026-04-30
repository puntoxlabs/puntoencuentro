-- Run this in your Supabase SQL Editor if you are getting errors about the 'reemplaza_a' column
ALTER TABLE public.encuentros ADD COLUMN IF NOT EXISTS reemplaza_a UUID NULL REFERENCES public.encuentros(id);

-- Optional: If you want to see which encounter replaces which in the UI more easily
COMMENT ON COLUMN public.encuentros.reemplaza_a IS 'Reference to the encounter this one replaces (cancellation flow)';
