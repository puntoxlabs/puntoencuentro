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

export type DateIntent =
  | { type: 'absolute'; day: number; month: number; year?: number }
  | { type: 'relative'; value: RelativeDateToken }
  | { type: 'weekday'; weekday: string; modifier?: 'this' | 'next' }
  | { type: 'range'; values: string[] }
  | { type: 'vague'; description: string };

export type TimeIntent =
  | { type: 'exact'; hour: number; minute: number }
  | { type: 'approximate'; hour: number; minute: number }
  | { type: 'period'; value: 'morning' | 'afternoon' | 'evening' | 'night' }
  | { type: 'after'; hour: number; minute: number }
  | { type: 'range'; startHour: number; startMinute: number; endHour: number; endMinute: number }
  | { type: 'vague'; description: string };

export interface EncounterDraftPatch {
  title?: InterpretedField<string>;
  description?: InterpretedField<string>;
  dateIntent?: InterpretedField<DateIntent>;
  timeIntent?: InterpretedField<TimeIntent>;
  dateModeSignal?: InterpretedField<'fixed' | 'coordination'>;
  modality?: InterpretedField<'presencial' | 'virtual'>;
  locationText?: InterpretedField<string>;
  virtualLink?: InterpretedField<string>;
  themeHint?: InterpretedField<string>;
}
