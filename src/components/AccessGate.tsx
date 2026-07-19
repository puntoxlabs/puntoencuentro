import React, { useState } from 'react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

const ENABLE_TEST_ACCESS_GATE = true; // Set to false or remove AccessGate before public launch.
const ACCESS_STORAGE_KEY = 'puntoencuentro_test_access_v1';
const EXPECTED_HASH = '298f4c329ee837515da80384316468597749d103d18f0a0cec8b8ae732088b19';

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

interface AccessGateProps {
  children: React.ReactNode;
}

export const AccessGate: React.FC<AccessGateProps> = ({ children }) => {
  const [isGranted, setIsGranted] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(ACCESS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.granted === true;
      }
    } catch (e) {
      // Ignore
    }
    return false;
  });
  
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // If gate is disabled, just render children immediately
  if (!ENABLE_TEST_ACCESS_GATE) {
    return <>{children}</>;
  }

  if (isGranted) {
    return <>{children}</>;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    
    setIsLoading(true);
    setError('');
    
    try {
      const hash = await sha256(password);
      if (hash === EXPECTED_HASH) {
        localStorage.setItem(ACCESS_STORAGE_KEY, JSON.stringify({ granted: true, at: Date.now() }));
        setIsGranted(true);
      } else {
        setError('Contraseña incorrecta');
      }
    } catch (err) {
      console.error('Crypto API error', err);
      setError('Error validando credenciales. Intentá nuevamente.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'var(--color-background, #F5F7FA)',
      padding: '20px'
    }}>
      <div style={{
        background: 'var(--color-surface, #FFFFFF)',
        borderRadius: '16px',
        padding: '40px 24px',
        maxWidth: '400px',
        width: '100%',
        boxShadow: '0 8px 30px rgba(0,0,0,0.08)',
        textAlign: 'center'
      }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, color: 'var(--color-on-surface, #0F1322)', marginBottom: '8px' }}>
          PuntoEncuentro
        </h1>
        <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--color-on-surface-variant, #4B5162)', marginBottom: '16px' }}>
          Acceso de pruebas
        </h2>
        <p style={{ fontSize: '14px', color: 'var(--color-on-surface-variant, #4B5162)', marginBottom: '32px', lineHeight: 1.5 }}>
          Este sitio se encuentra en etapa de pruebas. Ingresá la contraseña para continuar.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px', textAlign: 'left' }}>
          <div style={{ position: 'relative' }}>
            <Input
              type={showPassword ? 'text' : 'password'}
              label="Contraseña"
              placeholder="••••••••"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError('');
              }}
              error={error}
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              style={{
                position: 'absolute',
                right: '12px',
                top: '38px',
                background: 'transparent',
                border: 'none',
                color: 'var(--color-outline, #8E95A7)',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 600,
                padding: '4px'
              }}
            >
              {showPassword ? 'OCULTAR' : 'MOSTRAR'}
            </button>
          </div>

          <Button type="submit" variant="primary" fullWidth disabled={isLoading} style={{ marginTop: '8px' }}>
            Entrar
          </Button>
        </form>
      </div>
    </div>
  );
};
