export interface OpenEncounterSummary {
  id: string;
  title: string;
  activityType?: string;
  emoji?: string;
  startsAt: string; // ISO date string
  dateLabel: string; // e.g. "Jueves · 20:00"
  approximateZone: string; // e.g. "Güemes"
  localityId: string; // e.g. "guemes"
  openSlots: number; // Available spots to join
  confirmedCount: number; // Current confirmed participants
  language: string;
  description?: string;
  hostName?: string;
}

export interface Localidad {
  id: string;
  nombre: string;
  ciudad: string;
  zona: string;
  pais: string;
  orden: number;
}

export type SolicitudEstado = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface OpenEncounterRequest {
  id: string;
  encuentro_id: string;
  usuario_id: string;
  nombre_solicitante: string;
  mensaje?: string | null;
  estado: SolicitudEstado;
  participante_id?: string | null;
  token_participante?: string | null;
  created_at: string;
  resolved_at?: string | null;
}

export interface AbrirEncuentroPayload {
  open_description: string;
  max_participants: number;
  locality_id: string;
  open_public_zone?: string;
}

export type OpenEncounterSlotState = 'single' | 'remaining' | 'count' | 'full';

export function getSlotLabel(openSlots: number, t?: (key: string, opts?: any) => string): string {
  if (openSlots <= 0) {
    return t ? t('open_encounters.full', { defaultValue: 'Completo' }) : 'Completo';
  }
  if (openSlots === 1) {
    return t ? t('open_encounters.slot_single', { defaultValue: 'Falta 1' }) : 'Falta 1';
  }
  if (openSlots === 2) {
    return t ? t('open_encounters.slots_remaining', { count: 2, defaultValue: 'Quedan 2' }) : 'Quedan 2';
  }
  return t ? t('open_encounters.slots_count', { count: openSlots, defaultValue: `${openSlots} lugares` }) : `${openSlots} lugares`;
}

