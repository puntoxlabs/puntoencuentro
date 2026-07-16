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
    return `${formatter.format(dateObj)} \u2022 ${cleanHora}`;
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

    return formatter.format(d).replace(',', ' \u2022');
  } catch {
    return '';
  }
}
