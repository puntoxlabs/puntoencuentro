import React, { useState, useEffect } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { PerfilConfianzaSolicitante } from '@/types/trust';
import { trustService } from '@/services/trustService';
import './ApplicantTrustSignals.css';

export interface ApplicantTrustSignalsProps {
  solicitudId: string;
  initialProfile?: PerfilConfianzaSolicitante;
}

export function formatMemberSinceMonth(monthIso: string | null): string | null {
  if (!monthIso) return null;
  const parts = monthIso.split('-');
  if (parts.length !== 2) return null;
  const year = parts[0];
  const monthIdx = parseInt(parts[1], 10) - 1;
  const monthNames = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  if (monthIdx < 0 || monthIdx > 11) return null;
  return `${monthNames[monthIdx]} de ${year}`;
}

export const ApplicantTrustSignals: React.FC<ApplicantTrustSignalsProps> = ({
  solicitudId,
  initialProfile,
}) => {
  const [profile, setProfile] = useState<PerfilConfianzaSolicitante | null>(
    initialProfile || null
  );
  const [loading, setLoading] = useState<boolean>(!initialProfile);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialProfile) {
      setProfile(initialProfile);
      setLoading(false);
      return;
    }

    if (!solicitudId) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    trustService
      .getPerfilConfianzaSolicitante(solicitudId)
      .then((res) => {
        if (!isMounted) return;
        if (res.ok && res.data) {
          setProfile(res.data);
        } else {
          setError(res.error || 'error');
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        setError(err?.message || 'error');
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [solicitudId, initialProfile]);

  if (loading) {
    return (
      <div className="pe-trust-signals" role="status" aria-live="polite">
        <span className="pe-trust-signals__loading">Cargando señales de actividad…</span>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="pe-trust-signals">
        <span className="pe-trust-signals__error">
          No pudimos cargar las señales de actividad.
        </span>
      </div>
    );
  }

  const memberSinceFormatted = formatMemberSinceMonth(profile.member_since_month);
  const approvedCount = profile.approved_open_encounters_previous;
  const hostedCount = profile.hosted_open_encounters_previous;

  return (
    <div className="pe-trust-signals">
      <div className="pe-trust-signals__header">
        <ShieldCheck size={14} className="pe-trust-signals__icon" aria-hidden="true" />
        <span>Señales en PuntoEncuentro</span>
      </div>

      <div className="pe-trust-signals__list">
        {memberSinceFormatted && (
          <div className="pe-trust-signals__item">
            <span className="pe-trust-signals__bullet" aria-hidden="true">•</span>
            <span>{`En PuntoEncuentro desde ${memberSinceFormatted}`}</span>
          </div>
        )}

        {profile.no_prior_open_history ? (
          <div className="pe-trust-signals__neutral-box">
            <span className="pe-trust-signals__neutral-title">
              Sin historial previo en Encuentros Abiertos
            </span>
            <p className="pe-trust-signals__neutral-desc">
              Esta persona todavía no tiene actividad previa suficiente en PuntoEncuentro. Su mensaje de presentación puede ayudarte a decidir.
            </p>
          </div>
        ) : (
          <div className="pe-trust-signals__item">
            <span className="pe-trust-signals__bullet" aria-hidden="true">•</span>
            <span>
              {approvedCount === 1
                ? 'Fue aceptado en 1 encuentro abierto anterior'
                : `Fue aceptado en ${approvedCount} encuentros abiertos anteriores`}
            </span>
          </div>
        )}

        {hostedCount != null && hostedCount > 0 && (
          <div className="pe-trust-signals__item">
            <span className="pe-trust-signals__bullet" aria-hidden="true">•</span>
            <span>
              {hostedCount === 1
                ? 'Organizó 1 encuentro abierto anterior'
                : `Organizó ${hostedCount} encuentros abiertos anteriores`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
