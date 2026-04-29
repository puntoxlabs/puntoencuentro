import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Calendar, Sliders } from 'lucide-react';
import { FilterSheet } from '@/components/ui/FilterSheet';
import { encuentrosService } from '@/services/encuentrosService';
import { getHostId } from '@/lib/auth';
import { formatFriendlyDate } from '@/lib/formatDate';
import { useHomeStore } from '@/store/homeStore';
import { useWizardStore } from '@/store/wizardStore';
import { useDetailStore } from '@/store/detailStore';
import { themes } from '@/lib/themes';
import type { ThemeId } from '@/lib/themes';
import throttle from 'lodash/throttle';

/** Devuelve true si la fecha+hora del encuentro ya pasó */
function isEncuentroPasado(enc: any): boolean {
  if (!enc.fecha || !enc.hora) return false;
  const fechaHora = new Date(`${enc.fecha}T${enc.hora}`);
  fechaHora.setHours(fechaHora.getHours() + 2); // 2 hours grace period like DetailHost
  return fechaHora < new Date();
}

/** Obtiene el color primario del tema del encuentro */
function getEncuentroPrimaryColor(enc: any): string {
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
  const accentColor = getEncuentroPrimaryColor(enc);
  const confirmados = participantesCache?.filter((p: any) => p.estado === 'confirmado').length ?? null;
  const total = participantesCache?.length ?? null;

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
  const isCancelled = enc.estado === 'cancelado';
  const accentColor = getEncuentroPrimaryColor(enc);
  const confirmados = participantesCache?.filter((p: any) => p.estado === 'confirmado').length ?? null;
  const total = participantesCache?.length ?? null;

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
  const navigate = useNavigate();
  const { encuentros: cachedEncuentros, getValidCache, scrollPosition, setEncuentros, setScrollPosition, filterStatus, sortBy } = useHomeStore();
  const wizardStore = useWizardStore();
  const { reset: resetWizard } = wizardStore;
  const detailCache = useDetailStore(s => s.cache);
  const validCache = getValidCache();
  const [encuentros, setLocalEncuentros] = useState<any[]>(validCache || cachedEncuentros);
  const [loading, setLoading] = useState(!validCache);
  const [error, setError] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  useEffect(() => {
    loadData();
    if (scrollPosition > 0) {
      requestAnimationFrame(() => {
        const container = document.getElementById('home-scroll-container');
        if (container) container.scrollTop = scrollPosition;
      });
    }
  }, []);

  const handleScroll = throttle((e: React.UIEvent<HTMLDivElement>) => {
    setScrollPosition(e.currentTarget.scrollTop);
  }, 200);

  const loadData = async () => {
    try {
      const isCacheValid = useHomeStore.getState().getValidCache() !== null;
      if (!isCacheValid) setLoading(true);
      setError(null);
      const hostId = getHostId();
      const data = await encuentrosService.getEncuentrosByHost(hostId);
      const sortedData = (data || []).sort((a, b) => {
        const dateA = new Date(`${a.fecha}T${a.hora}`);
        const dateB = new Date(`${b.fecha}T${b.hora}`);
        return dateA.getTime() - dateB.getTime();
      });
      setLocalEncuentros(sortedData);
      setEncuentros(sortedData);
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
      const cls = getClasificacion(enc);
      if (filterStatus === 'all') return true;
      return cls === filterStatus;
    });

    const sorted = [...filtered].sort((a, b) => {
      if (sortBy === 'date_upcoming') {
        const dateA = new Date(`${a.fecha}T${a.hora}`).getTime();
        const dateB = new Date(`${b.fecha}T${b.hora}`).getTime();
        return dateA - dateB;
      }
      if (sortBy === 'date_distant') {
        const dateA = new Date(`${a.fecha}T${a.hora}`).getTime();
        const dateB = new Date(`${b.fecha}T${b.hora}`).getTime();
        return dateB - dateA;
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

    // Estado vacío total
    if (encuentros.length === 0) return (
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
          Todavía no tenés encuentros<br />programados 👇
        </h2>
        <p style={{
          fontSize: 15, color: '#6B7280',
          textAlign: 'center', margin: '0 0 32px', lineHeight: 1.5,
        }}>
          Organizá algo en segundos y empezá<br />a coordinar con otros
        </p>
        <Button
          variant="primary"
          fullWidth
          style={{ height: 56, fontSize: 16, fontWeight: 700 }}
          onClick={() => { resetWizard(); navigate('/create'); }}
        >
          + Crear encuentro
        </Button>
      </div>
    );

    const hasNoPending = proximos.length === 0 && pasados.length > 0;

    return (
      <div
        id="home-scroll-container"
        onScroll={handleScroll}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingBottom: 24, paddingTop: 16 }}
      >
        {/* Header de contadores con Chips */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <div style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.06)', borderRadius: 12, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.02)' }}>
             <span style={{ fontSize: 15 }}>🗓️</span>
             <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Próximos: <span style={{ color: 'var(--color-primary)' }}>{proximos.length}</span></span>
          </div>
          <div style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.06)', borderRadius: 12, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.02)' }}>
             <span style={{ fontSize: 15 }}>🕒</span>
             <span style={{ fontSize: 13, fontWeight: 700, color: '#6B7280' }}>Anteriores: {pasados.length}</span>
          </div>
        </div>

        {/* Encuentros próximos */}
        {proximos.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: pasados.length > 0 ? 36 : 0 }}>
            {proximos.map(enc => (
              <ActiveCard
                key={enc.id}
                enc={enc}
                onClick={() => navigate(`/meet/${enc.id}`)}
                participantesCache={detailCache[enc.id]?.participantes ?? null}
              />
            ))}
          </div>
        )}

        {/* Banner "sin próximos" cuando hay historial */}
        {hasNoPending && (
          <div style={{
            background: '#fff',
            borderLeft: '4px solid var(--color-primary)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
            borderRadius: 16,
            padding: '20px',
            marginBottom: 36,
            display: 'flex', alignItems: 'center', gap: 16,
          }}>
            <div style={{ width: 44, height: 44, borderRadius: 22, background: 'var(--color-primary-container)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
               <Calendar size={22} color="var(--color-primary)" />
            </div>
            <div>
              <p style={{ margin: 0, fontWeight: 800, fontSize: 15, color: '#111827' }}>
                No tenés encuentros próximos
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6B7280', fontWeight: 500 }}>
                Repetí uno anterior o creá uno nuevo
              </p>
            </div>
          </div>
        )}

        {/* Encuentros anteriores */}
        {pasados.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {/* Separador con título */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <p style={{
                fontSize: 13, fontWeight: 800,
                color: '#6B7280',
                textTransform: 'uppercase', letterSpacing: '0.08em',
                margin: 0, whiteSpace: 'nowrap',
              }}>
                Tus encuentros anteriores
              </p>
              <div style={{ flex: 1, height: 1, background: 'rgba(0,0,0,0.06)' }} />
            </div>

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
          </div>
        )}
      </div>
    );
  };

  return (
    <ScreenContainer style={{ background: '#F4F6FB' }}>
      <AppBar 
        title="Mis Encuentros" 
        subtitle="Organizá y gestioná tus encuentros" 
        rightAction={
          <button
            onClick={() => setIsFilterOpen(true)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 36, height: 36, borderRadius: '50%',
              color: filterStatus !== 'all' || sortBy !== 'date_upcoming' ? 'var(--color-primary)' : 'var(--color-on-surface)'
            }}
          >
            <Sliders size={20} />
          </button>
        }
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '0 20px', overflow: 'hidden' }}>
        {renderContent()}
      </div>
      
      <FilterSheet isOpen={isFilterOpen} onClose={() => setIsFilterOpen(false)} />
      
      {/* Botón crear — siempre visible en el fold */}
      {!loading && encuentros.length > 0 && (
        <div style={{ padding: '16px 20px', background: '#F4F6FB', borderTop: '1px solid rgba(0,0,0,0.03)' }}>
          <Button fullWidth variant="primary" style={{ height: 56, fontSize: 16, fontWeight: 700, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }} onClick={() => { resetWizard(); navigate('/create'); }}>
            + Crear encuentro
          </Button>
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
