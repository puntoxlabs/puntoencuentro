/**
 * Helper para formatear fecha y hora relativa en notificaciones in-app.
 * Formato amigable y legible adaptado al locale es-AR.
 */

const MONTH_NAMES = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic'
];

export function formatRelativeTime(dateString: string | null | undefined): string {
  if (!dateString) return '';

  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 60) {
    return 'Hace un momento';
  }

  if (diffMin < 60) {
    return `Hace ${diffMin} min`;
  }

  if (diffHours < 24) {
    return `Hace ${diffHours} h`;
  }

  if (diffDays === 1) {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `Ayer · ${hours}:${minutes}`;
  }

  const day = date.getDate();
  const month = MONTH_NAMES[date.getMonth()];
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');

  if (now.getFullYear() === date.getFullYear()) {
    return `${day} ${month} · ${hours}:${minutes}`;
  }

  return `${day} ${month} ${date.getFullYear()} · ${hours}:${minutes}`;
}
