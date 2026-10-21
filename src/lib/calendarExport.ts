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
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
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
 * Pliega líneas que superen los 75 octetos según RFC 5545 (Sección 3.1).
 */
export function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let remaining = line;
  while (remaining.length > 75) {
    parts.push(remaining.slice(0, 75));
    remaining = ' ' + remaining.slice(75);
  }
  parts.push(remaining);
  return parts.join('\r\n');
}

/**
 * Parsea fecha (YYYY-MM-DD) y hora (HH:MM) a componentes numéricos.
 */
function parseDateParts(fecha: string, hora: string) {
  const [yearStr, monthStr, dayStr] = fecha.split('-');
  const [hourStr, minStr] = hora.split(':');

  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  const hour = parseInt(hourStr || '0', 10);
  const minute = parseInt(minStr || '0', 10);

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
 */
export function generateIcsContent(encounter: CalendarEncounterData): string {
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
