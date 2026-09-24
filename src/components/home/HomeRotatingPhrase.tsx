import React, { useState, useEffect, useCallback } from 'react';
import { Pause, Play } from 'lucide-react';
import './HomeRotatingPhrase.css';

export const DEFAULT_ROTATING_PHRASES = [
  'Quiero invitar a mis amigos a tomar un café.',
  'Quiero organizar un partido de pádel.',
  'Quiero armar una cena con amigos este viernes.',
  'Quiero festejar mi cumpleaños.',
  'Quiero organizar un asado el sábado.',
  'Quiero juntarme a caminar con amigos.',
];

export interface HomeRotatingPhraseProps {
  phrases?: string[];
  intervalMs?: number;
  isPausedByInput?: boolean;
  className?: string;
  onPhraseClick?: (phrase: string) => void;
}

export const HomeRotatingPhrase: React.FC<HomeRotatingPhraseProps> = ({
  phrases = DEFAULT_ROTATING_PHRASES,
  intervalMs = 3500,
  isPausedByInput = false,
  className = '',
  onPhraseClick,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isManualPaused, setIsManualPaused] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Check prefers-reduced-motion
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(mediaQuery.matches);

    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    mediaQuery.addEventListener?.('change', handler);
    return () => mediaQuery.removeEventListener?.('change', handler);
  }, []);

  const totalPhrases = phrases.length;

  const goToNextPhrase = useCallback(() => {
    if (prefersReducedMotion) {
      setCurrentIndex((prev) => (prev + 1) % totalPhrases);
      return;
    }

    setIsTransitioning(true);
    // Smooth transition: 200ms exit, then switch and enter
    setTimeout(() => {
      setCurrentIndex((prev) => (prev + 1) % totalPhrases);
      setIsTransitioning(false);
    }, 220);
  }, [totalPhrases, prefersReducedMotion]);

  // Main timer
  useEffect(() => {
    if (prefersReducedMotion || isManualPaused || isPausedByInput || isHovered) {
      return;
    }

    const timer = setInterval(goToNextPhrase, intervalMs);

    // Pause when tab is not visible
    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearInterval(timer);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [prefersReducedMotion, isManualPaused, isPausedByInput, isHovered, intervalMs, goToNextPhrase]);

  const toggleManualPause = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsManualPaused((prev) => !prev);
  };

  const currentText = phrases[currentIndex] || '';
  const effectivePaused = prefersReducedMotion || isManualPaused || isPausedByInput;

  return (
    <div
      className={`home-rotating-phrase-wrapper ${className}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      aria-label="Frases inspiradoras de ejemplo"
    >
      <div className="home-rotating-phrase-slot" aria-hidden="true">
        <span
          className={`home-rotating-phrase-text ${isTransitioning ? 'home-rotating-phrase-text--exit' : 'home-rotating-phrase-text--enter'} ${onPhraseClick ? 'home-rotating-phrase-text--clickable' : ''}`}
          onClick={() => onPhraseClick?.(currentText)}
          title={onPhraseClick ? 'Tocar para usar esta idea' : undefined}
        >
          <span className="home-rotating-phrase-quote">&ldquo;</span>
          {currentText}
          <span className="home-rotating-phrase-quote">&rdquo;</span>
        </span>
      </div>

      {/* Accessible discrete control button */}
      {!prefersReducedMotion && (
        <button
          type="button"
          onClick={toggleManualPause}
          className="home-rotating-phrase-btn"
          aria-label={isManualPaused ? 'Reanudar rotación de frases' : 'Pausar rotación de frases'}
          title={isManualPaused ? 'Reanudar rotación' : 'Pausar rotación'}
        >
          {isManualPaused ? (
            <Play size={12} className="home-rotating-phrase-icon" />
          ) : (
            <Pause size={12} className="home-rotating-phrase-icon" />
          )}
        </button>
      )}

      {/* Visually hidden text for screen readers (only reads once, avoids annoying repetitive announcements) */}
      <span className="sr-only">
        Idea sugerida: {currentText}. {effectivePaused ? '(Rotación pausada)' : ''}
      </span>
    </div>
  );
};
