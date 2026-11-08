export const DATE_COORDINATION_ENABLED = true;
export const AI_CREATION_ENABLED = true;

/**
 * Feature Flag: Habilita el puente de identidad entre dominios (flujo automático).
 * Desactivado por defecto (false).
 */
export const ENABLE_DOMAIN_MIGRATION_BRIDGE =
  typeof import.meta !== 'undefined' &&
  import.meta.env?.VITE_ENABLE_DOMAIN_MIGRATION_BRIDGE === 'true';

/**
 * Feature Flag: Habilita el fallback manual bearer (llave temporal de 3 minutos).
 * Gobernado de forma independiente al puente automático y desactivado por defecto (false).
 */
export const ENABLE_DOMAIN_MIGRATION_MANUAL_FALLBACK =
  typeof import.meta !== 'undefined' &&
  import.meta.env?.VITE_ENABLE_DOMAIN_MIGRATION_MANUAL_FALLBACK === 'true';
