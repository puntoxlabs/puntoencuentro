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
import { useTranslation } from 'react-i18next';
import { useHomeStore } from '@/store/homeStore';
import { openExternalVideoLink } from '@/lib/openLink';

const JoinGeneral: React.FC = () => {
  const { public_token } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  
  const [encuentro, setEncuentro] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [nombre, setNombre] = useState('');
  const [loadingResponse, setLoadingResponse] = useState(false);
  const [step, setStep] = useState<'pending' | 'done'>('pending');
  const [participante, setParticipante] = useState<any>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    if (public_token) {
      loadData();
    }
  }, [public_token]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      
      console.log('[GENERAL_LINK] token:', public_token);
      
      const data = await encuentrosService.getEncuentroByPublicToken(public_token!);
      if (!data) throw new Error("No encontrado");
      
      console.log('[GENERAL_LINK] encuentro:', data);
      setEncuentro(data);
      
      const savedDataStr = localStorage.getItem('encuentros_general');
      const savedData = savedDataStr ? JSON.parse(savedDataStr) : { encuentros: {} };
      const participantData = savedData?.encuentros?.[public_token!];
      
      const participantId = participantData?.participant_id;
      const participantToken = participantData?.token_invitacion;
      
      console.log('[GENERAL_LINK] token local:', participantToken, 'id local:', participantId);
      
      let estadoUI = 'pending';

      if (participantToken) {
        try {
          const partData = await participantesService.getParticipanteByToken(participantToken);
          console.log('[GENERAL_LINK] participante backend token:', partData);
          if (partData && partData.estado === 'confirmado') {
             setParticipante(partData);
             setStep('done');
             estadoUI = 'done';
          }
        } catch (err) {
          console.error('Participant not found by token', err);
        }
      } else if (participantId) {
        try {
          const partData = await participantesService.getParticipanteById(participantId);
          console.log('[GENERAL_LINK] participante backend id:', partData);
          if (partData && partData.estado === 'confirmado') {
             setParticipante(partData);
             setStep('done');
             estadoUI = 'done';
          }
        } catch (err) {
          console.error('Participant not found by id', err);
        }
      }
      
      console.log('[GENERAL_LINK] estado final:', estadoUI);
    } catch (err) {
      console.error('Error loading encuentro', err);
      setError('No se pudo encontrar el encuentro o el enlace es inválido.');
    } finally {
      setLoading(false);
    }
  };

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

  const handleResponse = async (estado: 'confirmado' | 'rechazado') => {
    if (!encuentro || !nombre.trim()) return;
    try {
      setLoadingResponse(true);
      
      const newPart = await participantesService.addParticipanteGenerico(encuentro.id, nombre.trim(), estado);
      
      if (newPart && newPart.id) {
        const savedDataStr = localStorage.getItem('encuentros_general');
        const savedData = savedDataStr ? JSON.parse(savedDataStr) : { encuentros: {} };
        if (!savedData.encuentros) savedData.encuentros = {};
        
        savedData.encuentros[public_token!] = {
          participant_id: newPart.id,
          token_invitacion: newPart.token_invitacion
        };
        
        localStorage.setItem('encuentros_general', JSON.stringify(savedData));
      }
      
      useHomeStore.getState().invalidateCache();
      
      setParticipante(newPart || { estado, nombre_invitado: nombre.trim() });
      setStep('done');
      
      console.log('[GENERAL_LINK] estado final:', 'done');
    } catch (err) {
      console.error('Error responding', err);
      alert('Hubo un error al guardar tu respuesta. Por favor intenta de nuevo.');
    } finally {
      setLoadingResponse(false);
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

  // Vista de estado final (Ya respondido)
  if (step === 'done') {
    return (
      <ScreenContainer>
        <AppBar title="Respuesta enviada" />
        <EmptyState 
          title={participante?.estado === 'confirmado' ? '¡Listo! Ya confirmaste tu asistencia.' : 'Listo. Avisamos que no vas a asistir.'}
          description={participante?.estado === 'confirmado' ? 'No necesitás hacer nada más.' : 'Gracias por responder.'}
        />
        <Card style={{ marginTop: 'auto' }}>
          <h4 style={{ margin: '0 0 4px 0', fontSize: '16px' }}>{encuentro.titulo}</h4>
          {participante?.estado === 'confirmado' && encuentro.modalidad === 'virtual' && (
            <p style={{ margin: '0 0 12px 0', color: 'var(--color-primary)', fontSize: '14px', fontWeight: 'bold' }}>
              Ya podés unirte a la videollamada
            </p>
          )}
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
              {participante?.estado === 'confirmado' && encuentro.link_virtual ? (
                <>
                  <p style={{ margin: 0, color: 'var(--color-on-surface)', fontSize: '14px' }}>
                    <strong>Link de videollamada:</strong><br/>
                    <span style={{ wordBreak: 'break-all' }}>{encuentro.link_virtual}</span>
                  </p>
                  
                  <Button fullWidth onClick={() => openExternalVideoLink(encuentro.link_virtual)} style={{ marginTop: '4px' }}>
                    {t('open_video_call', 'Abrir videollamada')}
                  </Button>
                  
                  <Button fullWidth variant="outline" onClick={handleCopyVideoLink}>
                    {copiedLink ? t('link_copied', 'Link copiado.') : t('copy_link', 'Copiar link')}
                  </Button>
                </>
              ) : (
                <p style={{ margin: 0, color: 'var(--color-on-surface-variant)', fontSize: '14px', fontStyle: 'italic' }}>
                  {t('virtual_link_pending', 'Confirmá tu asistencia para acceder al enlace de la videollamada.')}
                </p>
              )}
            </div>
          )}
        </Card>
      </ScreenContainer>
    );
  }

  // Vista pendiente
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
            <p style={{ margin: 0, color: 'var(--color-on-surface-variant)', fontSize: '15px', fontStyle: 'italic' }}>
              {t('virtual_link_pending', 'Confirmá tu asistencia para acceder al enlace de la videollamada.')}
            </p>
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
          <Button fullWidth variant="primary" onClick={() => handleResponse('confirmado')} disabled={!nombre.trim() || loadingResponse}>
          {loadingResponse ? t('loading_link', 'Cargando enlace...') : 'Confirmar asistencia'}
        </Button>
        <Button fullWidth variant="outline" onClick={() => handleResponse('rechazado')} disabled={!nombre.trim() || loadingResponse}>
          {loadingResponse ? 'Procesando...' : 'No puedo ir'}
        </Button>
        </div>
      </div>
    </ScreenContainer>
  );
};

export default JoinGeneral;

