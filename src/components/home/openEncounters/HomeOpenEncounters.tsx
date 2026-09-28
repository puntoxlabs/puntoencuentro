import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ChevronRight, MapPin, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OpenEncounterSummary } from './types';
import { OPEN_ENCOUNTERS_DEMO } from './demoData';
import { HomeOpenEncounterCard } from './HomeOpenEncounterCard';
import { HomeOpenEncounterDetailSheet } from './HomeOpenEncounterDetailSheet';
import { ZoneSelectorModal } from './ZoneSelectorModal';
import { openEncountersService } from '@/services/openEncountersService';
import './HomeOpenEncounters.css';

export interface HomeOpenEncountersProps {
  encounters?: OpenEncounterSummary[];
  selectedLocalityIds?: string[];
  noZonesConfigured?: boolean;
  onOpenCreate?: () => void;
  onConfigureZones?: () => void;
  onSeeAll?: () => void;
  /**
   * Forzar modo demo o modo real explícitamente.
   * Si no se define, se permite fallback a demo sólo en rutas /preview.
   * En rutas normales (Home, Staging real, Prod) se muestran datos reales y empty states reales.
   */
  isDemoMode?: boolean;
}

export const HomeOpenEncounters: React.FC<HomeOpenEncountersProps> = ({
  encounters: propEncounters,
  selectedLocalityIds: propLocalityIds,
  noZonesConfigured = false,
  onOpenCreate,
  onConfigureZones,
  onSeeAll,
  isDemoMode,
}) => {
  const { t } = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  const [selectedEncounter, setSelectedEncounter] = useState<OpenEncounterSummary | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isZoneModalOpen, setIsZoneModalOpen] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const resumeTimerRef = useRef<number | null>(null);

  // Determinar si se permite fallback demo de diseño
  const allowDemoFallback = useMemo(() => {
    if (typeof isDemoMode === 'boolean') return isDemoMode;
    if (typeof window !== 'undefined') {
      return window.location.pathname.startsWith('/preview');
    }
    return false;
  }, [isDemoMode]);

  // Zonas del usuario (prop o cargadas de service)
  const [userZones, setUserZones] = useState<string[]>(propLocalityIds || []);
  const [liveEncounters, setLiveEncounters] = useState<OpenEncounterSummary[]>(propEncounters || []);

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

  // Si propEncounters viene provisto, usarlo; sino buscar de Supabase
  useEffect(() => {
    if (propEncounters) {
      setLiveEncounters(propEncounters);
      return;
    }

    let mounted = true;
    openEncountersService
      .getDiscoveryEncuentros(userZones.length > 0 ? userZones : undefined)
      .then((data) => {
        if (!mounted) return;
        if (data && data.length > 0) {
          setLiveEncounters(data);
        } else if (allowDemoFallback) {
          // Fallback a demo data sólo en preview de diseño
          setLiveEncounters(OPEN_ENCOUNTERS_DEMO);
        } else {
          // En modo real sin encuentros: array vacío real -> muestra empty state real
          setLiveEncounters([]);
        }
      })
      .catch((err) => {
        if (!mounted) return;
        console.error('[HomeOpenEncounters] Error cargando discovery:', err);
        if (allowDemoFallback) {
          setLiveEncounters(OPEN_ENCOUNTERS_DEMO);
        } else {
          setLiveEncounters([]);
        }
      });

    return () => {
      mounted = false;
    };
  }, [propEncounters, userZones, allowDemoFallback]);

  // Filtrado por zonas seleccionadas
  const visibleEncounters = useMemo(() => {
    if (!liveEncounters || liveEncounters.length === 0) return [];
    if (!userZones || userZones.length === 0) return liveEncounters;
    return liveEncounters.filter((e) => userZones.includes(e.localityId));
  }, [liveEncounters, userZones]);

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

        // Encontrar la card que está actualmente al inicio útil del track
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

        // Si el siguiente índice excede las tarjetas o su offsetLeft supera el límite de scroll
        // (lo que provocaría cortar la tarjeta anterior en desktop), volver de forma fluida a Card 0 flush.
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

  return (
    <section className="pe-discovery-section" aria-label="Encuentros abiertos para sumarte">
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

      {/* Caso A: Estado sin zonas configuradas */}
      {noZonesConfigured ? (
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
      ) : visibleEncounters.length === 0 ? (
        /* Caso B: Estado vacío (sin encuentros disponibles en la zona) */
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
      ) : (
        /* Caso C: Carrusel horizontal con scroll-snap nativo */
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
      )}

      {/* Detail Sheet / Modal */}
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
    </section>
  );
};
