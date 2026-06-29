import React, { useEffect } from 'react';
import { useHomeStore } from '@/store/homeStore';
import { X } from 'lucide-react';
import './BottomSheet.css';

interface FilterSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

export const FilterSheet: React.FC<FilterSheetProps> = ({ isOpen, onClose }) => {
  const { filterStatus, sortBy, setFilterStatus, setSortBy, resetFilters } = useHomeStore();

  // Temp states to apply only on "Aplicar"
  const [tempStatus, setTempStatus] = React.useState(filterStatus);
  const [tempSort, setTempSort] = React.useState(sortBy);

  useEffect(() => {
    if (isOpen) {
      setTempStatus(filterStatus);
      setTempSort(sortBy);
    }
  }, [isOpen, filterStatus, sortBy]);

  if (!isOpen) return null;

  const handleApply = () => {
    setFilterStatus(tempStatus);
    setSortBy(tempSort);
    onClose();
  };

  const handleClear = () => {
    resetFilters();
    setTempStatus('all');
    setTempSort('date_upcoming');
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="pe-sheet-overlay"
      />

      {/* Bottom Sheet */}
      <div className="pe-sheet-container">
        {/* Handlebar for sheet */}
        <div className="pe-sheet-handle" />

        {/* Header */}
        <div className="pe-sheet-header">
          <h2 className="pe-sheet-title">Filtros y Orden</h2>
          <button
            onClick={onClose}
            className="pe-sheet-close-btn"
          >
            <X size={18} />
          </button>
        </div>

        {/* Sección 1: Filtrar por Estado */}
        <div>
          <h3 className="pe-sheet-section-title">
            Filtrar por Estado
          </h3>
          <div className="pe-sheet-chips-group">
            {[
              { id: 'all', label: 'Todos' },
              { id: 'pending', label: 'Pendientes' },
              { id: 'confirmed', label: 'Confirmados' },
            ].map(opt => {
              const isSelected = tempStatus === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => setTempStatus(opt.id as any)}
                  className={`pe-sheet-chip ${isSelected ? 'pe-sheet-chip--selected' : 'pe-sheet-chip--unselected'}`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Sección 2: Ordenar por */}
        <div style={{ marginBottom: 32 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-on-surface-variant)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Ordenar por
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { id: 'date_upcoming', label: 'Fecha: próximos primero' },
              { id: 'date_distant', label: 'Fecha: más lejanos primero' },
              { id: 'name_asc', label: 'Nombre: A-Z' },
              { id: 'name_desc', label: 'Nombre: Z-A' }
            ].map((opt) => {
              const isSelected = tempSort === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => setTempSort(opt.id as any)}
                  style={{
                    display: 'flex', alignItems: 'center', padding: '14px 16px',
                    borderRadius: 14, border: isSelected ? '2px solid var(--color-primary)' : '1px solid rgba(0,0,0,0.08)',
                    background: isSelected ? 'var(--color-primary-container)' : '#fff',
                    color: isSelected ? 'var(--color-primary-dark)' : 'var(--color-on-surface)',
                    fontWeight: isSelected ? 700 : 500, fontSize: 14, cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                >
                  <span style={{
                    width: 18, height: 18, borderRadius: '50%',
                    border: isSelected ? '5px solid var(--color-primary)' : '2px solid rgba(0,0,0,0.2)',
                    marginRight: 12, boxSizing: 'border-box', transition: 'all 0.2s ease',
                    background: '#fff'
                  }} />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Acciones */}
        <div className="pe-sheet-buttons-row">
          <button
            onClick={handleClear}
            style={{
              flex: 1, padding: '16px', borderRadius: 14, border: '1px solid var(--color-outline-variant)',
              background: 'transparent', color: 'var(--color-on-surface-variant)', fontWeight: 600,
              fontSize: 15, cursor: 'pointer', transition: 'background 0.2s ease'
            }}
          >
            Limpiar
          </button>
          <button
            onClick={handleApply}
            style={{
              flex: 2, padding: '16px', borderRadius: 14, border: 'none',
              background: 'var(--color-primary)', color: '#fff', fontWeight: 700,
              fontSize: 16, cursor: 'pointer', transition: 'background 0.2s ease'
            }}
          >
            Aplicar
          </button>
        </div>
      </div>
    </>
  );
};
