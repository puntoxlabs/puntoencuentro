import type { Localidad } from '@/components/home/openEncounters/types';

/**
 * Catálogo fallback de localidades de lanzamiento para Mar del Plata (Local-First).
 * La fuente de verdad reside en Supabase (public.localidades).
 * Este array se utiliza exclusivamente como resiliencia ante fallos temporales de red.
 */
export const DEFAULT_LOCALIDADES: Localidad[] = [
  { id: 'centro', nombre: 'Centro / La Perla', ciudad: 'Mar del Plata', zona: 'Costa Atlántica', pais: 'AR', orden: 1 },
  { id: 'guemes', nombre: 'Güemes / Playa Grande', ciudad: 'Mar del Plata', zona: 'Costa Atlántica', pais: 'AR', orden: 2 },
  { id: 'mitre', nombre: 'Plaza Mitre / Chauvín', ciudad: 'Mar del Plata', zona: 'Costa Atlántica', pais: 'AR', orden: 3 },
  { id: 'constitucion', nombre: 'Constitución / Norte', ciudad: 'Mar del Plata', zona: 'Costa Atlántica', pais: 'AR', orden: 4 },
  { id: 'puerto-mogotes', nombre: 'Puerto / Punta Mogotes', ciudad: 'Mar del Plata', zona: 'Costa Atlántica', pais: 'AR', orden: 5 },
  { id: 'sur-playas-del-sur', nombre: 'Sur / Playas del Sur', ciudad: 'Mar del Plata', zona: 'Costa Atlántica', pais: 'AR', orden: 6 },
];
