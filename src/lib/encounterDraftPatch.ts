export type FieldConfidence = 'explicit' | 'inferred_high' | 'inferred_low' | 'ambiguous';

export interface InterpretedField<T> {
  value: T;
  confidence: FieldConfidence;
  originalText?: string;
  alternatives?: T[];
}

export type RelativeDateToken =
  | 'today'
  | 'tomorrow'
  | 'day_after_tomorrow'
  | 'this_weekend'
  | 'next_weekend'
  | 'next_week';

export type CanonicalWeekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

export type OrdinalValue = 1 | 2 | 3 | 4 | 5 | 'first' | 'second' | 'third' | 'fourth' | 'fifth' | 'last';

export type DateIntent =
  | { type: 'absolute'; day: number; month?: number; year?: number }
  | { type: 'relative'; value: RelativeDateToken }
  | { type: 'weekday'; weekday: string; modifier?: 'this' | 'next' }
  | {
      type: 'nth_weekday_of_month';
      weekday: string;
      ordinal: OrdinalValue;
      monthOffset?: number;
      month?: number;
      year?: number;
    }
  | { type: 'range'; values: string[] }
  | { type: 'vague'; description: string };

export type TimeIntent =
  | { type: 'exact'; hour: number; minute: number; description?: string }
  | { type: 'approximate'; hour: number; minute: number; description?: string }
  | { type: 'period'; value: 'morning' | 'afternoon' | 'evening' | 'night'; description?: string }
  | { type: 'after'; hour: number; minute: number; description?: string }
  | { type: 'range'; startHour: number; startMinute: number; endHour: number; endMinute: number; description?: string }
  | { type: 'vague'; description: string };

export interface TemporalAlternative {
  dateRef?: string;
  timeRef?: string;
}

/**
 * Identifies an existing dateOption by its resolved date (and optionally time for disambiguation).
 * OR by its 0-based position in the original snapshot at the start of the turn.
 *
 * Semantics: `position` always refers to the original array snapshot before any action
 * in the same turn is applied, so there is no index drift between actions.
 */
export type DateOptionTarget =
  | { date: string; time?: string }  // by ISO date + optional HH:mm disambiguator
  | { position: number };             // 0-based index into the original snapshot

/**
 * Discriminated union of all supported granular operations on dateOptions.
 * LLM emits semantic refs (dateRef/timeRef); the domain resolves them deterministically.
 */
export type EncounterDraftAction =
  | {
      type: 'add_date_option';
      target?: null;
      changes: {
        dateRef?: string;
        timeRef?: string;
      };
    }
  | {
      type: 'modify_date_option';
      /** Identifies which existing option to modify (resolved against original snapshot). */
      target: DateOptionTarget;
      /**
       * Values to apply. At least one of dateRef or timeRef must be present.
       * These are semantic tokens (e.g. "viernes", "a las 21") — NOT canonical dates.
       * The domain resolves them using the same logic as temporalAlternatives.
       */
      changes: {
        dateRef?: string;
        timeRef?: string;
      };
    }
  | {
      type: 'remove_date_option';
      /** Identifies which existing option to remove (resolved against original snapshot). */
      target: DateOptionTarget;
      changes?: null;
    }
  | {
      type: 'select_fixed_option';
      /** Identifies which existing option to make definitive (by position or date/time). */
      target?: DateOptionTarget | null;
      /**
       * Optional new dateRef or timeRef if setting a new fixed schedule or disambiguating.
       */
      changes?: {
        dateRef?: string;
        timeRef?: string;
      } | null;
    };

/**
 * Per-action outcome returned by draftMerger so the assistant reply accumulator
 * reports only what was actually applied, not what was proposed in the patch.
 */
export type ActionApplicationResult =
  | { status: 'applied';               action: EncounterDraftAction }
  | { status: 'rejected';              action: EncounterDraftAction; reason: string }
  | { status: 'needs_clarification';   action: EncounterDraftAction; reason: string };

export interface DescriptionField extends InterpretedField<string> {
  action?: 'set' | 'clear';
}

export interface EncounterDraftPatch {
  scope?: 'encounter' | 'off_topic' | 'unclear';
  title?: InterpretedField<string>;
  description?: DescriptionField;
  dateIntent?: InterpretedField<DateIntent>;
  timeIntent?: InterpretedField<TimeIntent>;
  dateModeSignal?: InterpretedField<'fixed' | 'coordination'>;
  dateOptions?: InterpretedField<Array<{ date: string; time: string }>>;
  durationMinutesHint?: InterpretedField<number>;
  responseDeadlineHint?: InterpretedField<string>;
  modality?: InterpretedField<'presencial' | 'virtual'>;
  locationText?: InterpretedField<string>;
  virtualLink?: InterpretedField<string>;
  themeHint?: InterpretedField<string>;
  templateHint?: InterpretedField<string>;
  invitationTypeHint?: InterpretedField<'individual' | 'link_general'>;
  temporalAlternatives?: InterpretedField<TemporalAlternative[]>;
  temporalAlternativesOverflow?: InterpretedField<boolean>;
  /** Granular operations on existing dateOptions. Typed — no arbitrary shapes. */
  actions?: EncounterDraftAction[];
}

