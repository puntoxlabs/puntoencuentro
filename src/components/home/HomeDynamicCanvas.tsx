import React, { useState, useEffect } from 'react';
import './HomeDynamicCanvas.css';

export type HomeVisualVariant = 'envolvente' | 'visor' | 'refinado' | 'stitch';

export interface FloatingTagItem {
  id: string;
  text: string;
  emoji: string;
  category: 'gastronomia' | 'deportes' | 'social' | 'airelibre' | 'cultura' | 'celebracion';
  colorScheme: 'mint' | 'coral' | 'blue' | 'purple' | 'amber' | 'teal' | 'rose';
  track: 'sky' | 'left' | 'right' | 'orbit' | 'visor-diag-down' | 'visor-diag-up' | 'visor-horiz' | 'mobile-top' | 'mobile-mid'
    | 'refinado-sky' | 'refinado-left' | 'refinado-right' | 'refinado-lower-cross' | 'refinado-sky-right' | 'refinado-lower-sway';
}

export interface AnimatedPhotoItem {
  id: string;
  src: string;
  alt: string;
  title: string;
  meta: string;
  badge: string;
  emoji: string;
  position: 'left-top' | 'left-bottom' | 'right-top' | 'right-bottom' | 'center-portal' | 'mobile-1' | 'mobile-2';
}

export const FLOATING_TAGS_CATALOG: FloatingTagItem[] = [
  { id: 'asado', text: 'Organizar un asado', emoji: '🥩', category: 'gastronomia', colorScheme: 'coral', track: 'left' },
  { id: 'mates', text: 'Tomar unos mates', emoji: '🧉', category: 'airelibre', colorScheme: 'mint', track: 'sky' },
  { id: 'partidito', text: 'Armar un partidito', emoji: '⚽', category: 'deportes', colorScheme: 'teal', track: 'right' },
  { id: 'padel', text: 'Jugar al pádel', emoji: '🎾', category: 'deportes', colorScheme: 'amber', track: 'visor-diag-down' },
  { id: 'correr', text: 'Salir a correr', emoji: '🏃‍♂️', category: 'deportes', colorScheme: 'blue', track: 'orbit' },
  { id: 'cenar', text: 'Juntarnos a cenar', emoji: '🍽️', category: 'gastronomia', colorScheme: 'purple', track: 'visor-horiz' },
  { id: 'playa', text: 'Ir a la playa', emoji: '🏖️', category: 'airelibre', colorScheme: 'blue', track: 'sky' },
  { id: 'bici', text: 'Una salida en bici', emoji: '🚴', category: 'airelibre', colorScheme: 'mint', track: 'left' },
  { id: 'pelicula', text: 'Ver una película', emoji: '🎬', category: 'cultura', colorScheme: 'purple', track: 'right' },
  { id: 'cumple', text: 'Organizar un cumpleaños', emoji: '🎂', category: 'celebracion', colorScheme: 'rose', track: 'visor-diag-up' },
  { id: 'caminar', text: 'Salir a caminar', emoji: '🥾', category: 'airelibre', colorScheme: 'teal', track: 'orbit' },
  { id: 'cafe', text: 'Encontrarnos a tomar un café', emoji: '☕', category: 'social', colorScheme: 'amber', track: 'mobile-top' },
  { id: 'previa', text: 'Hacer una previa', emoji: '🍻', category: 'social', colorScheme: 'coral', track: 'mobile-mid' },
  { id: 'musica', text: 'Tocar música', emoji: '🎸', category: 'cultura', colorScheme: 'purple', track: 'right' },
];

