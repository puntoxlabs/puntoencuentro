import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Calendar, Sliders, Plus, User, MoreVertical } from 'lucide-react';
import { FilterSheet } from '@/components/ui/FilterSheet';
import { AccountSheet } from '@/components/ui/AccountSheet';
import { InfoSheet } from '@/components/ui/InfoSheet';
import { StatusChip } from '@/components/ui/StatusChip';
import './Home.css';
import { encuentrosService } from '@/services/encuentrosService';

import { rememberEncuentroHostBulk } from '@/lib/meetHostsStorage';
import { useAuth } from '@/contexts/AuthContext';
import { useCreateEncounter } from '@/hooks/useCreateEncounter';
import { formatFriendlyDate, formatFriendlyDeadline } from '@/lib/formatDate';
import { getEncounterListBucket } from '@/lib/encounterListBucket';
import {
  isCoordinationEncounter,
  encounterComparator
} from '@/lib/encuentroHelper';
import type { EncuentroBase } from '@/lib/encuentroHelper';
import { useHomeStore } from '@/store/homeStore';
import { useWizardStore } from '@/store/wizardStore';
import { useAiWizardStore } from '@/store/aiWizardStore';
import { useDetailStore } from '@/store/detailStore';
import { themes } from '@/lib/themes';
import type { ThemeId } from '@/lib/themes';
import { throttle } from 'lodash';
import { CreationAccountChoiceSheet } from '@/components/ui/CreationAccountChoiceSheet';
import { DATE_COORDINATION_ENABLED } from '@/config/features';
import { EncounterModeChoiceSheet } from '@/components/ui/EncounterModeChoiceSheet';
import { useStartCoordinationEncounter } from '@/hooks/useStartCoordinationEncounter';
import { AnonymousCoordinationWarningSheet } from '@/components/ui/AnonymousCoordinationWarningSheet';
import { useHiddenDiscovery } from '@/hooks/useHiddenDiscovery';
import { hasMeaningfulDraftData } from '@/lib/encounterDraft';
import { ensureHostSession } from '@/lib/ensureHostSession';
import {
  HomeHero,
  HomeIntentInput,
  HomeSuggestionChips,
  HomeDraftResumeCard,
  HomeValueProposition,
  DraftOverwriteConfirmSheet,
  HomeFlankingVisuals,
  HomePillarsSection,
  HomeDynamicCanvas,
  HomeVariantSwitcher,
} from '@/components/home';
import type { HomeVisualVariant } from '@/components/home';
import { V2_SUGGESTIONS } from '@/components/home/HomeSuggestionChips';


/** Obtiene el color primario del tema del encuentro */
function getEncuentroPrimaryColor(enc: any): string {
  if (!enc) return themes.blue.primary;
  const themeId = enc.tema as ThemeId;
  return (themeId && themes[themeId]) ? themes[themeId].primary : themes.blue.primary;
}

/** Preloa el wizard con los datos de un encuentro existente */
function preloadWizardFromEncuentro(enc: any, wizardStore: ReturnType<typeof useWizardStore.getState>) {
  wizardStore.reset();
  const { setField } = wizardStore;
  setField('titulo', enc.titulo || '');
  setField('fecha', '');          // fecha en blanco — el usuario elige la nueva
  setField('hora', enc.hora || '');
  setField('descripcion', enc.descripcion || '');
  setField('modalidad', enc.modalidad || null);
  setField('lugar_texto', enc.lugar_texto || '');
  setField('link_virtual', enc.link_virtual || '');
  setField('tipo_invitacion', enc.tipo_invitacion || null);
  setField('tema', enc.tema || 'blue');
}

