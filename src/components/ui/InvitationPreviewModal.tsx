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
  onChangeStyle: () => void;
}

export const InvitationPreviewModal: React.FC<InvitationPreviewModalProps> = ({ onClose, onChangeStyle }) => {
  const wizardData = useWizardStore();
  const themeId = wizardData.tema_invitacion || 'classic';
  const eyebrow = getThemeEyebrow(themeId);
  
  const displayDateText = wizardData.fecha && wizardData.hora 
    ? formatFriendlyDate(wizardData.fecha, wizardData.hora)
    : 'Fecha y hora a definir';
    
  const displayLocation = wizardData.modalidad === 'virtual' 
    ? 'Encuentro virtual' 
    : (wizardData.lugar_texto || 'Lugar a definir');

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = 'auto';
    };
  }, []);

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
              templateId={wizardData.invitation_template}
              childName={wizardData.titulo}
              date={displayDateText}
              time={wizardData.hora}
              location={displayLocation}
              hostMessage={wizardData.descripcion}
              isReadOnly={true}
            />
          ) : (
            <div className="guest-card" style={{ margin: '0 auto', maxWidth: '400px', width: '100%' }}>
              <p className="guest-card-eyebrow">{eyebrow}</p>
            <h1 className="guest-card-title">{wizardData.titulo || 'Sin título'}</h1>
            
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
              <Button fullWidth disabled style={{ opacity: 1 }}>Confirmar asistencia</Button>
            </div>
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <button 
                type="button" 
                style={{ 
                  background: 'none', border: 'none', 
                  color: 'var(--color-on-surface-variant)', 
                  fontWeight: 600, fontSize: 14 
                }}
                disabled
              >
                No podré asistir
              </button>
            </div>
          </div>
          )}
          <p className="preview-modal-disclaimer">Así verán la invitación tus invitados. La vista es de solo lectura.</p>
        </div>

        <div className="preview-modal-footer">
          <Button fullWidth onClick={onChangeStyle}>Cambiar estilo</Button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};
