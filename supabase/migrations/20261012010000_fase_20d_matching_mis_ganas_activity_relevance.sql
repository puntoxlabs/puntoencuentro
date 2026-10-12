-- ============================================================
-- Migración: 20261012010000_fase_20d_matching_mis_ganas_activity_relevance.sql
-- Módulo: Fase 20D — Motor de Matching de "Mis ganas" con Relevancia de Actividad
-- Taxonomía table-driven multilingüe (ES/EN/PT/PT-BR), clasificación persistida,
-- registro durable en match_discoveries, deduplicación canónica y pipeline único.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. TABLAS DE TAXONOMÍA SERVER-SIDE (Acceso cliente mínimo)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.activity_categories (
    canonical_key TEXT PRIMARY KEY,
    group_name TEXT NOT NULL,
    display_names JSONB NOT NULL DEFAULT '{}'::jsonb,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now())
);

ALTER TABLE public.activity_categories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.activity_categories FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.activity_categories TO service_role;
GRANT ALL ON TABLE public.activity_categories TO postgres;

CREATE TABLE IF NOT EXISTS public.activity_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_key TEXT NOT NULL REFERENCES public.activity_categories(canonical_key) ON DELETE CASCADE,
    alias_normalized TEXT NOT NULL,
    language TEXT NOT NULL CHECK (language IN ('es', 'en', 'pt', 'pt-br', 'any')),
    strength TEXT NOT NULL CHECK (strength IN ('strong', 'weak')),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),

    CONSTRAINT uq_activity_aliases_key_alias_lang UNIQUE (canonical_key, alias_normalized, language)
);

CREATE INDEX IF NOT EXISTS idx_activity_aliases_lookup
    ON public.activity_aliases (alias_normalized, strength)
    WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_activity_aliases_canonical
    ON public.activity_aliases (canonical_key)
    WHERE active = true;

ALTER TABLE public.activity_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.activity_aliases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.activity_aliases TO service_role;
GRANT ALL ON TABLE public.activity_aliases TO postgres;


-- ============================================================
-- 2. SIEMBRA DE TAXONOMÍA INICIAL REVISADA (V1)
-- ============================================================

-- Categorías
INSERT INTO public.activity_categories (canonical_key, group_name, display_names, active) VALUES
    ('padel', 'deportes', '{"es": "Pádel", "en": "Padel", "pt": "Pádel", "pt-br": "Pádel"}'::jsonb, true),
    ('futbol', 'deportes', '{"es": "Fútbol", "en": "Football / Soccer", "pt": "Futebol", "pt-br": "Futebol"}'::jsonb, true),
    ('tenis', 'deportes', '{"es": "Tenis", "en": "Tennis", "pt": "Tênis", "pt-br": "Tênis"}'::jsonb, true),
    ('basquet', 'deportes', '{"es": "Básquetbol", "en": "Basketball", "pt": "Basquete", "pt-br": "Basquete"}'::jsonb, true),
    ('voley', 'deportes', '{"es": "Vóley", "en": "Volleyball", "pt": "Vôlei", "pt-br": "Vôlei"}'::jsonb, true),
    ('running', 'deportes', '{"es": "Running", "en": "Running", "pt": "Corrida", "pt-br": "Corrida"}'::jsonb, true),
    ('caminata', 'deportes', '{"es": "Caminata urbana", "en": "Walking", "pt": "Caminhada", "pt-br": "Caminhada"}'::jsonb, true),
    ('senderismo', 'deportes', '{"es": "Senderismo / Trekking", "en": "Hiking / Trekking", "pt": "Trilha / Trekking", "pt-br": "Trilha / Trekking"}'::jsonb, true),
    ('ciclismo', 'deportes', '{"es": "Ciclismo", "en": "Cycling", "pt": "Ciclismo", "pt-br": "Ciclismo"}'::jsonb, true),
    ('gimnasio', 'deportes', '{"es": "Gimnasio / Fitness", "en": "Gym / Fitness", "pt": "Academia / Treino", "pt-br": "Academia / Treino"}'::jsonb, true),
    ('yoga', 'deportes', '{"es": "Yoga / Pilates", "en": "Yoga / Pilates", "pt": "Yoga / Pilates", "pt-br": "Yoga / Pilates"}'::jsonb, true),
    ('natacion', 'deportes', '{"es": "Natación", "en": "Swimming", "pt": "Natação", "pt-br": "Natação"}'::jsonb, true),
    ('cafe', 'social', '{"es": "Café / Cafetería", "en": "Coffee", "pt": "Café", "pt-br": "Café"}'::jsonb, true),
    ('comida', 'social', '{"es": "Comida / Almuerzo / Cena", "en": "Dining / Lunch / Dinner", "pt": "Comida / Almoço / Jantar", "pt-br": "Comida / Almoço / Jantar"}'::jsonb, true),
    ('cerveza', 'social', '{"es": "Cerveza / After-office", "en": "Beer / Drinks", "pt": "Cerveja / Happy Hour", "pt-br": "Cerveja / Happy Hour"}'::jsonb, true),
    ('mate', 'social', '{"es": "Mate", "en": "Mate", "pt": "Chimarrão / Mate", "pt-br": "Chimarrão / Mate"}'::jsonb, true),
    ('cine', 'cultura', '{"es": "Cine", "en": "Cinema / Movies", "pt": "Cinema", "pt-br": "Cinema"}'::jsonb, true),
    ('teatro', 'cultura', '{"es": "Teatro / Standup", "en": "Theatre / Standup", "pt": "Teatro / Standup", "pt-br": "Teatro / Standup"}'::jsonb, true),
    ('musica_en_vivo', 'cultura', '{"es": "Música en vivo / Recital", "en": "Live Music / Concert", "pt": "Música ao vivo / Show", "pt-br": "Música ao vivo / Show"}'::jsonb, true),
    ('tocar_musica', 'cultura', '{"es": "Tocar música / Ensayar", "en": "Playing Music / Jam", "pt": "Tocar música / Ensaio", "pt-br": "Tocar música / Ensaio"}'::jsonb, true),
    ('baile', 'cultura', '{"es": "Baile / Danza", "en": "Dancing", "pt": "Dança", "pt-br": "Dança"}'::jsonb, true),
    ('juegos_mesa', 'juegos', '{"es": "Juegos de mesa", "en": "Board Games", "pt": "Jogos de tabuleiro", "pt-br": "Jogos de tabuleiro"}'::jsonb, true),
    ('ajedrez', 'juegos', '{"es": "Ajedrez", "en": "Chess", "pt": "Xadrez", "pt-br": "Xadrez"}'::jsonb, true),
    ('gaming', 'juegos', '{"es": "Videojuegos / Gaming", "en": "Video Games / Gaming", "pt": "Videogames / Gaming", "pt-br": "Videogames / Gaming"}'::jsonb, true),
    ('idiomas', 'aprendizaje', '{"es": "Intercambio de idiomas", "en": "Language Exchange", "pt": "Intercâmbio de idiomas", "pt-br": "Intercâmbio de idiomas"}'::jsonb, true),
    ('estudio', 'aprendizaje', '{"es": "Grupo de estudio", "en": "Study Group", "pt": "Grupo de estudo", "pt-br": "Grupo de estudo"}'::jsonb, true),
    ('ceramica', 'hobbies', '{"es": "Cerámica", "en": "Ceramics / Pottery", "pt": "Cerâmica", "pt-br": "Cerâmica"}'::jsonb, true),
    ('fotografia', 'hobbies', '{"es": "Fotografía", "en": "Photography", "pt": "Fotografia", "pt-br": "Fotografia"}'::jsonb, true),
    ('mascotas', 'otros', '{"es": "Paseo canino / Mascotas", "en": "Dog walk / Pets", "pt": "Passeio canino / Pets", "pt-br": "Passeio canino / Pets"}'::jsonb, true)
