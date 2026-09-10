import { getArgentinaTodayISO, isArgentinaDateTimeInFuture } from '@/lib/argentinaDateTime';

export function formatFriendlyDate(fecha: string, hora: string): string {
  if (!fecha || !hora) return `${fecha} a las ${hora}`;

  const parts = fecha.split('-');
  if (parts.length !== 3) return `${fecha} a las ${hora}`;

  const [, month, day] = parts;
  const monthNames = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const monthIndex = parseInt(month, 10) - 1;

  if (monthIndex < 0 || monthIndex > 11) return `${fecha} a las ${hora}`;

  const monthName = monthNames[monthIndex];
  const formattedHora = hora.substring(0, 5); // "10:00:00" -> "10:00"

  return `${parseInt(day, 10)} ${monthName} • ${formattedHora}`;
}

export function formatFriendlyDeadline(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';

    const formatter = new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    // El resultado de es-AR suele ser "14 de julio, 19:15" o "14 de julio de 2026, 19:15"
    // Lo parseamos manualmente para asegurar "14 de julio · 19:15" exacto:
    const parts = formatter.formatToParts(d);

    const day = parts.find(p => p.type === 'day')?.value || '';
    const month = parts.find(p => p.type === 'month')?.value || '';
    const hour = parts.find(p => p.type === 'hour')?.value || '';
    const minute = parts.find(p => p.type === 'minute')?.value || '';

    return `${day} de ${month} · ${hour}:${minute}`;
  } catch {
    return '';
  }
}

/** Devuelve true si la fecha+hora del encuentro ya pasó, considerando una ventana de gracia */
export function isEncuentroPasado(fecha: string, hora: string, graceMinutes: number = 45): boolean {
  if (!fecha || !hora) return false;
  try {
    const fechaHora = new Date(`${fecha}T${hora}`);
    if (isNaN(fechaHora.getTime())) return false;

    // Sumamos los minutos de gracia al tiempo del encuentro
    fechaHora.setMinutes(fechaHora.getMinutes() + graceMinutes);

    return fechaHora < new Date();
  } catch (e) {
    return false;
  }
}

export function isFuture(fecha: string, hora: string): boolean {
  return validateEncounterDate(fecha, hora) === null;
}

export function validateEncounterDate(fecha: string, hora: string): string | null {
  if (!fecha || !hora) return null;

  const localToday = getArgentinaTodayISO();

  if (fecha < localToday) {
    return "La fecha no puede ser anterior a hoy.";
  }

  // Si la hora viene con segundos (ej: "10:00:00"), nos quedamos con HH:mm
  const cleanHora = hora.substring(0, 5);

  if (!isArgentinaDateTimeInFuture(fecha, cleanHora)) {
    return "La fecha y hora deben ser futuras";
  }

  return null;
}

