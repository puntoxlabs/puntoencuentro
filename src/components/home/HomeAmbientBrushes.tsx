import React from 'react';

/**
 * HomeAmbientBrushes
 * Capa vectorial de pinceladas ambientales para Home V2 Desktop.
 * 
 * Lógica de composición FULL-BLEED LATERAL para resoluciones 1440px y 1920px:
 * - Acompaña el lenguaje expansivo del carrusel "Me sumo", naciendo y muriendo fuera del viewport.
 * - En resoluciones amplias (1920px+), el viewBox amplio (1920x960) y las coordenadas ancladas
 *   a los laterales (0px y 1920px+) proyectan los trazos hacia los bordes de pantalla.
 * - El centro funcional (los 1100px centrales: aprox. x=410 a x=1510 en un lienzo de 1920)
 *   permanece 100% limpio y libre de invasiones:
 *     * Pinceladas del flanco izquierdo (A, C, D, F) se afinan antes de x=450.
 *     * Pinceladas del flanco derecho (B, E) se proyectan hacia la derecha y no avanzan antes de x=1460.
 * - Cero interferencia con títulos, tabs, filtros, cards, loaders, empty state o el FAB.
 * - SVG inline con aria-hidden="true", focusable="false", pointer-events: none.
 */
export const HomeAmbientBrushes: React.FC = () => {
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
        <defs>
          {/* Gradiente Pinceladas A y D: Azul marca -> Menta suave */}
          <linearGradient id="pe-brush-grad-a" x1="0%" y1="40%" x2="100%" y2="60%">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.04" />
            <stop offset="18%" stopColor="#2563eb" stopOpacity="0.16" />
            <stop offset="55%" stopColor="#3b82f6" stopOpacity="0.13" />
            <stop offset="82%" stopColor="#10b981" stopOpacity="0.11" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
          </linearGradient>

          {/* Gradiente Pinceladas B y E: Lila/Violeta -> Índigo suave */}
          <linearGradient id="pe-brush-grad-b" x1="100%" y1="35%" x2="0%" y2="65%">
            <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.04" />
            <stop offset="20%" stopColor="#8b5cf6" stopOpacity="0.15" />
            <stop offset="58%" stopColor="#a855f7" stopOpacity="0.12" />
            <stop offset="85%" stopColor="#6366f1" stopOpacity="0.09" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
          </linearGradient>

          {/* Gradiente Pincelada C: Verde esmeralda -> Menta/Azul tenue */}
          <linearGradient id="pe-brush-grad-c" x1="0%" y1="50%" x2="100%" y2="50%">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.03" />
            <stop offset="25%" stopColor="#10b981" stopOpacity="0.10" />
            <stop offset="70%" stopColor="#0ea5e9" stopOpacity="0.07" />
            <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0" />
          </linearGradient>

          {/* Gradiente Pincelada F: Menta / Aguamarina suave -> Azul translúcido */}
          <linearGradient id="pe-brush-grad-f" x1="0%" y1="30%" x2="100%" y2="70%">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.03" />
            <stop offset="22%" stopColor="#14b8a6" stopOpacity="0.15" />
            <stop offset="60%" stopColor="#0ea5e9" stopOpacity="0.12" />
            <stop offset="88%" stopColor="#38bdf8" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
          </linearGradient>

          {/* Filtro blur mínimo/moderado (4px) para suavizar filos sin perder la silueta de trazo */}
          <filter id="pe-brush-soften" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>

        {/* 
          PINCELADA A (Vacío superior izquierdo / margen exterior de "Me sumo"):
          Nace fuera del viewport en el extremo izquierdo (-140px), acompaña la entrada superior
          con curvatura orgánica full-bleed y se afina terminando en x=420px (sin invadir el carril central).
          Largo visual: ~580px, alto variable: ~90-125px.
        */}
        <path
          d="M -140,75
             C 10,60 140,65 250,50
             C 330,38 390,26 425,20
             C 438,18 446,22 442,30
             C 436,38 418,46 385,54
             C 310,72 230,92 135,108
             C 40,124 -40,140 -140,155
             Z"
          fill="url(#pe-brush-grad-a)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--a"
        />

        {/* 
          PINCELADA B (Vacío lateral derecho intermedio / margen exterior de la transición):
          Nace fuera del viewport en el lateral derecho expansivo (2060px), avanza hacia el interior
          hasta x=1480px, poblando el amplio vacío lateral derecho de 1920/1440px y deteniéndose
          completamente antes del eje funcional de cards y tabs (que termina en x=1470px aprox).
          Largo visual: ~600px, alto variable: ~90-120px.
        */}
        <path
          d="M 2060,370
             C 1930,358 1810,374 1680,390
             C 1590,402 1530,420 1495,432
             C 1482,437 1476,444 1482,450
             C 1490,456 1506,457 1540,454
             C 1625,446 1725,432 1825,420
             C 1925,408 2000,412 2060,425
             Z"
          fill="url(#pe-brush-grad-b)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--b"
        />

        {/* 
          PINCELADA C (Vacío inferior izquierdo libre / margen exterior de "Crear o abrir"):
          Apoyo ambiental tenue en el margen blanco inferior izquierdo. Nace bien afuera (-120px),
          proyectándose hacia adentro hasta x=410px sin cruzar el eje central ni tocar la caja de Crear o abrir.
          Largo visual: ~540px, alto variable: ~75-100px.
        */}
        <path
          d="M -120,780
             C 0,770 120,780 230,768
             C 310,758 375,746 415,740
             C 428,738 434,742 430,748
             C 424,754 406,760 372,768
             C 300,785 210,802 120,814
             C 30,825 -45,835 -120,845
             Z"
          fill="url(#pe-brush-grad-c)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--c"
        />

        {/* 
          PINCELADA D (Vacío lateral izquierdo central-bajo):
          Ubicada en el espacio blanco lateral izquierdo entre el final de "Tus encuentros" y "Crear o abrir".
          Nace fuera de pantalla en el flanco izquierdo (-130px) y recorre el lateral hasta x=430px,
          respirando con amplitud en resoluciones 1440/1920 sin tocar el contenido central.
          Largo visual: ~570px, alto variable: ~85-110px.
        */}
        <path
          d="M -130,590
             C 0,578 120,588 230,572
             C 320,560 390,544 428,536
             C 440,532 448,537 444,544
             C 438,551 418,558 385,567
             C 305,588 215,608 120,622
             C 25,635 -45,648 -130,658
             Z"
          fill="url(#pe-brush-grad-a)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--d"
        />

        {/* 
          PINCELADA E (Vacío lateral derecho de la zona previa a "Crear o abrir"):
          Ubicada en el lateral derecho adyacente a la transición hacia "Crear o abrir".
          Nace fuera del viewport derecho (2050px) y se proyecta hacia la izquierda deteniéndose en x=1500px,
          dejando despejado el carril central y sin competir con el FAB fijado en la esquina inferior derecha.
          Largo visual: ~560px, alto variable: ~80-105px.
        */}
        <path
          d="M 2050,670
             C 1920,658 1810,672 1690,684
             C 1610,694 1545,708 1515,718
             C 1502,723 1496,729 1504,735
             C 1512,740 1530,741 1562,738
             C 1645,730 1740,718 1840,708
             C 1930,698 1995,704 2050,715
             Z"
          fill="url(#pe-brush-grad-b)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--e"
        />

        {/* 
          PINCELADA F (Vacío superior izquierdo de actividad personal):
          Ubicada específicamente en el vacío lateral que queda a la izquierda del inicio de
          "Tus encuentros / Mis ganas" (y=320px): entre el borde izquierdo del viewport/contenedor,
          la línea superior de la sección y el listado de cards.
          Nace fuera de la pantalla en -100px, con un trazo más corto y orgánico (~460px de largo),
          curvatura suave con leve conicidad que finaliza en x=360px con mini-cola orgánica y goteo muy sutil.
          Color: Menta / Aguamarina suave -> Azul tenue, núcleo al 12%-15% con filtro suave de 4px.
        */}
        <path
          d="M -100,310
             C 10,298 110,305 200,295
             C 260,288 310,280 345,274
             C 358,272 364,276 360,282
             C 354,290 338,298 315,306
             C 270,322 245,338 238,348
             C 234,354 238,358 244,354
             C 252,348 268,334 290,324
             C 230,344 150,358 70,368
             C -15,378 -50,385 -100,390
             Z"
          fill="url(#pe-brush-grad-f)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--f"
        />
      </svg>
    </div>
  );
};
