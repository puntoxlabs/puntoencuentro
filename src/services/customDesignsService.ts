import { supabase } from '@/lib/supabase';
import type { CustomInvitationTemplate } from '@/lib/customDesigns';
import { CUSTOM_DESIGNS_CONFIG } from '@/lib/customDesigns';

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

  async getCustomDesignById(templateId: string): Promise<CustomInvitationTemplate> {
    const { data, error } = await supabase
      .from('custom_invitation_templates')
      .select('id, name, image_path, thumbnail_path, image_url, thumbnail_url, overlay_opacity, is_active, created_at')
      .eq('id', templateId)
      .eq('is_active', true)
      .single();

    if (error) {
      console.error('Error fetching custom design by ID:', error);
      throw error;
    }

    return data as CustomInvitationTemplate;
  },

  async getPublicCustomDesignForToken(publicToken: string): Promise<CustomInvitationTemplate | null> {
    try {
      const { data, error } = await supabase.rpc('get_custom_invitation_template_public', {
        p_public_token: publicToken
      });

      if (error) {
        console.error('Error in getPublicCustomDesignForToken:', error);
        return null;
      }

      if (data && data.length > 0) {
        return data[0] as CustomInvitationTemplate;
      }
      return null;
    } catch (err) {
      console.error('Exception in getPublicCustomDesignForToken:', err);
      return null;
    }
  },

  getCustomDesignPublicUrl(path: string): string {
    const { data } = supabase.storage
      .from(CUSTOM_DESIGNS_CONFIG.BUCKET)
      .getPublicUrl(path);
    return data.publicUrl;
  },

  async createCustomDesign(params: {
    userId: string;
    templateId: string;
    name: string;
    backgroundBlob: Blob;
    thumbnailBlob: Blob;
    imagePath: string;
    thumbnailPath: string;
  }): Promise<CustomInvitationTemplate> {
    // 1. Upload background
    const { error: bgError } = await supabase.storage
      .from(CUSTOM_DESIGNS_CONFIG.BUCKET)
      .upload(params.imagePath, params.backgroundBlob, {
        contentType: 'image/webp',
        upsert: false
      });

    if (bgError) {
      console.error('Error uploading background:', bgError);
      throw new Error('No pudimos subir la imagen. Reintentá más tarde.');
    }

    // 2. Upload thumbnail
    const { error: thumbError } = await supabase.storage
      .from(CUSTOM_DESIGNS_CONFIG.BUCKET)
      .upload(params.thumbnailPath, params.thumbnailBlob, {
        contentType: 'image/webp',
        upsert: false
      });

    if (thumbError) {
      // Intento de limpieza
      await supabase.storage.from(CUSTOM_DESIGNS_CONFIG.BUCKET).remove([params.imagePath]);
      console.error('Error uploading thumbnail:', thumbError);
      throw new Error('No pudimos subir la miniatura. Reintentá más tarde.');
    }

    // 3. Insert into database
    const { data, error: insertError } = await supabase
      .from('custom_invitation_templates')
      .insert({
        id: params.templateId,
        user_id: params.userId,
        name: params.name,
        image_path: params.imagePath,
        thumbnail_path: params.thumbnailPath,
        image_url: null,
        thumbnail_url: null,
        overlay_opacity: 0.35,
        is_active: true
      })
      .select()
      .single();

    if (insertError) {
      // Intento de limpieza de Storage si falla el insert
      await supabase.storage.from(CUSTOM_DESIGNS_CONFIG.BUCKET).remove([params.imagePath, params.thumbnailPath]);
      
      console.error('Error insertando diseño:', insertError);
      if (insertError.message.includes('custom_templates_limit_exceeded')) {
        throw new Error('Ya tenés 3 diseños personalizados guardados.');
      }
      throw new Error('No pudimos guardar el diseño.');
    }

    return data as CustomInvitationTemplate;
  },

  async updateCustomDesignName(designId: string, name: string): Promise<void> {
    const { error } = await supabase
      .from('custom_invitation_templates')
      .update({ name })
      .eq('id', designId);
      
    if (error) {
      console.error('Error updating custom design name:', error);
      throw new Error('No pudimos actualizar el nombre. Reintentá más tarde.');
    }
  },

  async deactivateCustomDesign(designId: string): Promise<void> {
    const { error } = await supabase
      .from('custom_invitation_templates')
      .update({ is_active: false })
      .eq('id', designId);
      
    if (error) {
      console.error('Error deactivating custom design:', error);
      throw new Error('No pudimos eliminar el diseño. Reintentá más tarde.');
    }
  }
};
