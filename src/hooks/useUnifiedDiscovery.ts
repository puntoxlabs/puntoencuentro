import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { openEncountersService } from '../services/openEncountersService';
import { intencionesService } from '../services/intencionesService';
import type { OpenEncounterSummary } from '../components/home/openEncounters/types';
import type { PublicIntencionSummary, SetInteresResult, IntencionesServiceResult } from '../types/intenciones';
import type { UseUnifiedDiscoveryReturn } from '../types/discovery';

export interface UseUnifiedDiscoveryOptions {
  localityIds?: string[] | null;
  otherActiveLocalityIds?: string[] | null;
  enabled?: boolean;
}

export const OTHER_ZONES_SUGGESTION_THRESHOLD = 3;
export const MAX_OTHER_ZONE_SUGGESTIONS = 3;

/**
 * Hook central de datos para Discovery Unificado (Fase 2.0-B + Local-First Mar del Plata).
 * Consume en paralelo Encuentros Abiertos e Intenciones públicas con tolerancia a fallos (fail-soft).
 * Soporta capa de sugerencias secundarias en otras macrozonas activas cuando la oferta primaria es baja.
 * Maneja altas/bajas explícitas de interés con actualización local precisa tras confirmación server-side.
 */
export function useUnifiedDiscovery(
  optionsOrLocalityIds?: string[] | null | UseUnifiedDiscoveryOptions
): UseUnifiedDiscoveryReturn {
  const options = useMemo<UseUnifiedDiscoveryOptions>(() => {
    if (!optionsOrLocalityIds) {
      return { localityIds: undefined, otherActiveLocalityIds: undefined, enabled: true };
    }
    if (Array.isArray(optionsOrLocalityIds)) {
      return { localityIds: optionsOrLocalityIds, otherActiveLocalityIds: undefined, enabled: true };
    }
    return {
      localityIds: optionsOrLocalityIds.localityIds,
      otherActiveLocalityIds: optionsOrLocalityIds.otherActiveLocalityIds,
      enabled: optionsOrLocalityIds.enabled ?? true,
    };
  }, [
    Array.isArray(optionsOrLocalityIds)
      ? optionsOrLocalityIds.join(',')
      : (optionsOrLocalityIds as UseUnifiedDiscoveryOptions)?.localityIds?.join(','),
    (optionsOrLocalityIds as UseUnifiedDiscoveryOptions)?.otherActiveLocalityIds?.join(','),
    (optionsOrLocalityIds as UseUnifiedDiscoveryOptions)?.enabled,
  ]);

  const [encounters, setEncounters] = useState<OpenEncounterSummary[]>([]);
  const [intentions, setIntentions] = useState<PublicIntencionSummary[]>([]);
  const [secondaryEncounters, setSecondaryEncounters] = useState<OpenEncounterSummary[]>([]);
  const [secondaryIntentions, setSecondaryIntentions] = useState<PublicIntencionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [encountersError, setEncountersError] = useState<string | null>(null);
  const [intentionsError, setIntentionsError] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const localityIds = options.localityIds ?? undefined;
  const otherActiveLocalityIds = options.otherActiveLocalityIds ?? undefined;
  const enabled = options.enabled ?? true;

  const fetchData = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setEncountersError(null);
    setIntentionsError(null);

    // 1. Cargar fuentes principales (PRIMARY)
    const [encountersRes, intentionsRes] = await Promise.all([
      openEncountersService.getDiscoveryEncuentrosWithStatus(localityIds),
      intencionesService.getDiscoveryIntenciones(localityIds),
    ]);

    if (!isMountedRef.current) return;

    const encOk = encountersRes.ok;
    const intOk = intentionsRes.ok;

    const primaryEncounters = encOk && encountersRes.data ? encountersRes.data : [];
    const primaryIntentions = intOk && intentionsRes.data ? intentionsRes.data : [];
    const primaryCount = primaryEncounters.length + primaryIntentions.length;

    // Fail-soft: actualización proporcional de datos y errores primarios
    if (encOk) {
      setEncounters(primaryEncounters);
      setEncountersError(null);
    } else {
      setEncounters([]);
      setEncountersError(encountersRes.error || 'error_loading_encounters');
    }

    if (intOk) {
      setIntentions(primaryIntentions);
      setIntentionsError(null);
    } else {
      setIntentions([]);
      setIntentionsError(intentionsRes.error || 'error_loading_intentions');
    }

    // 2. Consulta condicional de sugerencias secundarias (SECONDARY)
    // Solo si el contenido primario es escaso (< 3) y hay otras zonas activas disponibles
    const shouldFetchSecondary = Boolean(
      primaryCount < 3 &&
      localityIds &&
      localityIds.length > 0 &&
      otherActiveLocalityIds &&
      otherActiveLocalityIds.length > 0
    );

    if (shouldFetchSecondary && otherActiveLocalityIds) {
      const [secEncRes, secIntRes] = await Promise.all([
        openEncountersService.getDiscoveryEncuentrosWithStatus(otherActiveLocalityIds),
        intencionesService.getDiscoveryIntenciones(otherActiveLocalityIds),
      ]);

      if (!isMountedRef.current) return;

      const primaryEncIds = new Set(primaryEncounters.map((e) => e.id));
      const filteredSecEnc = (secEncRes.ok && secEncRes.data ? secEncRes.data : [])
        .filter((e) => otherActiveLocalityIds.includes(e.localityId) && !primaryEncIds.has(e.id))
        .slice(0, MAX_OTHER_ZONE_SUGGESTIONS);
      setSecondaryEncounters(filteredSecEnc);

      const primaryIntIds = new Set(primaryIntentions.map((i) => i.id));
      const filteredSecInt = (secIntRes.ok && secIntRes.data ? secIntRes.data : [])
        .filter(
          (i) =>
            i.modalidad !== 'virtual' &&
            Boolean(i.locality_id && otherActiveLocalityIds.includes(i.locality_id)) &&
            !primaryIntIds.has(i.id)
        )
        .slice(0, MAX_OTHER_ZONE_SUGGESTIONS);
      setSecondaryIntentions(filteredSecInt);
    } else {
      setSecondaryEncounters([]);
      setSecondaryIntentions([]);
    }

    // Error general solo si ambas fuentes primarias fallan
    if (!encOk && !intOk) {
      setError('failed_to_load_discovery');
    } else {
      setError(null);
    }

    setLoading(false);
  }, [enabled, localityIds ? localityIds.join(',') : '', otherActiveLocalityIds ? otherActiveLocalityIds.join(',') : '']);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const refresh = useCallback(async () => {
    await fetchData();
  }, [fetchData]);

  /**
   * Modifica el interés sobre una intención sin toggle en cliente.
   * La UI debe enviar explícitamente true o false.
   * NO aplica optimistic update antes de la confirmación del servidor.
   * Actualiza el estado local de la intención afectada si la RPC confirma éxito.
   */
  const setIntentionInterest = useCallback(
    async (
      id: string,
      interesado: boolean
    ): Promise<IntencionesServiceResult<SetInteresResult>> => {
      const res = await intencionesService.setInteresIntencion(id, interesado);

      if (!isMountedRef.current) return res;

      if (res.ok && res.data) {
        setIntentions((prev) =>
          prev.map((item) => {
            if (item.id === id) {
              return {
                ...item,
                viewer_interested: res.data!.interesado,
                interested_count: res.data!.interested_count,
              };
            }
            return item;
          })
        );
        setSecondaryIntentions((prev) =>
          prev.map((item) => {
            if (item.id === id) {
              return {
                ...item,
                viewer_interested: res.data!.interesado,
                interested_count: res.data!.interested_count,
              };
            }
            return item;
          })
        );
      }
      // Si la RPC falla, se conserva intacto el estado previo

      return res;
    },
    []
  );

  return {
    encounters,
    intentions,
    secondaryEncounters,
    secondaryIntentions,
    loading,
    error,
    encountersError,
    intentionsError,
    refresh,
    setIntentionInterest,
  };
}
