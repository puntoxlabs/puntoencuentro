import React from 'react';
import { Sliders } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './HomeEncountersToolbar.css';

export interface HomeEncountersToolbarProps {
  activeScope: 'todos' | 'organizo' | 'participo';
  onScopeChange: (scope: 'todos' | 'organizo' | 'participo') => void;
  isLoggedIn: boolean;
  totalTodosCount?: number;
  totalOrganizedCount?: number;
  totalParticipatedCount?: number;
  totalProximosCount?: number;
  totalPasadosCount?: number;
  activeFilterCount: number;
  onOpenFilters: () => void;
}

export const HomeEncountersToolbar: React.FC<HomeEncountersToolbarProps> = ({
  activeScope,
  onScopeChange,
  isLoggedIn: _isLoggedIn,
  totalTodosCount,
  totalOrganizedCount,
  totalParticipatedCount,
  totalProximosCount,
  totalPasadosCount,
  activeFilterCount,
  onOpenFilters,
}) => {
  const { t } = useTranslation();

  return (
    <div className="pe-toolbar-container">
      <div className="pe-toolbar-header-row">
        <h2 className="pe-toolbar-title">
          {t('your_encounters.section_title', { defaultValue: 'Tus encuentros' })}
        </h2>
        {typeof totalProximosCount === 'number' && typeof totalPasadosCount === 'number' && (
          <span className="pe-toolbar-summary-count">
            {totalProximosCount} próximo{totalProximosCount !== 1 ? 's' : ''} • {totalPasadosCount} anterior{totalPasadosCount !== 1 ? 'es' : ''}
          </span>
        )}
      </div>

      <div className="pe-toolbar-controls">
        {/* Segmented Control (Todos | Organizo | Participo) */}
        <div
          className="pe-segmented-control"
          role="tablist"
          aria-label="Filtrar por rol en el encuentro"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeScope === 'todos'}
            className={`pe-segmented-btn ${activeScope === 'todos' ? 'pe-segmented-btn--active' : ''}`}
            onClick={() => onScopeChange('todos')}
          >
            <span>{t('your_encounters.tab_all', { defaultValue: 'Todos' })}</span>
            {typeof totalTodosCount === 'number' && totalTodosCount > 0 && (
              <span className="pe-segmented-badge">{totalTodosCount}</span>
            )}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeScope === 'organizo'}
            className={`pe-segmented-btn ${activeScope === 'organizo' ? 'pe-segmented-btn--active' : ''}`}
            onClick={() => onScopeChange('organizo')}
          >
            <span>{t('your_encounters.tab_organizing', { defaultValue: 'Organizo' })}</span>
            {typeof totalOrganizedCount === 'number' && totalOrganizedCount > 0 && (
              <span className="pe-segmented-badge">{totalOrganizedCount}</span>
            )}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeScope === 'participo'}
            className={`pe-segmented-btn ${activeScope === 'participo' ? 'pe-segmented-btn--active' : ''}`}
            onClick={() => onScopeChange('participo')}
          >
            <span>{t('your_encounters.tab_participating', { defaultValue: 'Participo' })}</span>
            {typeof totalParticipatedCount === 'number' && totalParticipatedCount > 0 && (
              <span className="pe-segmented-badge">{totalParticipatedCount}</span>
            )}
          </button>
        </div>

        {/* Botón Filtrar con badge discreto si hay filtros secundarios activos */}
        <button
          type="button"
          onClick={onOpenFilters}
          className={`pe-filter-btn ${activeFilterCount > 0 ? 'pe-filter-btn--active' : ''}`}
          aria-label={
            activeFilterCount > 0
              ? `Filtros secundarios, ${activeFilterCount} activos`
              : 'Abrir filtros secundarios'
          }
        >
          <Sliders size={16} aria-hidden="true" />
          <span>{t('your_encounters.filter_btn', { defaultValue: 'Filtrar' })}</span>
          {activeFilterCount > 0 && (
            <span className="pe-filter-badge">{activeFilterCount}</span>
          )}
        </button>
      </div>
    </div>
  );
};
