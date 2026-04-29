import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { MoreVertical } from 'lucide-react';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate } from '@/lib/formatDate';
import { useDetailStore } from '@/store/detailStore';
import { openExternalVideoLink } from '@/lib/openLink';
import throttle from 'lodash/throttle';
import { getThemeStyle } from '@/lib/themes';
import { useHomeStore } from '@/store/homeStore';

/** Devuelve true si la fecha+hora del encuentro ya pasó (con 2 horas de gracia para permitir "En curso ahora") */
function isEncuentroPasado(enc: any): boolean {
  if (!enc?.fecha || !enc?.hora) return false;
  const fechaHora = new Date(`${enc.fecha}T${enc.hora}`);
  fechaHora.setHours(fechaHora.getHours() + 2);
  return fechaHora < new Date();
}

const DetailHost: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
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
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

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
      
      // Refetch obligatorio para asegurar datos reales de Supabase
      const updatedEnc = await encuentrosService.getEncuentroById(id);
      
      useHomeStore.getState().invalidateCache();
      setEncuentro(updatedEnc);
      useDetailStore.getState().setDetailData(id, updatedEnc, participantes);
      
      setShowCancelModal(false);
      navigate(`/cancel-summary/${id}`);
    } catch (err: any) {
      console.error('[DetailHost] Error cancelando encuentro:', err);
      alert(`Error al cancelar: ${err?.message || 'Error desconocido'}`);
    } finally { setCancelling(false); }
  };

  const handleDeleteEncuentro = async () => {
    if (!id) return;
    try {
      setIsDeleting(true);
      await encuentrosService.deleteEncuentro(id);
      useHomeStore.getState().invalidateCache();
      setShowDeleteModal(false);
      navigate('/');
    } catch (err: any) {
      console.error('[DetailHost] Error eliminando encuentro:', err);
      alert(`Error al eliminar: ${err?.message || 'Error desconocido'}`);
    } finally { setIsDeleting(false); }
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

  const isCancelado  = encuentro.estado === 'cancelado';
  const isFinalizado = !isCancelado && isEncuentroPasado(encuentro);
  const isReadOnly   = isFinalizado;
  const isVirtual    = encuentro.modalidad === 'virtual';

  const getEventStatusBadge = () => {
    if (isCancelado) return { label: 'Cancelado', bg: '#FEE2E2', color: '#B91C1C' };
    if (!encuentro.fecha || !encuentro.hora) return { label: 'Activo', bg: 'var(--color-primary-container)', color: 'var(--color-primary-dark)' };

    const now = new Date();
    const eventDate = new Date(`${encuentro.fecha}T${encuentro.hora}`);
    const diffMinutes = Math.round((eventDate.getTime() - now.getTime()) / 60000);
    
    if (diffMinutes < -120) return { label: 'Finalizado', bg: '#F3F4F6', color: '#4B5563' };
    if (diffMinutes <= 0) return { label: '🟢 En curso ahora', bg: '#D1FAE5', color: '#047857' };
    if (diffMinutes <= 15) return { label: '🟢 Listo para unirte', bg: '#D1FAE5', color: '#047857' };
    if (diffMinutes <= 60) return { label: `🟡 Empieza en ${diffMinutes} min`, bg: '#FEF3C7', color: '#B45309' };
    
    return { label: 'Activo', bg: 'var(--color-primary-container)', color: 'var(--color-primary-dark)' };
  };

  const badge = getEventStatusBadge();

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

  const renderParticipantList = (title: string, list: any[]) => {
    if (list.length === 0) return null;
    return (
      <div style={{ marginBottom: 20 }}>
        <h4 style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
          {title}
        </h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {list.map(p => {
            const avatarChar = p.nombre_invitado ? p.nombre_invitado.charAt(0).toUpperCase() : '?';
            const sColor = p.estado === 'confirmado' ? '#059669' : p.estado === 'rechazado' ? '#DC2626' : '#6B7280';
            const sLabel = p.estado === 'confirmado' ? '✔ Confirmado' : p.estado === 'rechazado' ? '✖ No asiste' : 'Pendiente';
            const bgAvatar = p.estado === 'confirmado' ? '#D1FAE5' : p.estado === 'rechazado' ? '#FEE2E2' : '#F3F4F6';
            const fgAvatar = p.estado === 'confirmado' ? '#047857' : p.estado === 'rechazado' ? '#B91C1C' : '#4B5563';

            return (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 38, height: 38, borderRadius: 19,
                  background: bgAvatar, color: fgAvatar,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, fontSize: 15, flexShrink: 0
                }}>
                  {avatarChar}
                </div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600, fontSize: 15, color: '#111827' }}>{p.nombre_invitado}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {!isReadOnly && !isCancelado && p.estado === 'pendiente' && p.token_invitacion && (
                    <button
                      onClick={() => handleShareLink(p.token_invitacion, p.id)}
                      style={{
                        background: 'none', border: 'none',
                        color: copiedId === p.id ? 'var(--color-primary)' : 'var(--color-outline-variant)',
                        fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '4px 8px'
                      }}
                    >
                      {copiedId === p.id ? 'Copiado' : 'Recordar'}
                    </button>
                  )}
                  <span style={{ fontSize: 13, color: sColor, fontWeight: 500 }}>
                    {sLabel}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const getDeleteModalMessage = () => {
    let msg = '';
    if (participantes.length > 0) {
      msg += 'Este encuentro ya fue compartido. Las personas invitadas perderán acceso. ';
    }
    if (badge.label.includes('Activo') || badge.label.includes('En curso') || badge.label.includes('Listo') || badge.label.includes('Empieza')) {
      msg += 'Este encuentro está activo o próximo a realizarse. ';
    }
    msg += '¿Querés eliminarlo?';
    return msg;
  };

  const deleteModal = showDeleteModal ? (
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
        <h3 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>¿Eliminar encuentro?</h3>
        <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 24 }}>
          {getDeleteModalMessage()}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Button fullWidth variant="primary" style={{ background: '#DC2626', color: '#fff' }} onClick={handleDeleteEncuentro} disabled={isDeleting}>
            {isDeleting ? 'Eliminando…' : 'Eliminar'}
          </Button>
          <Button fullWidth variant="outline" onClick={() => setShowDeleteModal(false)} disabled={isDeleting}>
            Cancelar
          </Button>
        </div>
      </div>
    </div>
  ) : null;

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
          <Button fullWidth variant="primary" onClick={handleCancelEncuentro} disabled={cancelling}>
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
      {deleteModal}
      <AppBar
        title=""
        showBack
        rightAction={
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setShowContextMenu(!showContextMenu)}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 36, height: 36, borderRadius: '50%',
                color: '#111827'
              }}
            >
              <MoreVertical size={20} />
            </button>
            {showContextMenu && (
              <>
                <div
                  onClick={() => setShowContextMenu(false)}
                  style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 }}
                />
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4,
                  background: '#fff', border: '1px solid rgba(0,0,0,0.08)',
                  borderRadius: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                  zIndex: 100, width: 140, padding: '4px 0'
                }}>
                  <button
                    onClick={() => { setShowContextMenu(false); setShowDeleteModal(true); }}
                    style={{
                      width: '100%', padding: '12px 16px', border: 'none',
                      background: 'transparent', color: '#DC2626', fontWeight: 600,
                      fontSize: 14, textAlign: 'left', cursor: 'pointer'
                    }}
                  >
                    Eliminar
                  </button>
                </div>
              </>
            )}
          </div>
        }
      />

      <div
        id="detail-scroll-container"
        onScroll={handleScroll}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '16px 20px 40px' }}
      >
        {/* 1. HEADER EVENTO */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 28, fontWeight: 800, lineHeight: 1.15, color: '#111827', flex: 1, marginRight: 12 }}>
              {encuentro.titulo}
            </h2>
            <div style={{
              background: badge.bg, color: badge.color,
              padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700,
              whiteSpace: 'nowrap'
            }}>
              {badge.label}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#4B5563', fontSize: 15 }}>
              <span>📅</span> <span style={{ fontWeight: 500 }}>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#4B5563', fontSize: 15 }}>
              <span>{isVirtual ? '💻' : '📍'}</span> <span>{isVirtual ? 'Virtual' : (encuentro.lugar_texto || 'Presencial')}</span>
            </div>
            {encuentro.descripcion && (
              <div style={{ marginTop: 8, fontSize: 14, color: '#6B7280', fontStyle: 'italic' }}>
                {encuentro.descripcion}
              </div>
            )}
          </div>
        </div>

        {/* MODO SOLO LECTURA BANNER */}
        {isReadOnly && (
          <div style={{
            background: 'rgba(0,0,0,0.03)', borderRadius: 10, padding: '10px 14px',
            marginBottom: 24, display: 'flex', alignItems: 'center', gap: 8,
            border: '1px solid rgba(0,0,0,0.06)'
          }}>
            <span style={{ fontSize: 16 }}>🔒</span>
            <span style={{ fontSize: 13, color: '#4B5563', fontWeight: 500 }}>
              Este encuentro ya finalizó. No se puede modificar.
            </span>
          </div>
        )}

        {/* 2. CTA PRINCIPAL */}
        {!isReadOnly && !isCancelado && (
          <div style={{ marginBottom: 16 }}>
            {isVirtual ? (
              <Button fullWidth style={{ height: 54, fontSize: 16, fontWeight: 700 }} onClick={() => openExternalVideoLink(encuentro.link_virtual)}>
                Unirme a la videollamada
              </Button>
            ) : (
              <Button fullWidth style={{ height: 54, fontSize: 16, fontWeight: 700 }} onClick={() => navigate(encuentro.tipo_invitacion === 'individual' ? `/add-guests/${encuentro.id}` : `/share/${encuentro.id}`)}>
                Invitar personas
              </Button>
            )}
          </div>
        )}

        {/* 3. LINK COMPACTO (Solo virtual) */}
        {!isCancelado && isVirtual && encuentro.link_virtual && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: '#F3F4F6', borderRadius: 10, padding: '10px 14px', marginBottom: isReadOnly ? 32 : 16
          }}>
            <span style={{ fontSize: 13, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 12 }}>
              🔗 {encuentro.link_virtual.replace(/^https?:\/\//, '')}
            </span>
            {!isReadOnly && (
              <button onClick={handleCopyVideoLink} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: '4px 8px' }}>
                {copiedLink ? 'Copiado' : 'Copiar enlace'}
              </button>
            )}
          </div>
        )}

        {/* 4. ACCIONES SECUNDARIAS */}
        {!isReadOnly && !isCancelado && isVirtual && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 32 }}>
            <button
              onClick={() => navigate(encuentro.tipo_invitacion === 'individual' ? `/add-guests/${encuentro.id}` : `/share/${encuentro.id}`)}
              style={{
                flex: 1, padding: 12, borderRadius: 10,
                background: 'var(--color-primary-container)', color: 'var(--color-primary-dark)',
                fontWeight: 600, border: 'none', fontSize: 14, cursor: 'pointer',
                transition: 'background 0.15s ease'
              }}
            >
              Invitar personas
            </button>
          </div>
        )}

        {/* BANNER REPETIR CANCELADO */}
        {fromCancelled && (
          <div style={{
            background: 'var(--color-primary-container)',
            border: '1px solid var(--color-primary)',
            borderRadius: 16, padding: '16px',
            marginBottom: 32, flexShrink: 0,
          }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-primary-dark)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Encuentro anterior</p>
            <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', marginBottom: 12 }}>
              ❌ {fromCancelled.oldTitulo} – {fromCancelled.oldFecha}
            </p>
            <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', marginBottom: 12 }}>Recordá compartir el nuevo enlace con los participantes.</p>
            <Button fullWidth onClick={handleShareNewEncuentro}>
              {copiedNewShare ? '✓ Copiado' : '📤 Compartir nuevo enlace'}
            </Button>
          </div>
        )}

        {/* 5. PARTICIPANTES */}
        <div style={{ marginBottom: 40 }}>
          <h3 style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginBottom: 20 }}>
            Participantes <span style={{ color: '#6B7280', fontWeight: 500, fontSize: 16 }}>({confirmados.length} confirmados)</span>
          </h3>

          {participantes.length === 0 ? (
            <p style={{ margin: 0, fontSize: 14, color: '#6B7280', fontStyle: 'italic' }}>Aún no hay participantes registrados.</p>
          ) : (
            <>
              {renderParticipantList('Confirmados', confirmados)}
              {renderParticipantList('Pendientes', pendientes)}
              {renderParticipantList('No asisten', rechazados)}
            </>
          )}
        </div>

        {/* 6. CANCELAR ENCUENTRO */}
        {!isCancelado && !isReadOnly && (
          <div style={{ marginTop: 'auto', paddingTop: 32, textAlign: 'center' }}>
            <button
              onClick={() => setShowCancelModal(true)}
              style={{
                background: 'none', border: 'none',
                color: '#DC2626', fontSize: 14, fontWeight: 600,
                padding: '12px 24px', cursor: 'pointer',
                opacity: 0.8
              }}
            >
              Cancelar encuentro
            </button>
          </div>
        )}
      </div>
    </ScreenContainer>
  );
};

export default DetailHost;
