import React from 'react';
import { formatFriendlyDate } from '@/lib/formatDate';

export interface VariantMiniPreviewOverlayProps {
  titulo?: string;
  descripcion?: string;
  fecha?: string;
  hora?: string;
  lugar_texto?: string;
  eyebrow?: string;
}

export const VariantMiniPreviewOverlay: React.FC<VariantMiniPreviewOverlayProps> = ({
  titulo = '',
  descripcion = '',
  fecha = '',
  hora = '',
  lugar_texto = '',
  eyebrow = 'TE INVITO'
}) => {
  const displayTitle = titulo.trim() || 'Tu encuentro';
  
  let displayDetail = descripcion.trim();
  if (displayDetail.length > 40) {
    displayDetail = displayDetail.substring(0, 37) + '...';
  }

  let displayDate = 'Fecha';
  if (fecha) {
    try {
      displayDate = formatFriendlyDate(fecha, hora);
    } catch {
      displayDate = hora ? `${fecha} ${hora}` : fecha;
    }
  }

  const displayLocation = lugar_texto.trim() || 'Lugar';

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#1f2937',
      textAlign: 'center',
      padding: '8px',
      pointerEvents: 'none',
      gap: '4px'
    }}>
      <span style={{ fontSize: '8px', fontWeight: 600, letterSpacing: '0.08em', opacity: 0.8, textTransform: 'uppercase' }}>
        {eyebrow}
      </span>
      
      <span style={{ fontSize: '13px', fontWeight: 700, lineHeight: 1.1, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {displayTitle}
      </span>
      
      {displayDetail && (
        <span style={{ fontSize: '9px', fontWeight: 500, opacity: 0.9, fontStyle: 'italic', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {displayDetail}
        </span>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '2px', opacity: 0.85, fontSize: '8px', fontWeight: 500, gap: '2px' }}>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100px' }}>📅 {displayDate}</span>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100px' }}>📍 {displayLocation}</span>
      </div>
    </div>
  );
};
