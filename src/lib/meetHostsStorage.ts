/**
 * meetHostsStorage — persiste y recupera el mapeo encuentroId → hostId
 * en localStorage bajo la clave 'puntoencuentro_meet_hosts'.
 *
 * Esto permite que DetailHost resuelva el hostId correcto al refrescar
 * directamente en /meet/:id, sin necesidad de pasar por Home primero.
 */

const MEET_HOSTS_KEY = 'puntoencuentro_meet_hosts';

type MeetHostsMap = Record<string, string>; // encuentroId → hostId

function readMap(): MeetHostsMap {
  try {
    const raw = localStorage.getItem(MEET_HOSTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map: MeetHostsMap): void {
  try {
    localStorage.setItem(MEET_HOSTS_KEY, JSON.stringify(map));
  } catch {
    // Silencioso — no crítico
  }
}

/**
 * Guarda la asociación encuentroId → hostId.
 * Llamar después de crear o confirmar propiedad de un encuentro.
 */
export function rememberEncuentroHost(encuentroId: string, hostId: string): void {
  if (!encuentroId || !hostId) return;
  const map = readMap();
  map[encuentroId] = hostId;
  writeMap(map);
}

/**
 * Recupera el hostId asociado a un encuentroId.
 * Devuelve null si no existe entrada para ese encuentro.
 */
export function getEncuentroHost(encuentroId: string): string | null {
  if (!encuentroId) return null;
  const map = readMap();
  return map[encuentroId] ?? null;
}

/**
 * Guarda múltiples asociaciones a la vez (útil al cargar Home).
 * Recibe un array de objetos con { id, host_id }.
 */
export function rememberEncuentroHostBulk(encuentros: Array<{ id: string; host_id: string }>): void {
  if (!encuentros || encuentros.length === 0) return;
  const map = readMap();
  for (const enc of encuentros) {
    if (enc.id && enc.host_id) {
      map[enc.id] = enc.host_id;
    }
  }
  writeMap(map);
}
