import React from 'react';

/**
 * HomeAmbientBrushes
 * Capa vectorial de pinceladas ambientales para Home V2 Desktop.
 * 
 * Composición orgánica basada en el VACÍO REAL de la Home:
 * - Ocupa huecos blancos laterales y zonas de transición libres.
 * - Despeja el centro funcional (títulos, loading states, empty states, tabs, filtros, CTA).
 * - Exactamente 2 pinceladas principales:
 *   1. Pincelada A: Azul marca -> Menta suave (área lateral/vacío superior izquierdo).
 *   2. Pincelada B: Lila -> Índigo suave (área lateral/vacío derecho en transición).
 *   (Se eliminó la tercera pincelada inferior para preservar aire y evitar ruidos aislados).
 * - SVG inline con aria-hidden="true", focusable="false", pointer-events: none.
 */
export const HomeAmbientBrushes: React.FC = () => {
  return (
    <div className="home-ambient-brushes-container" aria-hidden="true">
      <svg
        className="home-ambient-brushes-svg"
        viewBox="0 0 1440 900"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="none"
        focusable="false"
        aria-hidden="true"
      >
        <defs>
          {/* Gradiente Pincelada A: Azul marca -> Menta suave */}
          <linearGradient id="pe-brush-grad-a" x1="0%" y1="40%" x2="100%" y2="60%">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.04" />
            <stop offset="18%" stopColor="#2563eb" stopOpacity="0.16" />
            <stop offset="55%" stopColor="#3b82f6" stopOpacity="0.13" />
            <stop offset="82%" stopColor="#10b981" stopOpacity="0.11" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
          </linearGradient>

          {/* Gradiente Pincelada B: Lila/Violeta -> Índigo suave */}
          <linearGradient id="pe-brush-grad-b" x1="100%" y1="35%" x2="0%" y2="65%">
            <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.04" />
            <stop offset="20%" stopColor="#8b5cf6" stopOpacity="0.15" />
            <stop offset="58%" stopColor="#a855f7" stopOpacity="0.12" />
            <stop offset="85%" stopColor="#6366f1" stopOpacity="0.09" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
          </linearGradient>

          {/* Filtro blur mínimo/moderado (4px) para suavizar filos sin perder la silueta de trazo */}
          <filter id="pe-brush-soften" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>

        {/* 
          PINCELADA A (Flanco izquierdo exterior / espacio libre alrededor de Me sumo):
          Nace fuera de pantalla en el flanco izquierdo (-90px), recorre el margen blanco
          con inclinación orgánica y se afina antes de interferir con el eje funcional central.
          Largo visual: ~800px, alto variable: ~120-140px.
        */}
        <path
          d="M -90,75
             C 80,55 240,65 410,45
             C 540,30 670,10 790,2
             C 830,0 855,6 865,16
             C 872,25 855,34 815,44
             C 700,72 565,105 420,125
             C 280,145 120,165 -90,185
             Z"
          fill="url(#pe-brush-grad-a)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--a"
        />

        {/* 
          PINCELADA B (Flanco derecho exterior / transición intermedia):
          Nace fuera de pantalla en el flanco derecho (1530px), entra ocupando el vacío blanco lateral
          entre las macrosecciones sin invadir el centro (cards, tabs, filtros o empty/loading states).
          Largo visual: ~840px, alto variable: ~110-135px.
        */}
        <path
          d="M 1530,370
             C 1370,355 1220,380 1060,400
             C 910,420 780,455 670,485
             C 635,494 615,505 610,516
             C 605,527 625,534 665,532
             C 785,525 920,505 1070,480
             C 1230,455 1385,440 1530,450
             Z"
          fill="url(#pe-brush-grad-b)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--b"
        />
      </svg>
    </div>
  );
};
