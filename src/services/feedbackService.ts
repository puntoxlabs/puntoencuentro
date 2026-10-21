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
  error?: 'authentication_required' | 'rate_limit_exceeded' | 'invalid_submission' | 'invalid_comment_length' | string;
}

export const feedbackService = {
  async submitFeedback(params: SubmitFeedbackParams): Promise<SubmitFeedbackResult> {
    const trimmed = params.comment.trim();
    if (trimmed.length < 3 || trimmed.length > 1000) {
      return { ok: false, error: 'invalid_comment_length' };
    }

    // Sanitizar ruta descartando query parameters y hashes
    let cleanRoute = params.pageRoute || window.location.pathname;
    if (cleanRoute.includes('?')) cleanRoute = cleanRoute.split('?')[0];
    if (cleanRoute.includes('#')) cleanRoute = cleanRoute.split('#')[0];
    if (cleanRoute.length > 60) cleanRoute = cleanRoute.substring(0, 60);

    const { data, error } = await supabase.rpc('enviar_feedback_usuario', {
      p_category: params.category,
      p_comment: trimmed,
      p_page_route: cleanRoute,
      p_honeypot: params.honeypot || null,
    });

    if (error) {
      const msg = error.message.toLowerCase();
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
