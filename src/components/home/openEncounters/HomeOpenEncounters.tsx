import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ChevronLeft, ChevronRight, MapPin, Sparkles, RefreshCw, AlertCircle, Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OpenEncounterSummary, Localidad } from './types';
import type { PublicIntencionSummary } from '@/types/intenciones';
import type { CrearAlertaParams } from '@/types/matchAlerts';
import { PENDING_AVISAME_DRAFT_KEY } from '@/types/matchAlerts';
import { OPEN_ENCOUNTERS_DEMO } from './demoData';
import { DEFAULT_LOCALIDADES } from '@/constants/localidades';
import { HomeOpenEncounterCard } from './HomeOpenEncounterCard';
import { HomeOpenEncounterDetailSheet } from './HomeOpenEncounterDetailSheet';
import { ZoneSelectorModal } from './ZoneSelectorModal';
import { PublicIntencionCard } from '../discovery/PublicIntencionCard';
import { AvisameSheet } from '../alerts/AvisameSheet';
import { LoginRequiredSheet } from '@/components/auth/LoginRequiredSheet';
import { openEncountersService } from '@/services/openEncountersService';
import {
  useUnifiedDiscovery,
  OTHER_ZONES_SUGGESTION_THRESHOLD,
  MAX_OTHER_ZONE_SUGGESTIONS,
} from '@/hooks/useUnifiedDiscovery';
import { useAuth } from '@/contexts/AuthContext';
import './HomeOpenEncounters.css';

export const PENDING_INTENTION_INTEREST_KEY = 'puntoencuentro_pending_intention_interest';
export { PENDING_AVISAME_DRAFT_KEY };
export { OTHER_ZONES_SUGGESTION_THRESHOLD, MAX_OTHER_ZONE_SUGGESTIONS };

export type DiscoveryTab = 'todo' | 'encuentros' | 'intenciones';

export interface HomeOpenEncountersProps {
  encounters?: OpenEncounterSummary[];
  intentions?: PublicIntencionSummary[];
  secondaryEncounters?: OpenEncounterSummary[];
  secondaryIntentions?: PublicIntencionSummary[];
  selectedLocalityIds?: string[];
  noZonesConfigured?: boolean;
  onOpenCreate?: () => void;
  onConfigureZones?: () => void;
  onSeeAll?: () => void;
  /** Callback para enfocar y hacer scroll suave al input de intención existente en Home */
  onFocusIntentInput?: () => void;
  /**
   * Forzar modo demo o modo real explícitamente.
   * Si no se define, se permite fallback a demo sólo en rutas /preview.
   * En rutas normales (Home, Staging real, Prod) se muestran datos reales y empty states reales.
   */
  isDemoMode?: boolean;
  /** Título personalizado para la sección de intenciones (por defecto "Ganas de…") */
  intentionsTitle?: string;
  /** Si está activa la variante V2 (desktop carrusel con flechas, orden por fecha ascendente) */
  isV2Variant?: boolean;
}

/**
 * Helper para calcular las posiciones canónicas absolutas de scroll (scrollLeft) de cada tarjeta
 * relativas al sistema de coordenadas de desplazamiento del track.
 * Invariante ante offsets relativos, breakout full-bleed, paddings o transformaciones CSS.
 */
export const getCardScrollTargets = (track: HTMLElement): number[] => {
  const cards = Array.from(track.querySelectorAll('.pe-discovery-item')) as HTMLElement[];
  if (cards.length === 0) return [];

  const trackRect = track.getBoundingClientRect();
  const currentScroll = track.scrollLeft;
  const firstCardLeft = cards[0].getBoundingClientRect().left - trackRect.left + currentScroll;

  return cards.map((card, idx) => {
    if (idx === 0) return 0;
    const cardLeft = card.getBoundingClientRect().left - trackRect.left + currentScroll;
    return Math.max(0, Math.round(cardLeft - firstCardLeft));
  });
};

