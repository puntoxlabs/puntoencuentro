import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate } from '@/lib/formatDate';
import { useTranslation } from 'react-i18next';
import { openExternalVideoLink } from '@/lib/openLink';
import { useHomeStore } from '@/store/homeStore';
import { getThemeStyle } from '@/lib/themes';

const metaRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  fontSize: 15, color: 'var(--color-on-surface-variant)', marginBottom: 10,
};
const metaIcon: React.CSSProperties = { fontSize: 17, width: 22, textAlign: 'center', flexShrink: 0 };
const eventCard: React.CSSProperties = {
  background: '#fff', borderRadius: 20, padding: '20px',
  border: '1px solid rgba(0,0,0,0.06)',
  boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
};
const linkBox: React.CSSProperties = {
  background: 'var(--color-primary-container)', borderRadius: 12,
  padding: '10px 14px', marginBottom: 12,
  wordBreak: 'break-all', fontSize: 14,
  color: 'var(--color-primary-dark)', fontWeight: 500,
};

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
      setCopiedLink(true); setTimeout(() => setCopiedLink(false), 2000);
    } catch (err) { console.error('Failed to copy', err); alert('Error al copiar el enlace.'); }
  };

  useEffect(() => {
    console.log('[INVITE] token inicial:', token);
    if (token) { loadData(); } else { setError('Token no proporcionado en la URL.'); setLoading(false); }
  }, [token]);

  const loadData = async () => {
    try {
      setLoading(true); setError(null);
      console.log('[INDIVIDUAL_INVITE] url completa:', window.location.href);
      console.log('[INDIVIDUAL_INVITE] token leído:', token);
      const data = await participantesService.getParticipanteByToken(token!);
      console.log('[INDIVIDUAL_INVITE] invitación encontrada:', data);
      if (!data) throw new Error("No encontrado");
      setParticipante(data);
      let enc = data.encuentros;
      if (!enc && data.encuentro_id) {
        try {
          const { encuentrosService } = await import('@/services/encuentrosService');
          enc = await encuentrosService.getEncuentroById(data.encuentro_id);
        } catch (e) { console.error("Error fetching fallback encuentro", e); }
      }
      setEncuentro(enc);
      if (data.estado !== 'pendiente') setStep('done');
    } catch (err) {
      console.error('InviteGuest error:', err);
      console.log('[INDIVIDUAL_INVITE] error backend:', err);
      setError('No se pudo encontrar la invitación o el enlace es inválido.');
    } finally { setLoading(false); }
  };

  const handleResponse = async (estado: 'confirmado' | 'rechazado') => {
    if (!participante || loadingResponse) return;
    try {
      setLoadingResponse(true);
      console.log('[INVITE] confirmando token:', token);
      const response = await participantesService.updateParticipanteEstado(participante.id, estado);
      console.log('[INVITE] respuesta confirmación:', response);
      useHomeStore.getState().invalidateCache();
      const refreshed = await participantesService.getParticipanteByToken(token!);
      let refEnc = refreshed.encuentros;
      if (!refEnc && refreshed.encuentro_id) {
        try {
          const { encuentrosService } = await import('@/services/encuentrosService');
          refEnc = await encuentrosService.getEncuentroById(refreshed.encuentro_id);
        } catch (e) { console.error("Error fetching fallback encuentro in refresh", e); }
      }
      if (!refEnc) throw new Error("No se pudo obtener el participante actualizado o su encuentro después de confirmar.");
      setParticipante(refreshed); setEncuentro(refEnc); setStep('done');
      console.log('[INVITE] ruta post-confirmación:', window.location.href);
    } catch (err) {
      console.error('InviteGuest error:', err);
      alert('Hubo un problema al enviar tu respuesta. Por favor intenta de nuevo.');
    } finally { setLoadingResponse(false); }
  };

  if (loading) return (
    <ScreenContainer>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p>Cargando invitación…</p>
      </div>
    </ScreenContainer>
  );

  if (error || !participante || !encuentro) return (
    <ScreenContainer>
      <AppBar title="Invitación" />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <p style={{ textAlign: 'center' }}>{error || 'Invitación no válida.'}</p>
        <Button onClick={() => navigate('/')} variant="outline">Volver al inicio</Button>
      </div>
    </ScreenContainer>
  );

  // Encuentro cancelado — bloquear confirmación
  if (encuentro?.estado === 'cancelado') return (
    <ScreenContainer style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Encuentro cancelado" />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 0, padding: '20px 0' }}>
        <div style={{
          background: 'rgba(220,38,38,0.08)', borderRadius: 16, padding: '16px',
          border: '1px solid rgba(220,38,38,0.2)', marginBottom: 24,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 24 }}>❌</span>
          <div>
            <p style={{ margin: 0, fontWeight: 700, fontSize: 15, color: '#B91C1C' }}>Este encuentro fue cancelado</p>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--color-on-surface-variant)', marginTop: 2 }}>
              El organizador canceló este encuentro.
            </p>
          </div>
        </div>
        <div style={{ ...eventCard }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Encuentro</p>
          <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 14 }}>{encuentro.titulo}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 8 }}>
            <span>📅</span><span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--color-on-surface-variant)' }}>
            <span>{encuentro.modalidad === 'presencial' ? '📍' : '💻'}</span>
            <span>{encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}</span>
          </div>
        </div>
        <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)', textAlign: 'center', marginTop: 24, fontStyle: 'italic' }}>
          No es necesario confirmar asistencia.
        </p>
      </div>
    </ScreenContainer>
  );

  if (step === 'done' || participante.estado !== 'pendiente') return (
    <ScreenContainer style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Respuesta enviada" />
      <EmptyState
        title={participante.estado === 'confirmado' ? '¡Todo listo!' : 'Gracias por responder.'}
        description={participante.estado === 'confirmado' ? 'Ya confirmaste tu asistencia.' : 'Avisamos que no vas a asistir.'}
      />
      <div style={{ ...eventCard, marginTop: 'auto' }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Encuentro</p>
        <h4 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>{encuentro.titulo}</h4>
        {participante.estado === 'confirmado' && encuentro.modalidad === 'virtual' && (
          <p style={{ fontSize: 13, color: 'var(--color-primary)', fontWeight: 700, marginBottom: 12 }}>🎉 Ya podés unirte a la videollamada</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
          <div style={metaRow}><span style={metaIcon}>📅</span><span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span></div>
          <div style={metaRow}>
            <span style={metaIcon}>{encuentro.modalidad === 'presencial' ? '📍' : '💻'}</span>
            <span>{encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}</span>
          </div>
        </div>
        {encuentro.modalidad === 'virtual' && participante.estado === 'confirmado' && encuentro.link_virtual && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={linkBox}>{encuentro.link_virtual}</div>
            <Button fullWidth onClick={() => openExternalVideoLink(encuentro.link_virtual)}>{t('open_video_call', 'Abrir videollamada')}</Button>
            <Button fullWidth variant="outline" onClick={handleCopyVideoLink}>{copiedLink ? t('link_copied', 'Link copiado.') : t('copy_link', 'Copiar link')}</Button>
          </div>
        )}
      </div>
    </ScreenContainer>
  );

  return (
    <ScreenContainer style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Invitación" />

      <div style={{ padding: '20px 0 4px 0' }}>
        <h2 style={{ fontSize: 26, fontWeight: 800, marginBottom: 4 }}>¡Hola, {participante.nombre_invitado}!</h2>
        <p style={{ margin: 0, fontSize: 15 }}>Te invitaron a un encuentro.</p>
      </div>

      <div style={{ ...eventCard, margin: '20px 0' }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Te invitan a</p>
        <h3 style={{ fontSize: 22, fontWeight: 800, marginBottom: 14, lineHeight: 1.2 }}>{encuentro.titulo}</h3>
        <div style={metaRow}><span style={metaIcon}>📅</span><span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span></div>
        {encuentro.modalidad === 'presencial' && encuentro.lugar_texto && (
          <div style={metaRow}><span style={metaIcon}>📍</span><span>{encuentro.lugar_texto}</span></div>
        )}
        <div style={metaRow}>
          <span style={metaIcon}>{encuentro.modalidad === 'presencial' ? '🤝' : '💻'}</span>
          <span>{encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}</span>
        </div>
        {encuentro.modalidad === 'virtual' && (
          <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', fontStyle: 'italic', margin: '4px 0 0' }}>
            {t('virtual_link_pending', 'Confirmá tu asistencia para acceder al enlace de la videollamada.')}
          </p>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 'auto' }}>
        <Button fullWidth variant="primary" onClick={() => handleResponse('confirmado')} disabled={loadingResponse}>
          {loadingResponse ? t('loading_link', 'Cargando…') : 'Confirmar asistencia'}
        </Button>
        <button
          onClick={() => handleResponse('rechazado')}
          disabled={loadingResponse}
          style={{
            background: 'none', border: 'none',
            color: loadingResponse ? 'var(--color-outline-variant)' : 'var(--color-on-surface-variant)',
            fontSize: 15, fontFamily: 'var(--font-family)', fontWeight: 500,
            cursor: loadingResponse ? 'not-allowed' : 'pointer',
            padding: '10px 0', textAlign: 'center', width: '100%',
          }}
        >
          {loadingResponse ? 'Procesando…' : 'No puedo ir'}
        </button>
      </div>
    </ScreenContainer>
  );
};

export default InviteGuest;
