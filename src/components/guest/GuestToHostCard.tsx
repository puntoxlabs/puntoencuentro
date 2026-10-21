import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ensureHostSession } from '@/lib/ensureHostSession';
import './GuestToHostCard.css';

export interface GuestToHostCardProps {
  className?: string;
  style?: React.CSSProperties;
}

export const GuestToHostCard: React.FC<GuestToHostCardProps> = ({
  className = '',
  style,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    if (loading) return;
    setLoading(true);

    try {
      // Iniciar o asegurar sesión de anfitrión anónimo sin exigir Google obligatorio
      await ensureHostSession();

      // Telemetría no intrusiva
      import('@/services/qaTelemetryService').then(({ qaTelemetryService }) => {
        qaTelemetryService.trackEvent({
          event_type: 'session_started',
          source: 'ui_manual',
          creation_source: 'manual',
          initial_route: '/create',
          status: 'started',
        });
      }).catch(() => {});

      // Navegar a la creación manual privada. Flujo limpio e independiente.
      navigate('/create', { state: { autoFocusTitle: true } });
    } catch (err) {
      console.error('[GuestToHostCard] Error asegurando sesión:', err);
      // Fallback directo si falla la sesión remota para permitir flujo local
      navigate('/create', { state: { autoFocusTitle: true } });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`guest-to-host-card ${className}`} style={style}>
      <div className="guest-to-host-content">
        <div className="guest-to-host-icon">
          <CalendarPlus size={20} />
        </div>
        <div className="guest-to-host-text">
          <h3 className="guest-to-host-title">
            {t('guest_convert.prompt', '¿Querés organizar algo parecido?')}
          </h3>
          <p className="guest-to-host-subtitle">
            {t(
              'guest_convert.subtitle',
              'Organizá tu propio encuentro privado en minutos, gratis y sin vueltas.'
            )}
          </p>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={handleCreate}
        disabled={loading}
        className="guest-to-host-btn"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          justifyContent: 'center',
        }}
      >
        <span>{t('guest_convert.action', 'Crear mi encuentro')}</span>
        <ArrowRight size={15} />
      </Button>
    </div>
  );
};
