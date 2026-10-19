import { supabase } from '@/lib/supabase';
import type {
  EncounterTemplateSummary,
  ReusablePayload,
  TemplateServiceResult,
} from '@/types/encounterTemplates';

function parseRpc(data: unknown): any {
  return typeof data === 'string' ? JSON.parse(data) : data;
}

function normalizePayload(raw: any): ReusablePayload {
  return {
    origen: raw?.origen === 'plantilla' ? 'plantilla' : 'encuentro',
    id: raw?.id ?? undefined,
    nombre: raw?.nombre ?? undefined,
    date_mode: raw?.date_mode === 'coordination' ? 'coordination' : 'fixed',
    config: raw?.config ?? {},
    invitados_count: typeof raw?.invitados_count === 'number' ? raw.invitados_count : 0,
    invitados: Array.isArray(raw?.invitados)
      ? raw.invitados.filter((e: unknown): e is string => typeof e === 'string')
      : [],
  };
}

/**
 * Servicio de plantillas/favoritos. Toda la identidad se deriva de auth.uid() en PostgreSQL;
 * el cliente nunca envía user_id/host_id. La creación de encuentros y el envío de invitaciones
 * siguen utilizando las RPCs existentes (encuentrosService / internalInvitationsService).
 */
export const encounterTemplatesService = {
  /** Guarda un favorito a partir de un encuentro PROPIO. La instantánea se arma en el servidor. */
  async guardar(
    encuentroId: string,
    nombre: string,
    incluirInvitados: boolean
  ): Promise<TemplateServiceResult<{ id: string; invitados_count: number }>> {
    const { data, error } = await supabase.rpc('guardar_plantilla_encuentro_seguro', {
      p_encuentro_id: encuentroId,
      p_nombre: nombre,
      p_incluir_invitados: incluirInvitados,
    });
    if (error) {
      console.error('[encounterTemplatesService] guardar:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    if (!r?.ok) return { ok: false, error: r?.error ?? 'unknown_error' };
    return { ok: true, data: { id: r.id, invitados_count: r.invitados_count ?? 0 } };
  },

  async listar(): Promise<TemplateServiceResult<{ plantillas: EncounterTemplateSummary[] }>> {
    const { data, error } = await supabase.rpc('listar_plantillas_encuentro_seguro');
    if (error) {
      console.error('[encounterTemplatesService] listar:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    if (!r?.ok) return { ok: false, error: r?.error ?? 'unknown_error' };
    return { ok: true, data: { plantillas: (r.plantillas ?? []) as EncounterTemplateSummary[] } };
  },

  /** Recupera un favorito propio. Los correos solo se piden con la modalidad "con invitados". */
  async getPlantilla(
    plantillaId: string,
    incluirInvitados: boolean
  ): Promise<TemplateServiceResult<{ payload: ReusablePayload }>> {
    const { data, error } = await supabase.rpc('get_plantilla_encuentro_seguro', {
      p_plantilla_id: plantillaId,
      p_incluir_invitados: incluirInvitados,
    });
    if (error) {
      console.error('[encounterTemplatesService] getPlantilla:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    if (!r?.ok) return { ok: false, error: r?.error ?? 'unknown_error' };
    return { ok: true, data: { payload: normalizePayload(r.plantilla) } };
  },

  /** Lee la configuración reutilizable de un encuentro PROPIO para repetirlo. */
  async getRepeticion(
    encuentroId: string,
    incluirInvitados: boolean
  ): Promise<TemplateServiceResult<{ payload: ReusablePayload }>> {
    const { data, error } = await supabase.rpc('get_repeticion_encuentro_seguro', {
      p_encuentro_id: encuentroId,
      p_incluir_invitados: incluirInvitados,
    });
    if (error) {
      console.error('[encounterTemplatesService] getRepeticion:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    if (!r?.ok) return { ok: false, error: r?.error ?? 'unknown_error' };
    return { ok: true, data: { payload: normalizePayload(r.plantilla) } };
  },

  async renombrar(plantillaId: string, nombre: string): Promise<TemplateServiceResult> {
    const { data, error } = await supabase.rpc('renombrar_plantilla_encuentro_seguro', {
      p_plantilla_id: plantillaId,
      p_nombre: nombre,
    });
    if (error) {
      console.error('[encounterTemplatesService] renombrar:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? 'unknown_error' };
  },

  async eliminar(plantillaId: string): Promise<TemplateServiceResult> {
    const { data, error } = await supabase.rpc('eliminar_plantilla_encuentro_seguro', {
      p_plantilla_id: plantillaId,
    });
    if (error) {
      console.error('[encounterTemplatesService] eliminar:', error);
      return { ok: false, error: 'unknown_error' };
    }
    const r = parseRpc(data);
    return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? 'unknown_error' };
  },
};
