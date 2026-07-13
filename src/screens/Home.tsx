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
import { formatFriendlyDate, isEncuentroPasado as isEncuentroPasadoFormat } from '@/lib/formatDate';
import { useHomeStore } from '@/store/homeStore';
import { useWizardStore } from '@/store/wizardStore';
import { useDetailStore } from '@/store/detailStore';
import { themes } from '@/lib/themes';
import type { ThemeId } from '@/lib/themes';
import { throttle } from 'lodash';
import { useCreateEncounter } from '@/hooks/useCreateEncounter';
import { CreationAccountChoiceSheet } from '@/components/ui/CreationAccountChoiceSheet';

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
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
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
  const [imgError, setImgError] = useState(false);

  // Estados locales para las dos listas
  const [organizedEncuentros, setOrganizedEncuentros] = useState<any[]>(validCache?.organized || staleOrganized || []);
  const [participatedEncuentros, setParticipatedEncuentros] = useState<any[]>(validCache?.participated || staleParticipated || []);
  const [counts, setCounts] = useState<Record<string, { total: number; confirmados: number }>>({});

  // Los encuentros "visibles" dependen del scope activo
  const encuentros = activeScope === 'organizo' ? organizedEncuentros : participatedEncuentros;



  const { startFixedEncounter, choiceSheetProps } = useCreateEncounter();

  const isAnonymousUser = user?.is_anonymous === true;

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

      const sortList = (list: any[]) => (list || []).filter(e => e && e.id).sort((a, b) => {
        const dateA = new Date(`${a.fecha || ''}T${a.hora || ''}`).getTime();
        const dateB = new Date(`${b.fecha || ''}T${b.hora || ''}`).getTime();
        return (isNaN(dateA) ? 0 : dateA) - (isNaN(dateB) ? 0 : dateB);
      });

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
              onClick={() => { sessionStorage.removeItem('cancel_reference'); resetWizard(); startFixedEncounter(); }}
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
                  onClick={() => { resetWizard(); startFixedEncounter(); }}
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
      
      {/* Bottom Sheets */}
      <FilterSheet isOpen={isFilterOpen} onClose={() => setIsFilterOpen(false)} />
      <AccountSheet isOpen={isAccountOpen} onClose={() => setIsAccountOpen(false)} />
      <InfoSheet isOpen={isInfoOpen} onClose={() => setIsInfoOpen(false)} />
      <CreationAccountChoiceSheet {...choiceSheetProps} />
      
      {/* FAB Botón Crear */}
      {!loading && encuentros && encuentros.length > 0 && (
        <div className="home-fab-container">
          <div className="home-fab-wrapper">
            <button
              onClick={() => { sessionStorage.removeItem('cancel_reference'); resetWizard(); startFixedEncounter(); }}
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
