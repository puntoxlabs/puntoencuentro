import React from 'react';

/**
 * HomeAmbientBrushes
 * Capa vectorial de pinceladas ambientales para Home V2 Desktop.
 * 
 * Composición orgánica basada estrictamente en los VACÍOS REALES de la Home:
 * - Pincelada A: Azul marca -> Menta suave.
 *   Ubicada en el vacío superior izquierdo acompañando el inicio del bloque "Me sumo".
 *   Nace fuera del viewport (-90px) y se afina hacia adentro sin cruzar el eje central.
 * 
 * - Pincelada B: Lila -> Índigo suave.
 *   Ubicada en el vacío lateral derecho intermedio, en la transición entre "Tengo ganas de..."
 *   y la actividad personal, sin cruzar tabs, filtros, CTA, loaders ni el empty state.
 * 
 * - Pincelada C: Verde esmeralda -> Menta/Azul tenue.
 *   Apoyo atmosférico muy sutil en el vacío inferior izquierdo, cerca de "Crear o abrir un encuentro",
 *   acompañando el margen libre inferior sin interferir en el centro de lectura.
 * 
 * - Pincelada D: Azul marca -> Menta suave.
 *   Ubicada en el vacío lateral izquierdo central-bajo: debajo de Tus encuentros / Mis ganas + filtros
 *   y por encima/alrededor de Crear o abrir un encuentro, sin pasar por debajo del contenido principal.
 * 
 * - Pincelada E: Lila / Violeta suave -> Índigo.
 *   Ubicada en el vacío lateral derecho de la zona del empty state / previa a Crear o abrir,
 *   llenando aire lateral sin invadir el centro ni competir con el FAB.
 * 
 * - Centro funcional 100% limpio (cero interferencia con textos, cards, empty states, botones).
 * - SVG inline con aria-hidden="true", focusable="false", pointer-events: none.
 */
export const HomeAmbientBrushes: React.FC = () => {
  return (
    <div className="home-ambient-brushes-container" aria-hidden="true">
      <svg
        className="home-ambient-brushes-svg"
        viewBox="0 0 1440 960"
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

          {/* Filtro blur mínimo/moderado (4px) para suavizar filos sin perder la silueta de trazo */}
          <filter id="pe-brush-soften" x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>

        {/* 
          PINCELADA A (Vacío superior izquierdo libre / margen exterior de "Me sumo"):
          Nace fuera del viewport en el flanco izquierdo (-90px), acompaña la entrada superior
          con curvatura orgánica y se afina a ~420px de la pantalla antes de acercarse al contenido central.
          Largo visual: ~530px, alto variable: ~90-120px.
        */}
        <path
          d="M -90,75
             C 40,60 160,65 270,50
             C 340,40 400,28 430,22
             C 445,19 455,23 452,30
             C 448,37 430,44 400,52
             C 330,70 250,90 160,105
             C 70,120 0,135 -90,150
             Z"
          fill="url(#pe-brush-grad-a)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--a"
        />

        {/* 
          PINCELADA B (Vacío lateral derecho intermedio / margen exterior de la transición):
          Nace en el lateral exterior derecho (1530px), entra solo hasta el margen libre derecho (1020px),
          manteniéndose a más de 300px fuera del contenedor central de cards/tabs/empty state (máx 1100px centrado).
          Largo visual: ~510px, alto variable: ~85-115px.
        */}
        <path
          d="M 1530,370
             C 1420,358 1310,375 1200,390
             C 1120,402 1060,420 1030,432
             C 1018,437 1012,444 1018,450
             C 1025,456 1040,457 1070,454
             C 1150,446 1240,432 1330,420
             C 1420,408 1485,412 1530,425
             Z"
          fill="url(#pe-brush-grad-b)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--b"
        />

        {/* 
          PINCELADA C (Vacío inferior izquierdo libre / margen exterior de "Crear o abrir"):
          Apoyo ambiental tenue en el margen blanco inferior izquierdo. Nace fuera de pantalla (-70px),
          se extiende hacia el interior sin cruzar el eje central ni tocar la caja de Crear o abrir.
          Largo visual: ~480px, alto variable: ~70-95px.
        */}
        <path
          d="M -70,780
             C 30,770 130,780 220,768
             C 290,758 350,746 395,740
             C 412,738 418,742 415,748
             C 410,754 395,760 365,768
             C 300,785 220,802 140,814
             C 60,825 -10,835 -70,845
             Z"
          fill="url(#pe-brush-grad-c)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--c"
        />

        {/* 
          PINCELADA D (Vacío lateral izquierdo central-bajo):
          Ubicada en el espacio blanco lateral izquierdo que queda debajo del bloque
          "Tus encuentros / Mis ganas" + filtros y por encima/alrededor de "Crear o abrir".
          Nace fuera de la pantalla en -80px, avanza de forma ascendente-ondulada hasta ~410px,
          permaneciendo en el margen lateral exterior sin tocar el contenido central.
          Largo visual: ~490px, alto variable: ~80-105px.
        */}
        <path
          d="M -80,590
             C 35,578 140,588 235,572
             C 310,560 375,544 408,536
             C 422,532 430,537 426,544
             C 420,551 402,558 372,567
             C 302,588 220,608 135,622
             C 50,635 -15,648 -80,658
             Z"
          fill="url(#pe-brush-grad-a)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--d"
        />

        {/* 
          PINCELADA E (Vacío lateral derecho de la zona previa a "Crear o abrir"):
          Ubicada en el lateral derecho adyacente al empty state / transición hacia "Crear o abrir",
          equilibrando visualmente la composición respecto al lateral izquierdo.
          Nace fuera de la pantalla en 1520px y se proyecta hacia la izquierda deteniéndose en 1050px,
          dejando un margen libre de más de 200px respecto al eje central y sin interferir con el FAB
          (que se sitúa en la esquina inferior derecha fija).
          Largo visual: ~470px, alto variable: ~75-100px.
        */}
        <path
          d="M 1520,670
             C 1410,658 1315,672 1215,684
             C 1145,694 1090,708 1062,718
             C 1050,723 1045,729 1052,735
             C 1058,740 1074,741 1102,738
             C 1175,730 1260,718 1345,708
             C 1425,698 1480,704 1520,715
             Z"
          fill="url(#pe-brush-grad-b)"
          filter="url(#pe-brush-soften)"
          className="pe-brush-path pe-brush-path--e"
        />
      </svg>
    </div>
  );
};
