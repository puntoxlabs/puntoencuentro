import {
  getArgentinaDateTimeParts,
  isArgentinaDateTimeInFuture,
} from '@/lib/argentinaDateTime';
import { inferModalityFromContext } from '@/lib/modalityInference';
import type {
  DateIntent,
  TimeIntent,
  FieldConfidence,
  CanonicalWeekday,
  OrdinalValue,
} from '@/lib/encounterDraftPatch';

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

export interface WeekdayInfo {
  canonical: CanonicalWeekday;
  dayIndex: number; // 0 for domingo/sunday, 1 for lunes/monday, ..., 6 for sabado/saturday
  nameEs: string;
}

export const WEEKDAY_MAPPING: Record<string, WeekdayInfo> = {
  // Sunday (0)
  domingo: { canonical: 'sunday', dayIndex: 0, nameEs: 'domingo' },
  dom: { canonical: 'sunday', dayIndex: 0, nameEs: 'domingo' },
  sunday: { canonical: 'sunday', dayIndex: 0, nameEs: 'domingo' },
  sun: { canonical: 'sunday', dayIndex: 0, nameEs: 'domingo' },

  // Monday (1)
  lunes: { canonical: 'monday', dayIndex: 1, nameEs: 'lunes' },
  lun: { canonical: 'monday', dayIndex: 1, nameEs: 'lunes' },
  monday: { canonical: 'monday', dayIndex: 1, nameEs: 'lunes' },
  mon: { canonical: 'monday', dayIndex: 1, nameEs: 'lunes' },

  // Tuesday (2)
  martes: { canonical: 'tuesday', dayIndex: 2, nameEs: 'martes' },
  mar: { canonical: 'tuesday', dayIndex: 2, nameEs: 'martes' },
  tuesday: { canonical: 'tuesday', dayIndex: 2, nameEs: 'martes' },
  tue: { canonical: 'tuesday', dayIndex: 2, nameEs: 'martes' },

  // Wednesday (3)
  miercoles: { canonical: 'wednesday', dayIndex: 3, nameEs: 'miércoles' },
  mie: { canonical: 'wednesday', dayIndex: 3, nameEs: 'miércoles' },
  wednesday: { canonical: 'wednesday', dayIndex: 3, nameEs: 'miércoles' },
  wed: { canonical: 'wednesday', dayIndex: 3, nameEs: 'miércoles' },

  // Thursday (4)
  jueves: { canonical: 'thursday', dayIndex: 4, nameEs: 'jueves' },
  jue: { canonical: 'thursday', dayIndex: 4, nameEs: 'jueves' },
  thursday: { canonical: 'thursday', dayIndex: 4, nameEs: 'jueves' },
  thu: { canonical: 'thursday', dayIndex: 4, nameEs: 'jueves' },

  // Friday (5)
  viernes: { canonical: 'friday', dayIndex: 5, nameEs: 'viernes' },
  vie: { canonical: 'friday', dayIndex: 5, nameEs: 'viernes' },
  friday: { canonical: 'friday', dayIndex: 5, nameEs: 'viernes' },
  fri: { canonical: 'friday', dayIndex: 5, nameEs: 'viernes' },

  // Saturday (6)
  sabado: { canonical: 'saturday', dayIndex: 6, nameEs: 'sábado' },
  sab: { canonical: 'saturday', dayIndex: 6, nameEs: 'sábado' },
  saturday: { canonical: 'saturday', dayIndex: 6, nameEs: 'sábado' },
  sat: { canonical: 'saturday', dayIndex: 6, nameEs: 'sábado' },
};

export function normalizeToCanonicalWeekday(name: string): WeekdayInfo | null {
  if (!name || typeof name !== 'string') return null;
  const clean = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  return WEEKDAY_MAPPING[clean] || null;
}

export function normalizeWeekday(name: string): number {
  const info = normalizeToCanonicalWeekday(name);
  return info ? info.dayIndex : -1;
}

export const ORDINAL_MAPPING: Record<string, OrdinalValue> = {
  primer: 'first',
  primero: 'first',
  primera: 'first',
  '1er': 'first',
  '1ro': 'first',
  '1ra': 'first',
  '1': 'first',
  '1°': 'first',
  '1ª': 'first',
  first: 'first',

  segundo: 'second',
  segunda: 'second',
  '2do': 'second',
  '2da': 'second',
  '2': 'second',
  '2°': 'second',
  '2ª': 'second',
  second: 'second',

  tercer: 'third',
  tercero: 'third',
  tercera: 'third',
  '3er': 'third',
  '3ro': 'third',
  '3ra': 'third',
  '3': 'third',
  '3°': 'third',
  '3ª': 'third',
  third: 'third',

  cuarto: 'fourth',
  cuarta: 'fourth',
  '4to': 'fourth',
  '4ta': 'fourth',
  '4': 'fourth',
  '4°': 'fourth',
  '4ª': 'fourth',
  fourth: 'fourth',

  quinto: 'fifth',
  quinta: 'fifth',
  '5to': 'fifth',
  '5ta': 'fifth',
  '5': 'fifth',
  '5°': 'fifth',
  '5ª': 'fifth',
  fifth: 'fifth',

  ultimo: 'last',
  último: 'last',
  ultima: 'last',
  última: 'last',
  last: 'last',
};

export const MONTHS_MAP: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

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
 * Resolves an nth_weekday_of_month expression (e.g. "primer viernes del mes que viene",
 * "tercer jueves de octubre", "último sábado del mes").
 */
export function resolveNthWeekdayOfMonth(
  intent: {
    weekday: string;
    ordinal: OrdinalValue;
    monthOffset?: number;
    month?: number;
    year?: number;
  },
  baseDateParts: { year: number; month: number; day: number }
): DateResolutionResult {
  const weekdayInfo = normalizeToCanonicalWeekday(intent.weekday);
  if (!weekdayInfo) {
    return {
      resolved: false,
      date: null,
      confidence: 'ambiguous',
      ambiguityReason: 'No pude determinar bien la fecha. ¿Podés indicarme el día de otra forma?',
    };
  }

  let targetYear = intent.year ?? baseDateParts.year;
  let targetMonth: number;

  if (intent.month !== undefined && intent.month !== null) {
    targetMonth = intent.month;
    if (intent.year === undefined) {
      if (targetMonth < baseDateParts.month) {
        targetYear = baseDateParts.year + 1;
      }
    }
  } else {
    const offset = intent.monthOffset ?? 0;
    targetMonth = baseDateParts.month + offset;
    while (targetMonth > 12) {
      targetMonth -= 12;
      targetYear += 1;
    }
    while (targetMonth < 1) {
      targetMonth += 12;
      targetYear -= 1;
    }
  }

  const daysInMonth = getDaysInMonth(targetYear, targetMonth);
  const matchingDays: number[] = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(targetYear, targetMonth - 1, d);
    if (dt.getDay() === weekdayInfo.dayIndex) {
      matchingDays.push(d);
    }
  }

  let chosenDay: number | null = null;
  const ord = intent.ordinal;

  if (ord === 'last') {
    chosenDay = matchingDays[matchingDays.length - 1] ?? null;
  } else {
    let index: number;
    if (typeof ord === 'number') {
      index = ord;
    } else {
      const ordNumMap: Record<string, number> = {
        first: 1,
        second: 2,
        third: 3,
        fourth: 4,
        fifth: 5,
      };
      index = ordNumMap[ord] || 1;
    }

    if (index > matchingDays.length) {
      return {
        resolved: false,
        date: null,
        confidence: 'ambiguous',
        ambiguityReason: `El mes indicado no tiene ${index}° ${weekdayInfo.nameEs}. ¿Podés elegir otra fecha?`,
      };
    }
    chosenDay = matchingDays[index - 1];
  }

  if (!chosenDay) {
    return {
      resolved: false,
      date: null,
      confidence: 'ambiguous',
      ambiguityReason: 'No se pudo encontrar el día solicitado en ese mes.',
    };
  }

  const resolvedIso = toIsoDate(targetYear, targetMonth, chosenDay);
  const todayIso = toIsoDate(baseDateParts.year, baseDateParts.month, baseDateParts.day);

  if (resolvedIso < todayIso) {
    return {
      resolved: false,
      date: null,
      confidence: 'ambiguous',
      isPast: true,
      ambiguityReason: 'La fecha indicada ya pasó. ¿Podés elegir una fecha futura?',
    };
  }

  return {
    resolved: true,
    date: resolvedIso,
    confidence: 'inferred_high',
  };
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
      const weekdayInfo = normalizeToCanonicalWeekday(intent.weekday);
      if (!weekdayInfo) {
        return {
          resolved: false,
          date: null,
          confidence: 'ambiguous',
          ambiguityReason: 'No pude determinar bien la fecha. ¿Podés indicarme el día de otra forma?',
        };
      }

      const targetWeekday = weekdayInfo.dayIndex;
      const todayDate = new Date(currentYear, currentMonth - 1, currentDay);
      const todayWeekday = todayDate.getDay();

      let daysToAdd = (targetWeekday - todayWeekday + 7) % 7;

      if (intent.modifier === 'next') {
        // "el próximo viernes" / "viernes próximo": strictly next future occurrence.
        // If today is that weekday (daysToAdd === 0), jump to next week (+7).
        // If today is before that weekday in current cycle (daysToAdd > 0),
        // it refers to this upcoming weekday in the current cycle.
        if (daysToAdd === 0) {
          daysToAdd = 7;
        }
      } else {
        // "este viernes" (modifier === 'this' or undefined):
        // If daysToAdd === 0 (today is that weekday), it refers to today (daysToAdd = 0).
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

    case 'nth_weekday_of_month': {
      return resolveNthWeekdayOfMonth(intent, baseDateParts);
    }

    case 'range':
      return {
        resolved: false,
        date: null,
        confidence: 'ambiguous',
        ambiguityReason: 'Se indicaron múltiples fechas candidatas',
      };

    case 'vague':
    default: {
      if (intent.description) {
        const rescued = parseDeterministicDateExpression(intent.description, baseDateParts);
        if (rescued && rescued.resolved) {
          return rescued;
        }
      }
      return {
        resolved: false,
        date: null,
        confidence: 'ambiguous',
        ambiguityReason: intent.description || 'Expresión de fecha vaga o indeterminada',
      };
    }
  }
}

