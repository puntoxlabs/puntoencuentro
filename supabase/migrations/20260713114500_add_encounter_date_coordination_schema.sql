-- ============================================================
-- Migración: add_encounter_date_coordination_schema
-- Descripción: Agrega soporte para coordinación de fechas,
-- con validaciones y modelo relacional estricto.
-- ============================================================

-- 1. Nuevas columnas en encuentros (Backfill compatible)
ALTER TABLE public.encuentros
ADD COLUMN date_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (date_mode IN ('fixed', 'coordination')),
ADD COLUMN coordination_status TEXT CHECK (coordination_status IN ('open', 'closed')),
ADD COLUMN selected_option_id UUID,
ADD COLUMN response_deadline TIMESTAMP WITH TIME ZONE;

-- 2. Modificación de obligatoriedad de fecha y hora
ALTER TABLE public.encuentros ALTER COLUMN fecha DROP NOT NULL;
ALTER TABLE public.encuentros ALTER COLUMN hora DROP NOT NULL;

-- 3. Constraint estricto de estado de coordinación
ALTER TABLE public.encuentros ADD CONSTRAINT check_encuentro_coordinacion
CHECK (
    (date_mode = 'fixed' AND coordination_status IS NULL AND fecha IS NOT NULL AND hora IS NOT NULL AND selected_option_id IS NULL AND response_deadline IS NULL)
    OR
    (date_mode = 'coordination' AND coordination_status = 'open' AND fecha IS NULL AND hora IS NULL AND selected_option_id IS NULL)
    OR
    (date_mode = 'coordination' AND coordination_status = 'closed' AND fecha IS NOT NULL AND hora IS NOT NULL AND selected_option_id IS NOT NULL)
);

-- 4. Creación de tabla de opciones de fecha
CREATE TABLE public.encuentro_opciones_fecha (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encuentro_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    hora_inicio TIME NOT NULL,
    orden INT NOT NULL CHECK (orden >= 1 AND orden <= 3),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    UNIQUE (encuentro_id, fecha, hora_inicio),
    UNIQUE (encuentro_id, orden),
    CONSTRAINT uq_opciones_encuentro_id_id UNIQUE (encuentro_id, id)
);

CREATE INDEX idx_opciones_encuentro_id ON public.encuentro_opciones_fecha(encuentro_id);

-- 5. Resolución de relación circular de selected_option_id
ALTER TABLE public.encuentros
ADD CONSTRAINT fk_encuentro_selected_option
FOREIGN KEY (id, selected_option_id) 
REFERENCES public.encuentro_opciones_fecha(encuentro_id, id) 
DEFERRABLE INITIALLY DEFERRED;

-- 6. Garantías estructurales en participantes
ALTER TABLE public.participantes ADD CONSTRAINT uq_participantes_encuentro_id_id UNIQUE (encuentro_id, id);

-- 7. Creación de tabla de disponibilidades
CREATE TABLE public.participante_disponibilidades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    participante_id UUID NOT NULL,
    opcion_fecha_id UUID NOT NULL,
    encuentro_id UUID NOT NULL,
    respuesta TEXT NOT NULL CHECK (respuesta IN ('available', 'maybe', 'unavailable')),
    es_preferida BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    UNIQUE (participante_id, opcion_fecha_id),
    
    CONSTRAINT fk_disp_participante FOREIGN KEY (encuentro_id, participante_id) 
        REFERENCES public.participantes(encuentro_id, id) ON DELETE CASCADE,
        
    CONSTRAINT fk_disp_opcion FOREIGN KEY (encuentro_id, opcion_fecha_id) 
        REFERENCES public.encuentro_opciones_fecha(encuentro_id, id) 
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_disp_participante_id ON public.participante_disponibilidades(participante_id);
CREATE INDEX idx_disp_opcion_id ON public.participante_disponibilidades(opcion_fecha_id);

-- 8. Validaciones avanzadas de disponibilidades
ALTER TABLE public.participante_disponibilidades ADD CONSTRAINT check_preferida_no_unavailable
CHECK (
    NOT (es_preferida = true AND respuesta = 'unavailable')
);

CREATE UNIQUE INDEX idx_unica_preferida_por_participante 
ON public.participante_disponibilidades (participante_id) 
WHERE es_preferida = true;

-- 9. Seguridad RLS restrictiva
ALTER TABLE public.encuentro_opciones_fecha ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participante_disponibilidades ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.encuentro_opciones_fecha FROM PUBLIC;
REVOKE ALL ON TABLE public.encuentro_opciones_fecha FROM anon;
REVOKE ALL ON TABLE public.encuentro_opciones_fecha FROM authenticated;

REVOKE ALL ON TABLE public.participante_disponibilidades FROM PUBLIC;
REVOKE ALL ON TABLE public.participante_disponibilidades FROM anon;
REVOKE ALL ON TABLE public.participante_disponibilidades FROM authenticated;
