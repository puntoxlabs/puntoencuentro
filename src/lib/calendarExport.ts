/**
 * Utilidad reutilizable para exportación de eventos a calendario (.ics / iCalendar RFC 5545).
 * Compatible de forma nativa con Google Calendar, Apple Calendar y Microsoft Outlook.
 * Zona horaria canónica de PuntoEncuentro: America/Argentina/Buenos_Aires (ART, UTC-3).
 */

export interface CalendarEncounterData {
  id: string;
  titulo: string;
  fecha?: string | null; // YYYY-MM-DD
  hora?: string | null;  // HH:MM
  durationMinutes?: number | null;
  duracion_minutos?: number | null;
  modalidad?: 'presencial' | 'virtual' | null;
  lugar_texto?: string | null;
  link_virtual?: string | null;
  descripcion?: string | null;
  estado?: string | null;
  date_mode?: string | null;
  coordination_status?: string | null;
}

export const TIMEZONE_ARGENTINA = 'America/Argentina/Buenos_Aires';
export const DEFAULT_DURATION_MINUTES = 120; // 2 horas por defecto
export const MIN_DURATION_MINUTES = 1;
export const MAX_DURATION_MINUTES = 1440; // 24 horas

export type CalendarReminderOption = '1d' | '1h' | '30m' | '10m' | 'none';

export const REMINDER_TRIGGERS: Record<Exclude<CalendarReminderOption, 'none'>, string> = {
  '1d': '-P1D',
  '1h': '-PT1H',
  '30m': '-PT30M',
  '10m': '-PT10M',
};

export const DEFAULT_REMINDER_OPTION: CalendarReminderOption = '30m';

const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

/**
 * Valida que una fecha sea astronómicamente real en el calendario gregoriano (evita 31 de feb, etc).
 */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 2020 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Valida que la duración en minutos sea un número positivo y razonable (hasta 24 horas).
 */
export function isValidDuration(duration?: number | null): boolean {
  if (duration === undefined || duration === null) return true;
  if (typeof duration !== 'number' || isNaN(duration) || !isFinite(duration)) return false;
  return duration >= MIN_DURATION_MINUTES && duration <= MAX_DURATION_MINUTES;
}

/**
 * Determina si un encuentro tiene fecha y hora definitivas para ser exportado al calendario.
 * Regla: No ofrecer en coordinaciones sin fecha cerrada ni en encuentros cancelados.
 */
export function canAddToCalendar(
  encounter?: Partial<CalendarEncounterData> | null
): boolean {
  if (!encounter) return false;

  // Estado cancelado: no se agrega al calendario
  if (encounter.estado?.toLowerCase() === 'cancelado') return false;

  // Coordinación abierta: no tiene fecha definitiva aún
  if (encounter.date_mode === 'coordination' && encounter.coordination_status !== 'closed') {
    return false;
  }

  // Requiere fecha y hora obligatorias y válidas
  if (!encounter.fecha || !encounter.hora) return false;

  const { year, month, day, hour, minute } = parseDateParts(encounter.fecha, encounter.hora);
  if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute)) {
    return false;
  }
  if (!isValidCalendarDate(year, month, day)) {
    return false;
  }

  // Validar duración positiva y razonable si se informa explícitamente
  const dur = encounter.durationMinutes ?? encounter.duracion_minutos;
  if (dur !== undefined && dur !== null && !isValidDuration(dur)) {
    return false;
  }

  return true;
}

/**
 * Escapa caracteres especiales según la especificación RFC 5545 (Sección 3.3.11).
 */
export function escapeIcsText(text: string): string {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

/**
 * Pliega líneas según RFC 5545 (Sección 3.1):
 * Máximo 75 octetos UTF-8 por línea, sin dividir caracteres multibyte (acentos, emojis).
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(line).length;
  if (totalBytes <= 75) return line;

  const lines: string[] = [];
  let currentLine = '';
  let currentBytes = 0;
  let isFirstLine = true;

  // Iterar por puntos de código Unicode completos (sin cortar surrogate pairs ni bytes)
  for (const char of line) {
    const charBytes = encoder.encode(char).length;
    const maxAllowed = isFirstLine ? 75 : 75;

    if (!isFirstLine && currentLine === '') {
      currentLine = ' ';
      currentBytes = 1;
    }

    if (currentBytes + charBytes > maxAllowed) {
      lines.push(currentLine);
      currentLine = ' ' + char;
      currentBytes = 1 + charBytes;
      isFirstLine = false;
    } else {
      currentLine += char;
      currentBytes += charBytes;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.join('\r\n');
}

/**
 * Parsea fecha (YYYY-MM-DD) y hora (HH:MM) a componentes numéricos validados estrictamente.
 */
function parseDateParts(fecha: string, hora: string) {
  const dateMatch = (fecha || '').trim().match(ISO_DATE_REGEX);
  const timeMatch = (hora || '').trim().match(TIME_REGEX);

  if (!dateMatch || !timeMatch) {
    return { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN };
  }

  const year = parseInt(dateMatch[1], 10);
  const month = parseInt(dateMatch[2], 10);
  const day = parseInt(dateMatch[3], 10);
  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);

  return { year, month, day, hour, minute };
}

/**
 * Formatea componentes a timestamp iCalendar local: YYYYMMDDTHHMMSS
 */
function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatIcsDateTime(year: number, month: number, day: number, hour: number, minute: number): string {
  return `${year}${pad2(month)}${pad2(day)}T${pad2(hour)}${pad2(minute)}00`;
}

/**
 * Calcula la fecha y hora de finalización en base a la duración en minutos.
 */
