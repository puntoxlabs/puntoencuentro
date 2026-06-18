import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate } from '@/lib/formatDate';
import { formatFechaHoraWhatsApp } from '@/lib/formatWhatsapp';
import { getThemeStyle } from '@/lib/themes';
import { useWizardStore } from '@/store/wizardStore';
import { useAuth } from '@/contexts/AuthContext';
import { getHostId } from '@/lib/auth';

const metaRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 8,
};
const metaIcon: React.CSSProperties = { fontSize: 16, width: 20, textAlign: 'center', flexShrink: 0 };

const CancelSummary: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user } = useAuth();
  const [encuentro, setEncuentro] = useState<any>(null);
  const [participantes, setParticipantes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (id) loadData();
  }, [id]);

  const loadData = async () => {
    try {
      setLoading(true);
      const hostId = user?.id ?? getHostId();
      const enc = await encuentrosService.getDetalleHostSeguro(id!, hostId);
      setEncuentro(enc);
      const parts = await participantesService.getParticipantesByEncuentro(id!, hostId);
      setParticipantes(parts || []);
    } catch (err) {
      console.error('CancelSummary error:', err);
      setError('No se pudo cargar el encuentro.');
    } finally { setLoading(false); }
  };

  const [shareFeedback, setShareFeedback] = useState(false);

  const handleShareCancel = async () => {
    if (!encuentro) return;
    try {
      const shareUrl = `${window.location.origin}/join/${encuentro.public_token || encuentro.id}`;
      const { fechaStr, horaStr } = formatFechaHoraWhatsApp(encuentro.fecha, encuentro.hora);
      const shareText = `Este encuentro fue cancelado.\n\n*${encuentro.titulo}*\n${fechaStr} · ${horaStr}\n\nVer estado:\n${shareUrl}`;

      if (navigator.share) {
        await navigator.share({
          title: encuentro.titulo || 'Cancelación',
          text: shareText,
        });
        setShareFeedback(true);
      } else {
        await navigator.clipboard.writeText(shareText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        setShareFeedback(true);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Error sharing/copying cancellation', err);
        alert('Error al compartir o copiar la cancelación.');
      }
    }
  };

  const handleCreateNew = () => {
    if (!encuentro) return;
    const cancelRef = {
      oldId: id,
      oldTitulo: encuentro.titulo,
      oldFecha: formatFriendlyDate(encuentro.fecha, encuentro.hora),
      tipoInvitacion: encuentro.tipo_invitacion,
      participantes: participantes.map(p => ({ nombre_invitado: p.nombre_invitado, estado: p.estado })),
      newId: null,
    };
    sessionStorage.setItem('cancel_reference', JSON.stringify(cancelRef));

    const { setField, reset } = useWizardStore.getState();
    reset();
    setField('titulo', encuentro.titulo);
    setField('descripcion', encuentro.descripcion || '');
    setField('fecha', encuentro.fecha);
    setField('hora', encuentro.hora);
    setField('modalidad', encuentro.modalidad);
    setField('lugar_texto', encuentro.lugar_texto || '');
    setField('link_virtual', encuentro.link_virtual || '');
    setField('tema', encuentro.tema || 'blue');

    navigate('/create');
  };

  if (loading) return (
    <ScreenContainer>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p>Cargando…</p>
      </div>
    </ScreenContainer>
  );

  if (error || !encuentro) return (
    <ScreenContainer>
      <AppBar title="Cancelado" showBack />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <p>{error || 'Encuentro no encontrado.'}</p>
        <Button fullWidth onClick={() => navigate('/')} variant="ghost" style={{ color: 'var(--color-on-surface-variant)', border: '1px solid rgba(0,0,0,0.1)' }}>Ir al inicio</Button>
      </div>
    </ScreenContainer>
  );

  return (
    <ScreenContainer style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Encuentro cancelado" showBack />

      <div style={{ flex: 1, overflowY: 'auto', paddingTop: 16, paddingBottom: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Encuentro card */}
        <div style={{
          background: '#fff', borderRadius: 20, padding: '20px',
          border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, flex: 1, marginRight: 10 }}>{encuentro.titulo}</h2>
            <Badge label="Cancelado" status="rejected" />
          </div>
          <div style={metaRow}><span style={metaIcon}>📅</span><span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span></div>
          <div style={metaRow}>
            <span style={metaIcon}>{encuentro.modalidad === 'presencial' ? '📍' : '💻'}</span>
            <span>{encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}</span>
          </div>
        </div>

        <div style={{ flex: 1 }}></div>

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 'auto', paddingTop: 8 }}>
          <Button fullWidth variant={copied ? 'secondary' : 'outline'} onClick={handleShareCancel}>
            {copied ? t('share.copied_for_sharing', 'Copiado para compartir') : '📤 Compartir cancelación'}
          </Button>

          {shareFeedback && (
            <p style={{ fontSize: 13, color: 'var(--color-primary-dark)', textAlign: 'center', margin: '4px 0 8px', fontWeight: 500, animation: 'fadeIn 0.3s ease' }}>
              {t('share.ready_cancel', 'Listo. Los invitados podrán ver el estado actualizado.')}
            </p>
          )}

          <Button fullWidth variant="primary" onClick={handleCreateNew}>
            ✨ Cancelar y crear uno nuevo
          </Button>
          <Button fullWidth variant="ghost" onClick={() => navigate('/')} style={{ color: 'var(--color-on-surface-variant)', border: '1px solid rgba(0,0,0,0.1)' }}>
            Ir al inicio
          </Button>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}} />
    </ScreenContainer>
  );
};

export default CancelSummary;
