import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Calendar, Plus, User, MoreVertical, Bell } from 'lucide-react';
import { AccountSheet } from '@/components/ui/AccountSheet';
import { InfoSheet } from '@/components/ui/InfoSheet';
import { StatusChip } from '@/components/ui/StatusChip';
import { NotificationsSheet } from '@/components/notifications';
import { HomeOpenEncounterDetailSheet } from '@/components/home/openEncounters/HomeOpenEncounterDetailSheet';
import type { OpenEncounterSummary } from '@/components/home/openEncounters/types';
import { useNotifications } from '@/contexts/NotificationsContext';
import './Home.css';
import { encuentrosService } from '@/services/encuentrosService';
import { openEncountersService } from '@/services/openEncountersService';

import { rememberEncuentroHostBulk } from '@/lib/meetHostsStorage';
import { useAuth } from '@/contexts/AuthContext';
import { useCreateEncounter } from '@/hooks/useCreateEncounter';
import { useEntitlements } from '@/hooks/useEntitlements';
import { LoginRequiredSheet } from '@/components/auth/LoginRequiredSheet';
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
import throttle from 'lodash/throttle';
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
} from '@/components/home';
import { AiLimitReachedSheet } from '@/components/home/AiLimitReachedSheet';
import type { HomeVisualVariant } from '@/components/home';
import { V2_SUGGESTIONS } from '@/components/home/HomeSuggestionChips';
import { HomeOpenEncounters } from '@/components/home/openEncounters/HomeOpenEncounters';
import { HomeEncountersToolbar } from '@/components/home/yourEncounters/HomeEncountersToolbar';
import {
  HomeEncountersFilterSheet,
  DEFAULT_FILTER_VALUES,
  countActiveSecondaryFilters,
  type EncountersFilterValues,
} from '@/components/home/yourEncounters/HomeEncountersFilterSheet';
import { HomeIntencionesSection } from '@/components/home/intentions/HomeIntencionesSection';

const HomeDynamicCanvasGsap = React.lazy(() => import('@/components/home/HomeDynamicCanvasGsap'));


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

export function formatBuildTimestamp(raw: string): string {
  if (!raw) return '';
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})/);
  if (match) {
    const [, d, m, y, h, min] = match;
    return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y} ${h.padStart(2, '0')}:${min}`;
  }
  const parsedDate = new Date(raw);
  if (!isNaN(parsedDate.getTime())) {
    const formatted = parsedDate.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    const matchIso = formatted.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})/);
    if (matchIso) {
      const [, d, m, y, h, min] = matchIso;
      return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y} ${h.padStart(2, '0')}:${min}`;
    }
  }
  return raw;
}

/* ─── Pantalla principal ─────────────────────────────────────────────────── */
export interface HomeProps {
  forcedVariant?: HomeVisualVariant;
  enableOpenDiscovery?: boolean;
  homeVariant?: 'v1' | 'v2';
  appEnv?: string;
}

