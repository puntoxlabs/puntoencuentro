import React from 'react';
import { HomeRotatingPhrase, DEFAULT_ROTATING_PHRASES } from './HomeRotatingPhrase';
import './HomeHero.css';

export interface HomeHeroProps {
  title?: string;
  subtitle?: string;
  badgeText?: string;
  isPausedByInput?: boolean;
  onPhraseClick?: (phrase: string) => void;
  phrases?: string[];
}

export const HomeHero: React.FC<HomeHeroProps> = ({
  title = '¿Qué querés hacer?',
  subtitle = 'Contanos tu idea y te ayudamos a coordinar la fecha, el lugar y la invitación.',
  badgeText = 'PLANES · PERSONAS · ENCUENTROS REALES',
  isPausedByInput = false,
  onPhraseClick,
  phrases = DEFAULT_ROTATING_PHRASES,
}) => {
  return (
    <section className="home-hero" aria-labelledby="home-hero-heading">
      {badgeText && (
        <div className="home-hero-badge">
          <span>{badgeText}</span>
        </div>
      )}

      <h1 id="home-hero-heading" className="home-hero-title" aria-label={title}>
        {title === '¿Qué querés hacer?' ? (
          <>
            <span className="sr-only">¿Qué querés hacer?</span>
            <span aria-hidden="true">
              ¿Qué querés <span className="home-hero-title-accent">hacer?</span>
            </span>
          </>
        ) : (
          title
        )}
      </h1>

      {subtitle && (
        <p className="home-hero-subtitle sr-only">
          {subtitle}
        </p>
      )}

      <div className="home-hero-rotating-container">
        <HomeRotatingPhrase
          phrases={phrases}
          isPausedByInput={isPausedByInput}
          onPhraseClick={onPhraseClick}
        />
      </div>
    </section>
  );
};
