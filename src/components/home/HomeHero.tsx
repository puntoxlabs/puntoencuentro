import React from 'react';
import './HomeHero.css';

interface HomeHeroProps {
  title?: string;
  subtitle?: string;
  badgeText?: string;
}

export const HomeHero: React.FC<HomeHeroProps> = ({
  title = '¿Qué querés hacer?',
  subtitle = 'Contanos tu idea y te ayudamos a coordinar la fecha, el lugar y la invitación.',
  badgeText,
}) => {
  return (
    <section className="home-hero" aria-labelledby="home-hero-heading">
      {badgeText && (
        <div className="home-hero-badge">
          <span>{badgeText}</span>
        </div>
      )}
      <h1 id="home-hero-heading" className="home-hero-title">
        {title}
      </h1>
      {subtitle && (
        <p className="home-hero-subtitle">
          {subtitle}
        </p>
      )}
    </section>
  );
};