export const ANIMATED_PHOTOS_CATALOG: AnimatedPhotoItem[] = [
  {
    id: 'asado',
    src: '/images/home-hero.webp',
    alt: 'Amigos compartiendo un asado',
    title: 'Asado este sábado',
    meta: '4 personas',
    badge: 'Confirmado ✔',
    emoji: '🍕',
    position: 'left-top',
  },
  {
    id: 'mates',
    src: '/invitation-templates/friends/friends_picnic_v4.webp',
    alt: 'Mates y picnic al parque',
    title: 'Mates al sol',
    meta: 'En el parque',
    badge: 'Hoy 17hs',
    emoji: '🧉',
    position: 'left-bottom',
  },
  {
    id: 'padel',
    src: '/invitation-templates/sports/sports_field_v2.webp',
    alt: 'Partido de pádel o fútbol',
    title: 'Pádel / Fútbol',
    meta: 'Cancha 3',
    badge: '+1 persona',
    emoji: '🎾',
    position: 'right-top',
  },
  {
    id: 'cafe',
    src: '/invitation-templates/friends/friends_coffee.webp',
    alt: 'Café y risas entre amigos',
    title: 'Café esta semana',
    meta: '3 personas',
    badge: 'En organización',
    emoji: '☕',
    position: 'right-bottom',
  },
  {
    id: 'cena',
    src: '/invitation-templates/friends/friends_night_v4.webp',
    alt: 'Cena informal de amigos',
    title: 'Cena informal',
    meta: 'Viernes 21hs',
    badge: '¡Listo!',
    emoji: '🍽️',
    position: 'center-portal',
  },
  {
    id: 'cumple',
    src: '/invitation-templates/celebration/celebration_festiva_v2.webp',
    alt: 'Cumpleaños festivo',
    title: 'Festejo de cumple',
    meta: '12 confirmados',
    badge: 'Sábado',
    emoji: '🎂',
    position: 'mobile-1',
  },
  {
    id: 'familia',
    src: '/invitation-templates/family/family_sunday_v4.webp',
    alt: 'Almuerzo familiar de domingo',
    title: 'Almuerzo de domingo',
    meta: 'Familia reunida',
    badge: 'Al mediodía',
    emoji: '🍝',
    position: 'mobile-2',
  },
];

/* ── CONFIGURACIÓN ESPECÍFICA PARA VARIANTE C: ESPACIO VIVO REFINADO ── */
export interface RefinadoTagItem {
  id: string;
  text: string;
  emoji: string;
  colorScheme: 'mint' | 'coral' | 'blue' | 'purple' | 'amber' | 'teal' | 'rose';
  track: 'refinado-sky' | 'refinado-left' | 'refinado-right' | 'refinado-lower-cross' | 'refinado-sky-right' | 'refinado-lower-sway';
  delay: string;
  isGhost?: boolean;
}

export const REFINADO_TAGS_CATALOG: RefinadoTagItem[] = [
  // 1. Cielo superior (alto, sobre el H1 y overline)
  { id: 'mates', text: 'Tomar unos mates', emoji: '🧉', colorScheme: 'mint', track: 'refinado-sky', delay: '0s' },
  { id: 'bici', text: 'Una salida en bici', emoji: '🚴', colorScheme: 'teal', track: 'refinado-sky', delay: '-14s' },

  // 2. Cielo derecha
  { id: 'playa', text: 'Ir a la playa', emoji: '🏖️', colorScheme: 'blue', track: 'refinado-sky-right', delay: '-6s', isGhost: true },

  // 3. Ala izquierda (flotación en margen izquierdo, sin invadir el centro)
  { id: 'asado', text: 'Organizar un asado', emoji: '🥩', colorScheme: 'coral', track: 'refinado-left', delay: '-3s' },
  { id: 'caminar', text: 'Salir a caminar', emoji: '🥾', colorScheme: 'mint', track: 'refinado-left', delay: '-11s', isGhost: true },

  // 4. Ala derecha (flotación en margen derecho)
  { id: 'padel', text: 'Jugar al pádel', emoji: '🎾', colorScheme: 'amber', track: 'refinado-right', delay: '-5s' },
  { id: 'partidito', text: 'Armar un partidito', emoji: '⚽', colorScheme: 'blue', track: 'refinado-right', delay: '-16s' },

  // 5. Cruce diagonal inferior (por debajo del CTA y chips)
  { id: 'cenar', text: 'Juntarnos a cenar', emoji: '🍽️', colorScheme: 'purple', track: 'refinado-lower-cross', delay: '-8s' },
  { id: 'previa', text: 'Hacer una previa', emoji: '🍻', colorScheme: 'coral', track: 'refinado-lower-cross', delay: '-21s', isGhost: true },

  // 6. Balanceo inferior derecho
  { id: 'cumple', text: 'Organizar un cumpleaños', emoji: '🎂', colorScheme: 'rose', track: 'refinado-lower-sway', delay: '-9s' },
  { id: 'musica', text: 'Tocar música', emoji: '🎸', colorScheme: 'purple', track: 'refinado-lower-sway', delay: '-18s' },
];

export interface RefinadoPhotoItem {
  id: string;
  src: string;
  alt: string;
  caption: string;
  emoji: string;
  position: 'refinado-desktop-left' | 'refinado-desktop-right-top' | 'refinado-desktop-right-bottom' | 'refinado-mobile-peek-left' | 'refinado-mobile-peek-right';
}

