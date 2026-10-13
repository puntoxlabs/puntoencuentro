import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { openEncountersService } from '@/services/openEncountersService';
import type { MiSolicitudItem } from '@/components/home/openEncounters/types';
import { supabase } from '@/lib/supabase';
import { formatFriendlyDate } from '@/lib/formatDate';
import {
  Calendar,
  Clock,
  MapPin,
  Users,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Inbox,
  ArrowRight,
} from 'lucide-react';
import './HomeSolicitudesSection.css';

export interface HomeSolicitudesSectionProps {
  onSelectEncuentro: (encuentroId: string) => void;
  initialLoading?: boolean;
}

export const HomeSolicitudesSection: React.FC<HomeSolicitudesSectionProps> = ({
  onSelectEncuentro,
  initialLoading = true,
}) => {
  const { t } = useTranslation();
  const { user, isPermanentUser } = useAuth();
  const [solicitudes, setSolicitudes] = useState<MiSolicitudItem[]>([]);
  const [loading, setLoading] = useState(initialLoading);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [isPastExpanded, setIsPastExpanded] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!user || !isPermanentUser) {
      setSolicitudes([]);
      setLoading(false);
      return;
    }

    try {
      setErrorMsg(null);
      const data = await openEncountersService.getMisSolicitudes();
      setSolicitudes(data || []);
    } catch (err: any) {
      console.error('[HomeSolicitudesSection] Error al cargar solicitudes:', err);
      setErrorMsg('No pudimos cargar tus solicitudes. Intentá nuevamente.');
    } finally {
      setLoading(false);
    }
  }, [user, isPermanentUser]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Suscripción Realtime a cambios en solicitudes_encuentro_abierto del usuario
  useEffect(() => {
    if (!user?.id || !isPermanentUser) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel(`user_solicitudes_realtime_${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'solicitudes_encuentro_abierto',
          filter: `usuario_id=eq.${user.id}`,
        },
        () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            loadData();
          }, 300);
        }
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [user?.id, isPermanentUser, loadData]);

  const handleCancelar = async (requestId: string) => {
    const confirmed = window.confirm(
      '¿Estás seguro de que querés cancelar esta solicitud? Ya no se considerará para el encuentro.'
    );
    if (!confirmed) return;

    setCancellingId(requestId);
    setErrorMsg(null);
    try {
      const res = await openEncountersService.cancelarSolicitud(requestId);
      if (res.ok) {
        await loadData();
      } else {
        setErrorMsg(
          res.error === 'cannot_cancel_non_pending'
            ? 'Esta solicitud ya fue procesada y no puede cancelarse.'
            : 'No se pudo cancelar la solicitud.'
        );
      }
    } catch (err) {
      setErrorMsg('Ocurrió un error al cancelar la solicitud.');
    } finally {
      setCancellingId(null);
    }
  };

  if (loading) {
    return (
      <div className="pe-solicitudes-section">
        <div className="pe-solicitudes-loading" role="status" aria-live="polite">
          <div className="pe-solicitudes-spinner" />
          <span>Cargando tus solicitudes...</span>
        </div>
      </div>
    );
  }

  const pendientes = solicitudes.filter((s) => s.estado === 'pending');
  const anteriores = solicitudes.filter((s) => s.estado !== 'pending');

  if (solicitudes.length === 0) {
    return (
      <div className="pe-solicitudes-section">
        <div className="pe-solicitudes-empty">
          <div className="pe-solicitudes-empty-icon" aria-hidden="true">
            <Inbox size={28} />
          </div>
          <h3 className="pe-solicitudes-empty-title">
            {t('your_encounters.solicitudes_empty_title', {
              defaultValue: 'No tenés solicitudes realizadas',
            })}
          </h3>
          <p className="pe-solicitudes-empty-desc">
            {t('your_encounters.solicitudes_empty_desc', {
              defaultValue: 'Cuando pidas sumarte a un encuentro abierto, vas a poder seguir el estado de tu solicitud acá.',
            })}
          </p>
        </div>
      </div>
    );
  }

  const renderBadge = (s: MiSolicitudItem) => {
    if (s.estado === 'pending') {
      if (s.is_expired) {
        return (
          <span className="pe-solicitud-badge pe-solicitud-badge--cancelled">
            <Clock size={12} /> Vencida
          </span>
        );
      }
      return (
        <span className="pe-solicitud-badge pe-solicitud-badge--pending">
          <Clock size={12} /> Pendiente
        </span>
      );
    }
    if (s.estado === 'approved') {
      return (
        <span className="pe-solicitud-badge pe-solicitud-badge--approved">
          <CheckCircle2 size={12} /> Aceptada
        </span>
      );
    }
    if (s.estado === 'rejected') {
      return (
        <span className="pe-solicitud-badge pe-solicitud-badge--rejected">
          <XCircle size={12} /> Rechazada
        </span>
      );
    }
    return (
      <span className="pe-solicitud-badge pe-solicitud-badge--cancelled">
        <AlertCircle size={12} /> Cancelada
      </span>
    );
  };

  return (
    <div className="pe-solicitudes-section">
      {errorMsg && (
        <div
          role="alert"
          style={{
            background: '#fee2e2',
            color: '#b91c1c',
            padding: '0.75rem 1rem',
            borderRadius: '10px',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            fontWeight: 500,
          }}
        >
          {errorMsg}
        </div>
      )}

      {/* ── 1. Solicitudes Pendientes ──────────────────────── */}
      {pendientes.length > 0 && (
        <div className="pe-solicitudes-group">
          <h3 className="pe-solicitudes-group-title">
            Solicitudes pendientes ({pendientes.length})
          </h3>
          <div className="pe-solicitudes-list">
            {pendientes.map((s) => (
              <article
                key={s.request_id}
                className="pe-solicitud-card pe-solicitud-card--pending"
              >
                <div className="pe-solicitud-card-top">
                  <h4 className="pe-solicitud-card-title">{s.open_public_title}</h4>
                  {renderBadge(s)}
                </div>

                <div className="pe-solicitud-meta">
                  {s.fecha && (
                    <span className="pe-solicitud-meta-item">
                      <Calendar size={13} aria-hidden="true" />
                      {formatFriendlyDate(s.fecha, s.hora)}
                    </span>
                  )}
                  <span className="pe-solicitud-meta-item">
                    <MapPin size={13} aria-hidden="true" />
                    {s.open_public_zone}
                  </span>
                  <span className="pe-solicitud-meta-item">
                    <Users size={13} aria-hidden="true" />
                    {s.seat_count === 1 ? '1 lugar' : `${s.seat_count} lugares`}
                  </span>
                </div>

                <div className="pe-solicitud-actions">
                  <button
                    type="button"
                    className="pe-solicitud-btn pe-solicitud-btn--primary"
                    onClick={() => onSelectEncuentro(s.encuentro_id)}
                  >
                    Ver encuentro <ArrowRight size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="pe-solicitud-btn pe-solicitud-btn--cancel"
                    onClick={() => handleCancelar(s.request_id)}
                    disabled={cancellingId === s.request_id}
                  >
                    {cancellingId === s.request_id ? 'Cancelando...' : 'Cancelar solicitud'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}

      {/* ── 2. Solicitudes Anteriores (Plegable) ─────────────── */}
      {anteriores.length > 0 && (
        <div className="pe-solicitudes-anteriores-section">
          <button
            type="button"
            className="pe-solicitudes-toggle-btn"
            onClick={() => setIsPastExpanded(!isPastExpanded)}
            aria-expanded={isPastExpanded}
          >
            <span>Ver solicitudes anteriores ({anteriores.length})</span>
            {isPastExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>

          {isPastExpanded && (
            <div className="pe-solicitudes-anteriores-wrap">
              <div className="pe-solicitudes-list">
                {anteriores.map((s) => (
                  <article
                    key={s.request_id}
                    className={`pe-solicitud-card pe-solicitud-card--${s.estado}`}
                  >
                    <div className="pe-solicitud-card-top">
                      <h4 className="pe-solicitud-card-title">{s.open_public_title}</h4>
                      {renderBadge(s)}
                    </div>

                    <div className="pe-solicitud-meta">
                      {s.fecha && (
                        <span className="pe-solicitud-meta-item">
                          <Calendar size={13} aria-hidden="true" />
                          {formatFriendlyDate(s.fecha, s.hora)}
                        </span>
                      )}
                      <span className="pe-solicitud-meta-item">
                        <MapPin size={13} aria-hidden="true" />
                        {s.open_public_zone}
                      </span>
                      <span className="pe-solicitud-meta-item">
                        <Users size={13} aria-hidden="true" />
                        {s.seat_count === 1 ? '1 lugar' : `${s.seat_count} lugares`}
                      </span>
                    </div>

                    <div className="pe-solicitud-actions">
                      <button
                        type="button"
                        className="pe-solicitud-btn pe-solicitud-btn--primary"
                        onClick={() => onSelectEncuentro(s.encuentro_id)}
                      >
                        Ver encuentro <ArrowRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
