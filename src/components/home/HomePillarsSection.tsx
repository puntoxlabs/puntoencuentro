import React from 'react';
import { Users, Megaphone, UserPlus, ArrowRight } from 'lucide-react';
import './HomePillarsSection.css';

interface HomePillarsSectionProps {
  onCreateClick: () => void;
  className?: string;
}

export const HomePillarsSection: React.FC<HomePillarsSectionProps> = ({
  onCreateClick,
  className = '',
}) => {
  return (
    <section className={`home-pillars-section ${className}`} aria-label="Modalidades de encuentro">
      <div className="home-pillars-grid">
        {/* Pillar 1: Crear un encuentro (ACTIVO EN PUNTOENCUENTRO 1.0) */}
        <div className="home-pillar-card home-pillar-card--active">
          <div className="home-pillar-header">
            <div className="home-pillar-icon-box home-pillar-icon-box--mint">
              <Users size={20} className="home-pillar-icon" />
            </div>
            <span className="home-pillar-status-tag home-pillar-status-tag--active">Disponible 1.0</span>
          </div>

          <div className="home-pillar-body">
            <h3 className="home-pillar-title">Crear un encuentro</h3>
            <p className="home-pillar-desc">
              Ya sabés con quién. Nosotros te ayudamos a coordinar fechas y concretarlo.
            </p>
          </div>

          <div className="home-pillar-footer">
            <button
              type="button"
              onClick={onCreateClick}
              className="home-pillar-cta home-pillar-cta--primary"
            >
              <span>Crear encuentro</span>
              <ArrowRight size={14} />
            </button>
          </div>
        </div>

        {/* Pillar 2: Abrir un encuentro (PRÓXIMAMENTE 1.5) */}
        <div className="home-pillar-card home-pillar-card--upcoming">
          <div className="home-pillar-header">
            <div className="home-pillar-icon-box home-pillar-icon-box--blue">
              <Megaphone size={20} className="home-pillar-icon" />
            </div>
            <span className="home-pillar-badge home-pillar-badge--blue">Próximamente</span>
          </div>

          <div className="home-pillar-body">
            <h3 className="home-pillar-title">Abrir un encuentro</h3>
            <p className="home-pillar-desc">
              Tenés el plan. Encontrá quién de tu círculo ampliado se suma.
            </p>
          </div>

          <div className="home-pillar-footer">
            <button
              type="button"
              disabled
              className="home-pillar-cta home-pillar-cta--disabled"
              title="Disponible en versión 1.5"
            >
              <span>Abrir encuentro</span>
              <ArrowRight size={14} />
            </button>
          </div>
        </div>

        {/* Pillar 3: Encontrar con quién (PRÓXIMAMENTE 2.0) */}
        <div className="home-pillar-card home-pillar-card--upcoming">
          <div className="home-pillar-header">
            <div className="home-pillar-icon-box home-pillar-icon-box--purple">
              <UserPlus size={20} className="home-pillar-icon" />
            </div>
            <span className="home-pillar-badge home-pillar-badge--purple">Próximamente</span>
          </div>

          <div className="home-pillar-body">
            <h3 className="home-pillar-title">Encontrar con quién</h3>
            <p className="home-pillar-desc">
              Tenés las ganas. Conectá con personas que quieren hacer lo mismo.
            </p>
          </div>

          <div className="home-pillar-footer">
            <button
              type="button"
              disabled
              className="home-pillar-cta home-pillar-cta--disabled"
              title="Disponible en versión 2.0"
            >
              <span>Explorar encuentros</span>
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
