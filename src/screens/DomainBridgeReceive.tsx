import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  RefreshCw,
  AlertCircle,
  HelpCircle,
  Key,
  ArrowRight,
} from 'lucide-react';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuth } from '@/contexts/AuthContext';
import {
  domainMigrationBridgeService,
  type BridgeReceiveState,
  getMigrationUserMessage,
} from '@/services/domainMigrationBridgeService';
import { getBrandConfig } from '@/config/domainConfig';
import { ENABLE_DOMAIN_MIGRATION_BRIDGE } from '@/config/features';

export const DomainBridgeReceiveScreen: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { signInWithGoogle } = useAuth();
  const brand = getBrandConfig();

  const [state, setState] = useState<BridgeReceiveState>('initializing');
  const [manualCodeInput, setManualCodeInput] = useState<string>('');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [isSubmittingManual, setIsSubmittingManual] = useState<boolean>(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState<boolean>(false);

  const bridgeListenerRef = useRef<{ cleanup: () => void } | null>(null);

  // Redirigir si el feature flag está apagado
  useEffect(() => {
    if (!ENABLE_DOMAIN_MIGRATION_BRIDGE) {
      navigate('/', { replace: true });
    }
  }, [navigate]);

  // Inicialización de sesión y detección de opener
  useEffect(() => {
    if (!ENABLE_DOMAIN_MIGRATION_BRIDGE) return;

    let mounted = true;

    const init = async () => {
      try {
        const { user } = await domainMigrationBridgeService.ensureTargetUser();
        if (!mounted) return;

        const hasOpener = typeof window !== 'undefined' && Boolean(window.opener);

        if (hasOpener && window.opener) {
          // Iniciar escucha automática con opener
          setState('receiving_auto');
          const sourceOriginParam = searchParams.get('source_origin');
          const bridgeSession = domainMigrationBridgeService.listenForBridgeCodeOnReceive({
            sourceOpener: window.opener,
            targetUserId: user.id,
            sourceOrigin: sourceOriginParam || undefined,
            onCodeReceived: async (ticketToken) => {
              const claimRes = await domainMigrationBridgeService.claimMigrationTicket(ticketToken);
              if (!mounted) return;

              if (claimRes.ok) {
                bridgeSession.notifyCompleted();
                setState('completed');
              } else {
                setErrorCode(claimRes.error || 'claim_failed');
                setState('error_recoverable');
              }
            },
            onError: (err) => {
              if (!mounted) return;
              setErrorCode(err);
              setState('error_recoverable');
            },
          });

          bridgeListenerRef.current = bridgeSession;
        } else {
          // Entrada directa o sin opener: solo mostrar código manual si está habilitado
          if (domainMigrationBridgeService.isManualFallbackEnabled()) {
            setState('awaiting_manual_code');
          } else {
            setState('lost_access_help');
          }
        }
      } catch (err: any) {
        if (!mounted) return;
        setErrorCode(err?.message || 'init_failed');
        setState('error_recoverable');
      }
    };

    void init();

    return () => {
      mounted = false;
      bridgeListenerRef.current?.cleanup();
    };
  }, [searchParams]);

  // Canje manual
  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanToken = manualCodeInput.trim().replace(/[\s-]+/g, '');
    if (!cleanToken) return;

    setIsSubmittingManual(true);
    setErrorCode(null);

    try {
      // Asegurar sesión destino
      await domainMigrationBridgeService.ensureTargetUser();
      const res = await domainMigrationBridgeService.claimMigrationTicket(cleanToken);

      if (res.ok) {
        setManualCodeInput('');
        setState('completed');
      } else {
        setErrorCode(res.error || 'claim_failed');
        setState('error_recoverable');
      }
    } catch (err: any) {
      setErrorCode(err?.message || 'claim_failed');
      setState('error_recoverable');
    } finally {
      setIsSubmittingManual(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);
    try {
      await signInWithGoogle();
    } catch {
      setIsGoogleLoading(false);
    }
  };

  return (
    <ScreenContainer>
      <AppBar title="Recuperar Encuentros" showBack={false} />

      <main style={{ padding: '1.25rem', maxWidth: '500px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        {/* ESTADO 1: INITIALIZING */}
        {state === 'initializing' && (
          <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
            <RefreshCw
              size={36}
              className="spin"
              style={{ color: '#0ea5e9', marginBottom: '1.25rem', animation: 'spin 1s linear infinite' }}
            />
            <p style={{ color: '#64748b', fontSize: '1rem', margin: 0 }}>
              Preparando tu nuevo espacio seguro…
            </p>
          </div>
        )}

        {/* ESTADO 2: RECEIVING AUTO */}
        {state === 'receiving_auto' && (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem' }}>
            <div
              style={{
                width: '64px',
                height: '64px',
                borderRadius: '50%',
                background: '#e0f2fe',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#0284c7',
              }}
            >
              <RefreshCw size={32} className="spin" style={{ animation: 'spin 1.2s linear infinite' }} />
            </div>

            <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: 0 }}>
              Trayendo tus encuentros a {brand.brandName}…
            </h2>

            <p style={{ color: '#475569', fontSize: '0.95rem', lineHeight: '1.5', margin: 0, maxWidth: '380px' }}>
              Estamos transfiriendo tus encuentros organizados e invitaciones de forma segura. En unos segundos estarán listos.
            </p>
          </div>
        )}

        {/* ESTADO 3: AWAITING MANUAL CODE */}
        {state === 'awaiting_manual_code' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingTop: '0.5rem' }}>
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: '60px',
                  height: '60px',
                  borderRadius: '50%',
                  background: '#f1f5f9',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 0.75rem auto',
                  color: '#475569',
                }}
              >
                <Key size={30} />
              </div>
              <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '0 0 0.4rem 0' }}>
                Traer mis encuentros anteriores
              </h2>
              <p style={{ color: '#475569', fontSize: '0.95rem', lineHeight: '1.45', margin: 0 }}>
                Si copiaste una llave temporal desde nuestro sitio anterior, pegala acá para completar el traslado.
              </p>
            </div>

            <form onSubmit={handleManualSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <Input
                label="Llave temporal"
                type="password"
                autoComplete="one-time-code"
                spellCheck={false}
                placeholder="Pegá acá la llave de traslado"
                value={manualCodeInput}
                onChange={(e) => setManualCodeInput(e.target.value)}
                autoFocus
              />

              <Button
                variant="primary"
                type="submit"
                fullWidth
                disabled={!manualCodeInput.trim() || isSubmittingManual}
                style={{ padding: '0.85rem' }}
              >
                {isSubmittingManual ? 'Verificando llave…' : 'Recuperar mis encuentros'}
              </Button>
            </form>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0.25rem 0' }}>
              <div style={{ flex: 1, height: '1px', background: '#e2e8f0' }} />
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', textTransform: 'uppercase' }}>o también</span>
              <div style={{ flex: 1, height: '1px', background: '#e2e8f0' }} />
            </div>

            <Button
              variant="outline"
              fullWidth
              disabled={isGoogleLoading}
              onClick={handleGoogleSignIn}
            >
              {isGoogleLoading ? 'Iniciando…' : 'Continuar con Google'}
            </Button>

            <div style={{ textAlign: 'center', marginTop: '0.5rem' }}>
              <button
                type="button"
                onClick={() => setState('lost_access_help')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#0284c7',
                  fontSize: '0.9rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.25rem',
                }}
              >
                <HelpCircle size={16} /> ¿Perdiste acceso al navegador anterior?
              </button>
            </div>

            <Button variant="ghost" fullWidth onClick={() => navigate('/')}>
              Ir al inicio
            </Button>
          </div>
        )}

        {/* ESTADO 4: COMPLETED */}
        {state === 'completed' && (
          <div style={{ textAlign: 'center', padding: '2.5rem 1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem' }}>
            <div
              style={{
                width: '68px',
                height: '68px',
                borderRadius: '50%',
                background: '#ecfdf5',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#059669',
              }}
            >
              <CheckCircle2 size={40} />
            </div>

            <h2 style={{ fontSize: '1.4rem', fontWeight: 700, margin: 0 }}>
              ¡Tus encuentros ya están acá!
            </h2>

            <p style={{ color: '#475569', fontSize: '1rem', lineHeight: '1.5', margin: 0, maxWidth: '400px' }}>
              Tus encuentros activos e invitaciones válidas ya están listos. Si alguna invitación anterior quedó sin trasladar, podés volver a acceder abriendo su enlace original.
            </p>

            <Button
              variant="primary"
              fullWidth
              onClick={() => navigate('/')}
              style={{ marginTop: '0.75rem', padding: '0.85rem', fontSize: '1rem' }}
            >
              Ver mis encuentros <ArrowRight size={18} style={{ marginLeft: 6 }} />
            </Button>
          </div>
        )}

        {/* ESTADO 5: LOST ACCESS HELP (Recorrido 5) */}
        {state === 'lost_access_help' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingTop: '0.5rem' }}>
            <div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>
                ¿Cómo recuperar tus encuentros?
              </h2>
              <p style={{ color: '#475569', fontSize: '0.92rem', lineHeight: '1.45', margin: 0 }}>
                Elegí la situación que mejor describa tu caso:
              </p>
            </div>

            {/* Situación 1: Google */}
            <div
              style={{
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '12px',
                padding: '1rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}
            >
              <span style={{ fontWeight: 600, color: '#0f172a', fontSize: '0.95rem' }}>
                1. «Antes entraba con Google»
              </span>
              <p style={{ fontSize: '0.88rem', color: '#475569', margin: 0, lineHeight: '1.4' }}>
                Tus encuentros ya están a salvo en tu cuenta. Solo tenés que volver a ingresar.
              </p>
              <Button
                variant="primary"
                size="sm"
                onClick={handleGoogleSignIn}
                style={{ alignSelf: 'flex-start', marginTop: '0.25rem' }}
              >
                Continuar con Google
              </Button>
            </div>

            {/* Situación 2: Invitado */}
            <div
              style={{
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '12px',
                padding: '1rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}
            >
              <span style={{ fontWeight: 600, color: '#0f172a', fontSize: '0.95rem' }}>
                2. «Era invitado en un encuentro»
              </span>
              <p style={{ fontSize: '0.88rem', color: '#475569', margin: 0, lineHeight: '1.4' }}>
                Abrí de nuevo el link de invitación que te pasaron por WhatsApp: funciona automáticamente en nuestra nueva dirección y volverá a guardarse acá.
              </p>
            </div>

            {/* Situación 3: Organizador anónimo que perdió el dispositivo */}
            <div
              style={{
                background: '#fef2f2',
                border: '1px solid #fee2e2',
                borderRadius: '12px',
                padding: '1rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}
            >
              <span style={{ fontWeight: 600, color: '#991b1b', fontSize: '0.95rem' }}>
                3. «Organicé un encuentro sin cuenta y perdí aquel celular o navegador»
              </span>
              <p style={{ fontSize: '0.88rem', color: '#7f1d1d', margin: 0, lineHeight: '1.4' }}>
                Al no haber vinculado una cuenta previa, por seguridad no es posible recuperar el panel de anfitrión desde otro dispositivo. Sin embargo, <strong>si tus invitados ya recibieron el link, el encuentro sigue funcionando normalmente para ellos</strong>.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate('/create')}
                style={{ alignSelf: 'flex-start', marginTop: '0.25rem', borderColor: '#fca5a5', color: '#991b1b' }}
              >
                Crear un nuevo encuentro
              </Button>
            </div>

            <Button
              variant="ghost"
              fullWidth
              onClick={() => {
                if (domainMigrationBridgeService.isManualFallbackEnabled()) {
                  setState('awaiting_manual_code');
                } else {
                  navigate('/');
                }
              }}
            >
              {domainMigrationBridgeService.isManualFallbackEnabled() ? 'Volver' : 'Ir al inicio'}
            </Button>
          </div>
        )}

        {/* ESTADO 6: ERROR RECUPERABLE */}
        {state === 'error_recoverable' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingTop: '1rem' }}>
            <EmptyState
              icon={<AlertCircle size={44} style={{ color: '#e11d48' }} />}
              title="No pudimos completar el traslado"
              description={getMigrationUserMessage(errorCode || 'unknown')}
              actions={
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%', marginTop: '1rem' }}>
                  <Button
                    variant="primary"
                    fullWidth
                    onClick={() => {
                      setErrorCode(null);
                      if (domainMigrationBridgeService.isManualFallbackEnabled()) {
                        setState('awaiting_manual_code');
                      } else {
                        navigate('/');
                      }
                    }}
                  >
                    Volver a intentar
                  </Button>
                  <Button variant="ghost" fullWidth onClick={() => navigate('/')}>
                    Ir al inicio
                  </Button>
                </div>
              }
            />
          </div>
        )}
      </main>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </ScreenContainer>
  );
};

export default DomainBridgeReceiveScreen;
