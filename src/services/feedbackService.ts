import { supabase } from '@/lib/supabase';

export type FeedbackCategory = 'issue' | 'suggestion' | 'general';

export interface SubmitFeedbackParams {
  category: FeedbackCategory;
  comment: string;
  pageRoute?: string;
  honeypot?: string;
}

export interface SubmitFeedbackResult {
  ok: boolean;
  id?: string;
  error?:
    | 'authentication_required'
    | 'permanent_account_required'
    | 'rate_limit_exceeded'
    | 'invalid_submission'
    | 'invalid_comment_length'
    | string;
}

/**
 * Normaliza rutas permitidas sustituyendo tokens, hashes e IDs privados por identificadores canónicos literales.
 * Rutas no reconocidas o dinámicas desconocidas se reducen a null para evitar filtración de PII.
 */
export function normalizeRouteForFeedback(rawRoute?: string): string | null {
  if (!rawRoute) return null;

  // Descartar query string, fragmento y protocolo
  let clean = rawRoute.trim();
  if (clean.includes('?')) clean = clean.split('?')[0];
  if (clean.includes('#')) clean = clean.split('#')[0];
  if (clean.includes('://')) {
    try {
      clean = new URL(clean).pathname;
    } catch {
      return null;
    }
  }

  if (clean === '' || clean === '/') return '/';
  if (clean === '/create') return '/create';
  if (clean === '/create/ai') return '/create/ai';
  if (clean === '/create/coordination') return '/create/coordination';
  if (/^\/meet\/[^/]+$/.test(clean)) return '/meet/:id';
  if (/^\/coordination\/invite\/[^/]+$/.test(clean)) return '/coordination/invite/:token';
  if (/^\/coordination\/join\/[^/]+$/.test(clean)) return '/coordination/join/:token';
  if (/^\/coordination\/[^/]+$/.test(clean)) return '/coordination/:id';
  if (/^\/invite\/[^/]+$/.test(clean)) return '/invite/:token';
  if (/^\/join\/[^/]+$/.test(clean)) return '/join/:token';
  if (/^\/add-guests\/[^/]+$/.test(clean)) return '/add-guests/:id';
  if (/^\/share\/[^/]+$/.test(clean)) return '/share/:id';
  if (/^\/invitation\/[^/]+$/.test(clean)) return '/invitation/:id';
  if (/^\/cancel-summary\/[^/]+$/.test(clean)) return '/cancel-summary/:id';
  if (/^\/internal\/qa\/sessions\/[^/]+$/.test(clean)) return '/internal/qa/sessions/:sessionId';
  if (clean === '/internal/qa/sessions') return '/internal/qa/sessions';
  if (clean === '/internal/qa') return '/internal/qa';
  if (clean === '/internal/moderation') return '/internal/moderation';

  return null;
}

export const feedbackService = {
  async submitFeedback(params: SubmitFeedbackParams): Promise<SubmitFeedbackResult> {
    const trimmed = params.comment.trim();
    if (trimmed.length < 3 || trimmed.length > 1000) {
      return { ok: false, error: 'invalid_comment_length' };
    }

    const currentPath = params.pageRoute || (typeof window !== 'undefined' ? window.location.pathname : '');
    const cleanRoute = normalizeRouteForFeedback(currentPath);

    const { data, error } = await supabase.rpc('enviar_feedback_usuario', {
      p_category: params.category,
      p_comment: trimmed,
      p_page_route: cleanRoute,
      p_honeypot: params.honeypot || null,
    });

    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('permanent_account_required')) {
        return { ok: false, error: 'permanent_account_required' };
      }
      if (msg.includes('authentication_required')) {
        return { ok: false, error: 'authentication_required' };
      }
      if (msg.includes('rate_limit_exceeded')) {
        return { ok: false, error: 'rate_limit_exceeded' };
      }
      if (msg.includes('invalid_submission')) {
        return { ok: false, error: 'invalid_submission' };
      }
      return { ok: false, error: error.message };
    }

    if (data && typeof data === 'object') {
      const res = data as any;
      if (!res.ok) {
        return { ok: false, error: res.error || 'unknown_error' };
      }
      return { ok: true, id: res.id };
    }

    return { ok: true };
  },
};