/* ─── Componente de card activa ───────────────────────────────────── */
const ActiveCard: React.FC<{
  enc: any;
  onClick: () => void;
  participantesCache: any[] | null;
  miEstado?: string | null;
  counts?: { total: number; confirmados: number } | null;
  isHost?: boolean;
}> = ({ enc, onClick, participantesCache, miEstado, counts, isHost = true }) => {
  if (!enc) return null;
  const accentColor = getEncuentroPrimaryColor(enc);
  const confirmados = counts ? counts.confirmados : (participantesCache || []).filter((p: any) => p && p.estado === 'confirmado').length;
  const total = counts ? counts.total : (participantesCache || []).length;

  const isExpired = isCoordinationEncounter(enc) && enc.coordination_status === 'open' && enc.response_deadline && new Date(enc.response_deadline) < new Date();

  // Label para estado propio del invitado (vista Participo)
  const miEstadoLabel = miEstado === 'confirmado' ? '✔ Vas a asistir' : miEstado === 'rechazado' ? '✖ No vas a asistir' : miEstado ? 'Respuesta registrada' : null;

  const getBadgeLabel = () => {
    if (!isCoordinationEncounter(enc)) return "Activo";
    if (enc.coordination_status === 'closed') return "Fecha confirmada";
    if (isExpired) return "Plazo vencido";
    return "Coordinación abierta";
  };

  const getBadgeStatus = () => {
    if (isExpired) return "pending";
    return "active";
  };

  return (
    <div
      onClick={onClick}
      className="home-card"
      style={{ borderLeft: `5px solid ${accentColor}` }}
    >
      <div className="home-card-header">
        <h3 className="home-card-title">
          {enc.titulo}
        </h3>
        <Badge label={getBadgeLabel()} status={getBadgeStatus()} />
      </div>

      <p className="home-card-date">
        📅 {isCoordinationEncounter(enc) 
             ? (enc.coordination_status === 'closed' 
                 ? formatFriendlyDate(enc.fecha, enc.hora) 
                 : 'Opciones de fecha propuestas') 
             : formatFriendlyDate(enc.fecha, enc.hora)}
      </p>
      {isCoordinationEncounter(enc) && enc.response_deadline && enc.coordination_status === 'open' && (
        <p className="home-card-date" style={{ color: isExpired ? 'var(--pe-error)' : 'var(--pe-error)', fontSize: 13, marginTop: 4 }}>
          {isExpired 
            ? (isHost ? '⏳ Plazo vencido (Elegí una fecha)' : '⏳ Plazo vencido (Esperando confirmación)')
            : `⏳ Responder antes del ${formatFriendlyDeadline(enc.response_deadline)}`}
        </p>
      )}

      <div className="home-card-footer">
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <StatusChip
            icon={enc.modalidad === 'presencial' ? '🤝' : '💻'}
            label={enc.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}
          />
          {enc.tipo_invitacion && (
            <StatusChip
              icon={enc.tipo_invitacion === 'individual' ? '👤' : '👥'}
              label={enc.tipo_invitacion === 'individual' ? 'Individual' : 'Grupal'}
            />
          )}
        </div>

        {/* Vista Participo: mostrar estado propio. Vista Organizo: mostrar conteo */}
        {miEstadoLabel ? (
          <span className={miEstado === 'confirmado' ? 'home-card-status--success' : miEstado === 'rechazado' ? 'home-card-status--danger' : 'home-card-status'}>
            {miEstadoLabel}
          </span>
        ) : (
          total !== null && (
            <span className="home-card-status">
              {confirmados !== null && confirmados > 0
                ? `${confirmados} confirmado${confirmados !== 1 ? 's' : ''}`
                : `${total} invitado${total !== 1 ? 's' : ''}`}
            </span>
          )
        )}
      </div>
    </div>
  );
};

/* ─── Componente de card pasada ───────────────────────────────────── */
const PastCard: React.FC<{
  enc: any;
  onClick: () => void;
  onRepeat: (e: React.MouseEvent) => void;
  participantesCache: any[] | null;
  miEstado?: string | null;
  counts?: { total: number; confirmados: number } | null;
}> = ({ enc, onClick, onRepeat, participantesCache, miEstado, counts }) => {
  if (!enc) return null;
  const isCancelled = enc.estado === 'cancelado';
  const accentColor = getEncuentroPrimaryColor(enc);
  const confirmados = counts ? counts.confirmados : (participantesCache || []).filter((p: any) => p && p.estado === 'confirmado').length;
  const total = counts ? counts.total : (participantesCache || []).length;

  // Label para estado propio del invitado (vista Participo)
  const miEstadoLabel = miEstado === 'confirmado' ? '✔ Asististe' : miEstado === 'rechazado' ? '✖ No asististe' : miEstado ? 'Respuesta registrada' : null;

  return (
    <div
      onClick={onClick}
      className="home-card--past"
      style={{ borderLeft: `4px solid ${accentColor}66` }}
    >
      <div className="home-card-header">
        <h3 className="home-card-title--past">
          {enc.titulo}
        </h3>
        {isCancelled ? (
          <Badge label="Cancelado" status="rejected" />
        ) : isCoordinationEncounter(enc) && enc.coordination_status === 'open' ? (
          <Badge label="Sin fecha confirmada" status="pending" />
        ) : (
          <Badge label="Finalizado" status="finished" />
        )}
      </div>

      <p className="home-card-date--past">
        📅 {isCoordinationEncounter(enc) 
             ? (enc.coordination_status === 'closed' 
                 ? formatFriendlyDate(enc.fecha, enc.hora) 
                 : 'Opciones de fecha propuestas') 
             : formatFriendlyDate(enc.fecha, enc.hora)}
      </p>

      <div className="home-card-footer">
        <div className="home-card-footer-left" style={{ flexWrap: 'wrap' }}>
          <StatusChip
            icon={enc.modalidad === 'presencial' ? '🤝' : '💻'}
            label={enc.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}
          />
          {enc.tipo_invitacion && (
            <StatusChip
              icon={enc.tipo_invitacion === 'individual' ? '👤' : '👥'}
              label={enc.tipo_invitacion === 'individual' ? 'Individual' : 'Grupal'}
            />
          )}
          {/* Vista Participo: mostrar estado propio. Vista Organizo: mostrar conteo */}
          {miEstadoLabel ? (
            <span className={miEstado === 'confirmado' ? 'home-card-status--success' : miEstado === 'rechazado' ? 'home-card-status--danger' : 'home-card-status'}>
              {miEstadoLabel}
            </span>
          ) : (
            total !== null && (
              <span className="home-card-status">
                {confirmados !== null && confirmados > 0
                  ? `${confirmados} confirmado${confirmados !== 1 ? 's' : ''}`
                  : `${total} invitado${total !== 1 ? 's' : ''}`}
              </span>
            )
          )}
        </div>

        {/* Botón Repetir */}
        <button
          onClick={onRepeat}
          className="home-card-repeat-btn"
          style={{ background: `${accentColor}10`, color: accentColor }}
          onMouseEnter={e => {
            e.stopPropagation();
            (e.currentTarget as HTMLButtonElement).style.background = `${accentColor}20`;
          }}
          onMouseLeave={e => {
            e.stopPropagation();
            (e.currentTarget as HTMLButtonElement).style.background = `${accentColor}10`;
          }}
        >
          🔁 Repetir
        </button>
      </div>
    </div>
  );
};

