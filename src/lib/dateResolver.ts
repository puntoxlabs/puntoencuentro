import {
  getArgentinaDateTimeParts,
  isArgentinaDateTimeInFuture,
} from '@/lib/argentinaDateTime';
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
    /^(?:el\s+)?([1-9]|[12]\d|3[01])\s+de\s+([a-z]+)(?:\s+(?:del?\s+)?(\d{4}))?$/
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

  // 3. Match time expression in restAfterDate
  const timeParsed = parseDeterministicTimeInput(restAfterDate);
  if (timeParsed.kind !== 'exact') return null;

  // 4. Contextual hour resolution with activity title
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

  if (contextualRes.requiresConfirmation) {
    return {
      title,
      date: dateIso || '',
      baseDate: dateIso || '',
      time: null,
      requiresConfirmation: true,
      questionText: contextualRes.questionText,
      quickOptions: contextualRes.options?.map((opt) => ({ label: opt, value: opt })),
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
