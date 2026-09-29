import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { openEncountersService } from '../services/openEncountersService';
import { intencionesService } from '../services/intencionesService';
import type { OpenEncounterSummary } from '../components/home/openEncounters/types';
import type { PublicIntencionSummary, SetInteresResult, IntencionesServiceResult } from '../types/intenciones';
import type { UseUnifiedDiscoveryReturn } from '../types/discovery';

export interface UseUnifiedDiscoveryOptions {
  localityIds?: string[] | null;
  enabled?: boolean;
}

/**
 * Hook central de datos para Discovery Unificado (Fase 2.0-B).
 * Consume en paralelo Encuentros Abiertos e Intenciones públicas con tolerancia a fallos (fail-soft).
 * Maneja altas/bajas explícitas de interés con actualización local precisa tras confirmación server-side.
 */
export function useUnifiedDiscovery(
  optionsOrLocalityIds?: string[] | null | UseUnifiedDiscoveryOptions
): UseUnifiedDiscoveryReturn {
  const options = useMemo<UseUnifiedDiscoveryOptions>(() => {
    if (!optionsOrLocalityIds) {
      return { localityIds: undefined, enabled: true };
    }
    if (Array.isArray(optionsOrLocalityIds)) {
      return { localityIds: optionsOrLocalityIds, enabled: true };
    }
    return {
      localityIds: optionsOrLocalityIds.localityIds,
      enabled: optionsOrLocalityIds.enabled ?? true,
    };
  }, [
    Array.isArray(optionsOrLocalityIds)
      ? optionsOrLocalityIds.join(',')
      : (optionsOrLocalityIds as UseUnifiedDiscoveryOptions)?.localityIds?.join(','),
    (optionsOrLocalityIds as UseUnifiedDiscoveryOptions)?.enabled,
  ]);

  const [encounters, setEncounters] = useState<OpenEncounterSummary[]>([]);
  const [intentions, setIntentions] = useState<PublicIntencionSummary[]>([]);
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

    // Consulta en paralelo de ambas fuentes de Discovery
    const [encountersRes, intentionsRes] = await Promise.all([
      openEncountersService.getDiscoveryEncuentrosWithStatus(localityIds),
      intencionesService.getDiscoveryIntenciones(localityIds),
    ]);

    if (!isMountedRef.current) return;

    const encOk = encountersRes.ok;
    const intOk = intentionsRes.ok;

    // Fail-soft: actualización proporcional de datos y errores
    if (encOk) {
      setEncounters(encountersRes.data);
      setEncountersError(null);
    } else {
      setEncounters([]);
      setEncountersError(encountersRes.error || 'error_loading_encounters');
    }

    if (intOk) {
      setIntentions(intentionsRes.data || []);
      setIntentionsError(null);
    } else {
      setIntentions([]);
      setIntentionsError(intentionsRes.error || 'error_loading_intentions');
    }

    // Error general solo si ambas fuentes fallan
    if (!encOk && !intOk) {
      setError('failed_to_load_discovery');
    } else {
      setError(null);
    }

    setLoading(false);
  }, [enabled, localityIds ? localityIds.join(',') : '']);

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
      }
      // Si la RPC falla, se conserva intacto el estado previo

      return res;
    },
    []
  );

  return {
    encounters,
    intentions,
    loading,
    error,
    encountersError,
    intentionsError,
    refresh,
    setIntentionInterest,
  };
}
