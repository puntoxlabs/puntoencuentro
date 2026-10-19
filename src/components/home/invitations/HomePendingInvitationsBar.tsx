import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Mail, Calendar, ChevronRight, X } from 'lucide-react';
import { internalInvitationsService } from '@/services/internalInvitationsService';
import { formatFriendlyDate } from '@/lib/formatDate';
import type { MyInternalInvitationItem } from '@/types/internalInvitations';
import './HomePendingInvitationsBar.css';

export interface HomePendingInvitationsBarProps {
  isPermanentUser: boolean;
  userId?: string;
  refreshTrigger?: number;
}

export const HomePendingInvitationsBar: React.FC<HomePendingInvitationsBarProps> = ({
  isPermanentUser,
  userId,
  refreshTrigger = 0,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [pendingInvitations, setPendingInvitations] = useState<MyInternalInvitationItem[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Anti-flooding debounce / throttle para llamadas RPC
  const lastFetchTimeRef = useRef<number>(0);
  const isFetchingRef = useRef<boolean>(false);

  const fetchPendingInvitations = useCallback(async (force = false) => {
    if (!isPermanentUser) {
      setPendingInvitations([]);
      return;
    }

    const now = Date.now();
    // Throttle mínimo de 3 segundos entre llamadas automáticas (salvo forzado)
    if (!force && now - lastFetchTimeRef.current < 3000) {
      return;
    }
    if (isFetchingRef.current) return;

    try {
      isFetchingRef.current = true;
      lastFetchTimeRef.current = now;
      const res = await internalInvitationsService.getMisInvitaciones();
      if (res.ok && Array.isArray(res.invitaciones)) {
        // Filtrar exclusivamente invitaciones en estado pendiente
        const pend = res.invitaciones.filter((inv) => inv.estado === 'pendiente');
        setPendingInvitations(pend);
      } else {
        setPendingInvitations([]);
      }
    } catch (err) {
      console.error('[HomePendingInvitationsBar] Error al cargar invitaciones:', err);
    } finally {
      isFetchingRef.current = false;
    }
  }, [isPermanentUser]);

  // 1. Carga inicial o al cambiar de usuario / sesión
  useEffect(() => {
    if (isPermanentUser && userId) {
      fetchPendingInvitations(true);
    } else {
      setPendingInvitations([]);
    }
  }, [isPermanentUser, userId, fetchPendingInvitations]);

  // 2. Refresco reactivo cuando el padre emite refreshTrigger
  useEffect(() => {
    if (refreshTrigger > 0 && isPermanentUser) {
      fetchPendingInvitations(true);
    }
  }, [refreshTrigger, isPermanentUser, fetchPendingInvitations]);

  // 3. Refresco al recuperar foco o volver a primer plano (window focus / visibilitychange)
  useEffect(() => {
    if (!isPermanentUser) return;

    const handleResume = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        fetchPendingInvitations(false);
      }
    };

    const handleFocus = () => {
      fetchPendingInvitations(false);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleFocus);
      document.addEventListener('visibilitychange', handleResume);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleFocus);
        document.removeEventListener('visibilitychange', handleResume);
      }
    };
  }, [isPermanentUser, fetchPendingInvitations]);

  // Si no hay cuenta permanente o no hay invitaciones pendientes, no renderizar nada
  if (!isPermanentUser || pendingInvitations.length === 0) {
    return null;
  }

  const initialItems = pendingInvitations.slice(0, 3);
  const remainingCount = Math.max(0, pendingInvitations.length - 3);

  const handleSelectInvitation = (invitationId: string) => {
    if (isModalOpen) setIsModalOpen(false);
    navigate(`/invitation/${invitationId}`);
  };

  const renderInvitationDate = (inv: MyInternalInvitationItem) => {
    if (inv.encuentro_date_mode === 'coordination') {
      return t('internal_invitations.date_mode_coordination', { defaultValue: 'Fecha a coordinar' });
    }
    if (inv.encuentro_fecha) {
      const friendly = formatFriendlyDate(inv.encuentro_fecha);
      return inv.encuentro_hora ? `${friendly} · ${inv.encuentro_hora.substring(0, 5)} hs` : friendly;
    }
    return t('internal_invitations.date_mode_coordination', { defaultValue: 'Fecha a coordinar' });
  };

  return (
    <>
      <section
        className="home-pending-invitations-banner"
        aria-label={t('internal_invitations.pending_section_title', { defaultValue: 'Invitaciones recibidas' })}
        data-testid="home-pending-invitations-banner"
      >
        <header className="home-pending-invitations-header">
          <div className="home-pending-invitations-title-group">
            <Mail size={16} className="home-pending-invitations-icon" aria-hidden="true" />
            <h3 className="home-pending-invitations-title">
              {t('internal_invitations.pending_section_title', { defaultValue: 'Invitaciones recibidas' })}
            </h3>
            <span
              className="home-pending-invitations-badge"
              title={`${pendingInvitations.length} ${t('internal_invitations.pending_badge_label', { defaultValue: 'invitaciones pendientes' })}`}
            >
              {pendingInvitations.length}
            </span>
          </div>

          {remainingCount > 0 && (
            <button
              type="button"
              className="home-pending-invitations-view-all-btn"
              onClick={() => setIsModalOpen(true)}
              aria-label={t('internal_invitations.view_remaining_aria', {
                count: remainingCount,
                defaultValue: `Ver las ${remainingCount} restantes`,
              })}
            >
              {t('internal_invitations.view_remaining', {
                count: remainingCount,
                defaultValue: `+${remainingCount} más`,
              })}
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          )}
        </header>

        <div className="home-pending-invitations-list" role="list">
          {initialItems.map((inv) => (
            <button
              key={inv.id}
              type="button"
              role="listitem"
              className="home-pending-invitation-card"
              onClick={() => handleSelectInvitation(inv.id)}
            >
              <div className="home-pending-invitation-main">
                <span className="home-pending-invitation-title">
                  {inv.encuentro_titulo}
                </span>
                <span className="home-pending-invitation-meta">
                  <span className="home-pending-invitation-meta-item">
                    <Calendar size={13} aria-hidden="true" />
                    <span>{renderInvitationDate(inv)}</span>
                  </span>
                  <span className="home-pending-invitation-meta-dot" aria-hidden="true">•</span>
                  <span>
                    {inv.encuentro_modalidad === 'presencial'
                      ? t('internal_invitations.modalidad_presencial', { defaultValue: 'Presencial' })
                      : t('internal_invitations.modalidad_virtual', { defaultValue: 'Virtual' })}
                  </span>
                </span>
              </div>

              <div className="home-pending-invitation-cta">
                <span>{t('internal_invitations.respond_cta', { defaultValue: 'Responder' })}</span>
                <ChevronRight size={14} aria-hidden="true" />
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* Modal / Dialog para ver todas las invitaciones si hay más de 3 */}
      {isModalOpen && (
        <div
          className="home-invitations-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="all-pending-invitations-title"
          onClick={() => setIsModalOpen(false)}
        >
          <div
            className="home-invitations-modal-container"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="home-invitations-modal-header">
              <h3 id="all-pending-invitations-title">
                <Mail size={18} aria-hidden="true" />
                {t('internal_invitations.all_pending_title', {
                  count: pendingInvitations.length,
                  defaultValue: `Invitaciones recibidas (${pendingInvitations.length})`,
                })}
              </h3>
              <button
                type="button"
                className="home-invitations-modal-close-btn"
                onClick={() => setIsModalOpen(false)}
                aria-label={t('common.close', { defaultValue: 'Cerrar' })}
              >
                <X size={18} />
              </button>
            </div>

            <div className="home-invitations-modal-body">
              {pendingInvitations.map((inv) => (
                <button
                  key={inv.id}
                  type="button"
                  className="home-pending-invitation-card"
                  onClick={() => handleSelectInvitation(inv.id)}
                >
                  <div className="home-pending-invitation-main">
                    <span className="home-pending-invitation-title">
                      {inv.encuentro_titulo}
                    </span>
                    <span className="home-pending-invitation-meta">
                      <span className="home-pending-invitation-meta-item">
                        <Calendar size={13} aria-hidden="true" />
                        <span>{renderInvitationDate(inv)}</span>
                      </span>
                      <span className="home-pending-invitation-meta-dot" aria-hidden="true">•</span>
                      <span>
                        {inv.encuentro_modalidad === 'presencial'
                          ? t('internal_invitations.modalidad_presencial', { defaultValue: 'Presencial' })
                          : t('internal_invitations.modalidad_virtual', { defaultValue: 'Virtual' })}
                      </span>
                    </span>
                  </div>

                  <div className="home-pending-invitation-cta">
                    <span>{t('internal_invitations.respond_cta', { defaultValue: 'Responder' })}</span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