/**
 * Parses deterministic date expressions from raw user text, including:
 * - Relative days: "hoy", "mañana", "pasado mañana", "este finde", "finde", "este fin de semana", "el próximo fin de semana"
 * - Ordinal weekday expressions: "el primer viernes del mes que viene", "segundo martes del próximo mes", "tercer jueves de octubre", "último sábado del mes"
 * - Relative weekday expressions: "el viernes próximo", "viernes próximo", "el viernes que viene", "viernes que viene", "este viernes", "el viernes", "viernes", "friday", "next friday"
 * - Day of month / day + month: "el 12", "12", "15 de septiembre", "15 de octubre de 2026"
 */
export function parseDeterministicDateIntent(text: string): DateIntent | null {
  if (!text || typeof text !== 'string') return null;
  const clean = text.trim();
  const normalized = clean
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  // 1. Relatives
  if (normalized === 'hoy') {
    return { type: 'relative', value: 'today' };
  }
  if (normalized === 'manana' || normalized === 'de manana') {
    return { type: 'relative', value: 'tomorrow' };
  }
  if (normalized === 'pasado manana') {
    return { type: 'relative', value: 'day_after_tomorrow' };
  }
  if (normalized === 'este fin de semana' || normalized === 'el finde' || normalized === 'finde') {
    return { type: 'relative', value: 'this_weekend' };
  }
  if (
    normalized === 'el proximo fin de semana' ||
    normalized === 'proximo fin de semana' ||
    normalized === 'el proximo finde' ||
    normalized === 'proximo finde'
  ) {
    return { type: 'relative', value: 'next_weekend' };
  }
  if (normalized === 'la proxima semana' || normalized === 'la semana que viene') {
    return { type: 'relative', value: 'next_week' };
  }

  // 2. Ordinals: e.g. "primer viernes del mes que viene", "segundo martes del proximo mes", "tercer jueves de octubre", "ultimo sabado del mes"
  const ordinalPattern = /^(?:el\s+)?(primer|primero|primera|segundo|segunda|tercer|tercero|tercera|cuarto|cuarta|quinto|quinta|ultimo|último|ultima|última|1er|1ro|1ra|1°|1ª|2do|2da|2°|2ª|3er|3ro|3ra|3°|3ª|4to|4ta|4°|4ª|5to|5ta|5°|5ª|first|second|third|fourth|fifth|last)\s+([a-z]+)(?:\s+(?:del?\s+)?(?:(este|proximo|pr[oó]ximo|que\s+viene)\s+mes|mes\s+(?:que\s+viene|proximo|pr[oó]ximo)|mes|(?:de\s+([a-z]+)(?:\s+(?:del?\s+)?(\d{4}))?)))?$/i;

  const ordMatch = normalized.match(ordinalPattern);
  if (ordMatch) {
    const rawOrd = ordMatch[1];
    const rawWk = ordMatch[2];
    const monthMod = ordMatch[3]; // "este", "proximo", "que viene"
    const explicitMonth = ordMatch[4]; // e.g. "octubre"
    const explicitYear = ordMatch[5] ? parseInt(ordMatch[5], 10) : undefined;

    const ordVal = ORDINAL_MAPPING[rawOrd];
    const wkInfo = normalizeToCanonicalWeekday(rawWk);

    if (ordVal && wkInfo) {
      let monthOffset = 0;
      let monthNum: number | undefined;

      if (explicitMonth && MONTHS_MAP[explicitMonth]) {
        monthNum = MONTHS_MAP[explicitMonth];
      } else if (
        monthMod === 'proximo' ||
        monthMod === 'que viene' ||
        normalized.includes('mes que viene') ||
        normalized.includes('proximo mes')
      ) {
        monthOffset = 1;
      } else if (monthMod === 'este' || normalized.includes('este mes') || normalized.includes('del mes')) {
        monthOffset = 0;
      }

      return {
        type: 'nth_weekday_of_month',
        weekday: wkInfo.canonical,
        ordinal: ordVal,
        monthOffset: monthNum ? undefined : monthOffset,
        month: monthNum,
        year: explicitYear,
      };
    }
  }

  // 3. Weekday expressions
  // "viernes proximo", "el viernes proximo", "viernes que viene", "el viernes que viene"
  const suffixNextMatch = normalized.match(/^(?:el\s+)?([a-z]+)\s+(?:proximo|que\s+viene)$/);
  if (suffixNextMatch) {
    const wkInfo = normalizeToCanonicalWeekday(suffixNextMatch[1]);
    if (wkInfo) {
      return {
        type: 'weekday',
        weekday: wkInfo.canonical,
        modifier: 'next',
      };
    }
  }

  // "el proximo viernes", "proximo viernes", "next friday"
  const prefixNextMatch = normalized.match(/^(?:el\s+proximo\s+|proximo\s+|next\s+)([a-z]+)$/);
  if (prefixNextMatch) {
    const wkInfo = normalizeToCanonicalWeekday(prefixNextMatch[1]);
    if (wkInfo) {
      return {
        type: 'weekday',
        weekday: wkInfo.canonical,
        modifier: 'next',
      };
    }
  }

  // "este viernes", "this friday"
  const thisWkMatch = normalized.match(/^(?:este\s+|this\s+)([a-z]+)$/);
  if (thisWkMatch) {
    const wkInfo = normalizeToCanonicalWeekday(thisWkMatch[1]);
    if (wkInfo) {
      return {
        type: 'weekday',
        weekday: wkInfo.canonical,
        modifier: 'this',
      };
    }
  }

  // "el viernes", "viernes", "friday", "fri", "vie"
  const singleWkMatch = normalized.match(/^(?:el\s+)?([a-z]+)$/);
  if (singleWkMatch) {
    const wkInfo = normalizeToCanonicalWeekday(singleWkMatch[1]);
    if (wkInfo) {
      return {
        type: 'weekday',
        weekday: wkInfo.canonical,
        modifier: 'this',
      };
    }
  }

  // 4. Absolute day or day + month
  const dayOnlyMatch = normalized.match(/^(?:el\s+)?([1-9]|[12]\d|3[01])$/);
  if (dayOnlyMatch) {
    return { type: 'absolute', day: parseInt(dayOnlyMatch[1], 10) };
  }

  const dayMonthMatch = normalized.match(
    /^(?:(?:el\s+)?(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+)?(?:el\s+)?([1-9]|[12]\d|3[01])\s+de\s+([a-z]+)(?:\s+(?:del?\s+)?(\d{4}))?$/
  );
  if (dayMonthMatch && MONTHS_MAP[dayMonthMatch[2]]) {
    return {
      type: 'absolute',
      day: parseInt(dayMonthMatch[1], 10),
      month: MONTHS_MAP[dayMonthMatch[2]],
      year: dayMonthMatch[3] ? parseInt(dayMonthMatch[3], 10) : undefined,
    };
  }

  return null;
}

/**
 * Deterministically parses and resolves a date expression against baseDateParts.
 * Returns DateResolutionResult or null if input does not match any date expression.
 */
export function parseDeterministicDateExpression(
  text: string,
  baseDateParts: { year: number; month: number; day: number } = getArgentinaDateTimeParts()
): DateResolutionResult | null {
  const intent = parseDeterministicDateIntent(text);
  if (!intent) return null;
  return resolveDateIntent(intent, baseDateParts);
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

export type HourSourceForm =
  | 'ambiguous_12h_word'
  | 'explicit_24h'
  | 'am_pm_explicit'
  | 'contextual_explicit';

export const SPANISH_HOUR_WORDS: Record<string, number> = {
  cero: 0,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  dieciséis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiun: 21,
  veintiún: 21,
  veintiuno: 21,
  veintiuna: 21,
  veintidos: 22,
  veintidós: 22,
  veintitres: 23,
  veintitrés: 23,
  veinticuatro: 24,
};

export const SPANISH_MINUTE_WORDS: Record<string, number> = {
  media: 30,
  cuarto: 15,
  treinta: 30,
  quince: 15,
  veinte: 20,
  diez: 10,
  cinco: 5,
  'cuarenta y cinco': 45,
  cuarenta: 40,
  cincuenta: 50,
};

export interface ParsedTimeResult {
  kind: 'exact';
  time: string; // "HH:MM"
  hour: number;
  minute: number;
  sourceForm: HourSourceForm;
  dayOffset?: number; // 0 or 1 for end-of-day rollover (e.g. 24:00 / medianoche)
}

export interface ParsedRangeResult {
  kind: 'range';
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export interface ParsedInvalidResult {
  kind: 'invalid';
  raw: string;
}

export type ParsedTimeInput = ParsedTimeResult | ParsedRangeResult | ParsedInvalidResult;

interface SingleTimeParsed {
  hour: number;
  minute: number;
  dayOffset: number;
  sourceForm: HourSourceForm;
}

function parseSingleTimeToken(
  token: string,
  periodModifier?: string
): SingleTimeParsed | null {
  let clean = token.trim().toLowerCase();

  // Strip leading "a las", "a la", "las", "la"
  clean = clean.replace(/^(?:a\s+)?(?:las?\s+)/i, '').trim();

  // Strip trailing "hs", "horas", "hrs", "h"
  const hasHsSuffix = /(?:hs?|horas?|hrs?)$/i.test(clean);
  clean = clean.replace(/\s*(?:hs?|horas?|hrs?)$/i, '').trim();

  if (/^media\s*noche$/i.test(clean)) {
    return { hour: 0, minute: 0, dayOffset: 1, sourceForm: 'explicit_24h' };
  }
  if (/^medio\s*d[ií]a$/i.test(clean)) {
    return { hour: 12, minute: 0, dayOffset: 0, sourceForm: 'explicit_24h' };
  }

  // 1. Try splitting minutes: "y media", "y cuarto", "treinta", "quince", ":MM", ".MM"
  let hourPart = clean;
  let minutePart: number | null = null;
  let hasExplicitMinutesColon = false;

  const wordMinuteMatch = clean.match(/^(.+?)\s+(?:y\s+)?(media|cuarto|treinta|quince|cuarenta\s+y\s+cinco|veinte|diez|cinco)$/i);
  if (wordMinuteMatch) {
    hourPart = wordMinuteMatch[1].trim();
    const minWord = wordMinuteMatch[2].toLowerCase().trim();
    minutePart = SPANISH_MINUTE_WORDS[minWord] ?? null;
  } else {
    const colonMatch = clean.match(/^(\d{1,2})[:.](\d{2})$/);
    if (colonMatch) {
      hourPart = colonMatch[1];
      minutePart = Number(colonMatch[2]);
      hasExplicitMinutesColon = true;
    }
  }

  // 2. Resolve hour value (either digits or Spanish word)
  let rawHour: number | null = null;
  let isWordHour = false;

  if (SPANISH_HOUR_WORDS[hourPart] !== undefined) {
    rawHour = SPANISH_HOUR_WORDS[hourPart];
    isWordHour = true;
  } else if (/^\d{1,2}$/.test(hourPart)) {
    rawHour = Number(hourPart);
    isWordHour = false;
  }

  if (rawHour === null || !Number.isInteger(rawHour)) return null;
  const minute = minutePart !== null ? minutePart : 0;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  // Determine initial sourceForm
  let sourceForm: HourSourceForm;
  if (periodModifier) {
    if (/(?:pm|am)/i.test(periodModifier)) {
      sourceForm = 'am_pm_explicit';
    } else {
      sourceForm = 'contextual_explicit';
    }
  } else if (hasHsSuffix || hasExplicitMinutesColon || rawHour > 12) {
    sourceForm = 'explicit_24h';
  } else if (isWordHour) {
    sourceForm = 'ambiguous_12h_word';
  } else {
    sourceForm = 'explicit_24h';
  }

  let hour = rawHour;

  // Handle period modifier (e.g. "de la noche", "de la tarde", "pm", "am")
  if (periodModifier) {
    if (/(?:noche|tarde|pm)/i.test(periodModifier)) {
      if (hour >= 1 && hour <= 11) {
        hour += 12;
      }
    } else if (/(?:mañana|madrugada|am)/i.test(periodModifier)) {
      if (hour === 12) {
        hour = 0;
      }
    }
  }

  if (hour === 24) {
    if (minute === 0) {
      return { hour: 0, minute: 0, dayOffset: 1, sourceForm: 'explicit_24h' };
    }
    return null; // 24:30 is invalid
  }

  if (hour < 0 || hour > 23) {
    return null;
  }

  return { hour, minute, dayOffset: 0, sourceForm };
}

/**
 * Deterministically parses a user response when the active question is time.
 * Supports:
 * - Exact hours: "10", "18", "10:30", "18:45", "10 hs", "10 horas", "a las 10", "a las 18:30"
 * - Numbers in words: "once", "diez", "dieciocho", "veintitrés", "once y media", "once treinta"
 * - Midnight/rollover: "24", "24:00", "24 hs", "medianoche", "veinticuatro", "a la medianoche"
 * - Midday: "mediodia", "al mediodia"
 * - Ranges: "10 a 18", "de 10 a 18", "10-18", "de diez a doce", "diez a dieciocho"
 * - Invalid: "27", "10:99", "abc"
 */
export function parseDeterministicTimeInput(text: string): ParsedTimeInput {
  let cleaned = text.trim();

  // Strip leading affirmative prefix like "sí, ", "dale, ", "ok, "
  cleaned = cleaned.replace(/^(?:s[ií]|dale|ok|bueno),?\s+/i, '').trim();

  // 1. Check named expressions
  if (/^(?:a\s+la\s+)?media\s*noche$/i.test(cleaned)) {
    return { kind: 'exact', time: '00:00', hour: 0, minute: 0, sourceForm: 'explicit_24h', dayOffset: 1 };
  }
  if (/^(?:al?\s+)?medio\s*d[ií]a$/i.test(cleaned)) {
    return { kind: 'exact', time: '12:00', hour: 12, minute: 0, sourceForm: 'explicit_24h', dayOffset: 0 };
  }

  // 2. Check Range expressions (supports digits and words)
  const rangeRegex = /^(?:de\s+)?(?:las\s+)?([a-záéíóúñ0-9:.]+(?:\s+(?:y\s+)?(?:media|cuarto|treinta))?)\s*(?:a|al?|-|hasta)\s*(?:las\s+)?([a-záéíóúñ0-9:.]+(?:\s+(?:y\s+)?(?:media|cuarto|treinta))?)\s*(?:hs?|horas?|hrs?)?$/i;
  const entreRegex = /^entre\s+(?:las\s+)?([a-záéíóúñ0-9:.]+(?:\s+(?:y\s+)?(?:media|cuarto|treinta))?)\s*y\s*(?:las\s+)?([a-záéíóúñ0-9:.]+(?:\s+(?:y\s+)?(?:media|cuarto|treinta))?)\s*(?:hs?|horas?|hrs?)?$/i;

  const rangeMatch = cleaned.match(rangeRegex) || cleaned.match(entreRegex);
  if (rangeMatch) {
    const startToken = parseSingleTimeToken(rangeMatch[1]);
    const endToken = parseSingleTimeToken(rangeMatch[2]);
    if (startToken && endToken) {
      return {
        kind: 'range',
        start: `${pad(startToken.hour)}:${pad(startToken.minute)}`,
        end: `${pad(endToken.hour)}:${pad(endToken.minute)}`,
      };
    }
  }

  // 3. Check Single Time expressions (supports digits, Spanish words, optional modifiers)
  const singleRegex = /^(?:a\s+las?\s+)?([a-záéíóúñ0-9:.]+(?:\s+(?:y\s+)?(?:media|cuarto|treinta|quince|cuarenta\s+y\s+cinco|veinte|diez|cinco))?)(?:\s+(?:hs?|horas?|hrs?))?(?:\s+(de\s+la\s+noche|de\s+la\s+tarde|de\s+la\s+mañana|de\s+la\s+madrugada|am|pm))?$/i;

  const singleMatch = cleaned.match(singleRegex);
  if (singleMatch) {
    const periodModifier = singleMatch[2];
    const parsed = parseSingleTimeToken(singleMatch[1], periodModifier);
    if (parsed) {
      return {
        kind: 'exact',
        time: `${pad(parsed.hour)}:${pad(parsed.minute)}`,
        hour: parsed.hour,
        minute: parsed.minute,
        sourceForm: parsed.sourceForm,
        dayOffset: parsed.dayOffset,
      };
    }
  }

  return { kind: 'invalid', raw: text };
}

export interface ContextualHourResolution {
  resolvedHour: number | null; // null if requires confirmation
  minute: number;
  dayOffset: number;
  requiresConfirmation: boolean;
  questionText?: string;
  options?: string[]; // e.g. ["11:00", "23:00"]
}

/**
 * Resolves contextual AM/PM interpretation or detects semantic conflicts
 * between parsed hour and activity context (Cena, Almuerzo, Desayuno, Merienda, etc.).
 */
export function resolveContextualHour(
  parsedHour: number,
  sourceForm: HourSourceForm,
  draftContext?: { title?: string | null; description?: string | null },
  minute: number = 0,
  dayOffset: number = 0
): ContextualHourResolution {
  // 1. Rollover / midnight / 24:00
  if (parsedHour === 24) {
    return { resolvedHour: 0, minute: 0, dayOffset: 1, requiresConfirmation: false };
  }
  if (parsedHour === 0) {
    return { resolvedHour: 0, minute, dayOffset: dayOffset || 0, requiresConfirmation: false };
  }

  // 2. Explicit AM/PM or contextual modifier (e.g. "11 pm", "11 de la noche")
  if (sourceForm === 'am_pm_explicit' || sourceForm === 'contextual_explicit') {
    return { resolvedHour: parsedHour, minute, dayOffset: 0, requiresConfirmation: false };
  }

  // 3. Hours > 12 are inherently 24h and unambiguous (e.g. 18, 20, 23)
  if (parsedHour > 12) {
    return { resolvedHour: parsedHour, minute, dayOffset: 0, requiresConfirmation: false };
  }

  // 4. Hours 1..12: Check semantic activity context
  const activityText = `${draftContext?.title || ''} ${draftContext?.description || ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const isCena = /\b(cena|cenar|cenita)\b/.test(activityText);
  const isAlmuerzo = /\b(almuerzo|almorzar)\b/.test(activityText);
  const isDesayuno = /\b(desayuno|desayunar)\b/.test(activityText);
  const isMerienda = /\b(merienda|merendar)\b/.test(activityText);

  // A. CENA
  if (isCena) {
    // Evening hours for dinner (7..11)
    if (parsedHour >= 7 && parsedHour <= 11) {
      if (sourceForm === 'explicit_24h') {
        // Explicit daytime 24h contradicts dinner!
        const amStr = `${pad(parsedHour)}:${pad(minute)}`;
        const pmStr = `${pad(parsedHour + 12)}:${pad(minute)}`;
        return {
          resolvedHour: null,
          minute,
          dayOffset: 0,
          requiresConfirmation: true,
          questionText: `¿Querés decir ${amStr} o ${pmStr}? Como es una cena, interpretaría ${pmStr}.`,
          options: [amStr, pmStr],
        };
      }
      // Ambiguous word or number -> resolve to PM (e.g. "once" -> 23:00, "ocho" -> 20:00)
      return {
        resolvedHour: parsedHour + 12,
        minute,
        dayOffset: 0,
        requiresConfirmation: false,
      };
    }
  }

  // B. ALMUERZO
  if (isAlmuerzo) {
    // Hours 1..3 for lunch (13:00..15:00)
    if (parsedHour >= 1 && parsedHour <= 3) {
      if (sourceForm === 'explicit_24h') {
        const amStr = `${pad(parsedHour)}:${pad(minute)}`;
        const pmStr = `${pad(parsedHour + 12)}:${pad(minute)}`;
        return {
          resolvedHour: null,
          minute,
          dayOffset: 0,
          requiresConfirmation: true,
          questionText: `¿Querés decir ${amStr} o ${pmStr}? Como es un almuerzo, interpretaría ${pmStr}.`,
          options: [amStr, pmStr],
        };
      }
      // "una" with Almuerzo -> 13:00
      return {
        resolvedHour: parsedHour + 12,
        minute,
        dayOffset: 0,
        requiresConfirmation: false,
      };
    }
    if (parsedHour === 12) {
      return { resolvedHour: 12, minute, dayOffset: 0, requiresConfirmation: false };
    }
    if (parsedHour === 11) {
      return { resolvedHour: 11, minute, dayOffset: 0, requiresConfirmation: false };
    }
  }

  // C. DESAYUNO
  if (isDesayuno) {
    // Hours 6..11 for breakfast -> stay AM (e.g. "ocho" with Desayuno -> 08:00)
    if (parsedHour >= 6 && parsedHour <= 11) {
      return {
        resolvedHour: parsedHour,
        minute,
        dayOffset: 0,
        requiresConfirmation: false,
      };
    }
  }

  // D. MERIENDA
  if (isMerienda) {
    if (parsedHour >= 4 && parsedHour <= 7) {
      return {
        resolvedHour: parsedHour + 12,
        minute,
        dayOffset: 0,
        requiresConfirmation: false,
      };
    }
  }

  // E. NEUTRAL / AMBIGUOUS (Reunión, Partido, Taller, Asado, or no context)
  // If parsedHour is 1..11 and ambiguous, ask confirmation
  if (parsedHour >= 1 && parsedHour <= 11) {
    if (sourceForm === 'ambiguous_12h_word') {
      const amStr = `${pad(parsedHour)}:${pad(minute)}`;
      const pmStr = `${pad(parsedHour + 12)}:${pad(minute)}`;
      return {
        resolvedHour: null,
        minute,
        dayOffset: 0,
        requiresConfirmation: true,
        questionText: `¿${amStr} o ${pmStr}?`,
        options: [amStr, pmStr],
      };
    }
  }

  // Default: respect parsedHour
  return {
    resolvedHour: parsedHour,
    minute,
    dayOffset: 0,
    requiresConfirmation: false,
  };
}

export interface CompositeEncounterResult {
  title: string;
  date: string; // ISO date or empty string
  baseDate: string;
  time: string | null; // "HH:MM" or null if requires confirmation
  appliedDayRollover?: boolean;
  requiresConfirmation: boolean;
  questionText?: string;
  quickOptions?: Array<{ label: string; value: string }>;
  modality?: 'presencial' | 'virtual' | null;
  locationText?: string | null;
  virtualLink?: string | null;
}

/**
 * Deterministically parses full statements containing activity + date + time,
 * such as "Cena mañana a las once", "Cena mañana a las 11 hs", "Cena mañana a las 11 pm".
 */
export function parseCompositeEncounterInput(text: string): CompositeEncounterResult | null {
  const clean = text.trim();

  // 1. Match activity at start
  const activityMatch = clean.match(/^(?:un[a]?\s+)?(cena|almuerzo|desayuno|merienda|reuni[oó]n|asado|taller|partido|caf[eé]|cumpleaños|salida|evento)\b/i);
  if (!activityMatch) return null;

  const title = activityMatch[1].charAt(0).toUpperCase() + activityMatch[1].slice(1).toLowerCase();

  const rest = clean.slice(activityMatch[0].length).trim();

  // 2. Match date keyword: "mañana", "hoy", "el 12"
  let dateIso: string | null = null;
  let restAfterDate = rest;

  if (/\b(?:mañana|de\s+mañana)\b/i.test(rest)) {
    const res = resolveDateIntent({ type: 'relative', value: 'tomorrow' });
    if (res.resolved && res.date) dateIso = res.date;
    restAfterDate = rest.replace(/\b(?:mañana|de\s+mañana)\b/i, '').trim();
  } else if (/\bhoy\b/i.test(rest)) {
    const res = resolveDateIntent({ type: 'relative', value: 'today' });
    if (res.resolved && res.date) dateIso = res.date;
    restAfterDate = rest.replace(/\bhoy\b/i, '').trim();
  } else {
    const dayMatch = rest.match(/\bel\s+(\d{1,2})\b/i);
    if (dayMatch) {
      const dayNum = Number(dayMatch[1]);
      const res = resolveDateIntent({ type: 'absolute', day: dayNum });
      if (res.resolved && res.date) {
        dateIso = res.date;
        restAfterDate = rest.replace(dayMatch[0], '').trim();
      }
    }
  }

  // 3. Extract optional trailing location ("en casa", "en Antares", etc.) or platform ("por Meet", "por Zoom")
  let timeStr = restAfterDate;
  let trailingLocation: string | null = null;
  let trailingVirtual: string | null = null;

  const virtualMatch = restAfterDate.match(/\s+por\s+(meet|zoom|teams|videollamada|discord|google\s+meet)\b/i);
  if (virtualMatch && virtualMatch.index !== undefined) {
    trailingVirtual = virtualMatch[1].trim();
    timeStr = restAfterDate.slice(0, virtualMatch.index).trim();
  } else {
    const locMatch = restAfterDate.match(/\s+en\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s]+)$/i);
    if (locMatch && locMatch.index !== undefined) {
      trailingLocation = locMatch[1].trim();
      timeStr = restAfterDate.slice(0, locMatch.index).trim();
    }
  }

  // 4. Match time expression
  const timeParsed = parseDeterministicTimeInput(timeStr);
  if (timeParsed.kind !== 'exact') return null;

  // 5. Contextual hour resolution with activity title
  const contextualRes = resolveContextualHour(
    timeParsed.hour,
    timeParsed.sourceForm,
    { title },
    timeParsed.minute,
    timeParsed.dayOffset || 0
  );

  let finalDate = dateIso || '';
  let appliedRollover = false;
  if (contextualRes.dayOffset && dateIso) {
    finalDate = addDaysToIsoDate(dateIso, contextualRes.dayOffset);
    appliedRollover = true;
  }

  // 6. Infer modality from context
  const modalityInferred = inferModalityFromContext({
    title,
    locationText: trailingLocation,
    virtualLink: trailingVirtual,
    userPrompt: text,
  });

  if (contextualRes.requiresConfirmation) {
    return {
      title,
      date: dateIso || '',
      baseDate: dateIso || '',
      time: null,
      appliedDayRollover: appliedRollover,
      requiresConfirmation: true,
      questionText: contextualRes.questionText,
      quickOptions: contextualRes.options?.map((opt) => ({ label: opt, value: opt })),
      modality: modalityInferred.modality,
      locationText: trailingLocation,
      virtualLink: trailingVirtual,
    };
  }

  const finalTime = `${pad(contextualRes.resolvedHour!)}:${pad(contextualRes.minute)}`;
  return {
    title,
    date: finalDate,
    baseDate: dateIso || '',
    time: finalTime,
    appliedDayRollover: appliedRollover,
    requiresConfirmation: false,
    modality: modalityInferred.modality,
    locationText: trailingLocation,
    virtualLink: trailingVirtual,
  };
}

/**
 * Detects whether user input represents an explicit edit or intention for another draft field
 * (date, modality, location, theme, or title).
 * Used when the active question is time to safely escape the deterministic time parser
 * and delegate to the general LLM / domain flow instead of showing an invalid time error.
 */
export function looksLikeOtherFieldIntent(text: string): boolean {
  const clean = text.trim();

  // 1. Date intent
  // Bare numbers like "10", "18", "27" are potential hour inputs, not date edits
  const isBareNumber = /^\d{1,2}(?::\d{2})?$/.test(clean);
  if (!isBareNumber) {
    const parsedDate = parseDeterministicDateIntent(clean);
    if (parsedDate && parsedDate.type !== 'absolute') {
      return true;
    }
    if (parsedDate && parsedDate.type === 'absolute' && (/^(?:el\s+)/i.test(clean) || /\bde\b/i.test(clean))) {
      return true;
    }
  }
  if (
    /\b(mañana|hoy|pasado\s+mañana|este\s+finde|fin\s+de\s+semana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday|primer|primero|segundo|tercer|cuarto|quinto|ultimo|último|próximo|proximo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/i.test(
      clean
    )
  ) {
    return true;
  }

  // 2. Modality intent
  if (
    /\b(virtual|presencial|en\s+persona|online|remoto|videollamada|zoom|meet|teams)\b/i.test(
      clean
    )
  ) {
    return true;
  }

  // 3. Location intent (e.g. "en casa", "en la oficina", starts with "en ", or location nouns)
  if (
    /^en\s+/i.test(clean) ||
    /\b(lugar|direcci[oó]n|ubicaci[oó]n|calle|avenida)\b/i.test(clean)
  ) {
    return true;
  }

  // 4. Theme / Template intent
  if (
    /\b(tema|diseño|diseno|plantilla|estilo|color|colores|variante|variantes)\b/i.test(
      clean
    )
  ) {
    return true;
  }

  // 5. Title / Description intent
  if (
    /\b(t[ií]tulo|titulo|nombre|llamalo|ponele|descripci[oó]n|descripcion)\b/i.test(
      clean
    )
  ) {
    return true;
  }

  // 6. Generic modification verbs without numbers
  if (
    /^(?:cambi[aá]|pas[aá]|pon[eé]|modific[aá]|sac[aá]|borr[aá]|edit[aá]|mejor|prefiero|quiero|hacelo|hagamos)\b/i.test(
      clean
    ) &&
    !/\d/.test(clean)
  ) {
    return true;
  }

  return false;
}

/**
 * Detects whether a text contains explicit date mentions (month names, relative date words,
 * weekday names, day-of-month indicators like "el 23", "\d{1,2}/\d{1,2}", etc.).
 * Used to avoid mistakenly classifying compound instructions as time-only queries.
 */
export function hasExplicitDateTokens(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const clean = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  return (
    /\b(hoy|manana|pasado\s+manana|este\s+finde|fin\s+de\s+semana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/i.test(
      clean
    ) ||
    /\b(?:el\s+)?(?:[1-9]|[12]\d|3[01])\s+de\s+[a-z]+\b/i.test(clean) ||
    /\bel\s+(?:[1-9]|[12]\d|3[01])\b/i.test(clean) ||
    /\b\d{1,2}\s*[\/\-]\s*\d{1,2}\b/.test(clean) ||
    /\b(?:proximo|proxima|este|esta)\s+(?:finde|semana|mes)\b/i.test(clean)
  );
}

export interface ParsedDateOption {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  rawText?: string;
  appliedDayRollover?: boolean;
}

export interface ParsedCoordinationResult {
  isCoordinationCandidate: boolean;
  hasExplicitCoordinationIntent: boolean;
  options: ParsedDateOption[];
  invalidPastOptions: Array<{ raw: string; reason: string }>;
  extractedTitle?: string;
  extractedLocation?: string;
  extractedModality?: 'presencial' | 'virtual';
  extractedDurationMinutes?: number;
  extractedDeadline?: string;
  totalAlternativesFound: number;
  pendingTimeOptions?: string[];
  timeAmbiguity?: { questionText: string; options?: string[] };
}

function normalizeCoordText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Deterministically parses natural language input with multiple date alternatives
 * for simple coordination (2-3 options, common title/place, shared or individual times).
 */
export function parseNaturalLanguageDateOptions(
  text: string,
  baseDateParts: { year: number; month: number; day: number } = getArgentinaDateTimeParts(),
  fallbackDate?: string | null
): ParsedCoordinationResult {
  const result: ParsedCoordinationResult = {
    isCoordinationCandidate: false,
    hasExplicitCoordinationIntent: false,
    options: [],
    invalidPastOptions: [],
    totalAlternativesFound: 0,
  };

  if (!text || typeof text !== 'string') return result;
  const clean = text.trim();

  // 1. Check explicit coordination intent keywords
  const explicitRegex =
    /\b(?:quiero\s+que\s+(?:los\s+invitados\s+)?(?:pued[ae]n\s+)?(?:elegir|elijan|votar|voten)|que\s+(?:los\s+invitados\s+)?(?:pued[ae]n\s+)?(?:elegir|elijan|votar|voten)|(?:elegir|elijan|votar|voten)\s+entre|coordinemos\s+entre|coordinar\s+entre|coordinemos|coordinar\s+fechas|a\s+votaci[oó]n|opciones\s+para\s+votar|para\s+coordinar|(?:as[íi]\s+|para\s+que\s+|que\s+)(?:cada\s+uno|todos|los\s+invitados)\s+(?:pued[ae]n\s+)?(?:indique[n]?|indicar|diga[n]?|decir|elija[n]?|elegir|vote[n]?|votar)|indique[n]?\s+(?:cu[aá]ndo|cu[aá]l)|(?:para\s+)?ver\s+cu[aá]ndo\s+puede|(?:para\s+)?ver\s+qu[eé]\s+(?:prefiere|eligen|sale)|propongamos|proponer|despu[eé]s\s+decid(?:imos|ir))\b/i;
  result.hasExplicitCoordinationIntent = explicitRegex.test(clean);

  // 2. Check duration
  const durationMatch = clean.match(
    /\b(?:durante|por|de)\s+(\d+|una|un|dos|tres|cuatro|cinco)\s*(h|hs|hora|horas|min|minutos)\b/i
  );
  if (durationMatch) {
    const rawVal = durationMatch[1].toLowerCase();
    const unit = durationMatch[2].toLowerCase();
    let num = 0;
    if (rawVal === 'un' || rawVal === 'una') num = 1;
    else if (rawVal === 'dos') num = 2;
    else if (rawVal === 'tres') num = 3;
    else if (rawVal === 'cuatro') num = 4;
    else if (rawVal === 'cinco') num = 5;
    else num = parseInt(rawVal, 10);

    if (unit.startsWith('h')) {
      result.extractedDurationMinutes = num * 60;
    } else {
      result.extractedDurationMinutes = num;
    }
  }

  // 3. Extract activity/title if present at start or after organize verbs or within explicit coordination
  const activityMatch = clean.match(
    /\b(?:un[a]?\s+)?(cena|cenar|cenemos|almuerzo|almorzar|almorcemos|desayuno|desayunar|desayunamos|merienda|merendar|merendemos|reuni[oó]n|asado|taller|partido|caf[eé]|cumpleaños|salida|evento|juntada)\b/i
  );
  if (activityMatch) {
    const rawWord = activityMatch[1].toLowerCase();
    if (/^cen/i.test(rawWord)) result.extractedTitle = 'Cena';
    else if (/^almorz|^almuer/i.test(rawWord)) result.extractedTitle = 'Almuerzo';
    else if (/^desayun/i.test(rawWord)) result.extractedTitle = 'Desayuno';
    else if (/^merend|^merien/i.test(rawWord)) result.extractedTitle = 'Merienda';
    else if (/^reuni/i.test(rawWord)) result.extractedTitle = 'Reunión';
    else if (/^junt/i.test(rawWord)) result.extractedTitle = 'Juntada';
    else result.extractedTitle = rawWord.charAt(0).toUpperCase() + rawWord.slice(1);
  }

  // 4. Extract common location
  // NOTE: use \b before the disjunctive 'o'/'u' to avoid matching the 'o' inside month names like "octubre".
  // Also stop at a comma or the word "para/el/la..." to prevent consuming date text after the location.
  const locMatch = clean.match(/\ben\s+([a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s]+?)(?:\s*[,.]|\s+(?:para\b|el\b|la\b|los\b|las\b|\bo\b|\bu\b|durante|por|con)|\s*$)/i);
  if (locMatch) {
    const locCandidate = locMatch[1].trim();
    if (!/^(?:el|la|los|las|un|una|este|esta|otro|otra)$/i.test(locCandidate)) {
      result.extractedLocation = locCandidate;
      result.extractedModality = 'presencial';
    }
  }

  // 5. Splitting alternatives
  let workText = clean;
  workText = workText.replace(
    /^(?:quiero\s+organizar\s+(?:un[a]?\s+)?[a-z]+\s+y\s+)?(?:quiero\s+que\s+(?:los\s+invitados\s+)?(?:puedan\s+)?(?:elegir|elijan|votar|voten)|que\s+(?:los\s+invitados\s+)?(?:puedan\s+)?(?:elegir|elijan|votar|voten)|elegir\s+entre|coordinemos\s+entre|coordinar\s+entre|coordinemos|coordinar\s+fechas|podemos\s+juntarnos)\s*(?:si\s+)?(?:entre\s+)?/i,
    ''
  );

  if (result.extractedTitle) {
    workText = workText.replace(
      /\b(?:para\s+)?(?:organizar|hacer|armar|tener)?\s*(?:un[a]?\s+)?(?:cena|cenar|cenemos|almuerzo|almorzar|almorcemos|desayuno|desayunar|desayunamos|merienda|merendar|merendemos|reuni[oó]n|asado|taller|partido|caf[eé]|cumpleaños|salida|evento|juntada)\b/i,
      ''
    ).trim();
  }

  if (result.extractedLocation) {
    workText = workText.replace(new RegExp('\\ben\\s+' + result.extractedLocation + '\\b', 'i'), '').trim();
  }

  if (durationMatch) {
    workText = workText.replace(durationMatch[0], '').trim();
  }

  let rawSegments: string[] = [];

  const entreMatch = workText.match(/\bentre\s+(.+?)\s+y\s+(.+)$/i);
  if (entreMatch) {
    rawSegments = [entreMatch[1].trim(), entreMatch[2].trim()];
  } else if (/\s+(?:o|u|o\s+bien)\s+/i.test(workText)) {
    const parts = workText.split(/\s+(?:o|u|o\s+bien)\s+/i);
    for (let i = 0; i < parts.length; i++) {
      const sub = parts[i].split(/\s*,\s*(?=(?:el\s+\d|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo|\d{1,2}(?::\d{2})?|a\s+las?\s+\d|tipo\s+\d))/i);
      rawSegments.push(...sub.map((s) => s.trim()).filter(Boolean));
    }
  } else {
    return result;
  }

  result.totalAlternativesFound = rawSegments.length;
  if (rawSegments.length < 2) return result;

  // 6. Parse each raw segment into a date and time
  const parsedCandidates: Array<{
    date: string | null;
    time: string | null;
    raw: string;
    isPast?: boolean;
    appliedDayRollover?: boolean;
  }> = [];

  let globalTime: string | null = null;
  let globalDate: string | null = null;

  for (const seg of rawSegments) {
    let cleanSeg = seg.trim();

    // Strip trailing conversational clauses that appear after a comma, period or conversational conjunction
    // and contain no date/time tokens. Examples: ", para que cada uno indique cuándo puede",
    // ", así todos pueden elegir", " para ver qué prefiere la mayoría", ". Mensaje para los invitados: ...".
    // A date/time token is: a weekday name, a digit-day (el 17), a month name,
    // "las" / "hs" / "horas", or a bare HH:MM pattern.
    cleanSeg = cleanSeg.replace(
      /(?:,\s*|\.\s*|\s+para\s+ver\s+|\s+para\s+que\s+|\s+as[íi]\s+que\s+)(?![^,]*(?:\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\b(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b|\bel\s+\d|\b\d{1,2}:\d{2}\b|\ba\s+las?\s+\d|\blas?\s+\d|\b\d{1,2}\s*(?:hs|horas)\b)).+$/i,
      ''
    ).trim();

    // Strip trailing location suffix (e.g. "en mi casa") that may remain after the split
    cleanSeg = cleanSeg.replace(/\ben\s+[a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s]+$/i, '').trim();

    let segTime: string | null = null;
    let timeDayOffset = 0;

    const timeMatch = cleanSeg.match(
      /\b(?:a\s+las?|tipo|alrededor\s+de\s+las?)\s+([^\s,]+(?:\s+(?:de\s+la\s+(?:noche|tarde|mañana)|am|pm|hs|horas))?)/i
    ) || cleanSeg.match(/\b(\d{1,2}(?::\d{2})?)\s*(?:hs|horas)\b/i)
      || cleanSeg.match(/\b(\d{1,2}:\d{2})\b/);

    if (timeMatch) {
      const parsedTime = parseDeterministicTimeInput(timeMatch[0]);
      if (parsedTime.kind === 'exact') {
        if (result.extractedTitle) {
          const contextual = resolveContextualHour(
            parsedTime.hour,
            parsedTime.sourceForm,
            { title: result.extractedTitle },
            parsedTime.minute,
            parsedTime.dayOffset || 0
          );
          if (contextual.resolvedHour !== null) {
            segTime = `${pad(contextual.resolvedHour)}:${pad(contextual.minute)}`;
            timeDayOffset = contextual.dayOffset || 0;
          } else if (contextual.requiresConfirmation) {
            segTime = `${pad(parsedTime.hour)}:${pad(parsedTime.minute)}`;
            if (!result.timeAmbiguity) {
              result.timeAmbiguity = {
                questionText: contextual.questionText || '',
                options: contextual.options,
              };
            }
          } else {
            segTime = parsedTime.time;
            timeDayOffset = parsedTime.dayOffset ?? 0;
          }
        } else {
          segTime = parsedTime.time;
          timeDayOffset = parsedTime.dayOffset ?? 0;
        }
      }
      cleanSeg = cleanSeg.replace(timeMatch[0], '').trim();
    } else {
      const directTime = parseDeterministicTimeInput(cleanSeg);
      if (directTime.kind === 'exact') {
        if (result.extractedTitle) {
          const contextual = resolveContextualHour(
            directTime.hour,
            directTime.sourceForm,
            { title: result.extractedTitle },
            directTime.minute,
            directTime.dayOffset || 0
          );
          if (contextual.resolvedHour !== null) {
            segTime = `${pad(contextual.resolvedHour)}:${pad(contextual.minute)}`;
            timeDayOffset = contextual.dayOffset || 0;
          } else if (contextual.requiresConfirmation) {
            segTime = `${pad(directTime.hour)}:${pad(directTime.minute)}`;
            if (!result.timeAmbiguity) {
              result.timeAmbiguity = {
                questionText: contextual.questionText || '',
                options: contextual.options,
              };
            }
          } else {
            segTime = directTime.time;
            timeDayOffset = directTime.dayOffset ?? 0;
          }
        } else {
          segTime = directTime.time;
          timeDayOffset = directTime.dayOffset ?? 0;
        }
        cleanSeg = '';
      } else {
        const trailingHourMatch = cleanSeg.match(/\b(?:el\s+)?([a-zA-ZáéíóúÁÉÍÓÚñÑ]+)\s+(\d{1,2})\b$/i);
        if (trailingHourMatch) {
          const word = trailingHourMatch[1].toLowerCase();
          const num = parseInt(trailingHourMatch[2], 10);
          const isWk = normalizeToCanonicalWeekday(word);
          if (isWk && num >= 1 && num <= 24) {
            const hour24 = num >= 1 && num <= 7 ? num + 12 : num === 24 ? 0 : num;
            segTime = `${String(hour24).padStart(2, '0')}:00`;
            if (num === 24) timeDayOffset = 1;
            cleanSeg = trailingHourMatch[1];
          }
        }
      }
    }

    if (segTime) {
      globalTime = segTime;
    }

    cleanSeg = cleanSeg.replace(/\b(?:horas|hs|de\s+la\s+noche|de\s+la\s+tarde|de\s+la\s+mañana)\b/gi, '').trim();

    // Strip leading conversational prefix before the first temporal token.
    // After the time is stripped, cleanSeg should start at the date token (e.g. "el 17 de octubre").
    // Residual text like "con amigos. podría ser el 17 de octubre" must be trimmed to "el 17 de octubre"
    // so that parseDeterministicDateIntent can find the date.
    cleanSeg = cleanSeg.replace(
      /^(?:.*?)(?=\b(?:el\s+\d|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[ñn]ana|pasado\s+ma[ñn]ana|pr[oó]ximo\s+|esta\s+semana|este\s+|el\s+pr[oó]ximo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|\d{1,2}\s*\/\s*\d{1,2}|ayer\b))/i,
      ''
    ).trim();

    let segDate: string | null = null;
    let isPast = false;

    if (/^ayer$/i.test(cleanSeg) || /^el\s+dia\s+de\s+ayer$/i.test(cleanSeg)) {
      isPast = true;
      segDate = addDaysToIsoDate(toIsoDate(baseDateParts.year, baseDateParts.month, baseDateParts.day), -1);
    } else if (cleanSeg) {
      const dateRes = parseDeterministicDateIntent(cleanSeg);
      if (dateRes) {
        const resolved = resolveDateIntent(dateRes, baseDateParts);
        if (resolved.resolved && resolved.date) {
          segDate = resolved.date;
        }
        if (resolved.isPast) {
          isPast = true;
        }
      }
    }

    if (segDate && !globalDate) {
      globalDate = segDate;
    }

    parsedCandidates.push({
      date: segDate,
      time: segTime,
      raw: seg.trim(),
      isPast,
      appliedDayRollover: timeDayOffset === 1,
    });
  }

  // Propagate date across segments if one segment had a date or fallbackDate was provided
  const effectiveDate = globalDate || fallbackDate || null;
  if (effectiveDate) {
    for (const c of parsedCandidates) {
      if (!c.date) {
        c.date = effectiveDate;
      }
    }
  }

  // Propagate shared time across candidates if some had none
  for (const c of parsedCandidates) {
    if (!c.time && globalTime) {
      c.time = globalTime;
    }
  }

  const uniqueKeys = new Set<string>();

  for (const c of parsedCandidates) {
    if (!c.date) continue;
    const finalTime = c.time || '20:00';
    let finalDate = c.date;

    if (c.appliedDayRollover) {
      finalDate = addDaysToIsoDate(finalDate, 1);
    }

    const isInFuture = !c.isPast && validateResolvedDateTimeInFuture(finalDate, finalTime);

    if (!isInFuture || c.isPast) {
      result.invalidPastOptions.push({
        raw: c.raw,
        reason: `La opción '${c.raw}' ya pasó.`,
      });
    } else {
      const key = `${finalDate}_${finalTime}`;
      if (!uniqueKeys.has(key)) {
        uniqueKeys.add(key);
        result.options.push({
          date: finalDate,
          time: finalTime,
          rawText: c.raw,
          appliedDayRollover: c.appliedDayRollover,
        });
      }
    }
  }

  result.options.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

  if (
    result.options.length >= 2 ||
    (result.options.length === 1 && result.invalidPastOptions.length > 0) ||
    result.hasExplicitCoordinationIntent
  ) {
    result.isCoordinationCandidate = true;
  }

  // If no date was resolved anywhere, evaluate pending time alternatives
  if (!effectiveDate && result.options.length === 0) {
    const uniqueTimes: string[] = [];
    for (const c of parsedCandidates) {
      if (c.time && !uniqueTimes.includes(c.time)) {
        uniqueTimes.push(c.time);
      }
    }
    uniqueTimes.sort((a, b) => a.localeCompare(b));

    if (uniqueTimes.length >= 2) {
      result.pendingTimeOptions = uniqueTimes;
      result.isCoordinationCandidate = true;
    }
  }

  return result;
}

/**
 * Parses user modifications, additions, deletions or switch-to-fixed requests
 * for an ongoing coordination encounter.
 */
export function parseCoordinationTransition(
  text: string,
  currentDraft?: {
    dateMode?: 'fixed' | 'coordination' | null;
    date?: string | null;
    time?: string | null;
    dateOptions?: Array<{ date: string; time: string }> | null;
  } | null,
  baseDateParts: { year: number; month: number; day: number } = getArgentinaDateTimeParts()
): {
  type: 'add' | 'remove' | 'modify' | 'switch_to_fixed' | 'change_fixed' | 'ambiguous_switch' | 'none';
  addedOption?: { date: string; time: string };
  removedOptionDate?: string;
  modifiedOption?: { date: string; time: string };
  selectedFixedOption?: { date: string; time: string };
  changedFixedOption?: { date: string; time: string };
  position?: number;
  ambiguousOptions?: Array<{ date: string; time: string }>;
  clarificationReason?: string;
} {
  const clean = text.trim();
  const safeDraft = currentDraft || { dateMode: null, date: null, time: null, dateOptions: null };

  // 0. Negative guards: Questions and Speculative utterances must NEVER switch to fixed!
  if (clean.includes('?') || clean.includes('¿')) {
    return { type: 'none' };
  }
  if (/\b(?:quiz[aá]s|tal\s+vez|puede\s+ser|a\s+lo\s+mejor|capaz|qu[eé]\s+opci[oó]n|cu[aá]l\s+(?:opci[oó]n|conviene))\b/i.test(clean)) {
    return { type: 'none' };
  }

  // 1. Positional switch: "la primera", "opción 1", "me quedo con la segunda", etc.
  if (safeDraft.dateOptions && safeDraft.dateOptions.length > 0) {
    const posPattern = /^(?:(?:mejor\s+)?(?:dejemos|dej[aá]|me\s+quedo\s+con|qued[eé]monos\s+con|confirm[aá](?:mos)?|fij[aá](?:mos)?|eleg[ií](?:mos)?|prefiero|va|vamos\s+con)\s+)?(?:directamente\s+)?(?:la\s+)?(primera|segunda|tercera|[uú]ltima|opci[oó]n\s+[123]|1|2|3)(?:\s+opci[oó]n)?(?:\s+(?:como\s+fecha\s+fija|como\s+fija))?$/i;
    const posMatch = clean.match(posPattern);
    if (posMatch) {
      const pRaw = posMatch[1].toLowerCase().replace(/^opci[oó]n\s+/, '');
      let idx = -1;
      if (pRaw === 'primera' || pRaw === '1') idx = 0;
      else if (pRaw === 'segunda' || pRaw === '2') idx = 1;
      else if (pRaw === 'tercera' || pRaw === '3') idx = 2;
      else if (pRaw === 'última' || pRaw === 'ultima') idx = safeDraft.dateOptions.length - 1;

      if (idx >= 0 && idx < safeDraft.dateOptions.length) {
        return {
          type: 'switch_to_fixed',
          position: idx,
          selectedFixedOption: safeDraft.dateOptions[idx],
        };
      }
    }
  }

  // 2. Switch to fixed with semantic prefixes / finality / exclusivity markers:
  const SWITCH_PREFIX_REGEX = /^(?:(?:no\s+coordinemos(?:\s+m[aá]s)?|cancel[aá]\s+la\s+coordinaci[oó]n|sin\s+coordinar)[,\s]*(?:lo\s+hacemos|ser[aá]|va)?|(?:descart[aá]|borr[aá]|sac[aá])\s+(?:las\s+otras|las\s+dem[aá]s)\s+y\s+(?:dej[aá]|dejemos)|(?:mejor\s+)?(?:s[oó]lo|solamente|[uú]nicamente)(?:\s+(?:ser[aá]|va|es))?|al\s+final(?:\s+(?:ser[aá]|va|es))?|finalmente(?:\s+(?:ser[aá]|va|es))?|ser[aá]\s+(?:s[oó]lo|solamente|[uú]nicamente)|(?:dejemos|dej[aá])(?:\s+(?:s[oó]lo|solamente|[uú]nicamente))?|queda(?:\s+(?:fijo|fija|definitivo|definitiva|cerrado|cerrada|confirmado|confirmada))?|qued[eé]monos\s+con|me\s+quedo\s+con|(?:confirm[aáeé](?:mos)?|confirmar|confirmo)|(?:fij[aáeé](?:mos)?|fijar|fijo)|(?:defin[iíaá](?:mos)?|definir|defino)|(?:decid[iíaá](?:mos)?|decidir|decido)|(?:eleg[ií]|elij[aá](?:mos)?|elegir|elijo)|prefiero|(?:cerremos\s+con|cerr[aá]\s+con)|(?:hag[aá]moslo|lo\s+hacemos|hacerlo)|(?:listo[,\s]+)?va|vamos\s+con)(?::|\s|$)[:\s]*/i;

  if (SWITCH_PREFIX_REGEX.test(clean)) {
    let rest = clean.replace(SWITCH_PREFIX_REGEX, '').trim();
    rest = rest.replace(/^(?:ser[aá]|va|es|lo\s+hacemos|la\s+del?|la\s+de|la|el|del?|para\s+el?|al?)\s+/i, '').trim();

    // Check positional within rest (e.g. "dejemos la primera", "confirmemos la opción 2")
    if (safeDraft.dateOptions && safeDraft.dateOptions.length > 0) {
      const posMatch = rest.match(/^(?:opci[oó]n\s+)?(primera|segunda|tercera|[uú]ltima|1|2|3)(?:\s+opci[oó]n)?$/i);
      if (posMatch) {
        const pRaw = posMatch[1].toLowerCase().replace(/^opci[oó]n\s+/, '');
        let idx = -1;
        if (pRaw === 'primera' || pRaw === '1') idx = 0;
        else if (pRaw === 'segunda' || pRaw === '2') idx = 1;
        else if (pRaw === 'tercera' || pRaw === '3') idx = 2;
        else if (pRaw === 'última' || pRaw === 'ultima') idx = safeDraft.dateOptions.length - 1;

        if (idx >= 0 && idx < safeDraft.dateOptions.length) {
          return {
            type: 'switch_to_fixed',
            position: idx,
            selectedFixedOption: safeDraft.dateOptions[idx],
          };
        }
      }
    }

    // Extract time if present
    let extractedTime: string | null = null;
    let textWithoutTime = rest;

    const timeMatch =
      rest.match(/(?:a\s+las?|para\s+las?)\s+([a-záéíóúñ0-9:.]+(?:\s+(?:y\s+)?(?:media|cuarto|treinta|quince|veinte|diez|cinco))?(?:\s*(?:hs?|horas?|hrs?))?(?:\s+(?:de\s+la\s+noche|de\s+la\s+tarde|de\s+la\s+mañana|am|pm))?)/i) ||
      rest.match(/\b([0-9]{1,2}(?::[0-9]{2})?)\s*(?:hs|horas|hrs)\b/i) ||
      rest.match(/\b([0-9]{1,2}:[0-9]{2})\b/i);

    if (timeMatch) {
      const tParsed = parseDeterministicTimeInput(timeMatch[1] || timeMatch[0]);
      if (tParsed.kind === 'exact') {
        extractedTime = tParsed.time;
        textWithoutTime = rest.replace(timeMatch[0], '').replace(/^(?:ser[aá]|va|es|lo\s+hacemos|la\s+del?|la\s+de|la|el|del?|para\s+el?|al?)\s+/i, '').trim();
      }
    }

    // Extract date if present
    let targetIso: string | null = null;
    let targetWeekdayName: string | null = null;

    if (textWithoutTime) {
      const dateIntent = parseDeterministicDateIntent(textWithoutTime);
      if (dateIntent) {
        if (dateIntent.type === 'weekday') {
          targetWeekdayName = normalizeCoordText(dateIntent.weekday);
        }
        const r = resolveDateIntent(dateIntent, baseDateParts);
        if (r.resolved && r.date) {
          targetIso = r.date;
        }
      }
    }

    // Matching against existing dateOptions
    if (safeDraft.dateOptions && safeDraft.dateOptions.length > 0) {
      const matches = safeDraft.dateOptions.filter((opt) => {
        if (targetIso && opt.date !== targetIso) return false;

        if (!targetIso && targetWeekdayName) {
          const optDateObj = new Date(opt.date + 'T12:00:00Z');
          const dayIdx = optDateObj.getUTCDay();
          const wkInfo = Object.values(WEEKDAY_MAPPING).find((w) => w.dayIndex === dayIdx);
          if (!wkInfo || normalizeCoordText(wkInfo.nameEs) !== targetWeekdayName) return false;
        }

        if (extractedTime && opt.time !== extractedTime) return false;

        return true;
      });

      // Ambiguity Check (Req 5): multiple options match
      if (matches.length > 1) {
        return {
          type: 'ambiguous_switch',
          ambiguousOptions: matches,
          clarificationReason: targetIso || targetWeekdayName
            ? 'Hay más de una opción en esa fecha. ¿A qué hora te referís?'
            : 'Hay más de una opción en ese horario. ¿Para qué día te referís?',
        };
      }

      // Exactly 1 match in dateOptions
      if (matches.length === 1) {
        const matched = matches[0];
        const pos = safeDraft.dateOptions.findIndex(
          (o) => o.date === matched.date && o.time === matched.time
        );
        return {
          type: 'switch_to_fixed',
          position: pos >= 0 ? pos : undefined,
          selectedFixedOption: {
            date: matched.date,
            time: extractedTime || matched.time,
          },
        };
      }

      // 0 matches in dateOptions, but valid new date + time specified (Req 6)
      if (targetIso && extractedTime) {
        if (validateResolvedDateTimeInFuture(targetIso, extractedTime)) {
          return {
            type: 'switch_to_fixed',
            selectedFixedOption: {
              date: targetIso,
              time: extractedTime,
            },
          };
        }
      }
    } else if (targetIso) {
      const finalTime = extractedTime || '20:00';
      if (validateResolvedDateTimeInFuture(targetIso, finalTime)) {
        return {
          type: 'switch_to_fixed',
          selectedFixedOption: {
            date: targetIso,
            time: finalTime,
          },
        };
      }
    }
  }

  // B. Remove option: "sacá la opción del viernes", "sacá la del viernes", "eliminá el viernes", "borrá el sábado"
  const removeMatch = clean.match(
    /^(?:sac[aá]|elimin[aá]|borr[aá]|quit[aá])(?:\s+(?:la\s+opci[oó]n|la|el|del?|de\s+la))*\s+([a-zA-ZáéíóúÁÉÍÓÚñÑ]+|\d{1,2}(?:\s+de\s+[a-zA-Z]+)?)\b/i
  );
  if (removeMatch) {
    const target = normalizeCoordText(removeMatch[1]);
    const dateRes = parseDeterministicDateIntent(removeMatch[1]);
    let targetIso: string | null = null;
    if (dateRes) {
      const r = resolveDateIntent(dateRes, baseDateParts);
      if (r.resolved && r.date) targetIso = r.date;
    }

    if (safeDraft.dateOptions && safeDraft.dateOptions.length > 0) {
      const matches = safeDraft.dateOptions.filter((opt) => {
        if (targetIso && opt.date === targetIso) return true;
        const optDateObj = new Date(opt.date + 'T12:00:00Z');
        const dayIdx = optDateObj.getUTCDay();
        const wkInfo = Object.values(WEEKDAY_MAPPING).find((w) => w.dayIndex === dayIdx);
        if (wkInfo && normalizeCoordText(wkInfo.nameEs) === target) return true;
        return false;
      });

      if (matches.length > 1) return { type: "none" };
      if (matches.length === 1) {
        const matched = matches[0];
        return { type: 'remove', removedOptionDate: matched.date };
      }
    }

    if (targetIso) {
      return { type: 'remove', removedOptionDate: targetIso };
    }
  }

  // C. Modify option: "cambiá sábado a las 22", "cambiá el viernes a las 20"
  const modifyMatch = clean.match(
    /^(?:cambi[aá]|pas[aá])(?:\s+la\s+opci[oó]n)?(?:\s+del?|\s+el)?\s+([a-zA-ZáéíóúÁÉÍÓÚñÑ]+)\s+(?:a\s+las?|para\s+las?)\s+(.+)$/i
  );
  if (modifyMatch && safeDraft.dateOptions && safeDraft.dateOptions.length > 0) {
    const targetDay = normalizeCoordText(modifyMatch[1]);
    const timeParsed = parseDeterministicTimeInput(modifyMatch[2]);
    if (timeParsed.kind === 'exact') {
      const matches = safeDraft.dateOptions.filter((opt) => {
        const optDateObj = new Date(opt.date + 'T12:00:00Z');
        const dayIdx = optDateObj.getUTCDay();
        const wkInfo = Object.values(WEEKDAY_MAPPING).find((w) => w.dayIndex === dayIdx);
        if (wkInfo && normalizeCoordText(wkInfo.nameEs) === targetDay) return true;
        return false;
      });
      if (matches.length > 1) return { type: "none" };
      if (matches.length === 1) {
        const matched = matches[0];
        return {
          type: 'modify',
          modifiedOption: { date: matched.date, time: timeParsed.time },
        };
      }
    }
  }

  // D. Add alternative option:
  // Only applies when there is an existing schedule in the draft to add alternatives to!
  const hasExistingSchedule =
    currentDraft === undefined ||
    Boolean(
      (safeDraft.date && safeDraft.time) ||
      (safeDraft.dateOptions && safeDraft.dateOptions.length > 0)
    );
  if (hasExistingSchedule) {
    const addMatch = clean.match(
      /^(?:(?:como\s+)?alternativa(?:\s+del?|\s+para\s+el?|\s+al?)?|otra\s+opci[oó]n(?:\s+del?|\s+para\s+el?|\s+al?)?|otra\s+alternativa(?:\s+del?|\s+para\s+el?|\s+al?)?|o\s+(?:tambi[eé]n\s+)?(?:el)?|tambi[eé]n\s+(?:puede|podr[ií]a)\s+ser(?:\s+el)?|podr[ií]a\s+ser(?:\s+tambi[eé]n)?(?:\s+el)?|agreg[aá]|sum[aá]|pon[eé]|tambi[eé]n)(?:\s+tambi[eé]n)?(?:\s+como\s+alternativa)?[:\s]+(.+)$/i
    );
    if (addMatch) {
      let segText = addMatch[1]
        .replace(/\b(?:como\s+alternativa|de\s+alternativa)\b/gi, '')
        .replace(/^(?:del?|para\s+el?|al?|el)\s+/i, '')
        .trim();

      // If the segment starts with an activity definition (e.g. "cena hoy en casa a las 11"),
      // this is an encounter statement, not a date alternative.
      if (/^(?:un[a]?\s+)?(?:cena|almuerzo|desayuno|merienda|reuni[oó]n|asado|taller|partido|caf[eé]|cumpleaños|salida|evento)\b/i.test(segText)) {
        return { type: 'none' };
      }

      const singleParse = parseNaturalLanguageDateOptions(segText + ' o ' + segText, baseDateParts);
      if (singleParse.options.length > 0) {
        return { type: 'add', addedOption: singleParse.options[0] };
      }

      // Direct fallback if singleParse didn't match
      const timeMatch = segText.match(/(?:a\s+las?|para\s+las?)\s+([0-9]{1,2}(?::[0-9]{2})?)/i) ||
                        segText.match(/\b([0-9]{1,2}(?::[0-9]{2})?)\s*(?:hs|horas)?\b/i);
      if (timeMatch) {
        const timeStr = timeMatch[1];
        const datePart = segText.replace(timeMatch[0], '').replace(/^(?:el|del?|para\s+el?)\s+/i, '').trim();
        const timeParsed = parseDeterministicTimeInput(timeStr);
        const dateIntent = parseDeterministicDateIntent(datePart);
        if (dateIntent && timeParsed.kind === 'exact') {
          const resolvedDate = resolveDateIntent(dateIntent, baseDateParts);
          if (resolvedDate.resolved && resolvedDate.date) {
            const finalTime = timeParsed.time;
            if (validateResolvedDateTimeInFuture(resolvedDate.date, finalTime)) {
              return { type: 'add', addedOption: { date: resolvedDate.date, time: finalTime } };
            }
          }
        }
      }
    }
  }

  // E. Change fixed encounter schedule:
  // "cambiar la fecha al sábado a las 23", "cambiá la fecha al sábado a las 23", "pasalo al sábado a las 23", "cambiar al sábado a las 23"
  const changeFixedMatch = clean.match(
    /^(?:cambi[aá](?:r)?|pas[aá](?:r)?|modific[aá](?:r)?)\s+(?:la\s+fecha|el\s+d[ií]a|el\s+horario|la\s+hora)?(?:\s+(?:al?|para\s+el?))?\s+(.+)$/i
  );
  if (changeFixedMatch) {
    let segText = changeFixedMatch[1]
      .replace(/^(?:del?|para\s+el?|al?|el)\s+/i, '')
      .trim();
    const singleParse = parseNaturalLanguageDateOptions(segText + ' o ' + segText, baseDateParts);
    if (singleParse.options.length > 0) {
      const opt = singleParse.options[0];
      if (safeDraft.dateMode === 'coordination' && safeDraft.dateOptions && safeDraft.dateOptions.length > 0) {
        return { type: 'switch_to_fixed', selectedFixedOption: opt };
      }
      return { type: 'change_fixed', changedFixedOption: opt };
    }
  }

  return { type: 'none' };
}