export const REFINADO_PHOTOS_CATALOG: RefinadoPhotoItem[] = [
  {
    id: 'asado',
    src: '/images/home-hero.webp',
    alt: 'Amigos compartiendo un asado',
    caption: 'Asado entre amigos',
    emoji: '🥩',
    position: 'refinado-desktop-left',
  },
  {
    id: 'padel',
    src: '/invitation-templates/sports/sports_field_v2.webp',
    alt: 'Partido de pádel o fútbol',
    caption: 'Turno de pádel',
    emoji: '🎾',
    position: 'refinado-desktop-right-top',
  },
  {
    id: 'cafe',
    src: '/invitation-templates/friends/friends_coffee.webp',
    alt: 'Café y risas entre amigos',
    caption: 'Charla y café',
    emoji: '☕',
    position: 'refinado-desktop-right-bottom',
  },
  {
    id: 'mates-mobile',
    src: '/invitation-templates/friends/friends_picnic_v4.webp',
    alt: 'Mates al sol',
    caption: 'Mates al parque',
    emoji: '🧉',
    position: 'refinado-mobile-peek-right',
  },
  {
    id: 'asado-mobile',
    src: '/images/home-hero.webp',
    alt: 'Asado con amigos',
    caption: 'Juntada asado',
    emoji: '🍕',
    position: 'refinado-mobile-peek-left',
  },
];

/* ── CONFIGURACIÓN ESPECÍFICA PARA VARIANTE D: MUNDO VIVO STITCH ── */
export interface StitchTagItem {
  id: string;
  text: string;
  emoji: string;
  cycle: 'A' | 'B' | 'C';
  styleVariant: 'translucent' | 'pill' | 'ghost';
  colorTheme: 'coral' | 'mint' | 'sky' | 'lavender' | 'warm' | 'yellow' | 'teal' | 'rose';
  shapeVariant: 'pill' | 'ribbon' | 'ticket' | 'blob' | 'curved-tape' | 'asymmetric';
  motionPattern: 'flutter' | 'curve-drift' | 'bob-hover' | 'slide-pause' | 'quick-pass';
  track: 'stitch-sky-cross' | 'stitch-left-travel' | 'stitch-right-ascend' | 'stitch-lower-travel' | 'stitch-right-curve';
  lane: 'sky-left' | 'sky-right' | 'left-mid' | 'right-mid' | 'lower-left' | 'lower-right';
  delay: string;
  duration?: string;
  sizeTier?: 'large' | 'medium' | 'small';
  mobileZone?: 'zone-a' | 'zone-b' | 'zone-c';
  mobileSlot?: number;
}

