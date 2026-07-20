import { isEncuentroPasado } from './formatDate';

export function getEncounterListBucket(encounter: any): 'current' | 'past' | 'cancelled' {
  if (!encounter) return 'current';
  if (encounter.estado === 'cancelado') return 'cancelled';

  const graceMinutes = encounter.post_event_active_minutes ?? 45;

  if (encounter.date_mode === 'coordination') {
    if (encounter.coordination_status === 'open') {
      // Usamos el campo has_future_options que ahora viene del backend.
      // Si no existe (encuentro viejo o backend viejo), asumimos open siempre en próximos.
      if (typeof encounter.has_future_options === 'boolean') {
        return encounter.has_future_options ? 'current' : 'past';
      }
      return 'current';
    }
    if (encounter.coordination_status === 'closed') {
      return isEncuentroPasado(encounter.fecha, encounter.hora, graceMinutes) ? 'past' : 'current';
    }
    return 'current';
  }

  return isEncuentroPasado(encounter.fecha, encounter.hora, graceMinutes) ? 'past' : 'current';
}
