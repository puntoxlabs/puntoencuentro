import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQAAuthorization, type QAAuthStatus } from '../../hooks/useQAAuthorization';
import { Button } from '../ui/Button';

interface QAGateProps {
  children: React.ReactNode;
  hookOverride?: () => {
    status: QAAuthStatus;
    retry?: () => void;
    userId?: string | null;
    error?: string | null;
  };
}

export const QAGate: React.FC<QAGateProps> = ({ children, hookOverride }) => {
  let navigate = (_path: string) => {};
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    navigate = useNavigate();
  } catch {
    /* Safe fallback when rendered outside Router in tests */
  }

  const defaultHook = useQAAuthorization;
  const { status, retry, userId } = hookOverride ? hookOverride() : defaultHook();

  // Estados A y B: Cargando (autenticación o autorización)
  if (status === 'auth_loading' || status === 'checking') {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          background: 'var(--color-background, #F5F7FA)',
        }}
      >
        <p style={{ color: 'var(--color-outline, #8E95A7)', fontSize: '15px', fontWeight: 500 }}>
          Cargando...
        </p>
      </div>
    );
  }

  // Estado C: Autorizado
  if (status === 'authorized') {
    return <>{children}</>;
  }

  // Estado D: No autorizado
  if (status === 'unauthorized') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--color-background, #F5F7FA)',
          padding: '20px',
        }}
      >
        <div
          style={{
            background: 'var(--color-surface, #FFFFFF)',
            borderRadius: '16px',
            padding: '36px 24px',
            maxWidth: '420px',
            width: '100%',
            boxShadow: '0 8px 30px rgba(0,0,0,0.08)',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '36px', marginBottom: '12px' }}>🔒</div>
          <h2
            style={{
              fontSize: '18px',
              fontWeight: 700,
              color: 'var(--color-on-surface, #0F1322)',
              marginBottom: '10px',
            }}
          >
            Acceso restringido
          </h2>
          <p
            style={{
              fontSize: '14px',
              color: 'var(--color-on-surface-variant, #4B5162)',
              marginBottom: '24px',
              lineHeight: 1.5,
            }}
          >
            No tenés autorización para acceder a esta consola.
          </p>
          {userId && (
            <div
              style={{
                marginBottom: '24px',
                padding: '10px 12px',
                background: 'var(--color-surface-variant, #F1F3F9)',
                borderRadius: '8px',
                fontSize: '12px',
                color: 'var(--color-outline, #6B7280)',
                wordBreak: 'break-all',
                textAlign: 'left',
              }}
            >
              <span style={{ fontWeight: 600, display: 'block', marginBottom: '4px' }}>
                Tu identificador de usuario (UID):
              </span>
              <code>{userId}</code>
            </div>
          )}
          <Button type="button" variant="primary" fullWidth onClick={() => navigate('/')}>
            Volver al inicio
          </Button>
        </div>
      </div>
    );
  }

  // Estado E: Error técnico
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--color-background, #F5F7FA)',
        padding: '20px',
      }}
    >
      <div
        style={{
          background: 'var(--color-surface, #FFFFFF)',
          borderRadius: '16px',
          padding: '36px 24px',
          maxWidth: '420px',
          width: '100%',
          boxShadow: '0 8px 30px rgba(0,0,0,0.08)',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '36px', marginBottom: '12px' }}>⚠️</div>
        <h2
          style={{
            fontSize: '18px',
            fontWeight: 700,
            color: 'var(--color-on-surface, #0F1322)',
            marginBottom: '10px',
          }}
        >
          Error de verificación
        </h2>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--color-on-surface-variant, #4B5162)',
            marginBottom: '24px',
            lineHeight: 1.5,
          }}
        >
          No pudimos verificar tu autorización.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <Button
            type="button"
            variant="primary"
            fullWidth
            onClick={() => retry?.()}
          >
            Reintentar
          </Button>
          <Button
            type="button"
            variant="secondary"
            fullWidth
            onClick={() => navigate('/')}
          >
            Volver al inicio
          </Button>
        </div>
      </div>
    </div>
  );
};
