import type { EncounterDraft } from '@/lib/encounterDraft';
import { hasMeaningfulDraftData } from '@/lib/encounterDraft';
import { validateEncounterDate } from '@/lib/formatDate';
import { isValidVirtualLink } from '@/lib/draftMerger';

export { hasMeaningfulDraftData };

export interface FieldQuestion {
  field:
    | 'title'
    | 'date'
    | 'time'
    | 'modality'
    | 'locationText'
    | 'virtualLink'
    | 'coordination_handoff'
    | 'coordination_confirm'
    | 'coordination_options'
    | 'responseDeadline'
    | 'theme'
    | 'template';
  question: string;
  helperText?: string;
  quickOptions?: { label: string; value: string }[];
  type: 'text' | 'choice' | 'date' | 'time' | 'handoff' | 'coordination_card';
  dateOptions?: Array<{ date: string; time: string }>;
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
 * Deterministic Priority for Fixed:
 * 1. Title
 * 2. Date
 * 3. Time
 * 4. Modality (NO default)
 * 5. Location (if presencial) / Virtual Link (if virtual)
 * 6. Final validation (date/time in future)
 *
 * Deterministic Priority for Coordination:
 * 1. Title
 * 2. Date Options (minimum 2, maximum 3, future timestamps)
 * 3. Modality (NO default)
 * 4. Location (if presencial) / Virtual Link (if virtual)
 * 5. Response deadline validation (must be < earliest option)
 */
export function evaluateDraft(
  draft: EncounterDraft,
  coordinationDetected: boolean = false,
  pendingAmbiguity?: { field: string; reason: string; options?: string[] },
  coordinationPendingConfirm: boolean = false
): DraftEvaluation {
  // 0a. If there is a pending coordination confirmation card for candidate options:
  if ((coordinationPendingConfirm || draft.coordinationPendingConfirm) && draft.dateOptions && draft.dateOptions.length >= 2) {
    const allSameDate = draft.dateOptions.every((opt) => opt.date === draft.dateOptions![0].date);
    return {
      isComplete: false,
      missingFields: ['coordination_confirm'],
      nextQuestion: {
        field: 'coordination_confirm',
        question: allSameDate
          ? '¿Querés que los invitados elijan entre estos horarios?'
          : '¿Querés que los invitados elijan entre estas fechas?',
        type: 'coordination_card',
        dateOptions: draft.dateOptions,
        quickOptions: [
          { label: 'Sí, continuar', value: 'confirm_coordination' },
          { label: allSameDate ? 'Elegir un horario fijo' : 'Elegir fecha fija', value: 'keep_fixed' },
        ],
      },
      validationError: null,
    };
  }

  // 0a2. Pending time alternatives without a date (e.g. "Desayuno a las 10 o a las 11:00 en casa")
  if (draft.pendingTimeOptions && draft.pendingTimeOptions.length >= 2 && (!draft.dateOptions || draft.dateOptions.length < 2)) {
    if (draft.pendingTimeOptions.length > 3 || draft.temporalAlternativesOverflow) {
      return {
        isComplete: false,
        missingFields: ['pendingTimeOptions'],
        nextQuestion: {
          field: 'coordination_options',
          question: 'Por ahora podés incluir hasta 3 opciones para coordinar. ¿Cuáles 3 preferís dejar?',
          type: 'text',
        },
        validationError: 'maximum_three_options',
      };
    }

    if (!draft.title || !draft.title.trim()) {
      return {
        isComplete: false,
        missingFields: ['title'],
        nextQuestion: {
          field: 'title',
          question: '¿Cómo se llama el encuentro?',
          helperText: 'Ej: Desayuno, Almuerzo de trabajo, Cumpleaños',
          type: 'text',
        },
        validationError: null,
      };
    }

    if (!draft.date) {
      return {
        isComplete: false,
        missingFields: ['date'],
        nextQuestion: {
          field: 'date',
          question: '¿Qué día sería?',
          type: 'date',
          quickOptions: [
            { label: 'Hoy', value: 'hoy' },
            { label: 'Mañana', value: 'mañana' },
            { label: 'Este finde', value: 'este fin de semana' },
          ],
        },
        validationError: null,
      };
    }
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
          type: pendingAmbiguity.options && pendingAmbiguity.options.length > 0 ? 'choice' : 'time',
          quickOptions:
            pendingAmbiguity.options && pendingAmbiguity.options.length > 0
              ? pendingAmbiguity.options.map((opt) => ({ label: opt, value: opt }))
              : [
                  { label: '20:00', value: '20:00' },
                  { label: '21:00', value: '21:00' },
                  { label: '22:00', value: '22:00' },
                ],
        },
        validationError: null,
      };
    }
  }

  // 0b. Coordination without specific date options (e.g. "cuando podamos") -> clarification prompt
  if (coordinationDetected && draft.dateMode !== 'coordination' && (!draft.dateOptions || draft.dateOptions.length < 2)) {
    return {
      isComplete: false,
      missingFields: ['dateOptions'],
      nextQuestion: {
        field: 'coordination_handoff',
        question: '¿Qué opciones querés proponer?',
        helperText: 'Por ejemplo: viernes a las 20 o sábado a las 21.',
        type: 'handoff',
        quickOptions: [
          { label: 'Elegir fecha fija', value: 'keep_fixed' },
          { label: 'Usar formulario manual', value: 'handoff_coordination' },
        ],
      },
      validationError: null,
    };
  }

  // 0c. COORDINATION MODE EVALUATION
  if (draft.dateMode === 'coordination') {
    const missingFields: string[] = [];

    // Title
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

    // Date Options
    if (!draft.dateOptions || draft.dateOptions.length < 2) {
      missingFields.push('dateOptions');
      return {
        isComplete: false,
        missingFields,
        nextQuestion: {
          field: 'coordination_options',
          question: '¿Qué fechas y horarios te gustaría proponer? (mínimo 2 opciones)',
          helperText: 'Ej: "viernes a las 21 o sábado a las 20"',
          type: 'text',
        },
        validationError: null,
      };
    }

    if (draft.dateOptions.length > 3 || draft.temporalAlternativesOverflow) {
      missingFields.push('dateOptions');
      return {
        isComplete: false,
        missingFields,
        nextQuestion: {
          field: 'coordination_options',
          question: 'Por ahora podés incluir hasta 3 opciones para coordinar. ¿Cuáles 3 preferís dejar?',
          type: 'text',
        },
        validationError: 'maximum_three_options',
      };
    }

    // Validate each option in the future
    for (const opt of draft.dateOptions) {
      const optErr = validateEncounterDate(opt.date, opt.time);
      if (optErr) {
        missingFields.push('dateOptions');
        return {
          isComplete: false,
          missingFields,
          nextQuestion: {
            field: 'coordination_options',
            question: `Una de las opciones propuestas no es válida (${optErr.toLowerCase()}). Por favor indicá fechas y horarios futuros.`,
            type: 'text',
          },
          validationError: optErr,
        };
      }
    }

    // Modality (Strict: NO SILENT DEFAULT)
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

    // Location or Virtual Link
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

    if (
      draft.modality === 'virtual' &&
      (!draft.virtualLink || !draft.virtualLink.trim() || !isValidVirtualLink(draft.virtualLink))
    ) {
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
        validationError:
          draft.virtualLink && !isValidVirtualLink(draft.virtualLink)
            ? 'El enlace no parece válido. Pegá el enlace completo de la videollamada.'
            : null,
      };
    }

    // Response deadline validation (optional field, but if provided, must be < earliest option)
    if (draft.responseDeadline) {
      const deadlineDate = new Date(draft.responseDeadline);
      const earliestOptionTs = Math.min(
        ...draft.dateOptions.map((opt) => new Date(`${opt.date}T${opt.time}:00`).getTime())
      );
      if (deadlineDate.getTime() >= earliestOptionTs || deadlineDate.getTime() <= Date.now()) {
        missingFields.push('responseDeadline');
        return {
          isComplete: false,
          missingFields,
          nextQuestion: {
            field: 'responseDeadline',
            question:
              'El plazo para responder debe ser anterior a la primera fecha del encuentro. ¿Hasta cuándo querés dar tiempo?',
            type: 'text',
          },
          validationError: 'invalid_deadline',
        };
      }
    }

    // Coordination draft is complete!
    return {
      isComplete: true,
      missingFields: [],
      nextQuestion: null,
      validationError: null,
    };
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
