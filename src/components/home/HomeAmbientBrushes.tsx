import React from 'react';

/**
 * Geometrías vectoriales orgánicas compartidas de las pinceladas ambientales (Home V2 / V3-D Desktop).
 * Reutiliza las mismas curvas Bezier, gradientes y filtro gaussiano (stdDeviation="4")
 * tanto en el lienzo de secciones post-Hero como en los dos flancos del Hero V3-D desktop.
 */
const BRUSH_PATHS = {
  a: `M -140,75
      C 10,60 140,65 250,50
      C 330,38 390,26 425,20
      C 438,18 446,22 442,30
      C 436,38 418,46 385,54
      C 310,72 230,92 135,108
      C 40,124 -40,140 -140,155
      Z`,
  b: `M 2060,370
      C 1930,358 1810,374 1680,390
      C 1590,402 1530,420 1495,432
      C 1482,437 1476,444 1482,450
      C 1490,456 1506,457 1540,454
      C 1625,446 1725,432 1825,420
      C 1925,408 2000,412 2060,425
      Z`,
  c: `M -120,780
      C 0,770 120,780 230,768
      C 310,758 375,746 415,740
      C 428,738 434,742 430,748
      C 424,754 406,760 372,768
      C 300,785 210,802 120,814
      C 30,825 -45,835 -120,845
      Z`,
  d: `M -130,590
      C 0,578 120,588 230,572
      C 320,560 390,544 428,536
      C 440,532 448,537 444,544
      C 438,551 418,558 385,567
      C 305,588 215,608 120,622
      C 25,635 -45,648 -130,658
      Z`,
  e: `M 2050,670
      C 1920,658 1810,672 1690,684
      C 1610,694 1545,708 1515,718
      C 1502,723 1496,729 1504,735
      C 1512,740 1530,741 1562,738
      C 1645,730 1740,718 1840,708
      C 1930,698 1995,704 2050,715
      Z`,
  f: `M -100,310
      C 10,298 110,305 200,295
      C 260,288 310,280 345,274
      C 358,272 364,276 360,282
      C 354,290 338,298 315,306
      C 270,322 245,338 238,348
      C 234,354 238,358 244,354
      C 252,348 268,334 290,324
      C 230,344 150,358 70,368
      C -15,378 -50,385 -100,390
      Z`,
} as const;

interface BrushDefsProps {
  prefix: string;
}

const BrushDefs: React.FC<BrushDefsProps> = ({ prefix }) => (
  <defs>
    {/* Gradiente Pinceladas A y D: Azul marca -> Menta suave */}
    <linearGradient id={`${prefix}-grad-a`} x1="0%" y1="40%" x2="100%" y2="60%">
      <stop offset="0%" stopColor="#2563eb" stopOpacity="0.04" />
      <stop offset="18%" stopColor="#2563eb" stopOpacity="0.16" />
      <stop offset="55%" stopColor="#3b82f6" stopOpacity="0.13" />
      <stop offset="82%" stopColor="#10b981" stopOpacity="0.11" />
      <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
    </linearGradient>

    {/* Gradiente Pinceladas B y E: Lila/Violeta -> Índigo suave */}
    <linearGradient id={`${prefix}-grad-b`} x1="100%" y1="35%" x2="0%" y2="65%">
      <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.04" />
      <stop offset="20%" stopColor="#8b5cf6" stopOpacity="0.15" />
      <stop offset="58%" stopColor="#a855f7" stopOpacity="0.12" />
      <stop offset="85%" stopColor="#6366f1" stopOpacity="0.09" />
      <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
    </linearGradient>

    {/* Gradiente Pincelada C: Verde esmeralda -> Menta/Azul tenue */}
    <linearGradient id={`${prefix}-grad-c`} x1="0%" y1="50%" x2="100%" y2="50%">
      <stop offset="0%" stopColor="#10b981" stopOpacity="0.03" />
      <stop offset="25%" stopColor="#10b981" stopOpacity="0.10" />
      <stop offset="70%" stopColor="#0ea5e9" stopOpacity="0.07" />
      <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0" />
    </linearGradient>

    {/* Gradiente Pincelada F: Menta / Aguamarina suave -> Azul translúcido */}
    <linearGradient id={`${prefix}-grad-f`} x1="0%" y1="30%" x2="100%" y2="70%">
      <stop offset="0%" stopColor="#10b981" stopOpacity="0.03" />
      <stop offset="22%" stopColor="#14b8a6" stopOpacity="0.15" />
      <stop offset="60%" stopColor="#0ea5e9" stopOpacity="0.12" />
      <stop offset="88%" stopColor="#38bdf8" stopOpacity="0.08" />
      <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
    </linearGradient>

    {/* Filtro blur mínimo/moderado (4px) para suavizar filos sin perder la silueta de trazo */}
    <filter id={`${prefix}-soften`} x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="4" />
    </filter>
  </defs>
);

