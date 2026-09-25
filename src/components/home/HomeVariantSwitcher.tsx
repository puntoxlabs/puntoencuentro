import React, { useState } from 'react';
import { Sparkles, Minimize2 } from 'lucide-react';
import type { HomeVisualVariant } from './HomeDynamicCanvas';
import './HomeVariantSwitcher.css';


interface HomeVariantSwitcherProps {
  currentVariant: HomeVisualVariant;
  onVariantChange: (variant: HomeVisualVariant) => void;
}

export const HomeVariantSwitcher: React.FC<HomeVariantSwitcherProps> = ({
  currentVariant,
  onVariantChange,
}) => {
  const [isMinimized, setIsMinimized] = useState(false);

  if (isMinimized) {
    return (
      <button
        onClick={() => setIsMinimized(false)}
        className="home-variant-minimized-badge"
        title="Mostrar selector de variantes de Home (Evaluación Local)"
        aria-label="Abrir selector de variante de Home"
      >
        <Sparkles size={14} className="home-variant-badge-icon" />
        <span>
          Variante {currentVariant === 'stitch' ? 'D (Stitch)' : currentVariant === 'refinado' ? 'C (Refinado)' : currentVariant === 'visor' ? 'B (Visor)' : 'A (Envolvente)'}
        </span>
      </button>

    );
  }

  return (
    <aside
      className="home-variant-floating-bar"
      aria-label="Selector de Variantes de Diseño para Evaluación Local"
    >
      <div className="home-variant-header">
        <div className="home-variant-title-wrap">
          <Sparkles size={14} className="home-variant-icon" />
          <span className="home-variant-title">Evaluación Visual Home</span>
        </div>
        <button
          onClick={() => setIsMinimized(true)}
          className="home-variant-close-btn"
          title="Minimizar panel"
          aria-label="Minimizar panel de variantes"
        >
          <Minimize2 size={13} />
        </button>
      </div>

      <div className="home-variant-options">
        <button
          type="button"
          onClick={() => onVariantChange('envolvente')}
          className={`home-variant-btn ${currentVariant === 'envolvente' ? 'is-active' : ''}`}
          aria-pressed={currentVariant === 'envolvente'}
        >
          <div className="home-variant-btn-dot" />
          <div className="home-variant-btn-info">
            <span className="home-variant-btn-name">Variante A</span>
            <span className="home-variant-btn-desc">Movimiento Envolvente</span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onVariantChange('visor')}
          className={`home-variant-btn ${currentVariant === 'visor' ? 'is-active' : ''}`}
          aria-pressed={currentVariant === 'visor'}
        >
          <div className="home-variant-btn-dot" />
          <div className="home-variant-btn-info">
            <span className="home-variant-btn-name">Variante B</span>
            <span className="home-variant-btn-desc">Visor Dinámico</span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onVariantChange('refinado')}
          className={`home-variant-btn home-variant-btn--c ${currentVariant === 'refinado' ? 'is-active' : ''}`}
          aria-pressed={currentVariant === 'refinado'}
        >
          <div className="home-variant-btn-dot" />
          <div className="home-variant-btn-info">
            <span className="home-variant-btn-name">Variante C ✨</span>
            <span className="home-variant-btn-desc">Espacio Vivo Refinado</span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onVariantChange('stitch')}
          className={`home-variant-btn home-variant-btn--d ${currentVariant === 'stitch' ? 'is-active' : ''}`}
          aria-pressed={currentVariant === 'stitch'}
        >
          <div className="home-variant-btn-dot" />
          <div className="home-variant-btn-info">
            <span className="home-variant-btn-name">Variante D ✨</span>
            <span className="home-variant-btn-desc">Mundo Vivo Stitch</span>
          </div>
        </button>
      </div>
    </aside>

  );
};
