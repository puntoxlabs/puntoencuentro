import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate } from '@/lib/formatDate';
import { useDetailStore } from '@/store/detailStore';
import { useTranslation } from 'react-i18next';
import { openExternalVideoLink } from '@/lib/openLink';
import throttle from 'lodash/throttle';
import { getThemeStyle } from '@/lib/themes';
import { useHomeStore } from '@/store/homeStore';

const metaRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 10,
};
const metaIcon: React.CSSProperties = { fontSize: 16, width: 20, textAlign: 'center', flexShrink: 0 };
const linkBox: React.CSSProperties = {
  background: 'var(--color-primary-container)', borderRadius: 12,
  padding: '10px 14px', marginBottom: 12,
  wordBreak: 'break-all', fontSize: 13,
  color: 'var(--color-primary-dark)', fontWeight: 500,
};

const DetailHost: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { getValidCache, setDetailData, setScrollPosition } = useDetailStore();
  const validCache = getValidCache(id!);

  const [encuentro, setEncuentro] = useState<any>(validCache?.encuentro || null);
  const [participantes, setParticipantes] = useState<any[]>(validCache?.participantes || []);
  const [loading, setLoading] = useState(!validCache);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [fromCancelled, setFromCancelled] = useState<any>(null);
  const [copiedNewShare, setCopiedNewShare] = useState(false);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval>;
    if (id) {
      loadData();
      if (validCache && validCache.scrollPosition > 0) {
        requestAnimationFrame(() => {
          const container = document.getElementById('detail-scroll-container');
          if (container) container.scrollTop = validCache.scrollPosition;
        });
      }
      intervalId = setInterval(async () => {
        try {
          const parts = await participantesService.getParticipantesByEncuentro(id);
          setParticipantes(parts || []);
          const currentEnc = useDetailStore.getState().cache[id]?.encuentro;
          if (currentEnc) setDetailData(id, currentEnc, parts || []);
        } catch (err) { console.error('Error polling participants', err); }
      }, 10000);
      // Check if this is a new encounter created from cancellation
      const refStr = sessionStorage.getItem('cancel_reference');
      if (refStr) {
        try {
          const ref = JSON.parse(refStr);
          if (ref.newId === id) {
            setFromCancelled(ref);
            sessionStorage.removeItem('cancel_reference');
          }
        } catch (e) { console.error('Error reading cancel_reference', e); }
      }
    }
    return () => { if (intervalId) clearInterval(intervalId); };
  }, [id]);

  const loadData = async () => {
    try {
      if (!useDetailStore.getState().getValidCache(id!)) setLoading(true);
      setError(null);
      const enc = await encuentrosService.getEncuentroById(id!);
      setEncuentro(enc);
      const parts = await participantesService.getParticipantesByEncuentro(id!);
      setParticipantes(parts || []);
      setDetailData(id!, enc, parts || []);
    } catch (err) {
      console.error('Error loading detail', err);
      setError('No se pudo cargar el encuentro.');
    } finally { setLoading(false); }
  };

  const handleScroll = throttle((e: React.UIEvent<HTMLDivElement>) => {
    if (id) setScrollPosition(id, e.currentTarget.scrollTop);
  }, 200);

  const handleCancelEncuentro = async () => {
    if (!id || cancelling) return;
    try {
      setCancelling(true);
      await encuentrosService.cancelarEncuentro(id);
      useHomeStore.getState().invalidateCache();
      setEncuentro((prev: any) => ({ ...prev, estado: 'cancelado' }));
      setShowCancelModal(false);
      navigate(`/cancel-summary/${id}`);
    } catch (err: any) {
      console.error('[CANCEL] Error en handleCancelEncuentro:');
      console.error('  encuentroId:', id);
      console.error('  err.message:', err?.message);
      console.error('  err.code:', err?.code);
      console.error('  err.hint:', err?.hint);
      console.error('  err completo:', JSON.stringify(err));
      const msg = err?.message || JSON.stringify(err) || 'Error desconocido';
      alert(`Error al cancelar: ${msg}`);
    } finally { setCancelling(false); }
  };

  const handleShareNewEncuentro = async () => {
    if (!encuentro || !fromCancelled) return;
    const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const newLink = encuentro.public_token
      ? `${baseUrl}/join/${encuentro.public_token}`
      : `${baseUrl}/meet/${encuentro.id}`;
    const msg = `El encuentro fue actualizado:\n\n❌ Anterior: ${fromCancelled.oldTitulo} – ${fromCancelled.oldFecha}\n✅ Nuevo: ${encuentro.titulo} – ${formatFriendlyDate(encuentro.fecha, encuentro.hora)}\n\nUnite acá:\n${newLink}`;
    if (navigator.share) {
      try { await navigator.share({ text: msg }); } catch (err) { console.error('Share error:', err); }
    } else {
      try {
        await navigator.clipboard.writeText(msg);
        setCopiedNewShare(true); setTimeout(() => setCopiedNewShare(false), 2000);
      } catch { alert('Error al copiar el mensaje.'); }
    }
  };

  if (loading) return (
    <ScreenContainer>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p>Cargando detalle…</p>
      </div>
    </ScreenContainer>
  );

  if (error || !encuentro) return (
    <ScreenContainer>
      <AppBar title="Error" showBack />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <p>{error || 'Encuentro no encontrado.'}</p>
        <Button onClick={() => navigate('/')} variant="outline">Volver al inicio</Button>
      </div>
    </ScreenContainer>
  );

  const confirmados = participantes.filter(p => p.estado === 'confirmado');
  const pendientes  = participantes.filter(p => p.estado === 'pendiente');
  const rechazados  = participantes.filter(p => p.estado === 'rechazado');

  const handleShareLink = async (token: string, partId: string) => {
    if (!token) return;
    const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const shareUrl = `${baseUrl}/invite/${token}`;
    const shareText = "Te invito a este encuentro 👇 Confirmá si podés asistir:";
    if (navigator.share) {
      try { await navigator.share({ text: shareText, url: shareUrl }); }
      catch (err) { console.error('Error sharing', err); }
    } else {
      try {
        await navigator.clipboard.writeText(shareUrl);
        setCopiedId(partId); setTimeout(() => setCopiedId(null), 2000);
      } catch (err) { console.error('Failed to copy', err); alert('Error al copiar el enlace.'); }
    }
  };

  const handleCopyVideoLink = async () => {
    if (!encuentro?.link_virtual) return;
    try {
      await navigator.clipboard.writeText(encuentro.link_virtual);
      setCopiedLink(true); setTimeout(() => setCopiedLink(false), 2000);
    } catch (err) { console.error('Failed to copy', err); alert('Error al copiar el enlace.'); }
  };

  const renderGroup = (title: string, group: any[], badgeStatus: 'confirmed' | 'pending' | 'rejected') => {
    if (group.length === 0) return null;
    return (
      <div style={{ marginBottom: 20 }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
          {title} · {group.length}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {group.map(p => {
            let timeLabel = '';
            if (p.respondido_en) {
              const d = new Date(p.respondido_en);
              timeLabel = `Respondió ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            } else if (p.creado_en) {
              const d = new Date(p.creado_en);
              timeLabel = `Creado ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            }
            return (
              <div key={p.id} style={{
                background: '#fff', borderRadius: 14, padding: '12px 16px',
                border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 15, display: 'block', marginBottom: 2 }}>{p.nombre_invitado}</span>
                  {timeLabel && <span style={{ fontSize: 12, color: 'var(--color-on-surface-variant)' }}>{timeLabel}</span>}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {p.estado === 'pendiente' && p.token_invitacion && (
                    <button
                      onClick={() => handleShareLink(p.token_invitacion, p.id)}
                      style={{
                        background: copiedId === p.id ? 'var(--color-primary-container)' : 'transparent',
                        border: `1.5px solid ${copiedId === p.id ? 'var(--color-primary)' : 'var(--color-outline-variant)'}`,
                        borderRadius: 8, padding: '4px 10px', cursor: 'pointer',
                        fontFamily: 'var(--font-family)', fontSize: 12, fontWeight: 600,
                        color: copiedId === p.id ? 'var(--color-primary)' : 'var(--color-on-surface-variant)',
                      }}
                    >
                      {copiedId === p.id ? '✓ Copiado' : 'Compartir'}
                    </button>
                  )}
                  <Badge
                    label={p.estado === 'pendiente' ? 'Pendiente' : p.estado === 'confirmado' ? 'Confirmado' : 'No asiste'}
                    status={badgeStatus}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const cancelModal = showCancelModal ? (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div style={{
        background: '#fff', borderRadius: '24px 24px 0 0',
        padding: '28px 24px 40px', width: '100%', maxWidth: 480,
        boxShadow: '0 -4px 30px rgba(0,0,0,0.15)',
      }}>
        <h3 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>¿Cancelar este encuentro?</h3>
        <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 24 }}>
          El encuentro quedará marcado como cancelado. Esta acción no se puede deshacer.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Button
            id="btn-confirmar-cancelacion"
            fullWidth
            variant="primary"
            onClick={handleCancelEncuentro}
            disabled={cancelling}
          >
            {cancelling ? 'Cancelando…' : 'Sí, cancelar encuentro'}
          </Button>
          <Button fullWidth variant="outline" onClick={() => setShowCancelModal(false)} disabled={cancelling}>
            Volver
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <ScreenContainer style={getThemeStyle(encuentro?.tema)}>
      {cancelModal}
      <AppBar title="Detalle" showBack />

      <div
        id="detail-scroll-container"
        onScroll={handleScroll}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingBottom: 16, paddingTop: 16 }}
      >
        {/* Event header card */}
        <div style={{
          background: '#fff', borderRadius: 20, padding: '20px',
          border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
          marginBottom: 16, flexShrink: 0,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, flex: 1, marginRight: 10 }}>{encuentro.titulo}</h2>
            <Badge
              label={encuentro.estado === 'activo' ? 'Activo' : encuentro.estado === 'cancelado' ? 'Cancelado' : encuentro.estado.charAt(0).toUpperCase() + encuentro.estado.slice(1)}
              status={encuentro.estado === 'activo' ? 'confirmed' : encuentro.estado === 'cancelado' ? 'rejected' : 'default'}
            />
          </div>

          <div style={metaRow}><span style={metaIcon}>📅</span><span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span></div>
          <div style={metaRow}>
            <span style={metaIcon}>{encuentro.modalidad === 'presencial' ? '📍' : '💻'}</span>
            <span>{encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}</span>
          </div>

          {encuentro.modalidad === 'virtual' && encuentro.link_virtual && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={linkBox}>{encuentro.link_virtual}</div>
              <Button fullWidth onClick={() => openExternalVideoLink(encuentro.link_virtual)}>
                {t('open_video_call', 'Abrir videollamada')}
              </Button>
              <Button fullWidth variant="outline" onClick={handleCopyVideoLink}>
                {copiedLink ? t('link_copied', 'Link copiado.') : t('copy_link', 'Copiar link')}
              </Button>
            </div>
          )}

          {encuentro.descripcion && (
            <p style={{ marginTop: 12, fontSize: 14, fontStyle: 'italic', color: 'var(--color-on-surface-variant)' }}>
              {encuentro.descripcion}
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ marginBottom: 24, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {encuentro.estado !== 'cancelado' && encuentro.tipo_invitacion === 'link_general' && (
            <Button fullWidth onClick={() => navigate(`/share/${encuentro.id}`)}>
              🔗 Compartir link de invitación
            </Button>
          )}
          {encuentro.estado !== 'cancelado' && encuentro.tipo_invitacion === 'individual' && (
            <Button fullWidth onClick={() => navigate(`/add-guests/${encuentro.id}`)}>
              + Agregar invitados
            </Button>
          )}
          {encuentro.estado !== 'cancelado' && (
            <button
              id="btn-cancelar-encuentro"
              onClick={() => setShowCancelModal(true)}
              style={{
                background: 'none', border: '1.5px solid rgba(220,38,38,0.35)',
                borderRadius: 12, padding: '12px 16px', cursor: 'pointer',
                fontFamily: 'var(--font-family)', fontSize: 14, fontWeight: 600,
                color: '#DC2626', width: '100%', textAlign: 'center',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(220,38,38,0.05)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              Cancelar encuentro
            </button>
          )}
          {encuentro.estado === 'cancelado' && (
            <Button fullWidth variant="outline" onClick={() => navigate(`/cancel-summary/${encuentro.id}`)}>
              Ver detalle de cancelación
            </Button>
          )}
        </div>

        {/* Banner: nuevo encuentro creado desde cancelación */}
        {fromCancelled && (
          <div style={{
            background: 'var(--color-primary-container)',
            border: '1px solid var(--color-primary)',
            borderRadius: 16, padding: '16px',
            marginBottom: 16, flexShrink: 0,
          }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-primary-dark)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Referencia del encuentro anterior</p>
            <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', marginBottom: 12 }}>
              ❌ {fromCancelled.oldTitulo} – {fromCancelled.oldFecha}
            </p>
            {fromCancelled.participantes && fromCancelled.participantes.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {fromCancelled.participantes
                  .filter((p: any) => fromCancelled.tipoInvitacion === 'individual' || p.estado === 'confirmado')
                  .map((p: any, i: number) => {
                    const s = p.estado === 'confirmado' ? 'confirmed' : p.estado === 'rechazado' ? 'rejected' : 'pending';
                    const l = p.estado === 'confirmado' ? 'Confirmado' : p.estado === 'rechazado' ? 'No asiste' : 'Pendiente';
                    return (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.7)', borderRadius: 8, padding: '6px 10px' }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{p.nombre_invitado}</span>
                        <Badge label={l} status={s as any} />
                      </div>
                    );
                  })}
              </div>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', fontStyle: 'italic', marginBottom: 12 }}>Sin participantes registrados en el encuentro anterior.</p>
            )}
            <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', marginBottom: 12 }}>Recordá compartir el nuevo encuentro con estas personas o con el mismo grupo.</p>
            <Button fullWidth onClick={handleShareNewEncuentro}>
              {copiedNewShare ? '✓ Copiado' : '📤 Compartir nuevo encuentro'}
            </Button>
          </div>
        )}

        {/* Participants */}
        <div>
          <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 16 }}>Participantes</h3>

          {participantes.length === 0 ? (
            <div style={{
              background: '#fff', borderRadius: 14, padding: '24px',
              border: '1.5px dashed var(--color-outline-variant)', textAlign: 'center',
            }}>
              <p style={{ margin: 0, fontSize: 14 }}>Aún no hay participantes en este encuentro.</p>
            </div>
          ) : (
            <>
              {renderGroup('Confirmados', confirmados, 'confirmed')}
              {renderGroup('No asisten', rechazados, 'rejected')}
              {renderGroup('Pendientes', pendientes, 'pending')}
            </>
          )}
        </div>
      </div>
    </ScreenContainer>
  );
};

export default DetailHost;
