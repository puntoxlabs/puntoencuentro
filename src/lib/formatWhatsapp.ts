

/**
 * Formatea la hora reemplazando los dos puntos (:) por un punto (.) 
 * y añadiendo "hs" para evitar que WhatsApp lo detecte como un link clickeable.
 * Ejemplo: "21:00" -> "21.00 hs"
 */
export function formatHoraWhatsApp(hora: string): string {
  if (!hora) return '';
  const cleanHora = hora.substring(0, 5); // "10:00:00" -> "10:00"
  return cleanHora.replace(':', '.') + ' hs';
}

/**
 * Formatea fecha y hora por separado para facilitar su uso en plantillas de WhatsApp,
 * evitando autolinking indeseado.
 */
export function formatFechaHoraWhatsApp(fecha: string, hora: string): { fechaStr: string, horaStr: string } {
  const parts = fecha.split('-');
  if (parts.length !== 3) return { fechaStr: fecha, horaStr: formatHoraWhatsApp(hora) };
  
  const [, month, day] = parts;
  const monthNames = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const monthIndex = parseInt(month, 10) - 1;
  
  if (monthIndex < 0 || monthIndex > 11) return { fechaStr: fecha, horaStr: formatHoraWhatsApp(hora) };
  
  const fechaStr = `${parseInt(day, 10)} ${monthNames[monthIndex]}`;
  const horaStr = formatHoraWhatsApp(hora);
  
  return { fechaStr, horaStr };
}
