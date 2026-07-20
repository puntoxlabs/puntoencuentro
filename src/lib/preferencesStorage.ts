export const POST_EVENT_MINUTES_KEY = 'puntoencuentro_post_event_minutes';

export const getPostEventMinutes = (): number => {
  try {
    const stored = localStorage.getItem(POST_EVENT_MINUTES_KEY);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1440) {
        return parsed;
      }
    }
  } catch {
    // Ignore localStorage errors
  }
  return 45; // Default value
};

export const setPostEventMinutes = (minutes: number) => {
  try {
    if (minutes >= 0 && minutes <= 1440) {
      localStorage.setItem(POST_EVENT_MINUTES_KEY, minutes.toString());
    }
  } catch {
    // Ignore localStorage errors
  }
};
