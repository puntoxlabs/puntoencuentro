import React, { useState } from 'react';
import { Calendar, Clock, MapPin, Video, Sparkles, Edit3, ArrowRight, Share2, Users, Check, X } from 'lucide-react';
import type { EncounterDraft, InvitationConfig } from '@/lib/encounterDraft';
import { formatFriendlyDate } from '@/lib/formatDate';
import {
  INVITATION_THEMES,
  AI_SUPPORTED_THEMES,
  getTemplateOptionsForTheme,
  getDefaultInvitationTemplate,
} from '@/lib/invitationThemes';

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
  const [showThemeSelector, setShowThemeSelector] = useState(false);
  const [showInvitationTypeSelector, setShowInvitationTypeSelector] = useState(false);

  const activeThemeConfig = INVITATION_THEMES.find((t) => t.id === config.invitationTheme);
  const themeTemplates = getTemplateOptionsForTheme(config.invitationTheme);
  const defaultTemplate = getDefaultInvitationTemplate(config.invitationTheme);
  const activeTemplate = themeTemplates.find(
    (t) => t.id === (config.invitationTemplate || defaultTemplate)
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

        {/* Row 1: Tema */}
        <div
          style={{
            paddingTop: '10px',
            borderTop: '1px solid #e2e8f0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ minWidth: 0, flex: 1, paddingRight: '8px' }}>
            <span
              style={{
                fontSize: '11px',
                textTransform: 'uppercase',
                color: '#64748b',
                fontWeight: 600,
                display: 'block',
              }}
            >
              Tema
            </span>
            <div
              style={{
                fontSize: '14px',
                fontWeight: 600,
                color: '#0f172a',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {activeThemeConfig?.label || 'Clásico'}
              {templateSuffix}
            </div>
          </div>
          <button
            type="button"
            data-testid="change-theme-button"
            onClick={() => setShowThemeSelector(!showThemeSelector)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-primary, #4f46e5)',
              fontSize: '13px',
              cursor: 'pointer',
              fontWeight: 600,
              padding: '6px 8px',
              flexShrink: 0,
            }}
          >
            {showThemeSelector ? 'Cerrar' : 'Cambiar'}
          </button>
        </div>

        {/* Inline Theme & Variant Selector */}
        {showThemeSelector && (
          <div
            data-testid="theme-selector-panel"
            style={{
              background: '#ffffff',
              padding: '14px',
              borderRadius: '10px',
              border: '1px solid #e2e8f0',
              marginTop: '4px',
              marginBottom: '6px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: '#334155' }}>
                Elegí una categoría y diseño:
              </span>
              <button
                type="button"
                onClick={() => setShowThemeSelector(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '12px',
                  color: '#64748b',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '2px',
                }}
              >
                <X size={13} /> Cerrar
              </button>
            </div>

            {/* Categorías */}
            <div>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  display: 'block',
                  marginBottom: '6px',
                }}
              >
                Categoría
              </span>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
                  gap: '6px',
                  maxHeight: '150px',
                  overflowY: 'auto',
                  paddingRight: '4px',
                }}
              >
                {AI_SUPPORTED_THEMES.map((themeId) => {
                  const themeItem = INVITATION_THEMES.find((t) => t.id === themeId);
                  if (!themeItem) return null;
                  const isSelected = config.invitationTheme === themeId;
                  const Icon = themeItem.icon;
                  return (
                    <button
                      key={themeId}
                      type="button"
                      data-testid={`theme-option-${themeId}`}
                      onClick={() => {
                        const defaultTpl = getDefaultInvitationTemplate(themeId);
                        onChangeConfig('invitationTheme', themeId);
                        onChangeConfig('invitationTemplate', defaultTpl);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 8px',
                        borderRadius: '6px',
                        border: isSelected
                          ? '2px solid var(--color-primary, #4f46e5)'
                          : '1px solid #e2e8f0',
                        background: isSelected ? '#eef2ff' : '#ffffff',
                        color: isSelected ? 'var(--color-primary, #4f46e5)' : '#334155',
                        fontSize: '12px',
                        fontWeight: isSelected ? 700 : 500,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <Icon size={14} style={{ flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {themeItem.label}
                      </span>
                      {isSelected && <Check size={12} style={{ flexShrink: 0, color: 'var(--color-primary, #4f46e5)' }} />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Variantes del tema seleccionado */}
            <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '10px' }}>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: '#64748b',
                  textTransform: 'uppercase',
                  display: 'block',
                  marginBottom: '6px',
                }}
              >
                Variante de diseño
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {themeTemplates.length > 0 ? (
                  themeTemplates.map((tpl) => {
                    const isVariantSelected = (config.invitationTemplate || defaultTemplate) === tpl.id;
                    const isDefault = tpl.id === defaultTemplate;
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        data-testid={`template-variant-${tpl.id}`}
                        onClick={() => {
                          onChangeConfig('invitationTemplate', tpl.id);
                        }}
                        style={{
                          padding: '5px 10px',
                          borderRadius: '16px',
                          border: isVariantSelected
                            ? '2px solid var(--color-primary, #4f46e5)'
                            : '1px solid #cbd5e1',
                          background: isVariantSelected ? '#eef2ff' : '#ffffff',
                          color: isVariantSelected ? 'var(--color-primary, #4f46e5)' : '#334155',
                          fontSize: '12px',
                          fontWeight: isVariantSelected ? 700 : 500,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        {isVariantSelected && <Check size={12} />}
                        <span>{tpl.name}</span>
                        {isDefault && <span style={{ fontSize: '10px', opacity: 0.7 }}> (por defecto)</span>}
                      </button>
                    );
                  })
                ) : (
                  <button
                    type="button"
                    disabled
                    data-testid="template-variant-classic-default"
                    style={{
                      padding: '5px 10px',
                      borderRadius: '16px',
                      border: '2px solid var(--color-primary, #4f46e5)',
                      background: '#eef2ff',
                      color: 'var(--color-primary, #4f46e5)',
                      fontSize: '12px',
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      cursor: 'default',
                    }}
                  >
                    <Check size={12} />
                    <span>Estándar</span>
                    <span style={{ fontSize: '10px', opacity: 0.7 }}> (por defecto)</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Row 2: Tipo de invitación */}
        <div
          style={{
            paddingTop: '10px',
            borderTop: '1px solid #e2e8f0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ minWidth: 0, flex: 1, paddingRight: '8px' }}>
            <span
              style={{
                fontSize: '11px',
                textTransform: 'uppercase',
                color: '#64748b',
                fontWeight: 600,
                display: 'block',
              }}
            >
              Tipo de invitación
            </span>
            <div
              style={{
                fontSize: '14px',
                fontWeight: 600,
                color: '#0f172a',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {config.invitationType === 'link_general' ? 'Enlace general' : 'Invitación individual'}
            </div>
          </div>
          <button
            type="button"
            data-testid="change-invitation-type-button"
            onClick={() => setShowInvitationTypeSelector(!showInvitationTypeSelector)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-primary, #4f46e5)',
              fontSize: '13px',
              cursor: 'pointer',
              fontWeight: 600,
              padding: '6px 8px',
              flexShrink: 0,
            }}
          >
            {showInvitationTypeSelector ? 'Cerrar' : 'Cambiar'}
          </button>
        </div>

        {/* Inline Invitation Type Selector */}
        {showInvitationTypeSelector && (
          <div
            data-testid="invitation-type-panel"
            style={{
              background: '#ffffff',
              padding: '12px',
              borderRadius: '8px',
              border: '1px solid #e2e8f0',
              marginTop: '4px',
              marginBottom: '6px',
            }}
          >
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                data-testid="invitation-type-link-general"
                onClick={() => {
                  onChangeConfig('invitationType', 'link_general');
                  setShowInvitationTypeSelector(false);
                }}
                style={{
                  flex: 1,
                  padding: '8px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: 600,
                  border:
                    config.invitationType === 'link_general'
                      ? '2px solid var(--color-primary, #4f46e5)'
                      : '1px solid #cbd5e1',
                  background: config.invitationType === 'link_general' ? '#eef2ff' : '#ffffff',
                  color: config.invitationType === 'link_general' ? 'var(--color-primary, #4f46e5)' : '#334155',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                }}
              >
                <Share2 size={14} /> Link general
              </button>
              <button
                type="button"
                data-testid="invitation-type-individual"
                onClick={() => {
                  onChangeConfig('invitationType', 'individual');
                  setShowInvitationTypeSelector(false);
                }}
                style={{
                  flex: 1,
                  padding: '8px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: 600,
                  border:
                    config.invitationType === 'individual'
                      ? '2px solid var(--color-primary, #4f46e5)'
                      : '1px solid #cbd5e1',
                  background: config.invitationType === 'individual' ? '#eef2ff' : '#ffffff',
                  color: config.invitationType === 'individual' ? 'var(--color-primary, #4f46e5)' : '#334155',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                }}
              >
                <Users size={14} /> Individual
              </button>
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
