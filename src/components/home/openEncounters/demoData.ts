import type { OpenEncounterSummary } from './types';

/**
 * OPEN_ENCOUNTERS_DEMO
 *
 * Datos DEMO exclusivamente para previsualización de arquitectura UX en /preview/home-gsap.
 * NUNCA se persisten en Supabase ni se mezclan con encuentros reales.
 */
export const OPEN_ENCOUNTERS_DEMO: OpenEncounterSummary[] = [
  {
    id: 'demo-padel',
    title: 'Pádel',
    emoji: '🎾',
    activityType: 'sports',
    startsAt: '2026-10-01T20:00:00',
    dateLabel: 'Jueves · 20:00',
    approximateZone: 'Güemes',
    localityId: 'guemes',
    openSlots: 1,
    confirmedCount: 3,
    language: 'es',
    description: 'Buscamos cuarto jugador/a para partido parejo de pádel categoría 6ta/7ma. Cancha reservada con iluminación.'
  },
  {
    id: 'demo-futbol',
    title: 'Fútbol 5',
    emoji: '⚽',
    activityType: 'sports',
    startsAt: '2026-10-03T18:00:00',
    dateLabel: 'Sábado · 18:00',
    approximateZone: 'Constitución',
    localityId: 'constitucion',
    openSlots: 2,
    confirmedCount: 8,
    language: 'es',
    description: 'Fútbol mixto semanal en cancha techada. Falta completar dos puestos para jugar 5 contra 5.'
  },
  {
    id: 'demo-bici',
    title: 'Salida en bici',
    emoji: '🚴',
    activityType: 'outdoor',
    startsAt: '2026-10-04T09:30:00',
    dateLabel: 'Domingo · 9:30',
    approximateZone: 'La costa',
    localityId: 'costa',
    openSlots: 3,
    confirmedCount: 5,
    language: 'es',
    description: 'Pedaleada tranquila por la costa hasta el faro, ritmo paseo con parada para mates y descanso.'
  },
  {
    id: 'demo-cafe',
    title: 'Café y charla',
    emoji: '☕',
    activityType: 'social',
    startsAt: '2026-10-02T18:30:00',
    dateLabel: 'Viernes · 18:30',
    approximateZone: 'Centro',
    localityId: 'centro',
    openSlots: 2,
    confirmedCount: 2,
    language: 'es',
    description: 'Juntada informal en cafetería céntrica para charlar sobre proyectos, ideas y nuevas tecnologías.'
  },
  {
    id: 'demo-mates',
    title: 'Mates en la plaza',
    emoji: '🧉',
    activityType: 'social',
    startsAt: '2026-10-03T16:00:00',
    dateLabel: 'Sábado · 16:00',
    approximateZone: 'Plaza Mitre',
    localityId: 'mitre',
    openSlots: 1,
    confirmedCount: 4,
    language: 'es',
    description: 'Llevamos termo, yerba y facturas. Abierto a quien quiera sumarse a compartir una tarde al sol.'
  }
];
