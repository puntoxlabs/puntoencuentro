import React, { useEffect, useState } from 'react';
import { Calendar, MapPin } from 'lucide-react';
import { formatFriendlyDate } from '@/lib/formatDate';
import { customDesignsService } from '@/services/customDesignsService';
import './CustomGuestInvitationPreview.css';

interface CustomGuestInvitationPreviewProps {
  invitationToken: string;
  titulo?: string;
  fecha?: string;
  hora?: string;
  lugar_texto?: string;
  hostMessage?: string;
}

export const CustomGuestInvitationPreview: React.FC<CustomGuestInvitationPreviewProps> = ({
  invitationToken,
  titulo,
  fecha,
  hora,
  lugar_texto,
  hostMessage
}) => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [opacity, setOpacity] = useState<number>(0.35);

  useEffect(() => {
    let isMounted = true;

    const fetchImage = async () => {
      if (!invitationToken) return;

      try {
        const design = await customDesignsService.getPublicCustomDesignForToken(invitationToken);

        if (design && design.image_path && isMounted) {
          const url = customDesignsService.getCustomDesignPublicUrl(design.image_path);
          setImageUrl(url);
          setOpacity(design.overlay_opacity ?? 0.35);
        }
      } catch (err) {
        console.error('Error fetching custom guest template preview', err);
      }
    };

    fetchImage();

    return () => {
      isMounted = false;
    };
  }, [invitationToken]);

  return (
    <div className="guest-theme-preview guest-theme-preview--custom-guest">
      {imageUrl ? (
        <div
          className="guest-theme-preview__background-image"
          style={{ backgroundImage: `url("${imageUrl}")` }}
        />
      ) : (
        <div className="guest-theme-preview__background-fallback" />
      )}

      <div
        className="guest-theme-preview__overlay"
        style={{ background: `rgba(0, 0, 0, ${opacity})` }}
      />

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

          {hostMessage && (
            <div className="guest-theme-preview__message">
              <p>{hostMessage}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
