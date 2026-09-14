export interface ModalityInferenceResult {
  modality: 'presencial' | 'virtual' | null;
  confidence: 'explicit' | 'inferred_high' | 'inferred_low' | null;
  source: 'explicit_modality' | 'virtual_signal' | 'physical_location' | 'semantic_activity' | 'ambiguous';
}

export interface ModalityContext {
  title?: string | null;
  locationText?: string | null;
  virtualLink?: string | null;
  userPrompt?: string | null;
}

const STRONGLY_PHYSICAL_REGEX = /\b(?:cena|cenar|almuerzo|almorzar|desayuno|desayunar|merienda|merendar|asado|asados|picada|pizzas|pizzada|caf[eé]|cumpleaños|cumple|fiesta|festejo|casamiento|boda|despedida|f[uú]tbol|futbol|p[aá]del|padel|tenis|b[aá]squet|basquet|running|caminata|gimnasio|trekking|partido|torneo|entrenamiento|bici|pileta|nataci[oó]n|recital|concierto|show|cine|teatro|festival|paseo|picnic|parque|plaza|camping|salida|birras|tragos|bar|restaurante)\b/i;

const EXPLICIT_VIRTUAL_REGEX = /\b(?:virtual|online|remot[oa]|videollamada|streaming|webinar|zoom|meet|google\s+meet|teams|skype|discord)\b/i;

const EXPLICIT_PRESENCIAL_REGEX = /\b(?:presencial|en\s+persona|f[ií]sic[oa])\b/i;

const PHYSICAL_LOCATION_CUE_REGEX = /\ben\s+(?:casa|lo\s+de|el\s+bar|el\s+club|la\s+oficina|el\s+parque|un\s+bar|el\s+resto|un\s+restaurante|mi\s+casa|tu\s+casa)\b/i;

/**
 * Centrally infers encounter modality using a strict hierarchy of signals:
 * 1. Explicit user modality keywords ("virtual" / "presencial")
 * 2. Explicit virtual signal (virtualLink or videocall platform in text)
 * 3. Explicit physical location (locationText or physical cue like "en casa")
 * 4. Semantic activity inference with high confidence (e.g. "Cena", "Fútbol", "Asado")
 * 5. Ambiguous activities ("Reunión", "Clase", "Charla") -> null (ask user)
 */
export function inferModalityFromContext(context: ModalityContext): ModalityInferenceResult {
  const prompt = (context.userPrompt || '').trim();
  const title = (context.title || '').trim();
  const locationText = (context.locationText || '').trim();
  const virtualLink = (context.virtualLink || '').trim();

  // 1. Explicit modality keywords
  if (EXPLICIT_VIRTUAL_REGEX.test(prompt) || EXPLICIT_VIRTUAL_REGEX.test(title)) {
    return {
      modality: 'virtual',
      confidence: 'explicit',
      source: 'explicit_modality',
    };
  }

  if (EXPLICIT_PRESENCIAL_REGEX.test(prompt) || EXPLICIT_PRESENCIAL_REGEX.test(title)) {
    return {
      modality: 'presencial',
      confidence: 'explicit',
      source: 'explicit_modality',
    };
  }

  // 2. Explicit virtual signal
  if (virtualLink.length > 0) {
    return {
      modality: 'virtual',
      confidence: 'explicit',
      source: 'virtual_signal',
    };
  }

  // 3. Explicit physical location
  if (locationText.length > 0 || PHYSICAL_LOCATION_CUE_REGEX.test(prompt)) {
    return {
      modality: 'presencial',
      confidence: 'inferred_high',
      source: 'physical_location',
    };
  }

  // 4. Semantic activity inference (Strongly physical activities)
  if (STRONGLY_PHYSICAL_REGEX.test(title) || STRONGLY_PHYSICAL_REGEX.test(prompt)) {
    return {
      modality: 'presencial',
      confidence: 'inferred_high',
      source: 'semantic_activity',
    };
  }

  // 5. Ambiguous or unknown
  return {
    modality: null,
    confidence: null,
    source: 'ambiguous',
  };
}
