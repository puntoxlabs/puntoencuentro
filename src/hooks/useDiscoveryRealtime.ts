import { useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';

export interface UseDiscoveryRealtimeOptions {
  enabled: boolean;
  onRefresh: () => void | Promise<void>;
  debounceMs?: number;
}

/**
 * Hook de suscripción en tiempo real para Discovery V2.
 * Escucha cambios en las tablas canónicas:
 * - public.encuentros (INSERT, UPDATE, DELETE)
 * - public.participantes (INSERT, UPDATE, DELETE)
 *
 * Aplica debounce coalescente (default 300ms) para consolidar eventos rápidos
 * y re-consulta la RPC canónica get_discovery_encuentros_abiertos server-side.
 * NO modifica estado client-side directamente con payloads de Realtime.
 * Limpia suscripción y timers al desmontar.
 */
export function useDiscoveryRealtime({
  enabled,
  onRefresh,
  debounceMs = 300,
}: UseDiscoveryRealtimeOptions) {
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const handleRealtimeChange = () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        onRefreshRef.current();
      }, debounceMs);
    };

    const channelName = `discovery_realtime_${Math.random().toString(36).substring(2, 9)}`;
    const channel = supabase.channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'encuentros' },
        handleRealtimeChange
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'participantes' },
        handleRealtimeChange
      )
      .subscribe();

    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      supabase.removeChannel(channel);
    };
  }, [enabled, debounceMs]);
}
