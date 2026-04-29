import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Calendar } from 'lucide-react';
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
        borderRadius: 18,
        padding: '18px 18px 16px',
        border: '1px solid rgba(0,0,0,0.06)',
        boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
        cursor: 'pointer',
        transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        position: 'relative',
        overflow: 'hidden',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 8px 24px rgba(0,0,0,0.10)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.transform = '';
        (e.currentTarget as HTMLDivElement).style.boxShadow = '0 2px 12px rgba(0,0,0,0.06)';
      }}
    >
      {/* Acento lateral de color del tema */}
      <div style={{
        position: 'absolute', left: 0, top: 10, bottom: 10,
        width: 4, borderRadius: '0 3px 3px 0',
        background: accentColor,
      }} />

      <div style={{ paddingLeft: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, flex: 1, marginRight: 8, lineHeight: 1.3 }}>
            {enc.titulo}
          </h3>
          <Badge label="Activo" status="confirmed" />
        </div>

        <p style={{ margin: '0 0 10px 0', fontSize: 13, color: 'var(--color-on-surface-variant)' }}>
          📅 {formatFriendlyDate(enc.fecha, enc.hora)}
        </p>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Badge
            label={enc.modalidad === 'presencial' ? '🤝 Presencial' : '💻 Virtual'}
            status="default"
          />
          {total !== null && (
            <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
              {confirmados !== null && confirmados > 0
                ? `${confirmados} confirmado${confirmados !== 1 ? 's' : ''} · ${total} total`
                : `${total} invitado${total !== 1 ? 's' : ''}`}
            </span>
          )}
        </div>
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
        background: '#f7f7f8',
        borderRadius: 16,
        padding: '14px 16px 12px',
        border: '1px solid rgba(0,0,0,0.055)',
        cursor: 'pointer',
        transition: 'background 0.15s ease',
        position: 'relative',
        overflow: 'hidden',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLDivElement).style.background = '#f0f0f2';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLDivElement).style.background = '#f7f7f8';
      }}
    >
      {/* Acento lateral sutil con color del tema */}
      <div style={{
        position: 'absolute', left: 0, top: 8, bottom: 8,
        width: 3, borderRadius: '0 2px 2px 0',
        background: accentColor,
        opacity: 0.35,
      }} />

      <div style={{ paddingLeft: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <h3 style={{
            margin: 0, fontSize: 15, fontWeight: 600, flex: 1, marginRight: 8,
            color: '#333', lineHeight: 1.3,
          }}>
            {enc.titulo}
          </h3>
          <Badge
            label={isCancelled ? 'Cancelado' : 'Finalizado'}
            status={isCancelled ? 'rejected' : 'default'}
          />
        </div>

        <p style={{ margin: '0 0 10px 0', fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
          📅 {formatFriendlyDate(enc.fecha, enc.hora)}
        </p>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Badge
              label={enc.modalidad === 'presencial' ? '🤝 Presencial' : '💻 Virtual'}
              status="default"
            />
            {total !== null && (
              <span style={{ fontSize: 11, color: 'var(--color-on-surface-variant)', opacity: 0.8 }}>
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
              background: 'none',
              border: `1.5px solid ${accentColor}`,
              borderRadius: 8,
              padding: '4px 10px',
              cursor: 'pointer',
              fontFamily: 'var(--font-family)',
              fontSize: 12,
              fontWeight: 600,
              color: accentColor,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={e => {
              e.stopPropagation();
              (e.currentTarget as HTMLButtonElement).style.background = `${accentColor}14`;
            }}
            onMouseLeave={e => {
              e.stopPropagation();
              (e.currentTarget as HTMLButtonElement).style.background = 'none';
            }}
          >
            🔁 Repetir
          </button>
        </div>
      </div>
    </div>
  );
};

/* ─── Pantalla principal ─────────────────────────────────────────────────── */
const Home: React.FC = () => {
  const navigate = useNavigate();
  const { encuentros: cachedEncuentros, getValidCache, scrollPosition, setEncuentros, setScrollPosition } = useHomeStore();
  const wizardStore = useWizardStore();
  const { reset: resetWizard } = wizardStore;
  const detailCache = useDetailStore(s => s.cache);
  const validCache = getValidCache();
  const [encuentros, setLocalEncuentros] = useState<any[]>(validCache || cachedEncuentros);
  const [loading, setLoading] = useState(!validCache);
  const [error, setError] = useState<string | null>(null);

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
        <p style={{ color: 'var(--color-on-surface-variant)' }}>Cargando encuentros…</p>
      </div>
    );

    if (error) return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <p>{error}</p>
        <Button variant="outline" onClick={loadData}>Reintentar</Button>
      </div>
    );

    // Separar: activos/futuros vs pasados (incluyendo cancelados)
    const proximos = encuentros.filter(enc => enc.estado !== 'cancelado' && !isEncuentroPasado(enc));
    const pasados = encuentros.filter(enc => enc.estado === 'cancelado' || isEncuentroPasado(enc));

    // Estado vacío total
    if (encuentros.length === 0) return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '20px 0', gap: 0,
      }}>
        <div style={{
          width: 72, height: 72, borderRadius: 24,
          background: 'var(--color-primary-container)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginBottom: 20,
        }}>
          <Calendar size={36} color="var(--color-primary)" />
        </div>
        <h2 style={{
          fontSize: 20, fontWeight: 800, textAlign: 'center',
          margin: '0 0 8px', lineHeight: 1.3,
        }}>
          Todavía no tenés encuentros<br />programados 👇
        </h2>
        <p style={{
          fontSize: 14, color: 'var(--color-on-surface-variant)',
          textAlign: 'center', margin: '0 0 28px', lineHeight: 1.5,
        }}>
          Organizá algo en segundos y empezá<br />a coordinar con otros
        </p>
        <Button
          variant="primary"
          fullWidth
          onClick={() => { resetWizard(); navigate('/create'); }}
        >
          + Crear encuentro
        </Button>
      </div>
    );

    // Sin próximos pero con historial
    const hasNoPending = proximos.length === 0 && pasados.length > 0;

    return (
      <div
        id="home-scroll-container"
        onScroll={handleScroll}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingBottom: 8 }}
      >
        {/* Contador resumen */}
        <p style={{
          fontSize: 12, color: 'var(--color-on-surface-variant)',
          margin: '0 0 16px 2px', fontWeight: 500,
        }}>
          {proximos.length} próximo{proximos.length !== 1 ? 's' : ''} · {pasados.length} anterior{pasados.length !== 1 ? 'es' : ''}
        </p>

        {/* Encuentros próximos */}
        {proximos.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: pasados.length > 0 ? 32 : 0 }}>
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
            background: 'var(--color-primary-container)',
            borderRadius: 16,
            padding: '18px 20px',
            marginBottom: 28,
            display: 'flex', alignItems: 'center', gap: 14,
          }}>
            <Calendar size={28} color="var(--color-primary)" style={{ flexShrink: 0 }} />
            <div>
              <p style={{ margin: 0, fontWeight: 700, fontSize: 15, color: 'var(--color-primary-dark)' }}>
                No tenés encuentros próximos
              </p>
              <p style={{ margin: '3px 0 0', fontSize: 13, color: 'var(--color-on-surface-variant)' }}>
                Repetí uno anterior o creá uno nuevo
              </p>
            </div>
          </div>
        )}

        {/* Encuentros anteriores */}
        {pasados.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {/* Separador con título */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <p style={{
                fontSize: 12, fontWeight: 700,
                color: 'var(--color-on-surface-variant)',
                textTransform: 'uppercase', letterSpacing: '0.07em',
                margin: 0, whiteSpace: 'nowrap',
              }}>
                Tus encuentros anteriores
              </p>
              <div style={{
                flex: 1, height: 1,
                background: 'rgba(0,0,0,0.07)',
                borderRadius: 1,
              }} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
    <ScreenContainer>
      <AppBar title="Mis Encuentros" />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', paddingTop: 16, gap: 16 }}>
        {renderContent()}
      </div>
      {/* Botón crear — siempre visible en el fold */}
      {!loading && encuentros.length > 0 && (
        <div style={{ paddingTop: 12 }}>
          <Button fullWidth variant="primary" onClick={() => { resetWizard(); navigate('/create'); }}>
            + Crear encuentro
          </Button>
        </div>
      )}
      <div style={{ textAlign: 'center', paddingTop: 10, paddingBottom: 4 }}>
        <span style={{ fontSize: 10, color: 'var(--color-on-surface-variant)', opacity: 0.4 }}>
          Build: {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'Local'}
        </span>
      </div>
    </ScreenContainer>
  );
};

export default Home;
