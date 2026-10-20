import React, { useState } from 'react';
import { AlertTriangle, AlertCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import './TransferClaimBanner.css';

export const TransferClaimBanner: React.FC = () => {
  const { transferClaimStatus, transferClaimError, retryTransferClaim } = useAuth();
  const [isRetrying, setIsRetrying] = useState(false);
  const [dismissedTerminal, setDismissedTerminal] = useState(false);

  if (transferClaimStatus === 'idle' || transferClaimStatus === 'success' || transferClaimStatus === 'claiming') {
    return null;
  }

  if (transferClaimStatus === 'error_terminal' && dismissedTerminal) {
    return null;
  }

  const handleRetry = async () => {
    if (isRetrying) return;
    setIsRetrying(true);
    try {
      await retryTransferClaim();
    } finally {
      setIsRetrying(false);
    }
  };

  if (transferClaimStatus === 'error_transient') {
    return (
      <div className="pe-transfer-banner pe-transfer-banner--transient" role="alert">
        <div className="pe-transfer-banner__header">
          <AlertTriangle size={20} className="pe-transfer-banner__icon" aria-hidden="true" />
          <div className="pe-transfer-banner__body">
            <h4 className="pe-transfer-banner__title">Problema al vincular tus encuentros</h4>
            <p className="pe-transfer-banner__desc">
              Tus encuentros no se perdieron. La vinculación con tu cuenta de Google no se pudo completar por un error de conexión.
            </p>
          </div>
        </div>
        <div className="pe-transfer-banner__actions">
          <button
            type="button"
            className="pe-transfer-banner__btn pe-transfer-banner__btn--primary"
            onClick={handleRetry}
            disabled={isRetrying}
          >
            {isRetrying ? 'Reintentando...' : 'Reintentar vinculación'}
          </button>
        </div>
      </div>
    );
  }

  if (transferClaimStatus === 'error_terminal') {
    const isExpired = transferClaimError === 'ticket_expired';
    return (
      <div className="pe-transfer-banner pe-transfer-banner--terminal" role="alert">
        <div className="pe-transfer-banner__header">
          <AlertCircle size={20} className="pe-transfer-banner__icon" aria-hidden="true" />
          <div className="pe-transfer-banner__body">
            <h4 className="pe-transfer-banner__title">
              {isExpired ? 'El enlace de transferencia expiró' : 'No se pudo completar la transferencia'}
            </h4>
            <p className="pe-transfer-banner__desc">
              {isExpired
                ? 'Por seguridad, los tickets de transferencia expiran a los 15 minutos. Si aún tenés la sesión previa en este dispositivo, tus encuentros siguen disponibles allí.'
                : 'El enlace de transferencia ya fue utilizado o no es válido.'}
            </p>
          </div>
        </div>
        <div className="pe-transfer-banner__actions">
          <button
            type="button"
            className="pe-transfer-banner__btn pe-transfer-banner__btn--outline"
            onClick={() => setDismissedTerminal(true)}
          >
            Entendido
          </button>
        </div>
      </div>
    );
  }

  return null;
};
