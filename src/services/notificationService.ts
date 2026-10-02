import { supabase } from '../lib/supabase';
import type {
  InboxNotificationItem,
  PaginatedInboxResponse,
  InboxUnreadCountResponse,
  MarcarLeidaResponse,
  MarcarTodasLeidasResponse,
} from '../types/notifications';

export const notificationService = {
  /**
   * Obtiene la bandeja de notificaciones in-app del usuario autenticado con paginación cursor.
   * La identidad proviene exclusivamente de auth.uid() en PostgreSQL.
   */
  async getMisNotificaciones(
    limit: number = 20,
    cursorCreatedAt?: string | null,
    cursorId?: string | null
  ): Promise<PaginatedInboxResponse> {
    try {
      const { data, error } = await supabase.rpc('get_mis_notificaciones_inbox_seguro', {
        p_limit: limit,
        p_cursor_created_at: cursorCreatedAt || null,
        p_cursor_id: cursorId || null,
      });

      if (error) {
        return { ok: false, data: [], hasMore: false, error: error.message };
      }

      const res = data as {
        ok: boolean;
        data?: Array<{
          id: string;
          notification_type: string;
          target_type: string;
          target_id: string;
          deep_link: string;
          title: string;
          body: string;
          payload: any;
          read_at: string | null;
          is_read: boolean;
          expires_at: string;
          created_at: string;
        }>;
        has_more?: boolean;
        next_cursor?: { created_at: string; id: string } | null;
        error?: string;
      };

      if (!res?.ok) {
        return { ok: false, data: [], hasMore: false, error: res?.error || 'unknown_error' };
      }

      const items: InboxNotificationItem[] = (res.data || []).map((row) => ({
        id: row.id,
        notificationType: row.notification_type as any,
        targetType: row.target_type as any,
        targetId: row.target_id,
        deepLink: row.deep_link,
        title: row.title,
        body: row.body,
        payload: row.payload,
        readAt: row.read_at,
        isRead: row.is_read,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      }));

      return {
        ok: true,
        data: items,
        hasMore: !!res.has_more,
        nextCursor: res.next_cursor
          ? {
              createdAt: res.next_cursor.created_at,
              id: res.next_cursor.id,
            }
          : null,
      };
    } catch (err: any) {
      return { ok: false, data: [], hasMore: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Obtiene la cantidad de notificaciones activas no leídas del usuario autenticado.
   */
  async getContadorNoLeidas(): Promise<InboxUnreadCountResponse> {
    try {
      const { data, error } = await supabase.rpc('get_contador_notificaciones_no_leidas_seguro');
      if (error) {
        return { ok: false, unreadCount: 0, error: error.message };
      }
      const res = data as { ok: boolean; unread_count?: number; error?: string };
      if (!res?.ok) {
        return { ok: false, unreadCount: 0, error: res?.error || 'unknown_error' };
      }
      return { ok: true, unreadCount: res.unread_count || 0 };
    } catch (err: any) {
      return { ok: false, unreadCount: 0, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Marca una notificación individual como leída vía RPC segura.
   */
  async marcarLeida(notificationId: string): Promise<MarcarLeidaResponse> {
    try {
      if (!notificationId) {
        return { ok: false, error: 'invalid_notification_id' };
      }
      const { data, error } = await supabase.rpc('marcar_notificacion_leida_seguro', {
        p_notification_id: notificationId,
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      const res = data as { ok: boolean; notification_id?: string; read_at?: string; error?: string };
      if (!res?.ok) {
        return { ok: false, error: res?.error || 'unknown_error' };
      }
      return { ok: true, notificationId: res.notification_id, readAt: res.read_at };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Marca todas las notificaciones activas del usuario como leídas.
   */
  async marcarTodasLeidas(): Promise<MarcarTodasLeidasResponse> {
    try {
      const { data, error } = await supabase.rpc('marcar_todas_notificaciones_leidas_seguro');
      if (error) {
        return { ok: false, error: error.message };
      }
      const res = data as { ok: boolean; updated_count?: number; error?: string };
      if (!res?.ok) {
        return { ok: false, error: res?.error || 'unknown_error' };
      }
      return { ok: true, updatedCount: res.updated_count || 0 };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },
};
