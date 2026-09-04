import React, { useEffect, useRef } from 'react';
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
import { CustomInvitationPreview } from '@/components/ui/CustomInvitationPreview';
import { CustomDesignsSheet } from '@/components/ui/CustomDesignsSheet';
import { KidsBirthdayTemplateSelector } from '@/components/ui/KidsBirthdayTemplateSelector';
import { CelebrationTemplateSelector } from '@/components/ui/CelebrationTemplateSelector';
import { RomanticTemplateSelector } from '@/components/ui/RomanticTemplateSelector';
import { FormalTemplateSelector } from '@/components/ui/FormalTemplateSelector';
import { FriendsTemplateSelector } from '@/components/ui/FriendsTemplateSelector';
import { FamilyTemplateSelector } from '@/components/ui/FamilyTemplateSelector';
import { SpecialTemplateSelector } from '@/components/ui/SpecialTemplateSelector';
import { SportsTemplateSelector } from '@/components/ui/SportsTemplateSelector';
import { EntertainmentTemplateSelector } from '@/components/ui/EntertainmentTemplateSelector';
import { LearningTemplateSelector } from '@/components/ui/LearningTemplateSelector';
import { WellnessTemplateSelector } from '@/components/ui/WellnessTemplateSelector';
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
import { getAllInvitationDesignOptions, getDefaultInvitationTemplate } from '@/lib/invitationThemes';
import { useAuth } from '@/contexts/AuthContext';
import { customDesignsService } from '@/services/customDesignsService';
import type { CustomInvitationTemplate } from '@/lib/customDesigns';
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

