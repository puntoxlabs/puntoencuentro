import React, { useEffect } from 'react';
import { useHomeStore } from '@/store/homeStore';
import { X } from 'lucide-react';

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
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0, 0, 0, 0.4)', zIndex: 999,
          backdropFilter: 'blur(2px)',
        }}
      />

      {/* Bottom Sheet */}
      <div
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0,
          margin: '0 auto', width: '100%', maxWidth: 520,
          background: '#fff', zIndex: 1000,
          borderTopLeftRadius: 24, borderTopRightRadius: 24,
          padding: '24px 20px 30px 20px',
          maxHeight: '85vh', overflowY: 'auto',
          boxShadow: '0 -4px 24px rgba(0,0,0,0.2)',
          display: 'flex', flexDirection: 'column',
          animation: 'slideUp 0.25s cubic-bezier(0.25, 0.8, 0.25, 1) forwards',
        }}
      >
        {/* CSS Animation */}
        <style dangerouslySetInnerHTML={{__html: `
          @keyframes slideUp {
            from { transform: translateY(100%); }
            to { transform: translateY(0); }
          }
        `}} />

        {/* Handlebar for sheet */}
        <div style={{
          width: 40, height: 4, background: 'rgba(0,0,0,0.1)',
          borderRadius: 2, alignSelf: 'center', marginBottom: 20
        }} />

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-on-surface)' }}>Filtros y Orden</h2>
          <button
            onClick={onClose}
            style={{
              background: 'var(--color-surface-variant)', border: 'none',
              borderRadius: '50%', width: 32, height: 32,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--color-on-surface)'
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Sección 1: Filtrar por Estado */}
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-on-surface-variant)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Filtrar por Estado
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {[
              { id: 'all', label: 'Todos' },
              { id: 'active', label: 'Activos' },
              { id: 'finished', label: 'Finalizados' },
              { id: 'cancelled', label: 'Cancelados' }
            ].map((opt) => {
              const isSelected = tempStatus === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => setTempStatus(opt.id as any)}
                  style={{
                    flex: '1 1 auto',
                    padding: '12px 16px', borderRadius: 12, border: isSelected ? '2px solid var(--color-primary)' : '1px solid rgba(0,0,0,0.08)',
                    background: isSelected ? 'var(--color-primary-container)' : '#fff',
                    color: isSelected ? 'var(--color-primary-dark)' : 'var(--color-on-surface)',
                    fontWeight: isSelected ? 700 : 500, fontSize: 14, cursor: 'pointer',
                    transition: 'all 0.2s ease', textAlign: 'center'
                  }}
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

        {/* Footer Acciones */}
        <div style={{ display: 'flex', gap: 12, marginTop: 'auto' }}>
          <button
            onClick={handleClear}
            style={{
              flex: 1, padding: '16px', borderRadius: 14, border: '1px solid rgba(0,0,0,0.1)',
              background: '#fff', color: 'var(--color-on-surface-variant)', fontWeight: 600,
              fontSize: 16, cursor: 'pointer', transition: 'all 0.2s ease'
            }}
          >
            Limpiar filtros
          </button>
          <button
            onClick={handleApply}
            style={{
              flex: 1, padding: '16px', borderRadius: 14, border: 'none',
              background: 'var(--color-primary)', color: '#fff', fontWeight: 600,
              fontSize: 16, cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              transition: 'all 0.2s ease'
            }}
          >
            Aplicar
          </button>
        </div>
      </div>
    </>
  );
};
