import {
  getArgentinaDateTimeParts,
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
  if (typeof n !== 'number' || !Number.isFinite(n) || Number.isNaN(n)) {
    throw new TypeError(`[pad] Expected a valid number, got: ${n}`);
  }
  return Math.trunc(n).toString().padStart(2, '0');
}

export function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12) {
    return false;
  }
  if (day < 1 || day > 31) {
    return false;
  }
  const maxDays = getDaysInMonth(year, month);
  return day <= maxDays;
}

/**
 * Finds the next real calendar date for a given day-of-month (1..31).
 * If the day does not exist in the current month (e.g. day 31 in September)
 * or has already passed in the current month, searches ahead month by month
 * to find the next month where that day physically exists in the calendar.
 */
export function resolveNextValidDayOfMonth(
  day: number,
  baseParts: { year: number; month: number; day: number }
): { year: number; month: number; day: number } | null {
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    return null;
  }

  let y = baseParts.year;
  let m = baseParts.month;

  for (let offset = 0; offset < 48; offset++) {
    const maxDays = getDaysInMonth(y, m);
    if (day <= maxDays) {
      if (offset === 0) {
        if (day >= baseParts.day) {
          return { year: y, month: m, day };
        }
      } else {
        return { year: y, month: m, day };
      }
    }

    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }

  return null;
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
 * Mandatory rule:
 * When an absolute date is given without a year (e.g. "15 de septiembre"),
 * deterministically calculate whether it belongs to current year or next year.
 * When an absolute date is given without a month (e.g. "el 12", "el 31"),
 * deterministically find the next real calendar date using resolveNextValidDayOfMonth.
 */
export function resolveDateIntent(
  intent: DateIntent,
  baseDateParts: { year: number; month: number; day: number } = getArgentinaDateTimeParts()
): DateResolutionResult {
  const currentYear = baseDateParts.year;
  const currentMonth = baseDateParts.month;
  const currentDay = baseDateParts.day;
  const todayIso = toIsoDate(currentYear, currentMonth, currentDay);

  switch (intent.type) {
    case 'absolute': {
      const day = intent.day;
      const month = intent.month;
      const year = intent.year;

      if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31) {
        return {
          resolved: false,
          date: null,
          confidence: 'ambiguous',
          ambiguityReason: `Día inválido o no especificado: ${day}`,
        };
      }

      // Case: Day-only (no month provided, e.g. "el 12", "el 5", "el 31")
      if (month === undefined || month === null) {
        const nextDate = resolveNextValidDayOfMonth(day, baseDateParts);
        if (!nextDate) {
          return {
            resolved: false,
            date: null,
            confidence: 'ambiguous',
            ambiguityReason: `No se pudo encontrar una fecha válida en el calendario para el día ${day}.`,
          };
        }

        const candidate = toIsoDate(nextDate.year, nextDate.month, nextDate.day);
        const isPast = candidate < todayIso;

        return {
          resolved: !isPast,
          date: candidate,
          confidence: 'inferred_high',
          isPast,
        };
      }

      // Case: Explicit month provided (e.g. "12 de octubre", "31 de septiembre", "29 de febrero de 2028")
      if (typeof month !== 'number' || !Number.isInteger(month) || month < 1 || month > 12) {
        return {
          resolved: false,
          date: null,
          confidence: 'ambiguous',
          ambiguityReason: `Mes inválido: ${month}`,
        };
      }

      let targetYear = year;
      if (!targetYear) {
        // Deterministic year deduction:
        // If the month/day has already passed this year, it must be for next year.
        if (
          month < currentMonth ||
          (month === currentMonth && day < currentDay)
        ) {
          targetYear = currentYear + 1;
        } else {
          targetYear = currentYear;
        }
      }

      // Strict calendar existence check:
      if (!isValidCalendarDate(targetYear, month, day)) {
        return {
          resolved: false,
          date: null,
          confidence: 'ambiguous',
          ambiguityReason: `Fecha inválida en el calendario: ${day}/${month}/${targetYear}`,
        };
      }

      const candidate = toIsoDate(targetYear, month, day);
      const isPast = candidate < todayIso;

      return {
        resolved: !isPast,
        date: candidate,
        confidence: year ? 'explicit' : 'inferred_high',
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
