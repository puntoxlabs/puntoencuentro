import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, MapPin, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { KidsBirthdayInvitationPreview } from '@/components/ui/KidsBirthdayInvitationPreview';
import { CelebrationInvitationPreview } from '@/components/ui/CelebrationInvitationPreview';
import { FormalInvitationPreview } from '@/components/ui/FormalInvitationPreview';
import { FriendsInvitationPreview } from '@/components/ui/FriendsInvitationPreview';
import { FamilyInvitationPreview } from '@/components/ui/FamilyInvitationPreview';
import { SpecialInvitationPreview } from '@/components/ui/SpecialInvitationPreview';
import { SportsInvitationPreview } from '@/components/ui/SportsInvitationPreview';
import { EntertainmentInvitationPreview } from '@/components/ui/EntertainmentInvitationPreview';
import { LearningInvitationPreview } from '@/components/ui/LearningInvitationPreview';
import { WellnessInvitationPreview } from '@/components/ui/WellnessInvitationPreview';
import { getFormalTemplateConfig } from '@/lib/formalTemplates';
import { getFriendsTemplateConfig } from '@/lib/friendsTemplates';
import { getFamilyTemplateConfig } from '@/lib/familyTemplates';
import { getSpecialTemplateConfig } from '@/lib/specialTemplates';
import { getSportsTemplateConfig } from '@/lib/sportsTemplates';
import { getEntertainmentTemplateConfig } from '@/lib/entertainmentTemplates';
import { getLearningTemplateConfig } from '@/lib/learningTemplates';
import { getWellnessTemplateConfig } from '@/lib/wellnessTemplates';
import { useWizardStore } from '@/store/wizardStore';
import { getThemeEyebrow, resolveInvitationTemplateForTheme } from '@/lib/invitationThemes';
import { getRomanticTemplateConfig } from '@/lib/romanticTemplates';
import { formatFriendlyDate } from '@/lib/formatDate';
import './InvitationPreviewModal.css';

interface InvitationPreviewModalProps {
  onClose: () => void;
  onChangeStyle?: () => void;
  previewData?: {
    titulo?: string;
    fecha?: string;
    hora?: string;
    lugar_texto?: string;
    modalidad?: string;
    tema_invitacion?: string;
    invitation_template?: string;
    descripcion?: string;
  };
}

