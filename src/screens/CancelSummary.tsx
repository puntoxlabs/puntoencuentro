import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate } from '@/lib/formatDate';

import { getThemeStyle } from '@/lib/themes';
import { useWizardStore } from '@/store/wizardStore';
import { useAuth } from '@/contexts/AuthContext';
import { getHostId } from '@/lib/auth';
import { getEncuentroHost, rememberEncuentroHost } from '@/lib/meetHostsStorage';
import { getHostAlias } from '@/lib/hostAliasStorage';
import './CancelSummary.css';

const CancelSummary: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user, loading: authLoading } = useAuth();
  const [encuentro, setEncuentro] = useState<any>(null);
  const [participantes, setParticipantes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const hostIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    const resolved = user?.id ?? getHostId();
    hostIdRef.current = resolved;
  }, [authLoading, user?.id]);

  useEffect(() => {
    if (!id || authLoading) return;
    const hId = user?.id ?? getEncuentroHost(id) ?? getHostId();
    hostIdRef.current = hId;
    loadData(hId);
  }, [id, authLoading]);

  const loadData = async (hId?: string) => {
    try {
      setLoading(true); setError(null);
      const hostId = hId ?? hostIdRef.current ?? (user?.id ?? getEncuentroHost(id!) ?? getHostId());
      const enc = await encuentrosService.getDetalleHostSeguro(id!, hostId);
      setEncuentro(enc);

      if (enc?.host_id) {
        rememberEncuentroHost(id!, enc.host_id);
      }

      const parts = await participantesService.getParticipantesByEncuentro(id!, hostId);
      setParticipantes(parts || []);
    } catch (err: any) {
      console.error('CancelSummary error:', err);
      const code = err?.code || err?.message || '';
      if (code === 'unauthorized') {
        setError('Este encuentro no pertenece a este dispositivo o sesión.');
      } else if (code === 'not_found') {
        setError('No se pudo encontrar el encuentro.');
      } else {
        setError('No se pudo cargar el encuentro.');
      }
    } finally { setLoading(false); }
  };

  const [shareFeedback, setShareFeedback] = useState(false);

  const handleShareCancel = async () => {
    if (!encuentro) return;
    try {
      const shareUrl = `${window.location.origin}/join/${encuentro.public_token || encuentro.id}`;
      const alias = getHostAlias();
      const intro = alias ? `${alias} canceló el encuentro:` : 'Se canceló el encuentro:';
      const shareText = `${intro}\n\n*${encuentro.titulo}*\n\nTe aviso para que estés al tanto.\n\nVer estado:\n${shareUrl}`;

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

  if (authLoading || loading) return (
    <ScreenContainer>
      <div className="pe-centered-loader">
        <p>Cargando…</p>
      </div>
    </ScreenContainer>
  );

  if (error || !encuentro) return (
    <ScreenContainer>
      <AppBar title="Error" showBack />
      <div className="cs-error-container">
        <span className="cs-error-icon">⚠️</span>
        <p className="cs-error-text">
          {error || 'Encuentro no encontrado.'}
        </p>
        <Button fullWidth onClick={() => loadData()} variant="outline">
          Reintentar
        </Button>
        <Button fullWidth onClick={() => navigate('/')} variant="ghost" style={{ color: 'var(--color-on-surface-variant)', border: 'none' }}>Ir al inicio</Button>
      </div>
    </ScreenContainer>
  );

  return (
    <ScreenContainer style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Encuentro cancelado" showBack />

      <div className="cs-content-wrapper">

        {/* Encuentro card */}
        <div className="cs-card">
          <div className="cs-card-header">
            <h2 className="cs-card-title">{encuentro.titulo}</h2>
            <Badge label="Cancelado" status="rejected" />
          </div>
          <div className="cs-meta-row"><span className="cs-meta-icon">📅</span><span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span></div>
          <div className="cs-meta-row">
            <span className="cs-meta-icon">{encuentro.modalidad === 'presencial' ? '📍' : '💻'}</span>
            <span>{encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}</span>
          </div>
        </div>

        {/* Nota informativa: el anfitrión debe compartir el aviso manualmente */}
        <div className="cs-info-box">
          <span className="cs-info-icon">ℹ️</span>
          <p className="cs-info-text">
            <strong>El encuentro ya fue cancelado.</strong>
            Ahora compartí el aviso con los invitados para que todos estén informados.
          </p>
        </div>

        <div style={{ flex: 1 }}></div>

        {/* Actions */}
        <div className="cs-actions-container">
          <Button fullWidth variant={copied ? 'secondary' : 'outline'} onClick={handleShareCancel}>
            {copied ? t('share.copied_for_sharing', 'Copiado para compartir') : '📤 Compartir aviso de cancelación'}
          </Button>

          {shareFeedback && (
            <p className="cs-feedback-text">
              {t('share.ready_cancel', 'Listo. Los invitados podrán ver el estado actualizado.')}
            </p>
          )}

          <Button fullWidth variant="primary" onClick={handleCreateNew}>
            ✨ Crear encuentro de reemplazo
          </Button>
          <Button fullWidth variant="ghost" onClick={() => navigate('/')} style={{ color: 'var(--color-on-surface-variant)', border: '1px solid var(--color-outline-variant)' }}>
            Ir al inicio
          </Button>
        </div>
      </div>
    </ScreenContainer>
  );
};

export default CancelSummary;
