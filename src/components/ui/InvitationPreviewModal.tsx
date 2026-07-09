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
import { RomanticInvitationPreview } from '@/components/ui/RomanticInvitationPreview';
import { getFormalTemplateConfig } from '@/lib/formalTemplates';
import { getFriendsTemplateConfig } from '@/lib/friendsTemplates';
import { getFamilyTemplateConfig } from '@/lib/familyTemplates';
import { getSpecialTemplateConfig } from '@/lib/specialTemplates';
import { getSportsTemplateConfig } from '@/lib/sportsTemplates';
import { getEntertainmentTemplateConfig } from '@/lib/entertainmentTemplates';
import { getLearningTemplateConfig } from '@/lib/learningTemplates';
import { getWellnessTemplateConfig } from '@/lib/wellnessTemplates';
import { useWizardStore } from '@/store/wizardStore';
import { getThemeEyebrow } from '@/lib/invitationThemes';
import { getRomanticTemplateConfig } from '@/lib/romanticTemplates';
import { formatFriendlyDate } from '@/lib/formatDate';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getAllInvitationDesignOptions, findDesignOptionIndex } from '@/lib/invitationThemes';
import './InvitationPreviewModal.css';

const SHOW_INVITATION_DEBUG = false;

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
  onApplyDesign?: (theme: string, template: string | null) => void;
}

