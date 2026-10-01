import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ChevronRight, MapPin, Sparkles, RefreshCw, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OpenEncounterSummary } from './types';
import type { PublicIntencionSummary } from '@/types/intenciones';
import { OPEN_ENCOUNTERS_DEMO } from './demoData';
import { HomeOpenEncounterCard } from './HomeOpenEncounterCard';
import { HomeOpenEncounterDetailSheet } from './HomeOpenEncounterDetailSheet';
import { ZoneSelectorModal } from './ZoneSelectorModal';
import { PublicIntencionCard } from '../discovery/PublicIntencionCard';
import { LoginRequiredSheet } from '@/components/auth/LoginRequiredSheet';
import { openEncountersService } from '@/services/openEncountersService';
import { useUnifiedDiscovery } from '@/hooks/useUnifiedDiscovery';
import { useAuth } from '@/contexts/AuthContext';
import './HomeOpenEncounters.css';

export const PENDING_INTENTION_INTEREST_KEY = 'puntoencuentro_pending_intention_interest';

export type DiscoveryTab = 'todo' | 'encuentros' | 'intenciones';

export interface HomeOpenEncountersProps {
  encounters?: OpenEncounterSummary[];
  intentions?: PublicIntencionSummary[];
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
}

export const HomeOpenEncounters: React.FC<HomeOpenEncountersProps> = ({
  encounters: propEncounters,
  intentions: propIntentions,
  selectedLocalityIds: propLocalityIds,
  noZonesConfigured = false,
  onOpenCreate,
  onConfigureZones,
  onSeeAll,
  isDemoMode,
  onFocusIntentInput,
}) => {
  const { t } = useTranslation();
  const { isPermanentUser, signInWithGoogleForDiscovery } = useAuth();

  const [discoveryTab, setDiscoveryTab] = useState<DiscoveryTab>('todo');

  const trackRef = useRef<HTMLDivElement>(null);
  const [selectedEncounter, setSelectedEncounter] = useState<OpenEncounterSummary | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isZoneModalOpen, setIsZoneModalOpen] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const resumeTimerRef = useRef<number | null>(null);

  // Auth Guard Sheet & Pending Action
  const [isLoginSheetOpen, setIsLoginSheetOpen] = useState(false);
  const [isOAuthStarting, setIsOAuthStarting] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const hasProcessedPendingInterestRef = useRef(false);

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

  // Hook central de Discovery Unificado
  const {
    encounters: hookEncounters,
    intentions: hookIntentions,
    loading: hookLoading,
    error: hookError,
    encountersError,
    intentionsError,
    refresh,
    setIntentionInterest,
  } = useUnifiedDiscovery({
    localityIds: userZones.length > 0 ? userZones : undefined,
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

  // Filtrado por zonas seleccionadas
  const visibleEncounters = useMemo(() => {
    if (!liveEncounters || liveEncounters.length === 0) return [];
    if (!userZones || userZones.length === 0) return liveEncounters;
    return liveEncounters.filter((e) => userZones.includes(e.localityId));
  }, [liveEncounters, userZones]);

  const visibleIntentions = useMemo(() => {
    if (!liveIntentions || liveIntentions.length === 0) return [];
    if (!userZones || userZones.length === 0) return liveIntentions;
    return liveIntentions.filter(
      (i) => i.modalidad === 'virtual' || (i.locality_id && userZones.includes(i.locality_id))
    );
  }, [liveIntentions, userZones]);

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

  // Pausa de auto-avance
  const pauseAutoAdvance = useCallback((temporaryMs = 12000) => {
    setIsInteracting(true);
    if (resumeTimerRef.current) {
      window.clearTimeout(resumeTimerRef.current);
    }
    resumeTimerRef.current = window.setTimeout(() => {
      setIsInteracting(false);
    }, temporaryMs);
  }, []);

  // Asegurar que el carrusel comience siempre alineado en scrollLeft 0
  useEffect(() => {
    if (trackRef.current) {
      trackRef.current.scrollLeft = 0;
    }
  }, [visibleEncounters.length]);

  // Auto-avance nativo
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    if (visibleEncounters.length <= 1) return;

    let intervalId: number | null = null;
    const initialDelayTimer = window.setTimeout(() => {
      intervalId = window.setInterval(() => {
        if (isInteracting) return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

        const track = trackRef.current;
        if (!track) return;

        const cards = Array.from(track.querySelectorAll('.pe-discovery-item')) as HTMLElement[];
        if (cards.length <= 1) return;

        const currentScroll = track.scrollLeft;
        let currentIndex = 0;
        let minDiff = Infinity;
        cards.forEach((card, idx) => {
          const diff = Math.abs(card.offsetLeft - currentScroll);
          if (diff < minDiff) {
            minDiff = diff;
            currentIndex = idx;
          }
        });

        const maxScrollLeft = track.scrollWidth - track.clientWidth;
        const nextIndex = currentIndex + 1;

        if (nextIndex >= cards.length || cards[nextIndex].offsetLeft > maxScrollLeft + 2) {
          track.scrollTo({ left: 0, behavior: 'smooth' });
        } else {
          track.scrollTo({ left: cards[nextIndex].offsetLeft, behavior: 'smooth' });
        }
      }, 7000);
    }, 10000);

    return () => {
      window.clearTimeout(initialDelayTimer);
      if (intervalId) window.clearInterval(intervalId);
      if (resumeTimerRef.current) {
        window.clearTimeout(resumeTimerRef.current);
      }
    };
  }, [visibleEncounters.length, isInteracting]);

  const handleCardClick = (encounter: OpenEncounterSummary) => {
    pauseAutoAdvance(30000);
    setSelectedEncounter(encounter);
    setIsDetailOpen(true);
  };

  const handleCloseDetail = () => {
    setIsDetailOpen(false);
    setSelectedEncounter(null);
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
          <button
            type="button"
            className="pe-discovery-empty-btn pe-discovery-empty-btn--primary"
            onClick={onOpenCreate}
          >
            <Sparkles size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
            {t('open_encounters.empty_cta', { defaultValue: 'Abrir un encuentro' })}
          </button>
        </div>
      );
    }

    return (
      <div
        className="pe-discovery-carousel-wrapper"
        onMouseEnter={() => setIsInteracting(true)}
        onMouseLeave={() => pauseAutoAdvance(3000)}
        onFocus={() => setIsInteracting(true)}
        onBlur={() => pauseAutoAdvance(3000)}
        onTouchStart={() => pauseAutoAdvance(15000)}
        onScroll={() => pauseAutoAdvance(12000)}
      >
        <div
          ref={trackRef}
          className="pe-discovery-track"
          role="region"
          aria-label="Carrusel de encuentros abiertos"
          tabIndex={0}
        >
          {visibleEncounters.map((encounter) => (
            <div key={encounter.id} className="pe-discovery-item">
              <HomeOpenEncounterCard encounter={encounter} onClick={handleCardClick} />
            </div>
          ))}
        </div>
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

  // Error general: ambas fuentes fallaron
  const isGeneralError = Boolean(hookError && !propEncounters && !propIntentions);

  return (
    <section className="pe-discovery-section" aria-label="Encuentros abiertos y planes para sumarte">
      {/* Cabecera de la Sección */}
      <div className="pe-discovery-header">
        <div className="pe-discovery-title-group">
          <h2 className="pe-discovery-title">
            {t('open_encounters.section_title', { defaultValue: 'Encuentros abiertos' })}
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
              {userZones.length > 0 ? ` (${userZones.length})` : ''}
            </span>
          </button>
        </div>

        <button
          type="button"
          onClick={handleSeeAllClick}
          className="pe-discovery-see-all-btn"
          aria-label="Ver todos los encuentros abiertos"
        >
          <span>{t('open_encounters.see_all', { defaultValue: 'Ver todos' })}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>

      {/* Selector Segmentado: [ Todo ] [ Encuentros ] [ Ganas de… ] */}
      <div className="pe-discovery-tabs" role="tablist" aria-label="Filtro de tipo de contenido en Discovery">
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

      {/* Contenido según Tab y Estado de Error General */}
      {isGeneralError ? (
        <div className="pe-discovery-empty pe-discovery-notice--error" role="alert">
          <AlertCircle size={20} aria-hidden="true" />
          <p className="pe-discovery-empty-title">No pudimos cargar el contenido de Discovery.</p>
          <button
            type="button"
            className="pe-discovery-empty-btn pe-discovery-empty-btn--outline"
            onClick={() => refresh()}
          >
            <RefreshCw size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'text-bottom' }} />
            Reintentar
          </button>
        </div>
      ) : (
        <>
          {/* Tab: Todo */}
          {discoveryTab === 'todo' && (
            <div className="pe-discovery-groups">
              <div className="pe-discovery-group">
                <h3 className="pe-discovery-subtitle">Encuentros próximos</h3>
                {renderEncountersGroup()}
              </div>

              <div className="pe-discovery-group" style={{ marginTop: '1.25rem' }}>
                <h3 className="pe-discovery-subtitle">
                  {t('open_encounters.intentions_title', { defaultValue: 'Ganas de…' })}
                </h3>
                {renderIntentionsGroup()}
              </div>
            </div>
          )}

          {/* Tab: Encuentros */}
          {discoveryTab === 'encuentros' && (
            <div className="pe-discovery-group">
              {renderEncountersGroup()}
            </div>
          )}

          {/* Tab: Ganas de… */}
          {discoveryTab === 'intenciones' && (
            <div className="pe-discovery-group">
              {renderIntentionsGroup()}
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
        selectedLocalityIds={userZones}
        onSave={handleSaveZones}
      />

      {/* LoginRequiredSheet para acción de Interés */}
      <LoginRequiredSheet
        isOpen={isLoginSheetOpen}
        onClose={() => setIsLoginSheetOpen(false)}
        onContinueWithGoogle={handleLoginWithGoogle}
        loading={isOAuthStarting}
        action="interest_intention"
      />
    </section>
  );
};
