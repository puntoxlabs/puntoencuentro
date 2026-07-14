import React from 'react';
import { ChevronDown } from 'lucide-react';

interface ScrollHintProps {
  visible: boolean;
  text?: string;
}

export const ScrollHint: React.FC<ScrollHintProps> = ({ visible, text = 'Deslizá para ver más' }) => {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
        left: '50%',
        transform: `translate(-50%, ${visible ? '0' : '12px'})`,
        opacity: visible ? 1 : 0,
        pointerEvents: 'none',
        zIndex: 100,
        transition: 'opacity 0.35s cubic-bezier(0.16, 1, 0.3, 1), transform 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '6px 14px',
        borderRadius: 999,
        background: 'rgba(255, 255, 255, 0.65)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid rgba(0, 0, 0, 0.04)',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.05)',
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 600, color: '#4b5563', letterSpacing: '0', fontFamily: 'var(--font-family, sans-serif)' }}>
        {text}
      </span>
      <ChevronDown
        size={13}
        color="#374151"
        style={{
          animation: 'bounceSlow 1.8s infinite ease-in-out',
        }}
      />
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes bounceSlow {
          0%, 100% { transform: translateY(-1px); }
          50% { transform: translateY(3px); }
        }
      `}} />
    </div>
  );
};
