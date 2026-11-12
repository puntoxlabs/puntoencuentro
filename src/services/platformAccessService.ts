/**
 * Platform Access Service (PRE-LAUNCH / PUBLIC-LAUNCH Architecture)
 *
 * Desacopla el control de fase de plataforma de hardcodes y de reglas basadas en hostname.
 *
 * Principios e Invariantes:
 * 1. Fail-Closed: Si no se puede verificar el estado (error de red, timeout, excepción),
 *    asume 'false' (Modo PRE-LAUNCH hermético activo).
 * 2. Hostname-Independent: Funciona idénticamente en localhost, staging, producción o dominios futuros.
 * 3. Cache Eficiente: Almacena en memoria el resultado durante la sesión para evitar llamadas RPC redundantes.
 * 4. Override de Entorno: Admite 'VITE_PUBLIC_LAUNCH_ACTIVE' === 'true' para builds estáticos públicos o testing.
 */

import { supabase } from '@/lib/supabase';

let memoryCache: { value: boolean; timestamp: number } | null = null;
const CACHE_TTL_MS = 60000; // 1 minuto de cache en memoria

/**
 * Consulta si la plataforma está oficialmente abierta al público general (PUBLIC-LAUNCH).
 * Retorna true si está abierta; false si está en fase PRE-LAUNCH (cerrada).
 */
export async function isPlatformPublicLaunchActive(): Promise<boolean> {
  // 1. Override explícito de variable de entorno (para pruebas o compilaciones fijadas)
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PUBLIC_LAUNCH_ACTIVE === 'true') {
    return true;
  }

  // 2. Verificar cache en memoria
  const now = Date.now();
  if (memoryCache && now - memoryCache.timestamp < CACHE_TTL_MS) {
    return memoryCache.value;
  }

  // 3. Consulta server-side mediante RPC STABLE SECURITY DEFINER
  try {
    const { data, error } = await supabase.rpc('is_public_launch_open');
    if (error) {
      console.warn('[PlatformAccess] Error consultando is_public_launch_open, aplicando fail-closed:', error.message);
      memoryCache = { value: false, timestamp: now };
      return false;
    }

    const isActive = data === true;
    memoryCache = { value: isActive, timestamp: now };
    return isActive;
  } catch (err: any) {
    console.warn('[PlatformAccess] Excepción en isPlatformPublicLaunchActive, aplicando fail-closed:', err?.message || err);
    memoryCache = { value: false, timestamp: now };
    return false;
  }
}

/**
 * Invalida el cache en memoria (útil para pruebas y tras cambios de fase).
 */
export function clearPlatformAccessCache(): void {
  memoryCache = null;
}