/* ─── Pantalla principal ─────────────────────────────────────────────────── */
export interface HomeProps {
  forcedVariant?: HomeVisualVariant;
}

const Home: React.FC<HomeProps> = ({ forcedVariant }) => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { getValidCache, scrollPosition, setEncuentros, setScrollPosition, filterStatus, filterType, filterCoordinationState, sortBy, setFilterType, setFilterCoordinationState } = useHomeStore();
  const wizardStore = useWizardStore();
  const { reset: resetWizard } = wizardStore;
  const detailCache = useDetailStore(s => s.cache);
  const validCache = getValidCache();
  const storeState = useHomeStore.getState();
  const staleOrganized = storeState.encuentros;
  const staleParticipated = storeState.participatedEncuentros;
  const { handleTap } = useHiddenDiscovery();

  // Si no hay caché válido ni datos viejos para mostrar, iniciamos en loading
  const [loading, setLoading] = useState(
    !validCache && staleOrganized.length === 0 && staleParticipated.length === 0
  );
  const [error, setError] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'upcoming' | 'past'>('upcoming');
  const [activeScope, setActiveScope] = useState<'organizo' | 'participo'>('organizo');
  const [imgError, setImgError] = useState(false);

  // Estados locales para las dos listas
  const [organizedEncuentros, setOrganizedEncuentros] = useState<any[]>(validCache?.organized || staleOrganized || []);
  const [participatedEncuentros, setParticipatedEncuentros] = useState<any[]>(validCache?.participated || staleParticipated || []);
  const [counts, setCounts] = useState<Record<string, { total: number; confirmados: number }>>({});

  // Los encuentros "visibles" dependen del scope activo
  const encuentros = activeScope === 'organizo' ? organizedEncuentros : participatedEncuentros;



  const { startFixedEncounter, choiceSheetProps } = useCreateEncounter();
  const { startCoordinationEncounter, coordinationWarningProps } = useStartCoordinationEncounter();

  const [isModeChoiceOpen, setIsModeChoiceOpen] = useState(false);
  const [homeIntent, setHomeIntent] = useState('');
  const [isSubmittingIntent, setIsSubmittingIntent] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [isSpeechListening, setIsSpeechListening] = useState(false);
  const [isOverwriteSheetOpen, setIsOverwriteSheetOpen] = useState(false);

  // Variante de diseño visual de la Home ('envolvente' | 'visor' | 'refinado' | 'stitch')
  const [visualVariant, setVisualVariant] = useState<HomeVisualVariant>(() => {
    if (forcedVariant) return forcedVariant;
    if (typeof window !== 'undefined') {
      try {
        const params = new URLSearchParams(window.location.search);
        const paramVariant = params.get('variant') || params.get('v');
        if (paramVariant === 'd' || paramVariant === 'stitch') return 'stitch';
        if (paramVariant === 'c' || paramVariant === 'refinado') return 'refinado';
        if (paramVariant === 'b' || paramVariant === 'visor') return 'visor';
        if (paramVariant === 'a' || paramVariant === 'envolvente') return 'envolvente';
        const saved = localStorage.getItem('puntoencuentro_home_variant');
        if (saved === 'stitch' || saved === 'refinado' || saved === 'visor' || saved === 'envolvente') return saved as HomeVisualVariant;
      } catch (e) {
        // Fallback seguro
      }
    }
    return 'refinado';
  });

  const effectiveVariant: HomeVisualVariant = forcedVariant || visualVariant;

  const handleVariantChange = (newVariant: HomeVisualVariant) => {
    if (forcedVariant) return; // Si la variante está forzada externamente, no alterar preferencia
    setVisualVariant(newVariant);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('puntoencuentro_home_variant', newVariant);
        const url = new URL(window.location.href);
        const vParam = newVariant === 'stitch' ? 'd' : newVariant === 'refinado' ? 'c' : newVariant === 'visor' ? 'b' : 'a';
        url.searchParams.set('variant', vParam);
        window.history.replaceState({}, '', url.toString());
      } catch (e) {
        // Ignorar fallos de storage
      }
    }
  };


  const aiDraft = useAiWizardStore(s => s.draft);
  const aiConfig = useAiWizardStore(s => s.config);
  const hasActiveDraft = hasMeaningfulDraftData(aiDraft, aiConfig);


  const startNewEncounterWithIntent = async (text: string) => {
    if (isSubmittingIntent) return;
    setIsSubmittingIntent(true);
    try {
      await ensureHostSession();
      useAiWizardStore.getState().startNewWithPrompt(text);
      navigate('/create/ai');
    } catch (err) {
      console.error('[Home] Error al inicializar sesión:', err);
      setIsSubmittingIntent(false);
    }
  };

  const handleIntentSubmit = () => {
    const text = homeIntent.trim();
    if (!text || isSubmittingIntent) return;

    if (hasActiveDraft) {
      setIsOverwriteSheetOpen(true);
      return;
    }

    startNewEncounterWithIntent(text);
  };

  const handleResumeOldDraft = () => {
    setIsOverwriteSheetOpen(false);
    navigate('/create/ai');
  };

  const handleConfirmNewDraft = () => {
    setIsOverwriteSheetOpen(false);
    startNewEncounterWithIntent(homeIntent.trim());
  };

  const handleDiscardOldDraft = () => {
    useAiWizardStore.getState().reset();
  };

  const handleSelectSuggestion = (prompt: string) => {
    setHomeIntent(prompt);
  };

  const handleCreateClick = () => {
    sessionStorage.removeItem('cancel_reference');
    resetWizard();
    if (DATE_COORDINATION_ENABLED) {
      setIsModeChoiceOpen(true);
    } else {
      startFixedEncounter();
    }
  };

  const isAnonymousUser = user?.is_anonymous === true;

  // Avatar helper
  const userAvatarUrl = user?.user_metadata?.avatar_url as string | undefined;
  const userInitials = (() => {
    const name = (user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || '') as string;
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase() || '?';
  })();

  const totalProximos = (encuentros || []).filter(enc => enc && typeof enc === 'object' && getEncounterListBucket(enc) === 'current').length;
  const totalPasados = (encuentros || []).filter(enc => enc && typeof enc === 'object' && (getEncounterListBucket(enc) === 'past' || getEncounterListBucket(enc) === 'cancelled')).length;

  useEffect(() => {
    loadData();
    if (scrollPosition > 0) {
      requestAnimationFrame(() => {
        const container = document.getElementById('home-scroll-container');
        if (container) container.scrollTop = scrollPosition;
      });
    }

    // Limpiar cualquier contexto de reemplazo abandonado o completado al volver a la Home
    sessionStorage.removeItem('cancel_reference');

    // Refresco silencioso al recuperar foco
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadData();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const handleScroll = throttle((e: React.UIEvent<HTMLDivElement>) => {
    setScrollPosition(e.currentTarget.scrollTop);
  }, 200);

  const loadingRef = useRef(false);

  const loadData = useCallback(async () => {
    console.log('[Home] loadData invoked');
    if (authLoading) return;
    if (loadingRef.current) return;

    loadingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      if (!user) {
        setOrganizedEncuentros([]);
        setParticipatedEncuentros([]);
        setCounts({});
        setEncuentros([], []);
        return;
      }

      console.log('[Home] before getEncuentros');

      let organized: any[] = [];
      let participated: any[] = [];

      // El backend autoriza y filtra usando exclusivamente auth.uid().
      // Enviamos el UUID de la sesión solo por compatibilidad de la firma de la RPC.
      organized = await encuentrosService.getEncuentrosByHostIds([user.id]);

      if (!user.is_anonymous) {
        participated = await encuentrosService.getEncuentrosParticipados(user.id);
      }

      try {
        const { getAllParticipatedTokens } = await import('@/lib/participatedTokens');
        const tokens = getAllParticipatedTokens();
        if (tokens.length > 0) {
          const anonParticipated = await encuentrosService.getEncuentrosParticipadosPorTokens(tokens);
          const existingIds = new Set(participated.map(p => p.id));
          const missing = anonParticipated.filter(p => !existingIds.has(p.id));
          participated = [...participated, ...missing];
        }
      } catch (err) {
        if (import.meta.env.DEV) console.error('[HOME] Error cargando participo anónimo:', err);
      }

      const sortList = (list: EncuentroBase[]) => {
        return (list || []).filter(e => e && e.id).sort(encounterComparator);
      };

      const sortedOrganized = sortList(organized);
      const sortedParticipated = sortList(participated);

      const allIds = [...sortedOrganized, ...sortedParticipated].map(e => e.id).filter(Boolean);
      const newCounts = await encuentrosService.getCountsPorEncuentros(allIds);

      console.log('[Home] after getEncuentros');

      setCounts(newCounts);
      setOrganizedEncuentros(sortedOrganized);
      setParticipatedEncuentros(sortedParticipated);
      rememberEncuentroHostBulk(sortedOrganized);
      setEncuentros(sortedOrganized, sortedParticipated);

    } catch (error) {
      console.error('[Home] loadData failed', error);
      setError('Hubo un error al cargar tus encuentros.');
    } finally {
      console.log('[Home] finally');
      loadingRef.current = false;
      setLoading(false);
    }
  }, [user, authLoading]);

  // Recargar cuando el usuario inicia o cierra sesión
  useEffect(() => {
    if (authLoading) return;
    void loadData();
  }, [authLoading, user?.id, user?.is_anonymous, loadData]);

  const handleRepeat = (enc: any, e: React.MouseEvent) => {
    e.stopPropagation();
    preloadWizardFromEncuentro(enc, useWizardStore.getState());
    startFixedEncounter();
  };

  const renderContent = () => {
    if (loading) return (
      <div className="home-loading">
        <p className="home-loading-text">Cargando encuentros…</p>
      </div>
    );

    if (error) return (
      <div className="home-error">
        <p className="home-error-text">{error}</p>
        <Button variant="outline" onClick={loadData}>Reintentar</Button>
      </div>
    );

    const getClasificacion = (enc: any) => {
      const bucket = getEncounterListBucket(enc);
      if (bucket === 'cancelled') return 'cancelled';
      if (bucket === 'past') return 'finished';
      return 'active';
    };

    const filtered = (encuentros || []).filter(enc => {
      if (!enc) return false;
      
      // 1. Filter by Status (from FilterSheet)
      const cls = getClasificacion(enc);
      if (filterStatus !== 'all' && cls !== filterStatus) return false;

      // 2. Filter by Type
      const isCoord = isCoordinationEncounter(enc);
      if (filterType === 'fixed' && isCoord) return false;
      if (filterType === 'coordination' && !isCoord) return false;

      // 3. Filter by Coordination State
      if (filterType === 'coordination' && isCoord && filterCoordinationState !== 'all') {
        const isExpired = enc.coordination_status === 'open' && enc.response_deadline && new Date(enc.response_deadline) < new Date();
        if (filterCoordinationState === 'open' && (enc.coordination_status !== 'open' || isExpired)) return false;
        if (filterCoordinationState === 'expired' && !isExpired) return false;
        if (filterCoordinationState === 'closed' && enc.coordination_status !== 'closed') return false;
      }

      return true;
    });

    const getStableSortValue = (enc: any) => {
      const d = new Date(`${enc.fecha || ''}T${enc.hora || ''}`).getTime();
      if (!isNaN(d)) return d;
      if (enc.response_deadline) return new Date(enc.response_deadline).getTime();
      if (enc.creado_en) return new Date(enc.creado_en).getTime();
      return 0;
    };

    const sorted = [...filtered].sort((a, b) => {
      if (sortBy === 'date_upcoming') {
        const sortA = getStableSortValue(a);
        const sortB = getStableSortValue(b);
        return sortA - sortB;
      }
      if (sortBy === 'date_distant') {
        const sortA = getStableSortValue(a);
        const sortB = getStableSortValue(b);
        return sortB - sortA;
      }
      if (sortBy === 'name_asc') {
        return (a.titulo || '').localeCompare(b.titulo || '');
      }
      if (sortBy === 'name_desc') {
        return (b.titulo || '').localeCompare(a.titulo || '');
      }
      return 0;
    });

    const proximos = filterStatus === 'all'
      ? sorted.filter(enc => getClasificacion(enc) === 'active')
      : (filterStatus === 'active' ? sorted : []);

    const pasados = filterStatus === 'all'
      ? sorted.filter(enc => getClasificacion(enc) !== 'active')
      : (filterStatus === 'finished' || filterStatus === 'cancelled' ? sorted : []);

    if (sortBy === 'date_upcoming') {
      pasados.sort((a, b) => {
        const sortA = getStableSortValue(a);
        const sortB = getStableSortValue(b);
        return sortB - sortA;
      });
    }

    // Estado vacío total
    if (!encuentros || encuentros.length === 0) {
      const isOrganizo = activeScope === 'organizo';
      return (
        <div className="home-empty">
          <div className="home-empty-icon">
            <Calendar size={40} color="var(--color-primary)" />
          </div>
          <h2 className="home-empty-title">
            {isOrganizo
              ? 'Todavía no organizaste encuentros'
              : 'Todavía no tenés invitaciones confirmadas'}
          </h2>
          <p className="home-empty-desc">
            {isOrganizo
              ? 'Creá uno nuevo para coordinar con otros.'
              : 'Cuando confirmes asistencia, aparecerán acá.'}
          </p>
          {isOrganizo && (
            <Button
              variant="primary"
              fullWidth
              style={{ height: 56, fontSize: 16, fontWeight: 700 }}
              onClick={handleCreateClick}
            >
              + Crear encuentro
            </Button>
          )}
        </div>
      );
    }

    const slideClass = activeTab === 'upcoming' ? 'slide-from-left' : 'slide-from-right';

    return (
      <div
        key={activeTab}
        id="home-scroll-container"
        onScroll={handleScroll}
        className={`${slideClass} home-scroll-container`}
      >

        {/* Banner A: Usuario NO logueado + encuentros locales (Nudge Login) */}
        {isAnonymousUser && (
          <div className="home-banner" style={{ backgroundColor: '#fff8e1', border: '1px solid #ffca28' }}>
            <p className="home-banner-title" style={{ color: '#f57f17' }}>
              Protegé tu historial
            </p>
            <p className="home-banner-desc" style={{ color: '#663c00' }}>
              Tus encuentros están guardados solamente en este navegador. Si borrás sus datos, cambiás de dispositivo o perdés esta sesión, podrías perder el acceso.
            </p>
            <p className="home-banner-desc" style={{ color: '#663c00', marginTop: 4 }}>
              La vinculación de los encuentros actuales con Google estará disponible próximamente.
            </p>
          </div>
        )}

        {activeTab === 'upcoming' ? (
          proximos.length > 0 ? (
            <div className="home-card-list">
              {proximos.map(enc => (
                <ActiveCard
                  key={enc.id}
                  enc={enc}
                  onClick={() => {
                    if (activeScope === 'participo' && enc._mi_token_invitacion) {
                      if (isCoordinationEncounter(enc)) {
                        navigate(`/coordination/invite/${enc._mi_token_invitacion}`);
                      } else {
                        navigate(`/invite/${enc._mi_token_invitacion}`);
                      }
                    } else if (isCoordinationEncounter(enc)) {
                      navigate(`/coordination/${enc.id}`);
                    } else {
                      navigate(`/meet/${enc.id}`);
                    }
                  }}
                  participantesCache={activeScope === 'organizo' ? (detailCache[enc.id]?.participantes ?? null) : null}
                  miEstado={activeScope === 'participo' ? (enc._mi_estado ?? null) : null}
                  counts={counts[enc.id] ?? null}
                  isHost={activeScope === 'organizo'}
                />
              ))}
            </div>
          ) : (
            <div className="home-empty">
              <div className="home-empty-icon">
                <Calendar size={32} color="var(--color-primary)" />
              </div>
              <h2 className="home-empty-title">
                {encuentros.length === 0 ? (
                  <>Todavía no tenés encuentros<br />programados 👇</>
                ) : (
                  <>No tenés encuentros próximos</>
                )}
              </h2>
              {(!encuentros || encuentros.length === 0) && (
                <Button
                  variant="primary"
                  fullWidth
                  style={{ height: 56, fontSize: 16, fontWeight: 700, marginTop: 12 }}
                  onClick={handleCreateClick}
                >
                  + Crear encuentro
                </Button>
              )}
            </div>
          )
        ) : (
          pasados.length > 0 ? (
            <div className="home-card-list">
              {pasados.map(enc => (
                <PastCard
                  key={enc.id}
                  enc={enc}
                  onClick={() => {
                    if (activeScope === 'participo' && enc._mi_token_invitacion) {
                      if (isCoordinationEncounter(enc)) {
                        navigate(`/coordination/invite/${enc._mi_token_invitacion}`);
                      } else {
                        navigate(`/invite/${enc._mi_token_invitacion}`);
                      }
                    } else if (isCoordinationEncounter(enc)) {
                      navigate(`/coordination/${enc.id}`);
                    } else {
                      navigate(`/meet/${enc.id}`);
                    }
                  }}
                  onRepeat={(e) => handleRepeat(enc, e)}
                  participantesCache={activeScope === 'organizo' ? (detailCache[enc.id]?.participantes ?? null) : null}
                  miEstado={activeScope === 'participo' ? (enc._mi_estado ?? null) : null}
                  counts={counts[enc.id] ?? null}
                />
              ))}
            </div>
          ) : (
            <div className="home-empty-past">
              No hay encuentros anteriores
            </div>
          )
        )}
      </div>
    );
  };

  return (
    <ScreenContainer style={{ background: 'var(--color-background)' }} className="home-screen-container">
      <header className="home-header">
        <div className="home-header-brand" onClick={handleTap}>
          <span className="home-header-logo-text">PuntoEncuentro</span>
        </div>
        <div className="home-header-actions">
          {/* Botón de perfil/cuenta */}
          <button
            onClick={() => setIsAccountOpen(true)}
            aria-label="Cuenta"
            className={`home-header-avatar-btn ${user ? 'home-header-avatar-btn--logged' : ''}`}
            title={user ? 'Tu cuenta' : 'Iniciar sesión'}
          >
            {user && userAvatarUrl && !imgError ? (
              <img
                src={userAvatarUrl}
                alt=""
                onError={() => setImgError(true)}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : user ? (
              <span className="home-header-avatar-initials">
                {userInitials}
              </span>
            ) : (
              <User size={18} color="var(--color-outline)" />
            )}
          </button>

          {/* Botón de filtros */}
          {(encuentros.length > 0 || filterStatus !== 'all' || filterType !== 'all') && (
            <button
              onClick={() => setIsFilterOpen(true)}
              className="home-header-icon-btn"
              style={{
                color: filterStatus !== 'all' || sortBy !== 'date_upcoming' ? 'var(--color-primary)' : 'var(--color-on-surface)'
              }}
              title="Filtros"
            >
              <Sliders size={20} />
            </button>
          )}

          {/* Botón de información */}
          <button
            onClick={() => setIsInfoOpen(true)}
            className="home-header-icon-btn"
            title="Información"
          >
            <MoreVertical size={20} />
          </button>
        </div>
      </header>

      {/* Hero Section con Composición Centrada Envolvente V2 y Espacio Vivo Dinámico */}
      <div className={`home-hero-wrapper home-hero-wrapper--${effectiveVariant}`}>
        {/* Espacio vivo de etiquetas flotantes y fotos en movimiento */}
        <HomeDynamicCanvas
          variant={effectiveVariant}
          isInputFocused={isInputFocused}
          onTagClick={(tagText) => setHomeIntent(tagText)}
        />

        {/* Flancos visuales de soporte complementario en Variante A */}
        {effectiveVariant === 'envolvente' && (
          <HomeFlankingVisuals isInputFocused={isInputFocused} />
        )}

        <div className="home-hero-center-column">
          <HomeHero
            isPausedByInput={isInputFocused || isSpeechListening || Boolean(homeIntent.trim())}
            onPhraseClick={(phrase) => {
              setHomeIntent(phrase);
            }}
          />

          {/* Input de Intención y CTA */}
          <HomeIntentInput
            value={homeIntent}
            onChange={setHomeIntent}
            onSubmit={handleIntentSubmit}
            isSubmitting={isSubmittingIntent}
            onFocusChange={setIsInputFocused}
            isListeningChange={setIsSpeechListening}
          />

          {/* Chips de Sugerencia */}
          <div style={{ marginTop: '0.75rem', width: '100%', position: 'relative', zIndex: 6 }}>
            <HomeSuggestionChips suggestions={V2_SUGGESTIONS} onSelect={handleSelectSuggestion} />
          </div>
        </div>
      </div>


      {/* Card de reanudación de borrador activo */}
      {hasActiveDraft && (
        <div style={{ marginTop: '0.75rem', width: '100%', maxWidth: '680px', margin: '0.75rem auto 0' }}>
          <HomeDraftResumeCard
            title={aiDraft.title}
            details={
              aiDraft.date
                ? `Programado para ${aiDraft.date}`
                : aiDraft.dateOptions?.length
                ? `${aiDraft.dateOptions.length} fechas propuestas`
                : 'Borrador sin finalizar'
            }
            onResume={handleResumeOldDraft}
            onDiscard={handleDiscardOldDraft}
          />
        </div>
      )}

      {/* Modalidades de encuentro (Los 3 Pilares V2) */}
      <HomePillarsSection onCreateClick={handleCreateClick} />

      {/* Si es visitante sin encuentros: Mostrar bloque "Cómo funciona" */}
      {!loading && (!encuentros || encuentros.length === 0) && !user && (
        <HomeValueProposition />
      )}

      {/* Sección "Tus encuentros" para usuarios con encuentros o logueados */}
      {(user || (encuentros && encuentros.length > 0)) && (
        <div className="home-encounters-section">
          <div className="home-encounters-header">
            <h2 className="home-encounters-title">Tus encuentros</h2>
            <span className="home-encounters-count">
              {totalProximos} próximo{totalProximos !== 1 ? 's' : ''} • {totalPasados} anterior{totalPasados !== 1 ? 'es' : ''}
            </span>
          </div>

      {/* A. Selector de Scope: Organizo / Participo (solo si logueado) */}
      {user && (
        <div className="home-scope-container">
          <div className="home-scope-toggle">
            <button
              onClick={() => setActiveScope('organizo')}
              className={`home-scope-btn ${activeScope === 'organizo' ? 'home-scope-btn--active' : ''}`}
            >
              Organizo
            </button>
            <button
              onClick={() => setActiveScope('participo')}
              className={`home-scope-btn ${activeScope === 'participo' ? 'home-scope-btn--active' : ''}`}
            >
              Participo
            </button>
          </div>
        </div>
      )}

      {/* Chips de filtrado por Tipo */}
      {!loading && (encuentros.length > 0 || filterType !== 'all') && (
        <div style={{ padding: '8px 20px', display: 'flex', gap: '8px', overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', msOverflowStyle: 'none' }} className="hide-scrollbar">
          <button
            onClick={() => setFilterType('all')}
            className={`pe-sheet-chip ${filterType === 'all' ? 'pe-sheet-chip--selected' : 'pe-sheet-chip--unselected'}`}
            style={{ padding: '6px 14px', fontSize: 13, borderRadius: 16, whiteSpace: 'nowrap' }}
          >
            Todos
          </button>
          <button
            onClick={() => setFilterType('fixed')}
            className={`pe-sheet-chip ${filterType === 'fixed' ? 'pe-sheet-chip--selected' : 'pe-sheet-chip--unselected'}`}
            style={{ padding: '6px 14px', fontSize: 13, borderRadius: 16, whiteSpace: 'nowrap' }}
          >
            Fecha definida
          </button>
          <button
            onClick={() => setFilterType('coordination')}
            className={`pe-sheet-chip ${filterType === 'coordination' ? 'pe-sheet-chip--selected' : 'pe-sheet-chip--unselected'}`}
            style={{ padding: '6px 14px', fontSize: 13, borderRadius: 16, whiteSpace: 'nowrap' }}
          >
            Coordinados
          </button>
        </div>
      )}

      {/* Sub-filtros para Coordinados */}
      {!loading && filterType === 'coordination' && (
        <div style={{ padding: '0px 20px 8px', display: 'flex', gap: '8px', overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', msOverflowStyle: 'none' }} className="hide-scrollbar">
          <button
            onClick={() => setFilterCoordinationState('all')}
            style={{ background: filterCoordinationState === 'all' ? 'var(--color-primary-container)' : 'transparent', color: filterCoordinationState === 'all' ? 'var(--color-primary-dark)' : 'var(--color-on-surface-variant)', border: 'none', padding: '4px 10px', fontSize: 12, borderRadius: 12, fontWeight: filterCoordinationState === 'all' ? 600 : 500, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            Todos
          </button>
          <button
            onClick={() => setFilterCoordinationState('open')}
            style={{ background: filterCoordinationState === 'open' ? 'var(--color-primary-container)' : 'transparent', color: filterCoordinationState === 'open' ? 'var(--color-primary-dark)' : 'var(--color-on-surface-variant)', border: 'none', padding: '4px 10px', fontSize: 12, borderRadius: 12, fontWeight: filterCoordinationState === 'open' ? 600 : 500, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            A coordinar
          </button>
          <button
            onClick={() => setFilterCoordinationState('expired')}
            style={{ background: filterCoordinationState === 'expired' ? 'var(--color-primary-container)' : 'transparent', color: filterCoordinationState === 'expired' ? 'var(--color-primary-dark)' : 'var(--color-on-surface-variant)', border: 'none', padding: '4px 10px', fontSize: 12, borderRadius: 12, fontWeight: filterCoordinationState === 'expired' ? 600 : 500, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            Plazo vencido
          </button>
          <button
            onClick={() => setFilterCoordinationState('closed')}
            style={{ background: filterCoordinationState === 'closed' ? 'var(--color-primary-container)' : 'transparent', color: filterCoordinationState === 'closed' ? 'var(--color-primary-dark)' : 'var(--color-on-surface-variant)', border: 'none', padding: '4px 10px', fontSize: 12, borderRadius: 12, fontWeight: filterCoordinationState === 'closed' ? 600 : 500, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            Fecha confirmada
          </button>
        </div>
      )}

      {/* B. Segmented Control Toggle (Próximos / Anteriores) */}
      {!loading && (encuentros.length > 0 || filterStatus !== 'all') && (
        <div className="home-tabs-container">
          <div className="home-tabs">
            <button
              onClick={() => setActiveTab('upcoming')}
              className={`home-tab ${activeTab === 'upcoming' ? 'home-tab--active' : ''}`}
            >
              <span>Próximos</span>
              <span className="home-tab-badge">{totalProximos}</span>
            </button>

            <button
              onClick={() => setActiveTab('past')}
              className={`home-tab ${activeTab === 'past' ? 'home-tab--active' : ''}`}
            >
              <span>Anteriores</span>
              <span className="home-tab-badge">{totalPasados}</span>
            </button>
          </div>
        </div>
      )}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '0 20px', overflow: 'hidden' }}>
        {renderContent()}
      </div>
        </div>
      )}

      {/* Bottom Sheets */}
      <DraftOverwriteConfirmSheet
        open={isOverwriteSheetOpen}
        draftTitle={aiDraft.title}
        newPrompt={homeIntent.trim()}
        onConfirmNew={handleConfirmNewDraft}
        onResumeOld={handleResumeOldDraft}
        onClose={() => setIsOverwriteSheetOpen(false)}
      />
      <FilterSheet isOpen={isFilterOpen} onClose={() => setIsFilterOpen(false)} />
      <AccountSheet isOpen={isAccountOpen} onClose={() => setIsAccountOpen(false)} />
      <InfoSheet isOpen={isInfoOpen} onClose={() => setIsInfoOpen(false)} />
      <CreationAccountChoiceSheet {...choiceSheetProps} />
      <EncounterModeChoiceSheet
        open={isModeChoiceOpen}
        onSelectAI={() => {
          setIsModeChoiceOpen(false);
          useAiWizardStore.getState().reset();
          navigate('/create/ai');
        }}
        onSelectFixed={() => {
          setIsModeChoiceOpen(false);
          startFixedEncounter();
        }}
        onSelectCoordination={() => {
          setIsModeChoiceOpen(false);
          startCoordinationEncounter();
        }}
        onClose={() => setIsModeChoiceOpen(false)}
      />
      <AnonymousCoordinationWarningSheet
        {...coordinationWarningProps}
        onSelectFixed={() => {
          coordinationWarningProps.onClose();
          startFixedEncounter();
        }}
      />

      {/* FAB Botón Crear */}
      {!loading && encuentros && encuentros.length > 0 && (
        <div className="home-fab-container">
          <div className="home-fab-wrapper">
            <button
              onClick={handleCreateClick}
              className="home-fab"
            >
              <Plus size={24} />
              <span className="home-fab-text">Crear</span>
            </button>
          </div>
        </div>
      )}
      {!loading && (
        <div className="home-build-info">
          <span>
            Build: {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'Local'}
          </span>
        </div>
      )}

      {/* Selector Flotante de Variantes para Evaluación Local */}
      {!forcedVariant && (
        <HomeVariantSwitcher
          currentVariant={effectiveVariant}
          onVariantChange={handleVariantChange}
        />
      )}
    </ScreenContainer>

  );
};

export default Home;
