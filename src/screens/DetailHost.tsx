import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate } from '@/lib/formatDate';

const DetailHost: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  
  const [encuentro, setEncuentro] = useState<any>(null);
  const [participantes, setParticipantes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id) {
      loadData();
    }
  }, [id]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const enc = await encuentrosService.getEncuentroById(id!);
      setEncuentro(enc);
      const parts = await participantesService.getParticipantesByEncuentro(id!);
      setParticipantes(parts || []);
    } catch (err) {
      console.error('Error loading detail', err);
      setError('No se pudo cargar el encuentro.');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <ScreenContainer><p>Cargando detalle...</p></ScreenContainer>;
  }

  if (error || !encuentro) {
    return (
      <ScreenContainer>
        <AppBar title="Error" showBack />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <p>{error || 'Encuentro no encontrado.'}</p>
          <Button onClick={() => navigate('/')} variant="outline" style={{ marginTop: '16px' }}>Volver al inicio</Button>
        </div>
      </ScreenContainer>
    );
  }

  // Agrupar participantes por estado
  const confirmados = participantes.filter(p => p.estado === 'confirmado');
  const pendientes = participantes.filter(p => p.estado === 'pendiente');
  const rechazados = participantes.filter(p => p.estado === 'rechazado');

  const renderParticipantsGroup = (title: string, group: any[], badgeStatus: 'confirmed' | 'pending' | 'rejected') => {
    if (group.length === 0) return null;
    return (
      <div style={{ marginBottom: '16px' }}>
        <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', color: 'var(--color-on-surface-variant)' }}>
          {title} ({group.length})
        </h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {group.map(p => {
            let timeLabel = '';
            if (p.respondido_en) {
              const dateObj = new Date(p.respondido_en);
              timeLabel = `Respondió ${dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            } else if (p.creado_en) {
              const dateObj = new Date(p.creado_en);
              timeLabel = `Creado ${dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            } else {
              timeLabel = 'Pendiente';
            }

            return (
              <Card key={p.id} style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontWeight: 500, fontSize: '15px' }}>{p.nombre_invitado}</span>
                  <span style={{ fontSize: '13px', color: 'var(--color-on-surface-variant)', marginTop: '2px' }}>
                    {timeLabel}
                  </span>
                </div>
                <Badge 
                  label={p.estado.charAt(0).toUpperCase() + p.estado.slice(1)} 
                  status={badgeStatus} 
                />
              </Card>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <ScreenContainer>
      <AppBar title="Detalle del Encuentro" showBack />
      
      <Card style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
          <h3 style={{ margin: 0, fontSize: '20px' }}>{encuentro.titulo}</h3>
          <Badge 
            label={encuentro.estado.charAt(0).toUpperCase() + encuentro.estado.slice(1)} 
            status={encuentro.estado === 'activo' ? 'confirmed' : 'default'} 
          />
        </div>
        
        <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface)', fontSize: '14px' }}>
          <strong>Fecha y hora:</strong><br/>
          {formatFriendlyDate(encuentro.fecha, encuentro.hora)}
        </p>
        <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface)', fontSize: '14px' }}>
          <strong>Modalidad:</strong> {encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}
        </p>
        <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface)', fontSize: '14px' }}>
          <strong>{encuentro.modalidad === 'presencial' ? 'Lugar:' : 'Link:'}</strong><br/>
          {encuentro.modalidad === 'presencial' ? encuentro.lugar_texto : encuentro.link_virtual}
        </p>
        {encuentro.descripcion && (
          <p style={{ margin: 0, color: 'var(--color-on-surface-variant)', fontSize: '14px', fontStyle: 'italic' }}>
            {encuentro.descripcion}
          </p>
        )}
      </Card>

      <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
        {encuentro.tipo_invitacion === 'link_general' && (
          <Button fullWidth onClick={() => navigate(`/share/${encuentro.id}`)}>
            Compartir link
          </Button>
        )}
        {encuentro.tipo_invitacion === 'individual' && (
          <Button fullWidth onClick={() => navigate(`/add-guests/${encuentro.id}`)}>
            Agregar invitados
          </Button>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <h3 style={{ margin: '0 0 16px 0', fontSize: '18px' }}>Participantes</h3>
        
        {participantes.length === 0 ? (
          <div style={{ backgroundColor: 'var(--color-surface)', border: '1px dashed var(--color-outline-variant)', borderRadius: 'var(--radius-md)', padding: '24px', textAlign: 'center' }}>
            <p style={{ margin: 0, color: 'var(--color-on-surface-variant)', fontSize: '14px' }}>Aún no hay participantes en este encuentro.</p>
          </div>
        ) : (
          <>
            {renderParticipantsGroup('Confirmados', confirmados, 'confirmed')}
            {renderParticipantsGroup('No asisten', rechazados, 'rejected')}
            {renderParticipantsGroup('Pendientes', pendientes, 'pending')}
          </>
        )}
      </div>
    </ScreenContainer>
  );
};

export default DetailHost;
