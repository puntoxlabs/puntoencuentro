import React, { useRef, useEffect, useState } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';
import './HomeDynamicCanvasGsap.css';

gsap.registerPlugin(MotionPathPlugin, useGSAP);

export interface GsapTagItem {
  id: string;
  text: string;
  emoji: string;
  semanticGroup: 'pizza' | 'padel' | 'mates' | 'futbol' | 'cafe' | 'caminar' | 'bici' | 'cena' | 'playa' | 'cumple' | 'asado';
  colorTheme: 'coral' | 'mint' | 'sky' | 'lavender' | 'warm' | 'yellow' | 'teal' | 'rose';
  shapeVariant: 'pill' | 'ribbon' | 'ticket' | 'blob' | 'curved-tape' | 'asymmetric';
  sizeTier: 'large' | 'medium' | 'small';
  isOpenEncounter?: boolean;
}

export const GSAP_TAGS_CATALOG: GsapTagItem[] = [
  // 1. Pizza en Ribbon (Protagonista 1 - Coral)
  {
    id: 'gt-pizza',
    text: 'Noche de pizzas',
    emoji: '🍕',
    semanticGroup: 'pizza',
    colorTheme: 'coral',
    shapeVariant: 'ribbon',
    sizeTier: 'large',
  },
  // 2. Pádel abierto en Ticket (Lanzamiento 1.0 - Sky)
  {
    id: 'gt-padel',
    text: 'Pádel jueves · falta 1',
    emoji: '🎾',
    semanticGroup: 'padel',
    colorTheme: 'sky',
    shapeVariant: 'ticket',
    sizeTier: 'medium',
    isOpenEncounter: true,
  },
  // 3. Mates en Curved Tape (Tactile - Warm)
  {
    id: 'gt-mates',
    text: 'Mates al sol',
    emoji: '🧉',
    semanticGroup: 'mates',
    colorTheme: 'warm',
    shapeVariant: 'curved-tape',
    sizeTier: 'medium',
  },
  // 4. Fútbol abierto en Blob (Protagonista 2 - Teal)
  {
    id: 'gt-futbol',
    text: 'Partido sábado · quedan 2',
    emoji: '⚽',
    semanticGroup: 'futbol',
    colorTheme: 'teal',
    shapeVariant: 'blob',
    sizeTier: 'large',
    isOpenEncounter: true,
  },
  // 5. Café abierto en Asymmetric (Editorial - Yellow)
  {
    id: 'gt-cafe',
    text: 'Café y charla · abierto',
    emoji: '☕',
    semanticGroup: 'cafe',
    colorTheme: 'yellow',
    shapeVariant: 'asymmetric',
    sizeTier: 'small',
    isOpenEncounter: true,
  },
  // 6. Caminata en Pill (Aire Libre - Mint)
  {
    id: 'gt-caminar',
    text: 'Salir a caminar',
    emoji: '🥾',
    semanticGroup: 'caminar',
    colorTheme: 'mint',
    shapeVariant: 'pill',
    sizeTier: 'medium',
  },
  // 7. Bici abierta en Ribbon (Protagonista 3 - Mint)
  {
    id: 'gt-bici',
    text: 'Salida en bici · quedan 3',
    emoji: '🚴',
    semanticGroup: 'bici',
    colorTheme: 'mint',
    shapeVariant: 'ribbon',
    sizeTier: 'large',
    isOpenEncounter: true,
  },
  // 8. Cena bajo las estrellas en Ticket (Nocturno - Coral)
  {
    id: 'gt-cena',
    text: 'Cena bajo las estrellas',
    emoji: '🍽️',
    semanticGroup: 'cena',
    colorTheme: 'coral',
    shapeVariant: 'ticket',
    sizeTier: 'small',
  },
  // 9. Playa en Blob (Relax - Sky)
  {
    id: 'gt-playa',
    text: 'Escapada a la playa',
    emoji: '🏖️',
    semanticGroup: 'playa',
    colorTheme: 'sky',
    shapeVariant: 'blob',
    sizeTier: 'small',
  },
  // 10. Cumpleaños en Asymmetric (Celebración - Rose)
  {
    id: 'gt-cumple',
    text: 'Festejar un cumple',
    emoji: '🎂',
    semanticGroup: 'cumple',
    colorTheme: 'rose',
    shapeVariant: 'asymmetric',
    sizeTier: 'medium',
  },
  // 11. Asado en Curved Tape (Amigos - Lavender)
  {
    id: 'gt-asado',
    text: 'Asado entre amigos',
    emoji: '🥩',
    semanticGroup: 'asado',
    colorTheme: 'lavender',
    shapeVariant: 'curved-tape',
    sizeTier: 'medium',
  },
];

export interface GsapPhotoItem {
  id: string;
  src: string;
  alt: string;
  caption: string;
  badge?: string;
  emoji: string;
  semanticGroup: 'asado' | 'padel' | 'cafe' | 'mates';
  position: 'left' | 'right-top' | 'right-bottom' | 'mobile-left' | 'mobile-right';
}

