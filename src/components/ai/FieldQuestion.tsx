import React from 'react';
import type { FieldQuestion as FieldQuestionType } from '@/lib/draftFieldEngine';
import { formatHumanSchedule } from '@/lib/formatDate';

interface FieldQuestionProps {
  question: FieldQuestionType;
  onSelectOption: (value: string) => void;
  onHandoffCoordination?: () => void;
}

export const FieldQuestion: React.FC<FieldQuestionProps> = ({
  question,
  onSelectOption,
  onHandoffCoordination,
}) => {
  if (question.field === 'coordination_confirm' || question.type === 'coordination_card') {
    return (
      <div
        data-testid="coordination-confirm-card"
        style={{
          background: 'var(--color-primary-container, #f8faff)',
          border: '1.5px solid var(--color-primary, #4f46e5)',
          borderRadius: '14px',
          padding: '16px',
          margin: '14px 0',
          boxShadow: '0 2px 8px rgba(79, 70, 229, 0.08)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <span style={{ fontSize: '18px' }}>🗓️</span>
          <p style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: 'var(--color-on-surface, #1e293b)' }}>
            Elegir fecha con los invitados
          </p>
        </div>

        {question.dateOptions && question.dateOptions.length > 0 && (
          <div
            style={{
              background: '#ffffff',
              borderRadius: '10px',
              padding: '10px 14px',
              marginBottom: '12px',
              border: '1px solid var(--color-outline, #e2e8f0)',
            }}
          >
            {question.dateOptions.map((opt, idx) => (
              <div
                key={`${opt.date}_${opt.time}_${idx}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '4px 0',
                  fontSize: '14px',
                  color: 'var(--color-on-surface, #334155)',
                  fontWeight: 500,
                }}
              >
                <span style={{ color: 'var(--color-primary, #4f46e5)', fontSize: '16px' }}>•</span>
                <span>{formatHumanSchedule(opt.date, opt.time)}</span>
              </div>
            ))}
          </div>
        )}

        <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: 'var(--color-on-surface-variant, #475569)' }}>
          {question.question || '¿Querés que los invitados elijan entre estas fechas?'}
        </p>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button
            onClick={() => onSelectOption('confirm_coordination')}
            style={{
              padding: '9px 18px',
              borderRadius: '20px',
              background: 'var(--color-primary, #4f46e5)',
              color: '#ffffff',
              border: 'none',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(79, 70, 229, 0.25)',
            }}
          >
            Sí, continuar
          </button>
          <button
            onClick={() => onSelectOption('keep_fixed')}
            style={{
              padding: '9px 18px',
              borderRadius: '20px',
              background: '#ffffff',
              color: 'var(--color-on-surface, #334155)',
              border: '1px solid var(--color-outline, #cbd5e1)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {question.quickOptions?.[1]?.label || 'Elegir fecha fija'}
          </button>
        </div>
      </div>
    );
  }
  if (question.field === 'coordination_handoff') {
    const keepFixedOpt = question.quickOptions?.find((o) => o.value === 'keep_fixed');
    const handoffOpt = question.quickOptions?.find((o) => o.value === 'handoff_coordination');

    return (
      <div
        style={{
          background: 'var(--color-primary-container, #eef2ff)',
          border: '1px solid var(--color-primary, #6366f1)',
          borderRadius: '12px',
          padding: '14px',
          margin: '12px 0',
        }}
      >
        <p style={{ margin: '0 0 6px 0', fontSize: '14px', fontWeight: 600, color: 'var(--color-on-primary-container, #312e81)' }}>
          {question.question}
        </p>
        {question.helperText && (
          <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: 'var(--color-on-surface-variant, #475569)' }}>
            {question.helperText}
          </p>
        )}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            onClick={() => onSelectOption('keep_fixed')}
            style={{
              padding: '8px 16px',
              borderRadius: '20px',
              background: '#ffffff',
              color: 'var(--color-on-surface, #334155)',
              border: '1px solid var(--color-outline, #cbd5e1)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {keepFixedOpt?.label || 'Elegir fecha fija'}
          </button>
          <button
            onClick={onHandoffCoordination}
            style={{
              padding: '8px 16px',
              borderRadius: '20px',
              background: 'transparent',
              color: 'var(--color-primary, #4f46e5)',
              border: '1px solid var(--color-primary, #6366f1)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {handoffOpt?.label || 'Usar formulario manual'} →
          </button>
        </div>
      </div>
    );
  }

  if (!question.quickOptions || question.quickOptions.length === 0) {
    return null;
  }

  return (
    <div style={{ margin: '8px 0 16px 0' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {question.quickOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSelectOption(opt.value)}
            style={{
              padding: '6px 14px',
              borderRadius: '18px',
              background: 'var(--color-surface, #ffffff)',
              color: 'var(--color-primary, #4f46e5)',
              border: '1px solid var(--color-primary, #6366f1)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
              transition: 'all 0.15s ease',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
};
