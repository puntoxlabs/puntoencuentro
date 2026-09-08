import React from 'react';
import type { FieldQuestion as FieldQuestionType } from '@/lib/draftFieldEngine';

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
  if (question.field === 'coordination_handoff') {
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
            onClick={onHandoffCoordination}
            style={{
              padding: '8px 16px',
              borderRadius: '20px',
              background: 'var(--color-primary, #4f46e5)',
              color: '#ffffff',
              border: 'none',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Ir a Coordinar fecha →
          </button>
          <button
            onClick={() => onSelectOption('keep_fixed')}
            style={{
              padding: '8px 16px',
              borderRadius: '20px',
              background: '#ffffff',
              color: 'var(--color-on-surface, #334155)',
              border: '1px solid var(--color-outline, #cbd5e1)',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            Elegir fecha fija acá
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