export const GSAP_PHOTOS_CATALOG: GsapPhotoItem[] = [
  {
    id: 'photo-asado-desk',
    src: '/images/stitch/asado_amigos.webp',
    alt: 'Amigos compartiendo un asado al aire libre',
    caption: 'Fuego al aire libre',
    badge: 'Tarde entre amigos',
    emoji: '🥩',
    semanticGroup: 'asado',
    position: 'left',
  },
  {
    id: 'photo-padel-desk',
    src: '/images/stitch/padel_sol.webp',
    alt: 'Amigos jugando al pádel en un día soleado',
    caption: 'Una tarde de pádel',
    emoji: '🎾',
    semanticGroup: 'padel',
    position: 'right-top',
  },
  {
    id: 'photo-cafe-desk',
    src: '/images/stitch/cafe_charla.webp',
    alt: 'Mesa de amigos en cafetería al atardecer',
    caption: 'Café de charla',
    emoji: '☕',
    semanticGroup: 'cafe',
    position: 'right-bottom',
  },
  {
    id: 'photo-asado-mob',
    src: '/images/stitch/asado_amigos.webp',
    alt: 'Asado entre amigos',
    caption: 'Asado al aire libre',
    emoji: '🥩',
    semanticGroup: 'asado',
    position: 'mobile-left',
  },
  {
    id: 'photo-mates-mob',
    src: '/images/stitch/mates_sol.webp',
    alt: 'Ronda de mates al sol',
    caption: 'Mates al sol',
    emoji: '🧉',
    semanticGroup: 'mates',
    position: 'mobile-right',
  },
];

interface HomeDynamicCanvasGsapProps {
  isInputFocused?: boolean;
  onTagClick?: (tagText: string) => void;
}