function calculateEndDateTime(year: number, month: number, day: number, hour: number, minute: number, durationMinutes: number) {
  // Operar en milisegundos con fecha UTC base para evitar desfases locales del runtime
  const utcBase = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const utcEnd = new Date(utcBase.getTime() + durationMinutes * 60 * 1000);

  return {
    year: utcEnd.getUTCFullYear(),
    month: utcEnd.getUTCMonth() + 1,
    day: utcEnd.getUTCDate(),
    hour: utcEnd.getUTCHours(),
    minute: utcEnd.getUTCMinutes(),
  };
}

/**
 * Convierte un encuentro en contenido válido de archivo .ics (iCalendar RFC 5545).
 * Permite configurar opcionalmente una alarma iCalendar (VALARM) previa al encuentro.
 */
export function generateIcsContent(
  encounter: CalendarEncounterData,
  reminder: CalendarReminderOption = DEFAULT_REMINDER_OPTION
): string {
  if (!canAddToCalendar(encounter)) {
    throw new Error('El encuentro no tiene fecha definitiva o se encuentra cancelado.');
  }

  const { year, month, day, hour, minute } = parseDateParts(encounter.fecha!, encounter.hora!);
  const duration = encounter.durationMinutes || encounter.duracion_minutos || DEFAULT_DURATION_MINUTES;
  const end = calculateEndDateTime(year, month, day, hour, minute, duration);

  const dtStart = formatIcsDateTime(year, month, day, hour, minute);
  const dtEnd = formatIcsDateTime(end.year, end.month, end.day, end.hour, end.minute);

  const now = new Date();
  const dtStamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;

  const uid = `pe-${encounter.id || 'draft'}@puntoencuentro.com.ar`;

  // Descripción y sanitización
  let descriptionText = '';
  if (encounter.descripcion && encounter.descripcion.trim()) {
    descriptionText = `${encounter.descripcion.trim()}\n\n`;
  }
  descriptionText += 'Encuentro organizado en PuntoEncuentro.';

  // Ubicación respetando privacidad
  let locationText = '';
  if (encounter.modalidad === 'virtual') {
    locationText = encounter.link_virtual?.trim() || 'Videollamada';
  } else if (encounter.lugar_texto && encounter.lugar_texto.trim()) {
    locationText = encounter.lugar_texto.trim();
  }

  // Componente de alarma VALARM según RFC 5545 (DISPLAY exige ACTION, TRIGGER y DESCRIPTION)
  const alarmLines: string[] =
    reminder !== 'none' && REMINDER_TRIGGERS[reminder]
      ? [
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `DESCRIPTION:${escapeIcsText(encounter.titulo || 'Encuentro')}`,
          `TRIGGER:${REMINDER_TRIGGERS[reminder]}`,
          'END:VALARM',
        ]
      : [];

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PuntoEncuentro//Calendario v1.0//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    // Bloque VTIMEZONE para America/Argentina/Buenos_Aires (UTC-3 permanente sin horario de verano)
    'BEGIN:VTIMEZONE',
    `TZID:${TIMEZONE_ARGENTINA}`,
    `X-LIC-LOCATION:${TIMEZONE_ARGENTINA}`,
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0300',
    'TZOFFSETTO:-0300',
    'TZNAME:ART',
    'DTSTART:19700101T000000',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART;TZID=${TIMEZONE_ARGENTINA}:${dtStart}`,
    `DTEND;TZID=${TIMEZONE_ARGENTINA}:${dtEnd}`,
    `SUMMARY:${escapeIcsText(encounter.titulo || 'Encuentro')}`,
    `DESCRIPTION:${escapeIcsText(descriptionText)}`,
    ...(locationText ? [`LOCATION:${escapeIcsText(locationText)}`] : []),
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    ...alarmLines,
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

/**
 * Genera la URL para agregar el evento directamente a Google Calendar vía web.
 * Argentina se encuentra en UTC-3, por lo que convertimos la hora a UTC para Google.
 */
export function buildGoogleCalendarUrl(encounter: CalendarEncounterData): string {
  if (!canAddToCalendar(encounter)) return '';

  const { year, month, day, hour, minute } = parseDateParts(encounter.fecha!, encounter.hora!);
  const duration = encounter.durationMinutes || encounter.duracion_minutos || DEFAULT_DURATION_MINUTES;

  // ART es UTC-3 -> en UTC sumamos 3 horas
  const startUtc = new Date(Date.UTC(year, month - 1, day, hour + 3, minute));
  const endUtc = new Date(startUtc.getTime() + duration * 60 * 1000);

  const formatUtcIso = (d: Date) =>
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}00Z`;

  let details = '';
  if (encounter.descripcion && encounter.descripcion.trim()) {
    details = `${encounter.descripcion.trim()}\n\n`;
  }
  details += 'Encuentro organizado en PuntoEncuentro.';

  let location = '';
  if (encounter.modalidad === 'virtual') {
    location = encounter.link_virtual?.trim() || 'Videollamada';
  } else if (encounter.lugar_texto) {
    location = encounter.lugar_texto.trim();
  }

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: encounter.titulo || 'Encuentro',
    dates: `${formatUtcIso(startUtc)}/${formatUtcIso(endUtc)}`,
    details,
    location,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Dispara la descarga del archivo .ics en el navegador del usuario (desktop y mobile).
 */
export function downloadIcsFile(filename: string, icsContent: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const cleanFilename = filename.toLowerCase().endsWith('.ics') ? filename : `${filename}.ics`;
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = cleanFilename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();

  // Limpieza segura en el siguiente tick
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
