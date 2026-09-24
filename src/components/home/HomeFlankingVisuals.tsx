import React, { useState } from 'react';
import { Check } from 'lucide-react';
import './HomeFlankingVisuals.css';

interface HomeFlankingVisualsProps {
  isInputFocused?: boolean;
}

export const HomeFlankingVisuals: React.FC<HomeFlankingVisualsProps> = ({
  isInputFocused = false,
}) => {
  const [imageError, setImageError] = useState(false);

  return (
    <>
      {/* ── MOBILE COMPACT BANNER (Visible on mobile/tablet, hidden on desktop >= 1024px) ── */}
      <div
        className={`home-mobile-visual-banner ${isInputFocused ? 'home-mobile-visual-banner--collapsed' : ''}`}
        aria-hidden="true"
      >
        <div className="home-mobile-visual-card">
          {!imageError ? (
            <img
              src="/images/home-hero.webp"
              alt="Encuentro de amigos"
              className="home-mobile-visual-img"
              onError={() => setImageError(true)}
              loading="eager"
            />
          ) : (
            <div className="home-mobile-visual-fallback" />
          )}

          <div className="home-mobile-visual-overlay" />

          <div className="home-visual-doodle home-visual-doodle--mobile">
            De ganas a encuentros ✨
          </div>

          <div className="home-floating-status-pill home-floating-status-pill--mobile">
            <div className="home-status-pill-left">
              <span className="home-status-pill-emoji">🍕</span>
              <div>
                <span className="home-status-pill-title">Asado este sábado</span>
                <span className="home-status-pill-meta">4 personas</span>
              </div>
            </div>
            <span className="home-status-pill-badge">Confirmado ✔</span>
          </div>
        </div>
      </div>

      {/* ── DESKTOP FLANKING VISUALS (Visible on desktop >= 1024px, hidden on mobile) ── */}
      <div className="home-desktop-flanks-wrapper" aria-hidden="true">
        {/* Left Flank */}
        <aside className="home-desktop-flank home-desktop-flank--left">
          <div className="home-visual-doodle home-visual-doodle--left">
            De ganas a encuentros ✨
          </div>

          <div className="home-desktop-photo-card home-desktop-photo-card--primary">
            {!imageError ? (
              <img
                src="/images/home-hero.webp"
                alt="Amigos compartiendo un asado"
                className="home-desktop-photo-img"
                onError={() => setImageError(true)}
                loading="eager"
              />
            ) : (
              <div className="home-desktop-photo-fallback" />
            )}

            <div className="home-floating-status-pill home-floating-status-pill--desktop-left">
              <div className="home-status-pill-avatars">
                <div className="home-status-pill-avatar home-status-pill-avatar--1">MR</div>
                <div className="home-status-pill-avatar home-status-pill-avatar--2">JC</div>
              </div>
              <div className="home-status-pill-info">
                <span className="home-status-pill-title">Asado este sábado</span>
                <span className="home-status-pill-meta">4 personas · Confirmado</span>
              </div>
              <div className="home-status-pill-check">
                <Check size={12} strokeWidth={3} />
              </div>
            </div>
          </div>
        </aside>

        {/* Right Flank */}
        <aside className="home-desktop-flank home-desktop-flank--right">
          <div className="home-visual-doodle home-visual-doodle--right">
            Más planes reales 🌱
          </div>

          {/* Top card: Pádel */}
          <div className="home-desktop-photo-card home-desktop-photo-card--padel">
            <div className="home-desktop-card-bg-padel">
              <span className="home-padel-icon">🎾</span>
            </div>
            <div className="home-floating-status-pill home-floating-status-pill--desktop-padel">
              <span className="home-status-pill-avatar-icon">🎾</span>
              <div className="home-status-pill-info">
                <span className="home-status-pill-title">Pádel</span>
                <span className="home-status-pill-meta">Se suma 1 persona más</span>
              </div>
            </div>
          </div>

          {/* Bottom card: Café */}
          <div className="home-desktop-photo-card home-desktop-photo-card--cafe">
            <div className="home-desktop-card-bg-cafe">
              <span className="home-cafe-icon">☕</span>
            </div>
            <div className="home-floating-status-pill home-floating-status-pill--desktop-cafe">
              <span className="home-status-pill-avatar-icon">☕</span>
              <div className="home-status-pill-info">
                <span className="home-status-pill-title">Café esta semana</span>
                <span className="home-status-pill-meta">3 personas · En organización</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
};