export function formatKidsBirthdayDateTime(date?: string, time?: string) {
  if (!date) return '';

  const [year, month, day] = date.split('-').map(Number);
  const localDate = new Date(year, month - 1, day);

  const formattedDate = localDate.toLocaleDateString('es-AR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const dateWithoutComma = formattedDate.replace(',', '');

  const cleanTime = time ? time.slice(0, 5) : '';
  const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

  return cleanTime
    ? `${capitalize(dateWithoutComma)} · ${cleanTime}`
    : capitalize(dateWithoutComma);
}

export interface FormatHumanScheduleOptions {
  date?: string | null;
  time?: string | null;
  locale?: string;
  timeZone?: string;
  referenceTodayISO?: string;
  labels?: {
    today?: string;
    tomorrow?: string;
  };
}

/**
 * Formats date and time into a friendly, human-readable schedule string
 * for UI presentation (e.g., "Hoy", "Mañana", "Mañana · 23:00", "Vie 11 sep · 20:30").
 * Avoids raw ISO dates and broken compositions like "2026-09-11 a las · Presencial".
 * Supports locale-aware Intl.DateTimeFormat (ES/EN/PT) and clean time without "hs".
 */
export function formatHumanSchedule(
  dateOrOptions?: string | FormatHumanScheduleOptions | null,
  maybeTime?: string | null,
  maybeOptionsOrRef?: string | Partial<FormatHumanScheduleOptions> | null
): string {
  let date: string | null | undefined;
  let time: string | null | undefined;
  let locale: string | undefined;
  let timeZone: string | undefined;
  let referenceTodayISO: string | undefined;
  let labels: { today?: string; tomorrow?: string } | undefined;

  if (typeof dateOrOptions === 'object' && dateOrOptions !== null) {
    date = dateOrOptions.date;
    time = dateOrOptions.time;
    locale = dateOrOptions.locale;
    timeZone = dateOrOptions.timeZone;
    referenceTodayISO = dateOrOptions.referenceTodayISO;
    labels = dateOrOptions.labels;
  } else {
    date = dateOrOptions;
    time = maybeTime;
    if (typeof maybeOptionsOrRef === 'string') {
      referenceTodayISO = maybeOptionsOrRef;
    } else if (typeof maybeOptionsOrRef === 'object' && maybeOptionsOrRef !== null) {
      locale = maybeOptionsOrRef.locale;
      timeZone = maybeOptionsOrRef.timeZone;
      referenceTodayISO = maybeOptionsOrRef.referenceTodayISO;
      labels = maybeOptionsOrRef.labels;
    }
  }

  const cleanTime = time ? time.trim().substring(0, 5) : '';
  const cleanDate = date ? date.trim() : '';

  if (!cleanDate && !cleanTime) return '';
  if (!cleanDate && cleanTime) return cleanTime;

  const effectiveTimeZone = timeZone || 'America/Argentina/Buenos_Aires';
  const todayISO = referenceTodayISO || getArgentinaTodayISO();

  // Compute tomorrow ISO based on todayISO
  let tomorrowISO = '';
  try {
    const [ty, tm, td] = todayISO.split('-').map(Number);
    const tomDate = new Date(Date.UTC(ty, tm - 1, td + 1));
    const pad = (n: number) => n.toString().padStart(2, '0');
    tomorrowISO = `${tomDate.getUTCFullYear()}-${pad(tomDate.getUTCMonth() + 1)}-${pad(tomDate.getUTCDate())}`;
  } catch {}

  // Locale normalization (es-AR default, en-US, pt-BR)
  let rawLocale = (locale || 'es-AR').trim();
  if (rawLocale === 'es') rawLocale = 'es-AR';
  if (rawLocale === 'en') rawLocale = 'en-US';
  if (rawLocale === 'pt') rawLocale = 'pt-BR';

  const langCode = rawLocale.split('-')[0].toLowerCase();
  const defaultRelativeLabels: Record<string, { today: string; tomorrow: string }> = {
    es: { today: 'Hoy', tomorrow: 'Mañana' },
    en: { today: 'Today', tomorrow: 'Tomorrow' },
    pt: { today: 'Hoje', tomorrow: 'Amanhã' },
  };

  const rel = labels || defaultRelativeLabels[langCode] || defaultRelativeLabels.es;

  let dateLabel = '';
  if (cleanDate === todayISO) {
    dateLabel = rel.today || 'Hoy';
  } else if (cleanDate === tomorrowISO) {
    dateLabel = rel.tomorrow || 'Mañana';
  } else {
    // Format using Intl.DateTimeFormat
    const parts = cleanDate.split('-');
    if (parts.length === 3) {
      const [y, m, d] = parts.map(Number);
      if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
        const utcDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
        try {
          const formatter = new Intl.DateTimeFormat(rawLocale, {
            timeZone: effectiveTimeZone,
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          });
          const formatted = formatter.format(utcDate);
          dateLabel = formatted.charAt(0).toUpperCase() + formatted.slice(1);
        } catch {
          dateLabel = cleanDate;
        }
      }
    }
    if (!dateLabel) {
      dateLabel = cleanDate;
    }
  }

  if (cleanTime) {
    return `${dateLabel} · ${cleanTime}`;
  }
  return dateLabel;
}

