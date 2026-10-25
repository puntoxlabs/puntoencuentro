import { supabase } from '../lib/supabase';
import type {
  ModerationQueueItem,
  ModeratorListResponse,
  ModeratorMutationResponse,
} from '../types/trust';
export type { ModeratorUser } from '../types/trust';

export const MODERATION_AUTH_TIMEOUT_MS = 6000;

/**
 * Verifica si el usuario actual está autorizado como moderador (admin o moderator en moderation_authorized_users).
 */
export const checkModerationAuthorization = async (timeoutMs: number = MODERATION_AUTH_TIMEOUT_MS): Promise<boolean> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('moderation_auth_timeout'));
      }, timeoutMs);
    });

    const rpcPromise = (async () => {
      const { data, error } = await supabase.rpc('is_moderation_authorized');
      if (error) throw error;
      return data === true;
    })();

    const result = await Promise.race([rpcPromise, timeoutPromise]);
    return result;
  } catch (error: any) {
    if (error?.message === 'moderation_auth_timeout') {
      console.warn(`[moderationAdminService] Authorization check timed out after ${timeoutMs}ms`);
      throw error;
    }
    console.error('[moderationAdminService] Authorization check failed:', error);
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

/**
 * Verifica si el usuario actual tiene permisos administrativos para gestionar moderadores.
 */
export const checkModerationAdmin = async (timeoutMs: number = MODERATION_AUTH_TIMEOUT_MS): Promise<boolean> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('moderation_admin_timeout'));
      }, timeoutMs);
    });

    const rpcPromise = (async () => {
      const { data, error } = await supabase.rpc('is_moderation_admin');
      if (error) throw error;
      return data === true;
    })();

    const result = await Promise.race([rpcPromise, timeoutPromise]);
    return result;
  } catch (error: any) {
    if (error?.message === 'moderation_admin_timeout') {
      console.warn(`[moderationAdminService] Admin check timed out after ${timeoutMs}ms`);
      throw error;
    }
    console.error('[moderationAdminService] Admin check failed:', error);
    return false;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

/**
 * Obtiene la lista de moderadores autorizados (requiere privilegio administrativo).
 */
export const getModeratorsList = async (): Promise<ModeratorListResponse> => {
  try {
    const { data, error } = await supabase.rpc('listar_moderadores_seguro');
    if (error) {
      return { ok: false, moderators: [], error: error.message };
    }
    return data as ModeratorListResponse;
  } catch (err: any) {
    return { ok: false, moderators: [], error: err?.message || 'unknown_error' };
  }
};

/**
 * Agrega un moderador por email exacto resuelto server-side (sin enumeración).
 */
export const addModeratorByEmail = async (
  email: string,
  role: 'admin' | 'moderator' = 'moderator'
): Promise<ModeratorMutationResponse> => {
  try {
    const { data, error } = await supabase.rpc('agregar_moderador_por_email_seguro', {
      p_email: email,
      p_role: role,
    });
    if (error) {
      return { ok: false, error: error.message, message: error.message };
    }
    return data as ModeratorMutationResponse;
  } catch (err: any) {
    return { ok: false, error: err?.message || 'unknown_error', message: err?.message || 'Error al agregar moderador' };
  }
};

/**
 * Modifica el rol de un moderador existente ('admin' <-> 'moderator').
 */
export const updateModeratorRole = async (
  userId: string,
  role: 'admin' | 'moderator'
): Promise<ModeratorMutationResponse> => {
  try {
    const { data, error } = await supabase.rpc('actualizar_rol_moderador_seguro', {
      p_user_id: userId,
      p_role: role,
    });
    if (error) {
      return { ok: false, error: error.message, message: error.message };
    }
    return data as ModeratorMutationResponse;
  } catch (err: any) {
    return { ok: false, error: err?.message || 'unknown_error', message: err?.message || 'Error al cambiar rol' };
  }
};

/**
 * Revoca el acceso de un moderador de forma lógica (active = false).
 */
export const revokeModerator = async (userId: string): Promise<ModeratorMutationResponse> => {
  try {
    const { data, error } = await supabase.rpc('revocar_moderador_seguro', {
      p_user_id: userId,
    });
    if (error) {
      return { ok: false, error: error.message, message: error.message };
    }
    return data as ModeratorMutationResponse;
  } catch (err: any) {
    return { ok: false, error: err?.message || 'unknown_error', message: err?.message || 'Error al revocar acceso' };
  }
};

/**
 * Obtiene la cola de casos pendientes de moderación pública (más antiguos primero).
 */
export const getModerationQueue = async (): Promise<{ ok: boolean; queue: ModerationQueueItem[]; error?: string }> => {
  try {
    const { data, error } = await supabase.rpc('get_moderation_queue_seguro');
    if (error) {
      return { ok: false, queue: [], error: error.message };
    }
    return data as { ok: boolean; queue: ModerationQueueItem[] };
  } catch (err: any) {
    return { ok: false, queue: [], error: err?.message || 'unknown_error' };
  }
};

/**
 * Resuelve una decisión de moderación (aprobar o rechazar) atómicamente con verificación de hash y concurrencia.
 */
export const resolverModeracion = async (
  encuentroId: string,
  action: 'approve' | 'reject' | 'hide' | 'remove',
  note?: string,
  expectedContentHash?: string
): Promise<{ ok: boolean; error?: string; message?: string; current_status?: string }> => {
  try {
    const { data, error } = await supabase.rpc('resolver_moderacion_encuentro_seguro', {
      p_encuentro_id: encuentroId,
      p_action: action,
      p_note: note ?? null,
      p_expected_content_hash: expectedContentHash ?? null,
    });

    if (error) {
      return { ok: false, error: error.message, message: error.message };
    }

    return data as { ok: boolean; error?: string; message?: string; current_status?: string };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'unknown_error', message: err?.message || 'Error de conexión' };
  }
};

/**
 * Obtiene la cola de controversias de asistencia y realización para moderadores autorizados.
 */
export const getControversiasModeracionQueue = async (
  status?: string
): Promise<{ ok: boolean; queue: import('../types/attendanceDispute').AttendanceDisputeItem[]; error?: string }> => {
  try {
    const { data, error } = await supabase.rpc('get_controversias_moderacion_seguro', {
      p_status: status ?? null,
    });
    if (error) {
      return { ok: false, queue: [], error: error.message };
    }
    const res = data as any;
    return {
      ok: true,
      queue: Array.isArray(res?.queue) ? res.queue : [],
    };
  } catch (err: any) {
    return { ok: false, queue: [], error: err?.message || 'unknown_error' };
  }
};

/**
 * Resuelve una controversia de asistencia desde la moderación humana independiente.
 */
export const resolverControversiaModeracion = async (
  disputeId: string,
  resolucion: import('../types/attendanceDispute').AttendanceDisputeResolution,
  fundamentacion: string
): Promise<{ ok: boolean; status?: string; resolution?: string; error?: string; message?: string }> => {
  try {
    const { data, error } = await supabase.rpc('resolver_controversia_moderacion_seguro', {
      p_dispute_id: disputeId,
      p_resolucion: resolucion,
      p_fundamentacion: fundamentacion,
    });

    if (error) {
      return { ok: false, error: error.message, message: error.message };
    }

    return (data as any) || { ok: false, error: 'empty_response' };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'unknown_error', message: err?.message || 'Error de conexión' };
  }
};
