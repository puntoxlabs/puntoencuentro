import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Calendar,
  Sparkles,
  Clock,
  Bookmark,
  BookUser,
  Compass,
  Bell,
  HelpCircle,
  MessageSquare,
  ChevronRight,
} from 'lucide-react';
import './QuickNavMenu.css';

export interface QuickNavMenuProps {
  isOpen: boolean;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
  isPermanentUser: boolean;
  totalPendingRequests?: number;
  onSelectEncuentros: () => void;
  onSelectGanas: () => void;
  onSelectSolicitudes: () => void;
  onSelectFavoritos: () => void;
  onSelectMisListas: () => void;
  onSelectMeSumo: () => void;
  onSelectMisAvisos: () => void;
  onSelectHelp: () => void;
  onSelectFeedback: () => void;
}

export const QuickNavMenu: React.FC<QuickNavMenuProps> = ({
  isOpen,
  onClose,
  triggerRef,
  isPermanentUser,
  totalPendingRequests = 0,
  onSelectEncuentros,
  onSelectGanas,
  onSelectSolicitudes,
  onSelectFavoritos,
  onSelectMisListas,
  onSelectMeSumo,
  onSelectMisAvisos,
  onSelectHelp,
  onSelectFeedback,
}) => {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstFocusableRef = useRef<HTMLButtonElement | null>(null);

  // Cierre por tecla Escape y foco inicial
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        triggerRef?.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    // Enfoque accesible al abrir
    const timer = setTimeout(() => {
      if (firstFocusableRef.current) {
        firstFocusableRef.current.focus();
      }
    }, 50);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
    };
  }, [isOpen, onClose, triggerRef]);

  // Bloqueo de scroll en mobile mientras el menú está abierto
  useEffect(() => {
    if (!isOpen) return;
    const isMobile = window.innerWidth < 768;
    if (isMobile) {
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prevOverflow;
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      {/* Overlay para clic exterior */}
      <div
        className="pe-quick-nav-overlay"
        onClick={() => {
          onClose();
          triggerRef?.current?.focus();
        }}
        aria-hidden="true"
      />

      {/* Contenedor del menú (Panel desktop / Sheet mobile) */}
      <div
        id="home-quick-nav-menu"
        ref={panelRef}
        className="pe-quick-nav-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('nav_menu.title', { defaultValue: 'Navegación' })}
      >
        {/* Manija táctil visible en mobile */}
        <div className="pe-quick-nav-handle" aria-hidden="true" />

        {/* Encabezado del menú */}
        <div className="pe-quick-nav-header">
          <span className="pe-quick-nav-title">
            {t('nav_menu.title', { defaultValue: 'Navegación' })}
          </span>
          <button
            type="button"
            className="pe-quick-nav-close-btn"
            onClick={() => {
              onClose();
              triggerRef?.current?.focus();
            }}
            aria-label={t('nav_menu.close', { defaultValue: 'Cerrar menú' })}
          >
            <X size={18} />
          </button>
        </div>

        {/* Contenido scrolleable agrupado */}
        <div className="pe-quick-nav-scroll-content">
          {/* GRUPO A — MI ACTIVIDAD */}
          <div className="pe-quick-nav-group">
            <span className="pe-quick-nav-group-title">
              {t('nav_menu.group_activity', { defaultValue: 'Mi actividad' })}
            </span>

            <button
              ref={firstFocusableRef}
              type="button"
              className="pe-quick-nav-item"
              onClick={onSelectEncuentros}
            >
              <span className="pe-quick-nav-item-icon">
                <Calendar size={18} aria-hidden="true" />
              </span>
              <span className="pe-quick-nav-item-label">
                {t('your_encounters.tab_encounters_v2', { defaultValue: 'Mis encuentros' })}
              </span>
              {totalPendingRequests > 0 && (
                <span
                  className="pe-quick-nav-badge"
                  title={t('nav_menu.pending_badge', {
                    count: totalPendingRequests,
                    defaultValue: `${totalPendingRequests} pendiente`,
                  })}
                >
                  {totalPendingRequests}
                </span>
              )}
              <ChevronRight size={16} className="pe-quick-nav-chevron" aria-hidden="true" />
            </button>

            <button
              type="button"
              className="pe-quick-nav-item"
              onClick={onSelectGanas}
            >
              <span className="pe-quick-nav-item-icon">
                <Sparkles size={18} aria-hidden="true" />
              </span>
              <span className="pe-quick-nav-item-label">
                {t('your_encounters.tab_intentions_v2', { defaultValue: 'Mis ganas' })}
              </span>
              <ChevronRight size={16} className="pe-quick-nav-chevron" aria-hidden="true" />
            </button>

            <button
              type="button"
              className="pe-quick-nav-item"
              onClick={onSelectSolicitudes}
            >
              <span className="pe-quick-nav-item-icon">
                <Clock size={18} aria-hidden="true" />
              </span>
              <span className="pe-quick-nav-item-label">
                {t('your_encounters.tab_solicitudes', { defaultValue: 'Mis solicitudes' })}
              </span>
              <ChevronRight size={16} className="pe-quick-nav-chevron" aria-hidden="true" />
            </button>

            <button
              type="button"
              className="pe-quick-nav-item"
              onClick={onSelectFavoritos}
            >
              <span className="pe-quick-nav-item-icon">
                <Bookmark size={18} aria-hidden="true" />
              </span>
              <span className="pe-quick-nav-item-label">
                {t('encounter_reuse.my_space_button', { defaultValue: 'Favoritos' })}
              </span>
              {!isPermanentUser && (
                <span className="pe-quick-nav-tag-account">
                  {t('nav_menu.requires_account', { defaultValue: 'Requiere cuenta' })}
                </span>
              )}
              <ChevronRight size={16} className="pe-quick-nav-chevron" aria-hidden="true" />
            </button>

            <button
              type="button"
              className="pe-quick-nav-item"
              onClick={onSelectMisListas}
            >
              <span className="pe-quick-nav-item-icon">
                <BookUser size={18} aria-hidden="true" />
              </span>
              <span className="pe-quick-nav-item-label">
                {t('contacts.lists.my_space_button', { defaultValue: 'Mis listas' })}
              </span>
              {!isPermanentUser && (
                <span className="pe-quick-nav-tag-account">
                  {t('nav_menu.requires_account', { defaultValue: 'Requiere cuenta' })}
                </span>
              )}
              <ChevronRight size={16} className="pe-quick-nav-chevron" aria-hidden="true" />
            </button>
          </div>

          {/* GRUPO B — EXPLORAR */}
          <div className="pe-quick-nav-group">
            <span className="pe-quick-nav-group-title">
              {t('nav_menu.group_explore', { defaultValue: 'Explorar' })}
            </span>

            <button
              type="button"
              className="pe-quick-nav-item"
              onClick={onSelectMeSumo}
            >
              <span className="pe-quick-nav-item-icon">
                <Compass size={18} aria-hidden="true" />
              </span>
              <span className="pe-quick-nav-item-label">
                {t('nav_menu.explore_open', { defaultValue: 'Me sumo' })}
              </span>
              <ChevronRight size={16} className="pe-quick-nav-chevron" aria-hidden="true" />
            </button>

            <button
              type="button"
              className="pe-quick-nav-item"
              onClick={onSelectMisAvisos}
            >
              <span className="pe-quick-nav-item-icon">
                <Bell size={18} aria-hidden="true" />
              </span>
              <span className="pe-quick-nav-item-label">
                {t('avisame.tab_my_alerts', { defaultValue: 'Mis avisos' })}
              </span>
              {!isPermanentUser && (
                <span className="pe-quick-nav-tag-account">
                  {t('nav_menu.requires_account', { defaultValue: 'Requiere cuenta' })}
                </span>
              )}
              <ChevronRight size={16} className="pe-quick-nav-chevron" aria-hidden="true" />
            </button>
          </div>

          {/* GRUPO C — INFORMACIÓN */}
          <div className="pe-quick-nav-group">
            <span className="pe-quick-nav-group-title">
              {t('nav_menu.group_info', { defaultValue: 'Información' })}
            </span>

            <button
              type="button"
              className="pe-quick-nav-item"
              onClick={onSelectHelp}
            >
              <span className="pe-quick-nav-item-icon">
                <HelpCircle size={18} aria-hidden="true" />
              </span>
              <span className="pe-quick-nav-item-label">
                {t('nav_menu.help', { defaultValue: 'Cómo funciona / Ayuda' })}
              </span>
              <ChevronRight size={16} className="pe-quick-nav-chevron" aria-hidden="true" />
            </button>

            <button
              type="button"
              className="pe-quick-nav-item"
              onClick={onSelectFeedback}
            >
              <span className="pe-quick-nav-item-icon">
                <MessageSquare size={18} aria-hidden="true" />
              </span>
              <span className="pe-quick-nav-item-label">
                {t('nav_menu.feedback', { defaultValue: 'Enviar una opinión' })}
              </span>
              <ChevronRight size={16} className="pe-quick-nav-chevron" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
