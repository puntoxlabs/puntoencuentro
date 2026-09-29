import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { intencionesService } from '../services/intencionesService';
import type {
  Intencion,
  CrearIntencionPayload,
  EditarIntencionPayload,
  EstadoIntencion,
  IntencionesServiceResult,
} from '../types/intenciones';

export function useIntenciones() {
  const { user, loading: authLoading } = useAuth();
  const [intenciones, setIntenciones] = useState<Intencion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchIntenciones = useCallback(async () => {
    // Si la autenticación aún está cargando o no hay usuario permanente, no fetch
    if (authLoading || !user || user.is_anonymous) {
      setIntenciones([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const res = await intencionesService.getMisIntenciones();
    if (res.ok && res.data) {
      setIntenciones(res.data);
    } else {
      setError(res.error || 'Error al cargar intenciones');
    }
    setLoading(false);
  }, [authLoading, user?.id, user?.is_anonymous]);

  useEffect(() => {
    fetchIntenciones();
  }, [fetchIntenciones]);

  const crearIntencion = useCallback(
    async (payload: CrearIntencionPayload): Promise<IntencionesServiceResult<string>> => {
      const res = await intencionesService.crearIntencion(payload);
      if (res.ok) {
        await fetchIntenciones();
      }
      return res;
    },
    [fetchIntenciones]
  );

  const editarIntencion = useCallback(
    async (payload: EditarIntencionPayload): Promise<IntencionesServiceResult<string>> => {
      const res = await intencionesService.editarIntencion(payload);
      if (res.ok) {
        await fetchIntenciones();
      }
      return res;
    },
    [fetchIntenciones]
  );

  const cambiarEstado = useCallback(
    async (id: string, nuevoEstado: EstadoIntencion): Promise<IntencionesServiceResult<EstadoIntencion>> => {
      const res = await intencionesService.cambiarEstado(id, nuevoEstado);
      if (res.ok) {
        await fetchIntenciones();
      }
      return res;
    },
    [fetchIntenciones]
  );

  const pausarIntencion = useCallback(
    async (id: string): Promise<IntencionesServiceResult<EstadoIntencion>> => {
      const res = await intencionesService.pausarIntencion(id);
      if (res.ok) {
        await fetchIntenciones();
      }
      return res;
    },
    [fetchIntenciones]
  );

  const reactivarIntencion = useCallback(
    async (id: string): Promise<IntencionesServiceResult<EstadoIntencion>> => {
      const res = await intencionesService.reactivarIntencion(id);
      if (res.ok) {
        await fetchIntenciones();
      }
      return res;
    },
    [fetchIntenciones]
  );

  const cerrarIntencion = useCallback(
    async (id: string): Promise<IntencionesServiceResult<EstadoIntencion>> => {
      const res = await intencionesService.cerrarIntencion(id);
      if (res.ok) {
        await fetchIntenciones();
      }
      return res;
    },
    [fetchIntenciones]
  );

  return {
    intenciones,
    loading,
    error,
    refresh: fetchIntenciones,
    crearIntencion,
    editarIntencion,
    cambiarEstado,
    pausarIntencion,
    reactivarIntencion,
    cerrarIntencion,
  };
}
