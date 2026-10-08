import React from 'react';

/**
 * HomeAmbientBrushes
 * Capa vectorial de pinceladas ambientales para Home V2 Desktop.
 * 
 * Reemplaza la técnica anterior de gradientes difusos con blur extremo por
 * trazos SVG vectoriales con geometría orgánica, tapering en extremos y curvatura.
 * 
 * Cumple estrictamente:
 * - Renderizado exclusivamente en Home V2 Desktop (>= 768px).
 * - SVG inline con aria-hidden="true", focusable="false", pointer-events: none.
 * - Fuera del flujo, posicionado absolutamente en el wrapper relativo post-hero.
 * - Pincelada A: lateral izquierdo (área Me sumo), azul marca (#2563eb / #3b82f6) a menta (#10b981),
 *   recorrido horizontal con leve inclinación ascendente, silueta de trazo alargado (~880px x 135px).
 * - Pincelada B: lateral derecho (área transición intermedia), lila (#8b5cf6 / #a855f7) a índigo (#6366f1),
 *   inclinación contraria, silueta de trazo irregular (~920px x 140px).
 * - Pincelada C secundaria: apoyo inferior tenue cerca de Crear/Abrir (~640px x 100px).
 * - Núcleo visual al 12%-18%, sin blur o blur mínimo (4px) para suavizar bordes sin perder la silueta de trazo.
 */
export const HomeAmbientBrushes: React.FC = () => {
  return (
    <div className="home-ambient-brushes-container" aria-hidden="true">
      <svg
        className="home-ambient-brushes-svg"
        viewBox="0 0 1440 1050"
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

          {/* Gradiente Pincelada C: Verde esmeralda -> Azul desaturado suave */}
          <linearGradient id="pe-brush-grad-c" x1="0%" y1="50%" x2="100%" y2="50%">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.03" />
            <stop offset="25%" stopColor="#10b981" stopOpacity="0.10" />
            <stop offset="70%" stopColor="#0ea5e9" stopOpacity="0.07" />
            <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0" />
          </linearGradient>

          {/* Filtro blur mínimo/moderado (4px) solo para suavizar el filo vectorial sin convertirlo en neblina */}
          <filter id="pe-brush-soften" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>

        {/* 
          PINCELADA A (Área "Me sumo", flanco izquierdo):
          Trazo alargado orgánico, entra desde la izquierda (-60px), leve inclinación ascendente,
          taper en la punta y cuerpo de ancho variable (~120-145px).
        */}
        <path
          d="M -50,115
             C 120,95 280,105 450,85
             C 580,70 710,50 830,42
             C 870,40 895,46 905,56
             C 912,65 895,74 855,84
             C 740,112 605,145 460,165
             C 320,185 160,205 -50,225
             Z"
          fill="url(#pe-brush-grad-a)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--a"
        />

        {/* 
          PINCELADA B (Transición intermedia, flanco derecho):
          Trazo alargado orgánico, entra desde el lateral derecho (1500px), inclinación contraria descendente/ondulada,
          taper suave en extremos y cuerpo variable (~110-140px).
        */}
        <path
          d="M 1490,440
             C 1330,425 1180,450 1020,470
             C 870,490 730,525 610,555
             C 575,564 555,575 550,586
             C 545,597 565,604 605,602
             C 725,595 860,575 1010,550
             C 1170,525 1325,510 1490,520
             Z"
          fill="url(#pe-brush-grad-b)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--b"
        />

        {/* 
          PINCELADA C (Apoyo inferior tenue cerca de "Crear o abrir"):
          Trazo secundario más contenido y de menor contraste (~620px).
        */}
        <path
          d="M -30,860
             C 110,845 250,860 380,840
             C 470,825 550,808 610,802
             C 635,800 645,806 648,814
             C 650,822 638,829 608,838
             C 515,865 405,890 290,905
             C 160,920 40,935 -30,945
             Z"
          fill="url(#pe-brush-grad-c)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--c"
        />
      </svg>
    </div>
  );
};