export const HomeOpenEncounters: React.FC<HomeOpenEncountersProps> = ({
  encounters: propEncounters,
  intentions: propIntentions,
  secondaryEncounters: propSecondaryEncounters,
  secondaryIntentions: propSecondaryIntentions,
  selectedLocalityIds: propLocalityIds,
  noZonesConfigured = false,
  onOpenCreate,
  onConfigureZones,
  onSeeAll,
  isDemoMode,
  onFocusIntentInput,
  intentionsTitle,
  isV2Variant = false,
}) => {
  const { t } = useTranslation();
  const { isPermanentUser, signInWithGoogleForDiscovery } = useAuth();

  const [discoveryTab, setDiscoveryTab] = useState<DiscoveryTab>('todo');

  const trackRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [selectedEncounter, setSelectedEncounter] = useState<OpenEncounterSummary | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isZoneModalOpen, setIsZoneModalOpen] = useState(false);
  const isInteractingRef = useRef(false);
  const isDetailOpenRef = useRef(false);
  const autoplayTimerRef = useRef<number | null>(null);
  const resumeTimerRef = useRef<number | null>(null);

  // Auth Guard Sheet & Pending Action
  const [isLoginSheetOpen, setIsLoginSheetOpen] = useState(false);
  const [loginSheetAction, setLoginSheetAction] = useState<
    'request_join' | 'open_encounter' | 'create_ai' | 'create_intention' | 'interest_intention' | 'create_alert'
  >('interest_intention');
  const [isOAuthStarting, setIsOAuthStarting] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const hasProcessedPendingInterestRef = useRef(false);
  const hasProcessedPendingAvisameRef = useRef(false);

  // Avisame Sheet State
  const [isAvisameOpen, setIsAvisameOpen] = useState(false);
  const [avisameTab, setAvisameTab] = useState<'create' | 'list'>('create');
  const [avisameDraft, setAvisameDraft] = useState<Partial<CrearAlertaParams> | null>(null);

  // Catálogo activo para reconciliación de preferencias stale y cálculo de otras macrozonas
  const [activeCatalogue, setActiveCatalogue] = useState<Localidad[]>(DEFAULT_LOCALIDADES);

  useEffect(() => {
    let mounted = true;
    openEncountersService.getLocalidades().then((data) => {
      if (mounted && data && data.length > 0) {
        setActiveCatalogue(data);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Zonas del usuario (prop o cargadas de service)
  const [userZones, setUserZones] = useState<string[]>(propLocalityIds || []);

  useEffect(() => {
    if (propLocalityIds) {
      setUserZones(propLocalityIds);
    } else {
      openEncountersService.getUserLocalidades().then((ids) => {
        if (ids && ids.length > 0) {
          setUserZones(ids);
        }
      });
    }
  }, [propLocalityIds]);

  // Reconciliación stale: savedZones ∩ activeCatalogue = effectiveZones
  const effectiveZones = useMemo(() => {
    if (!userZones || userZones.length === 0) return [];
    return userZones.filter((id) => activeCatalogue.some((loc) => loc.id === id));
  }, [userZones, activeCatalogue]);

  // Otras macrozonas activas para Discovery secundario
  const otherActiveZoneIds = useMemo(() => {
    if (effectiveZones.length === 0) return [];
    return activeCatalogue
      .map((l) => l.id)
      .filter((id) => !effectiveZones.includes(id));
  }, [effectiveZones, activeCatalogue]);

  // Hook central de Discovery Unificado
  const {
    encounters: hookEncounters,
    intentions: hookIntentions,
    secondaryEncounters: hookSecondaryEncounters,
    secondaryIntentions: hookSecondaryIntentions,
    loading: hookLoading,
    error: hookError,
    encountersError,
    intentionsError,
    refresh,
    setIntentionInterest,
  } = useUnifiedDiscovery({
    localityIds: effectiveZones.length > 0 ? effectiveZones : undefined,
    otherActiveLocalityIds: otherActiveZoneIds.length > 0 ? otherActiveZoneIds : undefined,
    enabled: propEncounters === undefined && propIntentions === undefined,
  });

  // Determinar si se permite fallback demo de diseño
  const allowDemoFallback = useMemo(() => {
    if (typeof isDemoMode === 'boolean') return isDemoMode;
    if (typeof window !== 'undefined') {
      return window.location.pathname.startsWith('/preview');
    }
    return false;
  }, [isDemoMode]);

  // Encuentros e intenciones efectivos
  const liveEncounters = useMemo<OpenEncounterSummary[]>(() => {
    if (propEncounters !== undefined) return propEncounters;
    if (hookEncounters && hookEncounters.length > 0) return hookEncounters;
    if (allowDemoFallback && !hookLoading) return OPEN_ENCOUNTERS_DEMO;
    return hookEncounters || [];
  }, [propEncounters, hookEncounters, allowDemoFallback, hookLoading]);

  const liveIntentions = useMemo<PublicIntencionSummary[]>(() => {
    if (propIntentions !== undefined) return propIntentions;
    return hookIntentions || [];
  }, [propIntentions, hookIntentions]);

  // Filtrado por zonas seleccionadas efectivas con orden canónico ascendente (V2) o por defecto (V1)
  const visibleEncounters = useMemo(() => {
    if (!liveEncounters || liveEncounters.length === 0) return [];
    const filtered = effectiveZones && effectiveZones.length > 0
      ? liveEncounters.filter((e) => effectiveZones.includes(e.localityId))
      : liveEncounters;

    // En V2: ordenar copia de los resultados de forma ascendente (más próximo -> más lejano)
    if (isV2Variant) {
      return [...filtered].sort((a, b) => {
        const timeA = new Date(a.startsAt).getTime();
        const timeB = new Date(b.startsAt).getTime();
        const valA = isNaN(timeA) ? 0 : timeA;
        const valB = isNaN(timeB) ? 0 : timeB;
        return valA - valB;
      });
    }

    return filtered;
  }, [liveEncounters, effectiveZones, isV2Variant]);

  const visibleIntentions = useMemo(() => {
    if (!liveIntentions || liveIntentions.length === 0) return [];
    if (!effectiveZones || effectiveZones.length === 0) return liveIntentions;
    return liveIntentions.filter(
      (i) => i.modalidad === 'virtual' || (i.locality_id && effectiveZones.includes(i.locality_id))
    );
  }, [liveIntentions, effectiveZones]);

  // Sugerencias secundarias de otras macrozonas
  const liveSecondaryEncounters = useMemo<OpenEncounterSummary[]>(() => {
    if (propSecondaryEncounters !== undefined) return propSecondaryEncounters;
    return hookSecondaryEncounters || [];
  }, [propSecondaryEncounters, hookSecondaryEncounters]);

  const liveSecondaryIntentions = useMemo<PublicIntencionSummary[]>(() => {
    if (propSecondaryIntentions !== undefined) return propSecondaryIntentions;
    return hookSecondaryIntentions || [];
  }, [propSecondaryIntentions, hookSecondaryIntentions]);

  const visibleSecondaryEncounters = useMemo(() => {
    if (effectiveZones.length === 0) return [];
    const primaryIds = new Set(visibleEncounters.map((e) => e.id));
    return liveSecondaryEncounters
      .filter((e) => !effectiveZones.includes(e.localityId) && !primaryIds.has(e.id))
      .slice(0, MAX_OTHER_ZONE_SUGGESTIONS);
  }, [effectiveZones, visibleEncounters, liveSecondaryEncounters]);

  const visibleSecondaryIntentions = useMemo(() => {
    if (effectiveZones.length === 0) return [];
    const primaryIds = new Set(visibleIntentions.map((i) => i.id));
    return liveSecondaryIntentions
      .filter(
        (i) =>
          i.modalidad !== 'virtual' &&
          Boolean(i.locality_id && !effectiveZones.includes(i.locality_id)) &&
          !primaryIds.has(i.id)
      )
      .slice(0, MAX_OTHER_ZONE_SUGGESTIONS);
  }, [effectiveZones, visibleIntentions, liveSecondaryIntentions]);

  // ── RECUPERACIÓN DE INTERÉS PENDIENTE POST-OAUTH ──
  useEffect(() => {
    if (!isPermanentUser) return;
    if (hasProcessedPendingInterestRef.current) return;
    if (typeof sessionStorage === 'undefined') return;

    const raw = sessionStorage.getItem(PENDING_INTENTION_INTEREST_KEY);
    if (!raw) return;

    try {
      const pending = JSON.parse(raw) as { intencionId: string; interesado: boolean };
      if (pending && pending.intencionId && pending.interesado === true) {
        hasProcessedPendingInterestRef.current = true;
        setActionLoadingId(pending.intencionId);

        setIntentionInterest(pending.intencionId, true)
          .then((res) => {
            if (res.ok) {
              sessionStorage.removeItem(PENDING_INTENTION_INTEREST_KEY);
            }
          })
          .catch((err) => {
            console.warn('[HomeOpenEncounters] Error reintentando pending interest:', err);
          })
          .finally(() => {
            setActionLoadingId(null);
          });
      }
    } catch (err) {
      console.warn('[HomeOpenEncounters] Error parseando pending interest:', err);
    }
  }, [isPermanentUser, setIntentionInterest]);

  // ── RECUPERACIÓN DE BORRADOR DE AVISAME POST-OAUTH ──
  useEffect(() => {
    if (!isPermanentUser) return;
    if (hasProcessedPendingAvisameRef.current) return;
    if (typeof sessionStorage === 'undefined') return;

    const raw = sessionStorage.getItem(PENDING_AVISAME_DRAFT_KEY);
    if (!raw) return;

    try {
      const draft = JSON.parse(raw) as Partial<CrearAlertaParams>;
      if (draft) {
        hasProcessedPendingAvisameRef.current = true;
        sessionStorage.removeItem(PENDING_AVISAME_DRAFT_KEY);
        setAvisameDraft(draft);
        setAvisameTab('create');
        setIsAvisameOpen(true);
      }
    } catch (err) {
      console.warn('[HomeOpenEncounters] Error recuperando draft avisame:', err);
      sessionStorage.removeItem(PENDING_AVISAME_DRAFT_KEY);
    }
  }, [isPermanentUser]);

  const handleOpenAvisame = (tab: 'create' | 'list' = 'create') => {
    if (!isPermanentUser) {
      const defaultDraft: Partial<CrearAlertaParams> = {
        modalidad: effectiveZones.length > 0 ? 'presencial' : 'indistinto',
        localityId: effectiveZones[0] || null,
      };
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(PENDING_AVISAME_DRAFT_KEY, JSON.stringify(defaultDraft));
      }
      setLoginSheetAction('create_alert');
      setIsLoginSheetOpen(true);
      return;
    }

    setAvisameDraft({
      modalidad: effectiveZones.length > 0 ? 'presencial' : 'indistinto',
      localityId: effectiveZones[0] || null,
    });
    setAvisameTab(tab);
    setIsAvisameOpen(true);
  };

  // Manejo de clicks en botón de interés
  const handleInterestClick = async (intencionId: string, interesado: boolean) => {
    if (interesado === true && !isPermanentUser) {
      // Guardar pending action exclusivamente con intencionId e interesado: true
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(
          PENDING_INTENTION_INTEREST_KEY,
          JSON.stringify({ intencionId, interesado: true })
        );
      }
      setLoginSheetAction('interest_intention');
      setIsLoginSheetOpen(true);
      return;
    }

    setActionLoadingId(intencionId);
    try {
      await setIntentionInterest(intencionId, interesado);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleLoginWithGoogle = async () => {
    setIsOAuthStarting(true);
    try {
      const res = await signInWithGoogleForDiscovery();
      if (!res.ok) {
        setIsOAuthStarting(false);
      }
    } catch {
      setIsOAuthStarting(false);
    }
  };

  const handleFocusIntent = () => {
    if (onFocusIntentInput) {
      onFocusIntentInput();
    } else {
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-testid="home-intent-textarea"]');
      if (textarea) {
        textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
        textarea.focus();
      }
    }
  };

  useEffect(() => {
    isDetailOpenRef.current = isDetailOpen;
  }, [isDetailOpen]);

  // Actualizar estado de scroll (overflow y flechas anterior/siguiente)
  const updateScrollState = useCallback(() => {
    const track = trackRef.current;
    if (!track) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      setHasOverflow(false);
      return;
    }

    const { scrollLeft, scrollWidth, clientWidth } = track;
    const overflow = scrollWidth > clientWidth + 1;
    setHasOverflow(overflow);
    setCanScrollLeft(scrollLeft > 2);
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 2);
  }, []);

  // Asegurar que el carrusel comience siempre alineado en scrollLeft 0 y actualizar estado de scroll
  useEffect(() => {
    if (trackRef.current) {
      trackRef.current.scrollLeft = 0;
    }
    updateScrollState();
  }, [visibleEncounters.length, updateScrollState]);

  // Listener para scroll y resize de track
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const handleScrollEvent = () => {
      updateScrollState();
    };

    track.addEventListener('scroll', handleScrollEvent, { passive: true });
    window.addEventListener('resize', updateScrollState);

    updateScrollState();

    return () => {
      track.removeEventListener('scroll', handleScrollEvent);
      window.removeEventListener('resize', updateScrollState);
    };
  }, [updateScrollState, visibleEncounters.length]);

  // Avanza un paso en el carrusel (reutilizado por autoplay y flecha siguiente)
  const advanceCarousel = useCallback((track: HTMLElement) => {
    const targets = getCardScrollTargets(track);
    if (targets.length <= 1) return;

    const currentScroll = track.scrollLeft;
    const maxScrollLeft = track.scrollWidth - track.clientWidth;

    // Buscar la siguiente tarjeta a la derecha (+10px para tolerancia a subpíxeles o snap)
    const nextTarget = targets.find((t) => t > currentScroll + 10);
    if (nextTarget !== undefined && nextTarget <= maxScrollLeft + 2) {
      track.scrollTo({ left: Math.min(maxScrollLeft, nextTarget), behavior: 'smooth' });
    } else {
      // Fin del carrusel: reiniciar suavemente a la primera card en el siguiente ciclo
      track.scrollTo({ left: 0, behavior: 'smooth' });
    }
  }, []);

  // Programar o reiniciar el temporizador de auto-avance (~10s)
  const resetAutoplayTimer = useCallback((delayMs = 10000) => {
    if (autoplayTimerRef.current) {
      window.clearTimeout(autoplayTimerRef.current);
      autoplayTimerRef.current = null;
    }

    if (typeof window === 'undefined') return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    if (visibleEncounters.length <= 1) return;

    autoplayTimerRef.current = window.setTimeout(() => {
      if (isInteractingRef.current || isDetailOpenRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        // Si la pestaña no está visible, esperar y volver a programar para cuando el usuario regrese
        resetAutoplayTimer(delayMs);
        return;
      }

      const track = trackRef.current;
      if (track) {
        advanceCarousel(track);
      }
      resetAutoplayTimer(delayMs);
    }, delayMs);
  }, [visibleEncounters.length, advanceCarousel]);

  // Pausa temporal de auto-avance con reanudación diferida que reinicia el timer completo de ~10s
  const pauseAutoAdvance = useCallback((resumeDelayMs = 10000) => {
    isInteractingRef.current = true;
    if (autoplayTimerRef.current) {
      window.clearTimeout(autoplayTimerRef.current);
      autoplayTimerRef.current = null;
    }
    if (resumeTimerRef.current) {
      window.clearTimeout(resumeTimerRef.current);
    }
    resumeTimerRef.current = window.setTimeout(() => {
      isInteractingRef.current = false;
      resetAutoplayTimer(10000);
    }, resumeDelayMs);
  }, [resetAutoplayTimer]);

  // Manejadores de navegación por flechas desktop
  const handleScrollPrev = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;

    const targets = getCardScrollTargets(track);
    if (targets.length === 0) return;

    const currentScroll = track.scrollLeft;
    let targetLeft = 0;
    for (let i = targets.length - 1; i >= 0; i--) {
      if (targets[i] < currentScroll - 10) {
        targetLeft = targets[i];
        break;
      }
    }

    track.scrollTo({ left: Math.max(0, targetLeft), behavior: 'smooth' });
    // Al interactuar manualmente con la flecha, se reinicia el timer completo de 10s
    pauseAutoAdvance(10000);
  }, [pauseAutoAdvance]);

  const handleScrollNext = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;

    const targets = getCardScrollTargets(track);
    if (targets.length === 0) return;

    const currentScroll = track.scrollLeft;
    const maxScrollLeft = track.scrollWidth - track.clientWidth;
    const nextTarget = targets.find((t) => t > currentScroll + 10);
    const targetLeft = nextTarget !== undefined ? nextTarget : maxScrollLeft;

    track.scrollTo({ left: Math.min(maxScrollLeft, targetLeft), behavior: 'smooth' });
    // Al interactuar manualmente con la flecha, se reinicia el timer completo de 10s
    pauseAutoAdvance(10000);
  }, [pauseAutoAdvance]);

  // Ciclo de Autoplay accesible:
  // - Intervalo de ~10s
  // - Avanza 1 card a la vez con el mismo cálculo de paso que la flecha derecha
  // - Se pausa en hover, focus, touch o swipe
  // - No se reanuda de golpe al soltar: reinicia el timer completo de ~10s
  // - Desactivado completamente si prefers-reduced-motion: reduce
  // - Se suspende cuando document.visibilityState !== 'visible'
  // - Al llegar al final, vuelve a 0 suavemente en el siguiente ciclo
  useEffect(() => {
    resetAutoplayTimer(10000);

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        resetAutoplayTimer(10000);
      } else {
        if (autoplayTimerRef.current) {
          window.clearTimeout(autoplayTimerRef.current);
          autoplayTimerRef.current = null;
        }
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (autoplayTimerRef.current) {
        window.clearTimeout(autoplayTimerRef.current);
        autoplayTimerRef.current = null;
      }
      if (resumeTimerRef.current) {
        window.clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
    };
  }, [visibleEncounters.length, resetAutoplayTimer]);

  const handleCardClick = (encounter: OpenEncounterSummary) => {
    isDetailOpenRef.current = true;
    if (autoplayTimerRef.current) {
      window.clearTimeout(autoplayTimerRef.current);
      autoplayTimerRef.current = null;
    }
    setSelectedEncounter(encounter);
    setIsDetailOpen(true);
  };

  const handleCloseDetail = () => {
    setIsDetailOpen(false);
    setSelectedEncounter(null);
    isDetailOpenRef.current = false;
    resetAutoplayTimer(10000);
  };

  const handleOpenZoneModal = () => {
    if (onConfigureZones) {
      onConfigureZones();
    } else {
      setIsZoneModalOpen(true);
    }
  };

  const handleSaveZones = (newZones: string[]) => {
    setUserZones(newZones);
    openEncountersService.setUserLocalidades(newZones);
  };

  const handleSeeAllClick = () => {
    if (onSeeAll) {
      onSeeAll();
    } else {
      handleOpenZoneModal();
    }
  };

  // Renderizado del bloque de Encuentros
  const renderEncountersGroup = () => {
    if (encountersError && !propEncounters) {
      return (
        <div className="pe-discovery-notice pe-discovery-notice--warning" role="alert">
          <span>No pudimos cargar los encuentros abiertos en este momento.</span>
          <button type="button" className="pe-discovery-notice-btn" onClick={() => refresh()}>
            Reintentar
          </button>
        </div>
      );
    }

    if (noZonesConfigured) {
      return (
        <div className="pe-discovery-empty">
          <p className="pe-discovery-empty-title">
            {t('open_encounters.no_zones_title', {
              defaultValue: 'Elegí tus zonas para ver encuentros cerca tuyo.',
            })}
          </p>
          <button
            type="button"
            className="pe-discovery-empty-btn pe-discovery-empty-btn--outline"
            onClick={handleOpenZoneModal}
          >
            {t('open_encounters.no_zones_cta', { defaultValue: 'Configurar zonas' })}
          </button>
        </div>
      );
    }

    if (visibleEncounters.length === 0) {
      return (
        <div className="pe-discovery-empty">
          <p className="pe-discovery-empty-title">
            {t('open_encounters.empty_title', {
              defaultValue: 'No hay encuentros abiertos ahora en tus zonas.',
            })}
          </p>
          <p className="pe-discovery-empty-desc">
            {t('open_encounters.empty_prompt', {
              defaultValue: '¿Ya tenés un plan y te falta gente?',
            })}
          </p>
          <div className="pe-discovery-empty-actions">
            <button
              type="button"
              className="pe-discovery-empty-btn pe-discovery-empty-btn--primary"
              onClick={onOpenCreate}
            >
              <Sparkles size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
              {t('open_encounters.empty_cta', { defaultValue: 'Abrir un encuentro' })}
            </button>
            <button
              type="button"
              className="pe-discovery-empty-btn pe-discovery-empty-btn--secondary pe-discovery-avisame-empty-btn"
              onClick={() => handleOpenAvisame('create')}
            >
              <Bell size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
              {t('avisame.empty_cta', { defaultValue: 'Avisame si aparece uno' })}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        className="pe-discovery-carousel-wrapper"
        onMouseEnter={() => {
          isInteractingRef.current = true;
          if (autoplayTimerRef.current) {
            window.clearTimeout(autoplayTimerRef.current);
            autoplayTimerRef.current = null;
          }
          if (resumeTimerRef.current) {
            window.clearTimeout(resumeTimerRef.current);
            resumeTimerRef.current = null;
          }
        }}
        onMouseLeave={() => {
          isInteractingRef.current = false;
          resetAutoplayTimer(10000);
        }}
        onFocus={() => {
          isInteractingRef.current = true;
          if (autoplayTimerRef.current) {
            window.clearTimeout(autoplayTimerRef.current);
            autoplayTimerRef.current = null;
          }
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            isInteractingRef.current = false;
            resetAutoplayTimer(10000);
          }
        }}
        onTouchStart={() => {
          isInteractingRef.current = true;
          if (autoplayTimerRef.current) {
            window.clearTimeout(autoplayTimerRef.current);
            autoplayTimerRef.current = null;
          }
        }}
        onTouchEnd={() => {
          isInteractingRef.current = false;
          resetAutoplayTimer(10000);
        }}
        onScroll={() => pauseAutoAdvance(10000)}
      >
        <div
          ref={trackRef}
          className="pe-discovery-track"
          role="region"
          aria-label="Carrusel de encuentros abiertos"
          tabIndex={0}
          onScroll={updateScrollState}
        >
          {visibleEncounters.map((encounter) => (
            <div key={encounter.id} className="pe-discovery-item">
              <HomeOpenEncounterCard encounter={encounter} onClick={handleCardClick} />
            </div>
          ))}
        </div>

        {/* Indicador / affordance mobile V2 hacia la derecha */}
        {isV2Variant && hasOverflow && canScrollRight && (
          <button
            type="button"
            className="pe-discovery-carousel-mobile-indicator"
            onClick={handleScrollNext}
            aria-label={t('open_encounters.carousel_next', { defaultValue: 'Encuentros siguientes' })}
            title={t('open_encounters.carousel_next', { defaultValue: 'Encuentros siguientes' })}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  // Renderizado del bloque de Intenciones
  const renderIntentionsGroup = () => {
    if (intentionsError && !propIntentions) {
      return (
        <div className="pe-discovery-notice pe-discovery-notice--warning" role="alert">
          <span>No pudimos cargar las ganas de hacer en este momento.</span>
          <button type="button" className="pe-discovery-notice-btn" onClick={() => refresh()}>
            Reintentar
          </button>
        </div>
      );
    }

    if (visibleIntentions.length === 0) {
      return (
        <div className="pe-discovery-empty pe-discovery-empty--subtle">
          <p className="pe-discovery-empty-title">
            {t('open_encounters.discovery_empty_title', {
              defaultValue: 'Todavía no hay nada por acá.',
            })}
          </p>
          <p className="pe-discovery-empty-desc">
            {t('open_encounters.discovery_empty_body', {
              defaultValue: '¿Y vos? ¿Qué tenés ganas de hacer?',
            })}
          </p>
          <button
            type="button"
            className="pe-discovery-empty-btn pe-discovery-empty-btn--secondary"
            onClick={handleFocusIntent}
          >
            <span>{t('open_encounters.discovery_empty_cta', { defaultValue: 'Tengo ganas de…' })}</span>
            <span aria-hidden="true">→</span>
          </button>
        </div>
      );
    }

    return (
      <div className="pe-discovery-intentions-grid">
        {visibleIntentions.map((intencion) => (
          <PublicIntencionCard
            key={intencion.id}
            intencion={intencion}
            onInterestClick={handleInterestClick}
            isLoading={actionLoadingId === intencion.id}
          />
        ))}
      </div>
    );
  };

  // Renderizado del bloque secundario de Discovery: Otras macrozonas
  const renderSecondarySection = (
    encList: OpenEncounterSummary[],
    intList: PublicIntencionSummary[]
  ) => {
    const hasItems = encList.length > 0 || intList.length > 0;
    if (!hasItems) return null;

    return (
      <div className="pe-discovery-secondary-block" data-testid="secondary-suggestions-block">
        <div className="pe-discovery-secondary-header">
          <h4 className="pe-discovery-secondary-title">
            {t('open_encounters.secondary_title', { defaultValue: 'También puede interesarte' })}
          </h4>
          <p className="pe-discovery-secondary-subtitle">
            {t('open_encounters.secondary_context', { defaultValue: 'En otras zonas de Mar del Plata' })}
          </p>
        </div>

        <div className="pe-discovery-secondary-cards">
          {encList.map((encounter) => (
            <div key={encounter.id} className="pe-discovery-secondary-item">
              <HomeOpenEncounterCard encounter={encounter} onClick={handleCardClick} />
            </div>
          ))}
          {intList.map((intencion) => (
            <div key={intencion.id} className="pe-discovery-secondary-item">
              <PublicIntencionCard
                intencion={intencion}
                onInterestClick={handleInterestClick}
                isLoading={actionLoadingId === intencion.id}
              />
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Error general: ambas fuentes fallaron
  const isGeneralError = Boolean(hookError && !propEncounters && !propIntentions);

  return (
    <section className={`pe-discovery-section${isV2Variant ? ' pe-discovery-section--v2' : ''}`} aria-label="Encuentros abiertos y planes para sumarte">
      {/* Cabecera de la Sección */}
      <div className="pe-discovery-header">
        <div className="pe-discovery-title-group">
          <h2 className="pe-discovery-title">
            {isV2Variant
              ? t('open_encounters.section_title_v2', { defaultValue: '¿A qué me sumo?' })
              : t('open_encounters.section_title', { defaultValue: 'Encuentros abiertos' })}
          </h2>
          <button
            type="button"
            className="pe-discovery-badge pe-discovery-badge--interactive"
            onClick={handleOpenZoneModal}
            title="Elegir zonas de interés"
          >
            <MapPin size={11} aria-hidden="true" />
            <span>
              {t('open_encounters.subtitle_zones', { defaultValue: 'En tus zonas' })}
              {effectiveZones.length > 0 ? ` (${effectiveZones.length})` : ''}
            </span>
          </button>
        </div>

        <div className="pe-discovery-header-actions">
          <button
            type="button"
            className="pe-discovery-avisame-btn"
            onClick={() => handleOpenAvisame('create')}
            aria-label={t('avisame.action_btn', { defaultValue: 'Avisame' })}
            title={t('avisame.action_tooltip', { defaultValue: 'Avisame cuando aparezca un encuentro' })}
          >
            <Bell size={13} aria-hidden="true" />
            <span>{t('avisame.action_btn', { defaultValue: 'Avisame' })}</span>
          </button>

          <button
            type="button"
            onClick={handleSeeAllClick}
            className="pe-discovery-see-all-btn"
            aria-label="Ver todos los encuentros abiertos"
          >
            <span>{t('open_encounters.see_all', { defaultValue: 'Ver todos' })}</span>
            <ChevronRight size={14} aria-hidden="true" />
          </button>

          {isV2Variant && hasOverflow && (
            <div className="pe-discovery-carousel-controls" aria-label="Navegación del carrusel">
              <button
                type="button"
                className="pe-discovery-carousel-arrow pe-discovery-carousel-arrow--prev"
                onClick={handleScrollPrev}
                disabled={!canScrollLeft}
                aria-label={t('open_encounters.carousel_prev', { defaultValue: 'Encuentros anteriores' })}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="pe-discovery-carousel-arrow pe-discovery-carousel-arrow--next"
                onClick={handleScrollNext}
                disabled={!canScrollRight}
                aria-label={t('open_encounters.carousel_next', { defaultValue: 'Encuentros siguientes' })}
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Selector Segmentado: [ Todo ] [ Encuentros ] [ Ganas de… ] (Solo V1) */}
      {!isV2Variant && (
        <div className="pe-discovery-tabs" role="tablist" aria-label="Filtro de tipo de contenido en Encuentros Abiertos">
          <button
            type="button"
            role="tab"
            aria-selected={discoveryTab === 'todo'}
            className={`pe-discovery-tab ${discoveryTab === 'todo' ? 'pe-discovery-tab--active' : ''}`}
            onClick={() => setDiscoveryTab('todo')}
          >
            {t('open_encounters.tab_all', { defaultValue: 'Todo' })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={discoveryTab === 'encuentros'}
            className={`pe-discovery-tab ${discoveryTab === 'encuentros' ? 'pe-discovery-tab--active' : ''}`}
            onClick={() => setDiscoveryTab('encuentros')}
          >
            {t('open_encounters.tab_encounters', { defaultValue: 'Encuentros' })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={discoveryTab === 'intenciones'}
            className={`pe-discovery-tab ${discoveryTab === 'intenciones' ? 'pe-discovery-tab--active' : ''}`}
            onClick={() => setDiscoveryTab('intenciones')}
          >
            {t('open_encounters.tab_intentions', { defaultValue: 'Ganas de…' })}
          </button>
        </div>
      )}

      {/* Contenido según Tab y Estado de Error General */}
      {isGeneralError ? (
        <div className="pe-discovery-empty pe-discovery-notice--error" role="alert">
          <AlertCircle size={20} aria-hidden="true" />
          <p className="pe-discovery-empty-title">No pudimos cargar los encuentros y planes para sumarse.</p>
          <button
            type="button"
            className="pe-discovery-empty-btn pe-discovery-empty-btn--outline"
            onClick={() => refresh()}
          >
            <RefreshCw size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
            Reintentar
          </button>
        </div>
      ) : isV2Variant ? (
        <div className="pe-discovery-group pe-discovery-group--v2">
          {renderEncountersGroup()}
          {effectiveZones.length > 0 &&
            visibleEncounters.length < OTHER_ZONES_SUGGESTION_THRESHOLD &&
            visibleSecondaryEncounters.length > 0 &&
            renderSecondarySection(visibleSecondaryEncounters, [])}
        </div>
      ) : (
        <>
          {/* Tab: Todo */}
          {discoveryTab === 'todo' && (() => {
            const primaryTotal = visibleEncounters.length + visibleIntentions.length;
            const secEnc = visibleSecondaryEncounters.slice(0, MAX_OTHER_ZONE_SUGGESTIONS);
            const remainingSlots = Math.max(0, MAX_OTHER_ZONE_SUGGESTIONS - secEnc.length);
            const secInt = visibleSecondaryIntentions.slice(0, remainingSlots);
            const hasSecondary = secEnc.length > 0 || secInt.length > 0;
            const showSecondary =
              effectiveZones.length > 0 &&
              primaryTotal < OTHER_ZONES_SUGGESTION_THRESHOLD &&
              hasSecondary;

            return (
              <div className="pe-discovery-groups">
                <div className="pe-discovery-group">
                  <div className="pe-discovery-subtitle-row">
                    <h3 className="pe-discovery-subtitle">
                      Encuentros próximos
                    </h3>
                  </div>
                  {renderEncountersGroup()}
                </div>

                <div className="pe-discovery-group" style={{ marginTop: '1.25rem' }}>
                  <h3 className="pe-discovery-subtitle">
                    {intentionsTitle || t('open_encounters.intentions_title', { defaultValue: 'Ganas de…' })}
                  </h3>
                  {renderIntentionsGroup()}
                </div>

                {showSecondary && renderSecondarySection(secEnc, secInt)}
              </div>
            );
          })()}

          {/* Tab: Encuentros */}
          {discoveryTab === 'encuentros' && (
            <div className="pe-discovery-group">
              {renderEncountersGroup()}
              {effectiveZones.length > 0 &&
                visibleEncounters.length < OTHER_ZONES_SUGGESTION_THRESHOLD &&
                visibleSecondaryEncounters.length > 0 &&
                renderSecondarySection(visibleSecondaryEncounters, [])}
            </div>
          )}

          {/* Tab: Ganas de… */}
          {discoveryTab === 'intenciones' && (
            <div className="pe-discovery-group">
              {renderIntentionsGroup()}
              {effectiveZones.length > 0 &&
                visibleIntentions.length < OTHER_ZONES_SUGGESTION_THRESHOLD &&
                visibleSecondaryIntentions.length > 0 &&
                renderSecondarySection([], visibleSecondaryIntentions)}
            </div>
          )}
        </>
      )}

      {/* Detail Sheet / Modal de Encuentro */}
      <HomeOpenEncounterDetailSheet
        isOpen={isDetailOpen}
        encounter={selectedEncounter}
        onClose={handleCloseDetail}
      />

      {/* Modal de selección de Zonas */}
      <ZoneSelectorModal
        isOpen={isZoneModalOpen}
        onClose={() => setIsZoneModalOpen(false)}
        selectedLocalityIds={effectiveZones}
        onSave={handleSaveZones}
      />

      {/* Sheet de Avisame (Fase 2B) */}
      <AvisameSheet
        isOpen={isAvisameOpen}
        onClose={() => setIsAvisameOpen(false)}
        initialTab={avisameTab}
        initialLocalityId={effectiveZones[0] || null}
        localidades={activeCatalogue}
        initialDraft={avisameDraft}
        isPermanentUser={isPermanentUser}
        onRequestLogin={(draft) => {
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem(PENDING_AVISAME_DRAFT_KEY, JSON.stringify(draft));
          }
          setIsAvisameOpen(false);
          setLoginSheetAction('create_alert');
          setIsLoginSheetOpen(true);
        }}
      />

      {/* LoginRequiredSheet para acción de Interés o Avisame */}
      <LoginRequiredSheet
        isOpen={isLoginSheetOpen}
        onClose={() => setIsLoginSheetOpen(false)}
        onContinueWithGoogle={handleLoginWithGoogle}
        loading={isOAuthStarting}
        action={loginSheetAction}
      />
    </section>
  );
};
