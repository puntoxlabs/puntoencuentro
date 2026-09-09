import type { EncounterDraft } from '@/lib/encounterDraft';
import { validateEncounterDate } from '@/lib/formatDate';
import { isValidVirtualLink } from '@/lib/draftMerger';

export interface FieldQuestion {
  field: 'title' | 'date' | 'time' | 'modality' | 'locationText' | 'virtualLink' | 'coordination_handoff' | 'theme' | 'template';
  question: string;
  helperText?: string;
  quickOptions?: { label: string; value: string }[];
  type: 'text' | 'choice' | 'date' | 'time' | 'handoff';
}

export interface DraftEvaluation {
  isComplete: boolean;
  missingFields: string[];
  nextQuestion: FieldQuestion | null;
  validationError: string | null;
}

/**
 * Evaluates the completeness of an EncounterDraft and selects the next deterministic question.
 *
 * Deterministic Priority:
 * 1. Title
 * 2. Date
 * 3. Time
 * 4. Modality (NO default)
 * 5. Location (if presencial) / Virtual Link (if virtual)
 * 6. Final validation (date/time in future)
 */
export function evaluateDraft(
  draft: EncounterDraft,
  coordinationDetected: boolean = false,
  pendingAmbiguity?: { field: string; reason: string; options?: string[] }
): DraftEvaluation {
  // If coordination was detected by the interpreter, immediately trigger handoff question
  if (coordinationDetected || draft.dateMode === 'coordination') {
    return {
      isComplete: false,
      missingFields: ['dateMode'],
      nextQuestion: {
        field: 'coordination_handoff',
        question: 'Parece que querés coordinar fechas con tus invitados. ¿Preferís continuar en la herramienta de coordinación de fechas?',
        helperText: 'Crear con IA Beta está preparado para encuentros con fecha fija.',
        type: 'handoff',
        quickOptions: [
          { label: 'Ir a Coordinar fecha', value: 'handoff_coordination' },
          { label: 'Elegir una fecha fija acá', value: 'keep_fixed' },
        ],
      },
      validationError: null,
    };
  }

  // If there is an unresolved ambiguity (e.g. from date/time resolution), prioritize asking it
  if (pendingAmbiguity) {
    if (pendingAmbiguity.field === 'date') {
      return {
        isComplete: false,
        missingFields: ['date'],
        nextQuestion: {
          field: 'date',
          question: pendingAmbiguity.reason,
          type: pendingAmbiguity.options ? 'choice' : 'date',
          quickOptions: pendingAmbiguity.options?.map((opt) => ({
            label: opt,
            value: opt,
          })),
        },
        validationError: null,
      };
    }
    if (pendingAmbiguity.field === 'time') {
      return {
        isComplete: false,
        missingFields: ['time'],
        nextQuestion: {
          field: 'time',
          question: pendingAmbiguity.reason,
          type: 'time',
          quickOptions: [
            { label: '20:00', value: '20:00' },
            { label: '21:00', value: '21:00' },
            { label: '22:00', value: '22:00' },
          ],
        },
        validationError: null,
      };
    }
  }

  const missingFields: string[] = [];

  // 1. Title
  if (!draft.title || !draft.title.trim()) {
    missingFields.push('title');
    return {
      isComplete: false,
      missingFields,
      nextQuestion: {
        field: 'title',
        question: '¿Cómo se llama el encuentro?',
        helperText: 'Ej: Cena con amigos, Cumpleaños de Sofi, Reunión de trabajo',
        type: 'text',
      },
      validationError: null,
    };
  }

  // 2. Date
  if (!draft.date) {
    missingFields.push('date');
    return {
      isComplete: false,
      missingFields,
      nextQuestion: {
        field: 'date',
        question: '¿Qué día sería?',
        helperText: 'Podés decir "este viernes", "mañana", o indicar una fecha',
        type: 'text',
      },
      validationError: null,
    };
  }

  // 3. Time
  if (!draft.time) {
    missingFields.push('time');
    return {
      isComplete: false,
      missingFields,
      nextQuestion: {
        field: 'time',
        question: '¿A qué hora?',
        helperText: 'Ej: "a las 21", "19:30", "a las 9 de la noche"',
        type: 'text',
      },
      validationError: null,
    };
  }

  // 4. Modality (Strict: NO SILENT DEFAULT)
  if (!draft.modality) {
    missingFields.push('modality');
    return {
      isComplete: false,
      missingFields,
      nextQuestion: {
        field: 'modality',
        question: '¿Va a ser presencial o virtual?',
        type: 'choice',
        quickOptions: [
          { label: '🏠 Presencial', value: 'presencial' },
          { label: '💻 Virtual', value: 'virtual' },
        ],
      },
      validationError: null,
    };
  }

  // 5. Location or Virtual Link
  if (draft.modality === 'presencial' && (!draft.locationText || !draft.locationText.trim())) {
    missingFields.push('locationText');
    return {
      isComplete: false,
      missingFields,
      nextQuestion: {
        field: 'locationText',
        question: '¿Dónde va a ser?',
        helperText: 'Ej: "En casa", "Bar Antares", "Av. Corrientes 1234"',
        type: 'text',
      },
      validationError: null,
    };
  }

  if (draft.modality === 'virtual' && (!draft.virtualLink || !draft.virtualLink.trim() || !isValidVirtualLink(draft.virtualLink))) {
    missingFields.push('virtualLink');
    return {
      isComplete: false,
      missingFields,
      nextQuestion: {
        field: 'virtualLink',
        question: '¿Cuál es el enlace de la videollamada?',
        helperText: 'Pegá el link de Google Meet, Zoom, Teams, etc.',
        type: 'text',
      },
      validationError: draft.virtualLink && !isValidVirtualLink(draft.virtualLink)
        ? 'El enlace no parece válido. Pegá el enlace completo de la videollamada.'
        : null,
    };
  }

  // 6. Validation of date and time
  const dateError = validateEncounterDate(draft.date, draft.time);
  if (dateError) {
    return {
      isComplete: false,
      missingFields: ['date', 'time'],
      nextQuestion: {
        field: 'date',
        question: `La fecha y hora no son válidas (${dateError.toLowerCase()}). ¿Qué día y horario preferís?`,
        type: 'text',
      },
      validationError: dateError,
    };
  }

  // All required fields present and valid!
  return {
    isComplete: true,
    missingFields: [],
    nextQuestion: null,
    validationError: null,
  };
}
