import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Calendar } from 'lucide-react';
import { encuentrosService } from '@/services/encuentrosService';
import { getHostId } from '@/lib/auth';
import { formatFriendlyDate } from '@/lib/formatDate';
import { useHomeStore } from '@/store/homeStore';
import { useWizardStore } from '@/store/wizardStore';
import throttle from 'lodash/throttle';

/** Devuelve true si la fecha+hora del encuentro ya pasó */
function isEncuentroPasado(enc: any): boolean {
  if (!enc.fecha || !enc.hora) return false;
  const fechaHora = new Date(`${enc.fecha}T${enc.hora}`);
  return fechaHora < new Date();
}

const Home: React.FC = () => {
  const navigate = useNavigate();
  const { encuentros: cachedEncuentros, getValidCache, scrollPosition, setEncuentros, setScrollPosition } = useHomeStore();
  const { reset: resetWizard } = useWizardStore();
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

  const renderCard = (enc: any, isPast: boolean) => {
    const isCancelled = enc.estado === 'cancelado';
    const cardOpacity = isPast ? 0.6 : 1;

    let badgeLabel: string;
    let badgeStatus: 'confirmed' | 'rejected' | 'default' | 'pending';

    if (isCancelled) {
      badgeLabel = 'Cancelado';
      badgeStatus = 'rejected';
    } else if (isPast) {
      badgeLabel = 'Finalizado';
      badgeStatus = 'default';
    } else {
      badgeLabel = 'Activo';
      badgeStatus = 'confirmed';
    }

    return (
      <div
        key={enc.id}
        onClick={() => navigate(`/meet/${enc.id}`)}
        style={{
          background: isPast ? '#f8f8f8' : '#fff',
          borderRadius: 16,
          padding: '16px',
          border: '1px solid rgba(0,0,0,0.06)',
          boxShadow: isPast ? 'none' : '0 2px 8px rgba(0,0,0,0.05)',
          cursor: 'pointer',
          transition: 'transform 0.18s ease, box-shadow 0.18s ease',
          opacity: cardOpacity,
        }}
        onMouseEnter={e => {
          if (!isPast) {
            (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)';
            (e.currentTarget as HTMLDivElement).style.boxShadow = '0 6px 20px rgba(0,0,0,0.09)';
          }
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLDivElement).style.transform = '';
          (e.currentTarget as HTMLDivElement).style.boxShadow = isPast ? 'none' : '0 2px 8px rgba(0,0,0,0.05)';
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <h3 style={{
            margin: 0, fontSize: 17, fontWeight: 700, flex: 1, marginRight: 8,
            color: isPast ? 'var(--color-on-surface-variant)' : 'inherit',
          }}>
            {enc.titulo}
          </h3>
          <Badge label={badgeLabel} status={badgeStatus} />
        </div>
        <p style={{ margin: '0 0 10px 0', fontSize: 13, color: 'var(--color-on-surface-variant)' }}>
          📅 {formatFriendlyDate(enc.fecha, enc.hora)}
        </p>
        <Badge
          label={enc.modalidad === 'presencial' ? '🤝 Presencial' : '💻 Virtual'}
          status="default"
        />
      </div>
    );
  };

  const renderContent = () => {
    if (loading) return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p>Cargando encuentros…</p>
      </div>
    );

    if (error) return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <p>{error}</p>
        <Button variant="outline" onClick={loadData}>Reintentar</Button>
      </div>
    );

    if (encuentros.length === 0) return (
      <EmptyState
        icon={<Calendar size={48} />}
        title="Todavía no tenés encuentros"
        description="Creá uno para empezar a organizar."
      />
    );

    // Separar: activos/futuros vs pasados (incluyendo cancelados pasados)
    const proximos = encuentros.filter(enc => enc.estado !== 'cancelado' && !isEncuentroPasado(enc));
    const pasados = encuentros.filter(enc => enc.estado === 'cancelado' || isEncuentroPasado(enc));

    return (
      <div
        id="home-scroll-container"
        onScroll={handleScroll}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}
      >
        {/* Encuentros próximos */}
        {proximos.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {proximos.map(enc => renderCard(enc, false))}
          </div>
        )}

        {proximos.length === 0 && pasados.length > 0 && (
          <EmptyState
            icon={<Calendar size={32} />}
            title="No tenés encuentros próximos"
            description="Creá uno nuevo para organizar tu próxima reunión."
          />
        )}

        {/* Encuentros pasados */}
        {pasados.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: proximos.length > 0 ? 8 : 0 }}>
            <p style={{
              fontSize: 11, fontWeight: 700,
              color: 'var(--color-on-surface-variant)',
              textTransform: 'uppercase', letterSpacing: '0.06em',
              margin: '4px 0 4px 2px',
            }}>
              Encuentros pasados
            </p>
            {pasados.map(enc => renderCard(enc, true))}
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
      <div style={{ paddingTop: 16 }}>
        <Button fullWidth variant="primary" onClick={() => { resetWizard(); navigate('/create'); }}>
          + Crear encuentro
        </Button>
      </div>
      <div style={{ textAlign: 'center', paddingTop: 12, paddingBottom: 4 }}>
        <span style={{ fontSize: 10, color: 'var(--color-on-surface-variant)', opacity: 0.5 }}>
          Build: {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'Local'}
        </span>
        <br/>
        <span style={{ fontSize: '10px', color: 'var(--color-primary)', fontWeight: 'bold' }}>
          BUILD_CHECK: 2026-04-27 17:48 - Redesign
        </span>
      </div>
    </ScreenContainer>
  );
};

export default Home;