export const InvitationPreviewModal: React.FC<InvitationPreviewModalProps> = ({ onClose, onChangeStyle, previewData, onApplyDesign }) => {
  const wizardData = useWizardStore();
  const currentPreviewData = previewData || wizardData;
  
  const allDesignOptions = React.useMemo(() => getAllInvitationDesignOptions(), []);

  const initialIndexRef = React.useRef(
    findDesignOptionIndex(
      currentPreviewData.tema_invitacion, 
      currentPreviewData.invitation_template
    )
  );

  const [currentIndex, setCurrentIndex] = React.useState<number>(initialIndexRef.current);

  const activeOption = allDesignOptions[currentIndex] || allDesignOptions[0];

  const resolvedPreviewData = {
    ...currentPreviewData,
    tema_invitacion: activeOption.theme,
    invitation_template: activeOption.template
  };

  const themeId = resolvedPreviewData.tema_invitacion;
  const eyebrow = getThemeEyebrow(themeId);
  
  const formalTemplateConfig = themeId === 'formal' ? getFormalTemplateConfig(resolvedPreviewData.invitation_template) : null;
  const hasValidFormalTemplate = !!formalTemplateConfig;
  
  const friendsTemplateConfig = themeId === 'friends' ? getFriendsTemplateConfig(resolvedPreviewData.invitation_template) : null;
  const hasValidFriendsTemplate = !!friendsTemplateConfig;
  
  const familyTemplateConfig = themeId === 'family' ? getFamilyTemplateConfig(resolvedPreviewData.invitation_template) : null;
  const hasValidFamilyTemplate = !!familyTemplateConfig;

  const specialTemplateConfig = themeId === 'special' ? getSpecialTemplateConfig(resolvedPreviewData.invitation_template) : null;
  const hasValidSpecialTemplate = !!specialTemplateConfig;
  
  const sportsTemplateConfig = themeId === 'sports' ? getSportsTemplateConfig(resolvedPreviewData.invitation_template) : null;
  const hasValidSportsTemplate = !!sportsTemplateConfig;

  if (import.meta.env.DEV) {
    console.log("[PreviewModal] theme:", themeId);
    console.log("[PreviewModal] raw template:", currentPreviewData.invitation_template);
    console.log("[PreviewModal] resolved template:", resolvedPreviewData.invitation_template);
    console.log("[PreviewModal] sports config:", sportsTemplateConfig);
    console.log("[PreviewModal] render branch:", hasValidSportsTemplate ? 'sports' : 'other');
  }

  const entertainmentTemplateConfig = themeId === 'entertainment' ? getEntertainmentTemplateConfig(resolvedPreviewData.invitation_template) : null;
  const hasValidEntertainmentTemplate = !!entertainmentTemplateConfig;

  const romanticTemplateConfig = themeId === 'romantic' ? getRomanticTemplateConfig(resolvedPreviewData.invitation_template) : null;
  const hasValidRomanticTemplate = !!romanticTemplateConfig;

  const learningTemplateConfig = themeId === 'learning' ? getLearningTemplateConfig(resolvedPreviewData.invitation_template) : null;
  const hasValidLearningTemplate = !!learningTemplateConfig;

  const wellnessTemplateConfig = themeId === 'wellness' ? getWellnessTemplateConfig(resolvedPreviewData.invitation_template) : null;
  const hasValidWellnessTemplate = !!wellnessTemplateConfig;
  
  const displayDateText = resolvedPreviewData.fecha && resolvedPreviewData.hora 
    ? formatFriendlyDate(resolvedPreviewData.fecha, resolvedPreviewData.hora)
    : 'Fecha y hora a definir';
    
  const displayLocation = resolvedPreviewData.modalidad === 'virtual' 
    ? 'Encuentro virtual' 
    : (resolvedPreviewData.lugar_texto || 'Lugar a definir');

  useEffect(() => {
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = 'auto';
    };
  }, []);

  const handlePrev = () => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : allDesignOptions.length - 1));
  };

  const handleNext = () => {
    setCurrentIndex((prev) => (prev < allDesignOptions.length - 1 ? prev + 1 : 0));
  };

  const currentSavedIndex = findDesignOptionIndex(
    currentPreviewData.tema_invitacion, 
    currentPreviewData.invitation_template
  );
  
  const isCurrentDesign = currentIndex === currentSavedIndex;

  const romanticTemplate = themeId === 'romantic' ? getRomanticTemplateConfig(resolvedPreviewData.invitation_template) : null;
  const customStyles = romanticTemplate?.background 
    ? { '--guest-bg-image': `url(${romanticTemplate.background})` } as React.CSSProperties
    : {};

  const modalContent = (
    <div className={`preview-modal-overlay guest-theme guest-theme--${themeId}`} style={customStyles}>
      <div className="preview-modal-content">
        <div className="preview-modal-header">
          <h3 className="preview-modal-title">Vista previa</h3>
          <button 
            type="button" 
            className="preview-modal-close" 
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }} 
            aria-label="Cerrar"
          >
            <X size={24} />
          </button>
        </div>

        {SHOW_INVITATION_DEBUG && import.meta.env.DEV && (
          <div className="preview-debug-badge" style={{ background: 'yellow', padding: '8px', color: 'black', fontSize: '12px', fontWeight: 'bold' }}>
            theme: {resolvedPreviewData.tema_invitacion} |
            raw: {currentPreviewData.invitation_template ?? 'null'} |
            resolved: {resolvedPreviewData.invitation_template ?? 'null'} |
            branch: {themeId === 'kids_birthday' ? 'kids_birthday' : themeId === 'celebration' ? 'celebration' : hasValidFormalTemplate ? 'formal' : hasValidFriendsTemplate ? 'friends' : hasValidFamilyTemplate ? 'family' : hasValidSpecialTemplate ? 'special' : hasValidSportsTemplate ? 'sports' : hasValidEntertainmentTemplate ? 'entertainment' : hasValidLearningTemplate ? 'learning' : hasValidWellnessTemplate ? 'wellness' : 'classic'}
          </div>
        )}

        <div className="preview-modal-body">
          {themeId === 'kids_birthday' ? (
            <KidsBirthdayInvitationPreview
              templateId={resolvedPreviewData.invitation_template || null}
              childName={resolvedPreviewData.titulo || ''}
              date={resolvedPreviewData.fecha || ''}
              time={resolvedPreviewData.hora || ''}
              location={displayLocation}
              hostMessage={resolvedPreviewData.descripcion || ''}
              isReadOnly={true}
            />
          ) : themeId === 'celebration' ? (
            <CelebrationInvitationPreview
              previewData={{
                titulo: resolvedPreviewData.titulo || '',
                fecha: resolvedPreviewData.fecha || '',
                hora: resolvedPreviewData.hora || '',
                lugar_texto: resolvedPreviewData.lugar_texto,
                modalidad: resolvedPreviewData.modalidad,
                descripcion: resolvedPreviewData.descripcion,
                tema_invitacion: themeId,
                invitation_template: resolvedPreviewData.invitation_template || 'celebration_gold'
              }}
            />
          ) : hasValidFormalTemplate ? (
            <FormalInvitationPreview
              previewData={{
                titulo: resolvedPreviewData.titulo || '',
                fecha: resolvedPreviewData.fecha || '',
                hora: resolvedPreviewData.hora || '',
                lugar_texto: resolvedPreviewData.lugar_texto,
                modalidad: resolvedPreviewData.modalidad,
                descripcion: resolvedPreviewData.descripcion,
                tema_invitacion: themeId,
                invitation_template: resolvedPreviewData.invitation_template
              }}
            />
          ) : hasValidFriendsTemplate ? (
            <FriendsInvitationPreview
              previewData={{
                titulo: resolvedPreviewData.titulo || '',
                fecha: resolvedPreviewData.fecha || '',
                hora: resolvedPreviewData.hora || '',
                lugar_texto: resolvedPreviewData.lugar_texto,
                modalidad: resolvedPreviewData.modalidad,
                descripcion: resolvedPreviewData.descripcion,
                tema_invitacion: themeId,
                invitation_template: resolvedPreviewData.invitation_template
              }}
            />
          ) : hasValidFamilyTemplate ? (
            <div className="ipm-scrollable-content">
              <FamilyInvitationPreview 
                previewData={{
                  titulo: resolvedPreviewData.titulo || '',
                  fecha: resolvedPreviewData.fecha || '',
                  hora: resolvedPreviewData.hora || '',
                  lugar_texto: resolvedPreviewData.lugar_texto,
                  modalidad: resolvedPreviewData.modalidad,
                  descripcion: resolvedPreviewData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: resolvedPreviewData.invitation_template
                }} 
                className="ipm-full-height-preview" 
              />
            </div>
          ) : hasValidSpecialTemplate ? (
            <div className="ipm-scrollable-content">
              <SpecialInvitationPreview 
                previewData={{
                  titulo: resolvedPreviewData.titulo || '',
                  fecha: resolvedPreviewData.fecha || '',
                  hora: resolvedPreviewData.hora || '',
                  lugar_texto: resolvedPreviewData.lugar_texto,
                  modalidad: resolvedPreviewData.modalidad,
                  descripcion: resolvedPreviewData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: resolvedPreviewData.invitation_template
                }} 
                className="ipm-full-height-preview" 
              />
            </div>
          ) : hasValidSportsTemplate ? (
            <div className="ipm-scrollable-content">
              <SportsInvitationPreview
                previewData={{
                  titulo: resolvedPreviewData.titulo || '',
                  fecha: resolvedPreviewData.fecha || '',
                  hora: resolvedPreviewData.hora || '',
                  lugar_texto: resolvedPreviewData.lugar_texto,
                  modalidad: resolvedPreviewData.modalidad,
                  descripcion: resolvedPreviewData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: resolvedPreviewData.invitation_template
                }}
                className="ipm-full-height-preview"
              />
            </div>
          ) : hasValidEntertainmentTemplate ? (
            <div className="ipm-scrollable-content">
              <EntertainmentInvitationPreview
                previewData={{
                  titulo: resolvedPreviewData.titulo || '',
                  fecha: resolvedPreviewData.fecha || '',
                  hora: resolvedPreviewData.hora || '',
                  lugar_texto: resolvedPreviewData.lugar_texto,
                  modalidad: resolvedPreviewData.modalidad,
                  descripcion: resolvedPreviewData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: resolvedPreviewData.invitation_template
                }}
                className="ipm-full-height-preview"
              />
            </div>
          ) : hasValidLearningTemplate ? (
            <div className="ipm-scrollable-content">
              <LearningInvitationPreview
                previewData={{
                  titulo: resolvedPreviewData.titulo || '',
                  fecha: resolvedPreviewData.fecha || '',
                  hora: resolvedPreviewData.hora || '',
                  lugar_texto: resolvedPreviewData.lugar_texto,
                  modalidad: resolvedPreviewData.modalidad,
                  descripcion: resolvedPreviewData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: resolvedPreviewData.invitation_template
                }}
                className="ipm-full-height-preview"
              />
            </div>
          ) : hasValidWellnessTemplate ? (
            <div className="ipm-scrollable-content">
              <WellnessInvitationPreview
                previewData={{
                  titulo: resolvedPreviewData.titulo || '',
                  fecha: resolvedPreviewData.fecha || '',
                  hora: resolvedPreviewData.hora || '',
                  lugar_texto: resolvedPreviewData.lugar_texto,
                  modalidad: resolvedPreviewData.modalidad,
                  descripcion: resolvedPreviewData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: resolvedPreviewData.invitation_template
                }}
                className="ipm-full-height-preview"
              />
            </div>
          ) : hasValidRomanticTemplate ? (
            <div className="ipm-scrollable-content">
              <RomanticInvitationPreview
                previewData={{
                  titulo: resolvedPreviewData.titulo || '',
                  fecha: resolvedPreviewData.fecha || '',
                  hora: resolvedPreviewData.hora || '',
                  lugar_texto: resolvedPreviewData.lugar_texto,
                  modalidad: resolvedPreviewData.modalidad,
                  descripcion: resolvedPreviewData.descripcion,
                  tema_invitacion: themeId,
                  invitation_template: resolvedPreviewData.invitation_template
                }}
                className="ipm-full-height-preview"
              />
            </div>
          ) : (
            <div className="guest-card" style={{ margin: '0 auto', maxWidth: '400px', width: '100%', boxShadow: '0 12px 32px rgba(0,0,0,0.1)' }}>
              <p className="guest-card-eyebrow">{eyebrow}</p>
            <h1 className="guest-card-title">{resolvedPreviewData.titulo || 'Sin título'}</h1>
            
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

        <button 
          type="button"
          onClick={handlePrev}
          className="preview-gallery-arrow preview-gallery-arrow-left"
          aria-label="Diseño anterior"
          style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', zIndex: 10, background: 'rgba(255,255,255,0.8)', border: 'none', borderRadius: '50%', width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', cursor: 'pointer', color: '#374151' }}
        >
          <ChevronLeft size={24} />
        </button>

        <button 
          type="button"
          onClick={handleNext}
          className="preview-gallery-arrow preview-gallery-arrow-right"
          aria-label="Siguiente diseño"
          style={{ position: 'absolute', right: '16px', top: '50%', transform: 'translateY(-50%)', zIndex: 10, background: 'rgba(255,255,255,0.8)', border: 'none', borderRadius: '50%', width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', cursor: 'pointer', color: '#374151' }}
        >
          <ChevronRight size={24} />
        </button>

        <div className="preview-modal-footer" style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-on-surface-variant)', marginBottom: '4px' }}>
            {activeOption.categoryLabel} {activeOption.templateLabel && `· ${activeOption.templateLabel}`}
          </div>
          
          {!isCurrentDesign ? (
            <Button fullWidth variant="primary" onClick={() => {
              if (onApplyDesign) {
                onApplyDesign(activeOption.theme, activeOption.template ?? null);
              }
            }}>
              Usar este diseño
            </Button>
          ) : (
            <Button fullWidth variant="secondary" onClick={() => {}} style={{ opacity: 0.7, pointerEvents: 'none' }}>
              Diseño actual
            </Button>
          )}

          {onChangeStyle && (
            <Button fullWidth variant="secondary" onClick={onChangeStyle} style={{ background: '#FFFFFF', color: 'var(--color-on-surface)', boxShadow: '0 4px 12px rgba(0,0,0,0.05)' }}>
              Ver todos los estilos
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
};
