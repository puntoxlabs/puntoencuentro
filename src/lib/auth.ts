/**
 * Gets the current host_id from localStorage, or generates a new one if it doesn't exist.
 */
export const getHostId = (): string => {
  const HOST_KEY = 'puntoencuentro_host_id';
  let hostId = localStorage.getItem(HOST_KEY);
  
  if (!hostId) {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      hostId = crypto.randomUUID();
    } else {
      hostId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }
    localStorage.setItem(HOST_KEY, hostId);
  }
  
  return hostId;
};
