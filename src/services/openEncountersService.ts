import { supabase } from '@/lib/supabase';
import type {
  OpenEncounterSummary,
  Localidad,
  OpenEncounterRequest,
  AbrirEncuentroPayload,
  MiSolicitudItem,
  EncuentroParticipanteAutorizado,
} from '@/components/home/openEncounters/types';
import type {
  PublicContentReportReason,
  ReportPublicEncounterResult,
  ModerationQueueItem,
} from '@/types/trust';

const USER_ZONES_LOCAL_STORAGE_KEY = 'puntoencuentro_user_zones';

export const openEncountersService = {
  /**
   * Obtiene el catálogo de localidades activas desde Supabase.
   */
  async getLocalidades(): Promise<Localidad[]> {
    try {
      const { data, error } = await supabase.rpc('get_localidades_catalogo');
      if (error) {
        console.error('[openEncountersService] Error fetching localidades catalogo:', error);
        return [];
      }
      return (data as Localidad[]) || [];
    } catch (err) {
      console.error('[openEncountersService] Exception fetching localidades:', err);
      return [];
    }
  },

  /**
   * Obtiene las localidades preferidas del usuario (desde backend o fallback localStorage).
   */
  async getUserLocalidades(userId?: string): Promise<string[]> {
    // 1. Fallback rápido desde localStorage
    const local = typeof localStorage !== 'undefined' ? localStorage.getItem(USER_ZONES_LOCAL_STORAGE_KEY) : null;
    let localIds: string[] = [];
    if (local) {
      try {
        localIds = JSON.parse(local);
      } catch {
        /* ignore */
      }
    }

    try {
      const { data, error } = await supabase.rpc('get_user_localidades_seguro', {
        p_user_id: userId ?? null,
      });
      if (error || !data) {
        return localIds;
      }
      const remoteIds = data as string[];
      // Sincronizar en localStorage si vino dato remoto
      if (Array.isArray(remoteIds) && remoteIds.length > 0 && typeof localStorage !== 'undefined') {
        localStorage.setItem(USER_ZONES_LOCAL_STORAGE_KEY, JSON.stringify(remoteIds));
        return remoteIds;
      }
      return localIds;
    } catch {
      return localIds;
    }
  },

  /**
   * Guarda las localidades del usuario tanto en Supabase como en localStorage.
   */
  async setUserLocalidades(localityIds: string[], userId?: string): Promise<boolean> {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(USER_ZONES_LOCAL_STORAGE_KEY, JSON.stringify(localityIds));
      }
      const { data, error } = await supabase.rpc('set_user_localidades_seguro', {
        p_locality_ids: localityIds,
        p_user_id: userId ?? null,
      });
      if (error) {
        console.warn('[openEncountersService] Error saving user localidades remote:', error);
      }
      return (data as any)?.ok ?? true;
    } catch (err) {
      console.warn('[openEncountersService] Failed to set user localidades:', err);
      return true; // LocalStorage ya se guardó
    }
  },

  /**
   * Obtiene los encuentros abiertos para Discovery desde el backend seguro con estado detallado.
   * Permite a capas compuestas (como useUnifiedDiscovery) diferenciar entre resultado vacío y error.
   */
  async getDiscoveryEncuentrosWithStatus(
    localityIds?: string[]
  ): Promise<{ ok: boolean; data: OpenEncounterSummary[]; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('get_discovery_encuentros_abiertos', {
        p_locality_ids: localityIds && localityIds.length > 0 ? localityIds : null,
      });

      if (error) {
        return { ok: false, data: [], error: error.message };
      }

      if (!Array.isArray(data)) {
        return { ok: true, data: [] };
      }

      const mapped: OpenEncounterSummary[] = data.map((item: any) => ({
        id: item.id,
        title: item.title,
        emoji: item.emoji,
        activityType: item.activity_type,
        startsAt: item.starts_at,
        dateLabel: item.date_label,
        approximateZone: item.approximate_zone,
        localityId: item.locality_id,
        openSlots: Number(item.open_slots ?? 0),
        confirmedCount: Number(item.confirmed_seats ?? item.confirmed_count ?? 0),
        confirmedSeats: Number(item.confirmed_seats ?? item.confirmed_count ?? 0),
        language: item.language || 'es',
        description: item.description,
        hostName: item.host_name,
        hostId: item.host_id,
        allowMultiSeatRequests: Boolean(item.allow_multi_seat_requests),
        maxSeatsPerRequest: Number(item.max_seats_per_request ?? 1),
        minSeatsPerRequest: Number(item.min_seats_per_request ?? 1),
        isHost: Boolean(item.is_host),
        minParticipants: item.min_participants ?? null,
        realizationStatus: item.realization_status || 'pending',
        inscriptionsClosed: Boolean(item.inscriptions_closed),
      }));

      return { ok: true, data: mapped };
    } catch (err: any) {
      return { ok: false, data: [], error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Obtiene los encuentros abiertos para Discovery desde el backend seguro.
   * Filtra por localidades seleccionadas si se proporcionan.
   * NUNCA expone dirección exacta ni tokens privados.
   */
  async getDiscoveryEncuentros(localityIds?: string[]): Promise<OpenEncounterSummary[]> {
    const res = await this.getDiscoveryEncuentrosWithStatus(localityIds);
    if (!res.ok) {
      console.error('[openEncountersService] Error fetching discovery encuentros:', res.error);
      return [];
    }
    return res.data;
  },

  /**
   * Obtiene un encuentro abierto por su ID de manera segura para Discovery o deep link.
   * Si no existe o no está abierto, retorna null.
   */
  async getEncuentroAbiertoById(encounterId: string): Promise<OpenEncounterSummary | null> {
    try {
      const res = await this.getDiscoveryEncuentrosWithStatus();
      if (res.ok && Array.isArray(res.data)) {
        const found = res.data.find((e) => e.id === encounterId);
        if (found) {
          return found;
        }
      }

      // Microcheck C: Fallback para deep links cuando el usuario está autorizado
      // (ej. el usuario es Host o participante aprobado, o el encuentro está cerrado/completo para Discovery)
      const authRes = await this.getEncuentroParticipanteAutorizado(encounterId);
      if (authRes && authRes.ok && authRes.id) {
        const timePart = authRes.hora ? authRes.hora.substring(0, 5) : '';
        const dateLabel = authRes.fecha ? `${authRes.fecha}${timePart ? ` · ${timePart}` : ''}` : '';
        const zone = authRes.open_public_zone || (authRes.modalidad === 'virtual' ? 'Online' : 'Ubicación confirmada');
        return {
          id: authRes.id,
          title: authRes.open_public_title || 'Encuentro',
          startsAt: `${authRes.fecha || ''}T${authRes.hora || '00:00:00'}`,
          dateLabel,
          approximateZone: zone,
          localityId: '',
          openSlots: 0,
          confirmedCount: 0,
          confirmedSeats: 0,
          language: 'es',
          description: authRes.open_description || '',
          hostId: authRes.is_host ? 'current-user' : '',
          allowMultiSeatRequests: false,
          maxSeatsPerRequest: 1,
        };
      }

      return null;
    } catch (err) {
      console.warn('[openEncountersService] Error fetching encuentro abierto by id:', err);
      return null;
    }
  },

  /**
   * Abre un encuentro existente para que aparezca en Discovery.
   */
  async abrirEncuentro(
    encuentroId: string,
    hostId: string,
    payload: AbrirEncuentroPayload
  ): Promise<{
    ok: boolean;
    is_open?: boolean;
    moderation_status?: string;
    message?: string;
    reason?: string;
    error?: string;
  }> {
    // 1. Choke point server-side: valida permisos, datos privados y aplica reglas deterministas.
    // El RPC SIEMPRE deja el encuentro no bloqueado en review_pending e is_open = false.
    const { data, error } = await supabase.rpc('abrir_encuentro_seguro', {
      p_encuentro_id: encuentroId,
      p_host_id: hostId,
      p_open_description: payload.open_description,
      p_max_participants: payload.max_participants,
      p_locality_id: payload.locality_id,
      p_open_public_zone: payload.open_public_zone ?? null,
      p_open_public_title: payload.open_public_title ?? null,
      p_allow_multi_seat_requests: payload.allow_multi_seat_requests ?? false,
      p_max_seats_per_request: payload.max_seats_per_request ?? 1,
      p_min_seats_per_request: payload.min_seats_per_request ?? 1,
    });

    if (error) {
      console.error('[openEncountersService] Error abriendo encuentro:', error);
      throw error;
    }

    const rpcResult = data as any;
    if (!rpcResult?.ok) {
      return rpcResult;
    }

    // 2. Choke point: Invocar pipeline de moderación semántica en Edge Function (sólo encounter_id)
    try {
      const funcRes = await supabase.functions.invoke('moderate-public-content', {
        body: {
          encounter_id: encuentroId,
        },
      });

      if (funcRes.data?.ok && funcRes.data?.data?.decision === 'allow' && funcRes.data?.data?.is_open) {
        return {
          ok: true,
          is_open: true,
          moderation_status: 'approved',
          message: 'Encuentro moderado y publicado exitosamente.',
        };
      } else if (funcRes.data?.ok && funcRes.data?.data?.decision === 'block') {
        return {
          ok: false,
          is_open: false,
          moderation_status: 'rejected',
          error: 'content_moderation_blocked',
          reason: funcRes.data?.data?.reason_code,
        };
      }
    } catch (fnErr) {
      console.warn('[openEncountersService] Edge function moderation diferida o fallida; permanece en review_pending:', fnErr);
    }

    // Si permanece en review_pending (por decisión de revisión o fail-safe por timeout/error de función)
    return {
      ok: true,
      is_open: false,
      moderation_status: 'review_pending',
      message: rpcResult.message || 'Estamos revisando esta publicación antes de mostrarla públicamente.',
    };
  },

  /**
   * Cierra un encuentro al Discovery (no elimina participantes ni el encuentro).
   */
  async cerrarEncuentro(
    encuentroId: string,
    hostId: string
  ): Promise<{ ok: boolean; error?: string }> {
    const { data, error } = await supabase.rpc('cerrar_encuentro_abierto_seguro', {
      p_encuentro_id: encuentroId,
      p_host_id: hostId,
    });

    if (error) {
      console.error('[openEncountersService] Error cerrando encuentro abierto:', error);
      throw error;
    }

    return data as any;
  },

  /**
   * Solicita sumarse a un encuentro abierto.
   *
   * SEGURIDAD: la identidad del solicitante se deriva exclusivamente del JWT (auth.uid()).
   * No se envía p_usuario_id — el backend lo ignora y usa solo auth.uid().
   * Requiere usuario permanente (no anónimo) autenticado.
   */
  async solicitarSumarse(
    encuentroId: string,
    nombre: string,
    mensaje?: string,
    seatCount: number = 1
  ): Promise<{
    ok: boolean;
    request_id?: string;
    error?: string;
    seat_count?: number;
    message?: string;
    available_slots?: number;
    min_seats_per_request?: number;
  }> {
    const { data, error } = await supabase.rpc('solicitar_sumarse_encuentro_abierto', {
      p_encuentro_id: encuentroId,
      p_nombre: nombre,
      p_mensaje: mensaje ?? null,
      p_seat_count: seatCount,
      // p_usuario_id: no se envía — identidad via JWT únicamente
    });

    if (error) {
      console.error('[openEncountersService] Error solicitando sumarse:', error);
      throw error;
    }

    return data as any;
  },

  /**
   * Consulta el estado de la solicitud del usuario actual para un encuentro.
   */
  async getMiSolicitud(
    encuentroId: string,
    usuarioId: string
  ): Promise<{
    ok: boolean;
    has_request: boolean;
    request_id?: string;
    estado?: 'pending' | 'approved' | 'rejected' | 'withdrawn';
    token_participante?: string;
    created_at?: string;
  }> {
    const { data, error } = await supabase.rpc('get_mi_solicitud_encuentro_abierto', {
      p_encuentro_id: encuentroId,
      p_usuario_id: usuarioId,
    });

    if (error) {
      console.error('[openEncountersService] Error fetching mi solicitud:', error);
      return { ok: false, has_request: false };
    }

    return data as any;
  },

  /**
   * Obtiene todas las solicitudes del encuentro (sólo accesible para el host).
   */
  async getSolicitudesHost(
    encuentroId: string,
    hostId: string
  ): Promise<OpenEncounterRequest[]> {
    const { data, error } = await supabase.rpc('get_solicitudes_host_seguro', {
      p_encuentro_id: encuentroId,
      p_host_id: hostId,
    });

    if (error) {
      console.error('[openEncountersService] Error fetching solicitudes host:', error);
      return [];
    }

    const res = data as any;
    if (!res?.ok || !Array.isArray(res.solicitudes)) {
      return [];
    }

    return res.solicitudes;
  },

  /**
   * Aprueba transaccionalmente una solicitud y crea al participante regular.
   */
  async aprobarSolicitud(
    requestId: string,
    hostId: string
  ): Promise<{ ok: boolean; error?: string; participante_id?: string; token_invitacion?: string }> {
    const { data, error } = await supabase.rpc('aprobar_solicitud_encuentro_abierto', {
      p_request_id: requestId,
      p_host_id: hostId,
    });

    if (error) {
      console.error('[openEncountersService] Error aprobando solicitud:', error);
      throw error;
    }

    return data as any;
  },

  /**
   * Rechaza una solicitud pendiente.
   */
  async rechazarSolicitud(
    requestId: string,
    hostId: string
  ): Promise<{ ok: boolean; error?: string }> {
    const { data, error } = await supabase.rpc('rechazar_solicitud_encuentro_abierto', {
      p_request_id: requestId,
      p_host_id: hostId,
    });

    if (error) {
      console.error('[openEncountersService] Error rechazando solicitud:', error);
      throw error;
    }

    return data as any;
  },

  /**
   * Reporta un encuentro público desde Discovery o detalle con deduplicación y rate limiting.
   */
  async reportarEncuentroPublico(
    encuentroId: string,
    reason: PublicContentReportReason,
    comment?: string
  ): Promise<ReportPublicEncounterResult> {
    try {
      const { data, error } = await supabase.rpc('reportar_encuentro_publico_seguro', {
        p_encuentro_id: encuentroId,
        p_reason: reason,
        p_comment: comment ?? null,
      });

      if (error) {
        console.error('[openEncountersService] Error reportando encuentro:', error);
        return { ok: false, error: error.message };
      }

      return data as ReportPublicEncounterResult;
    } catch (err: any) {
      console.error('[openEncountersService] Exception reportando encuentro:', err);
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Obtiene la cola de moderación administrativa (requiere admin/qa).
   */
  async getModerationQueue(): Promise<{ ok: boolean; queue: ModerationQueueItem[]; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('get_moderation_queue_seguro');
      if (error) {
        return { ok: false, queue: [], error: error.message };
      }
      return data as { ok: boolean; queue: ModerationQueueItem[] };
    } catch (err: any) {
      return { ok: false, queue: [], error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Resuelve una decisión administrativa de moderación (aprobar, ocultar, eliminar, rechazar).
   */
  async resolverModeracionEncuentro(
    encuentroId: string,
    action: 'approve' | 'hide' | 'remove' | 'reject',
    note?: string
  ): Promise<{ ok: boolean; new_status?: string; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('resolver_moderacion_encuentro_seguro', {
        p_encuentro_id: encuentroId,
        p_action: action,
        p_note: note ?? null,
      });

      if (error) {
        return { ok: false, error: error.message };
      }

      return data as { ok: boolean; new_status?: string };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Obtiene el listado durable no sensible de Mis solicitudes para el usuario actual.
   */
  async getMisSolicitudes(): Promise<MiSolicitudItem[]> {
    try {
      const { data, error } = await supabase.rpc('get_mis_solicitudes_seguro');
      if (error) {
        console.error('[openEncountersService] Error fetching mis solicitudes:', error);
        return [];
      }
      return (data as MiSolicitudItem[]) || [];
    } catch (err) {
      console.error('[openEncountersService] Exception fetching mis solicitudes:', err);
      return [];
    }
  },

  /**
   * Cancela una solicitud en estado pending de forma transaccional y server-side.
   */
  async cancelarSolicitud(requestId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('cancelar_solicitud_encuentro_abierto', {
        p_request_id: requestId,
      });
      if (error) {
        console.error('[openEncountersService] Error cancelando solicitud:', error);
        return { ok: false, error: error.message };
      }
      return data as { ok: boolean; error?: string };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Obtiene la logística y detalle privado autorizado para un participante confirmado o anfitrión.
   */
  async getEncuentroParticipanteAutorizado(
    encounterId: string
  ): Promise<EncuentroParticipanteAutorizado> {
    try {
      const { data, error } = await supabase.rpc('get_encuentro_participante_autorizado', {
        p_encuentro_id: encounterId,
      });
      if (error) {
        console.error('[openEncountersService] Error fetching participante autorizado:', error);
        return { ok: false, error: error.message };
      }
      return data as EncuentroParticipanteAutorizado;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Configura o actualiza el mínimo de participantes requeridos y recalcula el estado de realización.
   */
  async setMinParticipants(
    encounterId: string,
    hostId: string,
    minParticipants: number | null,
    confirmReversion: boolean = false
  ): Promise<{ ok: boolean; min_participants?: number | null; realization_status?: string; error?: string; message?: string }> {
    try {
      const { data, error } = await supabase.rpc('set_min_participants_seguro', {
        p_encuentro_id: encounterId,
        p_host_id: hostId,
        p_min_participants: minParticipants,
        p_confirm_reversion: confirmReversion,
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      return data as any;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * El anfitrión fuerza la realización del encuentro aun estando por debajo del mínimo ("Hacerlo igual").
   */
  async hacerloIgual(
    encounterId: string,
    hostId: string
  ): Promise<{ ok: boolean; realization_status?: string; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('hacerlo_igual_seguro', {
        p_encuentro_id: encounterId,
        p_host_id: hostId,
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      return data as any;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Cierra inscripciones para nuevas solicitudes y envía confirmación final si está confirmado/forzado.
   */
  async cerrarInscripciones(
    encounterId: string,
    hostId: string
  ): Promise<{ ok: boolean; inscriptions_closed?: boolean; final_confirmation_sent?: boolean; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('cerrar_inscripciones_seguro', {
        p_encuentro_id: encounterId,
        p_host_id: hostId,
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      return data as any;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * Reabre inscripciones si el encuentro está activo y no cancelado.
   */
  async reabrirInscripciones(
    encounterId: string,
    hostId: string
  ): Promise<{ ok: boolean; inscriptions_closed?: boolean; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('reabrir_inscripciones_seguro', {
        p_encuentro_id: encounterId,
        p_host_id: hostId,
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      return data as any;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },

  /**
   * El participante confirmado reconfirma su asistencia ('confirm') o desiste liberando lugares ('decline').
   */
  async reconfirmarAsistencia(
    encounterId: string,
    decision: 'confirm' | 'decline'
  ): Promise<{ ok: boolean; decision?: string; reconfirmation_status?: string; error?: string }> {
    try {
      const { data, error } = await supabase.rpc('reconfirmar_asistencia_seguro', {
        p_encuentro_id: encounterId,
        p_decision: decision,
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      return data as any;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },
};
