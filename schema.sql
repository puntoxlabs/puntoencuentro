-- Schema for PuntoEncuentro MVP

-- Tabla: encuentros
CREATE TABLE public.encuentros (
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
    creado_en TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Tabla: participantes
CREATE TABLE public.participantes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    nombre_invitado TEXT NOT NULL,
    tipo_invitacion TEXT NOT NULL CHECK (tipo_invitacion IN ('individual', 'generico')),
    token_invitacion UUID UNIQUE,
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'confirmado', 'rechazado')),
    respondido_en TIMESTAMP WITH TIME ZONE,
    creado_en TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Row Level Security (RLS) Simplificada para el MVP
ALTER TABLE public.encuentros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participantes ENABLE ROW LEVEL SECURITY;

-- Políticas ultra permisivas para MVP (sin login)
CREATE POLICY "Enable insert for anyone" ON public.encuentros FOR INSERT WITH CHECK (true);
CREATE POLICY "Enable read access for anyone" ON public.encuentros FOR SELECT USING (true);
CREATE POLICY "Enable insert for participants" ON public.participantes FOR INSERT WITH CHECK (true);
CREATE POLICY "Enable read for participants" ON public.participantes FOR SELECT USING (true);
CREATE POLICY "Enable update for participants" ON public.participantes FOR UPDATE USING (true);