export const InvitationPreviewModal: React.FC<InvitationPreviewModalProps> = ({ onClose, onChangeStyle, previewData }) => {
  const wizardData = useWizardStore();
  
  const sourceData = previewData || wizardData;
  
  const themeId = sourceData.tema_invitacion || 'classic';
  const eyebrow = getThemeEyebrow(themeId);
  
  const formalTemplateConfig = themeId === 'formal' ? getFormalTemplateConfig(sourceData.invitation_template) : null;
  const hasValidFormalTemplate = !!formalTemplateConfig;
  
  const friendsTemplateConfig = themeId === 'friends' ? getFriendsTemplateConfig(sourceData.invitation_template) : null;
  const hasValidFriendsTemplate = !!friendsTemplateConfig;
  
  const familyTemplateConfig = themeId === 'family' ? getFamilyTemplateConfig(sourceData.invitation_template) : null;
  const hasValidFamilyTemplate = !!familyTemplateConfig;
  
  const resolvedTemplate = resolveInvitationTemplateForTheme(themeId, sourceData.invitation_template);

  const specialTemplateConfig = themeId === 'special' ? getSpecialTemplateConfig(resolvedTemplate) : null;
  const hasValidSpecialTemplate = !!specialTemplateConfig;
  
  const sportsTemplateConfig = themeId === 'sports' ? getSportsTemplateConfig(resolvedTemplate) : null;
  const hasValidSportsTemplate = !!sportsTemplateConfig;

  const entertainmentTemplateConfig = themeId === 'entertainment' ? getEntertainmentTemplateConfig(resolvedTemplate) : null;
  const hasValidEntertainmentTemplate = !!entertainmentTemplateConfig;

  const learningTemplateConfig = themeId === 'learning' ? getLearningTemplateConfig(resolvedTemplate) : null;
  const hasValidLearningTemplate = !!learningTemplateConfig;

  const wellnessTemplateConfig = themeId === 'wellness' ? getWellnessTemplateConfig(resolvedTemplate) : null;
  const hasValidWellnessTemplate = !!wellnessTemplateConfig;
  
  const displayDateText = sourceData.fecha && sourceData.hora 
    ? formatFriendlyDate(sourceData.fecha, sourceData.hora)
    : 'Fecha y hora a definir';
    
  const displayLocation = sourceData.modalidad === 'virtual' 
    ? 'Encuentro virtual' 
    : (sourceData.lugar_texto || 'Lugar a definir');

  useEffect(() => {
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = 'auto';
    };
  }, []);

  const romanticTemplate = themeId === 'romantic' ? getRomanticTemplateConfig(sourceData.invitation_template) : null;
  const customStyles = romanticTemplate?.background 
    ? { '--guest-bg-image': `url(${romanticTemplate.background})` } as React.CSSProperties
    : {};

  const modalContent = (
    <div className={`preview-modal-overlay guest-theme guest-theme--${themeId}`} style={customStyles}>
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
          ) : themeId === 'celebration' ? (
            <CelebrationInvitationPreview
              previewData={{
                titulo: sourceData.titulo || '',
                fecha: sourceData.fecha || '',
                hora: sourceData.hora || '',
                lugar_texto: sourceData.lugar_texto,
                modalidad: sourceData.modalidad,
                descripcion: sourceData.descripcion,
                tema_invitacion: themeId,
                invitation_template: sourceData.invitation_template || 'celebration_gold'
              }}
            />
          ) : hasValidFormalTemplate ? (
            <FormalInvitationPreview
              previewData={{
                titulo: sourceData.titulo || '',
                fecha: sourceData.fecha || '',
                hora: sourceData.hora || '',
                lugar_texto: sourceData.lugar_texto,
                modalidad: sourceData.modalidad,
                descripcion: sourceData.descripcion,
                tema_invitacion: themeId,
                invitation_template: sourceData.invitation_template
              }}
            />
          ) : hasValidFriendsTemplate ? (
            <FriendsInvitationPreview
              previewData={{
                titulo: sourceData.titulo || '',
                fecha: sourceData.fecha || '',
                hora: sourceData.hora || '',
                lugar_texto: sourceData.lugar_texto,
                modalidad: sourceData.modalidad,
                descripcion: sourceData.descripcion,
                tema_invitacion: themeId,
                invitation_template: sourceData.invitation_template
              }}
            />
          ) : hasValidFamilyTemplate ? (
            <div className="ipm-scrollable-content">
              <FamilyInvitationPreview 
                previewData={{
                  titulo: sourceData.titulo || '',
                  fecha: sourceData.fecha || '',
                  hora: sourceData.hora || '',
                  lugar_texto: sourceData.lugar_texto,
                  modalidad: sourceData.modalidad,
                  descripcion: sourceData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: sourceData.invitation_template
                }} 
                className="ipm-full-height-preview" 
              />
            </div>
          ) : hasValidSpecialTemplate ? (
            <div className="ipm-scrollable-content">
              <SpecialInvitationPreview 
                previewData={{
                  titulo: sourceData.titulo || '',
                  fecha: sourceData.fecha || '',
                  hora: sourceData.hora || '',
                  lugar_texto: sourceData.lugar_texto,
                  modalidad: sourceData.modalidad,
                  descripcion: sourceData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: sourceData.invitation_template
                }} 
                className="ipm-full-height-preview" 
              />
            </div>
          ) : hasValidSportsTemplate ? (
            <div className="ipm-scrollable-content">
              <SportsInvitationPreview
                previewData={{
                  titulo: sourceData.titulo || '',
                  fecha: sourceData.fecha || '',
                  hora: sourceData.hora || '',
                  lugar_texto: sourceData.lugar_texto,
                  modalidad: sourceData.modalidad,
                  descripcion: sourceData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: resolvedTemplate
                }}
                className="ipm-full-height-preview"
              />
            </div>
          ) : hasValidEntertainmentTemplate ? (
            <div className="ipm-scrollable-content">
              <EntertainmentInvitationPreview
                previewData={{
                  titulo: sourceData.titulo || '',
                  fecha: sourceData.fecha || '',
                  hora: sourceData.hora || '',
                  lugar_texto: sourceData.lugar_texto,
                  modalidad: sourceData.modalidad,
                  descripcion: sourceData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: resolvedTemplate
                }}
                className="ipm-full-height-preview"
              />
            </div>
          ) : hasValidLearningTemplate ? (
            <div className="ipm-scrollable-content">
              <LearningInvitationPreview
                previewData={{
                  titulo: sourceData.titulo || '',
                  fecha: sourceData.fecha || '',
                  hora: sourceData.hora || '',
                  lugar_texto: sourceData.lugar_texto,
                  modalidad: sourceData.modalidad,
                  descripcion: sourceData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: resolvedTemplate
                }}
                className="ipm-full-height-preview"
              />
            </div>
          ) : hasValidWellnessTemplate ? (
            <div className="ipm-scrollable-content">
              <WellnessInvitationPreview
                previewData={{
                  titulo: sourceData.titulo || '',
                  fecha: sourceData.fecha || '',
                  hora: sourceData.hora || '',
                  lugar_texto: sourceData.lugar_texto,
                  modalidad: sourceData.modalidad,
                  descripcion: sourceData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: resolvedTemplate
                }}
                className="ipm-full-height-preview"
              />
            </div>
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
