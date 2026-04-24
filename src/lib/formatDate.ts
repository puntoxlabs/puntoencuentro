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
