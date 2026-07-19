import { isEncuentroPasado } from './formatDate';

export function getEncounterListBucket(encounter: any): 'current' | 'past' | 'cancelled' {
  if (!encounter) return 'current';
  if (encounter.estado === 'cancelado') return 'cancelled';

  if (encounter.date_mode === 'coordination') {
    if (encounter.coordination_status === 'open') return 'current';
    if (encounter.coordination_status === 'closed') {
      return isEncuentroPasado(encounter.fecha, encounter.hora) ? 'past' : 'current';
    }
    return 'current';
  }

  return isEncuentroPasado(encounter.fecha, encounter.hora) ? 'past' : 'current';
}
