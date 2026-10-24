import React, { useState, useEffect } from 'react';
import { X, Sparkles, MapPin, Users, AlertCircle, Video, Edit2, Check, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Localidad } from '@/components/home/openEncounters/types';
import { DEFAULT_LOCALIDADES } from '@/constants/localidades';
import { openEncountersService } from '@/services/openEncountersService';
import { PendingClosureBlockedModal } from '@/components/host/PendingClosureBlockedModal';
import './OpenEncounterPublishModal.css';

export interface OpenEncounterPublishModalProps {
  isOpen: boolean;
  onClose: () => void;
  encuentroId: string;
  hostId: string;
  modalidad?: 'presencial' | 'virtual';
  lugarTexto?: string;
  linkVirtual?: string;
  defaultTitle?: string;
  defaultDescription?: string;
  defaultSlots?: number;
  defaultLocalityId?: string;
  confirmedCount?: number;
  confirmedSeats?: number;
  defaultAllowMultiSeat?: boolean;
  defaultMaxSeats?: number;
  onUpdateLocation?: (loc: { lugar_texto?: string; link_virtual?: string }) => Promise<void>;
  onPublished: (result?: { ok: boolean; moderation_status?: string; message?: string }) => void;
}

export const OpenEncounterPublishModal: React.FC<OpenEncounterPublishModalProps> = ({
  isOpen,
  onClose,
  encuentroId,
  hostId,
  modalidad = 'presencial',
  lugarTexto = '',
  linkVirtual = '',
  defaultTitle = '',
  defaultDescription = '',
  defaultSlots,
  defaultLocalityId,
  confirmedCount = 0,
  confirmedSeats,
  defaultAllowMultiSeat,
  defaultMaxSeats,
  onUpdateLocation,
  onPublished,
}) => {
  const { t } = useTranslation();
  const [localidades, setLocalidades] = useState<Localidad[]>([]);
  const [pendingClosureData, setPendingClosureData] = useState<{ id: string; title: string } | null>(null);
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState(defaultDescription);
  const [slotsInput, setSlotsInput] = useState<string>(defaultSlots ? String(defaultSlots) : '2');
  const [localityId, setLocalityId] = useState<string>(defaultLocalityId || 'guemes');
  const [allowMultiSeat, setAllowMultiSeat] = useState<boolean>(defaultAllowMultiSeat ?? false);
  const [maxSeatsInput, setMaxSeatsInput] = useState<string>(defaultMaxSeats ? String(defaultMaxSeats) : '2');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSlotsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === '' || /^\d+$/.test(val)) {
      setSlotsInput(val);
      if (val !== '') {
        const num = parseInt(val, 10);
        if (num >= 1) setErrorMsg(null);
      }
    }
  };

  const handleSlotsBlur = () => {
    const parsed = parseInt(slotsInput, 10);
    if (!slotsInput || isNaN(parsed) || parsed < 1) {
      setSlotsInput('1');
    } else if (parsed > 40) {
      setSlotsInput('40');
    } else {
      setSlotsInput(String(parsed));
    }
  };

  // Edición de ubicación privada
  const isVirtual = modalidad === 'virtual';
  const [currentLugar, setCurrentLugar] = useState(lugarTexto);
  const [currentLink, setCurrentLink] = useState(linkVirtual);
  const [isEditingLocation, setIsEditingLocation] = useState(false);
  const [tempLocation, setTempLocation] = useState(isVirtual ? linkVirtual : lugarTexto);
  const [savingLocation, setSavingLocation] = useState(false);

  useEffect(() => {
    setCurrentLugar(lugarTexto);
    setCurrentLink(linkVirtual);
    setTempLocation(isVirtual ? linkVirtual : lugarTexto);
  }, [lugarTexto, linkVirtual, isVirtual]);

  useEffect(() => {
    if (isOpen) {
      setTitle(defaultTitle || '');
      setDescription(defaultDescription || '');
      setSlotsInput(defaultSlots ? String(defaultSlots) : '2');
      if (defaultLocalityId) setLocalityId(defaultLocalityId);
      if (defaultAllowMultiSeat !== undefined) setAllowMultiSeat(defaultAllowMultiSeat);
      if (defaultMaxSeats !== undefined) setMaxSeatsInput(String(defaultMaxSeats));
      setErrorMsg(null);
    }
  }, [isOpen, defaultTitle, defaultDescription, defaultSlots, defaultLocalityId, defaultAllowMultiSeat, defaultMaxSeats]);

  useEffect(() => {
    if (!isOpen || isVirtual) return;

    openEncountersService.getLocalidades().then((data) => {
      if (data && data.length > 0) {
        setLocalidades(data);
        if (!localityId) {
          setLocalityId(data[0].id);
        }
      } else {
        setLocalidades(DEFAULT_LOCALIDADES);
        if (!localityId) {
          setLocalityId(DEFAULT_LOCALIDADES[0].id);
        }
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isVirtual, onClose]);

  if (!isOpen) return null;

  const handleSaveLocation = async () => {
    if (!onUpdateLocation) return;
    const clean = tempLocation.trim();
    if (!clean) return;

    setSavingLocation(true);
    setErrorMsg(null);
    try {
      if (isVirtual) {
        await onUpdateLocation({ link_virtual: clean });
        setCurrentLink(clean);
      } else {
        await onUpdateLocation({ lugar_texto: clean });
        setCurrentLugar(clean);
      }
      setIsEditingLocation(false);
    } catch (err: any) {
      setErrorMsg(err.message || 'No se pudo actualizar la ubicación.');
    } finally {
      setSavingLocation(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // 1. Validar ubicación privada
    if (isVirtual) {
      if (!currentLink || !currentLink.trim()) {
        setErrorMsg('Por favor ingresá el enlace de la videollamada antes de abrir el encuentro.');
        setIsEditingLocation(true);
        return;
      }
    } else {
      if (!currentLugar || !currentLugar.trim()) {
        setErrorMsg('Por favor ingresá el lugar y dirección antes de abrir el encuentro.');
        setIsEditingLocation(true);
        return;
      }
    }

    const cleanTitle = title.trim();
    if (!cleanTitle || cleanTitle.length < 3) {
      setErrorMsg(
        t('open_encounters.open_title_min_length', {
          defaultValue: 'Por favor ingresá un título público de al menos 3 caracteres.',
        })
      );
      return;
    }
    if (cleanTitle.length > 80) {
      setErrorMsg(
        t('open_encounters.open_title_max_length', {
          defaultValue: 'El título público no puede superar los 80 caracteres.',
        })
      );
      return;
    }

    if (!description.trim()) {
      setErrorMsg('Por favor ingresá una descripción pública para el encuentro.');
      return;
    }

    const parsedSlots = parseInt(slotsInput, 10);
    if (isNaN(parsedSlots) || parsedSlots < 1) {
      setErrorMsg('Debés ofrecer al menos 1 lugar para sumarse.');
      return;
    }
    if (parsedSlots > 40) {
      setErrorMsg('El máximo permitido es 40 lugares para sumarse.');
      return;
    }

    if (!isVirtual && !localityId) {
      setErrorMsg('Por favor seleccioná una localidad.');
      return;
    }

    const parsedMaxSeats = parseInt(maxSeatsInput, 10);
    if (allowMultiSeat) {
      if (isNaN(parsedMaxSeats) || parsedMaxSeats < 2) {
        setErrorMsg('El máximo de lugares por solicitud debe ser al menos 2.');
        return;
      }
      if (parsedMaxSeats > parsedSlots) {
        setErrorMsg('El máximo por solicitud no puede superar los lugares totales para sumarse.');
        return;
      }
    }

    // Semántica canónica: max_participants = lugares directos para externos (el host no consume cupo visible)
    const calculatedMaxParticipants = parsedSlots;

    setSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await openEncountersService.abrirEncuentro(encuentroId, hostId, {
        open_public_title: cleanTitle,
        open_description: description.trim(),
        max_participants: calculatedMaxParticipants,
        locality_id: isVirtual ? null : localityId,
        allow_multi_seat_requests: allowMultiSeat,
        max_seats_per_request: allowMultiSeat ? parsedMaxSeats : 1,
      });

      if (res.ok) {
        onPublished(res);
        onClose();
      } else {
        if (res.error === 'pending_closure_required') {
          setPendingClosureData({
            id: res.pending_encuentro_id || '',
            title: res.pending_encuentro_title || '',
          });
          setErrorMsg(res.message || 'Tenés un encuentro abierto anterior pendiente de cierre.');
        } else if (res.error === 'content_moderation_blocked') {
          setErrorMsg(
            t('open_encounters.rejected_notice', {
              defaultValue:
                'Esta publicación no puede mostrarse públicamente con el contenido actual. Podés editarla e intentarlo nuevamente.',
            })
          );
        } else if (res.error === 'max_participants_too_low') {
          const effectiveConfirmedSeats = confirmedSeats ?? confirmedCount ?? 0;
          setErrorMsg(`No podés reducir el cupo por debajo de los lugares ya confirmados (${effectiveConfirmedSeats}).`);
        } else if (res.error === 'private_location_required') {
          setErrorMsg('El lugar y dirección privada es requerido para abrir el encuentro.');
          setIsEditingLocation(true);
        } else if (res.error === 'private_virtual_link_required') {
          setErrorMsg('El enlace de videollamada es requerido para abrir el encuentro virtual.');
          setIsEditingLocation(true);
        } else {
          setErrorMsg(res.error || 'No se pudo publicar el encuentro.');
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Error al publicar el encuentro.');
    } finally {
      setSubmitting(false);
    }
  };

  const hasPrivateLocation = isVirtual ? Boolean(currentLink?.trim()) : Boolean(currentLugar?.trim());

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
              {t('open_encounters.open_encounter_modal_title', { defaultValue: 'Abrir encuentro para sumarse' })}
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
          {isVirtual
            ? t('open_encounters.publish_subtitle_virtual', { defaultValue: 'Abrí lugares para que otras personas puedan descubrir tu plan y solicitar sumarse. El enlace de acceso se revelará una vez confirmada la realización y reconfirmada la asistencia.' })
            : t('open_encounters.publish_subtitle_presencial', { defaultValue: 'Abrí lugares para que otras personas de tu zona puedan ver el plan y solicitar sumarse. La dirección exacta se revelará una vez confirmada la realización y reconfirmada la asistencia.' })}
        </p>

        {isVirtual && (
          <div className="pe-publish-modal__virtual-info">
            <Video size={18} style={{ flexShrink: 0 }} />
            <span>
              Se publicará como <strong>Encuentro Virtual</strong>. No requiere zona física y el enlace privado no será expuesto públicamente.
            </span>
          </div>
        )}

        {/* Sección de Ubicación Privada con Opción de Editar */}
        <div className={`pe-publish-private-loc ${!hasPrivateLocation ? 'pe-publish-private-loc--missing' : ''}`}>
          <div className="pe-publish-private-loc__header">
            <div className="pe-publish-private-loc__label">
              <Lock size={13} />
              <span>{isVirtual ? 'Enlace de acceso privado' : 'Lugar y dirección privada'}</span>
            </div>
            {!isEditingLocation && onUpdateLocation && (
              <button
                type="button"
                className="pe-publish-private-loc__edit-btn"
                onClick={() => {
                  setTempLocation(isVirtual ? currentLink : currentLugar);
                  setIsEditingLocation(true);
                }}
              >
                <Edit2 size={12} />
                <span>Editar</span>
              </button>
            )}
          </div>

          {isEditingLocation ? (
            <div className="pe-publish-private-loc__edit-form">
              <input
                type="text"
                className="pe-publish-modal__input pe-publish-private-loc__input"
                placeholder={isVirtual ? 'https://meet.google.com/...' : 'Ej: Café Martínez (Güemes), o Av. Colón 1234'}
                value={tempLocation}
                onChange={(e) => setTempLocation(e.target.value)}
                autoFocus
              />
              <div className="pe-publish-private-loc__edit-actions">
                <button
                  type="button"
                  className="pe-publish-private-loc__save-btn"
                  onClick={handleSaveLocation}
                  disabled={savingLocation || !tempLocation.trim()}
                >
                  <Check size={14} />
                  <span>{savingLocation ? 'Guardando…' : 'Guardar'}</span>
                </button>
                <button
                  type="button"
                  className="pe-publish-private-loc__cancel-edit-btn"
                  onClick={() => setIsEditingLocation(false)}
                  disabled={savingLocation}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="pe-publish-private-loc__value">
                {hasPrivateLocation
                  ? (isVirtual ? currentLink : currentLugar)
                  : <span className="pe-publish-private-loc__empty">⚠️ Falta definir {isVirtual ? 'el enlace de acceso' : 'el lugar y dirección'}. Es necesario para que los participantes aprobados puedan asistir.</span>
                }
              </p>
              <p className="pe-publish-private-loc__hint" style={{ margin: '6px 0 0 0', fontSize: 12, color: 'var(--color-on-surface-variant)', lineHeight: 1.4 }}>
                {isVirtual
                  ? t('open_encounters.publish_loc_hint_virtual', { defaultValue: 'Enlace donde se realizará el encuentro. Es privado: se compartirá una vez confirmada la realización y reconfirmada la asistencia.' })
                  : t('open_encounters.publish_loc_hint_presencial', { defaultValue: 'Indica dónde será el encuentro (nombre del lugar, referencia o dirección). Es privado: se compartirá una vez confirmada la realización y reconfirmada la asistencia.' })}
              </p>
            </>
          )}
        </div>

        {errorMsg && (
          <div className="pe-publish-modal__error">
            <AlertCircle size={16} />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="pe-publish-modal__form">
          <div className="pe-publish-modal__field">
            <label className="pe-publish-modal__label">
              {t('open_encounters.open_title_label', { defaultValue: 'Título público del plan' })} *
            </label>
            <input
              type="text"
              required
              maxLength={80}
              className="pe-publish-modal__input"
              placeholder={t('open_encounters.open_title_placeholder', {
                defaultValue: 'Ej: Café de especialidad y charla...',
              })}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

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
            {!isVirtual ? (
              <div className="pe-publish-modal__desc-help" style={{ marginTop: '6px', fontSize: '12px', color: 'var(--color-on-surface-variant, #64748b)', lineHeight: '1.45', background: 'var(--color-surface-container-low, #f8fafc)', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--color-outline-variant, #e2e8f0)' }}>
                <p style={{ margin: '0 0 4px 0', fontWeight: 500, color: 'var(--color-on-surface, #334155)' }}>
                  {t('open_encounters.open_desc_hint', { defaultValue: 'Contá de qué se trata el encuentro y sumá una referencia aproximada de dónde será.' })}
                </p>
                <p style={{ margin: '0 0 4px 0', fontSize: '11.5px', color: 'var(--color-primary, #2563eb)' }}>
                  {t('open_encounters.open_desc_examples', { defaultValue: 'Ejemplos: «Zona Plaza Colón», «Cerca de Luro y España», «Por la costa, a la altura de Playa Grande».' })}
                </p>
                <p style={{ margin: 0, fontSize: '11px', color: 'var(--color-on-surface-variant, #64748b)' }}>
                  {t('open_encounters.open_desc_clarification', { defaultValue: 'Podés mencionar una plaza, un sector o dos calles cercanas. Usá una referencia orientativa, no necesariamente el punto exacto. No publiques la dirección definitiva.' })}
                </p>
              </div>
            ) : (
              <span className="pe-publish-modal__hint">
                {t('open_encounters.open_desc_virtual_hint', { defaultValue: 'Contá brevemente de qué se trata la videollamada y cuál es la propuesta.' })}
              </span>
            )}
          </div>

          <div className="pe-publish-modal__row">
            <div className="pe-publish-modal__field">
              <label className="pe-publish-modal__label">
                <Users size={12} style={{ display: 'inline', marginRight: 4 }} />
                {t('open_encounters.open_slots_label', { defaultValue: 'Lugares para sumarse' })} *
              </label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                required
                className="pe-publish-modal__input"
                value={slotsInput}
                onChange={handleSlotsChange}
                onBlur={handleSlotsBlur}
                placeholder="Ej: 4"
              />
              <span className="pe-publish-modal__hint">
                Personas adicionales que querés sumar a tu encuentro (no incluye al anfitrión).
              </span>
            </div>

            {!isVirtual && (
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
                <span className="pe-publish-modal__hint">
                  Esta zona será visible públicamente. La dirección exacta seguirá siendo privada.
                </span>
              </div>
            )}
          </div>

          {/* Opciones de Reserva Múltiple */}
          <div className="pe-publish-modal__field" style={{ marginTop: 8 }}>
            <label
              className="pe-publish-modal__checkbox-label"
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 500, fontSize: 13, color: '#334155' }}
            >
              <input
                type="checkbox"
                checked={allowMultiSeat}
                onChange={(e) => setAllowMultiSeat(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: '#059669', cursor: 'pointer' }}
              />
              <span>Permitir reservar varios lugares por solicitud</span>
            </label>
            <span className="pe-publish-modal__hint" style={{ marginTop: 2, display: 'block' }}>
              Los solicitantes podrán pedir más de 1 lugar (incluyéndose a sí mismos) hasta el límite que definas.
            </span>

            {allowMultiSeat && (
              <div style={{ marginTop: 10, paddingLeft: 24 }}>
                <label className="pe-publish-modal__label" style={{ fontSize: 12 }}>
                  Máximo de lugares por solicitud (entre 2 y {slotsInput || '40'}) *
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className="pe-publish-modal__input"
                  style={{ width: 90, marginTop: 4 }}
                  value={maxSeatsInput}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '' || /^\d+$/.test(val)) setMaxSeatsInput(val);
                  }}
                  onBlur={() => {
                    const p = parseInt(maxSeatsInput, 10);
                    const maxAllowed = parseInt(slotsInput, 10) || 40;
                    if (isNaN(p) || p < 2) setMaxSeatsInput('2');
                    else if (p > maxAllowed) setMaxSeatsInput(String(maxAllowed));
                    else setMaxSeatsInput(String(p));
                  }}
                />
              </div>
            )}
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
      {pendingClosureData && (
        <PendingClosureBlockedModal
          isOpen={Boolean(pendingClosureData)}
          pendingEncuentroId={pendingClosureData.id}
          pendingEncuentroTitle={pendingClosureData.title}
          onClose={() => setPendingClosureData(null)}
          onGoToClosure={(encId) => {
            setPendingClosureData(null);
            onClose();
            if (typeof window !== 'undefined') {
              window.location.href = `/encuentro/${encId}`;
            }
          }}
        />
      )}
    </>
  );
};