export const STITCH_TAGS_CATALOG: StitchTagItem[] = [
  // Ciclo A (0s - 10s): Apertura viva, pizza en ribbon, mates en cinta y pádel abierto (falta 1)
  {
    id: 's-pizza',
    text: 'Noche de pizzas',
    emoji: '🍕',
    cycle: 'A',
    styleVariant: 'translucent',
    colorTheme: 'coral',
    shapeVariant: 'ribbon',
    motionPattern: 'flutter',
    track: 'stitch-sky-cross',
    lane: 'sky-left',
    delay: '0s',
    duration: '24s',
    sizeTier: 'large',
    mobileZone: 'zone-a',
    mobileSlot: 1,
  },
  {
    id: 's-mates',
    text: 'Mates al sol',
    emoji: '🧉',
    cycle: 'A',
    styleVariant: 'pill',
    colorTheme: 'warm',
    shapeVariant: 'curved-tape',
    motionPattern: 'curve-drift',
    track: 'stitch-right-ascend',
    lane: 'right-mid',
    delay: '-3s',
    duration: '28s',
    sizeTier: 'medium',
    mobileZone: 'zone-a',
    mobileSlot: 3,
  },
  {
    id: 's-padel',
    text: 'Pádel jueves · falta 1',
    emoji: '🎾',
    cycle: 'A',
    styleVariant: 'ghost',
    colorTheme: 'sky',
    shapeVariant: 'ticket',
    motionPattern: 'slide-pause',
    track: 'stitch-lower-travel',
    lane: 'lower-left',
    delay: '-6s',
    duration: '26s',
    sizeTier: 'small',
    mobileZone: 'zone-c',
    mobileSlot: 2,
  },

  // Ciclo B (10s - 20s): Partido abierto (quedan 2) en blob protagonista, café asimétrico y caminata en pill
  {
    id: 's-partidito',
    text: 'Partido sábado · quedan 2',
    emoji: '⚽',
    cycle: 'B',
    styleVariant: 'pill',
    colorTheme: 'teal',
    shapeVariant: 'blob',
    motionPattern: 'bob-hover',
    track: 'stitch-sky-cross',
    lane: 'sky-right',
    delay: '-9s',
    duration: '30s',
    sizeTier: 'large',
    mobileZone: 'zone-c',
    mobileSlot: 6,
  },
  {
    id: 's-cafe',
    text: 'Café y charla',
    emoji: '☕',
    cycle: 'B',
    styleVariant: 'translucent',
    colorTheme: 'yellow',
    shapeVariant: 'asymmetric',
    motionPattern: 'quick-pass',
    track: 'stitch-left-travel',
    lane: 'left-mid',
    delay: '-12s',
    duration: '22s',
    sizeTier: 'small',
    mobileZone: 'zone-c',
    mobileSlot: 4,
  },
  {
    id: 's-caminar',
    text: 'Salir a caminar',
    emoji: '🥾',
    cycle: 'B',
    styleVariant: 'ghost',
    colorTheme: 'mint',
    shapeVariant: 'pill',
    motionPattern: 'curve-drift',
    track: 'stitch-lower-travel',
    lane: 'lower-right',
    delay: '-15s',
    duration: '27s',
    sizeTier: 'medium',
    mobileZone: 'zone-a',
    mobileSlot: 5,
  },

  // Ciclo C (20s - 33s): Bici abierta (3 lugares) en ribbon, cena ticket, playa blob, cumple asimétrico y asado
  {
    id: 's-bici',
    text: 'Salida en bici · 3 lugares',
    emoji: '🚴',
    cycle: 'C',
    styleVariant: 'translucent',
    colorTheme: 'mint',
    shapeVariant: 'ribbon',
    motionPattern: 'flutter',
    track: 'stitch-sky-cross',
    lane: 'sky-left',
    delay: '-18s',
    duration: '25s',
    sizeTier: 'large',
  },
  {
    id: 's-cena',
    text: 'Cena con amigos',
    emoji: '🍽️',
    cycle: 'C',
    styleVariant: 'pill',
    colorTheme: 'coral',
    shapeVariant: 'ticket',
    motionPattern: 'slide-pause',
    track: 'stitch-right-ascend',
    lane: 'right-mid',
    delay: '-21s',
    duration: '29s',
    sizeTier: 'medium',
  },
  {
    id: 's-playa',
    text: 'Escapada a la playa',
    emoji: '🏖️',
    cycle: 'C',
    styleVariant: 'ghost',
    colorTheme: 'sky',
    shapeVariant: 'blob',
    motionPattern: 'bob-hover',
    track: 'stitch-right-curve',
    lane: 'lower-left',
    delay: '-24s',
    duration: '31s',
    sizeTier: 'small',
  },
  {
    id: 's-cumple',
    text: 'Festejar un cumple',
    emoji: '🎂',
    cycle: 'C',
    styleVariant: 'translucent',
    colorTheme: 'rose',
    shapeVariant: 'asymmetric',
    motionPattern: 'curve-drift',
    track: 'stitch-left-travel',
    lane: 'left-mid',
    delay: '-27s',
    duration: '23s',
    sizeTier: 'medium',
  },
  {
    id: 's-asado',
    text: 'Asado entre amigos',
    emoji: '🥩',
    cycle: 'C',
    styleVariant: 'pill',
    colorTheme: 'lavender',
    shapeVariant: 'curved-tape',
    motionPattern: 'flutter',
    track: 'stitch-right-curve',
    lane: 'lower-right',
    delay: '-30s',
    duration: '26s',
    sizeTier: 'small',
  },
];

export interface StitchPhotoItem {
  id: string;
  src: string;
  alt: string;
  caption: string;
  badge?: string;
  emoji: string;
  position: 'stitch-desktop-left' | 'stitch-desktop-right-top' | 'stitch-desktop-right-bottom' | 'stitch-mobile-left' | 'stitch-mobile-right' | 'stitch-mobile-micro';
}

