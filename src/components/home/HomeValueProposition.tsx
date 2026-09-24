import React from 'react';
import './HomeValueProposition.css';

interface HomeValuePropositionProps {
  className?: string;
}

export const HomeValueProposition: React.FC<HomeValuePropositionProps> = ({ className = '' }) => {
  return (
    <section className={`home-value-prop ${className}`} aria-label="Cómo funciona PuntoEncuentro">
      <div className="home-value-prop-header">
        <h2 className="home-value-prop-title">Organizar un encuentro es simple</h2>
        <p className="home-value-prop-subtitle">Sin cadenas eternas de mensajes ni planillas</p>
      </div>

      <div className="home-value-prop-steps">
        <div className="home-value-prop-step">
          <div className="home-value-prop-step-num">1</div>
          <div className="home-value-prop-step-content">
            <span className="home-value-prop-step-title">Escribí qué querés hacer</span>
            <span className="home-value-prop-step-desc">
              En tus propias palabras: cena, asado, salida o reunión.
            </span>
          </div>
        </div>

        <div className="home-value-prop-step">
          <div className="home-value-prop-step-num">2</div>
          <div className="home-value-prop-step-content">
            <span className="home-value-prop-step-title">Elegí la fecha o proponé opciones</span>
            <span className="home-value-prop-step-desc">
              Fijá un día o coordiná entre varios horarios con tus invitados.
            </span>
          </div>
        </div>

        <div className="home-value-prop-step">
          <div className="home-value-prop-step-num">3</div>
          <div className="home-value-prop-step-content">
            <span className="home-value-prop-step-title">Compartí la invitación</span>
            <span className="home-value-prop-step-desc">
              Tus amigos confirman en un toque, sin registrarse ni descargar nada.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};
