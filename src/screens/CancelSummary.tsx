import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate } from '@/lib/formatDate';
import { getThemeStyle } from '@/lib/themes';
import { useWizardStore } from '@/store/wizardStore';

const metaRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 8,
};
const metaIcon: React.CSSProperties = { fontSize: 16, width: 20, textAlign: 'center', flexShrink: 0 };

const CancelSummary: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
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
      const enc = await encuentrosService.getEncuentroById(id!);
      setEncuentro(enc);
      const parts = await participantesService.getParticipantesByEncuentro(id!);
      setParticipantes(parts || []);
    } catch (err) {
      console.error('CancelSummary error:', err);
      setError('No se pudo cargar el encuentro.');
    } finally { setLoading(false); }
  };

  const buildShareLink = (enc: any): string => {
    const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    return enc.public_token
      ? `${baseUrl}/join/${enc.public_token}`
      : `${baseUrl}/meet/${enc.id}`;
  };

  const handleShareCancel = async () => {
    if (!encuentro) return;
    const shareLink = buildShareLink(encuentro);
    const msg = `Este encuentro fue cancelado.\n\n${encuentro.titulo} – ${formatFriendlyDate(encuentro.fecha, encuentro.hora)}\n\nVer estado:\n${shareLink}`;

    if (navigator.share) {
      try { await navigator.share({ text: msg }); } catch (err) { console.error('Share error:', err); }
    } else {
      try {
        await navigator.clipboard.writeText(msg);
        setCopied(true); setTimeout(() => setCopied(false), 2000);
      } catch { alert('Error al copiar el mensaje.'); }
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
        <Button onClick={() => navigate('/')} variant="outline">Volver al inicio</Button>
      </div>
    </ScreenContainer>
  );

  const confirmados = participantes.filter(p => p.estado === 'confirmado');
  const pendientes = participantes.filter(p => p.estado === 'pendiente');
  const rechazados = participantes.filter(p => p.estado === 'rechazado');
  const esIndividual = encuentro.tipo_invitacion === 'individual';

  const renderRow = (p: any, index: number) => {
    const s = p.estado === 'confirmado' ? 'confirmed' : p.estado === 'rechazado' ? 'rejected' : 'pending';
    const l = p.estado === 'confirmado' ? 'Confirmado' : p.estado === 'rechazado' ? 'No asiste' : 'Pendiente';
    return (
      <div key={`${p.nombre_invitado}-${index}`} style={{
        background: '#fff', borderRadius: 12, padding: '10px 14px',
        border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{p.nombre_invitado}</span>
        <Badge label={l} status={s as any} />
      </div>
    );
  };

  const participantesVisibles = esIndividual
    ? [...confirmados, ...pendientes, ...rechazados]
    : confirmados;

  const sinParticipantes = participantesVisibles.length === 0;

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
          <Button fullWidth variant="outline" onClick={handleShareCancel}>
            {copied ? '✓ Copiado' : '📤 Compartir cancelación'}
          </Button>
          <Button fullWidth variant="primary" onClick={handleCreateNew}>
            ✨ Cancelar y crear uno nuevo
          </Button>
        </div>
      </div>
    </ScreenContainer>
  );
};

export default CancelSummary;
