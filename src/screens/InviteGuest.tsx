import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate } from '@/lib/formatDate';

const InviteGuest: React.FC = () => {
  const { token } = useParams();
  const navigate = useNavigate();
  
  const [participante, setParticipante] = useState<any>(null);
  const [encuentro, setEncuentro] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const handleCopyVideoLink = async () => {
    if (!encuentro?.link_virtual) return;
    try {
      await navigator.clipboard.writeText(encuentro.link_virtual);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch (err) {
      console.error('Failed to copy', err);
      alert('Error al copiar el enlace.');
    }
  };

  useEffect(() => {
    if (token) {
      loadData();
    }
  }, [token]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await participantesService.getParticipanteByToken(token!);
      if (!data) throw new Error("No encontrado");
      
      setParticipante(data);
      // Supabase join returns the related encounter in the singular name based on table definition if we used `encuentros(*)`
      setEncuentro(data.encuentros);
    } catch (err) {
      console.error('Error loading invite', err);
      setError('No se pudo encontrar la invitación o el enlace es inválido.');
    } finally {
      setLoading(false);
    }
  };

  const handleResponse = async (estado: 'confirmado' | 'rechazado') => {
    if (!participante) return;
    try {
      setUpdating(true);
      const updated = await participantesService.updateParticipanteEstado(participante.id, estado);
      setParticipante(updated);
    } catch (err) {
      console.error('Error updating status', err);
      alert('Hubo un error al guardar tu respuesta. Por favor intenta de nuevo.');
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return <ScreenContainer><p>Cargando invitación...</p></ScreenContainer>;
  }

  if (error || !participante || !encuentro) {
    return (
      <ScreenContainer>
        <AppBar title="Invitación" />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <p>{error || 'Invitación no válida.'}</p>
          <Button onClick={() => navigate('/')} variant="outline" style={{ marginTop: '16px' }}>Volver al inicio</Button>
        </div>
      </ScreenContainer>
    );
  }

  // Vista de estado final (Ya respondido)
  if (participante.estado !== 'pendiente') {
    return (
      <ScreenContainer>
        <AppBar title="Respuesta enviada" />
        <EmptyState 
          title={participante.estado === 'confirmado' ? '¡Listo! Ya confirmaste tu asistencia.' : 'Listo. Avisamos que no vas a asistir.'}
          description={participante.estado === 'confirmado' ? 'No necesitás hacer nada más.' : 'Gracias por responder.'}
        />
        <Card style={{ marginTop: 'auto' }}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>{encuentro.titulo}</h4>
          <p style={{ margin: '0 0 12px 0', color: 'var(--color-on-surface-variant)', fontSize: '14px' }}>
            {formatFriendlyDate(encuentro.fecha, encuentro.hora)}
          </p>
          {encuentro.modalidad === 'virtual' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <p style={{ margin: 0, color: 'var(--color-on-surface)', fontSize: '14px' }}>
                <strong>Link de videollamada:</strong><br/>
                <span style={{ wordBreak: 'break-all' }}>{encuentro.link_virtual}</span>
              </p>
              <Button variant="outline" style={{ alignSelf: 'flex-start', padding: '0 12px', height: '32px' }} onClick={handleCopyVideoLink}>
                {copiedLink ? 'Link copiado' : 'Copiar link'}
              </Button>
            </div>
          )}
        </Card>
      </ScreenContainer>
    );
  }

  // Vista pendiente de respuesta
  return (
    <ScreenContainer>
      <AppBar title="Invitación" />
      
      <div style={{ padding: '8px 0' }}>
        <h2 style={{ fontSize: '24px', margin: '0 0 8px 0' }}>¡Hola, {participante.nombre_invitado}!</h2>
        <p style={{ margin: 0, color: 'var(--color-on-surface-variant)' }}>Te han invitado a un encuentro.</p>
      </div>

      <Card style={{ marginBottom: 'auto' }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: '18px' }}>{encuentro.titulo}</h3>
        <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface)', fontSize: '15px' }}>
          <strong>Fecha y hora:</strong><br/>
          {formatFriendlyDate(encuentro.fecha, encuentro.hora)}
        </p>
        <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface)', fontSize: '15px' }}>
          <strong>Modalidad:</strong><br/>
          {encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}
        </p>
        {encuentro.modalidad === 'presencial' ? (
          <p style={{ margin: 0, color: 'var(--color-on-surface)', fontSize: '15px' }}>
            <strong>Lugar:</strong><br/>
            {encuentro.lugar_texto}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <p style={{ margin: 0, color: 'var(--color-on-surface)', fontSize: '15px' }}>
              <strong>Link de videollamada:</strong><br/>
              <span style={{ wordBreak: 'break-all' }}>{encuentro.link_virtual}</span>
            </p>
            <Button variant="outline" style={{ alignSelf: 'flex-start', padding: '0 12px', height: '32px' }} onClick={handleCopyVideoLink}>
              {copiedLink ? 'Link copiado' : 'Copiar link'}
            </Button>
          </div>
        )}
      </Card>

      <div style={{ marginTop: '24px', display: 'flex', gap: '12px', flexDirection: 'column' }}>
        <Button fullWidth variant="primary" onClick={() => handleResponse('confirmado')} disabled={updating}>
          {updating ? 'Procesando...' : 'Confirmar asistencia'}
        </Button>
        <Button fullWidth variant="outline" onClick={() => handleResponse('rechazado')} disabled={updating}>
          {updating ? 'Procesando...' : 'No puedo ir'}
        </Button>
      </div>
    </ScreenContainer>
  );
};

export default InviteGuest;
