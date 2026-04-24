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
  const [step, setStep] = useState<'name' | 'action' | 'done'>('name');
  const [finalState, setFinalState] = useState<'confirmado' | 'rechazado' | null>(null);
  const [updating, setUpdating] = useState(false);

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

  const handleContinue = () => {
    if (nombre.trim()) {
      setStep('action');
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
          title={finalState === 'confirmado' ? '¡Asistencia confirmada!' : 'Marcaste que no podés asistir'}
          description={`Gracias por confirmar, ${nombre.trim()}.`}
        />
        <Card style={{ marginTop: 'auto', marginBottom: '24px' }}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>{encuentro.titulo}</h4>
          <p style={{ margin: 0, color: 'var(--color-on-surface-variant)', fontSize: '14px' }}>
            {formatFriendlyDate(encuentro.fecha, encuentro.hora)}
          </p>
        </Card>
        <div style={{ display: 'flex', gap: '12px', flexDirection: 'column' }}>
          <Button fullWidth onClick={() => navigate(`/meet/${encuentro.id}`)}>Ver encuentro</Button>
          <Button fullWidth variant="outline" onClick={() => navigate('/')}>Volver al inicio</Button>
        </div>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <AppBar title="Unirse al Encuentro" />

      {step === 'action' && (
        <div style={{ padding: '8px 0' }}>
          <h2 style={{ fontSize: '24px', margin: '0 0 8px 0' }}>¡Hola, {nombre.trim()}!</h2>
          <p style={{ margin: 0, color: 'var(--color-on-surface-variant)' }}>¿Vas a asistir?</p>
        </div>
      )}

      <Card style={{ marginBottom: step === 'action' ? 'auto' : '24px' }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: '18px' }}>{encuentro.titulo}</h3>
        <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface)', fontSize: '15px' }}>
          <strong>Fecha y hora:</strong><br/>
          {formatFriendlyDate(encuentro.fecha, encuentro.hora)}
        </p>
        <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface)', fontSize: '15px' }}>
          <strong>Modalidad:</strong><br/>
          {encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}
        </p>
        <p style={{ margin: 0, color: 'var(--color-on-surface)', fontSize: '15px' }}>
          <strong>{encuentro.modalidad === 'presencial' ? 'Lugar:' : 'Link:'}</strong><br/>
          {encuentro.modalidad === 'presencial' ? encuentro.lugar_texto : encuentro.link_virtual}
        </p>
      </Card>

      {step === 'name' ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Input 
            label="¿Cómo te llamás?"
            placeholder="Ej: Marcos" 
            value={nombre} 
            onChange={(e) => setNombre(e.target.value)} 
          />
          <Button 
            fullWidth 
            onClick={handleContinue} 
            disabled={!nombre.trim()}
          >
            Continuar
          </Button>
        </div>
      ) : (
        <div style={{ marginTop: '24px', display: 'flex', gap: '12px', flexDirection: 'column' }}>
          <Button fullWidth variant="primary" onClick={() => handleResponse('confirmado')} disabled={updating}>
            {updating ? 'Procesando...' : 'Confirmar asistencia'}
          </Button>
          <Button fullWidth variant="outline" onClick={() => handleResponse('rechazado')} disabled={updating}>
            {updating ? 'Procesando...' : 'No puedo ir'}
          </Button>
        </div>
      )}
    </ScreenContainer>
  );
};

export default JoinGeneral;
