import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate } from '@/lib/formatDate';
import { useTranslation } from 'react-i18next';
import { openExternalVideoLink } from '@/lib/openLink';
import { useHomeStore } from '@/store/homeStore';

const InviteGuest: React.FC = () => {
  const { token } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  
  const [participante, setParticipante] = useState<any>(null);
  const [encuentro, setEncuentro] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingResponse, setLoadingResponse] = useState(false);
  const [step, setStep] = useState<'pending' | 'done'>('pending');
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
    console.log('token recibido:', token);
    if (token) {
      loadData();
    } else {
      setError('Token no proporcionado en la URL.');
      setLoading(false);
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
      
      if (data.estado !== 'pendiente') {
        setStep('done');
      }
    } catch (err) {
      console.error('InviteGuest error:', err);
      setError('No se pudo encontrar la invitación o el enlace es inválido.');
    } finally {
      setLoading(false);
    }
  };

  const handleResponse = async (estado: 'confirmado' | 'rechazado') => {
    if (!participante || loadingResponse) return;
    try {
      setLoadingResponse(true);
      await participantesService.updateParticipanteEstado(participante.id, estado);
      
      // Invalidate cache in Home
      useHomeStore.getState().invalidateCache();

      // Refetch full data to ensure relations like 'encuentros' are present and link_virtual is unhidden by RPC
      const refreshed = await participantesService.getParticipanteByToken(token!);
      if (!refreshed) {
        throw new Error("No se pudo obtener el participante actualizado");
      }
      
      setParticipante(refreshed);
      setEncuentro(refreshed.encuentros);
      setStep('done');
    } catch (err) {
      console.error('InviteGuest error:', err);
      alert('Hubo un problema al enviar tu respuesta. Por favor intenta de nuevo.');
    } finally {
      setLoadingResponse(false);
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
  if (step === 'done' || participante.estado !== 'pendiente') {
    return (
      <ScreenContainer>
        <AppBar title="Respuesta enviada" />
        <EmptyState 
          title={participante.estado === 'confirmado' ? '¡Listo! Ya confirmaste tu asistencia.' : 'Listo. Avisamos que no vas a asistir.'}
          description={participante.estado === 'confirmado' ? 'No necesitás hacer nada más.' : 'Gracias por responder.'}
        />
        <Card style={{ marginTop: 'auto' }}>
          <h4 style={{ margin: '0 0 4px 0', fontSize: '16px' }}>{encuentro.titulo}</h4>
          {participante.estado === 'confirmado' && encuentro.modalidad === 'virtual' && (
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
              {participante.estado === 'confirmado' && encuentro.link_virtual ? (
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
            <p style={{ margin: 0, color: 'var(--color-on-surface-variant)', fontSize: '15px', fontStyle: 'italic' }}>
              {t('virtual_link_pending', 'Confirmá tu asistencia para acceder al enlace de la videollamada.')}
            </p>
          </div>
        )}
      </Card>

      <div style={{ marginTop: '24px', display: 'flex', gap: '12px', flexDirection: 'column' }}>
        <Button fullWidth variant="primary" onClick={() => handleResponse('confirmado')} disabled={loadingResponse}>
          {loadingResponse ? t('loading_link', 'Cargando enlace...') : 'Confirmar asistencia'}
        </Button>
        <Button fullWidth variant="outline" onClick={() => handleResponse('rechazado')} disabled={loadingResponse}>
          {loadingResponse ? 'Procesando...' : 'No puedo ir'}
        </Button>
      </div>
    </ScreenContainer>
  );
};

export default InviteGuest;