const Home: React.FC<HomeProps> = ({ forcedVariant, enableOpenDiscovery, homeVariant: propHomeVariant, appEnv: propAppEnv }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading: authLoading, signInWithGoogleForDiscovery, isPermanentUser } = useAuth();
  const { getValidCache, scrollPosition, setEncuentros, setScrollPosition, filterStatus, filterType, filterCoordinationState, sortBy, setFilterType, setFilterCoordinationState } = useHomeStore();
  const wizardStore = useWizardStore();
  const { reset: resetWizard } = wizardStore;
  const detailCache = useDetailStore(s => s.cache);
  const validCache = getValidCache();
  const storeState = useHomeStore.getState();
  const staleOrganized = storeState.encuentros;
  const staleParticipated = storeState.participatedEncuentros;
  const { handleTap } = useHiddenDiscovery();

  // Variante V2 de revisión de la Home (restringida a entornos no productivos vía __APP_ENV__)
  const currentEnv = propAppEnv || (typeof __APP_ENV__ !== 'undefined' ? __APP_ENV__ : 'development');
  const isProductionEnv = currentEnv === 'production';
  const queryHomeVariant = new URLSearchParams(
    location?.search || (typeof window !== 'undefined' ? window.location.search : '')
  ).get('homeVariant');

  const isV2Variant = !isProductionEnv && (
    propHomeVariant === 'v2' || (
      propHomeVariant !== 'v1' && queryHomeVariant === 'v2'
    )
  );

  // Variante de diseño visual de la Home (GSAP definitiva por defecto)
  const [visualVariant] = useState<HomeVisualVariant>(() => {
    if (forcedVariant) return forcedVariant;
    if (typeof window !== 'undefined') {
      try {
        const params = new URLSearchParams(window.location.search);
        const paramVariant = params.get('variant') || params.get('v');
        if (paramVariant === 'gsap') return 'gsap';
        if (paramVariant === 'd' || paramVariant === 'stitch') return 'stitch';
        if (paramVariant === 'c' || paramVariant === 'refinado') return 'refinado';
        if (paramVariant === 'b' || paramVariant === 'visor') return 'visor';
        if (paramVariant === 'a' || paramVariant === 'envolvente') return 'envolvente';
      } catch (e) {
        // Fallback seguro
      }
    }
    return 'gsap';
  });

  const effectiveVariant: HomeVisualVariant = forcedVariant || visualVariant;

  const isGsapPreview = effectiveVariant === 'gsap' || forcedVariant === 'gsap' || enableOpenDiscovery;

  // Si no hay caché válido ni datos viejos para mostrar, iniciamos en loading
  const [loading, setLoading] = useState(
    !validCache && staleOrganized.length === 0 && staleParticipated.length === 0
  );
  const [error, setError] = useState<string | null>(null);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'upcoming' | 'past'>('upcoming');
  const [activeScope, setActiveScope] = useState<'todos' | 'organizo' | 'participo'>(() => (forcedVariant === 'gsap' || effectiveVariant === 'gsap' || enableOpenDiscovery ? 'todos' : 'organizo'));
  const [userSectionTab, setUserSectionTab] = useState<'encuentros' | 'intenciones'>(() => {
    if (typeof window !== 'undefined' && window.sessionStorage?.getItem('puntoencuentro_pending_intention')) {
      return 'intenciones';
    }
    return 'encuentros';
  });
  const [imgError, setImgError] = useState(false);

  // Filtros secundarios simplificados para Preview GSAP
  const [secondaryFilters, setSecondaryFilters] = useState<EncountersFilterValues>(DEFAULT_FILTER_VALUES);
  const [isSecondaryFilterOpen, setIsSecondaryFilterOpen] = useState(false);

  // Hook y estados de Notificaciones In-App (Fase 1.5)
  const {
    unreadCount: notificationsUnreadCount,
    isOpen: isNotificationsOpen,
    setIsOpen: setIsNotificationsOpen,
  } = useNotifications();

  // Estado para visualización de Encuentro Abierto desde deep link
  const [selectedDeepLinkEncounter, setSelectedDeepLinkEncounter] = useState<OpenEncounterSummary | null>(null);
  const [isDeepLinkEncounterDetailOpen, setIsDeepLinkEncounterDetailOpen] = useState(false);

  // ── DEEP LINK "open_encounter" (Fase 2B) ──
  // Abre automáticamente el sheet de detalle seguro al navegar a /?open_encounter=<uuid>
  const lastProcessedEncounterIdRef = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const encounterId = params.get('open_encounter');
    if (!encounterId) return;

    if (lastProcessedEncounterIdRef.current === encounterId) return;
    lastProcessedEncounterIdRef.current = encounterId;

    // 1. Validar UUID/formato (RFC 4122)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(encounterId)) {
      console.warn('[Home] ID de encuentro abierto inválido en deep link:', encounterId);
      // Limpiar parámetro de la URL sin recargar
      params.delete('open_encounter');
      const cleanSearch = params.toString();
      navigate(cleanSearch ? `${location.pathname}?${cleanSearch}` : location.pathname, { replace: true });
      return;
    }

    // 2. Localizar/cargar el encuentro abierto
    let isMounted = true;
    void openEncountersService
      .getEncuentroAbiertoById(encounterId)
      .then((enc) => {
        if (!isMounted) return;
        if (enc) {
          // 3. Abrir automáticamente HomeOpenEncounterDetailSheet
          setSelectedDeepLinkEncounter(enc);
          setIsDeepLinkEncounterDetailOpen(true);
        } else {
          // 4. Fallback discreto si no existe o ya no está abierto
          console.info('[Home] El encuentro abierto ya no está disponible o no existe:', encounterId);
        }

        // 5. Limpiar open_encounter de la URL mediante navegación replace
        params.delete('open_encounter');
        const cleanSearch = params.toString();
        navigate(cleanSearch ? `${location.pathname}?${cleanSearch}` : location.pathname, { replace: true });
      })
      .catch((err) => {
        if (!isMounted) return;
        console.error('[Home] Error cargando encuentro abierto desde deep link:', err);
        params.delete('open_encounter');
        const cleanSearch = params.toString();
        navigate(cleanSearch ? `${location.pathname}?${cleanSearch}` : location.pathname, { replace: true });
      });

    return () => {
      isMounted = false;
    };
  }, [location.search, location.pathname, navigate]);

  // ── DEEP LINK "notifications" (Fase 3B - Privacidad Web Push) ──
  // Al hacer clic en un push neutral (?notifications=1), abre la bandeja de notificaciones
  // únicamente si el usuario cuenta con una sesión permanente autenticada.
  // Limpia el query param con replace sin recargar la página y no carga ninguna notificación por ID.
  useEffect(() => {
    if (authLoading) return;

    const params = new URLSearchParams(location.search);
    if (!params.has('notifications')) return;

    const notifVal = params.get('notifications');
    if (notifVal === '1' || notifVal === 'true') {
      if (isPermanentUser) {
        setIsNotificationsOpen(true);
      }
    }

    params.delete('notifications');
    const cleanSearch = params.toString();
    navigate(cleanSearch ? `${location.pathname}?${cleanSearch}` : location.pathname, { replace: true });
  }, [authLoading, isPermanentUser, location.search, location.pathname, navigate, setIsNotificationsOpen]);

  // Estados locales para las dos listas
  const [organizedEncuentros, setOrganizedEncuentros] = useState<any[]>(validCache?.organized || staleOrganized || []);
  const [participatedEncuentros, setParticipatedEncuentros] = useState<any[]>(validCache?.participated || staleParticipated || []);
  const [counts, setCounts] = useState<Record<string, { total: number; confirmados: number }>>({});

  // Conteo total de encuentros únicos combinando organizados y participados sin duplicaciones
  const allUniqueTodosCount = React.useMemo(() => {
    const seen = new Set<string>();
    for (const enc of organizedEncuentros || []) {
      if (enc?.id) seen.add(enc.id);
    }
    for (const enc of participatedEncuentros || []) {
      if (enc?.id) seen.add(enc.id);
    }
    return seen.size;
  }, [organizedEncuentros, participatedEncuentros]);

  // Lista unificada sin duplicaciones para selector "Todos" en Preview GSAP (Sección 31)
  const rawEncuentros = React.useMemo(() => {
    if (activeScope === 'organizo') {
      return (organizedEncuentros || []).map(e => ({ ...e, _isHost: true }));
    }
    if (activeScope === 'participo') {
      return (participatedEncuentros || []).map(e => ({ ...e, _isHost: false }));
    }
    const seen = new Set<string>();
    const list: any[] = [];
    for (const enc of organizedEncuentros || []) {
      if (enc && enc.id && !seen.has(enc.id)) {
        seen.add(enc.id);
        list.push({ ...enc, _isHost: true });
      }
    }
    for (const enc of participatedEncuentros || []) {
      if (enc && enc.id && !seen.has(enc.id)) {
        seen.add(enc.id);
        list.push({ ...enc, _isHost: false });
      }
    }
    return list;
  }, [activeScope, organizedEncuentros, participatedEncuentros]);

  // Los encuentros "visibles" dependen del scope activo
  const encuentros = activeScope === 'organizo' ? organizedEncuentros : activeScope === 'participo' ? participatedEncuentros : rawEncuentros;

  // Lista filtrada para Preview GSAP según momento, tipo, estado y orden
  const filteredGsap = React.useMemo(() => {
    return (rawEncuentros || []).filter(enc => {
      if (!enc) return false;

      // 1. Momento (timeFilter)
      const bucket = getEncounterListBucket(enc);
      const isActive = bucket !== 'cancelled' && bucket !== 'past';
      if (secondaryFilters.timeFilter === 'upcoming' && !isActive) return false;
      if (secondaryFilters.timeFilter === 'past' && isActive) return false;

      // 2. Tipo
      const isCoord = isCoordinationEncounter(enc);
      if (secondaryFilters.filterType === 'fixed' && isCoord) return false;
      if (secondaryFilters.filterType === 'coordination' && !isCoord) return false;

      // 3. Estado de coordinación
      if (secondaryFilters.filterType === 'coordination' && isCoord && secondaryFilters.filterCoordinationState !== 'all') {
        const isExpired = enc.coordination_status === 'open' && enc.response_deadline && new Date(enc.response_deadline) < new Date();
        if (secondaryFilters.filterCoordinationState === 'open' && (enc.coordination_status !== 'open' || isExpired)) return false;
        if (secondaryFilters.filterCoordinationState === 'expired' && !isExpired) return false;
        if (secondaryFilters.filterCoordinationState === 'closed' && enc.coordination_status !== 'closed') return false;
      }

      return true;
    }).sort((a, b) => {
      const getVal = (enc: any) => {
        const d = new Date(`${enc.fecha || ''}T${enc.hora || ''}`).getTime();
        if (!isNaN(d)) return d;
        if (enc.response_deadline) return new Date(enc.response_deadline).getTime();
        if (enc.creado_en) return new Date(enc.creado_en).getTime();
        return 0;
      };

      if (secondaryFilters.sortBy === 'date_upcoming') {
        return getVal(a) - getVal(b);
      }
      if (secondaryFilters.sortBy === 'date_distant') {
        return getVal(b) - getVal(a);
      }
      if (secondaryFilters.sortBy === 'name_asc') {
        return (a.titulo || '').localeCompare(b.titulo || '');
      }
      if (secondaryFilters.sortBy === 'name_desc') {
        return (b.titulo || '').localeCompare(a.titulo || '');
      }
      return 0;
    });
  }, [rawEncuentros, secondaryFilters]);



  const { startFixedEncounter, choiceSheetProps } = useCreateEncounter();
  const { startCoordinationEncounter, coordinationWarningProps } = useStartCoordinationEncounter();

  const [isModeChoiceOpen, setIsModeChoiceOpen] = useState(false);
  const [isOverwriteSheetOpen, setIsOverwriteSheetOpen] = useState(false);
  const [homeIntent, setHomeIntent] = useState('');
  const [isSubmittingIntent, setIsSubmittingIntent] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [isSpeechListening, setIsSpeechListening] = useState(false);
  
  const [isLoginRequiredForAiOpen, setIsLoginRequiredForAiOpen] = useState(false);
  const [pendingAiIntent, setPendingAiIntent] = useState<string | null>(null);
  const [isAiLimitReachedOpen, setIsAiLimitReachedOpen] = useState(false);
  
  const { data: entitlements } = useEntitlements();
  // ── FAB persistente global ──────────────────────────────────────────────────
  // El FAB "+ Crear" es un acceso rápido GLOBAL visible durante todo el recorrido de la Home.
  // No se oculta por la presencia de otros CTAs de creación (Hero, Pilares, empty state):
  // esos son CTAs contextuales; el FAB es una utilidad de acceso rápido para usuarios recurrentes.
  //
  // Se oculta únicamente cuando existe una razón funcional real:
  //   • loading (acción de creación imposible)
  //   • modal / bottom-sheet abierto (FAB quedaría bajo el overlay)
  //   • teclado/input activo en mobile (interfiere con la escritura)
  //
  // En desktop el input enfocado no oculta el FAB salvo interferencia real (layout fijo).
  const isAnySheetOpen =
    isAccountOpen ||
    isInfoOpen ||
    isSecondaryFilterOpen ||
    isModeChoiceOpen ||
    isOverwriteSheetOpen ||
    isLoginRequiredForAiOpen ||
    isAiLimitReachedOpen ||
    Boolean(coordinationWarningProps.open);

  const isMobileViewport = typeof window !== 'undefined' && window.innerWidth < 768;

  const showFab =
    !loading &&
    !isAnySheetOpen &&
    !(isInputFocused && isMobileViewport);


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

    // 1. Check if user is anonymous (requires permanent account for AI)
    if (isAnonymousUser) {
      setPendingAiIntent(text);
      setIsLoginRequiredForAiOpen(true);
      return;
    }

    // 2. Check entitlements and limit
    if (entitlements && entitlements.limits.enforcement_enabled && entitlements.usage.remaining_effective !== null) {
      if (entitlements.usage.remaining_effective <= 0) {
        setIsAiLimitReachedOpen(true);
        return;
      }
    }

    // 3. Check for existing active draft
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

      // ── RECOVER PENDING AI INTENT AFTER LOGIN ──
      if (!user.is_anonymous) {
        const pendingAi = sessionStorage.getItem('puntoencuentro_pending_ai_intent');
        if (pendingAi) {
          sessionStorage.removeItem('puntoencuentro_pending_ai_intent');
          // Give it a tiny delay to allow the layout to settle before redirecting
          setTimeout(() => {
            useAiWizardStore.getState().startNewWithPrompt(pendingAi);
            navigate('/create/ai');
          }, 100);
        }
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

  const renderGsapContent = () => {
    if (loading) {
      return (
        <div className="home-loading">
          <p className="home-loading-text">Cargando encuentros…</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="home-error">
          <p className="home-error-text">{error}</p>
          <Button variant="outline" onClick={loadData}>Reintentar</Button>
        </div>
      );
    }

    if (rawEncuentros.length === 0) {
      const isOrganizo = activeScope === 'organizo';
      return (
        <div className="home-empty">
          <div className="home-empty-icon">
            <Calendar size={40} color="var(--color-primary)" />
          </div>
          <h2 className="home-empty-title">
            {isOrganizo
              ? 'Todavía no organizaste encuentros'
              : activeScope === 'participo'
              ? 'Todavía no tenés invitaciones confirmadas'
              : 'Todavía no tenés encuentros programados'}
          </h2>
          <p className="home-empty-desc">
            {isOrganizo || activeScope === 'todos'
              ? 'Creá uno nuevo para coordinar con otros o sumate a un plan abierto.'
              : 'Cuando confirmes asistencia, aparecerán acá.'}
          </p>
          <Button
            variant="primary"
            style={{ minWidth: 200, maxWidth: 260, height: 48, fontSize: 15, fontWeight: 700, marginTop: 14, alignSelf: 'center' }}
            onClick={handleCreateClick}
          >
            + Crear encuentro
          </Button>
        </div>
      );
    }

    if (filteredGsap.length === 0) {
      return (
        <div className="home-empty" style={{ padding: '2rem 1rem' }}>
          <div className="home-empty-icon">
            <Calendar size={32} color="var(--color-primary)" />
          </div>
          <h2 className="home-empty-title">No hay encuentros para los filtros aplicados</h2>
          <p className="home-empty-desc">Probá cambiando el momento o el tipo seleccionado.</p>
          <Button
            variant="outline"
            onClick={() => setSecondaryFilters(DEFAULT_FILTER_VALUES)}
            style={{ marginTop: 12 }}
          >
            Limpiar filtros
          </Button>
        </div>
      );
    }

    return (
      <div className="home-card-list">
        {filteredGsap.map(enc => {
          const isHost = enc._isHost ?? (activeScope === 'organizo');
          const bucket = getEncounterListBucket(enc);
          const isPast = bucket === 'past' || bucket === 'cancelled';
          if (isPast) {
            return (
              <PastCard
                key={enc.id}
                enc={enc}
                onClick={() => {
                  if (!isHost && enc._mi_token_invitacion) {
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
                participantesCache={isHost ? (detailCache[enc.id]?.participantes ?? null) : null}
                miEstado={!isHost ? (enc._mi_estado ?? null) : null}
                counts={counts[enc.id] ?? null}
              />
            );
          }

          return (
            <ActiveCard
              key={enc.id}
              enc={enc}
              onClick={() => {
                if (!isHost && enc._mi_token_invitacion) {
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
              participantesCache={isHost ? (detailCache[enc.id]?.participantes ?? null) : null}
              miEstado={!isHost ? (enc._mi_estado ?? null) : null}
              counts={counts[enc.id] ?? null}
              isHost={isHost}
            />
          );
        })}
      </div>
    );
  };

  return (
    <ScreenContainer
      style={{ background: 'var(--color-background)' }}
      className={`home-screen-container${isGsapPreview ? ' home-gsap-layout' : ''}${isV2Variant ? ' home-v2-variant' : ''}`}
    >
      <header className="home-header">
        <div className="home-header-brand" onClick={handleTap}>
          <span className="home-header-logo-text">PuntoEncuentro</span>
        </div>
        <div className="home-header-actions">
          {/* Campana de notificaciones (solo cuentas permanentes) */}
          {user && !user.is_anonymous && (
            <button
              type="button"
              onClick={() => setIsNotificationsOpen(true)}
              className="home-header-icon-btn home-header-bell-btn"
              aria-label={
                notificationsUnreadCount > 0
                  ? `Notificaciones (${notificationsUnreadCount} no leídas)`
                  : 'Notificaciones'
              }
              title="Notificaciones"
            >
              <div className="home-header-bell-wrapper">
                <Bell size={20} />
                {notificationsUnreadCount > 0 && (
                  <span className="home-header-bell-badge" aria-hidden="true">
                    {notificationsUnreadCount > 99
                      ? '99+'
                      : notificationsUnreadCount}
                  </span>
                )}
              </div>
            </button>
          )}

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
        {effectiveVariant === 'gsap' ? (
          <React.Suspense fallback={null}>
            <HomeDynamicCanvasGsap
              isInputFocused={isInputFocused}
              onTagClick={(tagText) => setHomeIntent(tagText)}
            />
          </React.Suspense>
        ) : (
          <HomeDynamicCanvas
            variant={effectiveVariant}
            isInputFocused={isInputFocused}
            onTagClick={(tagText) => setHomeIntent(tagText)}
          />
        )}

        {/* Flancos visuales de soporte complementario en Variante A */}
        {effectiveVariant === 'envolvente' && (
          <HomeFlankingVisuals isInputFocused={isInputFocused} />
        )}

        <div className="home-hero-center-column">
          <HomeHero
            isPausedByInput={isInputFocused || isSpeechListening || Boolean(homeIntent.trim())}
            subtitle={isV2Variant ? 'Decinos qué querés hacer. Organizalo con los tuyos o encontrá con quién hacerlo.' : undefined}
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

      {isGsapPreview ? (
        <>
          {/* 2. ENCUENTROS ABIERTOS (Discovery Carrousel inmediatamente debajo del Hero) */}
          <HomeOpenEncounters
            onOpenCreate={handleCreateClick}
            onFocusIntentInput={() => {
              const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-testid="home-intent-textarea"]');
              if (textarea) {
                textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
                textarea.focus();
              }
            }}
          />

          {/* 3. CAPACIDADES PRINCIPALES (Organizar / Abrir) */}
          <HomePillarsSection
            onCreateClick={handleCreateClick}
            variant={effectiveVariant}
            showLaunchBadges={!isV2Variant}
            openEncountersExplanation={isV2Variant ? '¿Te falta gente? Abrí lugares en un encuentro que ya organizaste.' : undefined}
          />

          {/* Si es visitante sin encuentros: Mostrar bloque "Cómo funciona" */}
          {!loading && rawEncuentros.length === 0 && !user && (
            <HomeValueProposition />
          )}

          {/* 4. TUS ENCUENTROS & INTENCIONES */}
          <div className="home-encounters-section">
            <div className="pe-encounters-inner">
              <div className="home-user-tabs" role="tablist" aria-label="Secciones de usuario">
                <button
                  type="button"
                  role="tab"
                  aria-selected={userSectionTab === 'encuentros'}
                  className={`home-user-tab ${userSectionTab === 'encuentros' ? 'home-user-tab--active' : ''}`}
                  onClick={() => setUserSectionTab('encuentros')}
                >
                  Tus encuentros
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={userSectionTab === 'intenciones'}
                  className={`home-user-tab ${userSectionTab === 'intenciones' ? 'home-user-tab--active' : ''}`}
                  onClick={() => setUserSectionTab('intenciones')}
                >
                  Intenciones
                </button>
              </div>

              {userSectionTab === 'encuentros' ? (
                <>
                  <HomeEncountersToolbar
                    activeScope={activeScope}
                    onScopeChange={setActiveScope}
                    isLoggedIn={Boolean(user)}
                    totalTodosCount={allUniqueTodosCount}
                    totalOrganizedCount={organizedEncuentros.length}
                    totalParticipatedCount={participatedEncuentros.length}
                    totalProximosCount={totalProximos}
                    totalPasadosCount={totalPasados}
                    activeFilterCount={countActiveSecondaryFilters(secondaryFilters)}
                    onOpenFilters={() => setIsSecondaryFilterOpen(true)}
                  />

                  <div className="pe-gsap-encounters-container">
                    {renderGsapContent()}
                  </div>
                </>
              ) : (
                <div style={{ padding: '0 0.5rem', marginTop: '1rem' }}>
                  <HomeIntencionesSection />
                </div>
              )}
            </div>
          </div>

          {/* Panel de filtros secundarios para Tus Encuentros */}
          <HomeEncountersFilterSheet
            isOpen={isSecondaryFilterOpen}
            filters={secondaryFilters}
            onApply={setSecondaryFilters}
            onClose={() => setIsSecondaryFilterOpen(false)}
          />
        </>
      ) : (
        <>
          {/* Modalidades de encuentro (Los 3 Pilares V2 / 2 Pilares en Lanzamiento Variante D) */}
          <HomePillarsSection
            onCreateClick={handleCreateClick}
            variant={effectiveVariant}
            showLaunchBadges={!isV2Variant}
            openEncountersExplanation={isV2Variant ? '¿Te falta gente? Abrí lugares en un encuentro que ya organizaste.' : undefined}
          />

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
        </>
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

      <LoginRequiredSheet
        isOpen={isLoginRequiredForAiOpen}
        action="create_ai"
        onClose={() => {
          setIsLoginRequiredForAiOpen(false);
          setPendingAiIntent(null);
        }}
        onContinueWithGoogle={async () => {
          if (pendingAiIntent) {
            sessionStorage.setItem('puntoencuentro_pending_ai_intent', pendingAiIntent);
          }
          await signInWithGoogleForDiscovery();
        }}
      />

      <AiLimitReachedSheet
        isOpen={isAiLimitReachedOpen}
        onClose={() => setIsAiLimitReachedOpen(false)}
        onManualCreate={() => {
          setIsAiLimitReachedOpen(false);
          startFixedEncounter();
        }}
      />

      {/* FAB Botón Crear Contextual (Mobile + Desktop, aparece al alejarte del Hero cuando no hay otro CTA de crear visible) */}
      {showFab && (
        <div className="home-fab-container">
          <div className="home-fab-wrapper">
            <button
              onClick={handleCreateClick}
              className="home-fab"
              aria-label="Crear encuentro"
            >
              <Plus size={18} strokeWidth={2.5} />
              <span className="home-fab-text">Crear</span>
            </button>
          </div>
        </div>
      )}
      {!loading && (
        <div className="home-build-info">
          <span>
            {isV2Variant ? (
              typeof __APP_VERSION__ !== 'undefined' ? formatBuildTimestamp(__APP_VERSION__) : ''
            ) : typeof __APP_ENV__ !== 'undefined' && __APP_ENV__ === 'staging' ? (
              <>STAGING · {typeof __GIT_COMMIT__ !== 'undefined' ? __GIT_COMMIT__ : 'local'} · {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'Local'}</>
            ) : typeof __APP_ENV__ !== 'undefined' && __APP_ENV__ === 'preview' ? (
              <>PREVIEW · {typeof __GIT_COMMIT__ !== 'undefined' ? __GIT_COMMIT__ : 'local'} · {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'Local'}</>
            ) : (
              <>Build: {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'Local'}</>
            )}
          </span>
        </div>
      )}

      {/* Bandeja de Notificaciones In-App (Fase 1.5) */}
      <NotificationsSheet
        isOpen={isNotificationsOpen}
        onClose={() => setIsNotificationsOpen(false)}
      />

      {/* Detalle seguro de Encuentro Abierto abierto desde deep link */}
      <HomeOpenEncounterDetailSheet
        isOpen={isDeepLinkEncounterDetailOpen}
        encounter={selectedDeepLinkEncounter}
        onClose={() => {
          setIsDeepLinkEncounterDetailOpen(false);
          setSelectedDeepLinkEncounter(null);
        }}
      />
    </ScreenContainer>

  );
};

export default Home;
