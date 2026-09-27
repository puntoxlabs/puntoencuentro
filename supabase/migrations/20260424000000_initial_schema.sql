-- ============================================================
-- Migración Inicial: Esquema Base PuntoEncuentro MVP
-- Archivo: 20260424000000_initial_schema.sql
-- ============================================================

-- Tabla: encuentros
CREATE TABLE IF NOT EXISTS public.encuentros (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    titulo TEXT NOT NULL,
    descripcion TEXT,
    fecha DATE NOT NULL,
    hora TIME NOT NULL,
    modalidad TEXT NOT NULL CHECK (modalidad IN ('presencial', 'virtual')),
    lugar_texto TEXT,
    link_virtual TEXT,
    tipo_invitacion TEXT NOT NULL CHECK (tipo_invitacion IN ('individual', 'link_general')),
    host_id UUID NOT NULL,
    public_token UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
    estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'cancelado')),
    tema TEXT NOT NULL DEFAULT 'blue' CHECK (tema IN ('blue', 'green', 'orange', 'purple')),
    reemplaza_a UUID NULL REFERENCES public.encuentros(id),
    creado_en TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Tabla: participantes
CREATE TABLE IF NOT EXISTS public.participantes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    nombre_invitado TEXT NOT NULL,
    tipo_invitacion TEXT NOT NULL CHECK (tipo_invitacion IN ('individual', 'generico')),
    token_invitacion UUID UNIQUE,
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'confirmado', 'rechazado')),
    user_id UUID,
    mensaje_respuesta TEXT,
    respondido_en TIMESTAMP WITH TIME ZONE,
    creado_en TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Row Level Security (RLS) Simplificada para el MVP
ALTER TABLE public.encuentros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participantes ENABLE ROW LEVEL SECURITY;

-- Políticas iniciales MVP (serán endurecidas en migraciones posteriores)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Enable insert for anyone' AND tablename = 'encuentros') THEN
        CREATE POLICY "Enable insert for anyone" ON public.encuentros FOR INSERT WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Enable read access for anyone' AND tablename = 'encuentros') THEN
        CREATE POLICY "Enable read access for anyone" ON public.encuentros FOR SELECT USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Enable insert for participants' AND tablename = 'participantes') THEN
        CREATE POLICY "Enable insert for participants" ON public.participantes FOR INSERT WITH CHECK (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Enable read for participants' AND tablename = 'participantes') THEN
        CREATE POLICY "Enable read for participants" ON public.participantes FOR SELECT USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Enable update for participants' AND tablename = 'participantes') THEN
        CREATE POLICY "Enable update for participants" ON public.participantes FOR UPDATE USING (true);
    END IF;
END $$;

-- Función stub legacy para que el REVOKE de 20260713145000 sea idempotente en bases nuevas
CREATE OR REPLACE FUNCTION public.transferir_encuentros_anonimos_seguro(p_anon_id uuid, p_target_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    NULL;
END;
$$;