ON CONFLICT (canonical_key) DO UPDATE SET
    group_name = EXCLUDED.group_name,
    display_names = EXCLUDED.display_names,
    active = EXCLUDED.active;

-- Aliases Fuertes y Contextuales (Revisión V1: sin paleta, entrenar como weak, sin playa)
INSERT INTO public.activity_aliases (canonical_key, alias_normalized, language, strength, active) VALUES
    -- padel (eliminado 'paleta' por ambigüedad con frontón/playa)
    ('padel', 'padel', 'any', 'strong', true),

    -- futbol
    ('futbol', 'futbol', 'es', 'strong', true),
    ('futbol', 'fulbito', 'es', 'strong', true),
    ('futbol', 'picadito', 'es', 'strong', true),
    ('futbol', 'futsal', 'any', 'strong', true),
    ('futbol', 'soccer', 'en', 'strong', true),
    ('futbol', 'football', 'en', 'strong', true),
    ('futbol', 'futebol', 'pt', 'strong', true),
    ('futbol', 'pelada', 'pt-br', 'strong', true),

    -- tenis
    ('tenis', 'tenis', 'any', 'strong', true),
    ('tenis', 'tennis', 'en', 'strong', true),

    -- basquet
    ('basquet', 'basquet', 'es', 'strong', true),
    ('basquet', 'basquetbol', 'es', 'strong', true),
    ('basquet', 'basketball', 'en', 'strong', true),
    ('basquet', 'basquete', 'pt', 'strong', true),

    -- voley
    ('voley', 'voley', 'es', 'strong', true),
    ('voley', 'voleibol', 'es', 'strong', true),
    ('voley', 'volleyball', 'en', 'strong', true),
    ('voley', 'volei', 'pt', 'strong', true),

    -- running
    ('running', 'running', 'any', 'strong', true),
    ('running', 'correr', 'es', 'strong', true),
    ('running', 'trotar', 'es', 'strong', true),
    ('running', 'jogging', 'en', 'strong', true),
    ('running', 'maraton', 'es', 'strong', true),
    ('running', 'corrida', 'pt', 'strong', true),

    -- caminata (separado formalmente de senderismo)
    ('caminata', 'caminata', 'es', 'strong', true),
    ('caminata', 'caminar', 'es', 'strong', true),
    ('caminata', 'walking', 'en', 'strong', true),
    ('caminata', 'caminhada', 'pt', 'strong', true),
    ('caminata', 'caminhar', 'pt', 'strong', true),

    -- senderismo (trekking, hiking, trilha)
    ('senderismo', 'senderismo', 'es', 'strong', true),
    ('senderismo', 'trekking', 'any', 'strong', true),
    ('senderismo', 'hiking', 'en', 'strong', true),
    ('senderismo', 'hike', 'en', 'strong', true),
    ('senderismo', 'trilha', 'pt', 'strong', true),

    -- ciclismo
    ('ciclismo', 'ciclismo', 'es', 'strong', true),
    ('ciclismo', 'bicicleta', 'es', 'strong', true),
    ('ciclismo', 'bici', 'es', 'strong', true),
    ('ciclismo', 'cycling', 'en', 'strong', true),
    ('ciclismo', 'biking', 'en', 'strong', true),
    ('ciclismo', 'pedalar', 'pt', 'strong', true),

    -- gimnasio (entrenar pasado a weak)
    ('gimnasio', 'gimnasio', 'es', 'strong', true),
    ('gimnasio', 'gym', 'any', 'strong', true),
    ('gimnasio', 'crossfit', 'any', 'strong', true),
    ('gimnasio', 'calistenia', 'es', 'strong', true),
    ('gimnasio', 'musculacion', 'es', 'strong', true),
    ('gimnasio', 'workout', 'en', 'strong', true),
    ('gimnasio', 'academia', 'pt', 'strong', true),

    -- yoga (meditación/mindfulness eliminados de yoga V1)
    ('yoga', 'yoga', 'any', 'strong', true),
    ('yoga', 'ioga', 'pt', 'strong', true),
    ('yoga', 'pilates', 'any', 'strong', true),

    -- natacion
    ('natacion', 'natacion', 'es', 'strong', true),
    ('natacion', 'nadar', 'es', 'strong', true),
    ('natacion', 'swimming', 'en', 'strong', true),
    ('natacion', 'natacao', 'pt', 'strong', true),

    -- cafe (merienda pasada a weak)
    ('cafe', 'cafe', 'any', 'strong', true),
    ('cafe', 'cafecito', 'es', 'strong', true),
    ('cafe', 'coffee', 'en', 'strong', true),
    ('cafe', 'cafeteria', 'es', 'strong', true),
    ('cafe', 'cafezinho', 'pt', 'strong', true),

    -- comida
    ('comida', 'almuerzo', 'es', 'strong', true),
    ('comida', 'almorzar', 'es', 'strong', true),
    ('comida', 'cena', 'es', 'strong', true),
    ('comida', 'cenar', 'es', 'strong', true),
    ('comida', 'asado', 'es', 'strong', true),
    ('comida', 'pizza', 'any', 'strong', true),
    ('comida', 'pizzas', 'es', 'strong', true),
    ('comida', 'brunch', 'any', 'strong', true),
    ('comida', 'lunch', 'en', 'strong', true),
    ('comida', 'dinner', 'en', 'strong', true),
    ('comida', 'almoco', 'pt', 'strong', true),
    ('comida', 'jantar', 'pt', 'strong', true),
    ('comida', 'churrasco', 'pt', 'strong', true),

    -- cerveza (bar/pub pasados a weak)
    ('cerveza', 'cerveza', 'es', 'strong', true),
    ('cerveza', 'birra', 'es', 'strong', true),
    ('cerveza', 'beer', 'en', 'strong', true),
    ('cerveza', 'afteroffice', 'es', 'strong', true),
    ('cerveza', 'previa', 'es', 'strong', true),
    ('cerveza', 'chopp', 'pt-br', 'strong', true),
    ('cerveza', 'cervejaria', 'pt', 'strong', true),

    -- mate
    ('mate', 'mate', 'es', 'strong', true),
    ('mate', 'mates', 'es', 'strong', true),
    ('mate', 'mateada', 'es', 'strong', true),
    ('mate', 'chimarrao', 'pt-br', 'strong', true),

    -- cine
    ('cine', 'cine', 'es', 'strong', true),
    ('cine', 'pelicula', 'es', 'strong', true),
    ('cine', 'peliculas', 'es', 'strong', true),
    ('cine', 'peli', 'es', 'strong', true),
    ('cine', 'cinema', 'en', 'strong', true),
    ('cine', 'movies', 'en', 'strong', true),
    ('cine', 'filme', 'pt', 'strong', true),

    -- teatro
    ('teatro', 'teatro', 'any', 'strong', true),
    ('teatro', 'standup', 'any', 'strong', true),
    ('teatro', 'theatre', 'en', 'strong', true),
    ('teatro', 'theater', 'en', 'strong', true),

    -- musica_en_vivo
    ('musica_en_vivo', 'recital', 'es', 'strong', true),
    ('musica_en_vivo', 'concierto', 'es', 'strong', true),
    ('musica_en_vivo', 'concert', 'en', 'strong', true),
    ('musica_en_vivo', 'gig', 'en', 'strong', true),
    ('musica_en_vivo', 'show', 'pt', 'strong', true),

    -- tocar_musica
    ('tocar_musica', 'ensayar', 'es', 'strong', true),
    ('tocar_musica', 'zapada', 'es', 'strong', true),
    ('tocar_musica', 'jam', 'any', 'strong', true),

    -- baile
    ('baile', 'baile', 'es', 'strong', true),
    ('baile', 'bailar', 'es', 'strong', true),
    ('baile', 'salsa', 'any', 'strong', true),
    ('baile', 'bachata', 'any', 'strong', true),
    ('baile', 'tango', 'any', 'strong', true),
    ('baile', 'dancing', 'en', 'strong', true),
    ('baile', 'danca', 'pt', 'strong', true),

    -- juegos_mesa
    ('juegos_mesa', 'catan', 'any', 'strong', true),
    ('juegos_mesa', 'truco', 'es', 'strong', true),

    -- ajedrez
    ('ajedrez', 'ajedrez', 'es', 'strong', true),
    ('ajedrez', 'chess', 'en', 'strong', true),
    ('ajedrez', 'xadrez', 'pt', 'strong', true),

    -- gaming
    ('gaming', 'gaming', 'any', 'strong', true),
    ('gaming', 'videojuegos', 'es', 'strong', true),
    ('gaming', 'playstation', 'any', 'strong', true),
    ('gaming', 'esports', 'any', 'strong', true),
    ('gaming', 'videogame', 'pt', 'strong', true),

    -- idiomas (conversacion pasada a weak)
    ('idiomas', 'idiomas', 'es', 'strong', true),
    ('idiomas', 'ingles', 'es', 'strong', true),
    ('idiomas', 'english', 'en', 'strong', true),
    ('idiomas', 'tandem', 'any', 'strong', true),
    ('idiomas', 'frances', 'es', 'strong', true),
    ('idiomas', 'portugues', 'es', 'strong', true),

    -- estudio
    ('estudio', 'estudio', 'es', 'strong', true),
    ('estudio', 'estudiar', 'es', 'strong', true),
    ('estudio', 'biblioteca', 'es', 'strong', true),
    ('estudio', 'tesis', 'es', 'strong', true),
    ('estudio', 'study', 'en', 'strong', true),
    ('estudio', 'estudo', 'pt', 'strong', true),

    -- ceramica
    ('ceramica', 'ceramica', 'es', 'strong', true),
    ('ceramica', 'alfareria', 'es', 'strong', true),
    ('ceramica', 'pottery', 'en', 'strong', true),
    ('ceramica', 'ceramics', 'en', 'strong', true),

    -- fotografia
    ('fotografia', 'fotografia', 'es', 'strong', true),
    ('fotografia', 'photography', 'en', 'strong', true),
    ('fotografia', 'fotos', 'es', 'strong', true),

    -- mascotas
    ('mascotas', 'perros', 'es', 'strong', true),
    ('mascotas', 'perro', 'es', 'strong', true),
    ('mascotas', 'mascotas', 'es', 'strong', true),
    ('mascotas', 'dogs', 'en', 'strong', true),
    ('mascotas', 'cachorros', 'pt', 'strong', true)
