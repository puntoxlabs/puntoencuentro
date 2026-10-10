import React, { useState, useRef, useEffect } from 'react';
import {
  Calendar,
  MapPin,
  Edit3,
  PauseCircle,
  PlayCircle,
  XCircle,
  CalendarPlus,
  MoreVertical,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Intencion } from '../../../types/intenciones';
import './IntencionCard.css';

export interface IntencionCardProps {
  intencion: Intencion;
  onEdit: (intencion: Intencion) => void;
  onPausar: (id: string) => void;
  onReactivar: (id: string) => void;
  onCerrar: (id: string) => void;
  onOrganizar?: (intencion: Intencion) => void;
  disabled?: boolean;
  isV2Variant?: boolean;
}

export const IntencionCard: React.FC<IntencionCardProps> = ({
  intencion,
  onEdit,
  onPausar,
  onReactivar,
  onCerrar,
  onOrganizar,
  disabled = false,
  isV2Variant = false,
}) => {
  const { t } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isPausada = intencion.estado === 'pausada';
  const isActiva = intencion.estado === 'activa';
  const canOrganizar = (isActiva || isPausada) && Boolean(onOrganizar);

  const formatModalidad = () => {
    switch (intencion.modalidad) {
      case 'virtual':
        return 'Virtual';
      case 'indistinto':
        return 'Presencial o virtual';
      case 'presencial':
      default:
        return 'Presencial';
    }
  };

  // Cierre de menú al clickear afuera
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [isMenuOpen]);

  // Accesibilidad de teclado para el menú
  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setIsMenuOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
      if (items && items.length > 0) {
        const currentIndex = Array.from(items).indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex = (currentIndex + 1) % items.length;
        items[nextIndex].focus();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
      if (items && items.length > 0) {
        const currentIndex = Array.from(items).indexOf(document.activeElement as HTMLButtonElement);
        const prevIndex = (currentIndex - 1 + items.length) % items.length;
        items[prevIndex].focus();
      }
    }
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      if (!isMenuOpen) {
        setIsMenuOpen(true);
      }
    }
  };

  const toggleMenu = () => {
    setIsMenuOpen((prev) => !prev);
  };

  // Foco inicial en primer elemento al abrir el menú
  useEffect(() => {
    if (isMenuOpen && menuRef.current) {
      const firstItem = menuRef.current.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
      firstItem?.focus();
    }
  }, [isMenuOpen]);

  // ── HOME V2: MINI-CARD COMPACTA EN SEGUIMIENTO ──
  if (isV2Variant) {
    const statusLabel = isActiva
      ? t('your_encounters.intentions_status_active_v2', { defaultValue: 'En seguimiento' })
      : t('your_encounters.intentions_status_paused_v2', { defaultValue: 'Pausada' });

    return (
      <article
        className={`pe-intencion-card pe-intencion-card--mini ${isPausada ? 'pe-intencion-card--pausada' : ''}`}
        aria-label={intencion.titulo}
      >
        <div className="pe-intencion-card__header">
          <h3 className="pe-intencion-card__title">{intencion.titulo}</h3>
          <span
            className={`pe-intencion-card__status-badge ${
              isActiva
                ? 'pe-intencion-card__status-badge--activa'
                : 'pe-intencion-card__status-badge--pausada'
            }`}
          >
            <span className="pe-intencion-card__status-dot" aria-hidden="true" />
            <span>{statusLabel}</span>
          </span>
        </div>

        {intencion.descripcion && (
          <p className="pe-intencion-card__desc">{intencion.descripcion}</p>
        )}

        <div className="pe-intencion-card__meta-row">
          {intencion.temporalidad_texto && (
            <span className="pe-intencion-card__tag" title="Cuándo">
              <Calendar size={12} aria-hidden="true" />
              <span>{intencion.temporalidad_texto}</span>
            </span>
          )}

          <span className="pe-intencion-card__tag" title="Modalidad y lugar">
            {intencion.modalidad === 'presencial' && intencion.localidad_nombre ? (
              <>
                <MapPin size={12} aria-hidden="true" />
                <span>{`${formatModalidad()} · ${intencion.localidad_nombre}`}</span>
              </>
            ) : (
              <span>{formatModalidad()}</span>
            )}
          </span>
        </div>

        <div className="pe-intencion-card__footer">
          {canOrganizar && (
            <button
              type="button"
              onClick={() => onOrganizar!(intencion)}
              disabled={disabled}
              className="pe-intencion-card__btn pe-intencion-card__btn--organizar"
              aria-label={t('your_encounters.intentions_organize_aria', {
                defaultValue: `Organizar encuentro a partir de ${intencion.titulo}`,
                title: intencion.titulo,
              })}
            >
              <CalendarPlus size={13} aria-hidden="true" />
              <span>
                {t('your_encounters.intentions_action_organize_v2', {
                  defaultValue: 'Organizar encuentro',
                })}
              </span>
            </button>
          )}

          <div className="pe-intencion-card__menu-container">
            <button
              ref={triggerRef}
              type="button"
              onClick={toggleMenu}
              onKeyDown={handleTriggerKeyDown}
              disabled={disabled}
              className="pe-intencion-card__more-btn"
              aria-label={t('your_encounters.intentions_menu_aria', {
                defaultValue: `Más opciones para ${intencion.titulo}`,
                title: intencion.titulo,
              })}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
            >
              <MoreVertical size={16} aria-hidden="true" />
            </button>

            <div
              ref={menuRef}
              className={`pe-intencion-card__menu ${isMenuOpen ? 'pe-intencion-card__menu--open' : ''}`}
              role="menu"
              hidden={!isMenuOpen}
              aria-label={t('your_encounters.intentions_menu_aria', {
                defaultValue: `Más opciones para ${intencion.titulo}`,
                title: intencion.titulo,
              })}
              onKeyDown={handleMenuKeyDown}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsMenuOpen(false);
                  onEdit(intencion);
                }}
                disabled={disabled}
                className="pe-intencion-card__menu-item"
              >
                <Edit3 size={14} aria-hidden="true" />
                <span>
                  {t('your_encounters.intentions_action_edit_v2', { defaultValue: 'Editar' })}
                </span>
              </button>

              {isActiva && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMenuOpen(false);
                    onPausar(intencion.id);
                  }}
                  disabled={disabled}
                  className="pe-intencion-card__menu-item"
                >
                  <PauseCircle size={14} aria-hidden="true" />
                  <span>
                    {t('your_encounters.intentions_action_pause_v2', {
                      defaultValue: 'Pausar',
                    })}
                  </span>
                </button>
              )}

              {isPausada && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMenuOpen(false);
                    onReactivar(intencion.id);
                  }}
                  disabled={disabled}
                  className="pe-intencion-card__menu-item"
                >
                  <PlayCircle size={14} aria-hidden="true" />
                  <span>
                    {t('your_encounters.intentions_action_reactivate_v2', {
                      defaultValue: 'Reactivar',
                    })}
                  </span>
                </button>
              )}

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsMenuOpen(false);
                  onCerrar(intencion.id);
                }}
                disabled={disabled}
                className="pe-intencion-card__menu-item pe-intencion-card__menu-item--danger"
              >
                <XCircle size={14} aria-hidden="true" />
                <span>
                  {t('your_encounters.intentions_action_close_v2', { defaultValue: 'Cerrar' })}
                </span>
              </button>
            </div>
          </div>
        </div>
      </article>
    );
  }

  // ── HOME V1 / RETROCOMPATIBILIDAD HISTÓRICA INTACTA ──
  return (
    <article
      className={`pe-intencion-card ${isPausada ? 'pe-intencion-card--pausada' : ''}`}
      aria-label={`Intención: ${intencion.titulo}`}
    >
      <div className="pe-intencion-card__header">
        <h3 className="pe-intencion-card__title">{intencion.titulo}</h3>
        <span
          className={`pe-intencion-card__status-badge ${
            isActiva
              ? 'pe-intencion-card__status-badge--activa'
              : 'pe-intencion-card__status-badge--pausada'
          }`}
        >
          {isActiva ? 'Activa' : 'Pausada'}
        </span>
      </div>

      {intencion.descripcion && (
        <p className="pe-intencion-card__desc">{intencion.descripcion}</p>
      )}

      <div className="pe-intencion-card__meta-row">
        {intencion.temporalidad_texto && (
          <span className="pe-intencion-card__tag" title="Cuándo">
            <Calendar size={13} aria-hidden="true" />
            <span>{intencion.temporalidad_texto}</span>
          </span>
        )}

        <span className="pe-intencion-card__tag" title="Modalidad">
          <span>{formatModalidad()}</span>
        </span>

        {intencion.localidad_nombre && (
          <span className="pe-intencion-card__tag" title="Localidad">
            <MapPin size={13} aria-hidden="true" />
            <span>{`${intencion.localidad_nombre}${intencion.localidad_ciudad ? `, ${intencion.localidad_ciudad}` : ''}`}</span>
          </span>
        )}
      </div>

      <div className="pe-intencion-card__actions">
        {canOrganizar && (
          <button
            type="button"
            onClick={() => onOrganizar!(intencion)}
            disabled={disabled}
            className="pe-intencion-card__btn pe-intencion-card__btn--organizar"
            aria-label={`Organizar encuentro a partir de ${intencion.titulo}`}
          >
            <CalendarPlus size={14} aria-hidden="true" />
            <span>Organizar encuentro</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => onEdit(intencion)}
          disabled={disabled}
          className="pe-intencion-card__btn pe-intencion-card__btn--edit"
          aria-label={`Editar intención ${intencion.titulo}`}
        >
          <Edit3 size={14} aria-hidden="true" />
          <span>Editar</span>
        </button>

        {isActiva && (
          <button
            type="button"
            onClick={() => onPausar(intencion.id)}
            disabled={disabled}
            className="pe-intencion-card__btn pe-intencion-card__btn--pause"
            aria-label={`Pausar intención ${intencion.titulo}`}
          >
            <PauseCircle size={14} aria-hidden="true" />
            <span>Pausar</span>
          </button>
        )}

        {isPausada && (
          <button
            type="button"
            onClick={() => onReactivar(intencion.id)}
            disabled={disabled}
            className="pe-intencion-card__btn pe-intencion-card__btn--reactivate"
            aria-label={`Reactivar intención ${intencion.titulo}`}
          >
            <PlayCircle size={14} aria-hidden="true" />
            <span>Reactivar</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => onCerrar(intencion.id)}
          disabled={disabled}
          className="pe-intencion-card__btn pe-intencion-card__btn--close"
          aria-label={`Cerrar intención ${intencion.titulo}`}
        >
          <XCircle size={14} aria-hidden="true" />
          <span>Cerrar</span>
        </button>
      </div>
    </article>
  );
};
