import {
  getArgentinaDateTimeParts,
  getArgentinaTodayISO,
  isValidDateTime,
  isArgentinaDateTimeInFuture,
} from '@/lib/argentinaDateTime';
import type { DateIntent, TimeIntent, FieldConfidence } from '@/lib/encounterDraftPatch';

export interface DateResolutionResult {
  resolved: boolean;
  date: string | null; // YYYY-MM-DD
  confidence: FieldConfidence;
  ambiguousOptions?: string[];
  ambiguityReason?: string;
  isPast?: boolean;
}

export interface TimeResolutionResult {
  resolved: boolean;
  time: string | null; // HH:MM
  confidence: FieldConfidence;
  ambiguousOptions?: string[];
  ambiguityReason?: string;
  dayOffset?: number; // 0 or 1 for end-of-day rollover (e.g. 24:00 / medianoche fin de día)
}

const WEEKDAY_NAMES_ES = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

function normalizeWeekday(name: string): number {
  const clean = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  const index = WEEKDAY_NAMES_ES.indexOf(clean);
  return index; // 0 for domingo, 1 for lunes, etc.
}

export function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

export function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return toIsoDate(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

/**
 * Resolves a DateIntent into a canonical YYYY-MM-DD calendar date in Argentina timezone.
 *
 * Mandatory rule (Ajuste 3):
 * When an absolute date is given without a year (e.g. "15 de septiembre"),
 * deterministically calculate whether it belongs to current year or next year.
 */
export function resolveDateIntent(
  intent: DateIntent,
  baseDateParts: { year: number; month: number; day: number } = getArgentinaDateTimeParts()
): DateResolutionResult {
  const currentYear = baseDateParts.year;
  const currentMonth = baseDateParts.month;
  const currentDay = baseDateParts.day;
  const todayIso = getArgentinaTodayISO();

  switch (intent.type) {
    case 'absolute': {
      let targetYear = intent.year;

      if (!targetYear) {
        // Deterministic year deduction:
        // If the month/day has already passed this year, it must be for next year.
        if (
          intent.month < currentMonth ||
          (intent.month === currentMonth && intent.day < currentDay)
        ) {
          targetYear = currentYear + 1;
        } else {
          targetYear = currentYear;
        }
      }

      const candidate = toIsoDate(targetYear, intent.month, intent.day);
      if (!isValidDateTime(candidate, '12:00')) {
        return {
          resolved: false,
          date: null,
          confidence: 'ambiguous',
          ambiguityReason: `Fecha inválida: ${intent.day}/${intent.month}/${targetYear}`,
        };
      }

      const isPast = candidate < todayIso;

      return {
        resolved: !isPast,
        date: candidate,
        confidence: intent.year ? 'explicit' : 'inferred_high',
        isPast,
      };
    }

    case 'relative': {
      const todayDate = new Date(currentYear, currentMonth - 1, currentDay);

      if (intent.value === 'today') {
        return {
          resolved: true,
          date: todayIso,
          confidence: 'explicit',
        };
      }

      if (intent.value === 'tomorrow') {
        const tomorrow = new Date(todayDate);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return {
          resolved: true,
          date: toIsoDate(tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate()),
          confidence: 'explicit',
        };
      }

      if (intent.value === 'day_after_tomorrow') {
        const dayAfter = new Date(todayDate);
        dayAfter.setDate(dayAfter.getDate() + 2);
        return {
          resolved: true,
          date: toIsoDate(dayAfter.getFullYear(), dayAfter.getMonth() + 1, dayAfter.getDate()),
          confidence: 'explicit',
        };
      }

      if (intent.value === 'this_weekend') {
        // Weekend is ambiguous: sábado or domingo
        const todayDayOfWeek = todayDate.getDay(); // 0 is Sun, 6 is Sat
        const daysUntilSaturday = (6 - todayDayOfWeek + 7) % 7;
        const satDate = new Date(todayDate);
        satDate.setDate(satDate.getDate() + daysUntilSaturday);

        const sunDate = new Date(satDate);
        sunDate.setDate(sunDate.getDate() + 1);

        const satIso = toIsoDate(satDate.getFullYear(), satDate.getMonth() + 1, satDate.getDate());
        const sunIso = toIsoDate(sunDate.getFullYear(), sunDate.getMonth() + 1, sunDate.getDate());

        return {
          resolved: false,
          date: null,
          confidence: 'ambiguous',
          ambiguousOptions: [satIso, sunIso],
          ambiguityReason: '¿Querés que sea el sábado o el domingo?',
        };
      }

      if (intent.value === 'next_weekend') {
        const todayDayOfWeek = todayDate.getDay();
        const daysUntilSaturday = ((6 - todayDayOfWeek + 7) % 7) + 7;
        const satDate = new Date(todayDate);
        satDate.setDate(satDate.getDate() + daysUntilSaturday);

        const sunDate = new Date(satDate);
        sunDate.setDate(sunDate.getDate() + 1);

        const satIso = toIsoDate(satDate.getFullYear(), satDate.getMonth() + 1, satDate.getDate());
        const sunIso = toIsoDate(sunDate.getFullYear(), sunDate.getMonth() + 1, sunDate.getDate());

        return {
          resolved: false,
          date: null,
          confidence: 'ambiguous',
          ambiguousOptions: [satIso, sunIso],
          ambiguityReason: '¿Querés el próximo sábado o domingo?',
        };
      }

      if (intent.value === 'next_week') {
        return {
          resolved: false,
          date: null,
          confidence: 'ambiguous',
          ambiguityReason: '¿Qué día de la semana que viene preferís?',
        };
      }

      return {
        resolved: false,
        date: null,
        confidence: 'ambiguous',
        ambiguityReason: 'Fecha no especificada con suficiente precisión',
      };
    }

    case 'weekday': {
      const targetWeekday = normalizeWeekday(intent.weekday);
      if (targetWeekday === -1) {
        return {
          resolved: false,
          date: null,
          confidence: 'ambiguous',
          ambiguityReason: `Día de la semana no reconocido: ${intent.weekday}`,
        };
      }

      const todayDate = new Date(currentYear, currentMonth - 1, currentDay);
      const todayWeekday = todayDate.getDay();

      let daysToAdd = (targetWeekday - todayWeekday + 7) % 7;

      if (intent.modifier === 'next') {
        // "el próximo viernes": if today is Friday, +7; otherwise jump to next week's occurrence
        if (daysToAdd === 0) {
          daysToAdd = 7;
        } else {
          daysToAdd += 7;
        }
      } else {
        // "este viernes" (modifier === 'this' or undefined)
        // If daysToAdd === 0 (e.g. today is Friday):
        // It refers to today!
        // daysToAdd = 0
      }

      const resolvedDate = new Date(todayDate);
      resolvedDate.setDate(resolvedDate.getDate() + daysToAdd);

      const resolvedIso = toIsoDate(
        resolvedDate.getFullYear(),
        resolvedDate.getMonth() + 1,
        resolvedDate.getDate()
      );

      return {
        resolved: true,
        date: resolvedIso,
        confidence: 'inferred_high',
      };
    }

    case 'range':
      return {
        resolved: false,
        date: null,
        confidence: 'ambiguous',
        ambiguityReason: 'Se indicaron múltiples fechas candidatas',
      };

    case 'vague':
    default:
      return {
        resolved: false,
        date: null,
        confidence: 'ambiguous',
        ambiguityReason: intent.description || 'Expresión de fecha vaga o indeterminada',
      };
  }
}

/**
 * Resolves a TimeIntent into a canonical HH:MM time string.
 */
export function resolveTimeIntent(intent: TimeIntent): TimeResolutionResult {
  switch (intent.type) {
    case 'exact':
    case 'approximate': {
      if (intent.hour === 24) {
        if (intent.minute === 0) {
          return {
            resolved: true,
            time: '00:00',
            confidence: intent.type === 'exact' ? 'explicit' : 'inferred_high',
            dayOffset: 1,
          };
        }
        return {
          resolved: false,
          time: null,
          confidence: 'ambiguous',
          ambiguityReason: `Hora inválida: 24:${pad(intent.minute)}. Las 24 sólo admite 00 minutos (medianoche).`,
        };
      }

      if (
        intent.hour < 0 ||
        intent.hour > 23 ||
        intent.minute < 0 ||
        intent.minute > 59
      ) {
        return {
          resolved: false,
          time: null,
          confidence: 'ambiguous',
          ambiguityReason: `Hora inválida: ${intent.hour}:${intent.minute}`,
        };
      }

      const dayOffset =
        intent.hour === 0 &&
        intent.minute === 0 &&
        Boolean(intent.description && /media\s*noche|fin\s+de\s+d[ií]a/i.test(intent.description))
          ? 1
          : 0;

      const cleanTime = `${pad(intent.hour)}:${pad(intent.minute)}`;
      return {
        resolved: true,
        time: cleanTime,
        confidence: intent.type === 'exact' ? 'explicit' : 'inferred_high',
        dayOffset,
      };
    }

    case 'period': {
      const descriptions: Record<string, string> = {
        morning: 'a la mañana',
        afternoon: 'a la tarde',
        evening: 'al atardecer',
        night: 'a la noche',
      };
      return {
        resolved: false,
        time: null,
        confidence: 'ambiguous',
        ambiguityReason: `Mencionaste ${descriptions[intent.value] || intent.value}. ¿A qué hora exacta?`,
      };
    }

    case 'after': {
      return {
        resolved: false,
        time: null,
        confidence: 'ambiguous',
        ambiguityReason: `Mencionaste después de las ${pad(intent.hour)}:${pad(intent.minute)}. ¿A qué hora específica?`,
      };
    }

    case 'range': {
      return {
        resolved: false,
        time: null,
        confidence: 'ambiguous',
        ambiguityReason: `Mencionaste entre las ${pad(intent.startHour)}:${pad(intent.startMinute)} y las ${pad(intent.endHour)}:${pad(intent.endMinute)}. ¿Qué hora preferís?`,
      };
    }

    case 'vague':
    default:
      return {
        resolved: false,
        time: null,
        confidence: 'ambiguous',
        ambiguityReason: intent.description || 'Hora indeterminada',
      };
  }
}

/**
 * Validates whether the resolved date and time are in the future relative to Argentina current time.
 */
export function validateResolvedDateTimeInFuture(date: string, time: string): boolean {
  return isArgentinaDateTimeInFuture(date, time);
}