export const HomeDynamicCanvasGsap: React.FC<HomeDynamicCanvasGsapProps> = ({
  isInputFocused = false,
  onTagClick,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const masterTlRef = useRef<gsap.core.Timeline | null>(null);
  const [layoutReady, setLayoutReady] = useState(false);
  const [debugState, setDebugState] = useState<{
    enabled: boolean;
    vvWidth?: number;
    vvHeight?: number;
    vvOffsetTop?: number;
    zoneAY?: number;
    zoneCY?: number;
    containerWidth?: number;
    containerHeight?: number;
  }>({ enabled: false });

  // Detección de ?debugMotion=1 para diagnóstico en /preview/home-gsap
  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search);
        if (params.get('debugMotion') === '1') {
          setDebugState((prev) => ({ ...prev, enabled: true }));
        }
      }
    } catch {}
  }, []);

  // Estabilización de layout: esperar fonts y layout antes de disparar GSAP
  useEffect(() => {
    let isMounted = true;
    const timeoutId = setTimeout(() => {
      if (isMounted) setLayoutReady(true);
    }, 450);

    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready
        .then(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (isMounted) {
                clearTimeout(timeoutId);
                setLayoutReady(true);
              }
            });
          });
        })
        .catch(() => {
          if (isMounted) setLayoutReady(true);
        });
    } else {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (isMounted) setLayoutReady(true);
        });
      });
    }

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
    };
  }, []);

  // ResizeObserver y VisualViewport para responsive robusto
  useEffect(() => {
    if (!containerRef.current) return;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleResize = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (debugState.enabled && typeof window !== 'undefined') {
          const vv = window.visualViewport;
          const cRect = containerRef.current?.getBoundingClientRect();
          setDebugState((prev) => ({
            ...prev,
            vvWidth: vv?.width ? Math.round(vv.width) : window.innerWidth,
            vvHeight: vv?.height ? Math.round(vv.height) : window.innerHeight,
            vvOffsetTop: vv?.offsetTop ? Math.round(vv.offsetTop) : 0,
            containerWidth: cRect ? Math.round(cRect.width) : undefined,
            containerHeight: cRect ? Math.round(cRect.height) : undefined,
          }));
        }
      }, 150);
    };

    const ro = new ResizeObserver(handleResize);
    ro.observe(containerRef.current);

    if (typeof window !== 'undefined' && window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize);
      window.visualViewport.addEventListener('scroll', handleResize);
    }
    window.addEventListener('resize', handleResize);

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      ro.disconnect();
      if (typeof window !== 'undefined' && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleResize);
        window.visualViewport.removeEventListener('scroll', handleResize);
      }
      window.removeEventListener('resize', handleResize);
    };
  }, [debugState.enabled]);

  // Escucha del Modo Calma: desacelera la master timeline y atenúa
  useEffect(() => {
    if (!masterTlRef.current) return;
    const targetTimeScale = isInputFocused ? 0.15 : 1.0;
    gsap.to(masterTlRef.current, {
      timeScale: targetTimeScale,
      duration: isInputFocused ? 0.6 : 0.9,
      ease: 'power2.out',
    });
  }, [isInputFocused]);

  // Visibility State: pausar cuando la pestaña no es visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!masterTlRef.current) return;
      if (document.visibilityState === 'hidden') {
        masterTlRef.current.pause();
      } else {
        masterTlRef.current.resume();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useGSAP(
    () => {
      if (!layoutReady) return;
      const isReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      // ── MODO REDUCED MOTION ──
      if (isReduced) {
        // En reduced motion: no ejecutar timeline continua. Ubicar estáticamente 3 actores clave
        gsap.set('.home-gsap-tag', { visibility: 'hidden', opacity: 0 });
        gsap.set('#gt-pizza', {
          visibility: 'visible',
          opacity: 0.85,
          x: 60,
          y: 60,
          scale: 1,
        });
        gsap.set('#gt-padel', {
          visibility: 'visible',
          opacity: 0.85,
          x: 980,
          y: 90,
          scale: 0.95,
        });
        gsap.set('#gt-mates', {
          visibility: 'visible',
          opacity: 0.8,
          x: 100,
          y: 460,
          scale: 0.9,
        });
        return;
      }

      const mm = gsap.matchMedia();

      // ══════════════════════════════════════════════════════════════════
      // 1. DESKTOP COREOGRAFÍA (>= 768px)
      // ══════════════════════════════════════════════════════════════════
      mm.add('(min-width: 768px)', () => {
        // Master Timeline con duración de ciclo narrativo de 32s
        const masterTl = gsap.timeline({ repeat: -1 });
        masterTlRef.current = masterTl;

        // ── Sub-timeline de Fotografías Desktop (Respiración lenta y drift suave) ──
        const photoTl = gsap.timeline({ repeat: -1, yoyo: true });
        photoTl
          .to('.home-gsap-photo--left', {
            x: 14,
            y: -10,
            rotation: -0.5,
            scale: 1.025,
            duration: 8.5,
            ease: 'sine.inOut',
          })
          .to('.home-gsap-photo--left', {
            x: -6,
            y: 8,
            rotation: -2.2,
            scale: 0.995,
            duration: 9.5,
            ease: 'sine.inOut',
          });

        const photoPadelTl = gsap.timeline({ repeat: -1, yoyo: true });
        photoPadelTl
          .to('.home-gsap-photo--right-top', {
            x: -12,
            y: 10,
            rotation: 0.8,
            scale: 1.02,
            duration: 9,
            ease: 'sine.inOut',
          })
          .to('.home-gsap-photo--right-top', {
            x: 8,
            y: -8,
            rotation: 2.4,
            scale: 0.99,
            duration: 8.5,
            ease: 'sine.inOut',
          });

        const photoCafeTl = gsap.timeline({ repeat: -1, yoyo: true });
        photoCafeTl
          .to('.home-gsap-photo--right-bottom', {
            x: -10,
            y: -12,
            rotation: -0.3,
            scale: 1.022,
            duration: 8,
            ease: 'sine.inOut',
          })
          .to('.home-gsap-photo--right-bottom', {
            x: 10,
            y: 8,
            rotation: -1.6,
            scale: 0.995,
            duration: 10,
            ease: 'sine.inOut',
          });

        // ── COREOGRAFÍA DE TAGS EN DESKTOP ──
        // Estado inicial de todos los tags: ocultos
        gsap.set('.home-gsap-tag', { visibility: 'hidden', opacity: 0, scale: 0.92 });

        // Actor 1: Pizza (Large Protagonista Inicial, ala izquierda superior)
        // Entra con arco desde la izquierda hacia margen superior izquierdo
        masterTl.add(
          gsap
            .timeline()
            .set('#gt-pizza', { visibility: 'visible' })
            .fromTo(
              '#gt-pizza',
              { x: -140, y: 50, opacity: 0, scale: 0.92, rotation: -2.5 },
              {
                motionPath: {
                  path: [
                    { x: 30, y: 40 },
                    { x: 100, y: 55 },
                  ],
                  curviness: 1.2,
                },
                opacity: 0.98,
                scale: 1.08,
                rotation: -0.5,
                duration: 4.5,
                ease: 'power2.out',
              }
            )
            // Protagonismo sostenido + drift lento hacia la derecha
            .to('#gt-pizza', {
              x: 175,
              y: 65,
              rotation: 0.8,
              scale: 1.04,
              duration: 5.5,
              ease: 'sine.inOut',
            })
            // Transición a actor secundario y salida curvada
            .to('#gt-pizza', {
              motionPath: {
                path: [
                  { x: 230, y: 72 },
                  { x: 310, y: 50 },
                ],
                curviness: 1.2,
              },
              opacity: 0,
              scale: 0.92,
              rotation: 1.8,
              duration: 3.5,
              ease: 'power1.in',
            })
            .set('#gt-pizza', { visibility: 'hidden' }),
          0
        );

        // Actor 2: Pádel jueves · falta 1 (Medium en ala derecha superior)
        // Coincide con Pizza pero en lado opuesto, entra a t=0.5s
        masterTl.add(
          gsap
            .timeline()
            .set('#gt-padel', { visibility: 'visible' })
            .fromTo(
              '#gt-padel',
              { x: 1320, y: 55, opacity: 0, scale: 0.92, rotation: 2 },
              {
                motionPath: {
                  path: [
                    { x: 1220, y: 68 },
                    { x: 1160, y: 62 },
                  ],
                  curviness: 1.2,
                },
                opacity: 0.94,
                scale: 1.0,
                rotation: 0.5,
                duration: 4.2,
                ease: 'power2.out',
              }
            )
            .to('#gt-padel', {
              x: 1130,
              y: 70,
              rotation: -0.4,
              duration: 6.0,
              ease: 'sine.inOut',
            })
            .to('#gt-padel', {
              x: 1100,
              y: 78,
              opacity: 0,
              scale: 0.92,
              duration: 3.2,
              ease: 'power1.in',
            })
            .set('#gt-padel', { visibility: 'hidden' }),
          0.5
        );

        // Actor 3: Mates al sol (Medium en flanco izquierdo medio)
        // Entra a t=3.0s cuando Pizza empieza su drift
        masterTl.add(
          gsap
            .timeline()
            .set('#gt-mates', { visibility: 'visible' })
            .fromTo(
              '#gt-mates',
              { x: -100, y: 380, opacity: 0, scale: 0.9, rotation: -2 },
              {
                motionPath: {
                  path: [
                    { x: 35, y: 395 },
                    { x: 95, y: 385 },
                  ],
                  curviness: 1.2,
                },
                opacity: 0.92,
                scale: 0.98,
                rotation: -0.4,
                duration: 4.0,
                ease: 'power2.out',
              }
            )
            .to('#gt-mates', {
              x: 160,
              y: 375,
              rotation: 0.6,
              duration: 6.5,
              ease: 'sine.inOut',
            })
            .to('#gt-mates', {
              x: 230,
              y: 360,
              opacity: 0,
              scale: 0.9,
              duration: 3.5,
              ease: 'power1.in',
            })
            .set('#gt-mates', { visibility: 'hidden' }),
          3.0
        );

        // Actor 4: Fútbol abierto · quedan 2 (Protagonista 2 - Large en ala derecha media)
        // Entra a t=8.0s mientras Pizza sale y toma el relevo protagónico
        masterTl.add(
          gsap
            .timeline()
            .set('#gt-futbol', { visibility: 'visible' })
            .fromTo(
              '#gt-futbol',
              { x: 1320, y: 330, opacity: 0, scale: 0.92, rotation: 2 },
              {
                motionPath: {
                  path: [
                    { x: 1220, y: 320 },
                    { x: 1150, y: 335 },
                  ],
                  curviness: 1.3,
                },
                opacity: 0.98,
                scale: 1.1,
                rotation: 0.4,
                duration: 4.8,
                ease: 'power2.out',
              }
            )
            .to('#gt-futbol', {
              x: 1120,
              y: 350,
              rotation: -0.6,
              scale: 1.05,
              duration: 6.2,
              ease: 'sine.inOut',
            })
            .to('#gt-futbol', {
              x: 1100,
              y: 365,
              opacity: 0,
              scale: 0.94,
              duration: 3.5,
              ease: 'power1.in',
            })
            .set('#gt-futbol', { visibility: 'hidden' }),
          8.0
        );

        // Actor 5: Café y charla · abierto (Small en cielo superior izquierdo)
        // Entra a t=9.5s como acompañante ligero de Fútbol
        masterTl.add(
          gsap
            .timeline()
            .set('#gt-cafe', { visibility: 'visible' })
            .fromTo(
              '#gt-cafe',
              { x: 40, y: 20, opacity: 0, scale: 0.88, rotation: 1.5 },
              {
                x: 120,
                y: 48,
                opacity: 0.88,
                scale: 0.94,
                rotation: -0.3,
                duration: 4.0,
                ease: 'power2.out',
              }
            )
            .to('#gt-cafe', {
              x: 190,
              y: 54,
              rotation: 0.5,
              duration: 5.5,
              ease: 'sine.inOut',
            })
            .to('#gt-cafe', {
              x: 260,
              y: 42,
              opacity: 0,
              scale: 0.88,
              duration: 3.0,
              ease: 'power1.in',
            })
            .set('#gt-cafe', { visibility: 'hidden' }),
          9.5
        );

        // Actor 6: Salir a caminar (Medium en flanco inferior izquierdo)
        // Entra a t=13.0s
        masterTl.add(
          gsap
            .timeline()
            .set('#gt-caminar', { visibility: 'visible' })
            .fromTo(
              '#gt-caminar',
              { x: -80, y: 570, opacity: 0, scale: 0.9, rotation: -1.5 },
              {
                x: 80,
                y: 560,
                opacity: 0.92,
                scale: 0.98,
                rotation: 0.3,
                duration: 4.2,
                ease: 'power2.out',
              }
            )
            .to('#gt-caminar', {
              x: 160,
              y: 550,
              rotation: -0.4,
              duration: 6.0,
              ease: 'sine.inOut',
            })
            .to('#gt-caminar', {
              x: 240,
              y: 535,
              opacity: 0,
              scale: 0.9,
              duration: 3.2,
              ease: 'power1.in',
            })
            .set('#gt-caminar', { visibility: 'hidden' }),
          13.0
        );

        // Actor 7: Bici abierta · quedan 3 (Protagonista 3 - Large en cielo superior izquierdo)
        // Entra a t=17.5s
        masterTl.add(
          gsap
            .timeline()
            .set('#gt-bici', { visibility: 'visible' })
            .fromTo(
              '#gt-bici',
              { x: -140, y: 35, opacity: 0, scale: 0.92, rotation: -1.8 },
              {
                motionPath: {
                  path: [
                    { x: -20, y: 30 },
                    { x: 45, y: 38 },
                  ],
                  curviness: 1.2,
                },
                opacity: 0.98,
                scale: 1.08,
                rotation: 0.4,
                duration: 4.5,
                ease: 'power2.out',
              }
            )
            .to('#gt-bici', {
              x: 85,
              y: 42,
              rotation: -0.5,
              scale: 1.04,
              duration: 6.0,
              ease: 'sine.inOut',
            })
            .to('#gt-bici', {
              x: 110,
              y: 35,
              opacity: 0,
              scale: 0.92,
              duration: 3.5,
              ease: 'power1.in',
            })
            .set('#gt-bici', { visibility: 'hidden' }),
          17.5
        );

        // Actor 8: Cena bajo las estrellas (Small en flanco derecho superior)
        // Entra a t=19.0s
        masterTl.add(
          gsap
            .timeline()
            .set('#gt-cena', { visibility: 'visible' })
            .fromTo(
              '#gt-cena',
              { x: 1240, y: 80, opacity: 0, scale: 0.88, rotation: 1.8 },
              {
                x: 1100,
                y: 92,
                opacity: 0.88,
                scale: 0.94,
                rotation: -0.4,
                duration: 3.8,
                ease: 'power2.out',
              }
            )
            .to('#gt-cena', {
              x: 1020,
              y: 86,
              rotation: 0.4,
              duration: 5.5,
              ease: 'sine.inOut',
            })
            .to('#gt-cena', {
              x: 940,
              y: 95,
              opacity: 0,
              scale: 0.88,
              duration: 3.0,
              ease: 'power1.in',
            })
            .set('#gt-cena', { visibility: 'hidden' }),
          19.0
        );

        // Actor 9: Escapada a la playa (Small en flanco inferior derecho)
        // Entra a t=22.0s
        masterTl.add(
          gsap
            .timeline()
            .set('#gt-playa', { visibility: 'visible' })
            .fromTo(
              '#gt-playa',
              { x: 1300, y: 665, opacity: 0, scale: 0.88, rotation: -1.2 },
              {
                x: 1160,
                y: 670,
                opacity: 0.88,
                scale: 0.94,
                rotation: 0.3,
                duration: 4.0,
                ease: 'power2.out',
              }
            )
            .to('#gt-playa', {
              x: 1130,
              y: 675,
              rotation: -0.5,
              duration: 5.5,
              ease: 'sine.inOut',
            })
            .to('#gt-playa', {
              x: 1100,
              y: 665,
              opacity: 0,
              scale: 0.88,
              duration: 3.0,
              ease: 'power1.in',
            })
            .set('#gt-playa', { visibility: 'hidden' }),
          22.0
        );

        // Actor 10: Festejo de cumple (Medium en flanco izquierdo)
        // Entra a t=24.5s
        masterTl.add(
          gsap
            .timeline()
            .set('#gt-cumple', { visibility: 'visible' })
            .fromTo(
              '#gt-cumple',
              { x: -80, y: 390, opacity: 0, scale: 0.9, rotation: 1.5 },
              {
                x: 50,
                y: 405,
                opacity: 0.92,
                scale: 0.98,
                rotation: -0.3,
                duration: 3.8,
                ease: 'power2.out',
              }
            )
            .to('#gt-cumple', {
              x: 130,
              y: 395,
              rotation: 0.4,
              duration: 5.0,
              ease: 'sine.inOut',
            })
            .to('#gt-cumple', {
              x: 210,
              y: 380,
              opacity: 0,
              scale: 0.9,
              duration: 3.0,
              ease: 'power1.in',
            })
            .set('#gt-cumple', { visibility: 'hidden' }),
          24.5
        );

        // Actor 11: Asado entre amigos (Medium en ala derecha media)
        // Entra a t=26.0s cerrando el ciclo armónicamente
        masterTl.add(
          gsap
            .timeline()
            .set('#gt-asado', { visibility: 'visible' })
            .fromTo(
              '#gt-asado',
              { x: 1300, y: 440, opacity: 0, scale: 0.9, rotation: -1.5 },
              {
                x: 1160,
                y: 450,
                opacity: 0.94,
                scale: 1.0,
                rotation: 0.4,
                duration: 3.8,
                ease: 'power2.out',
              }
            )
            .to('#gt-asado', {
              x: 1130,
              y: 460,
              rotation: -0.3,
              duration: 4.8,
              ease: 'sine.inOut',
            })
            .to('#gt-asado', {
              x: 1100,
              y: 450,
              opacity: 0,
              scale: 0.9,
              duration: 2.8,
              ease: 'power1.in',
            })
            .set('#gt-asado', { visibility: 'hidden' }),
          26.0
        );
      });

      // ══════════════════════════════════════════════════════════════════
      // 2. MOBILE COREOGRAFÍA (< 768px)
      // ══════════════════════════════════════════════════════════════════
      mm.add('(max-width: 767px)', () => {
        const container = containerRef.current;
        if (!container) return;

        const containerRect = container.getBoundingClientRect();
        const containerWidth = containerRect.width || window.innerWidth;
        const containerHeight = containerRect.height || 670;

        const eyebrowEl = document.querySelector('.home-hero-badge');
        const chipsEl = document.querySelector('.home-suggestion-chips');
        const photoLeftEl = container.querySelector('.home-gsap-mobile-frag--left');
        const photoRightEl = container.querySelector('.home-gsap-mobile-frag--right');

        const eyebrowRect = eyebrowEl ? eyebrowEl.getBoundingClientRect() : null;
        const chipsRect = chipsEl ? chipsEl.getBoundingClientRect() : null;
        const photoLeftRect = photoLeftEl ? photoLeftEl.getBoundingClientRect() : null;
        const photoRightRect = photoRightEl ? photoRightEl.getBoundingClientRect() : null;

        const eyebrowRelTop = eyebrowRect ? (eyebrowRect.top - containerRect.top) : 92;
        const chipsRelBottom = chipsRect ? (chipsRect.bottom - containerRect.top) : (containerHeight - 72);

        // Zone A (Cornisa Superior): entre top 16px y 26px, resguardada arriba del eyebrow
        const zoneAY = Math.max(16, Math.min(26, Math.round(eyebrowRelTop - 46)));

        // Zone C (Flanco Inferior): bajo chips funcionales y dentro del canvas
        const zoneCY = Math.min(containerHeight - 52, Math.max(Math.round(chipsRelBottom + 12), containerHeight - 68));

        // Cornisa bounds relativos al container (considerando amplitud de balanceo de las fotos de +/-4px)
        const photoLeftEnd = photoLeftRect ? Math.round(photoLeftRect.right - containerRect.left + 4) : 76;
        const photoRightStart = photoRightRect ? Math.round(photoRightRect.left - containerRect.left - 4) : Math.round(containerWidth - 76);
        const tagAWidthApprox = 150;
        const cornisaCenter = Math.round((photoLeftEnd + photoRightStart) / 2);
        const centerA_X = Math.round(cornisaCenter - tagAWidthApprox / 2);

        // Posicionamiento en el centro de la cornisa entre fotos (0 colisiones garantizadas)
        const slotA1_x1 = centerA_X;
        const slotA1_x2 = centerA_X;
        const slotA2_x1 = centerA_X;
        const slotA2_x2 = centerA_X;

        // Zone C (Flanco Inferior bajo chips)
        const tagCWidthApprox = 145;
        const slotC1_x1 = 14;
        const slotC1_x2 = 26;
        const slotC2_x1 = Math.round(containerWidth - tagCWidthApprox - 14);
        const slotC2_x2 = slotC2_x1 - 12;

        if (debugState.enabled && typeof window !== 'undefined') {
          const vv = window.visualViewport;
          setDebugState((prev) => ({
            ...prev,
            zoneAY,
            zoneCY,
            containerWidth: Math.round(containerWidth),
            containerHeight: Math.round(containerHeight),
            vvWidth: vv?.width ? Math.round(vv.width) : window.innerWidth,
            vvHeight: vv?.height ? Math.round(vv.height) : window.innerHeight,
            vvOffsetTop: vv?.offsetTop ? Math.round(vv.offsetTop) : 0,
          }));
        }

        // Master Timeline con duración de ciclo narrativo continuo de 24s
        const mobileMasterTl = gsap.timeline({ repeat: -1 });
        masterTlRef.current = mobileMasterTl;

        // Micro-respiración de fragmentos fotográficos mobile
        const mobPhotoTl = gsap.timeline({ repeat: -1, yoyo: true });
        mobPhotoTl
          .to('.home-gsap-mobile-frag--left', {
            rotation: -1.5,
            x: 4,
            y: 2,
            scale: 1.02,
            duration: 6,
            ease: 'sine.inOut',
          })
          .to('.home-gsap-mobile-frag--right', {
            rotation: 1.5,
            x: -4,
            y: -2,
            scale: 1.02,
            duration: 6.5,
            ease: 'sine.inOut',
          });

        gsap.set('.home-gsap-tag', { visibility: 'hidden', opacity: 0, scale: 0.92 });

        // Helper para crear la timeline fluida de un tag (6.5s de presencia)
        const createTagTl = (
          tagId: string,
          xStart: number,
          xDrift: number,
          yPos: number,
          rotStart: number,
          rotDrift: number
        ) => {
          return gsap
            .timeline()
            .set(tagId, { visibility: 'visible' })
            .fromTo(
              tagId,
              { x: xStart, y: yPos, opacity: 0, scale: 0.94, rotation: rotStart },
              {
                x: xStart + Math.round((xDrift - xStart) * 0.4),
                y: yPos,
                opacity: 0.96,
                scale: 1.0,
                rotation: (rotStart + rotDrift) / 2,
                duration: 1.2,
                ease: 'power2.out',
              }
            )
            .to(tagId, {
              x: xDrift,
              y: yPos + (xDrift > xStart ? 1.5 : -1.5),
              rotation: rotDrift,
              scale: 1.01,
              duration: 3.8,
              ease: 'sine.inOut',
            })
            .to(tagId, {
              opacity: 0,
              scale: 0.94,
              duration: 1.5,
              ease: 'power1.in',
            })
            .set(tagId, { visibility: 'hidden' });
        };

        // Helper para la cola del wrap al inicio (t=0s a 3.5s)
        const createWrapTailTl = (
          tagId: string,
          xMid: number,
          xEnd: number,
          yPos: number,
          rotMid: number,
          rotEnd: number
        ) => {
          return gsap
            .timeline()
            .set(tagId, { visibility: 'visible', opacity: 0.96, scale: 1.01, x: xMid, y: yPos, rotation: rotMid })
            .to(tagId, {
              x: xEnd,
              y: yPos - 1,
              rotation: rotEnd,
              duration: 2.0,
              ease: 'sine.inOut',
            })
            .to(tagId, {
              opacity: 0,
              scale: 0.94,
              duration: 1.5,
              ease: 'power1.in',
            })
            .set(tagId, { visibility: 'hidden' });
        };

        // ── COREOGRAFÍA CONTINUA 24s MOBILE (Sostenida: 1-2 tags, 0 gaps, 0 colisiones) ──
        // Para que desde el segundo 0 haya 2 tags visibles (uno en Zone A y uno en Zone C):
        // En t=0: gt-cumple (Zone C) está finalizando su ciclo (0s a 3.5s) mientras gt-pizza (Zone A) entra (0s a 6.5s)
        mobileMasterTl.add(
          createWrapTailTl('#gt-cumple', slotC2_x1 + 10, slotC2_x2, zoneCY, 0.2, -0.4),
          0
        );

        // 1. Zone A: Pizza (Coral / Ribbon / Large) - t=0.0s a 6.5s
        mobileMasterTl.add(
          createTagTl('#gt-pizza', slotA1_x1, slotA1_x2, zoneAY, -1.2, 0.4),
          0
        );

        // 2. Zone C: Pádel (Sky / Ticket / Medium) - t=3.0s a 9.5s
        mobileMasterTl.add(
          createTagTl('#gt-padel', slotC1_x1, slotC1_x2, zoneCY, 0.8, -0.3),
          3.0
        );

        // 3. Zone A: Mates (Warm / Curved-tape / Medium) - t=6.0s a 12.5s
        mobileMasterTl.add(
          createTagTl('#gt-mates', slotA2_x1, slotA2_x2, zoneAY, 1.0, -0.4),
          6.0
        );

        // 4. Zone C: Fútbol (Teal / Blob / Large) - t=9.0s a 15.5s
        mobileMasterTl.add(
          createTagTl('#gt-futbol', slotC2_x1, slotC2_x2, zoneCY, -0.8, 0.4),
          9.0
        );

        // 5. Zone A: Caminar (Mint / Pill / Medium) - t=12.0s a 18.5s
        mobileMasterTl.add(
          createTagTl('#gt-caminar', slotA1_x1, slotA1_x2, zoneAY, -0.6, 0.3),
          12.0
        );

        // 6. Zone C: Café (Yellow / Asymmetric / Small) - t=15.0s a 21.5s
        mobileMasterTl.add(
          createTagTl('#gt-cafe', slotC1_x1, slotC1_x2, zoneCY, 0.6, -0.2),
          15.0
        );

        // 7. Zone A: Bici (Mint / Ribbon / Large) - t=18.0s a 24.5s
        mobileMasterTl.add(
          createTagTl('#gt-bici', slotA2_x1, slotA2_x2, zoneAY, 0.8, -0.3),
          18.0
        );

        // 8. Zone C: Cumple (Rose / Asymmetric / Medium) - t=21.0s a 27.5s (conecta con el wrap en t=0)
        mobileMasterTl.add(
          createTagTl('#gt-cumple', slotC2_x1, slotC2_x2, zoneCY, -0.6, 0.2),
          21.0
        );
      });

      return () => {
        mm.revert();
      };
    },
    { scope: containerRef, dependencies: [layoutReady] }
  );

  return (
    <div
      ref={containerRef}
      className={`home-dynamic-canvas home-dynamic-canvas--gsap ${
        isInputFocused ? 'home-dynamic-canvas--calm' : ''
      }`}
      aria-hidden="true"
    >
      {/* ── CAPA FOTOGRÁFICA (Drift sutil animado por GSAP) ── */}
      <div className="home-gsap-photos-layer">
        {/* Flanco Izquierdo Desktop: Asado */}
        <div className="home-gsap-photo home-gsap-photo--left">
          <img
            src={GSAP_PHOTOS_CATALOG[0].src}
            alt={GSAP_PHOTOS_CATALOG[0].alt}
            className="home-gsap-photo-img"
            loading="eager"
            decoding="async"
          />
          <div className="home-gsap-photo-overlay" />
          <div className="home-gsap-photo-card-tag">
            <span className="home-gsap-card-emoji">{GSAP_PHOTOS_CATALOG[0].emoji}</span>
            <span className="home-gsap-card-title">{GSAP_PHOTOS_CATALOG[0].caption}</span>
            <span className="home-gsap-card-arrow">↗</span>
          </div>
          {GSAP_PHOTOS_CATALOG[0].badge && (
            <div className="home-gsap-photo-subtag">
              <span>{GSAP_PHOTOS_CATALOG[0].badge}</span>
            </div>
          )}
        </div>

        {/* Flanco Derecho Superior Desktop: Pádel */}
        <div className="home-gsap-photo home-gsap-photo--right-top">
          <img
            src={GSAP_PHOTOS_CATALOG[1].src}
            alt={GSAP_PHOTOS_CATALOG[1].alt}
            className="home-gsap-photo-img"
            loading="eager"
            decoding="async"
          />
          <div className="home-gsap-photo-overlay" />
          <div className="home-gsap-photo-card-tag">
            <span className="home-gsap-card-emoji">{GSAP_PHOTOS_CATALOG[1].emoji}</span>
            <span className="home-gsap-card-title">{GSAP_PHOTOS_CATALOG[1].caption}</span>
            <span className="home-gsap-card-arrow">↗</span>
          </div>
        </div>

        {/* Flanco Derecho Inferior Desktop: Café */}
        <div className="home-gsap-photo home-gsap-photo--right-bottom">
          <img
            src={GSAP_PHOTOS_CATALOG[2].src}
            alt={GSAP_PHOTOS_CATALOG[2].alt}
            className="home-gsap-photo-img"
            loading="eager"
            decoding="async"
          />
          <div className="home-gsap-photo-overlay" />
          <div className="home-gsap-photo-card-tag">
            <span className="home-gsap-card-emoji">{GSAP_PHOTOS_CATALOG[2].emoji}</span>
            <span className="home-gsap-card-title">{GSAP_PHOTOS_CATALOG[2].caption}</span>
            <span className="home-gsap-card-arrow">↗</span>
          </div>
        </div>

        {/* Viñetas Fotográficas Mobile */}
        <div className="home-gsap-mobile-frag home-gsap-mobile-frag--left">
          <img
            src={GSAP_PHOTOS_CATALOG[3].src}
            alt={GSAP_PHOTOS_CATALOG[3].alt}
            className="home-gsap-frag-img"
            loading="eager"
            decoding="async"
          />
          <span className="home-gsap-frag-pill">🥩 Asado</span>
        </div>

        <div className="home-gsap-mobile-frag home-gsap-mobile-frag--right">
          <img
            src={GSAP_PHOTOS_CATALOG[4].src}
            alt={GSAP_PHOTOS_CATALOG[4].alt}
            className="home-gsap-frag-img"
            loading="eager"
            decoding="async"
          />
          <span className="home-gsap-frag-pill">🧉 Mates</span>
        </div>
      </div>

      {/* ── CAPA DE ETIQUETAS DINÁMICAS (Animadas por GSAP) ── */}
      <div className="home-gsap-tags-layer">
        {GSAP_TAGS_CATALOG.map((tag) => (
          <div
            key={tag.id}
            id={tag.id}
            className={`home-gsap-tag home-floating-tag home-floating-tag--stitch home-gsap-tag--size-${tag.sizeTier} home-floating-tag--size-${tag.sizeTier} home-gsap-tag--shape-${tag.shapeVariant} home-floating-tag--stitch-shape-${tag.shapeVariant} home-gsap-tag--color-${tag.colorTheme} home-floating-tag--stitch-color-${tag.colorTheme}`}
            onClick={() => onTagClick?.(tag.text)}
          >
            <span className="home-gsap-tag-emoji home-floating-tag-emoji">{tag.emoji}</span>
            <span className="home-gsap-tag-text home-floating-tag-text">{tag.text}</span>
          </div>
        ))}
      </div>

      {/* ── MODO DEBUG MOTION (?debugMotion=1) ── */}
      {debugState.enabled && (
        <div className="home-gsap-debug-hud">
          <div className="home-gsap-debug-hud-title">
            <span>GSAP Debug</span>
            <span>{isInputFocused ? 'CALMA' : 'ACTIVE'}</span>
          </div>
          <div className="home-gsap-debug-hud-item">
            Layout: <span>{layoutReady ? 'STABLE' : 'WAITING'}</span>
          </div>
          <div className="home-gsap-debug-hud-item">
            VV: <span>{debugState.vvWidth ?? 0}×{debugState.vvHeight ?? 0}</span> (top: {debugState.vvOffsetTop ?? 0})
          </div>
          <div className="home-gsap-debug-hud-item">
            Canvas: <span>{debugState.containerWidth ?? 0}×{debugState.containerHeight ?? 0}</span>
          </div>
          <div className="home-gsap-debug-hud-item">
            Zone A Y: <span>{debugState.zoneAY ?? 0}px</span>
          </div>
          <div className="home-gsap-debug-hud-item">
            Zone C Y: <span>{debugState.zoneCY ?? 0}px</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default HomeDynamicCanvasGsap;
