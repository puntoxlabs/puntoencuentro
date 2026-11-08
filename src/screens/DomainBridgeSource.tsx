import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheck,
  ArrowRight,
  RefreshCw,
  Copy,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Clock,
  Sparkles,
  Lock,
} from 'lucide-react';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuth } from '@/contexts/AuthContext';
import {
  domainMigrationBridgeService,
  type BridgeSourceState,
  type MigrationInventory,
  getMigrationUserMessage,
} from '@/services/domainMigrationBridgeService';
import {
  getBrandConfig,
  getTargetMigrationOrigin,
} from '@/config/domainConfig';
import { ENABLE_DOMAIN_MIGRATION_BRIDGE } from '@/config/features';

export const DomainBridgeSourceScreen: React.FC = () => {
  const navigate = useNavigate();
  const { signInWithGoogle } = useAuth();
  const brand = getBrandConfig();
  const targetOrigin = getTargetMigrationOrigin();
  const targetHost = (() => {
    try {
      return new URL(targetOrigin).host;
    } catch {
      return targetOrigin;
    }
  })();

  const [state, setState] = useState<BridgeSourceState>('detecting_inventory');
  const [inventory, setInventory] = useState<MigrationInventory | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [manualToken, setManualToken] = useState<string | null>(null);
  const [manualExpiresAt, setManualExpiresAt] = useState<string | null>(null);
  const [countdownSeconds, setCountdownSeconds] = useState<number>(180);
  const [copied, setCopied] = useState<boolean>(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState<boolean>(false);

  const bridgeSessionRef = useRef<{ cancel: () => void } | null>(null);

  // Redirigir a Home si el feature flag está desactivado
  useEffect(() => {
    if (!ENABLE_DOMAIN_MIGRATION_BRIDGE) {
      navigate('/', { replace: true });
    }
  }, [navigate]);

  // Carga inicial e inspección de inventario
  const loadInventory = async () => {
    setState('detecting_inventory');
    setErrorCode(null);
    try {
      const res = await domainMigrationBridgeService.detectInventory();
      setInventory(res.inventory);
      setState(res.state);
    } catch (err: any) {
      setErrorCode(err?.message || 'inventory_failed');
      setState('error_recoverable');
    }
  };

  useEffect(() => {
    if (ENABLE_DOMAIN_MIGRATION_BRIDGE) {
      void loadInventory();
    }
    return () => {
      bridgeSessionRef.current?.cancel();
    };
  }, []);

  // Cuenta regresiva del modo manual (3 minutos)
  useEffect(() => {
    if (state !== 'manual_code_fallback' || !manualExpiresAt) return;

    const calculateRemaining = () => {
      const expireTime = new Date(manualExpiresAt).getTime();
      const now = Date.now();
      const diff = Math.max(0, Math.floor((expireTime - now) / 1000));
      return diff;
    };

    setCountdownSeconds(calculateRemaining());

    const interval = setInterval(() => {
      const remaining = calculateRemaining();
      setCountdownSeconds(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        setErrorCode('ticket_expired');
        setState('error_recoverable');
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [state, manualExpiresAt]);

  // Iniciar traslado manual si el fallback está activado
  const handleManualFallbackSwitch = async () => {
    setState('manual_code_fallback');
    const res = await domainMigrationBridgeService.createManualMigrationTicket();
    if (res.ok && res.ticket_token && res.expires_at) {
      setManualToken(res.ticket_token);
      setManualExpiresAt(res.expires_at);
    } else {
      setErrorCode(res.error || 'manual_ticket_failed');
      setState('error_recoverable');
    }
  };

  // Iniciar traslado automático
  const handleStartAutoTransfer = () => {
    setErrorCode(null);
    setState('awaiting_handshake');

    // Apertura sincrónica del popup dentro del gesto del usuario para evitar bloqueos en iOS Safari y Android Chrome
    const sourceOrigin = typeof window !== 'undefined' ? window.location.origin : '';
    const targetUrl = `${targetOrigin}/migrate-receive?mode=popup${sourceOrigin ? `&source_origin=${encodeURIComponent(sourceOrigin)}` : ''}`;
    let popupWindow: Window | null = null;
    try {
      popupWindow = window.open(targetUrl, 'puntoencuentro_bridge_popup');
    } catch {
      popupWindow = null;
    }

    if (!popupWindow) {
      if (domainMigrationBridgeService.isManualFallbackEnabled()) {
        void handleManualFallbackSwitch();
      } else {
        setErrorCode('popup_blocked');
        setState('error_recoverable');
      }
      return;
    }

    bridgeSessionRef.current = domainMigrationBridgeService.startBridgeHandshake({
      popupWindow,
      targetOrigin,
      onStateChange: (newState) => setState(newState),
      onError: (errCode) => {
        setErrorCode(errCode);
        setState('error_recoverable');
      },
      onManualFallbackReady: (token, expiresAt) => {
        setManualToken(token);
        setManualExpiresAt(expiresAt);
        setState('manual_code_fallback');
      },
    });
  };

  // Cancelar traslado en curso
  const handleCancelTransfer = async () => {
    bridgeSessionRef.current?.cancel();
    bridgeSessionRef.current = null;
    await domainMigrationBridgeService.cancelPendingMigration();
    setState('ready_to_migrate');
  };

  // Respaldar con Google
  const handleGoogleUpgrade = async () => {
    setIsGoogleLoading(true);
    try {
      await signInWithGoogle();
    } catch {
      setIsGoogleLoading(false);
    }
  };

  // Copiar llave manual
  const handleCopyManualToken = async () => {
    if (!manualToken) return;
    try {
      await navigator.clipboard.writeText(manualToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
      // Abrir Dominio B en nueva pestaña
      window.open(`${targetOrigin}/migrate-receive`, '_blank');
    } catch {
      // fallback
    }
  };

  // Formato MM:SS
  const formatTime = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <ScreenContainer>
      <AppBar title="Traslado de Encuentros" showBack={false} />

      <main style={{ padding: '1.25rem', maxWidth: '520px', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        {/* ESTADO 1: DETECTING INVENTORY */}
        {state === 'detecting_inventory' && (
          <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
            <RefreshCw
              size={40}
              className="spin"
              style={{ color: '#0ea5e9', marginBottom: '1.5rem', animation: 'spin 1s linear infinite' }}
            />
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: '0 0 0.5rem 0' }}>
              Revisando tus encuentros guardados…
            </h2>
            <p style={{ color: '#64748b', fontSize: '0.95rem', margin: 0 }}>
              Buscando encuentros e invitaciones en este navegador.
            </p>
          </div>
        )}

        {/* ESTADO 2: GOOGLE READY */}
        {state === 'google_ready' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingTop: '1rem' }}>
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '50%',
                  background: '#e0f2fe',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 1rem auto',
                  color: '#0284c7',
                }}
              >
                <ShieldCheck size={36} />
              </div>
              <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>
                Tus encuentros ya están a salvo
              </h2>
              <p style={{ color: '#475569', fontSize: '1rem', lineHeight: '1.5', margin: 0 }}>
                Como iniciaste sesión con Google, todos tus encuentros, invitaciones y mensajes ya están respaldados permanentemente.
              </p>
            </div>

            <div
              style={{
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '12px',
                padding: '1rem',
                fontSize: '0.9rem',
                color: '#334155',
              }}
            >
              Para continuar, solo tenés que ingresar en nuestra nueva dirección con la misma cuenta de Google.
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
              <Button
                variant="primary"
                fullWidth
                onClick={() => {
                  window.location.href = targetOrigin;
                }}
              >
                Ir a {brand.brandName} e ingresar con Google <ExternalLink size={18} style={{ marginLeft: 6 }} />
              </Button>
              <Button variant="ghost" fullWidth onClick={() => navigate('/')}>
                Seguir acá por ahora
              </Button>
            </div>
          </div>
        )}

        {/* ESTADO 3: EMPTY CLEAN */}
        {state === 'empty_clean' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingTop: '1rem' }}>
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '50%',
                  background: '#f1f5f9',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 1rem auto',
                  color: '#64748b',
                }}
              >
                <Sparkles size={32} />
              </div>
              <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>
                Nos mudamos a una nueva dirección
              </h2>
              <p style={{ color: '#475569', fontSize: '1rem', lineHeight: '1.5', margin: 0 }}>
                Cambiamos de dirección a <strong>{targetHost}</strong>. No encontramos encuentros guardados en este navegador, por lo que podés empezar directamente en el nuevo sitio.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
              <Button
                variant="primary"
                fullWidth
                onClick={() => {
                  window.location.href = targetOrigin;
                }}
              >
                Abrir {brand.brandName} <ExternalLink size={18} style={{ marginLeft: 6 }} />
              </Button>
              <Button variant="ghost" fullWidth onClick={() => navigate('/')}>
                Volver al inicio
              </Button>
            </div>
          </div>
        )}

        {/* ESTADO 4: READY TO MIGRATE */}
        {state === 'ready_to_migrate' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingTop: '0.5rem' }}>
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '50%',
                  background: '#ecfdf5',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 1rem auto',
                  color: '#059669',
                }}
              >
                <CheckCircle2 size={36} />
              </div>
              <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>
                Encontramos tus encuentros en este navegador
              </h2>
              <p style={{ color: '#475569', fontSize: '0.98rem', lineHeight: '1.5', margin: 0 }}>
                Llevátelos a nuestra nueva dirección web en un solo paso, con todos tus participantes, respuestas y mensajes intactos.
              </p>
            </div>

            {/* Resumen del inventario */}
            <div
              style={{
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: '12px',
                padding: '1.1rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.6rem',
              }}
            >
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#64748b', textTransform: 'uppercase' }}>
                Lo que se va a trasladar:
              </span>
              <ul style={{ margin: 0, paddingLeft: '1.25rem', color: '#1e293b', fontSize: '0.95rem', lineHeight: '1.6' }}>
                {inventory?.hasOwnedEncounters && (
                  <li>Tus encuentros organizados y sus paneles de administración</li>
                )}
                {Boolean(inventory?.localTokensCount && inventory.localTokensCount > 0) && (
                  <li>
                    {inventory?.localTokensCount === 1
                      ? '1 invitación respondida guardada'
                      : `${inventory?.localTokensCount} invitaciones respondidas guardadas`}
                  </li>
                )}
                {inventory?.hasMessages && <li>Tus mensajes y avisos publicados</li>}
                {inventory?.hasCustomTemplates && <li>Tus diseños de invitación personalizados</li>}
              </ul>
            </div>

            {/* Acciones */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', marginTop: '0.25rem' }}>
              <Button
                variant="primary"
                fullWidth
                onClick={handleStartAutoTransfer}
                style={{ padding: '0.85rem 1rem', fontSize: '1rem' }}
              >
                Llevar mis encuentros ahora (sin crear cuenta) <ArrowRight size={18} style={{ marginLeft: 6 }} />
              </Button>

              <Button
                variant="outline"
                fullWidth
                disabled={isGoogleLoading}
                onClick={handleGoogleUpgrade}
                style={{ padding: '0.75rem 1rem' }}
              >
                {isGoogleLoading ? 'Conectando con Google…' : 'Guardar con Google para no perderlos nunca'}
              </Button>

              <Button variant="ghost" fullWidth onClick={() => navigate('/')}>
                Seguir acá por ahora
              </Button>
            </div>

            <p style={{ textAlign: 'center', fontSize: '0.8rem', color: '#94a3b8', margin: 0 }}>
              Cerrar o dudar no borra nada. Tus encuentros permanecen seguros en este dispositivo.
            </p>
          </div>
        )}

        {/* ESTADO 5: AWAITING HANDSHAKE */}
        {state === 'awaiting_handshake' && (
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

            <h2 style={{ fontSize: '1.3rem', fontWeight: 700, margin: 0 }}>
              Conectando con el nuevo sitio…
            </h2>

            <p style={{ color: '#475569', fontSize: '0.95rem', lineHeight: '1.5', margin: 0, maxWidth: '380px' }}>
              Se abrió una nueva pestaña en <strong>{targetHost}</strong> para recibir tus encuentros. No cierres esta ventana todavía.
            </p>

            <Button
              variant="outline"
              onClick={handleCancelTransfer}
              style={{ marginTop: '1rem', color: '#64748b', borderColor: '#cbd5e1' }}
            >
              Cancelar traslado
            </Button>
          </div>
        )}

        {/* ESTADO 6: MANUAL CODE FALLBACK */}
        {state === 'manual_code_fallback' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', paddingTop: '0.5rem' }}>
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: '56px',
                  height: '56px',
                  borderRadius: '50%',
                  background: '#fef3c7',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 0.75rem auto',
                  color: '#d97706',
                }}
              >
                <Lock size={28} />
              </div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.35rem 0' }}>
                Llave temporal de traslado
              </h2>
              <p style={{ color: '#475569', fontSize: '0.92rem', lineHeight: '1.4', margin: 0 }}>
                Copiá esta llave y pegala en el nuevo sitio. Por seguridad, no la compartas por chat ni en redes.
              </p>
            </div>

            {/* Temporizador */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                color: countdownSeconds < 60 ? '#dc2626' : '#64748b',
                fontWeight: 600,
                fontSize: '0.95rem',
              }}
            >
              <Clock size={18} /> Vence en {formatTime(countdownSeconds)}
            </div>

            {/* Caja de código */}
            <div
              style={{
                background: '#f8fafc',
                border: '1px dashed #cbd5e1',
                borderRadius: '10px',
                padding: '0.85rem',
                fontFamily: 'monospace',
                fontSize: '0.82rem',
                color: '#1e293b',
                wordBreak: 'break-all',
                textAlign: 'center',
                letterSpacing: '0.05em',
                userSelect: 'all',
              }}
            >
              {manualToken || 'Generando llave…'}
            </div>

            <Button
              variant="primary"
              fullWidth
              onClick={handleCopyManualToken}
              style={{ padding: '0.85rem' }}
            >
              {copied ? (
                <>
                  <CheckCircle2 size={18} style={{ marginRight: 6 }} /> ¡Copiado! Abriendo nuevo sitio…
                </>
              ) : (
                <>
                  <Copy size={18} style={{ marginRight: 6 }} /> Copiar llave y abrir nuevo sitio
                </>
              )}
            </Button>

            <Button variant="ghost" fullWidth onClick={handleCancelTransfer}>
              Cancelar llave
            </Button>
          </div>
        )}

        {/* ESTADO 7: ALREADY MIGRATED */}
        {state === 'already_migrated' && (
          <div style={{ textAlign: 'center', padding: '2rem 1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem' }}>
            <div
              style={{
                width: '64px',
                height: '64px',
                borderRadius: '50%',
                background: '#ecfdf5',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#059669',
              }}
            >
              <CheckCircle2 size={36} />
            </div>

            <h2 style={{ fontSize: '1.35rem', fontWeight: 700, margin: 0 }}>
              ¡Tus encuentros ya están en {targetHost}!
            </h2>

            <p style={{ color: '#475569', fontSize: '0.98rem', lineHeight: '1.5', margin: 0, maxWidth: '420px' }}>
              Este navegador anterior quedó cerrado para crear encuentros nuevos. Para seguir administrando tus encuentros o sumarte a otros, continuá directamente en nuestra nueva dirección.
            </p>

            <Button
              variant="primary"
              fullWidth
              onClick={() => {
                window.location.href = targetOrigin;
              }}
              style={{ marginTop: '0.5rem', padding: '0.85rem' }}
            >
              Ir a mis encuentros en {brand.brandName} <ExternalLink size={18} style={{ marginLeft: 6 }} />
            </Button>
          </div>
        )}

        {/* ESTADO 8: ERROR RECUPERABLE */}
        {state === 'error_recoverable' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingTop: '1rem' }}>
            <EmptyState
              icon={<AlertCircle size={44} style={{ color: '#e11d48' }} />}
              title="No pudimos completar el paso"
              description={getMigrationUserMessage(errorCode || 'unknown')}
              actions={
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%', marginTop: '1rem' }}>
                  <Button variant="primary" fullWidth onClick={loadInventory}>
                    Volver a intentar
                  </Button>
                  <Button variant="ghost" fullWidth onClick={() => navigate('/')}>
                    Volver al inicio
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

export default DomainBridgeSourceScreen;
