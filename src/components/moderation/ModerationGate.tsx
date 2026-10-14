import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useModerationAuthorization, type ModerationAuthStatus } from '../../hooks/useModerationAuthorization';
import { Button } from '../ui/Button';

interface ModerationGateProps {
  children: React.ReactNode;
  hookOverride?: () => {
    status: ModerationAuthStatus;
    retry?: () => void;
    userId?: string | null;
    error?: string | null;
  };
}

export const ModerationGate: React.FC<ModerationGateProps> = ({ children, hookOverride }) => {
  let navigate = (_path: string) => {};
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    navigate = useNavigate();
  } catch {
    /* Safe fallback when rendered outside Router in tests */
  }

  const defaultHook = useModerationAuthorization;
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
            No tenés autorización para acceder a la consola de moderación.
          </p>
          {userId && (
            <div
              style={{
                fontSize: '11px',
                fontFamily: 'monospace',
                color: 'var(--color-outline, #8E95A7)',
                background: 'rgba(0,0,0,0.04)',
                padding: '6px 10px',
                borderRadius: '6px',
                marginBottom: '24px',
                wordBreak: 'break-all',
              }}
            >
              UID: {userId}
            </div>
          )}
          <Button
            variant="primary"
            onClick={() => navigate('/')}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            Volver al inicio
          </Button>
        </div>
      </div>
    );
  }

  // Estado E: Error técnico de verificación
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
            color: 'var(--color-error, #D32F2F)',
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
          No pudimos comprobar tus permisos en este momento. Por favor intentá nuevamente.
        </p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          {retry && (
            <Button variant="outline" onClick={retry}>
              Reintentar
            </Button>
          )}
          <Button variant="ghost" onClick={() => navigate('/')}>
            Ir al inicio
          </Button>
        </div>
      </div>
    </div>
  );
};
