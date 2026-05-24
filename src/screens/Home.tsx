import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Calendar, Sliders, Plus, User } from 'lucide-react';
import { FilterSheet } from '@/components/ui/FilterSheet';
import { AccountSheet } from '@/components/ui/AccountSheet';
import { encuentrosService } from '@/services/encuentrosService';
import { getHostId } from '@/lib/auth';
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

/* ─── Componente de card activa ─────────────────────────────────────────── */
const ActiveCard: React.FC<{
  enc: any;
  onClick: () => void;
  participantesCache: any[] | null;
}> = ({ enc, onClick, participantesCache }) => {
  if (!enc) return null;
  const accentColor = getEncuentroPrimaryColor(enc);
  const confirmados = (participantesCache || []).filter((p: any) => p && p.estado === 'confirmado').length;
  const total = (participantesCache || []).length;

  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff',
        borderRadius: 16,
        padding: '20px',
        border: '1px solid rgba(0,0,0,0.04)',
        borderLeft: `5px solid ${accentColor}`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
        cursor: 'pointer',
        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-3px)';
        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 6px 16px rgba(0,0,0,0.08)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.05)';
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 19, fontWeight: 700, flex: 1, marginRight: 8, lineHeight: 1.25, color: '#111827' }}>
          {enc.titulo}
        </h3>
        <Badge label="Activo" status="confirmed" />
      </div>

      <p style={{ margin: '0 0 14px 0', fontSize: 14, color: '#6B7280', fontWeight: 500 }}>
        📅 {formatFriendlyDate(enc.fecha, enc.hora)}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ background: '#F3F4F6', color: '#4B5563', padding: '4px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600 }}>
          {enc.modalidad === 'presencial' ? '🤝 Presencial' : '💻 Virtual'}
        </div>
        
        {total !== null && (
          <span style={{ fontSize: 13, color: '#6B7280', fontWeight: 500 }}>
            {confirmados !== null && confirmados > 0
              ? `${confirmados} confirmado${confirmados !== 1 ? 's' : ''}`
              : `${total} invitado${total !== 1 ? 's' : ''}`}
          </span>
        )}
      </div>
    </div>
  );
};

