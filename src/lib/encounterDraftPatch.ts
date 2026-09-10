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

export interface EncounterDraftPatch {
  scope?: 'encounter' | 'off_topic' | 'unclear';
  title?: InterpretedField<string>;
  description?: InterpretedField<string>;
  dateIntent?: InterpretedField<DateIntent>;
  timeIntent?: InterpretedField<TimeIntent>;
  dateModeSignal?: InterpretedField<'fixed' | 'coordination'>;
  modality?: InterpretedField<'presencial' | 'virtual'>;
  locationText?: InterpretedField<string>;
  virtualLink?: InterpretedField<string>;
  themeHint?: InterpretedField<string>;
  templateHint?: InterpretedField<string>;
}
