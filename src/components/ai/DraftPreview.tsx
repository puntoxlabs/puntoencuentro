import React, { useState } from 'react';
import { Calendar, Clock, MapPin, Video, Tag, Check, Edit2 } from 'lucide-react';
import type { EncounterDraft } from '@/lib/encounterDraft';
import { formatFriendlyDate } from '@/lib/formatDate';

interface DraftPreviewProps {
  draft: EncounterDraft;
  onUpdateField: (field: keyof EncounterDraft, value: any) => void;
}

export const DraftPreview: React.FC<DraftPreviewProps> = ({ draft, onUpdateField }) => {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [tempValue, setTempValue] = useState<string>('');

  const hasAnyData = Boolean(
    draft.title || draft.date || draft.time || draft.modality || draft.locationText || draft.virtualLink
  );

  if (!hasAnyData) {
    return null;
  }

  const startEdit = (field: string, currentValue: string | null) => {
    setEditingField(field);
    setTempValue(currentValue || '');
  };

  const saveEdit = (field: keyof EncounterDraft) => {
    onUpdateField(field, tempValue.trim() || null);
    setEditingField(null);
  };

  const cancelEdit = () => {
    setEditingField(null);
    setTempValue('');
  };

  return (
    <div
      style={{
        background: 'var(--color-surface, #ffffff)',
        border: '1px solid var(--color-outline-variant, #e2e8f0)',
        borderRadius: '12px',
        padding: '14px',
        marginBottom: '16px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '12px',
          borderBottom: '1px solid var(--color-outline-variant, #f1f5f9)',
          paddingBottom: '8px',
        }}
      >
        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--color-primary, #4f46e5)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          📋 Datos detectados
        </span>
        <span style={{ fontSize: '11px', color: 'var(--color-on-surface-variant, #64748b)' }}>
          Tocá para editar
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {/* Title */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
            <Tag size={16} color="var(--color-primary, #4f46e5)" />
            {editingField === 'title' ? (
              <input
                type="text"
                value={tempValue}
                onChange={(e) => setTempValue(e.target.value)}
                autoFocus
                style={{ flex: 1, padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--color-primary)' }}
              />
            ) : (
              <span style={{ fontSize: '14px', fontWeight: 600 }}>
                {draft.title || <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>¿Cómo se llama?</span>}
              </span>
            )}
          </div>
          {editingField === 'title' ? (
            <div style={{ display: 'flex', gap: '4px' }}>
              <button onClick={() => saveEdit('title')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'green' }}><Check size={16} /></button>
              <button onClick={cancelEdit} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'red' }}>✕</button>
            </div>
          ) : (
            <button onClick={() => startEdit('title', draft.title)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}>
              <Edit2 size={14} />
            </button>
          )}
        </div>

        {/* Date & Time */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
            <Calendar size={16} color="#0284c7" />
            <span style={{ fontSize: '13px' }}>
              {draft.date ? (
                <span>
                  {formatFriendlyDate(draft.date, draft.time || '00:00').split('•')[0]}
                  {draft.time && (
                    <span style={{ marginLeft: '6px', fontWeight: 600 }}>
                      <Clock size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '3px' }} />
                      {draft.time} hs
                    </span>
                  )}
                </span>
              ) : (
                <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>Fecha y hora pendientes</span>
              )}
            </span>
          </div>
        </div>

        {/* Modality & Location */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
            {draft.modality === 'virtual' ? (
              <Video size={16} color="#16a34a" />
            ) : (
              <MapPin size={16} color="#ea580c" />
            )}
            <span style={{ fontSize: '13px' }}>
              {draft.modality === 'virtual' ? (
                draft.virtualLink ? (
                  <span style={{ color: '#16a34a' }}>Virtual ({draft.virtualLink})</span>
                ) : (
                  <span style={{ color: '#16a34a' }}>Virtual (enlace pendiente)</span>
                )
              ) : draft.modality === 'presencial' ? (
                draft.locationText ? (
                  <span>Presencial en <strong>{draft.locationText}</strong></span>
                ) : (
                  <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>Lugar presencial pendiente</span>
                )
              ) : (
                <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>Modalidad pendiente</span>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
