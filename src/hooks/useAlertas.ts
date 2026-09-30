import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { alertasService } from '../services/alertasService';
import type {
  AlertaCompatibilidad,
  AlertasServiceResult,
  MarcarLeidaResult,
  UseAlertasReturn,
} from '../types/alertas';

export function useAlertas(): UseAlertasReturn {
  const { user, loading: authLoading } = useAuth();
  const [alertas, setAlertas] = useState<AlertaCompatibilidad[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAlertas = useCallback(async () => {
    // Si la autenticación aún está resolviéndose, esperar
    if (authLoading) {
      return;
    }

    // Las alertas sólo aplican a cuentas permanentes
    if (!user || user.is_anonymous) {
      setAlertas([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const res = await alertasService.getMisAlertas();
    if (res.ok && res.data) {
      // Preservar orden del backend (created_at DESC)
      setAlertas(res.data);
    } else {
      setError(res.error || 'Error al cargar alertas');
    }
    setLoading(false);
  }, [authLoading, user?.id, user?.is_anonymous]);

  useEffect(() => {
    fetchAlertas();
  }, [fetchAlertas]);

  // Contador local reactivo de alertas no leídas
  const unreadCount = useMemo(() => {
    return alertas.filter((a) => !a.leida).length;
  }, [alertas]);

  // Marcado como leída seguro sin optimistic update previo a respuesta del servidor
  const marcarLeida = useCallback(
    async (alertaId: string): Promise<AlertasServiceResult<MarcarLeidaResult>> => {
      const res = await alertasService.marcarLeida(alertaId);
      if (res.ok && res.data) {
        // Actualizar únicamente esa alerta localmente sin re-fetch innecesario
        setAlertas((prev) =>
          prev.map((a) => (a.id === alertaId ? { ...a, leida: true } : a))
        );
      }
      // Si falla, conserva estado previo automáticamente
      return res;
    },
    []
  );

  return {
    alertas,
    unreadCount,
    loading,
    error,
    refresh: fetchAlertas,
    marcarLeida,
  };
}