export const STITCH_PHOTOS_CATALOG: StitchPhotoItem[] = [
  {
    id: 'asado-desktop',
    src: '/images/stitch/asado_amigos.webp',
    alt: 'Amigos compartiendo un asado al aire libre',
    caption: 'Fuego al aire libre',
    badge: 'Tarde entre amigos',
    emoji: '🥩',
    position: 'stitch-desktop-left',
  },
  {
    id: 'padel-desktop',
    src: '/images/stitch/padel_sol.webp',
    alt: 'Amigos jugando al pádel en un día soleado',
    caption: 'Una tarde de pádel',
    emoji: '🎾',
    position: 'stitch-desktop-right-top',
  },
  {
    id: 'cafe-desktop',
    src: '/images/stitch/cafe_charla.webp',
    alt: 'Mesa de amigos en cafetería al atardecer',
    caption: 'Café de charla',
    emoji: '☕',
    position: 'stitch-desktop-right-bottom',
  },
  {
    id: 'asado-mobile',
    src: '/images/stitch/asado_amigos.webp',
    alt: 'Asado entre amigos',
    caption: 'Asado al aire libre',
    emoji: '🥩',
    position: 'stitch-mobile-left',
  },
  {
    id: 'mates-mobile',
    src: '/images/stitch/mates_sol.webp',
    alt: 'Ronda de mates al sol',
    caption: 'Mates al sol',
    emoji: '🧉',
    position: 'stitch-mobile-right',
  },
  {
    id: 'padel-mobile',
    src: '/images/stitch/padel_sol.webp',
    alt: 'Tarde de pádel',
    caption: 'Pádel al sol',
    emoji: '🎾',
    position: 'stitch-mobile-micro',
  },
];

export interface HomeDynamicCanvasProps {
  variant: HomeVisualVariant;
  isInputFocused?: boolean;
  onTagClick?: (tagText: string) => void;
}

