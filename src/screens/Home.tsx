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

    return (
      <div
        id="home-scroll-container"
        onScroll={handleScroll}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}
      >
        {encuentros.map(enc => (
          <div
            key={enc.id}
            onClick={() => navigate(`/meet/${enc.id}`)}
            style={{
              background: '#fff', borderRadius: 16, padding: '16px',
              border: '1px solid rgba(0,0,0,0.06)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
              cursor: 'pointer', transition: 'transform 0.18s ease, box-shadow 0.18s ease',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 6px 20px rgba(0,0,0,0.09)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = ''; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.05)'; }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, flex: 1, marginRight: 8 }}>{enc.titulo}</h3>
              <Badge
                label={enc.estado === 'activo' ? 'Activo' : enc.estado.charAt(0).toUpperCase() + enc.estado.slice(1)}
                status={enc.estado === 'activo' ? 'confirmed' : 'default'}
              />
            </div>
            <p style={{ margin: '0 0 10px 0', fontSize: 13, color: 'var(--color-on-surface-variant)' }}>
              📅 {formatFriendlyDate(enc.fecha, enc.hora)}
            </p>
            <Badge
              label={enc.modalidad === 'presencial' ? '🤝 Presencial' : '💻 Virtual'}
              status="default"
            />
          </div>
        ))}
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
      </div>
    </ScreenContainer>
  );
};

export default Home;