export const InvitationPreviewModal: React.FC<InvitationPreviewModalProps> = ({ onClose, previewData, onApplyDesign }) => {
  // closeInitiated: guard síncrono que previene que handleClose() se ejecute más de
  // una vez (doble tap en X, tap en X y botón simultáneamente, etc.).
  // Se setea de forma síncrona ANTES de llamar a history.back(), que es asíncrono.
  // Reemplaza a closedProgrammatically e historyEntryConsumed de la versión anterior:
  // ya no los necesitamos porque ahora onClose() siempre llega desde popstate,
  // no hay carrera entre history.back() y el desmontaje del componente.
  const closeInitiated = useRef(false);

  // Cierre por X o botón "Cerrar vista previa".
  // NO llama a onClose() directamente — delega ese rol al handler de popstate.
  // Esto elimina la carrera entre history.back() (async) y el desmontaje:
  // el componente solo se desmonta cuando popstate llega y llama a onClose(),
  // garantizando que la entrada fantasma siempre se consume antes del desmontaje.
  const handleClose = () => {
    if (closeInitiated.current) return;
    closeInitiated.current = true;
    history.back();
    // onClose() será llamado por handlePopState cuando history.back() complete.
  };
  const { user } = useAuth();
  const wizardData = useWizardStore();
  const currentPreviewData = previewData || wizardData;
  const [customDesigns, setCustomDesigns] = React.useState<CustomInvitationTemplate[]>([]);

  useEffect(() => {
    let isMounted = true;
    if (user) {
      customDesignsService.listCustomDesigns(user.id)
        .then(designs => {
          if (isMounted) setCustomDesigns(designs);
        })
        .catch(err => console.error('Error fetching custom designs:', err));
    }
    return () => { isMounted = false; };
  }, [user]);

  const allDesignOptions = React.useMemo(() => {
    const options = getAllInvitationDesignOptions();

    customDesigns.forEach(design => {
      options.push({
        theme: 'custom' as any,
        template: `custom_${design.id}`,
        categoryLabel: 'Diseño personalizado',
        templateLabel: design.name || 'Tu diseño',
        customDesignId: design.id,
        customImagePath: design.image_path,
        customThumbnailPath: design.thumbnail_path
      });
    });

    if (currentPreviewData.tema_invitacion === 'custom' && currentPreviewData.invitation_template?.startsWith('custom_')) {
      const exists = options.some(opt => opt.theme === 'custom' && opt.template === currentPreviewData.invitation_template);
      if (!exists) {
        options.push({
          theme: 'custom' as any,
          template: currentPreviewData.invitation_template,
          categoryLabel: 'Diseño personalizado',
          templateLabel: 'Tu diseño'
        });
      }
    }
    return options;
  }, [currentPreviewData.tema_invitacion, currentPreviewData.invitation_template, customDesigns]);

  const initialIndexRef = React.useRef(
    (() => {
      const idx = allDesignOptions.findIndex(
        opt => opt.theme === currentPreviewData.tema_invitacion && opt.template === currentPreviewData.invitation_template
      );
      if (idx !== -1) return idx;
      const themeIdx = allDesignOptions.findIndex(opt => opt.theme === currentPreviewData.tema_invitacion);
      return themeIdx !== -1 ? themeIdx : 0;
    })()
  );

  const [currentIndex, setCurrentIndex] = React.useState<number>(initialIndexRef.current);
  const [userHasNavigated, setUserHasNavigated] = React.useState(false);
  const [showVariantSelector, setShowVariantSelector] = React.useState(false);
  const [showCustomDesignsSheet, setShowCustomDesignsSheet] = React.useState(false);
  const [showCategorySelector, setShowCategorySelector] = React.useState(false);

  const activeOption = allDesignOptions[currentIndex] || allDesignOptions[0];

  const handleSelectVariant = (templateId: string) => {
    const selectedTheme = activeOption.theme;
    const selectedIndex = allDesignOptions.findIndex(
      opt => opt.theme === selectedTheme && opt.template === templateId
    );
    if (selectedIndex !== -1) {
      setUserHasNavigated(true);
      setCurrentIndex(selectedIndex);
    }
    setShowVariantSelector(false);
  };

  const handleSelectCustomDesign = (templateId: string) => {
    // Defensive: avoid double-prefixing (custom_custom_<uuid>)
    const templateValue = templateId.startsWith('custom_')
      ? templateId
      : `custom_${templateId}`;
    // Only update the preview — do NOT call onApplyDesign yet.
    // The user must press 'Aplicar diseño' to persist.
    let existingIndex = allDesignOptions.findIndex(
      opt => opt.theme === 'custom' && opt.template === templateValue
    );

    // If not found (e.g. from CustomDesignsSheet but not yet in allDesignOptions), find the first custom or push
    if (existingIndex !== -1) {
      setUserHasNavigated(true);
      setCurrentIndex(existingIndex);
    }
    setShowCustomDesignsSheet(false);
    setShowCategorySelector(false);
  };

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

    // Agregar una entrada "fantasma" al historial del browser.
    // Permite que Atrás Android cierre la preview en vez de navegar hacia atrás.
    //
    // Preservamos history.state existente (spread) para no pisar las claves
    // internas de React Router v6: { idx, key, usr }.
    const previousState = history.state ?? {};
    history.pushState({ ...previousState, previewModal: true }, '', location.href);

    const handlePopState = () => {
      // ÚNICA fuente de cierre del modal.
      // Se ejecuta en dos escenarios:
      //   1. El usuario presiona Atrás en Android (el browser consume la entrada).
      //   2. handleClose() llama history.back() al presionar X o botón inferior.
      // En ambos casos la entrada fantasma ya fue consumida en este punto,
      // por lo que no hay riesgo de doble back.
      onClose();
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      document.body.style.overflow = 'auto';
      window.removeEventListener('popstate', handlePopState);

      // ⚠️  El cleanup NO llama a history.back() intencionalmente.
      //
      // Los flujos normales de cierre (Atrás Android, X, botón inferior)
      // siempre consumen la entrada fantasma ANTES de que el componente se
      // desmonte (porque el desmontaje ocurre desde onClose() que se llama
      // dentro de handlePopState, después de que la entrada fue consumida).
      //
      // El único caso donde el cleanup correría sin que la entrada haya sido
      // consumida es un desmontaje EXTERNO: navegación de ruta, logout, o
      // cualquier cambio de ruta programático mientras la preview está abierta.
      // En ese caso hacer history.back() sería incorrecto: navegaría al usuario
      // hacia atrás contradiciéndose con la intención de la navegación que
      // desencadenó el desmontaje.
      //
      // Trade-off aceptado: en ese edge case extremadamente raro puede quedar
      // una entrada huérfana en el historial (requeriría un Atrás extra para
      // salir de /meet/:id). Es preferible a provocar una navegación inesperada.
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePrev = () => {
    setUserHasNavigated(true);
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : allDesignOptions.length - 1));
  };

  const handleNext = () => {
    setUserHasNavigated(true);
    setCurrentIndex((prev) => (prev < allDesignOptions.length - 1 ? prev + 1 : 0));
  };

  const currentSavedIndex = (() => {
    const idx = allDesignOptions.findIndex(
      opt => opt.theme === currentPreviewData.tema_invitacion && opt.template === currentPreviewData.invitation_template
    );
    if (idx !== -1) return idx;
    const themeIdx = allDesignOptions.findIndex(opt => opt.theme === currentPreviewData.tema_invitacion);
    return themeIdx !== -1 ? themeIdx : 0;
  })();

  useEffect(() => {
    if (!userHasNavigated) {
      setCurrentIndex(currentSavedIndex);
    }
  }, [currentSavedIndex, userHasNavigated]);

  const isCurrentDesign = currentIndex === currentSavedIndex;

  const romanticTemplate = themeId === 'romantic' ? getRomanticTemplateConfig(resolvedPreviewData.invitation_template) : null;
  const friendsTemplateForBg = themeId === 'friends' ? friendsTemplateConfig : null;
  const wellnessTemplateForBg = themeId === 'wellness' ? wellnessTemplateConfig : null;
  const formalTemplateForBg = themeId === 'formal' ? formalTemplateConfig : null;
  const familyTemplateForBg = themeId === 'family' ? familyTemplateConfig : null;
  const specialTemplateForBg = themeId === 'special' ? specialTemplateConfig : null;
  const sportsTemplateForBg = themeId === 'sports' ? sportsTemplateConfig : null;
  const entertainmentTemplateForBg = themeId === 'entertainment' ? entertainmentTemplateConfig : null;
  const learningTemplateForBg = themeId === 'learning' ? learningTemplateConfig : null;

  const activeBgConfig =
    romanticTemplate ||
    friendsTemplateForBg ||
    wellnessTemplateForBg ||
    formalTemplateForBg ||
    familyTemplateForBg ||
    specialTemplateForBg ||
    sportsTemplateForBg ||
    entertainmentTemplateForBg ||
    learningTemplateForBg ||
    null;

  const customStyles = activeBgConfig?.background
    ? { '--guest-bg-image': `url(${activeBgConfig.background})` } as React.CSSProperties
    : {};

  const modalContent = (
    <div className={`preview-modal-overlay guest-theme guest-theme--${themeId}`} style={customStyles}>
      <div className="preview-modal-content">
        <div className="preview-modal-header">
          <h3 className="preview-modal-title">Vista previa</h3>
          <button
            type="button"
            className="preview-modal-close"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleClose(); }}
            aria-label="Cerrar vista previa"
          >
            <X size={20} />
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
          {themeId === 'custom' ? (
            <div className="ipm-scrollable-content">
              <CustomInvitationPreview
                titulo={resolvedPreviewData.titulo}
                fecha={resolvedPreviewData.fecha}
                hora={resolvedPreviewData.hora}
                lugar_texto={resolvedPreviewData.lugar_texto}
                descripcion={resolvedPreviewData.descripcion}
                templateId={resolvedPreviewData.invitation_template}
                variant="full"
              />
            </div>
          ) : themeId === 'kids_birthday' ? (
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

        <>
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
          </>

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
              Aplicar diseño
            </Button>
          ) : (
            <Button fullWidth variant="secondary" onClick={() => {}} style={{ opacity: 0.7, pointerEvents: 'none' }}>
              Diseño actual
            </Button>
          )}

          <Button
            fullWidth
            variant="secondary"
            onClick={() => setShowCategorySelector(true)}
            style={{ background: '#FFFFFF', color: 'var(--color-on-surface)', boxShadow: '0 4px 12px rgba(0,0,0,0.05)' }}
          >
            Cambiar diseño
          </Button>

          <Button
            fullWidth
            variant="secondary"
            onClick={handleClose}
            style={{ background: '#FFFFFF', color: '#374151', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', fontWeight: 600 }}
          >
            Cerrar vista previa
          </Button>
        </div>
      </div>

      {showVariantSelector && (
        <div className="dh-modal-overlay" style={{ zIndex: 10000, position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div className="dh-bottom-sheet" style={{ background: '#fff', padding: '24px 20px', maxHeight: '85vh', overflowY: 'auto', borderTopLeftRadius: '24px', borderTopRightRadius: '24px', position: 'relative' }}>
            <button
              onClick={() => setShowVariantSelector(false)}
              style={{ position: 'absolute', right: '16px', top: '16px', background: 'transparent', border: 'none', cursor: 'pointer', color: '#6B7280' }}
            >
              <X size={24} />
            </button>
            <h3 className="dh-sheet-title" style={{ marginBottom: 16 }}>Cambiar modelo</h3>

            {activeOption.theme === 'kids_birthday' && (
               <KidsBirthdayTemplateSelector selectedTemplateId={activeOption.template || 'kids_jungle'} onSelect={handleSelectVariant} titulo={resolvedPreviewData.titulo} descripcion={resolvedPreviewData.descripcion} fecha={resolvedPreviewData.fecha} hora={resolvedPreviewData.hora} lugar_texto={resolvedPreviewData.lugar_texto} />
            )}
            {activeOption.theme === 'celebration' && (
               <CelebrationTemplateSelector selectedTemplateId={activeOption.template || 'celebration_gold'} onSelect={handleSelectVariant} titulo={resolvedPreviewData.titulo} descripcion={resolvedPreviewData.descripcion} fecha={resolvedPreviewData.fecha} hora={resolvedPreviewData.hora} lugar_texto={resolvedPreviewData.lugar_texto} />
            )}
            {activeOption.theme === 'romantic' && (
               <RomanticTemplateSelector selectedTemplateId={activeOption.template || 'romantic_classic'} onSelect={handleSelectVariant} titulo={resolvedPreviewData.titulo} descripcion={resolvedPreviewData.descripcion} fecha={resolvedPreviewData.fecha} hora={resolvedPreviewData.hora} lugar_texto={resolvedPreviewData.lugar_texto} />
            )}
            {activeOption.theme === 'formal' && (
               <FormalTemplateSelector selectedTemplateId={activeOption.template || 'formal_black_tie'} onSelect={handleSelectVariant} titulo={resolvedPreviewData.titulo} descripcion={resolvedPreviewData.descripcion} fecha={resolvedPreviewData.fecha} hora={resolvedPreviewData.hora} lugar_texto={resolvedPreviewData.lugar_texto} />
            )}
            {activeOption.theme === 'friends' && (
               <FriendsTemplateSelector selectedTemplateId={activeOption.template || 'friends_coffee'} onSelect={handleSelectVariant} titulo={resolvedPreviewData.titulo} descripcion={resolvedPreviewData.descripcion} fecha={resolvedPreviewData.fecha} hora={resolvedPreviewData.hora} lugar_texto={resolvedPreviewData.lugar_texto} />
            )}
            {activeOption.theme === 'family' && (
               <FamilyTemplateSelector selectedTemplateId={activeOption.template || 'family_home'} onSelect={handleSelectVariant} titulo={resolvedPreviewData.titulo} descripcion={resolvedPreviewData.descripcion} fecha={resolvedPreviewData.fecha} hora={resolvedPreviewData.hora} lugar_texto={resolvedPreviewData.lugar_texto} />
            )}
            {activeOption.theme === 'special' && (
               <SpecialTemplateSelector selectedTemplateId={activeOption.template || 'special_moment'} onSelect={handleSelectVariant} titulo={resolvedPreviewData.titulo} descripcion={resolvedPreviewData.descripcion} fecha={resolvedPreviewData.fecha} hora={resolvedPreviewData.hora} lugar_texto={resolvedPreviewData.lugar_texto} />
            )}
            {activeOption.theme === 'sports' && (
               <SportsTemplateSelector selectedTemplateId={activeOption.template || 'sports_field'} onSelect={handleSelectVariant} titulo={resolvedPreviewData.titulo} descripcion={resolvedPreviewData.descripcion} fecha={resolvedPreviewData.fecha} hora={resolvedPreviewData.hora} lugar_texto={resolvedPreviewData.lugar_texto} />
            )}
            {activeOption.theme === 'entertainment' && (
               <EntertainmentTemplateSelector selectedTemplateId={activeOption.template || 'entertainment_cinema'} onSelect={handleSelectVariant} titulo={resolvedPreviewData.titulo} descripcion={resolvedPreviewData.descripcion} fecha={resolvedPreviewData.fecha} hora={resolvedPreviewData.hora} lugar_texto={resolvedPreviewData.lugar_texto} />
            )}
            {activeOption.theme === 'learning' && (
               <LearningTemplateSelector selectedTemplateId={activeOption.template || 'learning_class'} onSelect={handleSelectVariant} titulo={resolvedPreviewData.titulo} descripcion={resolvedPreviewData.descripcion} fecha={resolvedPreviewData.fecha} hora={resolvedPreviewData.hora} lugar_texto={resolvedPreviewData.lugar_texto} />
            )}
            {activeOption.theme === 'wellness' && (
               <WellnessTemplateSelector selectedTemplateId={activeOption.template || 'wellness_calm'} onSelect={handleSelectVariant} titulo={resolvedPreviewData.titulo} descripcion={resolvedPreviewData.descripcion} fecha={resolvedPreviewData.fecha} hora={resolvedPreviewData.hora} lugar_texto={resolvedPreviewData.lugar_texto} />
            )}
          </div>
        </div>
      )}

      {showCategorySelector && (
        <div className="dh-modal-overlay" style={{ zIndex: 10000, position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div className="dh-bottom-sheet" style={{ background: '#fff', padding: '24px 20px', maxHeight: '85vh', overflowY: 'auto', borderTopLeftRadius: '24px', borderTopRightRadius: '24px', position: 'relative' }}>
            <button
              onClick={() => setShowCategorySelector(false)}
              style={{ position: 'absolute', right: '16px', top: '16px', background: 'transparent', border: 'none', cursor: 'pointer', color: '#6B7280' }}
            >
              <X size={24} />
            </button>
            <h3 className="dh-sheet-title" style={{ marginBottom: 16 }}>Cambiar diseño</h3>

            <div style={{ marginBottom: 24 }}>
              <h4 style={{ fontSize: 14, fontWeight: 600, color: '#4B5563', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Mis diseños personalizados</h4>
              {customDesigns.length > 0 ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                  {customDesigns.map(design => (
                    <div
                      key={design.id}
                      onClick={() => handleSelectCustomDesign(design.id)}
                      style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4 }}
                    >
                      <div style={{ aspectRatio: '4/5', background: '#f3f4f6', borderRadius: 8, overflow: 'hidden' }}>
                         {design.thumbnail_path && (
                            <img
                              src={customDesignsService.getCustomDesignPublicUrl(design.thumbnail_path)}
                              alt={design.name}
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                         )}
                      </div>
                      <span style={{ fontSize: 12, color: '#374151', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{design.name || 'Tu diseño'}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 14, color: '#6B7280' }}>No tienes diseños activos.</p>
              )}
              <Button variant="secondary" fullWidth style={{ marginTop: 12 }} onClick={() => {
                setShowCategorySelector(false);
                setShowCustomDesignsSheet(true);
              }}>
                Gestionar diseños personalizados
              </Button>
            </div>

            <div>
              <h4 style={{ fontSize: 14, fontWeight: 600, color: '#4B5563', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Categorías</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Array.from(new Set(allDesignOptions.filter(opt => opt.theme !== 'custom').map(opt => opt.theme))).map(theme => {
                  const firstOpt = allDesignOptions.find(opt => opt.theme === theme);
                  if (!firstOpt) return null;
                  return (
                    <button
                      key={theme}
                      onClick={() => {
                        setUserHasNavigated(true);
                        const defaultTemplate = getDefaultInvitationTemplate(theme) || firstOpt.template;
                        const targetIndex = allDesignOptions.findIndex(opt => opt.theme === theme && opt.template === defaultTemplate);
                        if (targetIndex !== -1) {
                          setCurrentIndex(targetIndex);
                        } else {
                          // Fallback to first option of that category
                          setCurrentIndex(allDesignOptions.findIndex(opt => opt.theme === theme));
                        }
                        setShowCategorySelector(false);
                        // Optional: automatically show variant selector for non-classic
                        if (theme !== 'classic') {
                          setTimeout(() => setShowVariantSelector(true), 50);
                        }
                      }}
                      style={{ textAlign: 'left', padding: '12px 16px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 15, fontWeight: 500, color: '#111827', cursor: 'pointer' }}
                    >
                      {firstOpt.categoryLabel}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <CustomDesignsSheet
        isOpen={showCustomDesignsSheet}
        onClose={() => setShowCustomDesignsSheet(false)}
        onSelectDesign={handleSelectCustomDesign}
      />
    </div>
  );

  return createPortal(modalContent, document.body);
};
