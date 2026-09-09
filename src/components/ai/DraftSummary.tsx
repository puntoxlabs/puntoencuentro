import React, { useState } from 'react';
import { Calendar, Clock, MapPin, Video, Sparkles, Edit3, ArrowRight, Share2, Users } from 'lucide-react';
import type { EncounterDraft, InvitationConfig } from '@/lib/encounterDraft';
import { formatFriendlyDate } from '@/lib/formatDate';
import { INVITATION_THEMES, getTemplateOptionsForTheme } from '@/lib/invitationThemes';

interface DraftSummaryProps {
  draft: EncounterDraft;
  config: InvitationConfig;
  isLoading: boolean;
  onConfirmCreate: () => void;
  onModify: (field: keyof EncounterDraft) => void;
  onFallbackManual: () => void;
  onChangeConfig: <K extends keyof InvitationConfig>(field: K, value: InvitationConfig[K]) => void;
}

export const DraftSummary: React.FC<DraftSummaryProps> = ({
  draft,
  config,
  isLoading,
  onConfirmCreate,
  onModify,
  onFallbackManual,
  onChangeConfig,
}) => {
  const [showConfigOptions, setShowConfigOptions] = useState(false);

  const activeThemeConfig = INVITATION_THEMES.find((t) => t.id === config.invitationTheme);
  const activeTemplate = getTemplateOptionsForTheme(config.invitationTheme).find(
    (t) => t.id === config.invitationTemplate
  );
  const templateSuffix = activeTemplate ? ` (${activeTemplate.name})` : '';

  return (
    <div
      style={{
        background: 'var(--color-surface, #ffffff)',
        border: '1px solid var(--color-outline-variant, #e2e8f0)',
        borderRadius: '16px',
        padding: '20px',
        margin: '16px 0',
        boxShadow: '0 4px 16px rgba(0,0,0,0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        <Sparkles size={20} color="var(--color-primary, #4f46e5)" />
        <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: 'var(--color-on-surface, #0f172a)' }}>
          Tu encuentro está listo
        </h2>
      </div>

      <div
        style={{
          background: 'var(--color-surface-variant, #f8fafc)',
          borderRadius: '12px',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          marginBottom: '20px',
        }}
      >
        {/* Title */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <span style={{ fontSize: '11px', textTransform: 'uppercase', color: '#64748b', fontWeight: 600 }}>
              Título
            </span>
            <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>{draft.title}</div>
          </div>
          <button
            onClick={() => onModify('title')}
            style={{ background: 'none', border: 'none', color: 'var(--color-primary, #4f46e5)', cursor: 'pointer', padding: '4px' }}
            title="Modificar título"
          >
            <Edit3 size={15} />
          </button>
        </div>

        {/* Date & Time */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <span style={{ fontSize: '11px', textTransform: 'uppercase', color: '#64748b', fontWeight: 600 }}>
              Cuándo
            </span>
            <div style={{ fontSize: '14px', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Calendar size={15} color="#0284c7" />
              <span>{formatFriendlyDate(draft.date || '', draft.time || '').split('•')[0]}</span>
              <Clock size={15} color="#0284c7" style={{ marginLeft: '6px' }} />
              <span>{draft.time} hs</span>
            </div>
          </div>
          <button
            onClick={() => onModify('date')}
            style={{ background: 'none', border: 'none', color: 'var(--color-primary, #4f46e5)', cursor: 'pointer', padding: '4px' }}
            title="Modificar fecha u hora"
          >
            <Edit3 size={15} />
          </button>
        </div>

        {/* Modality & Location */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <span style={{ fontSize: '11px', textTransform: 'uppercase', color: '#64748b', fontWeight: 600 }}>
              {draft.modality === 'virtual' ? 'Videollamada' : 'Lugar'}
            </span>
            <div style={{ fontSize: '14px', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
              {draft.modality === 'virtual' ? (
                <>
                  <Video size={15} color="#16a34a" />
                  <span style={{ color: '#16a34a', wordBreak: 'break-all' }}>{draft.virtualLink}</span>
                </>
              ) : (
                <>
                  <MapPin size={15} color="#ea580c" />
                  <span>{draft.locationText}</span>
                </>
              )}
            </div>
          </div>
          <button
            onClick={() => onModify(draft.modality === 'virtual' ? 'virtualLink' : 'locationText')}
            style={{ background: 'none', border: 'none', color: 'var(--color-primary, #4f46e5)', cursor: 'pointer', padding: '4px' }}
            title="Modificar lugar o link"
          >
            <Edit3 size={15} />
          </button>
        </div>

        {/* Theme & Invitation Config toggle */}
        <div style={{ paddingTop: '8px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '12px', color: '#475569' }}>
            Tema: <strong>{activeThemeConfig?.label || 'Clásico'}{templateSuffix}</strong> •{' '}
            {config.invitationType === 'link_general' ? 'Enlace general' : 'Invitación individual'}
          </div>
          <button
            onClick={() => setShowConfigOptions(!showConfigOptions)}
            style={{ background: 'none', border: 'none', color: 'var(--color-primary, #4f46e5)', fontSize: '12px', cursor: 'pointer', fontWeight: 600 }}
          >
            {showConfigOptions ? 'Cerrar' : 'Cambiar'}
          </button>
        </div>

        {showConfigOptions && (
          <div style={{ background: '#ffffff', padding: '12px', borderRadius: '8px', border: '1px solid #e2e8f0', marginTop: '6px' }}>
            <div style={{ marginBottom: '10px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '6px' }}>
                Tipo de invitación:
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => onChangeConfig('invitationType', 'link_general')}
                  style={{
                    flex: 1,
                    padding: '6px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    border: config.invitationType === 'link_general' ? '2px solid var(--color-primary)' : '1px solid #cbd5e1',
                    background: config.invitationType === 'link_general' ? '#eef2ff' : '#ffffff',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px',
                  }}
                >
                  <Share2 size={13} /> Link general
                </button>
                <button
                  onClick={() => onChangeConfig('invitationType', 'individual')}
                  style={{
                    flex: 1,
                    padding: '6px',
                    borderRadius: '6px',
                    fontSize: '12px',
                    border: config.invitationType === 'individual' ? '2px solid var(--color-primary)' : '1px solid #cbd5e1',
                    background: config.invitationType === 'individual' ? '#eef2ff' : '#ffffff',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px',
                  }}
                >
                  <Users size={13} /> Individual
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Main Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <button
          onClick={onConfirmCreate}
          disabled={isLoading}
          style={{
            width: '100%',
            padding: '14px',
            borderRadius: '12px',
            background: 'var(--color-primary, #4f46e5)',
            color: '#ffffff',
            border: 'none',
            fontSize: '15px',
            fontWeight: 700,
            cursor: isLoading ? 'not-allowed' : 'pointer',
            opacity: isLoading ? 0.7 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            boxShadow: '0 2px 6px rgba(79, 70, 229, 0.3)',
          }}
        >
          {isLoading ? 'Creando encuentro...' : 'Crear encuentro'}
          {!isLoading && <ArrowRight size={18} />}
        </button>

        <button
          onClick={onFallbackManual}
          disabled={isLoading}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-on-surface-variant, #64748b)',
            fontSize: '13px',
            cursor: 'pointer',
            padding: '8px',
            textDecoration: 'underline',
          }}
        >
          Completar en el formulario manual
        </button>
      </div>
    </div>
  );
};
