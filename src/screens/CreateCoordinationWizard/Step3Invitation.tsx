import React, { useState, useEffect } from 'react';
import { useCoordinationWizardStore } from '@/store/coordinationWizardStore';
import { Button } from '@/components/ui/Button';
import { InvitationThemeSelector } from '@/components/ui/InvitationThemeSelector';
import { Link, Users } from 'lucide-react';
import { SelectableOptionCard } from '@/components/ui/SelectableOptionCard';
import type { InvitationTheme } from '@/lib/invitationThemes';
import { themeRequiresTemplate, isTemplateValidForTheme, getDefaultInvitationTemplate } from '@/lib/invitationThemes';
import { ActiveThemeTemplateSelector } from '@/components/ui/ActiveThemeTemplateSelector';

interface Step3InvitationProps {
  onNext: () => void;
  onBack: () => void;
}

const Step3Invitation: React.FC<Step3InvitationProps> = ({ onNext, onBack }) => {
  const { draft, updateDraft } = useCoordinationWizardStore();
  const [errors, setErrors] = useState<{ [key: string]: string }>({});

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  const validate = () => {
    const newErrors: { [key: string]: string } = {};
    if (!draft.invitationType) {
      newErrors.invitationType = 'Elegí cómo querés invitar';
    }

    const theme = draft.invitationTheme || 'classic';
    if (theme === 'custom') {
      if (!draft.invitationTemplate?.startsWith('custom_')) {
        newErrors.theme = 'Completá tu diseño personalizado para continuar.';
      }
    } else if (themeRequiresTemplate(theme)) {
      if (!draft.invitationTemplate || !isTemplateValidForTheme(theme, draft.invitationTemplate)) {
        newErrors.theme = 'Elegí uno de los estilos disponibles para continuar.';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleNext = () => {
    if (validate()) {
      onNext();
    } else {
      setTimeout(() => {
        const firstError = document.querySelector('.input-error, [style*="color: #DC2626"]');
        if (firstError) {
          firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
          (firstError as HTMLElement).focus?.();
        }
      }, 50);
    }
  };

  return (
    <div className="pe-wizard-step fade-in" style={{ padding: '20px', display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div style={{ paddingBottom: '32px' }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8, color: 'var(--pe-text)' }}>
          Diseño y tipo de invitación
        </h2>
        <p style={{ color: 'var(--pe-text-muted)', marginBottom: 24, fontSize: 15, lineHeight: 1.5 }}>
          Elegí cómo se verá la invitación y de qué manera vas a invitar a los demás.
        </p>

        <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--pe-text)', marginBottom: 16 }}>
          Tema de la invitación
        </h3>
        <InvitationThemeSelector
          value={draft.invitationTheme as InvitationTheme}
          template={draft.invitationTemplate}
          onChange={(t, templ) => {
            // Replicating Step1Data's template clearing logic
            if (t === 'custom') {
              if (templ?.startsWith('custom_')) {
                updateDraft({ invitationTheme: t, invitationTemplate: templ });
              } else {
                updateDraft({ invitationTheme: t });
              }
              return;
            }
            if (templ) {
              updateDraft({ invitationTheme: t, invitationTemplate: templ });
            } else {
              const newTemplate = getDefaultInvitationTemplate(t) || '';
              updateDraft({ invitationTheme: t, invitationTemplate: newTemplate });
            }
          }}
        />

        {errors.theme && (
          <p style={{ color: '#DC2626', fontWeight: 500, fontSize: 14, marginTop: 8 }}>{errors.theme}</p>
        )}

        <ActiveThemeTemplateSelector
          theme={draft.invitationTheme || 'classic'}
          template={draft.invitationTemplate || null}
          onSelect={(id) => {
            updateDraft({ invitationTemplate: id });
            setErrors(prev => {
              const next = { ...prev };
              delete next.theme;
              return next;
            });
          }}
          titulo={draft.title}
          descripcion={draft.description}
          lugar_texto={draft.locationText}
          displayDateLabel="Fecha a coordinar"
        />

        <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--pe-text)', marginTop: 32, marginBottom: 16 }}>
          ¿Cómo vas a invitar?
        </h3>

        {errors.invitationType && (
          <p style={{ color: '#DC2626', fontWeight: 500, fontSize: 14, marginBottom: 16 }}>{errors.invitationType}</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
          <SelectableOptionCard
            title="Link general"
            description="Cualquiera con el enlace puede indicar su disponibilidad y sumarse."
            icon={<Link size={24} />}
            selected={draft.invitationType === 'link_general'}
            onClick={() => {
              updateDraft({ invitationType: 'link_general' });
              setErrors({});
            }}
          />
          {draft.invitationType === 'link_general' && (
            <p className="fade-in" style={{ fontSize: 14, color: 'var(--pe-text-muted)', marginTop: -4, marginBottom: 8, paddingLeft: 12 }}>
              Después de crear el encuentro podrás copiar y compartir el enlace.
            </p>
          )}

          <SelectableOptionCard
            title="Invitados individuales"
            description="Creá enlaces únicos para cada persona y llevá el control de quién respondió."
            icon={<Users size={24} />}
            selected={draft.invitationType === 'individual'}
            onClick={() => {
              updateDraft({ invitationType: 'individual' });
              setErrors({});
            }}
          />
          {draft.invitationType === 'individual' && (
            <p className="fade-in" style={{ fontSize: 14, color: 'var(--pe-text-muted)', marginTop: -4, marginBottom: 8, paddingLeft: 12 }}>
              Después de crear el encuentro podrás agregar personas y generar sus enlaces.
            </p>
          )}
        </div>
      </div>

      <div style={{ position: 'sticky', bottom: 0, padding: '16px 0', background: 'var(--pe-bg)', marginTop: 'auto', display: 'flex', gap: 12, zIndex: 10 }}>
        <Button variant="outline" onClick={onBack} style={{ flex: 1 }}>
          Atrás
        </Button>
        <Button variant="primary" onClick={handleNext} style={{ flex: 2 }}>
          Siguiente
        </Button>
      </div>
    </div>
  );
};

export default Step3Invitation;
