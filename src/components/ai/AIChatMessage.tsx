import React from 'react';
import { Sparkles, User } from 'lucide-react';
import type { ChatMessage } from '@/store/aiWizardStore';

interface AIChatMessageProps {
  message: ChatMessage;
}

export const AIChatMessage: React.FC<AIChatMessageProps> = ({ message }) => {
  const isUser = message.role === 'user';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        marginBottom: '12px',
        width: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '8px',
          maxWidth: '85%',
          flexDirection: isUser ? 'row-reverse' : 'row',
        }}
      >
        <div
          style={{
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            background: isUser ? 'var(--color-primary-container, #e0e7ff)' : 'var(--color-secondary-container, #f3e8ff)',
            color: isUser ? 'var(--color-on-primary-container, #3730a3)' : 'var(--color-on-secondary-container, #6b21a8)',
          }}
        >
          {isUser ? <User size={16} /> : <Sparkles size={16} />}
        </div>

        <div
          style={{
            padding: '10px 14px',
            borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
            background: isUser
              ? 'var(--color-primary, #4f46e5)'
              : 'var(--color-surface-variant, #f1f5f9)',
            color: isUser ? '#ffffff' : 'var(--color-on-surface, #1e293b)',
            fontSize: '14px',
            lineHeight: 1.45,
            boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
            wordBreak: 'break-word',
          }}
        >
          {message.text}
        </div>
      </div>
    </div>
  );
};
