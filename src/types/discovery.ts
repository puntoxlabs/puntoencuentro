/**
 * Tipos de dominio para Discovery Unificado (Fase 2.0-B).
 * Mantiene desacoplados los modelos de Encuentros Abiertos e Intenciones públicas.
 */

import type { OpenEncounterSummary } from '@/components/home/openEncounters/types';
import type { PublicIntencionSummary, SetInteresResult } from './intenciones';

export type { OpenEncounterSummary } from '@/components/home/openEncounters/types';
export type { PublicIntencionSummary, SetInteresResult } from './intenciones';

export type DiscoveryItemType = 'encounter' | 'intention';

export type UnifiedDiscoveryItem =
  | { type: 'encounter'; encounter: OpenEncounterSummary }
  | { type: 'intention'; intention: PublicIntencionSummary };

export interface UnifiedDiscoveryFilter {
  localityIds?: string[] | null;
}

export interface UnifiedDiscoveryState {
  encounters: OpenEncounterSummary[];
  intentions: PublicIntencionSummary[];
  secondaryEncounters: OpenEncounterSummary[];
  secondaryIntentions: PublicIntencionSummary[];
  loading: boolean;
  error: string | null;
  encountersError: string | null;
  intentionsError: string | null;
}

export interface UseUnifiedDiscoveryReturn extends UnifiedDiscoveryState {
  refresh: () => Promise<void>;
  setIntentionInterest: (
    id: string,
    interesado: boolean
  ) => Promise<{ ok: boolean; data?: SetInteresResult; error?: string }>;
}
