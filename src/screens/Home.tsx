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

const Home: React.FC = () => {
  const navigate = useNavigate();
  
  const [encuentros, setEncuentros] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const hostId = getHostId();
      const data = await encuentrosService.getEncuentrosByHost(hostId);
      
      // Ordenar por fecha y hora (más próximos primero)
      const sortedData = (data || []).sort((a, b) => {
        const dateA = new Date(`${a.fecha}T${a.hora}`);
        const dateB = new Date(`${b.fecha}T${b.hora}`);
        return dateA.getTime() - dateB.getTime();
      });
      
      setEncuentros(sortedData);
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
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' }}>
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
        <Button fullWidth variant="primary" onClick={() => navigate('/create')}>
          Crear encuentro
        </Button>
      </div>
    </ScreenContainer>
  );
};

export default Home;
