import { supabase } from '@/lib/supabase';
import { ensureHostSession } from '@/lib/ensureHostSession';

export type CoverageResultType =
  | 'existing_locality'
  | 'request_created'
  | 'request_updated'
  | 'unknown_created'
  | 'unknown_updated';

export interface CoverageResponse {
  ok: boolean;
  result_type?: CoverageResultType;
  market_key?: string;
  market_label?: string;
  raw_location?: string;
  existing_locality_id?: string;
  existing_locality_name?: string;
  error?: string;
}

export const coverageService = {
  /**
   * Envía una solicitud de cobertura territorial a la RPC segura server-side.
   * Asegura sesión válida previa (anónima o permanente) vía ensureHostSession.
   */
  async submitCoverageRequest(
    locationText: string,
    intentText?: string | null
  ): Promise<CoverageResponse> {
    try {
      await ensureHostSession();

      const { data, error } = await supabase.rpc('submit_coverage_request', {
        p_location_text: locationText,
        p_intent_text: intentText && intentText.trim() ? intentText.trim() : null,
      });

      if (error) {
        console.error('[coverageService] RPC error:', error);
        return { ok: false, error: error.message };
      }

      return (data as CoverageResponse) || { ok: false, error: 'empty_response' };
    } catch (err: any) {
      console.error('[coverageService] Exception:', err);
      return { ok: false, error: err?.message || 'unknown_error' };
    }
  },
};
