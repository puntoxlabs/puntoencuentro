import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
import { getHostId } from '@/lib/auth';
import { rememberEncuentroHostBulk } from '@/lib/meetHostsStorage';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { formatFriendlyDate, isEncuentroPasado as isEncuentroPasadoFormat } from '@/lib/formatDate';
import { useHomeStore } from '@/store/homeStore';
import { useWizardStore } from '@/store/wizardStore';
import { useDetailStore } from '@/store/detailStore';
import { themes } from '@/lib/themes';
import type { ThemeId } from '@/lib/themes';
import { throttle } from 'lodash';

/** Devuelve true si la fecha+hora del encuentro ya pasó */
function isEncuentroPasado(enc: any): boolean {
  if (!enc || !enc.fecha || !enc.hora) return false;
  return isEncuentroPasadoFormat(enc.fecha, enc.hora);
}

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
}> = ({ enc, onClick, participantesCache, miEstado, counts }) => {
  if (!enc) return null;
  const accentColor = getEncuentroPrimaryColor(enc);
  const confirmados = counts ? counts.confirmados : (participantesCache || []).filter((p: any) => p && p.estado === 'confirmado').length;
  const total = counts ? counts.total : (participantesCache || []).length;

  // Label para estado propio del invitado (vista Participo)
  const miEstadoLabel = miEstado === 'confirmado' ? '✔ Vas a asistir' : miEstado === 'rechazado' ? '✖ No vas a asistir' : miEstado ? 'Respuesta registrada' : null;

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
        <Badge label="Activo" status="active" />
      </div>

      <p className="home-card-date">
        📅 {formatFriendlyDate(enc.fecha, enc.hora)}
      </p>

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
        ) : (
          <Badge label="Finalizado" status="finished" />
        )}
      </div>

      <p className="home-card-date--past">
        📅 {formatFriendlyDate(enc.fecha, enc.hora)}
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
const Home: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, signInWithGoogle } = useAuth();
  const { getValidCache, scrollPosition, setEncuentros, setScrollPosition, filterStatus, sortBy } = useHomeStore();
  const wizardStore = useWizardStore();
  const { reset: resetWizard } = wizardStore;
  const detailCache = useDetailStore(s => s.cache);
  const validCache = getValidCache();
  const storeState = useHomeStore.getState();
  const staleOrganized = storeState.encuentros;
  const staleParticipated = storeState.participatedEncuentros;
  
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
  const [linking, setLinking] = useState(false);
  const [linkDismissed, setLinkDismissed] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);
  const [showHint, setShowHint] = useState(false);

  // Estados locales para las dos listas
  const [organizedEncuentros, setOrganizedEncuentros] = useState<any[]>(validCache?.organized || staleOrganized || []);
  const [participatedEncuentros, setParticipatedEncuentros] = useState<any[]>(validCache?.participated || staleParticipated || []);
  const [counts, setCounts] = useState<Record<string, { total: number; confirmados: number }>>({});

  // Los encuentros "visibles" dependen del scope activo
  const encuentros = activeScope === 'organizo' ? organizedEncuentros : participatedEncuentros;

  const anonId = getHostId();
  // Mostrar banner de VINCULACIÓN si: logueado + hay encuentros anónimos locales + no descartado
  const hasAnonymous = !!user
    && anonId !== user.id
    && !linkDismissed
    && (organizedEncuentros || []).some(e => e.host_id === anonId);

  // Mostrar nudge de LOGIN si: NO logueado + hay encuentros locales + no descartado
  const showAnonNudge = !user
    && !linkDismissed
    && (organizedEncuentros || []).length > 0;

  // Avatar helper
  const userAvatarUrl = user?.user_metadata?.avatar_url as string | undefined;
  const userInitials = (() => {
    const name = (user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || '') as string;
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase() || '?';
  })();

  const totalProximos = (encuentros || []).filter(enc => enc && typeof enc === 'object' && enc.estado !== 'cancelado' && !isEncuentroPasado(enc)).length;
  const totalPasados = (encuentros || []).filter(enc => enc && typeof enc === 'object' && (enc.estado === 'cancelado' || isEncuentroPasado(enc))).length;

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

  // Recargar cuando el usuario inicia o cierra sesión
  useEffect(() => {
    loadData();
  }, [user?.id]);

  const handleScroll = throttle((e: React.UIEvent<HTMLDivElement>) => {
    setScrollPosition(e.currentTarget.scrollTop);
  }, 200);

  const handleLinkEncuentros = async () => {
    if (!user || !anonId || linking) return;
    try {
      setLinking(true);
      setLinkError(null);
      await encuentrosService.linkAnonymousEncuentros(anonId, user.id);
      await loadData();
    } catch (err) {
      console.error('Error linking encuentros', err);
      setLinkError(t('account.link_error', 'No se pudieron guardar los encuentros. Intentá nuevamente.'));
    } finally {
      setLinking(false);
    }
  };

  const loadData = async () => {
    try {
      const isCacheValid = useHomeStore.getState().getValidCache() !== null;
      const storeState = useHomeStore.getState();
      const hasLocalData = storeState.encuentros.length > 0 || storeState.participatedEncuentros.length > 0;
      if (!isCacheValid && !hasLocalData) setLoading(true);
      setError(null);

      const anonId = getHostId();
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      const userId = currentUser?.id;

      let organized: any[] = [];
      let participated: any[] = [];

      if (userId) {
        // Logueado: traer organizados (user + anon) y participados
        organized = await encuentrosService.getEncuentrosByHostIds([userId, anonId]);
        participated = await encuentrosService.getEncuentrosParticipados(userId);
        
        // Cargar también participaciones anónimas locales y hacer merge
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
          if (import.meta.env.DEV) console.error('[HOME] Error cargando participo anónimo en merge:', err);
        }
      } else {
        // Anónimo: organizados del UUID local
        organized = await encuentrosService.getEncuentrosByHost(anonId);
        // Anónimo: participaciones por tokens locales
        try {
          const { getAllParticipatedTokens } = await import('@/lib/participatedTokens');
          const tokens = getAllParticipatedTokens();
          if (tokens.length > 0) {
            participated = await encuentrosService.getEncuentrosParticipadosPorTokens(tokens);
          }
        } catch (err) {
          if (import.meta.env.DEV) console.error('[HOME] Error cargando participo anónimo:', err);
        }
      }

      const sortList = (list: any[]) => (list || []).filter(e => e && e.id).sort((a, b) => {
        const dateA = new Date(`${a.fecha || ''}T${a.hora || ''}`).getTime();
        const dateB = new Date(`${b.fecha || ''}T${b.hora || ''}`).getTime();
        return (isNaN(dateA) ? 0 : dateA) - (isNaN(dateB) ? 0 : dateB);
      });

      const sortedOrganized = sortList(organized);
      const sortedParticipated = sortList(participated);

      const allIds = [...sortedOrganized, ...sortedParticipated].map(e => e.id).filter(Boolean);
      const newCounts = await encuentrosService.getCountsPorEncuentros(allIds);
      setCounts(newCounts);

      setOrganizedEncuentros(sortedOrganized);
      setParticipatedEncuentros(sortedParticipated);

      // Reforzar mapeo local encuentroId → hostId para todos los encuentros organizados.
      // Esto garantiza que DetailHost pueda resolver el hostId correcto al refrescar
      // incluso si el usuario llegó a esta pantalla antes de pasar por Home.
      rememberEncuentroHostBulk(sortedOrganized);

      // Actualizar el store global (principalmente para la lista de organizados que es la principal)
      setEncuentros(sortedOrganized, sortedParticipated);
    } catch (err) {
      console.error('Error loading home data', err);
      setError('Hubo un error al cargar tus encuentros.');
    } finally { setLoading(false); }
  };

  const handleRepeat = (enc: any, e: React.MouseEvent) => {
    e.stopPropagation();
    preloadWizardFromEncuentro(enc, useWizardStore.getState());
    navigate('/create', { state: { autoFocusTitle: true } });
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
      if (enc.estado === 'cancelado') return 'cancelled';
      if (isEncuentroPasado(enc)) return 'finished';
      return 'active';
    };

    const filtered = (encuentros || []).filter(enc => {
      if (!enc) return false;
      const cls = getClasificacion(enc);
      if (filterStatus === 'all') return true;
      return cls === filterStatus;
    });

    const sorted = [...filtered].sort((a, b) => {
      if (sortBy === 'date_upcoming') {
        const dateA = new Date(`${a.fecha || ''}T${a.hora || ''}`).getTime();
        const dateB = new Date(`${b.fecha || ''}T${b.hora || ''}`).getTime();
        return (isNaN(dateA) ? 0 : dateA) - (isNaN(dateB) ? 0 : dateB);
      }
      if (sortBy === 'date_distant') {
        const dateA = new Date(`${a.fecha || ''}T${a.hora || ''}`).getTime();
        const dateB = new Date(`${b.fecha || ''}T${b.hora || ''}`).getTime();
        return (isNaN(dateB) ? 0 : dateB) - (isNaN(dateA) ? 0 : dateA);
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
        const dateA = new Date(`${a.fecha || ''}T${a.hora || ''}`).getTime();
        const dateB = new Date(`${b.fecha || ''}T${b.hora || ''}`).getTime();
        return (isNaN(dateB) ? 0 : dateB) - (isNaN(dateA) ? 0 : dateA);
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
              onClick={() => { sessionStorage.removeItem('cancel_reference'); resetWizard(); navigate('/create', { state: { autoFocusTitle: true } }); }}
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
        {activeTab === 'upcoming' && showAnonNudge && (
          <div className="home-banner">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <p className="home-banner-title">
                  {t('account.save_meetings_title', 'Guardá tus encuentros')}
                </p>
                <p className="home-banner-desc">
                  {t('account.save_meetings_desc', 'Iniciá sesión para acceder desde otros dispositivos.')}
                </p>
              </div>
            </div>
            
            <div className="home-banner-actions">
              <Button
                variant="primary"
                size="sm"
                onClick={() => signInWithGoogle()}
              >
                <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden="true" style={{ marginRight: 6 }}>
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                {t('account.continue_google', 'Continuar con Google')}
              </Button>
              <button
                className="home-banner-btn-secondary"
                onClick={() => {
                  setLinkDismissed(true);
                  setShowHint(true);
                  setTimeout(() => setShowHint(false), 4000);
                }}
              >
                {t('account.not_now', 'Ahora no')}
              </button>
            </div>
          </div>
        )}

        {/* Banner B: Usuario logueado + encuentros locales sin vincular (Vinculación) */}
        {activeTab === 'upcoming' && hasAnonymous && (
          <div className="home-banner">
            <p className="home-banner-title">
              {t('account.link_title', 'Guardá tus encuentros en tu cuenta')}
            </p>
            <p className="home-banner-desc">
              {t('account.link_banner', 'Tenés encuentros creados en este dispositivo. Guardálos para acceder desde otros dispositivos.')}
            </p>
            {linkError && (
              <p className="home-banner-error">
                {linkError}
              </p>
            )}
            <div className="home-banner-actions">
              <Button
                variant="primary"
                size="sm"
                onClick={handleLinkEncuentros}
                disabled={linking}
              >
                {linking ? '…' : t('account.link_action', 'Guardar en mi cuenta')}
              </Button>
              <button
                className="home-banner-btn-secondary"
                onClick={() => { 
                  setLinkDismissed(true); 
                  setLinkError(null); 
                  setShowHint(true);
                  setTimeout(() => setShowHint(false), 4000);
                }}
                disabled={linking}
              >
                {t('account.link_later', 'Ahora no')}
              </button>
            </div>
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
                      navigate(`/invite/${enc._mi_token_invitacion}`);
                    } else {
                      navigate(`/meet/${enc.id}`);
                    }
                  }}
                  participantesCache={activeScope === 'organizo' ? (detailCache[enc.id]?.participantes ?? null) : null}
                  miEstado={activeScope === 'participo' ? (enc._mi_estado ?? null) : null}
                  counts={counts[enc.id] ?? null}
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
                  onClick={() => { resetWizard(); navigate('/create', { state: { autoFocusTitle: true } }); }}
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
                      navigate(`/invite/${enc._mi_token_invitacion}`);
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
    <ScreenContainer style={{ background: 'var(--color-background)' }}>
      <header className="home-header">
        <div>
          <h1 className="home-header-title">
            Tus encuentros
          </h1>
          <p className="home-header-subtitle">
            {totalProximos} próximo{totalProximos !== 1 ? 's' : ''} • {totalPasados} anterior{totalPasados !== 1 ? 'es' : ''}
          </p>
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
          <button
            onClick={() => setIsFilterOpen(true)}
            className="home-header-icon-btn"
            style={{
              color: filterStatus !== 'all' || sortBy !== 'date_upcoming' ? 'var(--color-primary)' : 'var(--color-on-surface)'
            }}
          >
            <Sliders size={20} />
          </button>

          {/* Botón de información */}
          <button
            onClick={() => setIsInfoOpen(true)}
            className="home-header-icon-btn"
          >
            <MoreVertical size={20} />
          </button>
        </div>
      </header>

      <InfoSheet isOpen={isInfoOpen} onClose={() => setIsInfoOpen(false)} />

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
      
      <FilterSheet isOpen={isFilterOpen} onClose={() => setIsFilterOpen(false)} />
      <AccountSheet isOpen={isAccountOpen} onClose={() => setIsAccountOpen(false)} />

      {/* Hint Toast */}
      {showHint && (
        <div className="home-hint">
          {t('account.login_later_hint', 'Podés iniciar sesión más tarde desde el ícono de cuenta.')}
        </div>
      )}
      
      {/* FAB Botón Crear */}
      {!loading && encuentros && encuentros.length > 0 && (
        <div className="home-fab-container">
          <div className="home-fab-wrapper">
            <button
              onClick={() => { sessionStorage.removeItem('cancel_reference'); resetWizard(); navigate('/create', { state: { autoFocusTitle: true } }); }}
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
    </ScreenContainer>
  );
};

export default Home;
