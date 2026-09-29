import {
  getArgentinaDateTimeParts,
} from './argentinaDateTime';

export type TemporalidadChip = 'hoy' | 'esta_semana' | 'este_finde' | 'flexible';

export interface TemporalidadInfo {
  chip: TemporalidadChip;
  temporalidad_texto: string;
  fecha_desde: string | null;
  fecha_hasta: string | null;
}

export const TEMPORALIDAD_CHIPS: { id: TemporalidadChip; label: string }[] = [
  { id: 'hoy', label: 'Hoy' },
  { id: 'esta_semana', label: 'Esta semana' },
  { id: 'este_finde', label: 'Este finde' },
  { id: 'flexible', label: 'Flexible' },
];

/**
 * Resuelve las fechas y etiqueta de temporalidad para una intención
 * basándose estrictamente en la hora oficial de Argentina (evitando desfasajes UTC).
 */
export function resolverTemporalidadIntencion(
  chip: TemporalidadChip,
  referenceDate?: Date
): TemporalidadInfo {
  if (chip === 'flexible') {
    return {
      chip: 'flexible',
      temporalidad_texto: 'Flexible',
      fecha_desde: null,
      fecha_hasta: null,
    };
  }

  const parts = getArgentinaDateTimeParts(referenceDate);
  const pad = (n: number) => n.toString().padStart(2, '0');

  // Fecha local en Argentina
  const todayDate = new Date(parts.year, parts.month - 1, parts.day);
  const todayISO = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const dayOfWeek = todayDate.getDay(); // 0: Domingo, 1: Lunes, ..., 6: Sábado

  switch (chip) {
    case 'hoy': {
      return {
        chip: 'hoy',
        temporalidad_texto: 'Hoy',
        fecha_desde: todayISO,
        fecha_hasta: todayISO,
      };
    }

    case 'esta_semana': {
      // Esta semana: desde hoy hasta el domingo de la semana en curso
      const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
      const sunday = new Date(parts.year, parts.month - 1, parts.day + daysUntilSunday);
      const sundayISO = `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}`;

      return {
        chip: 'esta_semana',
        temporalidad_texto: 'Esta semana',
        fecha_desde: todayISO,
        fecha_hasta: sundayISO,
      };
    }

    case 'este_finde': {
      // Fin de semana: Sábado y Domingo
      if (dayOfWeek === 0) {
        // Hoy ya es domingo (último día del finde actual)
        return {
          chip: 'este_finde',
          temporalidad_texto: 'Este finde',
          fecha_desde: todayISO,
          fecha_hasta: todayISO,
        };
      }

      if (dayOfWeek === 6) {
        // Hoy es sábado
        const sunday = new Date(parts.year, parts.month - 1, parts.day + 1);
        const sundayISO = `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}`;
        return {
          chip: 'este_finde',
          temporalidad_texto: 'Este finde',
          fecha_desde: todayISO,
          fecha_hasta: sundayISO,
        };
      }

      // Lunes a viernes
      const daysUntilSaturday = 6 - dayOfWeek;
      const daysUntilSunday = 7 - dayOfWeek;
      const saturday = new Date(parts.year, parts.month - 1, parts.day + daysUntilSaturday);
      const sunday = new Date(parts.year, parts.month - 1, parts.day + daysUntilSunday);
      const satISO = `${saturday.getFullYear()}-${pad(saturday.getMonth() + 1)}-${pad(saturday.getDate())}`;
      const sunISO = `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}`;

      return {
        chip: 'este_finde',
        temporalidad_texto: 'Este finde',
        fecha_desde: satISO,
        fecha_hasta: sunISO,
      };
    }

    default: {
      return {
        chip: 'flexible',
        temporalidad_texto: 'Flexible',
        fecha_desde: null,
        fecha_hasta: null,
      };
    }
  }
}
