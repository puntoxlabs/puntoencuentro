

/**
 * Formatea la hora usando ":" y cortando segundos si existieran.
 * Ejemplo: "13:15:00" -> "13:15"
 */
export function formatHoraWhatsApp(hora: string): string {
  if (!hora) return '';
  const hsMin = hora.substring(0, 5);
  const parts = hsMin.split(':');
  if (parts.length === 2) {
    if (parts[1] === '00') {
      return `${parts[0]} hs`;
    }
    return `${parts[0]} h ${parts[1]}`;
  }
  return hsMin;
}

/**
 * Formatea fecha y hora por separado para facilitar su uso en plantillas de WhatsApp,
 * devolviendo el día de semana y el formato amigable.
 * Ejemplo: Jueves 2 de julio
 */
export function formatFechaHoraWhatsApp(fecha: string, hora: string): { fechaStr: string, horaStr: string } {
  const horaStr = formatHoraWhatsApp(hora);

  try {
    const parts = fecha.split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const monthIndex = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);

      const dateObj = new Date(year, monthIndex, day);

      const weekdays = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
      const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

      const weekday = weekdays[dateObj.getDay()];
      const monthName = monthNames[monthIndex];

      const fechaStr = `${weekday} ${day} de ${monthName}`;
      return { fechaStr, horaStr };
    }
  } catch (e) {
    // Fallback silencioso
  }

  // Fallback si no pudo parsear
  return { fechaStr: fecha, horaStr };
}

/**
 * Inserta un espacio de ancho cero entre secuencias de dígitos para
 * evitar que plataformas como WhatsApp los conviertan en links clickeables (como teléfonos).
 */
export function preventNumberLinking(text: string): string {
  if (!text) return text;
  // Busca cualquier dígito seguido de otro dígito y mete un \u2060 (WORD JOINER) en el medio.
  // Esto rompe la detección de patrón del parser de WhatsApp sin afectar lo visual.
  return text.replace(/(\d)(?=\d)/g, '$1\u2060');
}
