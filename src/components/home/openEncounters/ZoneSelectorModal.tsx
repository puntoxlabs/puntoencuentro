import React, { useState, useEffect } from 'react';
import { X, Check, MapPin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Localidad } from './types';
import { DEFAULT_LOCALIDADES } from '@/constants/localidades';
import { openEncountersService } from '@/services/openEncountersService';
import './ZoneSelectorModal.css';

export interface ZoneSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedLocalityIds: string[];
  onSave: (localityIds: string[]) => void;
}

export const ZoneSelectorModal: React.FC<ZoneSelectorModalProps> = ({
  isOpen,
  onClose,
  selectedLocalityIds,
  onSave,
}) => {
  const { t } = useTranslation();
  const [localidades, setLocalidades] = useState<Localidad[]>([]);
  const [selected, setSelected] = useState<string[]>(selectedLocalityIds);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSelected(selectedLocalityIds);
  }, [selectedLocalityIds]);

  useEffect(() => {
    if (!isOpen) return;

    let mounted = true;
    setLoading(true);

    openEncountersService
      .getLocalidades()
      .then((data) => {
        if (mounted) {
          if (data && data.length > 0) {
            setLocalidades(data);
          } else {
            // Fallback catálogo local si está offline
            setLocalidades(DEFAULT_LOCALIDADES);
          }
          setLoading(false);
        }
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const toggleLocality = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSave = () => {
    onSave(selected);
    onClose();
  };

  const handleClearAll = () => {
    setSelected([]);
  };

  // Agrupar por ciudad
  const grouped = localidades.reduce((acc, loc) => {
    const city = loc.ciudad || 'Otras';
    if (!acc[city]) acc[city] = [];
    acc[city].push(loc);
    return acc;
  }, {} as Record<string, Localidad[]>);

  return (
    <>
      <div className="pe-zones-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="pe-zones-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pe-zones-title"
      >
        <div className="pe-zones-modal__header">
          <div className="pe-zones-modal__title-row">
            <MapPin size={20} className="pe-zones-modal__icon" aria-hidden="true" />
            <h2 id="pe-zones-title" className="pe-zones-modal__title">
              {t('open_encounters.zones_modal_title', { defaultValue: 'Configurar mis zonas' })}
            </h2>
          </div>
          <button
            type="button"
            className="pe-zones-modal__close-btn"
            onClick={onClose}
            aria-label="Cerrar modal"
          >
            <X size={18} />
          </button>
        </div>

        <p className="pe-zones-modal__subtitle">
          {t('open_encounters.zones_modal_subtitle', {
            defaultValue: 'Elegí los barrios o localidades donde te interesa descubrir planes y juntadas.',
          })}
        </p>

        {loading ? (
          <div className="pe-zones-modal__loading">Cargando localidades…</div>
        ) : (
          <div className="pe-zones-modal__body">
            {Object.entries(grouped).map(([city, items]) => (
              <div key={city} className="pe-zones-city-group">
                <h3 className="pe-zones-city-title">{city}</h3>
                <div className="pe-zones-chips-grid">
                  {items.map((loc) => {
                    const isChecked = selected.includes(loc.id);
                    return (
                      <button
                        key={loc.id}
                        type="button"
                        className={`pe-zone-chip ${isChecked ? 'pe-zone-chip--active' : ''}`}
                        onClick={() => toggleLocality(loc.id)}
                        aria-pressed={isChecked}
                      >
                        <span className="pe-zone-chip__check">
                          {isChecked && <Check size={14} />}
                        </span>
                        <span className="pe-zone-chip__name">{loc.nombre}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="pe-zones-modal__footer">
          <button
            type="button"
            className="pe-zones-modal__btn-clear"
            onClick={handleClearAll}
          >
            {t('open_encounters.zones_all_clear', { defaultValue: 'Desmarcar todas' })}
          </button>
          <button
            type="button"
            className="pe-zones-modal__btn-save"
            onClick={handleSave}
          >
            {t('open_encounters.zones_save', { defaultValue: 'Guardar mis zonas' })}
            {selected.length > 0 && ` (${selected.length})`}
          </button>
        </div>
      </div>
    </>
  );
};
