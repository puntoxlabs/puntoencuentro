import React, { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './HomeEncountersFilterSheet.css';

export interface EncountersFilterValues {
  timeFilter: 'upcoming' | 'past' | 'all';
  filterType: 'all' | 'fixed' | 'coordination';
  filterCoordinationState: 'all' | 'open' | 'expired' | 'closed';
  sortBy: 'date_upcoming' | 'date_distant' | 'name_asc' | 'name_desc';
}

export const DEFAULT_FILTER_VALUES: EncountersFilterValues = {
  timeFilter: 'upcoming',
  filterType: 'all',
  filterCoordinationState: 'all',
  sortBy: 'date_upcoming',
};

export function countActiveSecondaryFilters(values: EncountersFilterValues): number {
  let count = 0;
  if (values.timeFilter !== DEFAULT_FILTER_VALUES.timeFilter) count++;
  if (values.filterType !== DEFAULT_FILTER_VALUES.filterType) count++;
  if (values.filterCoordinationState !== DEFAULT_FILTER_VALUES.filterCoordinationState) count++;
  if (values.sortBy !== DEFAULT_FILTER_VALUES.sortBy) count++;
  return count;
}

export interface HomeEncountersFilterSheetProps {
  isOpen: boolean;
  filters: EncountersFilterValues;
  onApply: (newFilters: EncountersFilterValues) => void;
  onClose: () => void;
}

export const HomeEncountersFilterSheet: React.FC<HomeEncountersFilterSheetProps> = ({
  isOpen,
  filters,
  onApply,
  onClose,
}) => {
  const { t } = useTranslation();
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const [tempFilters, setTempFilters] = useState<EncountersFilterValues>(filters);

  useEffect(() => {
    if (isOpen) {
      setTempFilters(filters);
      setTimeout(() => {
        closeBtnRef.current?.focus();
      }, 50);
    }
  }, [isOpen, filters]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleClear = () => {
    setTempFilters(DEFAULT_FILTER_VALUES);
  };

  const handleApplyClick = () => {
    onApply(tempFilters);
    onClose();
  };

  return (
    <>
      <div className="pe-filter-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="pe-filter-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pe-filter-title"
      >
        <div className="pe-filter-sheet__handle" aria-hidden="true" />

        <div className="pe-filter-sheet__header">
          <h2 id="pe-filter-title" className="pe-filter-sheet__title">
            {t('your_encounters.filters_title', { defaultValue: 'Filtros y orden' })}
          </h2>
          <button
            ref={closeBtnRef}
            type="button"
            className="pe-filter-sheet__close-btn"
            onClick={onClose}
            aria-label="Cerrar filtros"
          >
            <X size={18} />
          </button>
        </div>

        {/* 1. MOMENTO */}
        <div className="pe-filter-section">
          <h3 className="pe-filter-section__title">
            {t('your_encounters.filter_timing', { defaultValue: 'Momento' })}
          </h3>
          <div className="pe-filter-chips-row">
            {[
              { id: 'upcoming', label: t('your_encounters.filter_timing_upcoming', { defaultValue: 'Próximos' }) },
              { id: 'past', label: t('your_encounters.filter_timing_past', { defaultValue: 'Anteriores' }) },
              { id: 'all', label: t('your_encounters.filter_timing_all', { defaultValue: 'Todos' }) },
            ].map(item => {
              const isSelected = tempFilters.timeFilter === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTempFilters(prev => ({ ...prev, timeFilter: item.id as any }))}
                  className={`pe-filter-chip ${isSelected ? 'pe-filter-chip--selected' : ''}`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 2. TIPO DE ENCUENTRO */}
        <div className="pe-filter-section">
          <h3 className="pe-filter-section__title">
            {t('your_encounters.filter_type', { defaultValue: 'Tipo' })}
          </h3>
          <div className="pe-filter-chips-row">
            {[
              { id: 'all', label: t('your_encounters.filter_type_all', { defaultValue: 'Todos' }) },
              { id: 'fixed', label: t('your_encounters.filter_type_fixed', { defaultValue: 'Fecha definida' }) },
              { id: 'coordination', label: t('your_encounters.filter_type_coordination', { defaultValue: 'Coordinación' }) },
            ].map(item => {
              const isSelected = tempFilters.filterType === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() =>
                    setTempFilters(prev => ({
                      ...prev,
                      filterType: item.id as any,
                      filterCoordinationState: item.id !== 'coordination' ? 'all' : prev.filterCoordinationState,
                    }))
                  }
                  className={`pe-filter-chip ${isSelected ? 'pe-filter-chip--selected' : ''}`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 3. ESTADO DE COORDINACIÓN (Condicional a Tipo = Coordinación) */}
        {tempFilters.filterType === 'coordination' && (
          <div className="pe-filter-section">
            <h3 className="pe-filter-section__title">
              {t('your_encounters.filter_coord_state', { defaultValue: 'Estado de coordinación' })}
            </h3>
            <div className="pe-filter-chips-row">
              {[
                { id: 'all', label: t('your_encounters.filter_coord_all', { defaultValue: 'Todos' }) },
                { id: 'open', label: t('your_encounters.filter_coord_open', { defaultValue: 'A coordinar' }) },
                { id: 'expired', label: t('your_encounters.filter_coord_expired', { defaultValue: 'Plazo vencido' }) },
                { id: 'closed', label: t('your_encounters.filter_coord_closed', { defaultValue: 'Fecha confirmada' }) },
              ].map(item => {
                const isSelected = tempFilters.filterCoordinationState === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() =>
                      setTempFilters(prev => ({
                        ...prev,
                        filterCoordinationState: item.id as any,
                      }))
                    }
                    className={`pe-filter-chip ${isSelected ? 'pe-filter-chip--selected' : ''}`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 4. ORDEN */}
        <div className="pe-filter-section">
          <h3 className="pe-filter-section__title">
            {t('your_encounters.sort_by', { defaultValue: 'Ordenar por' })}
          </h3>
          {[
            { id: 'date_upcoming', label: t('your_encounters.sort_upcoming', { defaultValue: 'Fecha: próximos primero' }) },
            { id: 'date_distant', label: t('your_encounters.sort_distant', { defaultValue: 'Fecha: más lejanos primero' }) },
            { id: 'name_asc', label: t('your_encounters.sort_name_asc', { defaultValue: 'Nombre: A-Z' }) },
            { id: 'name_desc', label: t('your_encounters.sort_name_desc', { defaultValue: 'Nombre: Z-A' }) },
          ].map(opt => {
            const isSelected = tempFilters.sortBy === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setTempFilters(prev => ({ ...prev, sortBy: opt.id as any }))}
                className={`pe-sort-option ${isSelected ? 'pe-sort-option--selected' : ''}`}
              >
                <span className="pe-sort-radio">
                  {isSelected && <span className="pe-sort-radio-inner" />}
                </span>
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>

        {/* Acciones */}
        <div className="pe-filter-actions">
          <button
            type="button"
            className="pe-filter-btn-clear"
            onClick={handleClear}
          >
            {t('your_encounters.clear_filters', { defaultValue: 'Limpiar filtros' })}
          </button>
          <button
            type="button"
            className="pe-filter-btn-apply"
            onClick={handleApplyClick}
          >
            {t('your_encounters.apply_filters', { defaultValue: 'Aplicar' })}
          </button>
        </div>
      </div>
    </>
  );
};
