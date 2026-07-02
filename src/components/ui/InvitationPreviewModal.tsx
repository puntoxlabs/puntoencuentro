import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, MapPin, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { KidsBirthdayInvitationPreview } from '@/components/ui/KidsBirthdayInvitationPreview';
import { useWizardStore } from '@/store/wizardStore';
import { getThemeEyebrow } from '@/lib/invitationThemes';
import { formatFriendlyDate } from '@/lib/formatDate';
import './InvitationPreviewModal.css';

interface InvitationPreviewModalProps {
  onClose: () => void;
  onChangeStyle?: () => void; // Made optional since it's not strictly needed if we change style directly in DetailHost or maybe it's not passed.
  previewData?: {
    titulo?: string;
    fecha?: string;
    hora?: string;
    lugar_texto?: string;
    modalidad?: string;
    tema_invitacion?: string;
    invitation_template?: string;
    descripcion?: string; // will map to hostMessage
  };
}

export const InvitationPreviewModal: React.FC<InvitationPreviewModalProps> = ({ onClose, onChangeStyle, previewData }) => {
  const wizardData = useWizardStore();
  
  // Use previewData if provided, otherwise fallback to wizardData
  const sourceData = previewData || wizardData;
  
  const themeId = sourceData.tema_invitacion || 'classic';
  const eyebrow = getThemeEyebrow(themeId);
  
  const displayDateText = sourceData.fecha && sourceData.hora 
    ? formatFriendlyDate(sourceData.fecha, sourceData.hora)
    : 'Fecha y hora a definir';
    
  const displayLocation = sourceData.modalidad === 'virtual' 
    ? 'Encuentro virtual' 
    : (sourceData.lugar_texto || 'Lugar a definir');

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    window.history.pushState({ previewModal: true }, '');

    let popped = false;
    const handlePopState = () => {
      popped = true;
      onClose();
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      document.body.style.overflow = 'auto';
      window.removeEventListener('popstate', handlePopState);
      if (!popped) {
        window.history.back();
      }
    };
  }, [onClose]);

  const modalContent = (
    <div className={`preview-modal-overlay guest-theme guest-theme--${themeId}`}>
      <div className="preview-modal-content">
        <div className="preview-modal-header">
          <h3 className="preview-modal-title">Vista previa</h3>
          <button className="preview-modal-close" onClick={onClose} aria-label="Cerrar">
            <X size={24} />
          </button>
        </div>

        <div className="preview-modal-body">
          {themeId === 'kids_birthday' ? (
            <KidsBirthdayInvitationPreview
              templateId={sourceData.invitation_template || null}
              childName={sourceData.titulo || ''}
              date={sourceData.fecha || ''}
              time={sourceData.hora || ''}
              location={displayLocation}
              hostMessage={sourceData.descripcion || ''}
              isReadOnly={true}
            />
          ) : (
            <div className="guest-card" style={{ margin: '0 auto', maxWidth: '400px', width: '100%', boxShadow: '0 12px 32px rgba(0,0,0,0.1)' }}>
              <p className="guest-card-eyebrow">{eyebrow}</p>
            <h1 className="guest-card-title">{sourceData.titulo || 'Sin título'}</h1>
            
            <div className="guest-meta-list">
              <div className="guest-meta-row">
                <div className="guest-meta-icon"><Calendar size={18} /></div>
                <span>{displayDateText}</span>
              </div>
              <div className="guest-meta-row">
                <div className="guest-meta-icon"><MapPin size={18} /></div>
                <span>{displayLocation}</span>
              </div>
            </div>

            <div style={{ marginTop: 24 }}>
              <Button 
                fullWidth 
                onClick={(e) => e.preventDefault()} 
                style={{ pointerEvents: 'none' }}
              >
                Confirmar asistencia
              </Button>
            </div>
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <button 
                type="button" 
                onClick={(e) => e.preventDefault()}
                style={{ 
                  background: 'none', border: 'none', 
                  color: 'var(--color-on-surface-variant)', 
                  fontWeight: 600, fontSize: 14,
                  pointerEvents: 'none'
                }}
              >
                No podré asistir
              </button>
            </div>
          </div>
          )}
          <p className="preview-modal-disclaimer">Así verán la invitación tus invitados. La vista es de solo lectura.</p>
        </div>

        <div className="preview-modal-footer">
          <Button fullWidth variant="secondary" onClick={onChangeStyle} style={{ background: '#FFFFFF', color: 'var(--color-on-surface)', boxShadow: '0 4px 12px rgba(0,0,0,0.05)' }}>
            Cambiar estilo
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};
