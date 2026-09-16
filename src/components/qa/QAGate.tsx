import React from 'react';
import { Navigate } from 'react-router-dom';
import { useQAAuthorization } from '../../hooks/useQAAuthorization';

interface QAGateProps {
  children: React.ReactNode;
  hookOverride?: () => { status: 'checking' | 'authorized' | 'unauthorized' | 'error' };
}

export const QAGate: React.FC<QAGateProps> = ({ children, hookOverride }) => {
  const defaultHook = useQAAuthorization;
  const { status } = hookOverride ? hookOverride() : defaultHook();

  if (status === 'checking') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--color-background)' }}>
        <p style={{ color: 'var(--color-outline)' }}>Cargando...</p>
      </div>
    );
  }

  if (status === 'authorized') {
    return <>{children}</>;
  }

  // Unauthorized or Error: Redirect silently to home
  return <Navigate to="/" replace />;
};
