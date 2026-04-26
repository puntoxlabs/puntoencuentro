import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
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
  // Solo mostramos loading si no hay caché válido
  const [loading, setLoading] = useState(!validCache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
    // Restaurar scroll posponiendo la ejecución al siguiente render frame
    if (scrollPosition > 0) {
      requestAnimationFrame(() => {
        const container = document.getElementById('home-scroll-container');
        if (container) {
          container.scrollTop = scrollPosition;
        }
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
      
      // Ordenar por fecha y hora (más próximos primero)
      const sortedData = (data || []).sort((a, b) => {
        const dateA = new Date(`${a.fecha}T${a.hora}`);
        const dateB = new Date(`${b.fecha}T${b.hora}`);
        return dateA.getTime() - dateB.getTime();
      });
      
      setLocalEncuentros(sortedData);
      setEncuentros(sortedData); // Guardar en store
    } catch (err) {
      console.error('Error loading home data', err);
      setError('Hubo un error al cargar tus encuentros.');
    } finally {
      setLoading(false);
    }
  };

  const renderContent = () => {
    if (loading) {
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p>Cargando encuentros...</p>
        </div>
      );
    }

    if (error) {
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <p>{error}</p>
          <Button variant="outline" onClick={loadData}>Reintentar</Button>
        </div>
      );
    }

    if (encuentros.length === 0) {
      return (
        <EmptyState 
          icon={<Calendar size={48} />}
          title="Todavía no tenés encuentros"
          description="Creá uno para empezar a organizar."
        />
      );
    }

    return (
      <div 
        id="home-scroll-container"
        onScroll={handleScroll}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' }}
      >
        {encuentros.map(enc => (
          <Card key={enc.id} onClick={() => navigate(`/meet/${enc.id}`)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '16px' }}>{enc.titulo}</h3>
              <Badge 
                label={enc.estado.charAt(0).toUpperCase() + enc.estado.slice(1)} 
                status={enc.estado === 'activo' ? 'confirmed' : 'default'} 
              />
            </div>
            <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface-variant)', fontSize: '14px' }}>
              {formatFriendlyDate(enc.fecha, enc.hora)}
            </p>
            <div style={{ display: 'flex' }}>
              <Badge 
                label={enc.modalidad === 'presencial' ? 'Presencial' : 'Virtual'} 
                status="default" 
              />
            </div>
          </Card>
        ))}
      </div>
    );
  };

  return (
    <ScreenContainer>
      <AppBar title="Mis Encuentros" />
      
      {renderContent()}

      <div style={{ marginTop: '16px' }}>
        <Button fullWidth variant="primary" onClick={() => {
          resetWizard();
          navigate('/create');
        }}>
          Crear encuentro
        </Button>
      </div>
      
      <div style={{ textAlign: 'center', marginTop: '16px', paddingBottom: '8px' }}>
        <span style={{ fontSize: '10px', color: 'var(--color-on-surface-variant)', opacity: 0.6 }}>
          Build: {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'Local'}
        </span>
        <br/>
        <span style={{ fontSize: '10px', color: 'var(--color-primary)', fontWeight: 'bold' }}>
          BUILD_CHECK: 2026-04-26 18:55 - Commit: 1985872
        </span>
      </div>
    </ScreenContainer>
  );
};

export default Home;
