import React from 'react';
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
        marginBottom: '10px',
        width: '100%',
      }}
    >
      <div
        style={{
          maxWidth: isUser ? '85%' : '90%',
          padding: '10px 15px',
          borderRadius: isUser ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
          background: isUser
            ? 'var(--color-primary, #4f46e5)'
            : 'var(--color-surface-variant, #f8fafc)',
          color: isUser ? '#ffffff' : 'var(--color-on-surface, #0f172a)',
          border: isUser ? 'none' : '1px solid var(--color-outline-variant, #e2e8f0)',
          fontSize: '16px',
          lineHeight: 1.48,
          boxShadow: isUser ? '0 1px 2px rgba(0,0,0,0.06)' : '0 1px 2px rgba(0,0,0,0.03)',
          wordBreak: 'break-word',
        }}
      >
        {message.text}
      </div>
    </div>
  );
};
