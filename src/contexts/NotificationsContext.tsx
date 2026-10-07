import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import { notificationService } from '../services/notificationService';
import type { InboxNotificationItem } from '../types/notifications';

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
        () => {
          fetchUnreadCount();
          if (isOpen) {
            fetchNotifications(true);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isPermanentUser, user?.id, isOpen, fetchUnreadCount, fetchNotifications]);

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
      }}
    >
      {children}
    </NotificationsContext.Provider>
  );
};

const DEFAULT_NOTIFICATIONS_CONTEXT: NotificationsContextValue = {
  unreadCount: 0,
  notifications: [],
  loading: false,
  loadingMore: false,
  hasMore: false,
  error: null,
  isOpen: false,
  setIsOpen: () => {},
  fetchUnreadCount: async () => {},
  fetchNotifications: async () => {},
  marcarLeida: async () => false,
  marcarTodasLeidas: async () => false,
  cargarMas: async () => {},
};

export const useNotifications = () => {
  const context = useContext(NotificationsContext);
  return context || DEFAULT_NOTIFICATIONS_CONTEXT;
};
