/**
 * Gets the current host_id from localStorage, or generates a new one if it doesn't exist.
 */
export const getHostId = (): string => {
  const HOST_KEY = 'puntoencuentro_host_id';
  let hostId = localStorage.getItem(HOST_KEY);
  
  if (!hostId) {
    hostId = crypto.randomUUID();
    localStorage.setItem(HOST_KEY, hostId);
  }
  
  return hostId;
};
