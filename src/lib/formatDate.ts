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
  
  // Combinamos fecha y hora para la comparación completa
  const encounterDateTime = new Date(`${fecha}T${cleanHora}`);
  
  if (encounterDateTime <= now) {
    return "La fecha y hora deben ser futuras";
  }

  return null;
}