ON CONFLICT (canonical_key, alias_normalized, language) DO UPDATE SET
    strength = EXCLUDED.strength,
    active = EXCLUDED.active;


-- ============================================================
-- 3. FUNCIÓN DE NORMALIZACIÓN PURA E INMUTABLE
-- No depende de extensiones externas; usa pg_catalog.translate
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_normalize_activity_text(p_text TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_cleaned TEXT;
BEGIN
    IF p_text IS NULL OR pg_catalog.trim(p_text) = '' THEN
        RETURN '';
    END IF;

    -- Minúsculas y reemplazo determinístico de acentos/diacríticos
    v_cleaned := pg_catalog.translate(
        pg_catalog.lower(p_text),
        'áéíóúüñãõàèìòùâêîôûç',
        'aeiouunaoaeiouaeiouc'
    );

    -- Sustituir puntuación y caracteres especiales por espacios
    v_cleaned := pg_catalog.regexp_replace(v_cleaned, '[^a-z0-9]+', ' ', 'g');
    RETURN pg_catalog.trim(v_cleaned);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_normalize_activity_text(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_normalize_activity_text(TEXT) TO postgres, service_role;


-- ============================================================
-- 4. FUNCIÓN DETERMINÍSTICA DE CLASIFICACIÓN DE ACTIVIDAD (V1)
-- Regla final aprobada:
-- exact 1 canonical fuerte => eligible = true, canonical = canon, reason = NULL
-- >= 2 canonicals fuertes => eligible = false, canonical = NULL, reason = 'multiple_activities'
-- 0 canonicals fuertes   => eligible = false, canonical = NULL, reason = 'no_activity_detected'
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_classify_activity(
    p_titulo TEXT,
    p_descripcion TEXT DEFAULT NULL
)
RETURNS TABLE (
    activity_canonical TEXT,
    activity_strong_tokens TEXT[],
    activity_matching_eligible BOOLEAN,
    match_ineligible_reason TEXT
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
    v_norm TEXT;
    v_matched_canonicals TEXT[];
    v_matched_tokens TEXT[];
    v_canon_count INT;
BEGIN
    -- Normalizar texto consolidado (título es primario, descripción apoya)
    v_norm := public.fn_normalize_activity_text(
        pg_catalog.coalesce(p_titulo, '') || ' ' || pg_catalog.coalesce(p_descripcion, '')
    );

    IF v_norm = '' THEN
        RETURN QUERY SELECT
            NULL::TEXT,
            '{}'::TEXT[],
            false,
            'no_activity_detected'::TEXT;
        RETURN;
    END IF;

    -- Buscar aliases fuertes que coincidan con límites de palabras en el texto normalizado
    SELECT
        pg_catalog.array_agg(DISTINCT a.canonical_key),
        pg_catalog.array_agg(DISTINCT a.alias_normalized)
    INTO v_matched_canonicals, v_matched_tokens
    FROM public.activity_aliases a
    WHERE a.active = true
      AND a.strength = 'strong'
      AND (' ' || v_norm || ' ') LIKE ('% ' || a.alias_normalized || ' %');

    v_canon_count := pg_catalog.coalesce(pg_catalog.cardinality(v_matched_canonicals), 0);

    IF v_canon_count = 1 THEN
        RETURN QUERY SELECT
            v_matched_canonicals[1],
            pg_catalog.coalesce(v_matched_tokens, '{}'::TEXT[]),
            true,
            NULL::TEXT;
    ELSIF v_canon_count >= 2 THEN
        RETURN QUERY SELECT
            NULL::TEXT,
            pg_catalog.coalesce(v_matched_tokens, '{}'::TEXT[]),
            false,
            'multiple_activities'::TEXT;
    ELSE
        RETURN QUERY SELECT
            NULL::TEXT,
            '{}'::TEXT[],
            false,
            'no_activity_detected'::TEXT;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_classify_activity(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_classify_activity(TEXT, TEXT) TO postgres, service_role;


-- ============================================================
-- 5. COLUMNAS Y TRIGGERS DE PERSISTENCIA EN INTENCIONES Y ENCUENTROS
-- ============================================================

-- Columnas en public.intenciones
ALTER TABLE public.intenciones
    ADD COLUMN IF NOT EXISTS activity_canonical TEXT REFERENCES public.activity_categories(canonical_key) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS activity_strong_tokens TEXT[] DEFAULT '{}'::TEXT[],
    ADD COLUMN IF NOT EXISTS activity_matching_eligible BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS match_ineligible_reason TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS activity_classified_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_intenciones_activity_canonical
    ON public.intenciones (activity_canonical)
    WHERE activity_matching_eligible = true AND estado = 'activa';

-- Columnas en public.encuentros
ALTER TABLE public.encuentros
    ADD COLUMN IF NOT EXISTS open_activity_canonical TEXT REFERENCES public.activity_categories(canonical_key) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS open_activity_strong_tokens TEXT[] DEFAULT '{}'::TEXT[],
    ADD COLUMN IF NOT EXISTS open_activity_matching_eligible BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS open_match_ineligible_reason TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS open_activity_classified_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_encuentros_open_activity_canonical
    ON public.encuentros (open_activity_canonical)
    WHERE open_activity_matching_eligible = true AND is_open = true AND estado = 'activo';

-- Trigger para public.intenciones
CREATE OR REPLACE FUNCTION public.fn_trg_intenciones_classify_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_res RECORD;
BEGIN
    SELECT * INTO v_res FROM public.fn_classify_activity(NEW.titulo, NEW.descripcion);
    NEW.activity_canonical := v_res.activity_canonical;
    NEW.activity_strong_tokens := v_res.activity_strong_tokens;
    NEW.activity_matching_eligible := v_res.activity_matching_eligible;
    NEW.match_ineligible_reason := v_res.match_ineligible_reason;
    NEW.activity_classified_at := pg_catalog.timezone('utc', pg_catalog.now());
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_intenciones_classify_activity ON public.intenciones;
CREATE TRIGGER trg_intenciones_classify_activity
    BEFORE INSERT OR UPDATE OF titulo, descripcion ON public.intenciones
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_intenciones_classify_activity();

-- Trigger para public.encuentros
CREATE OR REPLACE FUNCTION public.fn_trg_encuentros_classify_open_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_res RECORD;
BEGIN
    SELECT * INTO v_res FROM public.fn_classify_activity(NEW.titulo, NEW.open_description);
    NEW.open_activity_canonical := v_res.activity_canonical;
    NEW.open_activity_strong_tokens := v_res.activity_strong_tokens;
    NEW.open_activity_matching_eligible := v_res.activity_matching_eligible;
    NEW.open_match_ineligible_reason := v_res.match_ineligible_reason;
    NEW.open_activity_classified_at := pg_catalog.timezone('utc', pg_catalog.now());
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_encuentros_classify_open_activity ON public.encuentros;
CREATE TRIGGER trg_encuentros_classify_open_activity
    BEFORE INSERT OR UPDATE OF titulo, open_description ON public.encuentros
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_encuentros_classify_open_activity();

-- Backfill idempotente de filas existentes
UPDATE public.intenciones
SET updated_at = updated_at
WHERE activity_classified_at IS NULL;

UPDATE public.encuentros
SET creado_en = creado_en
WHERE open_activity_classified_at IS NULL;


-- ============================================================
-- 6. TABLA DURABLE DE DEDUPLICACIÓN: public.match_discoveries
-- Unicidad estricta (user_id, encounter_id) a perpetuidad
-- ============================================================

CREATE TABLE IF NOT EXISTS public.match_discoveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    encounter_id UUID NOT NULL REFERENCES public.encuentros(id) ON DELETE CASCADE,
    primary_source TEXT NOT NULL CHECK (primary_source IN ('intention', 'manual_alert')),
    sources JSONB NOT NULL DEFAULT '[]'::jsonb,
    activity_canonical TEXT REFERENCES public.activity_categories(canonical_key) ON DELETE SET NULL,
    matched_intention_id UUID REFERENCES public.intenciones(id) ON DELETE SET NULL,
    matched_subscription_id UUID REFERENCES public.match_alert_subscriptions(id) ON DELETE SET NULL,
    match_reason TEXT NOT NULL,
    first_matched_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),
    last_matched_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.timezone('utc', pg_catalog.now()),

    CONSTRAINT uq_match_discoveries_user_encounter UNIQUE (user_id, encounter_id)
);

CREATE INDEX IF NOT EXISTS idx_match_discoveries_user
    ON public.match_discoveries (user_id, encounter_id);

ALTER TABLE public.match_discoveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.match_discoveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.match_discoveries TO postgres, service_role;


-- ============================================================
-- 7. PIPELINE ÚNICO: evaluar_matching_encuentro_abierto
-- Inserta en match_discoveries -> Emite match.detected.v1
-- ============================================================

CREATE OR REPLACE FUNCTION public.evaluar_matching_encuentro_abierto(
    p_encuentro_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_encuentro RECORD;
    v_candidate RECORD;
    v_matched_count INT := 0;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_today DATE := (v_now AT TIME ZONE 'UTC')::date;
    v_dedup_key TEXT;
    v_payload JSONB;
    v_expires_at TIMESTAMPTZ;
    v_inserted_discovery UUID;
    v_notification_title TEXT;
    v_notification_body TEXT;
BEGIN
    IF p_encuentro_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_encuentro_id');
    END IF;

    -- Obtener encuentro abierto activo, aprobado por moderación y vigente
    SELECT 
        e.id,
        e.titulo,
        e.descripcion,
        e.fecha,
        e.hora,
        e.modalidad,
        e.locality_id,
        e.host_id,
        e.open_activity_canonical,
        e.open_activity_matching_eligible,
        COALESCE(e.open_public_zone, l.nombre, 'Zona aproximada') AS zone_text
    INTO v_encuentro
    FROM public.encuentros e
    LEFT JOIN public.localidades l ON e.locality_id = l.id
    WHERE e.id = p_encuentro_id
      AND e.is_open = true
      AND e.estado = 'activo'
      AND (e.moderation_status IS NULL OR e.moderation_status = 'approved')
      AND (e.fecha IS NULL OR e.fecha >= v_today);

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', true, 'matches_count', 0, 'reason', 'encuentro_not_eligible');
    END IF;

    -- Expiración del match: día posterior al encuentro o 30 días
    IF v_encuentro.fecha IS NOT NULL THEN
        v_expires_at := (v_encuentro.fecha + INTERVAL '1 day')::timestamptz;
    ELSE
        v_expires_at := v_now + INTERVAL '30 days';
    END IF;

    -- Recorrer candidatos unificados de Avisame y Mis ganas con deduplicación por user_id
    FOR v_candidate IN
        WITH unified_candidates AS (
            -- Fuente 1: Alertas manuales Avisame
            SELECT
                s.user_id,
                'manual_alert' AS source_type,
                NULL::uuid AS matched_intention_id,
                s.id AS matched_subscription_id,
                v_encuentro.open_activity_canonical AS activity_canonical,
                'manual_alert_filter_match' AS match_reason,
                s.created_at
            FROM public.match_alert_subscriptions s
            WHERE s.status = 'active'
              AND (s.expires_at IS NULL OR s.expires_at > v_now)
              AND (v_encuentro.host_id IS NULL OR s.user_id <> v_encuentro.host_id)
              AND NOT EXISTS (
                  SELECT 1 FROM public.bloqueos_usuario b
                  WHERE (b.blocker_id = s.user_id AND b.blocked_id = v_encuentro.host_id)
                     OR (b.blocker_id = v_encuentro.host_id AND b.blocked_id = s.user_id)
              )
              AND (s.modalidad IS NULL OR s.modalidad = 'indistinto' OR s.modalidad = v_encuentro.modalidad)
              AND (v_encuentro.modalidad = 'virtual' OR s.locality_id IS NULL OR s.locality_id = v_encuentro.locality_id)
              AND (s.fecha_desde IS NULL OR v_encuentro.fecha IS NULL OR v_encuentro.fecha >= s.fecha_desde)
              AND (s.fecha_hasta IS NULL OR v_encuentro.fecha IS NULL OR v_encuentro.fecha <= s.fecha_hasta)
              AND (s.hora_desde IS NULL OR v_encuentro.hora IS NULL OR v_encuentro.hora >= s.hora_desde)
              AND (s.hora_hasta IS NULL OR v_encuentro.hora IS NULL OR v_encuentro.hora <= s.hora_hasta)

            UNION ALL

            -- Fuente 2: Mis ganas (Intenciones activas elegibles)
            SELECT
                i.user_id,
                'intention' AS source_type,
                i.id AS matched_intention_id,
                NULL::uuid AS matched_subscription_id,
                i.activity_canonical,
                'intention_canonical_exact_match' AS match_reason,
                i.created_at
            FROM public.intenciones i
            WHERE i.estado = 'activa'
              AND i.activity_matching_eligible = true
              AND v_encuentro.open_activity_matching_eligible = true
              AND i.activity_canonical = v_encuentro.open_activity_canonical
              AND (v_encuentro.host_id IS NULL OR i.user_id <> v_encuentro.host_id)
              AND NOT EXISTS (
                  SELECT 1 FROM public.bloqueos_usuario b
                  WHERE (b.blocker_id = i.user_id AND b.blocked_id = v_encuentro.host_id)
                     OR (b.blocker_id = v_encuentro.host_id AND b.blocked_id = i.user_id)
              )
              AND (i.modalidad IS NULL OR i.modalidad = 'indistinto' OR i.modalidad = v_encuentro.modalidad)
              AND (v_encuentro.modalidad = 'virtual' OR i.locality_id IS NULL OR i.locality_id = v_encuentro.locality_id)
              AND (i.fecha_desde IS NULL OR v_encuentro.fecha IS NULL OR v_encuentro.fecha >= i.fecha_desde)
              AND (i.fecha_hasta IS NULL OR v_encuentro.fecha IS NULL OR v_encuentro.fecha <= i.fecha_hasta)
              AND (i.fecha_hasta IS NULL OR i.fecha_hasta >= v_today)
        )
        SELECT DISTINCT ON (c.user_id)
            c.user_id,
            c.source_type,
            c.matched_intention_id,
            c.matched_subscription_id,
            c.activity_canonical,
            c.match_reason
        FROM unified_candidates c
        ORDER BY c.user_id, (CASE WHEN c.source_type = 'intention' THEN 1 ELSE 2 END) ASC
    LOOP
        v_inserted_discovery := NULL;

        -- 1. Inserción atómica en tabla durable match_discoveries
        INSERT INTO public.match_discoveries (
            user_id,
            encounter_id,
            primary_source,
            sources,
            activity_canonical,
            matched_intention_id,
            matched_subscription_id,
            match_reason
        ) VALUES (
            v_candidate.user_id,
            v_encuentro.id,
            v_candidate.source_type,
            pg_catalog.jsonb_build_array(v_candidate.source_type),
            v_candidate.activity_canonical,
            v_candidate.matched_intention_id,
            v_candidate.matched_subscription_id,
            v_candidate.match_reason
        )
        ON CONFLICT (user_id, encounter_id) DO NOTHING
        RETURNING id INTO v_inserted_discovery;

        -- 2. Si es un descubrimiento nuevo, emitir evento canónico al Transactional Outbox
        IF v_inserted_discovery IS NOT NULL THEN
            v_dedup_key := pg_catalog.format('match:%s:%s:v1', v_candidate.user_id, v_encuentro.id);

            IF v_candidate.source_type = 'intention' THEN
                v_notification_title := 'Encontramos algo para vos';
                v_notification_body := 'Hay un encuentro que coincide con algo que tenés ganas de hacer.';
            ELSE
                v_notification_title := 'Nuevo encuentro compatible';
                v_notification_body := 'Se publicó un encuentro que coincide con tu alerta: ' || v_encuentro.titulo;
            END IF;

            v_payload := pg_catalog.jsonb_build_object(
                'discovery_id', v_inserted_discovery,
                'recipient_user_id', v_candidate.user_id,
                'encounter_id', v_encuentro.id,
                'encounter_title', v_encuentro.titulo,
                'primary_source', v_candidate.source_type,
                'activity_canonical', v_candidate.activity_canonical,
                'matched_intention_id', v_candidate.matched_intention_id,
                'matched_subscription_id', v_candidate.matched_subscription_id,
                'title', v_notification_title,
                'body', v_notification_body,
                'deep_link', pg_catalog.format('/?open_encounter=%s', v_encuentro.id),
                'dedup_key', v_dedup_key,
                'expires_at', v_expires_at
            );

            INSERT INTO public.domain_events_outbox (
                event_type,
                event_version,
                aggregate_type,
                aggregate_id,
                actor_user_id,
                payload,
                dedup_key,
                status
            ) VALUES (
                'match.detected.v1',
                1,
                'encounter',
                v_encuentro.id,
                v_encuentro.host_id,
                v_payload,
                v_dedup_key,
                'pending'
            )
            ON CONFLICT (dedup_key) DO NOTHING;

            v_matched_count := v_matched_count + 1;
        END IF;
    END LOOP;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'encuentro_id', v_encuentro.id,
        'matches_count', v_matched_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public.evaluar_matching_encuentro_abierto(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.evaluar_matching_encuentro_abierto(UUID) TO authenticated, service_role;


-- ============================================================
-- 8. MATCHING INMEDIATO: evaluar_matching_intencion_activa
-- Evalúa encuentros abiertos existentes al crear o reactivar intención
-- ============================================================

CREATE OR REPLACE FUNCTION public.evaluar_matching_intencion_activa(
    p_intencion_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_intencion RECORD;
    v_encuentro RECORD;
    v_now TIMESTAMPTZ := pg_catalog.timezone('utc', pg_catalog.now());
    v_today DATE := (v_now AT TIME ZONE 'UTC')::date;
    v_inserted_discovery UUID;
    v_dedup_key TEXT;
    v_payload JSONB;
    v_expires_at TIMESTAMPTZ;
    v_matched_count INT := 0;
    v_matched_encounter_ids UUID[] := '{}'::UUID[];
BEGIN
    IF p_intencion_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_intencion_id');
    END IF;

    SELECT 
        i.id,
        i.user_id,
        i.estado,
        i.modalidad,
        i.locality_id,
        i.fecha_desde,
        i.fecha_hasta,
        i.activity_canonical,
        i.activity_matching_eligible
    INTO v_intencion
    FROM public.intenciones i
    WHERE i.id = p_intencion_id
      AND i.estado = 'activa'
      AND i.activity_matching_eligible = true
      AND (i.fecha_hasta IS NULL OR i.fecha_hasta >= v_today);

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object(
            'ok', true,
            'matches_found_count', 0,
            'matched_encounter_ids', '[]'::jsonb,
            'reason', 'intencion_not_eligible'
        );
    END IF;

    -- Buscar encuentros abiertos vigentes compatibles
    FOR v_encuentro IN
        SELECT
            e.id,
            e.titulo,
            e.fecha,
            e.host_id
        FROM public.encuentros e
        WHERE e.is_open = true
          AND e.estado = 'activo'
          AND (e.moderation_status IS NULL OR e.moderation_status = 'approved')
          AND e.open_activity_matching_eligible = true
          AND e.open_activity_canonical = v_intencion.activity_canonical
          AND (e.host_id IS NULL OR e.host_id <> v_intencion.user_id)
          AND (e.fecha IS NULL OR e.fecha >= v_today)
          AND (v_intencion.modalidad IS NULL OR v_intencion.modalidad = 'indistinto' OR v_intencion.modalidad = e.modalidad)
          AND (e.modalidad = 'virtual' OR v_intencion.locality_id IS NULL OR v_intencion.locality_id = e.locality_id)
          AND (v_intencion.fecha_desde IS NULL OR e.fecha IS NULL OR e.fecha >= v_intencion.fecha_desde)
          AND (v_intencion.fecha_hasta IS NULL OR e.fecha IS NULL OR e.fecha <= v_intencion.fecha_hasta)
          AND NOT EXISTS (
              SELECT 1 FROM public.bloqueos_usuario b
              WHERE (b.blocker_id = v_intencion.user_id AND b.blocked_id = e.host_id)
                 OR (b.blocker_id = e.host_id AND b.blocked_id = v_intencion.user_id)
          )
        ORDER BY e.opened_at DESC NULLS LAST
    LOOP
        v_inserted_discovery := NULL;

        -- 1. Inserción atómica en match_discoveries
        INSERT INTO public.match_discoveries (
            user_id,
            encounter_id,
            primary_source,
            sources,
            activity_canonical,
            matched_intention_id,
            matched_subscription_id,
            match_reason
        ) VALUES (
            v_intencion.user_id,
            v_encuentro.id,
            'intention',
            pg_catalog.jsonb_build_array('intention'),
            v_intencion.activity_canonical,
            v_intencion.id,
            NULL,
            'intention_canonical_exact_match'
        )
        ON CONFLICT (user_id, encounter_id) DO NOTHING
        RETURNING id INTO v_inserted_discovery;

        -- 2. Si es nuevo, emitir al transactional outbox
        IF v_inserted_discovery IS NOT NULL THEN
            v_dedup_key := pg_catalog.format('match:%s:%s:v1', v_intencion.user_id, v_encuentro.id);

            IF v_encuentro.fecha IS NOT NULL THEN
                v_expires_at := (v_encuentro.fecha + INTERVAL '1 day')::timestamptz;
            ELSE
                v_expires_at := v_now + INTERVAL '30 days';
            END IF;

            v_payload := pg_catalog.jsonb_build_object(
                'discovery_id', v_inserted_discovery,
                'recipient_user_id', v_intencion.user_id,
                'encounter_id', v_encuentro.id,
                'encounter_title', v_encuentro.titulo,
                'primary_source', 'intention',
                'activity_canonical', v_intencion.activity_canonical,
                'matched_intention_id', v_intencion.id,
                'matched_subscription_id', NULL,
                'title', 'Encontramos algo para vos',
                'body', 'Hay un encuentro que coincide con algo que tenés ganas de hacer.',
                'deep_link', pg_catalog.format('/?open_encounter=%s', v_encuentro.id),
                'dedup_key', v_dedup_key,
                'expires_at', v_expires_at
            );

            INSERT INTO public.domain_events_outbox (
                event_type,
                event_version,
                aggregate_type,
                aggregate_id,
                actor_user_id,
                payload,
                dedup_key,
                status
            ) VALUES (
                'match.detected.v1',
                1,
                'encounter',
                v_encuentro.id,
                v_encuentro.host_id,
                v_payload,
                v_dedup_key,
                'pending'
            )
            ON CONFLICT (dedup_key) DO NOTHING;

            v_matched_count := v_matched_count + 1;
            v_matched_encounter_ids := pg_catalog.array_append(v_matched_encounter_ids, v_encuentro.id);
        END IF;
    END LOOP;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'intencion_id', v_intencion.id,
        'matches_found_count', v_matched_count,
        'matched_encounter_ids', pg_catalog.to_jsonb(v_matched_encounter_ids)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.evaluar_matching_intencion_activa(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.evaluar_matching_intencion_activa(UUID) TO authenticated, service_role;


-- ============================================================
-- 9. ACTUALIZACIÓN DE RPC: crear_intencion_segura
-- Retorna matches_found_count y matched_encounter_ids para feedback inmediato
-- ============================================================

CREATE OR REPLACE FUNCTION public.crear_intencion_segura(
    p_titulo TEXT,
    p_descripcion TEXT DEFAULT NULL,
    p_temporalidad_texto TEXT DEFAULT NULL,
    p_fecha_desde DATE DEFAULT NULL,
    p_fecha_hasta DATE DEFAULT NULL,
    p_modalidad TEXT DEFAULT 'presencial',
    p_locality_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_titulo_clean TEXT;
    v_modalidad_clean TEXT;
    v_new_id UUID;
    v_eval_res JSONB;
    v_matches_count INT := 0;
    v_matched_ids JSONB := '[]'::jsonb;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    v_titulo_clean := trim(COALESCE(p_titulo, ''));
    IF v_titulo_clean = '' OR length(p_titulo) > 120 THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_title');
    END IF;

    v_modalidad_clean := trim(COALESCE(p_modalidad, 'presencial'));
    IF v_modalidad_clean NOT IN ('presencial', 'virtual', 'indistinto') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_modality');
    END IF;

    IF p_fecha_desde IS NOT NULL AND p_fecha_hasta IS NOT NULL AND p_fecha_desde > p_fecha_hasta THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_date_range');
    END IF;

    IF p_locality_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.localidades WHERE id = p_locality_id AND activo = true) THEN
            RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_locality');
        END IF;
    END IF;

    INSERT INTO public.intenciones (
        user_id,
        titulo,
        descripcion,
        temporalidad_texto,
        fecha_desde,
        fecha_hasta,
        modalidad,
        locality_id,
        estado
    ) VALUES (
        v_user_id,
        v_titulo_clean,
        NULLIF(trim(COALESCE(p_descripcion, '')), ''),
        NULLIF(trim(COALESCE(p_temporalidad_texto, '')), ''),
        p_fecha_desde,
        p_fecha_hasta,
        v_modalidad_clean,
        p_locality_id,
        'activa'
    )
    RETURNING id INTO v_new_id;

    -- Matching inmediato contra encuentros abiertos existentes
    v_eval_res := public.evaluar_matching_intencion_activa(v_new_id);
    IF (v_eval_res ->> 'ok')::boolean = true THEN
        v_matches_count := COALESCE((v_eval_res ->> 'matches_found_count')::int, 0);
        v_matched_ids := COALESCE(v_eval_res -> 'matched_encounter_ids', '[]'::jsonb);
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'id', v_new_id,
        'matches_found_count', v_matches_count,
        'matched_encounter_ids', v_matched_ids
    );
END;
$$;

REVOKE ALL ON FUNCTION public.crear_intencion_segura(TEXT, TEXT, TEXT, DATE, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crear_intencion_segura(TEXT, TEXT, TEXT, DATE, DATE, TEXT, TEXT) TO authenticated;


-- ============================================================
-- 10. ACTUALIZACIÓN DE RPC: cambiar_estado_intencion_segura
-- Reactivación evalúa encuentros existentes de forma automática
-- ============================================================

CREATE OR REPLACE FUNCTION public.cambiar_estado_intencion_segura(
    p_id UUID,
    p_nuevo_estado TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_anon BOOLEAN;
    v_estado_actual TEXT;
    v_eval_res JSONB;
    v_matches_count INT := 0;
    v_matched_ids JSONB := '[]'::jsonb;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'authentication_required');
    END IF;

    v_is_anon := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
    IF v_is_anon THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'permanent_account_required');
    END IF;

    IF p_id IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_id');
    END IF;

    IF p_nuevo_estado = 'convertida' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'manual_conversion_not_allowed');
    END IF;

    IF p_nuevo_estado NOT IN ('activa', 'pausada', 'cerrada') THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_state');
    END IF;

    SELECT estado INTO v_estado_actual
    FROM public.intenciones
    WHERE id = p_id AND user_id = v_user_id;

    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intencion_not_found');
    END IF;

    IF v_estado_actual = 'cerrada' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intencion_already_closed');
    END IF;

    IF v_estado_actual = 'convertida' THEN
        RETURN pg_catalog.jsonb_build_object('ok', false, 'error', 'intencion_already_converted');
    END IF;

    IF v_estado_actual = p_nuevo_estado THEN
        RETURN pg_catalog.jsonb_build_object('ok', true, 'id', p_id, 'estado', p_nuevo_estado);
    END IF;

    UPDATE public.intenciones
    SET estado = p_nuevo_estado,
        updated_at = pg_catalog.timezone('utc', pg_catalog.now())
    WHERE id = p_id AND user_id = v_user_id;

    -- Si se reactiva a 'activa', evaluar encuentros existentes
    IF p_nuevo_estado = 'activa' THEN
        v_eval_res := public.evaluar_matching_intencion_activa(p_id);
        IF (v_eval_res ->> 'ok')::boolean = true THEN
            v_matches_count := COALESCE((v_eval_res ->> 'matches_found_count')::int, 0);
            v_matched_ids := COALESCE(v_eval_res -> 'matched_encounter_ids', '[]'::jsonb);
        END IF;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'ok', true,
        'id', p_id,
        'estado', p_nuevo_estado,
        'matches_found_count', v_matches_count,
        'matched_encounter_ids', v_matched_ids
    );
END;
$$;

REVOKE ALL ON FUNCTION public.cambiar_estado_intencion_segura(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cambiar_estado_intencion_segura(UUID, TEXT) TO authenticated;

COMMIT;