/* ─── Componente de card pasada ─────────────────────────────────────────── */
const PastCard: React.FC<{
  enc: any;
  onClick: () => void;
  onRepeat: (e: React.MouseEvent) => void;
  participantesCache: any[] | null;
}> = ({ enc, onClick, onRepeat, participantesCache }) => {
  if (!enc) return null;
  const isCancelled = enc.estado === 'cancelado';
  const accentColor = getEncuentroPrimaryColor(enc);
  const confirmados = (participantesCache || []).filter((p: any) => p && p.estado === 'confirmado').length;
  const total = (participantesCache || []).length;

  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff',
        borderRadius: 16,
        padding: '20px',
        border: '1px solid rgba(0,0,0,0.04)',
        borderLeft: `4px solid ${accentColor}66`, // opacity in hex
        boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
        cursor: 'pointer',
        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 6px 16px rgba(0,0,0,0.06)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.04)';
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1, marginRight: 8, color: '#374151', lineHeight: 1.3 }}>
          {enc.titulo}
        </h3>
        {isCancelled ? (
          <Badge label="Cancelado" status="rejected" />
        ) : (
          <div style={{ background: '#EEF1F5', color: '#6B7280', padding: '4px 12px', borderRadius: 9999, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Finalizado
          </div>
        )}
      </div>

      <p style={{ margin: '0 0 16px 0', fontSize: 13, color: '#6B7280', fontWeight: 500 }}>
        📅 {formatFriendlyDate(enc.fecha, enc.hora)}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ background: '#F3F4F6', color: '#6B7280', padding: '4px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600 }}>
            {enc.modalidad === 'presencial' ? '🤝 Presencial' : '💻 Virtual'}
          </div>
          {total !== null && (
            <span style={{ fontSize: 12, color: '#9CA3AF', fontWeight: 500 }}>
              {confirmados !== null && confirmados > 0
                ? `${confirmados} confirmado${confirmados !== 1 ? 's' : ''}`
                : `${total} invitado${total !== 1 ? 's' : ''}`}
            </span>
          )}
        </div>

        {/* Botón Repetir */}
        <button
          onClick={onRepeat}
          style={{
            background: `${accentColor}10`, // very light background
            border: 'none',
            borderRadius: 10,
            padding: '8px 14px',
            cursor: 'pointer',
            fontFamily: 'var(--font-family)',
            fontSize: 13,
            fontWeight: 700,
            color: accentColor,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            transition: 'background 0.2s ease, transform 0.1s ease',
          }}
          onMouseEnter={e => {
            e.stopPropagation();
            (e.currentTarget as HTMLButtonElement).style.background = `${accentColor}20`;
            (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)';
          }}
          onMouseLeave={e => {
            e.stopPropagation();
            (e.currentTarget as HTMLButtonElement).style.background = `${accentColor}10`;
            (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
          }}
          onMouseDown={e => {
             e.stopPropagation();
             (e.currentTarget as HTMLButtonElement).style.transform = 'scale(0.96)';
          }}
          onMouseUp={e => {
             e.stopPropagation();
             (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)';
          }}
        >
          🔁 Repetir encuentro
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
  const [loading, setLoading] = useState(!validCache);
  const [error, setError] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'upcoming' | 'past'>('upcoming');
  const [activeScope, setActiveScope] = useState<'organizo' | 'participo'>('organizo');
  const [linking, setLinking] = useState(false);
  const [linkDismissed, setLinkDismissed] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);
  const [showHint, setShowHint] = useState(false);

  // Estados locales para las dos listas
  const [organizedEncuentros, setOrganizedEncuentros] = useState<any[]>(validCache || []);
  const [participatedEncuentros, setParticipatedEncuentros] = useState<any[]>([]);

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
      if (!isCacheValid) setLoading(true);
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
      } else {
        // Anónimo: solo organizados del UUID local
        organized = await encuentrosService.getEncuentrosByHost(anonId);
      }

      const sortList = (list: any[]) => (list || []).filter(e => e && e.id).sort((a, b) => {
        const dateA = new Date(`${a.fecha || ''}T${a.hora || ''}`).getTime();
        const dateB = new Date(`${b.fecha || ''}T${b.hora || ''}`).getTime();
        return (isNaN(dateA) ? 0 : dateA) - (isNaN(dateB) ? 0 : dateB);
      });

      const sortedOrganized = sortList(organized);
      const sortedParticipated = sortList(participated);

      setOrganizedEncuentros(sortedOrganized);
      setParticipatedEncuentros(sortedParticipated);
      
      // Actualizar el store global (principalmente para la lista de organizados que es la principal)
      setEncuentros(sortedOrganized);
    } catch (err) {
      console.error('Error loading home data', err);
      setError('Hubo un error al cargar tus encuentros.');
    } finally { setLoading(false); }
  };

  const handleRepeat = (enc: any, e: React.MouseEvent) => {
    e.stopPropagation();
    preloadWizardFromEncuentro(enc, useWizardStore.getState());
    navigate('/create');
  };

  const renderContent = () => {
    if (loading) return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#6B7280', fontWeight: 500 }}>Cargando encuentros…</p>
      </div>
    );

    if (error) return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <p style={{ color: '#DC2626', fontWeight: 500 }}>{error}</p>
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
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '20px 0', gap: 0,
        }}>
          <div style={{
            width: 80, height: 80, borderRadius: 28,
            background: 'var(--color-primary-container)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 24,
          }}>
            <Calendar size={40} color="var(--color-primary)" />
          </div>
          <h2 style={{
            fontSize: 22, fontWeight: 800, textAlign: 'center',
            margin: '0 0 12px', lineHeight: 1.3, color: '#111827'
          }}>
            {isOrganizo 
              ? 'Todavía no organizaste encuentros'
              : 'Todavía no tenés invitaciones confirmadas'}
          </h2>
          <p style={{
            fontSize: 15, color: '#6B7280',
            textAlign: 'center', margin: '0 0 32px', lineHeight: 1.5,
          }}>
            {isOrganizo
              ? 'Creá uno nuevo para coordinar con otros.'
              : 'Cuando confirmes asistencia, aparecerán acá.'}
          </p>
          {isOrganizo && (
            <Button
              variant="primary"
              fullWidth
              style={{ height: 56, fontSize: 16, fontWeight: 700 }}
              onClick={() => { resetWizard(); navigate('/create'); }}
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
        className={slideClass}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingBottom: 80, paddingTop: 16 }}
      >
        <style dangerouslySetInnerHTML={{__html: `
          @keyframes slideFromLeft {
            from { transform: translateX(-20px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
          @keyframes slideFromRight {
            from { transform: translateX(20px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
          .slide-from-left { animation: slideFromLeft 0.25s cubic-bezier(0.25, 0.8, 0.25, 1) forwards; }
          .slide-from-right { animation: slideFromRight 0.25s cubic-bezier(0.25, 0.8, 0.25, 1) forwards; }
        `}} />

        {/* Banner A: Usuario NO logueado + encuentros locales (Nudge Login) */}
        {activeTab === 'upcoming' && showAnonNudge && (
          <div style={{
            background: '#fff',
            borderRadius: 14,
            padding: '12px 16px',
            marginBottom: 16,
            border: '1px solid rgba(var(--color-primary-rgb), 0.15)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            animation: 'fadeIn 0.5s ease-out',
            boxShadow: '0 2px 6px rgba(0,0,0,0.02)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--color-primary)', lineHeight: 1.2 }}>
                  {t('account.save_meetings_title', 'Guardá tus encuentros')}
                </p>
                <p style={{ margin: '2px 0 0 0', fontSize: 12, color: '#6B7280', lineHeight: 1.4 }}>
                  {t('account.save_meetings_desc', 'Iniciá sesión para acceder desde otros dispositivos.')}
                </p>
              </div>
            </div>
            
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 2 }}>
              <Button
                variant="primary"
                size="sm"
                onClick={() => signInWithGoogle()}
                style={{ 
                  padding: '0 12px', 
                  height: 32, 
                  fontSize: 12, 
                  borderRadius: 8,
                  fontWeight: 600
                }}
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
                onClick={() => {
                  setLinkDismissed(true);
                  setShowHint(true);
                  setTimeout(() => setShowHint(false), 4000);
                }}
                style={{ 
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: '#9CA3AF', 
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  textUnderlineOffset: '2px'
                }}
              >
                {t('account.not_now', 'Ahora no')}
              </button>
            </div>
          </div>
        )}

        {/* Banner B: Usuario logueado + encuentros locales sin vincular (Vinculación) */}
        {activeTab === 'upcoming' && hasAnonymous && (
          <div style={{
            background: '#fff',
            borderRadius: 14,
            padding: '12px 16px',
            marginBottom: 16,
            border: '1px solid rgba(var(--color-primary-rgb), 0.15)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            animation: 'fadeIn 0.5s ease-out',
            boxShadow: '0 2px 6px rgba(0,0,0,0.02)'
          }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--color-primary)', lineHeight: 1.2 }}>
              {t('account.link_title', 'Guardá tus encuentros en tu cuenta')}
            </p>
            <p style={{ margin: '2px 0 0 0', fontSize: 12, color: '#6B7280', lineHeight: 1.4 }}>
              {t('account.link_banner', 'Tenés encuentros creados en este dispositivo. Guardálos para acceder desde otros dispositivos.')}
            </p>
            {linkError && (
              <p style={{ margin: 0, fontSize: 11, color: 'var(--color-error, #dc2626)', fontWeight: 600 }}>
                {linkError}
              </p>
            )}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 2 }}>
              <Button
                variant="primary"
                size="sm"
                onClick={handleLinkEncuentros}
                disabled={linking}
                style={{ 
                  padding: '0 12px', 
                  height: 32, 
                  fontSize: 12, 
                  borderRadius: 8,
                  fontWeight: 600
                }}
              >
                {linking ? '…' : t('account.link_action', 'Guardar en mi cuenta')}
              </Button>
              <button
                onClick={() => { 
                  setLinkDismissed(true); 
                  setLinkError(null); 
                  setShowHint(true);
                  setTimeout(() => setShowHint(false), 4000);
                }}
                disabled={linking}
                style={{ 
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: '#9CA3AF', 
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  textUnderlineOffset: '2px',
                  opacity: linking ? 0.5 : 1
                }}
              >
                {t('account.link_later', 'Ahora no')}
              </button>
            </div>
          </div>
        )}

        {activeTab === 'upcoming' ? (
          proximos.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {proximos.map(enc => (
                <ActiveCard
                  key={enc.id}
                  enc={enc}
                  onClick={() => navigate(`/meet/${enc.id}`)}
                  participantesCache={detailCache[enc.id]?.participantes ?? null}
                />
              ))}
            </div>
          ) : (
            <div style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              padding: '40px 20px',
            }}>
              <div style={{
                width: 80, height: 80, borderRadius: 28,
                background: 'var(--color-primary-container)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: 24,
              }}>
                <Calendar size={32} color="var(--color-primary)" />
              </div>
              <h2 style={{
                fontSize: 22, fontWeight: 800, textAlign: 'center',
                margin: '0 0 12px', lineHeight: 1.3, color: '#111827'
              }}>
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
                  onClick={() => { resetWizard(); navigate('/create'); }}
                >
                  + Crear encuentro
                </Button>
              )}
            </div>
          )
        ) : (
          pasados.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {pasados.map(enc => (
                <PastCard
                  key={enc.id}
                  enc={enc}
                  onClick={() => navigate(`/meet/${enc.id}`)}
                  onRepeat={(e) => handleRepeat(enc, e)}
                  participantesCache={detailCache[enc.id]?.participantes ?? null}
                />
              ))}
            </div>
          ) : (
            <div style={{
              textAlign: 'center', padding: '60px 20px', color: '#6B7280',
              fontSize: 15, fontWeight: 600
            }}>
              No hay encuentros anteriores
            </div>
          )
        )}
      </div>
    );
  };

  return (
    <ScreenContainer style={{ background: '#F4F6FB' }}>
      <header style={{
        background: '#F3F7FF',
        borderBottom: '1px solid #E5E7EB',
        padding: 'calc(20px + env(safe-area-inset-top, 0px)) 16px 16px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 10
      }}>
        <div>
          <h1 style={{
            fontSize: '20px',
            fontWeight: 700,
            color: '#111827',
            letterSpacing: '-0.3px',
            margin: 0
          }}>
            Tus encuentros
          </h1>
          <p style={{
            fontSize: '13px',
            color: '#6B7280',
            margin: '4px 0 0 0'
          }}>
            {totalProximos} próximo{totalProximos !== 1 ? 's' : ''} • {totalPasados} anterior{totalPasados !== 1 ? 'es' : ''}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Botón de perfil/cuenta */}
          <button
            onClick={() => setIsAccountOpen(true)}
            aria-label="Cuenta"
            style={{
              background: user ? 'var(--color-primary)' : '#F3F4F6',
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 36, height: 36, borderRadius: '50%',
              overflow: 'hidden',
              transition: 'background 0.2s ease',
              padding: 0,
            }}
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
              <span style={{ fontSize: 13, fontWeight: 800, color: '#fff', textTransform: 'uppercase' }}>
                {userInitials}
              </span>
            ) : (
              <User size={18} color="#6B7280" />
            )}
          </button>

          {/* Botón de filtros */}
          <button
            onClick={() => setIsFilterOpen(true)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 36, height: 36, borderRadius: '50%',
              color: filterStatus !== 'all' || sortBy !== 'date_upcoming' ? 'var(--color-primary)' : '#111827'
            }}
          >
            <Sliders size={20} />
          </button>
        </div>
      </header>

      {/* A. Selector de Scope: Organizo / Participo (solo si logueado) */}
      {user && (
        <div style={{ padding: '16px 20px 0 20px', background: '#F4F6FB' }}>
          <div style={{
            display: 'flex',
            background: '#E5E7EB',
            padding: 4,
            borderRadius: 14,
            height: 48,
          }}>
            <button
              onClick={() => setActiveScope('organizo')}
              style={{
                flex: 1, border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                background: activeScope === 'organizo' ? '#fff' : 'transparent',
                color: activeScope === 'organizo' ? '#111827' : '#6B7280',
                boxShadow: activeScope === 'organizo' ? '0 2px 4px rgba(0,0,0,0.05)' : 'none',
                transition: 'all 0.2s ease',
              }}
            >
              Organizo
            </button>
            <button
              onClick={() => setActiveScope('participo')}
              style={{
                flex: 1, border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                background: activeScope === 'participo' ? '#fff' : 'transparent',
                color: activeScope === 'participo' ? '#111827' : '#6B7280',
                boxShadow: activeScope === 'participo' ? '0 2px 4px rgba(0,0,0,0.05)' : 'none',
                transition: 'all 0.2s ease',
              }}
            >
              Participo
            </button>
          </div>
        </div>
      )}

      {/* B. Segmented Control Toggle (Próximos / Anteriores) */}
      {!loading && (encuentros.length > 0 || filterStatus !== 'all') && (
        <div style={{ padding: '16px 20px 0 20px', background: '#F4F6FB' }}>
          <div style={{
            background: '#E8EDF8',
            borderRadius: 14,
            padding: 4,
            display: 'flex',
            gap: 4
          }}>
            <button
              onClick={() => setActiveTab('upcoming')}
              style={{
                flex: 1,
                padding: '10px 0',
                borderRadius: 11,
                border: 'none',
                background: activeTab === 'upcoming' ? '#fff' : 'transparent',
                color: activeTab === 'upcoming' ? '#111827' : '#6B7280',
                fontWeight: activeTab === 'upcoming' ? 700 : 600,
                fontSize: 14,
                cursor: 'pointer',
                boxShadow: activeTab === 'upcoming' ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
                transition: 'all 0.2s ease',
                display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6
              }}
            >
              <span>Próximos</span>
              <span style={{
                background: activeTab === 'upcoming' ? 'var(--color-primary-container)' : '#DCE4F2',
                color: activeTab === 'upcoming' ? 'var(--color-primary)' : '#6B7280',
                padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700
              }}>{totalProximos}</span>
            </button>

            <button
              onClick={() => setActiveTab('past')}
              style={{
                flex: 1,
                padding: '10px 0',
                borderRadius: 11,
                border: 'none',
                background: activeTab === 'past' ? '#fff' : 'transparent',
                color: activeTab === 'past' ? '#111827' : '#6B7280',
                fontWeight: activeTab === 'past' ? 700 : 600,
                fontSize: 14,
                cursor: 'pointer',
                boxShadow: activeTab === 'past' ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
                transition: 'all 0.2s ease',
                display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6
              }}
            >
              <span>Anteriores</span>
              <span style={{
                background: activeTab === 'past' ? 'var(--color-primary-container)' : '#DCE4F2',
                color: activeTab === 'past' ? 'var(--color-primary)' : '#6B7280',
                padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700
              }}>{totalPasados}</span>
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
        <div style={{
          position: 'fixed',
          bottom: 100, // Above the "Add" button
          left: 20,
          right: 20,
          background: '#374151',
          color: '#fff',
          padding: '12px 16px',
          borderRadius: 12,
          fontSize: 13,
          fontWeight: 500,
          textAlign: 'center',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          zIndex: 2000,
          animation: 'fadeIn 0.3s ease'
        }}>
          {t('account.login_later_hint', 'Podés iniciar sesión más tarde desde el ícono de cuenta.')}
        </div>
      )}
      
      {/* FAB Botón Crear */}
      {!loading && encuentros && encuentros.length > 0 && (
        <div style={{
          position: 'fixed', bottom: 24, left: 0, right: 0, zIndex: 100,
          display: 'flex', justifyContent: 'center', pointerEvents: 'none'
        }}>
          <div style={{
            width: '100%', maxWidth: 480, display: 'flex', justifyContent: 'flex-end',
            padding: '0 20px'
          }}>
            <button
              onClick={() => { resetWizard(); navigate('/create'); }}
              style={{
                pointerEvents: 'auto',
                height: 56, borderRadius: 28, padding: '0 24px',
                background: 'var(--color-primary)', color: '#fff',
                border: 'none', cursor: 'pointer',
                boxShadow: '0 6px 16px rgba(0,0,0,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                transition: 'transform 0.2s ease',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
              }}
            >
              <Plus size={24} />
              <span style={{ fontSize: 16, fontWeight: 700 }}>Crear</span>
            </button>
          </div>
        </div>
      )}
      {!loading && (
        <div style={{ textAlign: 'center', paddingBottom: 12, background: '#F4F6FB' }}>
          <span style={{ fontSize: 11, color: '#9CA3AF', fontWeight: 500 }}>
            Build: {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'Local'}
          </span>
        </div>
      )}
    </ScreenContainer>
  );
};

export default Home;
