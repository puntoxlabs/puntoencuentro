import React, { useState, useEffect } from 'react';
import { X, Sparkles, MapPin, Users, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Localidad } from '@/components/home/openEncounters/types';
import { openEncountersService } from '@/services/openEncountersService';
import './OpenEncounterPublishModal.css';

export interface OpenEncounterPublishModalProps {
  isOpen: boolean;
  onClose: () => void;
  encuentroId: string;
  hostId: string;
  defaultDescription?: string;
  confirmedCount: number;
  onPublished: () => void;
}

export const OpenEncounterPublishModal: React.FC<OpenEncounterPublishModalProps> = ({
  isOpen,
  onClose,
  encuentroId,
  hostId,
  defaultDescription = '',
  confirmedCount,
  onPublished,
}) => {
  const { t } = useTranslation();
  const [localidades, setLocalidades] = useState<Localidad[]>([]);
  const [description, setDescription] = useState(defaultDescription);
  const [maxParticipants, setMaxParticipants] = useState<number>(Math.max(4, confirmedCount + 2));
  const [localityId, setLocalityId] = useState<string>('guemes');
  const [publicZone, setPublicZone] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    openEncountersService.getLocalidades().then((data) => {
      if (data && data.length > 0) {
        setLocalidades(data);
        if (!localityId) {
          setLocalityId(data[0].id);
        }
      } else {
        setLocalidades([
          { id: 'guemes', nombre: 'Güemes', ciudad: 'Mar del Plata', zona: 'Costa Atlántica', pais: 'AR', orden: 1 },
          { id: 'constitucion', nombre: 'Constitución', ciudad: 'Mar del Plata', zona: 'Costa Atlántica', pais: 'AR', orden: 2 },
          { id: 'costa', nombre: 'La Costa', ciudad: 'Mar del Plata', zona: 'Costa Atlántica', pais: 'AR', orden: 3 },
          { id: 'centro', nombre: 'Centro', ciudad: 'Mar del Plata', zona: 'Costa Atlántica', pais: 'AR', orden: 4 },
          { id: 'mitre', nombre: 'Plaza Mitre', ciudad: 'Mar del Plata', zona: 'Costa Atlántica', pais: 'AR', orden: 5 },
          { id: 'palermo', nombre: 'Palermo', ciudad: 'Buenos Aires', zona: 'CABA', pais: 'AR', orden: 6 },
          { id: 'belgrano', nombre: 'Belgrano', ciudad: 'Buenos Aires', zona: 'CABA', pais: 'AR', orden: 7 },
        ]);
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) {
      setErrorMsg('Por favor ingresá una descripción pública para el encuentro.');
      return;
    }
    if (maxParticipants <= confirmedCount) {
      setErrorMsg(`El cupo total debe ser mayor a los confirmados actuales (${confirmedCount}).`);
      return;
    }
    if (!localityId) {
      setErrorMsg('Por favor seleccioná una localidad.');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    const selectedLoc = localidades.find((l) => l.id === localityId);
    const resolvedZone = publicZone.trim() || (selectedLoc ? `${selectedLoc.nombre} · ${selectedLoc.ciudad}` : '');

    try {
      const res = await openEncountersService.abrirEncuentro(encuentroId, hostId, {
        open_description: description.trim(),
        max_participants: maxParticipants,
        locality_id: localityId,
        open_public_zone: resolvedZone,
      });

      if (res.ok) {
        onPublished();
        onClose();
      } else {
        setErrorMsg(res.error || 'No se pudo publicar el encuentro.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Error al publicar el encuentro.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="pe-publish-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="pe-publish-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pe-publish-title"
      >
        <div className="pe-publish-modal__header">
          <div className="pe-publish-modal__title-row">
            <Sparkles size={20} className="pe-publish-modal__icon" aria-hidden="true" />
            <h2 id="pe-publish-title" className="pe-publish-modal__title">
              {t('open_encounters.open_encounter_modal_title', { defaultValue: 'Abrir encuentro al Discovery' })}
            </h2>
          </div>
          <button
            type="button"
            className="pe-publish-modal__close-btn"
            onClick={onClose}
            aria-label="Cerrar modal"
          >
            <X size={18} />
          </button>
        </div>

        <p className="pe-publish-modal__subtitle">
          Abrí lugares para que otras personas de tu zona puedan ver el plan y solicitar sumarse. La dirección puntual solo se revelará a quienes apruebes.
        </p>

        {errorMsg && (
          <div className="pe-publish-modal__error">
            <AlertCircle size={16} />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="pe-publish-modal__form">
          <div className="pe-publish-modal__field">
            <label className="pe-publish-modal__label">
              {t('open_encounters.open_desc_label', { defaultValue: 'Descripción pública del plan' })} *
            </label>
            <textarea
              required
              className="pe-publish-modal__textarea"
              placeholder={t('open_encounters.open_desc_placeholder', {
                defaultValue: 'Contá brevemente de qué se trata y a quiénes buscás sumar...',
              })}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={400}
            />
          </div>

          <div className="pe-publish-modal__row">
            <div className="pe-publish-modal__field">
              <label className="pe-publish-modal__label">
                <Users size={12} style={{ display: 'inline', marginRight: 4 }} />
                {t('open_encounters.open_slots_label', { defaultValue: 'Cupo máximo total' })} *
              </label>
              <input
                type="number"
                required
                min={Math.max(2, confirmedCount + 1)}
                max={50}
                className="pe-publish-modal__input"
                value={maxParticipants}
                onChange={(e) => setMaxParticipants(parseInt(e.target.value, 10) || 2)}
              />
              <span className="pe-publish-modal__hint">
                Incluye al anfitrión y acompañantes ({confirmedCount} ocupados hoy).
              </span>
            </div>

            <div className="pe-publish-modal__field">
              <label className="pe-publish-modal__label">
                <MapPin size={12} style={{ display: 'inline', marginRight: 4 }} />
                {t('open_encounters.open_zone_label', { defaultValue: 'Localidad / Barrio' })} *
              </label>
              <select
                className="pe-publish-modal__select"
                value={localityId}
                onChange={(e) => setLocalityId(e.target.value)}
              >
                {localidades.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.nombre} ({loc.ciudad})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="pe-publish-modal__field">
            <label className="pe-publish-modal__label">
              {t('open_encounters.open_public_zone_label', { defaultValue: 'Referencia pública aproximada' })}
            </label>
            <input
              type="text"
              className="pe-publish-modal__input"
              placeholder={t('open_encounters.open_public_zone_placeholder', {
                defaultValue: 'Ej: Güemes · Mar del Plata, o Palermo Soho',
              })}
              value={publicZone}
              onChange={(e) => setPublicZone(e.target.value)}
              maxLength={70}
            />
            <span className="pe-publish-modal__hint">
              Esta referencia es lo único visible antes de la aprobación (la dirección exacta permanece oculta).
            </span>
          </div>

          <div className="pe-publish-modal__footer">
            <button
              type="button"
              className="pe-publish-modal__btn-cancel"
              onClick={onClose}
              disabled={submitting}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="pe-publish-modal__btn-submit"
              disabled={submitting}
            >
              {submitting
                ? 'Publicando…'
                : t('open_encounters.open_publish_btn', { defaultValue: 'Publicar en Encuentros Abiertos' })}
            </button>
          </div>
        </form>
      </div>
    </>
  );
};
