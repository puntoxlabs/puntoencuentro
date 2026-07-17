import type { TFunction } from 'i18next';

export function formatCoordinationDuration(
  minutes: number | null | undefined,
  t: TFunction
): string | null {
  if (
    typeof minutes !== 'number' ||
    !Number.isFinite(minutes) ||
    !Number.isInteger(minutes) ||
    minutes < 15 ||
    minutes > 1440
  ) {
    return null;
  }

  const h = Math.floor(minutes / 60);
  const m = minutes % 60;

  if (h === 0) {
    return t('coordination.duration.minutes', { count: m });
  } else if (m === 0) {
    return t('coordination.duration.hours', { count: h });
  } else {
    return t('coordination.duration.hours_and_minutes', {
      hours: t('coordination.duration.hours', { count: h }),
      minutes: t('coordination.duration.minutes', { count: m })
    });
  }
}