export const HomeDynamicCanvas: React.FC<HomeDynamicCanvasProps> = ({
  variant,
  isInputFocused = false,
  onTagClick,
}) => {
  const [isTabVisible, setIsTabVisible] = useState(true);

  // Pausar animaciones cuando la pestaña está oculta para ahorrar batería/GPU
  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsTabVisible(!document.hidden);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return (
    <div
      className={`home-dynamic-canvas home-dynamic-canvas--${variant} ${
        isInputFocused ? 'home-dynamic-canvas--input-focused' : ''
      } ${!isTabVisible ? 'home-dynamic-canvas--paused' : ''}`}
      aria-hidden="true"
    >
      {/* ── FOTOGRAFÍAS EN MOVIMIENTO ── */}
      <div className="home-dynamic-photos-layer">
        {variant === 'stitch' ? (
          /* Variante D: Mundo Vivo Stitch — Composición Asimétrica Panorámica y Profundidad Orgánica */
          <div className="home-stitch-photos-stage">
            {/* Flanco Izquierdo Desktop: Fotografía humana grande (Asado) */}
            <div className="home-stitch-photo home-stitch-photo--left">
              <img
                src={STITCH_PHOTOS_CATALOG[0].src}
                alt={STITCH_PHOTOS_CATALOG[0].alt}
                className="home-stitch-photo-img"
                loading="eager"
              />
              <div className="home-stitch-photo-overlay" />
              <div className="home-stitch-photo-card-tag">
                <span className="home-stitch-card-emoji">{STITCH_PHOTOS_CATALOG[0].emoji}</span>
                <span className="home-stitch-card-title">{STITCH_PHOTOS_CATALOG[0].caption}</span>
                <span className="home-stitch-card-arrow">↗</span>
              </div>
              <div className="home-stitch-photo-subtag">
                <span className="home-stitch-subtag-dot" />
                <span>{STITCH_PHOTOS_CATALOG[0].badge}</span>
              </div>
            </div>

            {/* Flanco Derecho Superior Desktop: Escena de Pádel a distinta altura y escala */}
            <div className="home-stitch-photo home-stitch-photo--right-top">
              <div className="home-stitch-photo-tag-top">
                <span>{STITCH_PHOTOS_CATALOG[1].emoji}</span>
                <span>{STITCH_PHOTOS_CATALOG[1].caption}</span>
              </div>
              <img
                src={STITCH_PHOTOS_CATALOG[1].src}
                alt={STITCH_PHOTOS_CATALOG[1].alt}
                className="home-stitch-photo-img"
                loading="eager"
              />
              <div className="home-stitch-photo-overlay" />
            </div>

            {/* Flanco Derecho Inferior Desktop: Escena de Café en plano inferior */}
            <div className="home-stitch-photo home-stitch-photo--right-bottom">
              <img
                src={STITCH_PHOTOS_CATALOG[2].src}
                alt={STITCH_PHOTOS_CATALOG[2].alt}
                className="home-stitch-photo-img"
                loading="lazy"
              />
              <div className="home-stitch-photo-overlay" />
              <div className="home-stitch-photo-tag-bottom">
                <span>{STITCH_PHOTOS_CATALOG[2].emoji}</span>
                <span>{STITCH_PHOTOS_CATALOG[2].caption}</span>
              </div>
            </div>

            {/* Mobile Cornisa Superior: 3 fragmentos fotográficos vivos sin desplazar el H1 */}
            <div className="home-stitch-mobile-stage">
              <div className="home-stitch-mobile-frag home-stitch-mobile-frag--left">
                <img src={STITCH_PHOTOS_CATALOG[3].src} alt="" className="home-stitch-frag-img" />
                <div className="home-stitch-frag-overlay" />
                <span className="home-stitch-frag-pill">🥩 Asado</span>
              </div>

              <div className="home-stitch-mobile-frag home-stitch-mobile-frag--right">
                <img src={STITCH_PHOTOS_CATALOG[4].src} alt="" className="home-stitch-frag-img" />
                <div className="home-stitch-frag-overlay" />
                <span className="home-stitch-frag-pill">🧉 Mates</span>
              </div>

              <div className="home-stitch-mobile-frag home-stitch-mobile-frag--micro">
                <img src={STITCH_PHOTOS_CATALOG[5].src} alt="" className="home-stitch-frag-img" />
              </div>
            </div>
          </div>
        ) : variant === 'envolvente' ? (
          /* Variante A: Fotografías en flancos envolventes y flotación orbital */
          <>
            {/* Flanco Izquierdo: Asado y Mates */}
            <div className="home-dynamic-photo-card home-dynamic-photo-card--left-top">
              <img
                src={ANIMATED_PHOTOS_CATALOG[0].src}
                alt={ANIMATED_PHOTOS_CATALOG[0].alt}
                className="home-dynamic-photo-img"
                loading="eager"
              />
              <div className="home-dynamic-photo-badge">
                <span className="home-photo-badge-emoji">{ANIMATED_PHOTOS_CATALOG[0].emoji}</span>
                <div className="home-photo-badge-texts">
                  <span className="home-photo-badge-title">{ANIMATED_PHOTOS_CATALOG[0].title}</span>
                  <span className="home-photo-badge-meta">{ANIMATED_PHOTOS_CATALOG[0].meta}</span>
                </div>
                <span className="home-photo-badge-status">{ANIMATED_PHOTOS_CATALOG[0].badge}</span>
              </div>
            </div>

            <div className="home-dynamic-photo-card home-dynamic-photo-card--left-bottom">
              <img
                src={ANIMATED_PHOTOS_CATALOG[1].src}
                alt={ANIMATED_PHOTOS_CATALOG[1].alt}
                className="home-dynamic-photo-img"
                loading="lazy"
              />
              <div className="home-dynamic-photo-badge">
                <span className="home-photo-badge-emoji">{ANIMATED_PHOTOS_CATALOG[1].emoji}</span>
                <div className="home-photo-badge-texts">
                  <span className="home-photo-badge-title">{ANIMATED_PHOTOS_CATALOG[1].title}</span>
                  <span className="home-photo-badge-meta">{ANIMATED_PHOTOS_CATALOG[1].meta}</span>
                </div>
                <span className="home-photo-badge-status">{ANIMATED_PHOTOS_CATALOG[1].badge}</span>
              </div>
            </div>

            {/* Flanco Derecho: Pádel y Café */}
            <div className="home-dynamic-photo-card home-dynamic-photo-card--right-top">
              <img
                src={ANIMATED_PHOTOS_CATALOG[2].src}
                alt={ANIMATED_PHOTOS_CATALOG[2].alt}
                className="home-dynamic-photo-img"
                loading="eager"
              />
              <div className="home-dynamic-photo-badge">
                <span className="home-photo-badge-emoji">{ANIMATED_PHOTOS_CATALOG[2].emoji}</span>
                <div className="home-photo-badge-texts">
                  <span className="home-photo-badge-title">{ANIMATED_PHOTOS_CATALOG[2].title}</span>
                  <span className="home-photo-badge-meta">{ANIMATED_PHOTOS_CATALOG[2].meta}</span>
                </div>
                <span className="home-photo-badge-status">{ANIMATED_PHOTOS_CATALOG[2].badge}</span>
              </div>
            </div>

            <div className="home-dynamic-photo-card home-dynamic-photo-card--right-bottom">
              <img
                src={ANIMATED_PHOTOS_CATALOG[3].src}
                alt={ANIMATED_PHOTOS_CATALOG[3].alt}
                className="home-dynamic-photo-img"
                loading="lazy"
              />
              <div className="home-dynamic-photo-badge">
                <span className="home-photo-badge-emoji">{ANIMATED_PHOTOS_CATALOG[3].emoji}</span>
                <div className="home-photo-badge-texts">
                  <span className="home-photo-badge-title">{ANIMATED_PHOTOS_CATALOG[3].title}</span>
                  <span className="home-photo-badge-meta">{ANIMATED_PHOTOS_CATALOG[3].meta}</span>
                </div>
                <span className="home-photo-badge-status">{ANIMATED_PHOTOS_CATALOG[3].badge}</span>
              </div>
            </div>

            {/* Mobile Photo Floating Capsules */}
            <div className="home-dynamic-photo-mobile-wrapper">
              <div className="home-dynamic-photo-mobile-pill home-dynamic-photo-mobile-pill--1">
                <img src={ANIMATED_PHOTOS_CATALOG[0].src} alt="" className="home-mobile-pill-img" />
                <span className="home-mobile-pill-tag">🍕 Asado sábado</span>
              </div>
              <div className="home-dynamic-photo-mobile-pill home-dynamic-photo-mobile-pill--2">
                <img src={ANIMATED_PHOTOS_CATALOG[2].src} alt="" className="home-mobile-pill-img" />
                <span className="home-mobile-pill-tag">🎾 Pádel</span>
              </div>
            </div>
          </>
        ) : variant === 'visor' ? (
          /* Variante B: Visor Dinámico — Portales fotográficos con profundidad y aura */
          <div className="home-dynamic-visor-stage">
            <div className="home-visor-portal home-visor-portal--left">
              <img
                src={ANIMATED_PHOTOS_CATALOG[0].src}
                alt="Encuentro vivo"
                className="home-visor-portal-img"
              />
              <div className="home-visor-portal-glass">
                <span className="home-visor-portal-pill">🥩 Asado en marcha</span>
              </div>
            </div>

            <div className="home-visor-portal home-visor-portal--center">
              <img
                src={ANIMATED_PHOTOS_CATALOG[4].src}
                alt="Encuentro vivo"
                className="home-visor-portal-img"
              />
              <div className="home-visor-portal-glass">
                <span className="home-visor-portal-pill">🍽️ Cena de viernes</span>
              </div>
            </div>

            <div className="home-visor-portal home-visor-portal--right">
              <img
                src={ANIMATED_PHOTOS_CATALOG[2].src}
                alt="Encuentro vivo"
                className="home-visor-portal-img"
              />
              <div className="home-visor-portal-glass">
                <span className="home-visor-portal-pill">🎾 Turno pádel</span>
              </div>
            </div>
          </div>
        ) : (
          /* Variante C: Espacio Vivo Refinado — Momentos orgánicos asimétricos con micro-captions */
          <div className="home-refinado-photos-stage">
            {/* Momento 1 Desktop: Asado en margen izquierdo superior */}
            <div className="home-refinado-photo-momento home-refinado-photo-momento--left">
              <img
                src={REFINADO_PHOTOS_CATALOG[0].src}
                alt={REFINADO_PHOTOS_CATALOG[0].alt}
                className="home-refinado-photo-img"
                loading="eager"
              />
              <div className="home-refinado-photo-caption">
                <span className="home-refinado-caption-emoji">{REFINADO_PHOTOS_CATALOG[0].emoji}</span>
                <span>{REFINADO_PHOTOS_CATALOG[0].caption}</span>
              </div>
            </div>

            {/* Momento 2 Desktop: Pádel en margen derecho medio-alto */}
            <div className="home-refinado-photo-momento home-refinado-photo-momento--right-top">
              <img
                src={REFINADO_PHOTOS_CATALOG[1].src}
                alt={REFINADO_PHOTOS_CATALOG[1].alt}
                className="home-refinado-photo-img"
                loading="eager"
              />
              <div className="home-refinado-photo-caption">
                <span className="home-refinado-caption-emoji">{REFINADO_PHOTOS_CATALOG[1].emoji}</span>
                <span>{REFINADO_PHOTOS_CATALOG[1].caption}</span>
              </div>
            </div>

            {/* Momento 3 Desktop: Café en margen derecho inferior */}
            <div className="home-refinado-photo-momento home-refinado-photo-momento--right-bottom">
              <img
                src={REFINADO_PHOTOS_CATALOG[2].src}
                alt={REFINADO_PHOTOS_CATALOG[2].alt}
                className="home-refinado-photo-img"
                loading="lazy"
              />
              <div className="home-refinado-photo-caption">
                <span className="home-refinado-caption-emoji">{REFINADO_PHOTOS_CATALOG[2].emoji}</span>
                <span>{REFINADO_PHOTOS_CATALOG[2].caption}</span>
              </div>
            </div>

            {/* Momentos Mobile: Viñetas sutiles en esquinas que NO empujan el H1 hacia abajo */}
            <div className="home-refinado-mobile-peek home-refinado-mobile-peek--left">
              <img
                src={REFINADO_PHOTOS_CATALOG[4].src}
                alt=""
                className="home-refinado-peek-img"
              />
              <span className="home-refinado-peek-pill">🥩 Asado</span>
            </div>

            <div className="home-refinado-mobile-peek home-refinado-mobile-peek--right">
              <img
                src={REFINADO_PHOTOS_CATALOG[3].src}
                alt=""
                className="home-refinado-peek-img"
              />
              <span className="home-refinado-peek-pill">🧉 Mates</span>
            </div>
          </div>
        )}
      </div>

      {/* ── ETIQUETAS FLOTANTES DINÁMICAS ── */}
      <div className="home-dynamic-tags-layer">
        {variant === 'stitch' ? (
          /* Variante D: Etiquetas con microvariantes de forma, paleta pastel, patrones cinéticos y zona de exclusión central */
          STITCH_TAGS_CATALOG.map((tag) => (
            <div
              key={tag.id}
              className={`home-floating-tag home-floating-tag--stitch home-floating-tag--stitch-${tag.styleVariant} home-floating-tag--stitch-color-${tag.colorTheme} home-floating-tag--stitch-shape-${tag.shapeVariant} home-floating-tag--size-${tag.sizeTier || 'medium'} ${
                tag.mobileSlot
                  ? `home-floating-tag--mobile-slot-${tag.mobileSlot} home-floating-tag--mobile-${tag.mobileZone}`
                  : 'home-floating-tag--mobile-hidden'
              } home-floating-tag--motion-${tag.motionPattern} home-floating-tag--track-${tag.track} home-floating-tag--lane-${tag.lane} home-floating-tag--tag-${tag.id}`}
              onClick={() => onTagClick?.(tag.text)}
              style={{
                animationDelay: tag.delay,
                ...(tag.duration ? { animationDuration: tag.duration } : {}),
              }}
            >
              <span className="home-floating-tag-emoji">{tag.emoji}</span>
              <span className="home-floating-tag-text">{tag.text}</span>
            </div>
          ))
        ) : variant === 'refinado' ? (
          /* Variante C: Etiquetas coreografiadas con zona central de seguridad y menor densidad */
          REFINADO_TAGS_CATALOG.map((tag, idx) => (
            <div
              key={tag.id}
              className={`home-floating-tag home-floating-tag--refinado home-floating-tag--${tag.colorScheme} home-floating-tag--track-${tag.track} home-floating-tag--refinado-${idx} ${
                tag.isGhost ? 'home-floating-tag--ghost' : ''
              }`}
              onClick={() => onTagClick?.(tag.text)}
              style={{
                animationDelay: tag.delay,
              }}
            >
              <span className="home-floating-tag-emoji">{tag.emoji}</span>
              <span className="home-floating-tag-text">{tag.text}</span>
            </div>
          ))
        ) : (
          /* Variante A y B: Catálogo estándar */
          FLOATING_TAGS_CATALOG.map((tag, idx) => (
            <div
              key={tag.id}
              className={`home-floating-tag home-floating-tag--${tag.colorScheme} home-floating-tag--track-${tag.track} home-floating-tag--index-${idx}`}
              onClick={() => onTagClick?.(tag.text)}
              style={{
                animationDelay: `${-1.8 * (idx + 1)}s`,
              }}
            >
              <span className="home-floating-tag-emoji">{tag.emoji}</span>
              <span className="home-floating-tag-text">{tag.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
