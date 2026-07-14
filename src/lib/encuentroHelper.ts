import { buildArgentinaLocalKey, compareArgentinaLocalDateTimes, isArgentinaDateTimeInFuture } from './argentinaDateTime';

export interface EncuentroBase {
  id: string;
  host_id: string;
  titulo: string;
  descripcion?: string | null;
  estado: string;
  fecha: string | null;
  hora: string | null;
  modalidad: string;
  lugar_texto?: string | null;
  link_virtual?: string | null;
  tipo_invitacion: string;
  tema?: string | null;
  tema_invitacion: string;
  invitation_template?: string | null;
  creado_en?: string;
  actualizado_en?: string;
  date_mode?: 'fixed' | 'coordination';
  coordination_status?: 'open' | 'closed' | null;
  response_deadline?: string | null;
  selected_option_id?: string | null;
}

/**
 * Helpers para categorizar y ordenar los encuentros, asegurando
 * que la detección de coordinaciones (que pueden tener fecha/hora null)
 * no rompa la lógica del dashboard.
 */

export const isCoordinationEncounter = (encuentro: EncuentroBase): boolean => {
  if (encuentro.date_mode) {
    return encuentro.date_mode === 'coordination';
  }
  // Fallback temporal mientras la RPC de Home no exponga date_mode.
  // IMPORTANTE: Este fallback no es 100% seguro y asume que
  // cualquier encuentro sin fecha ni hora fue creado como coordinación.
  return !encuentro.fecha && !encuentro.hora;
};

export const isOpenCoordination = (encuentro: EncuentroBase): boolean => {
  if (!isCoordinationEncounter(encuentro)) return false;
  if (encuentro.coordination_status) {
    return encuentro.coordination_status === 'open';
  }
  // Si no hay coordination_status en el payload de Home, y no tiene selected_option_id, asumimos abierta
  return !encuentro.selected_option_id;
};

export type EncounterSortGroup = 1 | 2 | 3 | 4;

export const getEncounterSortGroup = (encuentro: EncuentroBase): EncounterSortGroup => {
  if (isCoordinationEncounter(encuentro)) {
    return isOpenCoordination(encuentro) ? 1 : 3;
  }
  // Si no es coordinación, asumo fijo. Valido su fecha contra Argentina.
  if (encuentro.fecha && encuentro.hora) {
    return isArgentinaDateTimeInFuture(encuentro.fecha, encuentro.hora) ? 2 : 4;
  }
  // Fallback si no tiene fecha, lo considero pasado.
  return 4;
};

// Comparator final que recibe los 4 grupos y ordena coherentemente
export const encounterComparator = (a: EncuentroBase, b: EncuentroBase): number => {
  const groupA = getEncounterSortGroup(a);
  const groupB = getEncounterSortGroup(b);

  if (groupA !== groupB) return groupA - groupB;

  // Mismo grupo
  if (groupA === 1) { // ambas coordinaciones abiertas: creado_en descendente
    return new Date(b.creado_en || 0).getTime() - new Date(a.creado_en || 0).getTime();
  }

  if (groupA === 2 || groupA === 4) { // ambos fijos (futuros o pasados)
    if (
      a.fecha &&
      a.hora &&
      b.fecha &&
      b.hora
    ) {
      const comparison = compareArgentinaLocalDateTimes(
        buildArgentinaLocalKey(a.fecha, a.hora),
        buildArgentinaLocalKey(b.fecha, b.hora)
      );
      // futuros: próximos primero (ascendente)
      if (groupA === 2) return comparison;
      // pasados: más recientes primero (descendente)
      return -comparison;
    }
    // Fallback si no hay fecha/hora
    const tA = new Date(a.actualizado_en || a.creado_en || 0).getTime();
    const tB = new Date(b.actualizado_en || b.creado_en || 0).getTime();
    return tB - tA; // Más recientes primero
  }

  if (groupA === 3) { // ambas coordinaciones cerradas
    if (a.fecha && a.hora && b.fecha && b.hora) {
      const comparison = compareArgentinaLocalDateTimes(
        buildArgentinaLocalKey(a.fecha, a.hora),
        buildArgentinaLocalKey(b.fecha, b.hora)
      );
      return -comparison; // cerradas suelen estar pasadas, ordenamos más reciente primero
    }
    const tA = new Date(a.actualizado_en || a.creado_en || 0).getTime();
    const tB = new Date(b.actualizado_en || b.creado_en || 0).getTime();
    return tB - tA;
  }

  return 0;
};
