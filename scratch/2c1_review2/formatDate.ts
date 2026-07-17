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

  return `${parseInt(day, 10)} ${monthName} â€¢ ${formattedHora}`;
}

export function formatCoordinationOptionDate(fecha: string, hora: string, language: string): string {
  if (!fecha || !hora) return `${fecha} ${hora}`;
  try {
    const parts = fecha.split('-');
    if (parts.length !== 3) return `${fecha} ${hora}`;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);

    const dateObj = new Date(year, month, day);

    const formatter = new Intl.DateTimeFormat(language || 'es', {
      month: 'short',
      day: 'numeric'
    });

    const cleanHora = hora.substring(0, 5);
    return `${formatter.format(dateObj)} â€¢ ${cleanHora}`;
  } catch {
    return `${fecha} ${hora}`;
  }
}

export function formatCoordinationDeadline(isoString: string, language: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';

    const formatter = new Intl.DateTimeFormat(language || 'es', {
      timeZone: 'America/Argentina/Buenos_Aires',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    return formatter.format(d).replace(',', ' â€¢');
  } catch {
    return '';
  }
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
    // Lo parseamos manualmente para asegurar "14 de julio Â· 19:15" exacto:
    const parts = formatter.formatToParts(d);

    const day = parts.find(p => p.type === 'day')?.value || '';
    const month = parts.find(p => p.type === 'month')?.value || '';
    const hour = parts.find(p => p.type === 'hour')?.value || '';
    const minute = parts.find(p => p.type === 'minute')?.value || '';

    return `${day} de ${month} Â· ${hour}:${minute}`;
  } catch {
    return '';
  }
}

/** Devuelve true si la fecha+hora del encuentro ya pasÃ³, considerando una ventana de gracia */
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

  const now = new Date();

  // Obtenemos la fecha local en formato YYYY-MM-DD
  const localYear = now.getFullYear();
  const localMonth = String(now.getMonth() + 1).padStart(2, '0');
  const localDay = String(now.getDate()).padStart(2, '0');
  const localToday = `${localYear}-${localMonth}-${localDay}`;

  if (fecha < localToday) {
    return "La fecha no puede ser anterior a hoy.";
  }

  // Si la hora viene con segundos (ej: "10:00:00"), nos quedamos con HH:mm
  const cleanHora = hora.substring(0, 5);

  // Combinamos fecha y hora para la comparaciÃ³n completa
  const encounterDateTime = new Date(`${fecha}T${cleanHora}`);

  if (encounterDateTime <= now) {
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
    ? `${capitalize(dateWithoutComma)} Â· ${cleanTime}`
    : capitalize(dateWithoutComma);
}
