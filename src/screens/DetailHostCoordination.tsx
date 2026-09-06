import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { encuentrosService } from '@/services/encuentrosService';
import type { CoordinationHostDetail } from '@/services/encuentrosService';
import { Clock, MapPin, Video, Link, Users, Share2, Plus, ChevronDown, ChevronUp } from 'lucide-react';
import { formatFriendlyDate, formatFriendlyDeadline } from '@/lib/formatDate';
import { isMobileShareEnvironment, buildGeneralInvitationUrl } from '@/lib/shareHelper';
import { useTranslation } from 'react-i18next';
import { formatCoordinationDuration } from '@/lib/formatDuration';
import { useAuth } from '@/contexts/AuthContext';
import { OrganizerMessageSheet } from '@/components/ui/OrganizerMessageSheet';

const DetailHostCoordination: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [detail, setDetail] = useState<CoordinationHostDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [confirmModalOption, setConfirmModalOption] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  const { user } = useAuth();
  const hostId = user?.id;
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [personalMessage, setPersonalMessage] = useState('');
  const [activeShareTarget, setActiveShareTarget] = useState<'general' | 'confirmed' | null>(null);

  const [savingVisibilidad, setSavingVisibilidad] = useState(false);
  const [visibilidadFeedback, setVisibilidadFeedback] = useState<'ok' | 'error' | null>(null);
  const [showResponsesDetail, setShowResponsesDetail] = useState(false);

  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancellingMode, setCancellingMode] = useState<'cancel' | 'create' | null>(null);
  
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const loadData = useCallback(async (isPolling = false) => {
    if (!id) return;
    try {
      if (!isPolling) setLoading(true);
      if (!isPolling) setError(null);
      const data = await encuentrosService.getCoordinacionHost(id);
      if (data && data.ok) {
        setDetail(data);
      } else {
        if (!isPolling) setError(data.error || 'No se pudo cargar la coordinación.');
      }
    } catch (err: any) {
      console.error('[DetailHostCoordination] Error:', err);
      if (!isPolling) setError('Ocurrió un error al cargar la coordinación.');
    } finally {
      if (!isPolling) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData(false);
    const interval = setInterval(() => {
      loadData(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  if (loading) {
    return (
      <ScreenContainer>
        <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <p>Cargando coordinación...</p>
        </div>
      </ScreenContainer>
    );
  }

  if (error || !detail || !detail.encuentro) {
    return (
      <ScreenContainer>
        <AppBar title="Coordinación" showBack onBack={() => navigate('/')} />
        <div style={{ padding: 20, textAlign: 'center' }}>
          <p style={{ color: 'var(--pe-error)', marginBottom: 16 }}>{error || 'No se encontró la coordinación.'}</p>
          <Button variant="outline" onClick={() => navigate('/')}>Volver al inicio</Button>
        </div>
      </ScreenContainer>
    );
  }

  const { encuentro, opciones, response_deadline } = detail;
  const isLinkGeneral = encuentro.tipo_invitacion === 'link_general';

  const shareUrl = buildGeneralInvitationUrl(encuentro.public_token, 'coordination');

  const handleShare = async () => {
    if (isLinkGeneral) {
      if (!shareUrl) {
        console.error('[DetailHostCoordination] Cannot share: Missing public_token');
        return;
      }
      setActiveShareTarget('general');
      setIsSheetOpen(true);
    } else {
      navigate(`/add-guests/${encuentro.id}`);
    }
  };

  const executeShareGeneral = async () => {
    if (!shareUrl) return;
    let shareText = `Hola 👋\n\nTe invito a coordinar la fecha para "${encuentro.titulo}" en PuntoEncuentro.\n\n`;
    if (personalMessage.trim()) {
      shareText += `${personalMessage.trim()}\n\n`;
    }
    shareText += `👉 Respondé tu disponibilidad acá:`;

    const shareData = {
      title: `Coordinar fecha: ${encuentro.titulo}`,
      text: shareText,
      url: shareUrl,
    };

    try {
      if (isMobileShareEnvironment()) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(`${shareText}\n${shareUrl}`);
        alert('¡Link copiado al portapapeles!');
      }
    } catch (err) {
      console.error('Error sharing:', err);
    }
  };

  const handleShareConfirmedDate = async () => {
    if (!detail.fecha || !detail.hora) return;
    setActiveShareTarget('confirmed');
    setIsSheetOpen(true);
  };

  const executeShareConfirmedDate = async () => {
    if (!detail.fecha || !detail.hora) return;
    const formattedDate = formatFriendlyDate(detail.fecha, detail.hora);
    
    let locationText = '';
    if (encuentro.modalidad === 'presencial' && encuentro.lugar_texto) {
      locationText = `📍 ${encuentro.lugar_texto}`;
    } else if (encuentro.modalidad === 'virtual' && encuentro.link_virtual) {
      locationText = `🔗 Enlace de reunión:\n${encuentro.link_virtual}`;
    }

    const confirmUrl = shareUrl || '';

    let shareText = `Fecha confirmada ✅\n\nEl encuentro "${encuentro.titulo}" quedó confirmado para:\n${formattedDate}`;
    if (locationText) shareText += `\n\n${locationText}`;
    if (personalMessage.trim()) shareText += `\n\n${personalMessage.trim()}`;
    if (confirmUrl) shareText += `\n\nConfirmá tu asistencia acá:\n${confirmUrl}`;
    shareText += `\n\nNos vemos ahí.`;

    const shareData: ShareData = {
      title: `Fecha confirmada: ${encuentro.titulo}`,
      text: shareText,
      ...(confirmUrl ? { url: confirmUrl } : {})
    };

    try {
      if (isMobileShareEnvironment()) {
        await navigator.share(shareData);
      } else {
        const fullText = confirmUrl ? `${shareText}` : shareText;
        await navigator.clipboard.writeText(fullText);
        alert('¡Texto copiado al portapapeles!');
      }
    } catch (err) {
      console.error('Error sharing confirmed date:', err);
    }
  };

  const handleSavePersonalMessage = async (msg: string) => {
    setPersonalMessage(msg);
    // Este mensaje solo se usa para compartir, no se guarda en DB
    
    // Proceder a compartir según el target activo
    setIsSheetOpen(false);
    // Un pequeño timeout para asegurar que el modal se cierre antes de invocar la API share nativa
    setTimeout(() => {
      if (activeShareTarget === 'general') {
        executeShareGeneral();
      } else if (activeShareTarget === 'confirmed') {
        executeShareConfirmedDate();
      }
      setActiveShareTarget(null);
    }, 150);
  };

  const handleConfirmOption = async (optionId: string) => {
    setIsClosing(true);
    
    try {
      const res = await encuentrosService.cerrarCoordinacionHost(encuentro.id, optionId);
      if (res.ok) {
        setConfirmModalOption(null);
        await loadData(false);
      } else {
        console.error('[DetailHostCoordination] Error al cerrar:', res.error);
        if (res.error === 'invalid_option') {
          alert('No se pudo confirmar la opción seleccionada. Actualizá la pantalla e intentá nuevamente.');
        } else if (res.error === 'unauthorized') {
          alert('No tenés permisos para cerrar esta coordinación.');
        } else if (res.error === 'already_closed') {
          alert('Esta coordinación ya fue cerrada.');
        } else if (res.error === 'invalid_date_mode') {
          alert('Este encuentro no está en modo coordinación.');
        } else if (res.error === 'not_found') {
          alert('El encuentro no existe o fue eliminado.');
        } else if (res.error === 'option_already_expired') {
          alert('Esta opción ya pasó y no puede confirmarse. Actualizá la pantalla e intentá con otra.');
          await loadData(false);
        } else {
          alert(`No pudimos confirmar la fecha. Detalle técnico: ${res.error}. Intentá nuevamente.`);
        }
      }
    } catch (err) {
      console.error('[DetailHostCoordination] Excepcion no controlada al cerrar:', err);
      alert('Ocurrió un error inesperado al confirmar la fecha.');
    } finally {
      setIsClosing(false);
    }
  };

  const handleSetVisibilidad = async (newVal: 'hidden' | 'summary' | 'detail') => {
    if (!id || !hostId) return;
    setSavingVisibilidad(true);
    setVisibilidadFeedback(null);
    try {
      const res = await encuentrosService.setVisibilidadRespuestasInvitados(id, hostId, newVal);
      if (res.ok) {
        setVisibilidadFeedback('ok');
        setDetail((prev: any) => prev ? {
          ...prev,
          encuentro: {
            ...prev.encuentro,
            visibilidad_respuestas_invitados: newVal,
            mostrar_respuestas_a_invitados: newVal !== 'hidden'
          }
        } : prev);
        setTimeout(() => setVisibilidadFeedback(null), 3000);
      } else {
        setVisibilidadFeedback('error');
      }
    } catch (err) {
      console.error('[DetailHostCoordination] Error guardando visibilidad', err);
      setVisibilidadFeedback('error');
    } finally {
      setSavingVisibilidad(false);
    }
  };

  const handleCancelEncuentro = async () => {
    if (!id || !hostId) return;
    setCancelling(true);
    try {
      await encuentrosService.cancelarEncuentro(id, hostId);
      setShowCancelModal(false);
      setCancellingMode(null);
      await loadData(false);
    } catch (err) {
      console.error('Error cancelando', err);
      alert('No se pudo cancelar el encuentro. Intentá nuevamente.');
    } finally {
      setCancelling(false);
    }
  };

  const handleDeleteEncuentro = async () => {
    if (!id || !hostId) return;
    setIsDeleting(true);
    try {
      await encuentrosService.deleteEncuentro(id, hostId);
      navigate('/', { replace: true });
    } catch (err) {
      console.error('Error eliminando', err);
      alert('No se pudo eliminar el encuentro. Intentá nuevamente.');
      setIsDeleting(false);
    }
  };

  const derivedStatus = detail.derived_status;

  // Calculate recommended option
  let recommendedOptionId: string | null = null;
  if (opciones && opciones.length > 0 && detail.participantes && detail.participantes.length > 0) {
    const hasAnyResponse = detail.participantes.some(p => p.respondio_disponibilidad);
    if (hasAnyResponse) {
      const sorted = [...opciones].sort((a, b) => {
        // 1. Mayor Sí
        if (a.available_count !== b.available_count) return b.available_count - a.available_count;
        // 2. Mayor Preferida
        const aPref = detail.participantes!.filter(p => p.respuestas.find(r => r.opcion_fecha_id === a.id)?.es_preferida).length;
        const bPref = detail.participantes!.filter(p => p.respuestas.find(r => r.opcion_fecha_id === b.id)?.es_preferida).length;
        if (aPref !== bPref) return bPref - aPref;
        // 3. Mayor Tal vez
        if (a.maybe_count !== b.maybe_count) return b.maybe_count - a.maybe_count;
        // 4. Menor No
        if (a.unavailable_count !== b.unavailable_count) return a.unavailable_count - b.unavailable_count;
        // 5. Más temprana
        return a.orden - b.orden;
      });
      recommendedOptionId = sorted[0].id;
    }
  }

  // Compute effective state for a participant when coordination is closed
  const getParticipanteEstadoEfectivo = (part: any) => {
    if (derivedStatus !== 'closed') return part.estado;
    
    // Respuesta final explícita posterior al cierre tiene prioridad
    if (part.estado === 'confirmado' || part.estado === 'rechazado') {
      return part.estado;
    }

    const selectedOptionId = detail.selected_option_id;
    if (!selectedOptionId) return part.estado;

    const respuesta = part.respuestas?.find((r: any) => r.opcion_fecha_id === selectedOptionId);
    if (!respuesta) return 'pendiente';
    
    if (respuesta.respuesta === 'available') return 'confirmado';
    if (respuesta.respuesta === 'unavailable') return 'rechazado';
    
    // Tal vez (maybe) u otra queda como pendiente
    return 'pendiente';
  };

  return (
    <ScreenContainer>
      <AppBar title="Coordinación" showBack onBack={() => navigate('/')} />

      <div style={{ padding: '20px', paddingBottom: '160px', background: '#F8FAFC', minHeight: '100vh' }}>
        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            {derivedStatus === 'closed' ? (
              <span style={{ backgroundColor: '#dcfce7', color: '#166534', padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Fecha confirmada
              </span>
            ) : derivedStatus === 'expired_unconfirmed' ? (
              <span style={{ backgroundColor: '#f1f5f9', color: '#475569', padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Coordinación finalizada
              </span>
            ) : derivedStatus === 'deadline_passed' ? (
              <span style={{ backgroundColor: '#ffedd5', color: '#c2410c', padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Plazo vencido
              </span>
            ) : (
              <span style={{ backgroundColor: '#eef2ff', color: '#4f46e5', padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Esperando respuestas
              </span>
            )}
          </div>

          <h1 style={{ fontSize: 26, fontWeight: 800, margin: '0 0 8px 0', color: '#0f172a', letterSpacing: '-0.5px' }}>
            {encuentro.titulo}
          </h1>

          {encuentro.descripcion && (
            <p style={{ fontSize: 16, color: '#475569', marginBottom: 28, lineHeight: 1.6 }}>
              {encuentro.descripcion}
            </p>
          )}

          {!shareUrl && isLinkGeneral && (
            <div style={{ backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', padding: '16px', borderRadius: 16, marginBottom: 24 }}>
              <h4 style={{ color: '#1e3a8a', margin: '0 0 8px 0', fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Link size={18} />
                El enlace todavía no está disponible
              </h4>
              <p style={{ color: '#1e40af', margin: '0 0 8px 0', fontSize: 14 }}>
                Esta coordinación se creó correctamente, pero el enlace para invitados requiere una actualización pendiente del sistema.
              </p>
              <p style={{ color: '#1e40af', margin: 0, fontSize: 13, opacity: 0.9 }}>
                La función de coordinación continúa en preparación y todavía no está habilitada en producción.
              </p>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {derivedStatus === 'closed' && detail.fecha && detail.hora && (
              <div style={{ backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0', padding: '24px', borderRadius: 20, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 8px 24px rgba(22,163,74,0.08)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ color: '#166534', fontWeight: 700, fontSize: 18 }}>Fecha confirmada ✅</span>
                </div>
                <div>
                  <span style={{ color: '#14532d', fontWeight: 800, fontSize: 16 }}>
                    {formatFriendlyDate(detail.fecha, detail.hora)}
                  </span>
                </div>
              </div>
            )}

            {derivedStatus === 'deadline_passed' && (
              <div style={{ backgroundColor: '#fffbeb', border: '1px solid #fde68a', padding: '20px', borderRadius: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Clock size={20} color="#d97706" />
                  <span style={{ color: '#b45309', fontWeight: 700, fontSize: 16 }}>Plazo vencido</span>
                </div>
                <span style={{ color: '#92400e', fontSize: 15, lineHeight: 1.5 }}>
                  Ya no se reciben nuevas disponibilidades. Elegí una fecha para confirmar el encuentro.
                </span>
              </div>
            )}

            {derivedStatus === 'expired_unconfirmed' && (
              <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', padding: '20px', borderRadius: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 20 }}>📋</span>
                  <span style={{ color: '#334155', fontWeight: 700, fontSize: 16 }}>Coordinación finalizada sin fecha confirmada</span>
                </div>
                <span style={{ color: '#64748b', fontSize: 15, lineHeight: 1.5 }}>
                  Las fechas propuestas ya pasaron y no se confirmó el encuentro.
                </span>
              </div>
            )}

            {/* Card 1: General Info */}
            <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)' }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 20px 0', color: '#0f172a', paddingBottom: 16, borderBottom: '1px solid rgba(15,23,42,0.05)' }}>
                Información general
              </h3>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{ background: '#E0F2FE', padding: 8, borderRadius: 10 }}>
                    {encuentro.modalidad === 'presencial' ? <MapPin size={18} color="#0284C7" /> : <Video size={18} color="#0284C7" />}
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                      {encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}
                    </span>
                    <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                      {encuentro.modalidad === 'presencial' ? encuentro.lugar_texto : encuentro.link_virtual}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{ background: '#EDE9FE', padding: 8, borderRadius: 10 }}>
                    {isLinkGeneral ? <Link size={18} color="#7C3AED" /> : <Users size={18} color="#7C3AED" />}
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                      Tipo de invitación
                    </span>
                    <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                      {isLinkGeneral ? 'Link general' : 'Invitados individuales'}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{ background: '#DCFCE7', padding: 8, borderRadius: 10 }}>
                    <Clock size={18} color="#16A34A" />
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                      Duración
                    </span>
                    <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                      {formatCoordinationDuration(encuentro.duration_minutes, t) || 'Flexible'}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{ background: '#FCE7F3', padding: 8, borderRadius: 10 }}>
                    <Clock size={18} color="#DB2777" />
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                      Plazo para responder
                    </span>
                    <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                      {response_deadline ? formatFriendlyDeadline(response_deadline) : 'Sin plazo definido'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Card 1.5: Opciones del encuentro — Visibilidad para invitados */}
            {derivedStatus !== 'closed' && derivedStatus !== 'expired_unconfirmed' && (
              <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)', marginBottom: 24 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 16 }}>
                  Visibilidad para invitados
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div 
                    onClick={() => !savingVisibilidad && handleSetVisibilidad('hidden')}
                    style={{ padding: 12, borderRadius: 12, border: encuentro.visibilidad_respuestas_invitados === 'hidden' ? '2px solid #3b82f6' : '1px solid #e2e8f0', background: encuentro.visibilidad_respuestas_invitados === 'hidden' ? '#eff6ff' : '#fff', cursor: savingVisibilidad ? 'not-allowed' : 'pointer', opacity: savingVisibilidad ? 0.7 : 1 }}
                  >
                    <p style={{ margin: '0 0 4px 0', fontWeight: 600, color: '#0f172a' }}>No mostrar respuestas</p>
                    <p style={{ margin: 0, fontSize: 14, color: '#64748b' }}>Los invitados no verán las respuestas de los demás.</p>
                  </div>
                  <div 
                    onClick={() => !savingVisibilidad && handleSetVisibilidad('summary')}
                    style={{ padding: 12, borderRadius: 12, border: encuentro.visibilidad_respuestas_invitados === 'summary' ? '2px solid #3b82f6' : '1px solid #e2e8f0', background: encuentro.visibilidad_respuestas_invitados === 'summary' ? '#eff6ff' : '#fff', cursor: savingVisibilidad ? 'not-allowed' : 'pointer', opacity: savingVisibilidad ? 0.7 : 1 }}
                  >
                    <p style={{ margin: '0 0 4px 0', fontWeight: 600, color: '#0f172a' }}>Resumen anónimo</p>
                    <p style={{ margin: 0, fontSize: 14, color: '#64748b' }}>Los invitados verán un conteo anónimo por fecha.</p>
                  </div>
                  <div 
                    onClick={() => !savingVisibilidad && handleSetVisibilidad('detail')}
                    style={{ padding: 12, borderRadius: 12, border: encuentro.visibilidad_respuestas_invitados === 'detail' ? '2px solid #3b82f6' : '1px solid #e2e8f0', background: encuentro.visibilidad_respuestas_invitados === 'detail' ? '#eff6ff' : '#fff', cursor: savingVisibilidad ? 'not-allowed' : 'pointer', opacity: savingVisibilidad ? 0.7 : 1 }}
                  >
                    <p style={{ margin: '0 0 4px 0', fontWeight: 600, color: '#0f172a' }}>Detalle por invitado</p>
                    <p style={{ margin: 0, fontSize: 14, color: '#64748b' }}>Verán el nombre declarado y disponibilidad por fecha.</p>
                  </div>
                </div>
                {visibilidadFeedback && (
                  <p style={{
                    marginTop: 12,
                    fontSize: 14,
                    fontWeight: 500,
                    color: visibilidadFeedback === 'ok' ? '#16a34a' : '#dc2626',
                    animation: 'fadeIn 0.3s ease-in-out'
                  }}>
                    {visibilidadFeedback === 'ok' ? '✓ Visibilidad actualizada' : '✗ Error al guardar'}
                  </p>
                )}
              </div>
            )}

            {/* Card 2: Opciones */}
            <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)' }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 20px 0', color: '#0f172a', paddingBottom: 16, borderBottom: '1px solid rgba(15,23,42,0.05)' }}>
                Opciones propuestas
              </h3>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {opciones?.map((opt) => {
                  const isSelected = derivedStatus === 'closed' && detail.selected_option_id === opt.id;
                  const isRecommended = derivedStatus !== 'closed' && recommendedOptionId === opt.id;
                  
                  return (
                    <div key={opt.id} style={{ display: 'flex', flexDirection: 'column', padding: '14px 16px', borderRadius: 14, border: isSelected ? '2px solid #22c55e' : isRecommended ? '2px solid #fbbf24' : '1px solid rgba(15,23,42,0.05)', background: isSelected ? '#f0fdf4' : isRecommended ? '#fffbeb' : '#f8fafc', transition: 'all 0.2s' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                          <div style={{ width: 32, height: 32, borderRadius: '50%', background: isSelected ? '#dcfce7' : isRecommended ? '#fef3c7' : '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: isSelected ? '#16a34a' : isRecommended ? '#d97706' : '#475569', fontSize: 14 }}>
                            {opt.orden}
                          </div>
                          <div>
                            <span style={{ display: 'block', fontWeight: 600, color: isSelected ? '#14532d' : '#1e293b', fontSize: 15 }}>
                              {formatFriendlyDate(opt.fecha, opt.hora_inicio)}
                            </span>
                            {isRecommended && (
                              <span style={{ color: '#d97706', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                ⭐ Recomendada
                              </span>
                            )}
                            {isSelected && (
                              <span style={{ color: '#16a34a', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                ✓ Fecha confirmada
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: '40%' }}>
                          {opt.available_count > 0 && <span style={{ background: '#dcfce7', color: '#166534', fontWeight: 600, fontSize: 12, padding: '2px 8px', borderRadius: 12 }}>Sí: {opt.available_count}</span>}
                          {opt.maybe_count > 0 && <span style={{ background: '#fef9c3', color: '#854d0e', fontWeight: 600, fontSize: 12, padding: '2px 8px', borderRadius: 12 }}>Tal vez: {opt.maybe_count}</span>}
                          {opt.unavailable_count > 0 && <span style={{ background: '#fee2e2', color: '#991b1b', fontWeight: 600, fontSize: 12, padding: '2px 8px', borderRadius: 12 }}>No: {opt.unavailable_count}</span>}
                          {opt.available_count === 0 && opt.maybe_count === 0 && opt.unavailable_count === 0 && <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>0 votos</span>}
                        </div>
                      </div>
                      
                      {derivedStatus !== 'closed' && opt.is_confirmable === true && (
                        <div style={{ marginTop: 12, paddingTop: 12, borderTop: isRecommended ? '1px solid #fde68a' : '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end' }}>
                          <Button 
                            variant={derivedStatus === 'deadline_passed' && isRecommended ? 'primary' : 'outline'}
                            onClick={() => setConfirmModalOption(opt.id)}
                            style={{ 
                              padding: '6px 16px', 
                              fontSize: 14, 
                              height: 36, 
                              borderRadius: 10,
                              opacity: derivedStatus === 'deadline_passed' ? 1 : 0.85
                            }}
                          >
                            {derivedStatus === 'deadline_passed' ? 'Confirmar esta fecha' : 'Cerrar con esta fecha'}
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Card 2.5: Asistencia Final (solo cerrada) */}
            {derivedStatus === 'closed' && (
              <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)' }}>
                <h3 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 20px 0', color: '#0f172a', paddingBottom: 16, borderBottom: '1px solid rgba(15,23,42,0.05)' }}>
                  Asistencia final
                </h3>
                
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 100, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 16, padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: '#166534', fontSize: 24, fontWeight: 800 }}>
                      {detail.participantes?.filter(p => getParticipanteEstadoEfectivo(p) === 'confirmado').length || 0}
                    </span>
                    <span style={{ color: '#15803d', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Confirmados</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 100, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 16, padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: '#991b1b', fontSize: 24, fontWeight: 800 }}>
                      {detail.participantes?.filter(p => getParticipanteEstadoEfectivo(p) === 'rechazado').length || 0}
                    </span>
                    <span style={{ color: '#b91c1c', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>No asisten</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 100, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 16, padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: '#475569', fontSize: 24, fontWeight: 800 }}>
                      {detail.participantes?.filter(p => getParticipanteEstadoEfectivo(p) === 'pendiente').length || 0}
                    </span>
                    <span style={{ color: '#64748b', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pendientes</span>
                  </div>
                </div>
              </div>
            )}

            {/* Card 3: Respuestas */}
            <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)' }}>
              <button
                onClick={() => setShowResponsesDetail(!showResponsesDetail)}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', background: 'none', border: 'none', padding: '0 0 16px 0', borderBottom: '1px solid rgba(15,23,42,0.05)', marginBottom: 20, cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                  <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: '#0f172a' }}>
                    {derivedStatus === 'closed' ? 'Detalle por invitado' : 'Respuestas'}
                  </h3>
                  <span style={{ fontSize: 13, color: '#64748b' }}>
                    {detail.participantes?.filter(p => p.respondio_disponibilidad || derivedStatus === 'closed').length || 0} invitado(s) respondieron
                  </span>
                </div>
                {showResponsesDetail ? <ChevronUp size={20} color="#64748b" /> : <ChevronDown size={20} color="#64748b" />}
              </button>

              {showResponsesDetail && ((!detail.participantes || detail.participantes.filter(p => p.respondio_disponibilidad || derivedStatus === 'closed').length === 0) ? (
                <div style={{ padding: '40px 20px', borderRadius: 16, border: '2px dashed rgba(15,23,42,0.1)', textAlign: 'center', backgroundColor: '#f8fafc', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                  <div style={{ background: '#F1F5F9', width: 48, height: 48, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Users size={24} color="#475569" />
                  </div>
                  <p style={{ margin: 0, fontSize: 15, color: '#64748b', fontWeight: 500 }}>
                    {derivedStatus === 'closed' ? 'No hay invitados registrados todavía.' : 'Todavía no recibiste disponibilidades.'}
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {detail.participantes.filter(p => p.respondio_disponibilidad || derivedStatus === 'closed').map((part) => {
                    const estadoEfectivo = getParticipanteEstadoEfectivo(part);
                    return (
                    <div key={part.id} style={{ background: '#ffffff', borderRadius: 16, border: '1px solid #e2e8f0', boxShadow: '0 2px 8px rgba(15,23,42,0.04)', overflow: 'hidden' }}>
                      <div style={{ padding: '16px 20px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 800, color: '#0f172a', fontSize: 16 }}>
                          {part.nombre_invitado}
                        </span>
                        {derivedStatus === 'closed' ? (
                          <span style={{
                            padding: '4px 10px',
                            borderRadius: 20,
                            fontSize: 12,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                            background: estadoEfectivo === 'confirmado' ? '#dcfce7' : estadoEfectivo === 'rechazado' ? '#fee2e2' : '#f1f5f9',
                            color: estadoEfectivo === 'confirmado' ? '#166534' : estadoEfectivo === 'rechazado' ? '#991b1b' : '#475569',
                            border: `1px solid ${estadoEfectivo === 'confirmado' ? '#bbf7d0' : estadoEfectivo === 'rechazado' ? '#fecaca' : '#e2e8f0'}`
                          }}>
                            {estadoEfectivo === 'confirmado' ? 'Confirmado' : estadoEfectivo === 'rechazado' ? 'No asiste' : 'Pendiente'}
                          </span>
                        ) : (
                          <span style={{ padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700, background: '#dcfce7', color: '#166534', border: '1px solid #bbf7d0' }}>
                            Respondido
                          </span>
                        )}
                      </div>
                      <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {part.respuestas.length === 0 ? (
                          <span style={{ color: '#94a3b8', fontSize: 14, fontStyle: 'italic' }}>Sin disponibilidad previa.</span>
                        ) : (
                          part.respuestas.map((resp) => {
                            const option = opciones?.find(o => o.id === resp.opcion_fecha_id);
                            if (!option) return null;
                            const isConfirmedOption = option.id === detail.selected_option_id;
                            
                            return (
                              <div key={resp.opcion_fecha_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: isConfirmedOption ? '4px 8px' : 0, background: isConfirmedOption ? '#f0fdf4' : 'transparent', borderRadius: 8, margin: isConfirmedOption ? '-4px -8px' : 0 }}>
                                <span style={{ color: isConfirmedOption ? '#166534' : '#475569', fontWeight: isConfirmedOption ? 700 : 600, fontSize: 14 }}>
                                  {formatFriendlyDate(option.fecha, option.hora_inicio)} {isConfirmedOption && '✓'}
                                </span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  {resp.es_preferida && (
                                    <span style={{ background: '#fef3c7', color: '#d97706', fontWeight: 700, fontSize: 11, padding: '4px 8px', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                      ★ Preferida
                                    </span>
                                  )}
                                  <span style={{ fontWeight: 700, fontSize: 13, padding: '4px 10px', borderRadius: 12, backgroundColor: resp.respuesta === 'available' ? '#dcfce7' : resp.respuesta === 'maybe' ? '#fef9c3' : '#fee2e2', color: resp.respuesta === 'available' ? '#166534' : resp.respuesta === 'maybe' ? '#854d0e' : '#991b1b' }}>
                                    {resp.respuesta === 'available' ? 'Sí puedo' : resp.respuesta === 'maybe' ? 'Tal vez' : 'No puedo'}
                                  </span>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>
                  );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Acciones de administración */}
        <div style={{ padding: '0 20px', marginTop: 24, paddingBottom: 100 }}>
          {derivedStatus !== 'closed' && derivedStatus !== 'expired_unconfirmed' && encuentro.estado !== 'cancelado' && (
            <Button
              variant="outline"
              fullWidth
              style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)', marginBottom: 12 }}
              onClick={() => setShowCancelModal(true)}
            >
              Cancelar encuentro
            </Button>
          )}
          <Button
            variant="ghost"
            fullWidth
            style={{ color: 'var(--color-danger)', padding: '12px 0', fontSize: 14, fontWeight: 600, display: 'block', marginBottom: 24 }}
            onClick={() => setShowDeleteModal(true)}
          >
            Eliminar del historial
          </Button>
        </div>

      </div>

      {derivedStatus !== 'expired_unconfirmed' && (
        <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, padding: '20px 20px', background: 'rgba(255, 255, 255, 0.85)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', borderTop: '1px solid rgba(15,23,42,0.05)', boxShadow: '0 -4px 24px rgba(0,0,0,0.04)', paddingBottom: 'calc(20px + env(safe-area-inset-bottom))', zIndex: 10 }}>
          {derivedStatus === 'closed' ? (
            <Button
              variant="primary"
              fullWidth
              onClick={handleShareConfirmedDate}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 14, background: '#16a34a', boxShadow: '0 4px 12px rgba(22, 163, 74, 0.25)' }}
            >
              <Share2 size={20} />
              Compartir fecha confirmada
            </Button>
          ) : (
            <Button
              variant="primary"
              fullWidth
              onClick={handleShare}
              disabled={isLinkGeneral && !shareUrl}
              aria-disabled={isLinkGeneral && !shareUrl}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 14, background: '#4f46e5', boxShadow: '0 4px 12px rgba(79, 70, 229, 0.25)' }}
            >
              {isLinkGeneral ? <Share2 size={20} /> : <Plus size={20} />}
              {isLinkGeneral ? 'Compartir link general' : 'Agregar invitados'}
            </Button>
          )}
        </div>
      )}

      {showCancelModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#ffffff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: '24px 20px calc(24px + env(safe-area-inset-bottom))', width: '100%', maxWidth: 480, animation: 'slideUp 0.3s ease-out' }}>
            <div style={{ width: 40, height: 4, background: '#e2e8f0', borderRadius: 4, margin: '0 auto 20px auto' }} />
            <h3 style={{ fontSize: 20, fontWeight: 800, margin: '0 0 12px 0', color: '#0f172a' }}>
              ¿Qué querés hacer con esta coordinación?
            </h3>
            <p style={{ margin: '0 0 24px 0', color: '#475569', fontSize: 15, lineHeight: 1.5 }}>
              Si la cancelás, el encuentro quedará marcado como cancelado.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Button
                fullWidth
                variant="outline"
                style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}
                onClick={() => { setCancellingMode('cancel'); handleCancelEncuentro(); }}
                disabled={cancelling}
              >
                {cancelling && cancellingMode === 'cancel' ? 'Cancelando…' : 'Cancelar encuentro'}
              </Button>
              <Button
                fullWidth
                variant="ghost"
                style={{ color: '#475569', marginTop: 4 }}
                onClick={() => { setShowCancelModal(false); setCancellingMode(null); }}
                disabled={cancelling}
              >
                Volver
              </Button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#ffffff', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: '24px 20px calc(24px + env(safe-area-inset-bottom))', width: '100%', maxWidth: 480, animation: 'slideUp 0.3s ease-out' }}>
            <div style={{ width: 40, height: 4, background: '#e2e8f0', borderRadius: 4, margin: '0 auto 20px auto' }} />
            <h3 style={{ fontSize: 20, fontWeight: 800, margin: '0 0 12px 0', color: '#0f172a' }}>
              ¿Querés eliminar esta coordinación?
            </h3>
            <p style={{ margin: '0 0 24px 0', color: '#475569', fontSize: 15, lineHeight: 1.5 }}>
              Esta acción no se puede deshacer. Dejará de aparecer en tu historial.
            </p>
            <div style={{ display: 'flex', gap: 12 }}>
              <Button fullWidth variant="outline" onClick={() => setShowDeleteModal(false)} disabled={isDeleting} style={{ borderRadius: 12 }}>
                Cancelar
              </Button>
              <Button fullWidth variant="primary" style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 12 }} onClick={handleDeleteEncuentro} disabled={isDeleting}>
                {isDeleting ? 'Eliminando…' : 'Eliminar'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmModalOption && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 }}>
          <div style={{ background: '#ffffff', borderRadius: 24, padding: 24, width: '100%', maxWidth: 400, boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)' }}>
            <h3 style={{ fontSize: 20, fontWeight: 800, margin: '0 0 12px 0', color: '#0f172a' }}>Confirmar fecha</h3>
            <p style={{ margin: '0 0 24px 0', color: '#475569', fontSize: 15, lineHeight: 1.5 }}>
              ¿Estás seguro de que querés confirmar esta fecha? Esta acción cerrará la coordinación y no se recibirán más respuestas.
            </p>
            <div style={{ display: 'flex', gap: 12 }}>
              <Button 
                variant="outline" 
                fullWidth 
                onClick={() => setConfirmModalOption(null)}
                disabled={isClosing}
                style={{ borderRadius: 12 }}
              >
                Cancelar
              </Button>
              <Button 
                variant="primary" 
                fullWidth 
                onClick={() => handleConfirmOption(confirmModalOption)}
                disabled={isClosing}
                style={{ borderRadius: 12, background: '#4f46e5' }}
              >
                {isClosing ? 'Confirmando...' : 'Sí, confirmar'}
              </Button>
            </div>
          </div>
        </div>
      )}
      <OrganizerMessageSheet
        isOpen={isSheetOpen}
        onClose={() => setIsSheetOpen(false)}
        initialMessage={personalMessage}
        onSave={handleSavePersonalMessage}
      />
    </ScreenContainer>
  );
};

export default DetailHostCoordination;
