import { supabase } from '@/lib/supabase';
import type { CustomInvitationTemplate } from '@/lib/customDesigns';

export const customDesignsService = {
  async listCustomDesigns(userId: string): Promise<CustomInvitationTemplate[]> {
    const { data, error } = await supabase
      .from('custom_invitation_templates')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching custom designs:', error);
      throw error;
    }

    return data as CustomInvitationTemplate[];
  },
};
