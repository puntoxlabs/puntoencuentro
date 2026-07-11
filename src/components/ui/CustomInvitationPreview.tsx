import React, { useEffect, useState } from 'react';
import { Calendar, MapPin } from 'lucide-react';
import { formatFriendlyDate } from '@/lib/formatDate';
import { customDesignsService } from '@/services/customDesignsService';
import './CustomInvitationPreview.css';

interface CustomInvitationPreviewProps {
  titulo?: string;
  fecha?: string;
  hora?: string;
  lugar_texto?: string;
  templateId?: string | null;
  variant?: 'compact' | 'full';
}

export const CustomInvitationPreview: React.FC<CustomInvitationPreviewProps> = ({
  titulo,
  fecha,
  hora,
  lugar_texto,
  templateId,
  variant = 'full'
}) => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const fetchImage = async () => {
      if (!templateId || !templateId.startsWith('custom_')) return;
      
      const id = templateId.replace('custom_', '');
      
      // Usar servicio para obtener el diseño por ID (autenticado)
      try {
        const design = await customDesignsService.getCustomDesignById(id);
        
        if (design && design.image_path && isMounted) {
          const url = customDesignsService.getCustomDesignPublicUrl(design.image_path);
          setImageUrl(url);
        }
      } catch (err) {
        console.error('Error fetching custom template preview', err);
      }
    };

    fetchImage();

    return () => {
      isMounted = false;
    };
  }, [templateId]);

  return (
    <div className={`guest-theme-preview guest-theme-preview--custom guest-theme-preview--custom-${variant}`}>
      {imageUrl ? (
        <div 
          className="guest-theme-preview__background-image"
          style={{ backgroundImage: `url(${imageUrl})` }}
        />
      ) : (
        <div className="guest-theme-preview__background-fallback" />
      )}
      
      <div className="guest-theme-preview__overlay" />
      
      <div className="guest-theme-preview__content">
        <div className="guest-theme-preview__glass-card">
          <p className="guest-theme-preview__eyebrow">Te invitan a un evento</p>
          <h2 className="guest-theme-preview__title">{titulo || 'Título del encuentro'}</h2>
          
          <div className="guest-theme-preview__details">
            <div className="guest-theme-preview__detail-item">
              <Calendar className="guest-theme-preview__detail-icon" />
              <span>
                {fecha ? formatFriendlyDate(fecha, hora || '') : 'Fecha a definir'}
              </span>
            </div>
            
            {lugar_texto && (
              <div className="guest-theme-preview__detail-item">
                <MapPin className="guest-theme-preview__detail-icon" />
                <span>{lugar_texto}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
