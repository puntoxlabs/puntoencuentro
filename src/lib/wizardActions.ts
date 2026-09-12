/**
 * wizardActions.ts
 *
 * Capa tipada de acciones internas del wizard Crear con IA.
 * Centraliza la definición de acciones estructuradas de UI, campos editables,
 * y detección de tokens internos para prevenir que acciones técnicas
 * se conviertan en mensajes de chat o invoquen modelos de lenguaje.
 */

import type { EncounterDraft } from './encounterDraft';
import type { InvitationTheme } from './invitationThemes';

export type EditableField =
  | 'title'
  | 'location'
  | 'fixed_datetime'
  | 'date_options'
  | 'theme';

export interface DateOptionValue {
  date: string; // Formato canónico YYYY-MM-DD
  time: string; // Formato canónico HH:mm
}

export type DraftOperation =
  | { type: 'set_title'; title: string }
  | { type: 'set_location'; modality: 'presencial' | 'virtual'; value: string }
  | { type: 'set_fixed_datetime'; date: string; time: string }
  | { type: 'set_date_options'; options: DateOptionValue[] }
  | { type: 'convert_to_fixed'; option?: DateOptionValue }
  | { type: 'set_theme'; theme: InvitationTheme; templateId?: string };

export type WizardAction =
  | { type: 'edit_field'; field: EditableField }
  | { type: 'confirm_coordination' }
  | { type: 'keep_fixed' }
  | { type: 'choose_fixed_option'; date: string; time: string }
  | { type: 'open_manual_form' }
  | { type: 'reset' };

export interface EditableFieldConfig {
  field: EditableField;
  label: string;
  ariaLabel: string;
  description?: string;
}

export const EDITABLE_FIELD_REGISTRY: Record<EditableField, EditableFieldConfig> = {
  title: {
    field: 'title',
    label: 'Título',
    ariaLabel: 'Editar título',
    description: 'Nombre o motivo del encuentro',
  },
  location: {
    field: 'location',
    label: 'Lugar o videollamada',
    ariaLabel: 'Editar lugar o videollamada',
    description: 'Ubicación física o enlace virtual',
  },
  fixed_datetime: {
    field: 'fixed_datetime',
    label: 'Fecha y hora',
    ariaLabel: 'Editar fecha y hora',
    description: 'Fecha y horario definido del encuentro',
  },
  date_options: {
    field: 'date_options',
    label: 'Opciones de fecha',
    ariaLabel: 'Editar opciones de fecha',
    description: 'Opciones propuestas para coordinar con invitados',
  },
  theme: {
    field: 'theme',
    label: 'Tema del encuentro',
    ariaLabel: 'Cambiar tema',
    description: 'Diseño visual y categoría de invitación',
  },
};

/**
 * Determina el campo editable temporal adecuado según el estado del draft.
 */
export function getTemporalEditableField(draft: EncounterDraft): 'date_options' | 'fixed_datetime' {
  if (
    draft.dateMode === 'coordination' ||
    (draft.dateOptions && draft.dateOptions.length > 0) ||
    (draft.pendingTemporalAlternatives && draft.pendingTemporalAlternatives.length > 0)
  ) {
    return 'date_options';
  }
  return 'fixed_datetime';
}

/**
 * Detecta tokens de acción interna del wizard que nunca deben renderizarse
 * como mensajes de chat del usuario ni enviarse a procesamiento LLM.
 */
export function isInternalWizardAction(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed === 'confirm_coordination' ||
    trimmed === 'keep_fixed' ||
    trimmed === 'handoff_coordination' ||
    trimmed === 'choose_fixed_date' ||
    trimmed === 'reset' ||
    trimmed.startsWith('fixed_opt_') ||
    trimmed.startsWith('edit_field_')
  );
}


export function checkFieldDirty(
  field: EditableField,
  currentBuffer: any,
  initialSnapshot: any
): boolean {
  if (field === 'date_options') {
    return JSON.stringify(currentBuffer.dateOptionsBuffer) !== JSON.stringify(initialSnapshot.dateOptionsBuffer);
  }
  if (field === 'fixed_datetime') {
    return currentBuffer.fixedDate !== initialSnapshot.fixedDate || currentBuffer.fixedTime !== initialSnapshot.fixedTime;
  }
  if (field === 'title') {
    return currentBuffer.titleBuffer !== initialSnapshot.titleBuffer;
  }
  if (field === 'location') {
    return currentBuffer.modalityBuffer !== initialSnapshot.modalityBuffer || currentBuffer.locationBuffer !== initialSnapshot.locationBuffer;
  }
  if (field === 'theme') {
    return currentBuffer.themeBuffer !== initialSnapshot.themeBuffer || currentBuffer.templateBuffer !== initialSnapshot.templateBuffer;
  }
  return false;
}