export interface HomeAmbientBrushesProps {
  /**
   * - 'sections' (default): capa ambiental post-Hero de Home V2/V3 Desktop.
   * - 'hero-v3d': par de pinceladas decorativas bajo los bloques fotográficos laterales del Hero V3-D Desktop.
   */
  variant?: 'sections' | 'hero-v3d';
}

export const HomeAmbientBrushes: React.FC<HomeAmbientBrushesProps> = ({ variant = 'sections' }) => {
  if (variant === 'hero-v3d') {
    return (
      <div
        className="home-v3d-hero-brushes"
        aria-hidden="true"
        data-testid="v3d-desktop-hero-brushes"
      >
        {/* Flanco izquierdo: debajo del bloque fotográfico de asado/reunión (reutiliza trazo F y gradiente F) */}
        <svg
          className="home-v3d-hero-brush home-v3d-hero-brush--left"
          viewBox="-90 264 464 134"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          preserveAspectRatio="none"
          focusable="false"
          aria-hidden="true"
        >
          <BrushDefs prefix="pe-v3d-hero-brush-left" />
          <path
            d={BRUSH_PATHS.f}
            fill="url(#pe-v3d-hero-brush-left-grad-f)"
            filter="url(#pe-v3d-hero-brush-left-soften)"
            className="pe-brush-path pe-brush-path--v3d-hero-left"
          />
        </svg>

        {/* Flanco derecho: debajo del conjunto de fotografías de pádel y café (reutiliza trazo B y gradiente B) */}
        <svg
          className="home-v3d-hero-brush home-v3d-hero-brush--right"
          viewBox="1466 348 584 120"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          preserveAspectRatio="none"
          focusable="false"
          aria-hidden="true"
        >
          <BrushDefs prefix="pe-v3d-hero-brush-right" />
          <path
            d={BRUSH_PATHS.b}
            fill="url(#pe-v3d-hero-brush-right-grad-b)"
            filter="url(#pe-v3d-hero-brush-right-soften)"
            className="pe-brush-path pe-brush-path--v3d-hero-right"
          />
        </svg>
      </div>
    );
  }

  return (
    <div className="home-ambient-brushes-container" aria-hidden="true">
      <svg
        className="home-ambient-brushes-svg"
        viewBox="0 0 1920 960"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="none"
        focusable="false"
        aria-hidden="true"
      >
        <BrushDefs prefix="pe-brush" />

        <path
          d={BRUSH_PATHS.a}
          fill="url(#pe-brush-grad-a)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--a"
        />

        <path
          d={BRUSH_PATHS.b}
          fill="url(#pe-brush-grad-b)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--b"
        />

        <path
          d={BRUSH_PATHS.c}
          fill="url(#pe-brush-grad-c)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--c"
        />

        <path
          d={BRUSH_PATHS.d}
          fill="url(#pe-brush-grad-a)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--d"
        />

        <path
          d={BRUSH_PATHS.e}
          fill="url(#pe-brush-grad-b)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--e"
        />

        <path
          d={BRUSH_PATHS.f}
          fill="url(#pe-brush-grad-f)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--f"
        />
      </svg>
    </div>
  );
};
