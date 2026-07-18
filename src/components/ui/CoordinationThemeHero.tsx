import React from 'react';
import { resolveInvitationTemplateForTheme, type InvitationTheme } from '@/lib/invitationThemes';
import { getFormalTemplateConfig } from '@/lib/formalTemplates';
import { getFriendsTemplateConfig } from '@/lib/friendsTemplates';
import { getFamilyTemplateConfig } from '@/lib/familyTemplates';
import { getSpecialTemplateConfig } from '@/lib/specialTemplates';
import { getSportsTemplateConfig } from '@/lib/sportsTemplates';
import { getEntertainmentTemplateConfig } from '@/lib/entertainmentTemplates';
import { getLearningTemplateConfig } from '@/lib/learningTemplates';
import { getWellnessTemplateConfig } from '@/lib/wellnessTemplates';

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
import { CustomGuestInvitationPreview } from '@/components/ui/CustomGuestInvitationPreview';

interface EncounterData {
  titulo: string;
  descripcion: string | null;
  estado?: string;
  modalidad: string;
  lugar_texto: string | null;
  tema: string | null;
  tema_invitacion: string;
  invitation_template: string | null;
}

interface CoordinationThemeHeroProps {
  encuentro: EncounterData;
  publicToken: string;
  isClosed: boolean;
  fechaConfirmada: string | null;
  horaConfirmada: string | null;
}

export const CoordinationThemeHero: React.FC<CoordinationThemeHeroProps> = ({
  encuentro,
  publicToken,
  isClosed,
  fechaConfirmada,
  horaConfirmada
}) => {
  const resolvedTemplate = resolveInvitationTemplateForTheme(encuentro.tema_invitacion as InvitationTheme, encuentro.invitation_template);

  const hasValidFormalTemplate = encuentro.tema_invitacion === 'formal' && !!getFormalTemplateConfig(resolvedTemplate);
  const hasValidFriendsTemplate = encuentro.tema_invitacion === 'friends' && !!getFriendsTemplateConfig(resolvedTemplate);
  const hasValidFamilyTemplate = encuentro.tema_invitacion === 'family' && !!getFamilyTemplateConfig(resolvedTemplate);
  const hasValidSpecialTemplate = encuentro.tema_invitacion === 'special' && !!getSpecialTemplateConfig(resolvedTemplate);
  const hasValidSportsTemplate = encuentro.tema_invitacion === 'sports' && !!getSportsTemplateConfig(resolvedTemplate);
  const hasValidEntertainmentTemplate = encuentro.tema_invitacion === 'entertainment' && !!getEntertainmentTemplateConfig(resolvedTemplate);
  const hasValidLearningTemplate = encuentro.tema_invitacion === 'learning' && !!getLearningTemplateConfig(resolvedTemplate);
  const hasValidWellnessTemplate = encuentro.tema_invitacion === 'wellness' && !!getWellnessTemplateConfig(resolvedTemplate);

  // Si está cerrado, mostramos la fecha real. Si está abierto, enviamos vacío al preview.
  const heroFecha = (isClosed && fechaConfirmada) ? fechaConfirmada : '';
  const heroHora = (isClosed && horaConfirmada) ? horaConfirmada : '';

  const dateDisplayLabel = isClosed ? null : 'Fecha a coordinar';

  const previewData = {
    titulo: encuentro.titulo || '',
    fecha: heroFecha,
    hora: heroHora,
    lugar_texto: encuentro.lugar_texto,
    modalidad: encuentro.modalidad,
    descripcion: encuentro.descripcion,
    tema_invitacion: encuentro.tema_invitacion || 'classic',
    invitation_template: resolvedTemplate
  };

  const isVirtual = encuentro.modalidad === 'virtual';
  const locationText = isVirtual ? 'Virtual' : (encuentro.lugar_texto || 'Presencial');

  const renderPreview = () => {
    if (encuentro.tema_invitacion === 'custom') {
      return (
        <CustomGuestInvitationPreview
          invitationToken={publicToken}
          titulo={encuentro.titulo}
          fecha={heroFecha}
          hora={heroHora}
          lugar_texto={locationText}
          hostMessage={encuentro.descripcion || ''}
        />
      );
    }

    if (encuentro.tema_invitacion === 'kids_birthday') {
      return (
        <KidsBirthdayInvitationPreview
          templateId={resolvedTemplate}
          childName={encuentro.titulo}
          date={heroFecha}
          time={heroHora}
          location={locationText}
          hostMessage={encuentro.descripcion || ''}
          confirmationText={undefined}
          isReadOnly={true}
        />
      );
    }

    if (encuentro.tema_invitacion === 'celebration') {
      return <CelebrationInvitationPreview previewData={previewData} />;
    }
    if (hasValidFormalTemplate) return <FormalInvitationPreview previewData={previewData} />;
    if (hasValidFriendsTemplate) return <FriendsInvitationPreview previewData={previewData} />;
    if (hasValidFamilyTemplate) return <FamilyInvitationPreview previewData={previewData} />;
    if (hasValidSpecialTemplate) return <SpecialInvitationPreview previewData={previewData} />;
    if (hasValidSportsTemplate) return <SportsInvitationPreview previewData={previewData} />;
    if (hasValidEntertainmentTemplate) return <EntertainmentInvitationPreview previewData={previewData} />;
    if (hasValidLearningTemplate) return <LearningInvitationPreview previewData={previewData} />;
    if (hasValidWellnessTemplate) return <WellnessInvitationPreview previewData={previewData} />;

    // Fallback
    return (
      <div style={{
        background: '#fff',
        padding: '32px 24px',
        borderRadius: '24px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.06)',
        textAlign: 'center',
        border: '1px solid #f1f5f9'
      }}>
        <h2 style={{ fontSize: 28, fontWeight: 800, color: '#0f172a', margin: '0 0 12px 0' }}>
          {encuentro.titulo}
        </h2>
        {isClosed && (heroFecha || heroHora) && (
          <div style={{ color: '#64748b', fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
            <span style={{ color: '#16a34a', fontWeight: 700 }}>✓ Fecha confirmada:</span> {heroFecha} {heroHora ? `a las ${heroHora.slice(0,5)}` : ''}
          </div>
        )}
        {encuentro.descripcion && (
          <p style={{ color: '#475569', fontSize: 16, lineHeight: 1.6, margin: 0, marginTop: 12 }}>
            {encuentro.descripcion}
          </p>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      {renderPreview()}
      
      {dateDisplayLabel && (
        <div style={{
          background: 'rgba(255, 255, 255, 0.9)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          border: '1px solid rgba(226, 232, 240, 0.8)',
          padding: '14px 20px',
          borderRadius: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          color: '#334155',
          fontWeight: 700,
          fontSize: 16,
          boxShadow: '0 4px 12px rgba(0,0,0,0.05)'
        }}>
          <span style={{ fontSize: 20 }}>🗓</span> {dateDisplayLabel}
        </div>
      )}
    </div>
  );
};
