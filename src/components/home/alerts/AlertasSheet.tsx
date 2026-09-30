import React, { useEffect, useRef, useState, useMemo } from 'react';
import { X, Bell, Calendar, MapPin, AlertCircle, RefreshCw } from 'lucide-react';
import type {
  AlertaCompatibilidad,
  AlertaCompatibilidadEncuentroPublico,
  UseAlertasReturn,
} from '@/types/alertas';
import { useAlertas } from '@/hooks/useAlertas';
import { formatFriendlyDate } from '@/lib/formatDate';
import '@/components/ui/BottomSheet.css';
import './AlertasSheet.css';

export interface AlertasSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectEncuentro?: (encuentro: AlertaCompatibilidadEncuentroPublico) => void;
  alertasHook?: UseAlertasReturn;
}

export const AlertasSheet: React.FC<AlertasSheetProps> = ({
  isOpen,
  onClose,
  onSelectEncuentro,
  alertasHook: injectedHook,
}) => {
  // Usar hook inyectado (para tests) o instancia propia del hook
  const defaultHook = useAlertas();
  const hook = injectedHook || defaultHook;
  const { alertas, loading, error, refresh, marcarLeida } = hook;

  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [markingIds, setMarkingIds] = useState<Set<string>>(new Set());
  const [unavailableIds, setUnavailableIds] = useState<Set<string>>(new Set());

  // Escape key listener & focus management
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    const timer = setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 50);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
    };
  }, [isOpen, onClose]);

  // Alertas ordenadas descendentemente por fecha de creación (más reciente primero)
  const sortedAlertas = useMemo(() => {
    return [...alertas].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }, [alertas]);

  if (!isOpen) return null;

  const handleMarcarLeida = async (alertaId: string) => {
    if (markingIds.has(alertaId)) return;
    setMarkingIds((prev) => new Set(prev).add(alertaId));
    try {
      await marcarLeida(alertaId);
    } finally {
      setMarkingIds((prev) => {
        const next = new Set(prev);
        next.delete(alertaId);
        return next;
      });
    }
  };

  const handleVerEncuentro = async (alerta: AlertaCompatibilidad) => {
    // 1. Marcar como leída de forma no bloqueante
    if (!alerta.leida) {
      handleMarcarLeida(alerta.id).catch(() => {});
    }

    // 2. Comprobar disponibilidad del encuentro sin public_token
    const encounter = alerta.encuentro;
    if (!encounter || encounter.is_open === false) {
      setUnavailableIds((prev) => new Set(prev).add(alerta.id));
      return;
    }

    // 3. Abrir detalle de Encuentro Abierto seguro
    onSelectEncuentro?.(encounter);
    onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="pe-sheet-overlay"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Container */}
      <div
        className="pe-sheet-container pe-alerts-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Alertas"
      >
        {/* Drag handle */}
        <div className="pe-sheet-handle" aria-hidden="true" />

        {/* Header */}
        <div className="pe-sheet-header">
          <h2 className="pe-sheet-title">Alertas</h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="pe-sheet-close-btn"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Estado: Cargando */}
        {loading && sortedAlertas.length === 0 && (
          <div className="pe-alerts-loading" role="status" aria-live="polite">
            <div className="pe-alerts-spinner" aria-hidden="true" />
            <span>Cargando alertas...</span>
          </div>
        )}

        {/* Estado: Error */}
        {!loading && error && (
          <div className="pe-alerts-error" role="alert">
            <AlertCircle size={20} className="pe-alerts-error-icon" />
            <p className="pe-alerts-error-text">
              {error || 'No pudimos cargar tus alertas.'}
            </p>
            <button
              type="button"
              className="pe-alerts-retry-btn"
              onClick={() => refresh()}
            >
              <RefreshCw size={15} /> Reintentar
            </button>
          </div>
        )}

        {/* Estado: Vacío */}
        {!loading && !error && sortedAlertas.length === 0 && (
          <div className="pe-alerts-empty">
            <div className="pe-alerts-empty-icon" aria-hidden="true">
              <Bell size={28} />
            </div>
            <h3 className="pe-alerts-empty-title">No tenés alertas nuevas.</h3>
            <p className="pe-alerts-empty-desc">
              Te avisaremos cuando haya novedades sobre tus intenciones o encuentros.
            </p>
          </div>
        )}

        {/* Listado de Alertas */}
        {sortedAlertas.length > 0 && (
          <div className="pe-alerts-list">
            {sortedAlertas.map((alerta) => {
              const enc = alerta.encuentro;
              const isUnread = !alerta.leida;
              const isMarking = markingIds.has(alerta.id);
              const isUnavailable =
                unavailableIds.has(alerta.id) || (enc && enc.is_open === false);

              const encounterTitle =
                alerta.encuentro_titulo || enc?.titulo || 'Encuentro';
              const formattedDate =
                enc?.fecha
                  ? formatFriendlyDate(enc.fecha, enc.hora || null)
                  : alerta.encuentro_fecha
                  ? formatFriendlyDate(alerta.encuentro_fecha, alerta.encuentro_hora || null)
                  : null;
              const zone = enc?.approximate_zone || alerta.encuentro_approximate_zone;
              const modality = enc?.modalidad || alerta.encuentro_modalidad;

              return (
                <article
                  key={alerta.id}
                  className={`pe-alert-card ${
                    isUnread ? 'pe-alert-card--unread' : 'pe-alert-card--read'
                  }`}
                  data-alert-id={alerta.id}
                  data-read={alerta.leida}
                >
                  <div className="pe-alert-card__top">
                    {isUnread ? (
                      <span className="pe-alert-card__status-badge pe-alert-card__status-badge--unread">
                        <span className="pe-alert-dot" aria-hidden="true" />
                        Nueva
                      </span>
                    ) : (
                      <span className="pe-alert-card__status-badge pe-alert-card__status-badge--read">
                        Leída
                      </span>
                    )}
                  </div>

                  {alerta.tipo === 'interes_convertido' && (
                    <p className="pe-alert-card__copy">
                      Una idea que te interesaba ahora tiene encuentro.
                    </p>
                  )}

                  <h3 className="pe-alert-card__title">{encounterTitle}</h3>

                  {(formattedDate || zone || modality) && (
                    <div className="pe-alert-card__meta">
                      {formattedDate && (
                        <span className="pe-alert-card__meta-item">
                          <Calendar size={13} aria-hidden="true" /> {formattedDate}
                        </span>
                      )}
                      {zone && (
                        <span className="pe-alert-card__meta-item">
                          <MapPin size={13} aria-hidden="true" /> {zone}
                        </span>
                      )}
                      {modality && (
                        <span className="pe-alert-card__meta-item">
                          {modality === 'presencial' ? '🤝 Presencial' : '💻 Virtual'}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Estado defensivo si el encuentro ya no está disponible */}
                  {isUnavailable && (
                    <div className="pe-alert-card__unavailable" role="alert">
                      <AlertCircle size={15} aria-hidden="true" />
                      <span>Este encuentro ya no está disponible.</span>
                    </div>
                  )}

                  {/* Acciones */}
                  <div className="pe-alert-card__actions">
                    <button
                      type="button"
                      className="pe-alert-card__btn pe-alert-card__btn--primary"
                      onClick={() => handleVerEncuentro(alerta)}
                    >
                      Ver encuentro
                    </button>

                    {isUnread ? (
                      <button
                        type="button"
                        className="pe-alert-card__btn pe-alert-card__btn--secondary"
                        onClick={() => handleMarcarLeida(alerta.id)}
                        disabled={isMarking}
                      >
                        {isMarking ? 'Marcando...' : 'Marcar como leída'}
                      </button>
                    ) : (
                      <span className="pe-alert-card__read-label">Leída</span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
};
