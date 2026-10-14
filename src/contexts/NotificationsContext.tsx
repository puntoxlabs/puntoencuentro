import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import { notificationService } from '../services/notificationService';
import type { InboxNotificationItem } from '../types/notifications';

export interface IncomingMatchEvent {
  encounterId: string;
  notificationId?: string;
  payload?: any;
}

export type IncomingMatchListener = (event: IncomingMatchEvent) => void;

interface NotificationsContextValue {
  unreadCount: number;
  notifications: InboxNotificationItem[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  fetchUnreadCount: () => Promise<void>;
  fetchNotifications: (reset?: boolean) => Promise<void>;
  marcarLeida: (id: string) => Promise<boolean>;
  marcarTodasLeidas: () => Promise<boolean>;
  cargarMas: () => Promise<void>;
  subscribeToIncomingMatches: (listener: IncomingMatchListener) => () => void;
}

const NotificationsContext = createContext<NotificationsContextValue | undefined>(undefined);

export const NotificationsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isPermanentUser, loading: authLoading } = useAuth();

  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [notifications, setNotifications] = useState<InboxNotificationItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [nextCursor, setNextCursor] = useState<{ createdAt: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState<boolean>(false);

  // Ref para evitar condiciones de carrera entre peticiones simultáneas
  const activeFetchRef = useRef<number>(0);

  // Registro de listeners activos para eventos en vivo de matches de Mis Ganas
  const matchListenersRef = useRef<Set<IncomingMatchListener>>(new Set());

  const subscribeToIncomingMatches = useCallback((listener: IncomingMatchListener) => {
    matchListenersRef.current.add(listener);
    return () => {
      matchListenersRef.current.delete(listener);
    };
  }, []);

  // 1. Obtener conteo de no leídas
  const fetchUnreadCount = useCallback(async () => {
    if (!isPermanentUser) {
      setUnreadCount(0);
      return;
    }
    const res = await notificationService.getContadorNoLeidas();
    if (res.ok) {
      setUnreadCount(res.unreadCount);
    }
  }, [isPermanentUser]);

  // 2. Obtener lista inicial o refrescar
  const fetchNotifications = useCallback(async (reset: boolean = false) => {
    if (!isPermanentUser) {
      setNotifications([]);
      setHasMore(false);
      setNextCursor(null);
      return;
    }

    if (reset) {
      setNextCursor(null);
    }

    const fetchId = ++activeFetchRef.current;
    setLoading(true);
    setError(null);

    const res = await notificationService.getMisNotificaciones(20, null, null);

    if (fetchId !== activeFetchRef.current) return;

    if (res.ok) {
      setNotifications(res.data);
      setHasMore(res.hasMore);
      setNextCursor(res.nextCursor || null);
    } else {
      setError(res.error || 'Error al cargar notificaciones');
    }
    setLoading(false);
  }, [isPermanentUser]);

  // 3. Paginación: Cargar siguiente lote
  const cargarMas = useCallback(async () => {
    if (!isPermanentUser || !hasMore || !nextCursor || loadingMore) {
      return;
    }

    setLoadingMore(true);
    const res = await notificationService.getMisNotificaciones(
      20,
      nextCursor.createdAt,
      nextCursor.id
    );

    if (res.ok) {
      setNotifications((prev) => [...prev, ...res.data]);
      setHasMore(res.hasMore);
      setNextCursor(res.nextCursor || null);
    } else {
      console.warn('[Notifications] Error cargando más notificaciones:', res.error);
    }
    setLoadingMore(false);
  }, [isPermanentUser, hasMore, nextCursor, loadingMore]);

  // 4. Marcar notificación individual como leída (optimista + server-side)
  const marcarLeida = useCallback(async (id: string): Promise<boolean> => {
    // Comprobar si ya estaba leída en el estado local
    const target = notifications.find((n) => n.id === id);
    const wasUnread = target ? !target.isRead : true;

    // Actualización optimista inmediata
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n))
    );
    if (wasUnread) {
      setUnreadCount((prev) => Math.max(0, prev - 1));
    }

    const res = await notificationService.marcarLeida(id);
    if (!res.ok) {
      // Revertir y sincronizar con servidor en caso de error
      fetchUnreadCount();
      return false;
    }
    return true;
  }, [notifications, fetchUnreadCount]);

  // 5. Marcar todas las notificaciones como leídas
  const marcarTodasLeidas = useCallback(async (): Promise<boolean> => {
    // Actualización optimista inmediata
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, isRead: true, readAt: n.readAt || new Date().toISOString() }))
    );
    setUnreadCount(0);

    const res = await notificationService.marcarTodasLeidas();
    if (!res.ok) {
      fetchUnreadCount();
      return false;
    }
    return true;
  }, [fetchUnreadCount]);

  // 6. Efecto de cambio de sesión / autenticación
  useEffect(() => {
    if (authLoading) return;

    if (!isPermanentUser) {
      // Limpiar estrictamente datos locales si no hay sesión permanente
      setUnreadCount(0);
      setNotifications([]);
      setHasMore(false);
      setNextCursor(null);
      setError(null);
      setIsOpen(false);
      return;
    }

    // Usuario permanente autenticado: carga inicial de contador
    fetchUnreadCount();
  }, [authLoading, isPermanentUser, user?.id, fetchUnreadCount]);

  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const fetchUnreadCountRef = useRef(fetchUnreadCount);
  fetchUnreadCountRef.current = fetchUnreadCount;

  const fetchNotificationsRef = useRef(fetchNotifications);
  fetchNotificationsRef.current = fetchNotifications;

  // 6.1. Suscripción Realtime en app abierta para inbox_notifications
  useEffect(() => {
    if (!isPermanentUser || !user?.id) return;

    const channel = supabase
      .channel(`inbox_notifications_user:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'inbox_notifications',
          filter: `recipient_user_id=eq.${user.id}`,
        },
        (change) => {
          fetchUnreadCountRef.current();
          if (isOpenRef.current) {
            fetchNotificationsRef.current(true);
          }

          const newRow = change?.new as any;
          if (newRow && (newRow.target_type === 'encounter' || newRow.notification_type === 'match_found')) {
            const isMatch =
              newRow.notification_type === 'match_found' ||
              newRow.notification_type === 'match_alert' ||
              newRow.notification_type === 'intention_converted_to_encounter' ||
              newRow.notification_type === 'interes_convertido' ||
              (newRow.target_type === 'encounter' && Boolean(newRow.payload?.primary_source === 'intention'));

            let rawPayload = newRow.payload;
            if (typeof rawPayload === 'string') {
              try {
                rawPayload = JSON.parse(rawPayload);
              } catch {
                // ignore
              }
            }

            const encounterId =
              newRow.target_id ||
              rawPayload?.encounter_id ||
              rawPayload?.encounterId ||
              rawPayload?.data?.encounterId ||
              rawPayload?.data?.encounter_id;

            if (isMatch && encounterId) {
              matchListenersRef.current.forEach((listener) => {
                try {
                  listener({
                    encounterId: String(encounterId),
                    notificationId: newRow.id,
                    payload: rawPayload,
                  });
                } catch (err) {
                  console.error('[NotificationsContext] Error notificando match listener:', err);
                }
              });
            }
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isPermanentUser, user?.id]);

  // 7. Revalidación al volver a primer plano (visibilitychange)
  useEffect(() => {
    if (!isPermanentUser) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchUnreadCount();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isPermanentUser, fetchUnreadCount]);

  // 8. Revalidación al abrir la bandeja
  useEffect(() => {
    if (isOpen && isPermanentUser) {
      fetchNotifications(true);
      fetchUnreadCount();
    }
  }, [isOpen, isPermanentUser, fetchNotifications, fetchUnreadCount]);

  return (
    <NotificationsContext.Provider
      value={{
        unreadCount,
        notifications,
        loading,
        loadingMore,
        hasMore,
        error,
        isOpen,
        setIsOpen,
        fetchUnreadCount,
        fetchNotifications,
        marcarLeida,
        marcarTodasLeidas,
        cargarMas,
        subscribeToIncomingMatches,
      }}
    >
      {children}
    </NotificationsContext.Provider>
  );
};

export const useNotifications = () => {
  const context = useContext(NotificationsContext);
  if (!context) {
    throw new Error('useNotifications debe utilizarse dentro de un NotificationsProvider');
  }
  return context;
};
