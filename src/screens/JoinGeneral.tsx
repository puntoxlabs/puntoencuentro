import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate } from '@/lib/formatDate';

const JoinGeneral: React.FC = () => {
  const { public_token } = useParams();
  const navigate = useNavigate();
  
  const [encuentro, setEncuentro] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [nombre, setNombre] = useState('');
  const [step, setStep] = useState<'form' | 'done'>('form');
  const [finalState, setFinalState] = useState<'confirmado' | 'rechazado' | null>(null);
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
    if (public_token) {
      loadData();
    }
  }, [public_token]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await encuentrosService.getEncuentroByPublicToken(public_token!);
      if (!data) throw new Error("No encontrado");
      
      setEncuentro(data);
    } catch (err) {
      console.error('Error loading encuentro', err);
      setError('No se pudo encontrar el encuentro o el enlace es inválido.');
    } finally {
      setLoading(false);
    }
  };


  const handleResponse = async (estado: 'confirmado' | 'rechazado') => {
    if (!encuentro || !nombre.trim()) return;
    try {
      setUpdating(true);
      await participantesService.addParticipanteGenerico(encuentro.id, nombre.trim(), estado);
      setFinalState(estado);
      setStep('done');
    } catch (err) {
      console.error('Error responding', err);
      alert('Hubo un error al guardar tu respuesta. Por favor intenta de nuevo.');
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return <ScreenContainer><p>Cargando encuentro...</p></ScreenContainer>;
  }

  if (error || !encuentro) {
    return (
      <ScreenContainer>
        <AppBar title="Encuentro" />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <p>{error || 'Encuentro no válido.'}</p>
          <Button onClick={() => navigate('/')} variant="outline" style={{ marginTop: '16px' }}>Volver al inicio</Button>
        </div>
      </ScreenContainer>
    );
  }

  if (step === 'done' && finalState) {
    return (
      <ScreenContainer>
        <AppBar title="Respuesta enviada" />
        <EmptyState 
          title={finalState === 'confirmado' ? '¡Listo! Ya confirmaste tu asistencia.' : 'Listo. Avisamos que no vas a asistir.'}
          description={finalState === 'confirmado' ? 'No necesitás hacer nada más.' : 'Gracias por responder.'}
        />
        <Card style={{ marginTop: 'auto' }}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>{encuentro.titulo}</h4>
          <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface-variant)', fontSize: '14px' }}>
            {formatFriendlyDate(encuentro.fecha, encuentro.hora)}
          </p>
          <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface)', fontSize: '14px' }}>
            <strong>Modalidad:</strong><br/>
            {encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}
          </p>
          {encuentro.modalidad === 'presencial' ? (
            <p style={{ margin: 0, color: 'var(--color-on-surface)', fontSize: '14px' }}>
              <strong>Lugar:</strong><br/>
              {encuentro.lugar_texto}
            </p>
          ) : (
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

  return (
    <ScreenContainer>
      <AppBar title="Unirse al Encuentro" />

      <Card style={{ marginBottom: '24px' }}>
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

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <Input 
          label="¿Cómo te llamás?"
          placeholder="Ej: Marcos" 
          value={nombre} 
          onChange={(e) => setNombre(e.target.value)} 
        />
        <div style={{ marginTop: 'auto', display: 'flex', gap: '12px', flexDirection: 'column' }}>
          <Button fullWidth variant="primary" onClick={() => handleResponse('confirmado')} disabled={updating || !nombre.trim()}>
            {updating ? 'Procesando...' : 'Confirmar asistencia'}
          </Button>
          <Button fullWidth variant="outline" onClick={() => handleResponse('rechazado')} disabled={updating || !nombre.trim()}>
            {updating ? 'Procesando...' : 'No puedo ir'}
          </Button>
        </div>
      </div>
    </ScreenContainer>
  );
};

export default JoinGeneral;
