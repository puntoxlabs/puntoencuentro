import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { MoreVertical, PencilLine, MessageSquare } from 'lucide-react';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate, isEncuentroPasado } from '@/lib/formatDate';
import { formatFechaHoraWhatsApp } from '@/lib/formatWhatsapp';
import { useDetailStore } from '@/store/detailStore';
import { openExternalVideoLink } from '@/lib/openLink';
import throttle from 'lodash/throttle';
import { getThemeStyle } from '@/lib/themes';
import { useHomeStore } from '@/store/homeStore';
import { useAuth } from '@/contexts/AuthContext';
import { getHostId } from '@/lib/auth';
import { getEncuentroHost, rememberEncuentroHost } from '@/lib/meetHostsStorage';
import { MapPin, Video, CheckCircle2, XCircle, Clock, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ScrollHint } from '@/components/ui/ScrollHint';
import { OrganizerMessageSheet } from '@/components/ui/OrganizerMessageSheet';
import { useWizardStore } from '@/store/wizardStore';
import { getHostAlias, setHostAlias } from '@/lib/hostAliasStorage';
import { formatCount } from '@/lib/formatCount';

/** Función eliminada a favor de la exportada en formatDate.ts */

const DetailHost: React.FC = () => {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isFromShare = searchParams.get('share') === '1';
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
  const [showScrollHint, setShowScrollHint] = useState(false);
  // Estados para bloque de invitación unificado (link_general)
  const [personalMessage, setPersonalMessage] = useState('');
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [shareFeedback, setShareFeedback] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);
  // Estado para discriminar qué botón destructivo del bottom sheet de cancelación fue clickeado
  const [cancellingMode, setCancellingMode] = useState<'cancel' | 'create' | null>(null);
  const { user, loading: authLoading, signInWithGoogle } = useAuth();

  // Estados para invitado individual
  const [nombre, setNombre] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedGuestMessage, setSelectedGuestMessage] = useState<any>(null);
  // Marca local de invitaciones ya compartidas (persiste en localStorage)
  const [sharedInvites, setSharedInvites] = useState<Record<string, boolean>>({});
  // Estado para la opción de visibilidad de respuestas para invitados
  const [visibilidadRespuestas, setVisibilidadRespuestas] = useState(false);
  const [savingVisibilidad, setSavingVisibilidad] = useState(false);
  const [visibilidadFeedback, setVisibilidadFeedback] = useState<'ok' | 'error' | null>(null);

  // Alias del anfitrión
  const [hostAlias, setHostAliasState] = useState(getHostAlias());
  const [aliasFeedback, setAliasFeedback] = useState(false);

  const handleSaveAlias = () => {
    setHostAlias(hostAlias);
    setHostAliasState(getHostAlias());
    setAliasFeedback(true);
    setTimeout(() => setAliasFeedback(false), 2000);
  };

  // hostId estabilizado en ref: se resuelve UNA vez cuando auth ya tiene valor definitivo.
  // Usa user.id si está logueado, o el UUID persistido en localStorage si es anónimo.
  // No genera un nuevo UUID al refrescar: getHostId() lee desde localStorage.
  const hostIdRef = useRef<string | null>(null);

  // Ref para el interval de polling (evita duplicados)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Resuelve y fija hostId cuando auth termina de cargar
  useEffect(() => {
    if (authLoading) return; // Esperar que auth resuelva antes de fijar hostId
    const resolved = user?.id ?? getHostId();
    if (import.meta.env.DEV) console.log('[DetailHost] hostId resuelto:', resolved, '(user logueado:', !!user, ')');
    hostIdRef.current = resolved;
  }, [authLoading, user?.id]);

  // Carga el estado de invitaciones ya compartidas desde localStorage
  useEffect(() => {
    if (!id) return;
    try {
      const raw = localStorage.getItem('puntoencuentro_shared_invites');
      const all = raw ? JSON.parse(raw) : {};
      setSharedInvites(all[id] || {});
    } catch { /* ignore */ }
  }, [id]);

  const refreshParticipantes = useCallback(async () => {
    const hId = hostIdRef.current;
    if (!id || !hId) return;
    try {
      const parts = await participantesService.getParticipantesByEncuentro(id, hId);
      setParticipantes(parts || []);
      const currentEnc = useDetailStore.getState().cache[id]?.encuentro;
      if (currentEnc) setDetailData(id, currentEnc, parts || []);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[DetailHost] Error polling participants:', err);
    }
  }, [id]);

  // Efecto principal: carga inicial + polling + visibilitychange
  // Se re-ejecuta cuando auth termina (authLoading cambia a false)
  useEffect(() => {
    if (!id) return;
    if (authLoading) return; // No cargar hasta que auth esté resuelto

    // Prioridad hostId:
    // 1. user?.id (sesión autenticada)
    // 2. mapeo local encuentroId → hostId (persistido al crear)
    // 3. hostId genérico del dispositivo
    const hId = user?.id ?? getEncuentroHost(id) ?? getHostId();
    hostIdRef.current = hId;

    if (import.meta.env.DEV) console.log('[DetailHost] mount/auth-resolved. id:', id, 'hostId:', hId);

    loadData(hId);

    if (validCache && validCache.scrollPosition > 0) {
      requestAnimationFrame(() => {
        const container = document.getElementById('detail-scroll-container');
        if (container) container.scrollTop = validCache.scrollPosition;
      });
    }

    // Leer cancel_reference del sessionStorage
    const refStr = sessionStorage.getItem('cancel_reference');
    if (refStr) {
      try {
        const ref = JSON.parse(refStr);
        if (ref && typeof ref === 'object' && ref.newId === id) {
          setFromCancelled(ref);
          sessionStorage.removeItem('cancel_reference');
        }
      } catch (e) { console.error('Error reading cancel_reference', e); }
    }

    // Polling de participantes cada 5 s por RPC (no SELECT directo)
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(async () => {
      const hId2 = hostIdRef.current;
      if (!id || !hId2) return;
      try {
        const parts = await participantesService.getParticipantesByEncuentro(id, hId2);
        setParticipantes(parts || []);
        const currentEnc = useDetailStore.getState().cache[id]?.encuentro;
        if (currentEnc) setDetailData(id, currentEnc, parts || []);
      } catch (err) {
        if (import.meta.env.DEV) console.error('[DetailHost] Error en polling:', err);
      }
    }, 5000);

    // Refresh al volver el foco de la ventana
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (import.meta.env.DEV) console.log('[DetailHost] visibilitychange: refrescando participantes');
        refreshParticipantes();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [id, authLoading]);

  const loadData = async (hId?: string) => {
    const hostId = hId ?? hostIdRef.current ?? (user?.id ?? getEncuentroHost(id!) ?? getHostId());
    try {
      if (!useDetailStore.getState().getValidCache(id!)) setLoading(true);
      setError(null);
      if (import.meta.env.DEV) console.log('[DetailHost] loadData con hostId:', hostId);
      const enc = await encuentrosService.getDetalleHostSeguro(id!, hostId);
      setEncuentro(enc);

      // Reforzar mapeo local con los datos que vienen del servidor
      if (enc?.host_id) {
        rememberEncuentroHost(id!, enc.host_id);
      }

      const parts = await participantesService.getParticipantesByEncuentro(id!, hostId);
      setParticipantes(parts || []);
      setDetailData(id!, enc, parts || []);

      // Leer estado actual de visibilidad para invitados
      // get_detalle_host_seguro puede no incluir este campo (RPC preexistente),
      // por eso consultamos con RPC dedicada
      try {
        const visResult = await encuentrosService.getVisibilidadInvitadosHost(id!, hostId);
        if (visResult?.ok) setVisibilidadRespuestas(visResult.visible ?? false);
      } catch { /* no fatal — el toggle inicia en false */ }
    } catch (err: any) {
      if (import.meta.env.DEV) console.error('[DetailHost] loadData error:', err?.message, err);
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


  const handleScroll = throttle((e: React.UIEvent<HTMLDivElement>) => {
    if (id) setScrollPosition(id, e.currentTarget.scrollTop);
  }, 200);

  useEffect(() => {
    const checkScroll = () => {
      const scrollY = window.scrollY;
      const viewportHeight = window.innerHeight;
      const totalHeight = document.documentElement.scrollHeight;
      
      const hasOverflow = totalHeight > viewportHeight + 12;
      const isBottom = totalHeight - scrollY - viewportHeight < 35;
      
      setShowScrollHint(hasOverflow && !isBottom);
    };

    window.addEventListener('scroll', checkScroll);
    window.addEventListener('resize', checkScroll);
    const timer = setTimeout(checkScroll, 350);

    return () => {
      window.removeEventListener('scroll', checkScroll);
      window.removeEventListener('resize', checkScroll);
      clearTimeout(timer);
    };
  }, [participantes, encuentro, loading]);

  const handleCancelEncuentro = async () => {
    if (!id || cancelling) return;
    try {
      setCancelling(true);
      const hostId = user?.id ?? getHostId();
      await encuentrosService.cancelarEncuentro(id, hostId);
      
      // Refetch obligatorio para asegurar datos reales de Supabase
      const updatedEnc = await encuentrosService.getDetalleHostSeguro(id, hostId);
      
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

  const handleAddGuest = async () => {
    const trimNombre = nombre.trim();
    if (!trimNombre) return;
    const isDuplicate = participantes.some(p => p.nombre_invitado?.toLowerCase() === trimNombre.toLowerCase());
    if (isDuplicate) { alert('Ya existe un invitado con ese nombre.'); return; }
    try {
      const hostId = user?.id ?? getHostId();
      await participantesService.addParticipanteIndividual(id!, hostId, trimNombre);
      setNombre('');
      setTimeout(() => inputRef.current?.focus(), 0);
      refreshParticipantes();
    } catch (error) { 
      console.error('Error adding guest', error); 
      alert('Error al agregar invitado'); 
    }
  };

  const handleDeleteGuest = async (partId: string) => {
    try {
      setParticipantes(prev => prev.filter(p => p.id !== partId));
      await participantesService.deleteParticipante(partId, user?.id ?? getHostId());
      refreshParticipantes();
    } catch (error) {
      console.error('Error deleting guest', error);
      alert('Error al eliminar invitado');
      refreshParticipantes();
    }
  };

  // Cancela el encuentro Y precarga el wizard para crear uno nuevo de inmediato.
  // Replica la lógica de CancelSummary.handleCreateNew pero desde el bottom sheet,
  // evitando que el usuario tenga que navegar a /cancel-summary primero.
  const handleCancelAndCreate = async () => {
    if (!id || cancelling) return;
    try {
      setCancelling(true);
      const hostId = user?.id ?? getHostId();

      // 1. Cancelar en Supabase (mismo flujo validado)
      await encuentrosService.cancelarEncuentro(id, hostId);
      const updatedEnc = await encuentrosService.getDetalleHostSeguro(id, hostId);

      useHomeStore.getState().invalidateCache();
      setEncuentro(updatedEnc);
      useDetailStore.getState().setDetailData(id, updatedEnc, participantes);

      // 2. Guardar referencia del encuentro cancelado para que ShareLink
      //    pueda mostrar el banner "reemplaza a" cuando el nuevo encuentro se cree
      const cancelRef = {
        oldId: id,
        oldTitulo: encuentro.titulo,
        oldFecha: formatFriendlyDate(encuentro.fecha, encuentro.hora),
        tipoInvitacion: encuentro.tipo_invitacion,
        participantes: participantes.map((p: any) => ({
          nombre_invitado: p.nombre_invitado,
          estado: p.estado,
        })),
        newId: null,
      };
      sessionStorage.setItem('cancel_reference', JSON.stringify(cancelRef));

      // 3. Precargar wizard con datos del encuentro cancelado
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

      setShowCancelModal(false);
      navigate('/create');
    } catch (err: any) {
      console.error('[DetailHost] Error en cancelar y crear:', err);
      alert(`Error al cancelar: ${err?.message || 'Error desconocido'}`);
    } finally {
      setCancelling(false);
    }
  };

  const handleDeleteEncuentro = async () => {
    if (!id) return;
    try {
      setIsDeleting(true);
      const hostId = user?.id ?? getHostId();
      await encuentrosService.deleteEncuentro(id, hostId);
      useHomeStore.setState(state => ({ encuentros: state.encuentros.filter(e => e.id !== id) }));
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
    
    
    const intro = hostAlias 
      ? `${hostAlias} creó un nuevo encuentro en reemplazo del anterior 👇` 
      : `Se creó un nuevo encuentro en reemplazo del anterior 👇`;
      
    const msg = `${intro}\n\nConfirmá si podés asistir:\n${newLink}`;
    
    if (navigator.share) {
      try { await navigator.share({ text: msg }); } catch (err) { console.error('Share error:', err); }
    } else {
      try {
        await navigator.clipboard.writeText(msg);
        setCopiedNewShare(true); setTimeout(() => setCopiedNewShare(false), 2000);
      } catch { alert('Error al copiar el mensaje.'); }
    }
  };

  // Mostrar loading mientras auth resuelve (evita flash de error)
  if (authLoading || loading) return (
    <ScreenContainer>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p>Cargando detalle…</p>
      </div>
    </ScreenContainer>
  );

  if (error || !encuentro) return (
    <ScreenContainer>
      <AppBar title="Error" showBack />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '0 24px' }}>
        <span style={{ fontSize: 36 }}>⚠️</span>
        <p style={{ textAlign: 'center', fontSize: 15, color: '#374151', margin: 0 }}>
          {error || 'Encuentro no encontrado.'}
        </p>
        <Button fullWidth onClick={() => loadData()} variant="outline">
          Reintentar
        </Button>
        <Button fullWidth onClick={() => navigate('/')} variant="ghost" style={{ color: 'var(--color-on-surface-variant)', border: 'none' }}>Ir al inicio</Button>
      </div>
    </ScreenContainer>
  );

  // Orden alfabético dentro de cada sección (no muta participantes)
  const sortByName = (a: any, b: any) =>
    (a.nombre_invitado || '').localeCompare(b.nombre_invitado || '', 'es', { sensitivity: 'base' });

  const confirmados = (participantes || []).filter(p => p && p.estado === 'confirmado').sort(sortByName);
  const pendientes  = (participantes || []).filter(p => p && p.estado === 'pendiente').sort(sortByName);
  const rechazados  = (participantes || []).filter(p => p && p.estado === 'rechazado').sort(sortByName);
  const hasAnyResponse = confirmados.length > 0 || pendientes.length > 0 || rechazados.length > 0;

  const isCancelado  = encuentro.estado === 'cancelado';
  const isFinalizado = !isCancelado && isEncuentroPasado(encuentro.fecha, encuentro.hora);
  const isReadOnly   = isFinalizado;
  const isVirtual    = encuentro.modalidad === 'virtual';

  const getEventStatusBadge = () => {
    if (isCancelado) return { label: 'Cancelado', bg: '#FEE2E2', color: '#B91C1C' };
    if (!encuentro.fecha || !encuentro.hora) return { label: 'Activo', bg: 'var(--color-primary-container)', color: 'var(--color-primary-dark)' };

    const now = new Date();
    const eventDate = new Date(`${encuentro.fecha}T${encuentro.hora}`);
    const diffMinutes = Math.round((eventDate.getTime() - now.getTime()) / 60000);
    
    if (diffMinutes < -45) return { label: 'Finalizado', bg: '#F3F4F6', color: '#4B5563' };
    if (diffMinutes <= 0) return { label: '🟢 En curso ahora', bg: '#D1FAE5', color: '#047857' };
    // Corregido: "Listo para unirte" suena a invitado; para el host usamos "Encuentro activo"
    if (diffMinutes <= 15) return { label: '🟢 Encuentro activo', bg: '#D1FAE5', color: '#047857' };
    if (diffMinutes <= 60) return { label: `🟡 Empieza en ${diffMinutes} min`, bg: '#FEF3C7', color: '#B45309' };
    
    return { label: 'Activo', bg: 'var(--color-primary-container)', color: 'var(--color-primary-dark)' };
  };

  const badge = getEventStatusBadge();

  // Handler para compartir invitación general (link_general)
  const handleToggleVisibilidad = async (newValue: boolean) => {
    if (savingVisibilidad) return;
    const hostId = hostIdRef.current ?? (user?.id ?? getHostId());
    setSavingVisibilidad(true);
    setVisibilidadFeedback(null);
    try {
      await encuentrosService.setVisibilidadRespuestasInvitados(id!, hostId, newValue);
      setVisibilidadRespuestas(newValue);
      setVisibilidadFeedback('ok');
    } catch {
      setVisibilidadFeedback('error');
    } finally {
      setSavingVisibilidad(false);
      setTimeout(() => setVisibilidadFeedback(null), 2500);
    }
  };

  // Handler para compartir invitación general (link_general)
  const handleShareGeneral = async () => {
    if (!encuentro) return;
    try {
      const shareUrl = `${window.location.origin}/join/${encuentro.public_token}`;
      const { fechaStr, horaStr } = formatFechaHoraWhatsApp(encuentro.fecha, encuentro.hora);
      
      const aliasIntro = hostAlias 
        ? `${hostAlias} te invita a este encuentro 👇` 
        : `Te invito a este encuentro 👇`;
        
      let shareText = `${aliasIntro}\n\n*${encuentro.titulo}*\n${fechaStr} · ${horaStr}\n${encuentro.modalidad === 'presencial' ? '📍' : '💻'} ${encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}\n\n`;
      if (personalMessage.trim()) {
        shareText += `${personalMessage.trim()}\n\n`;
      }
      shareText += `Confirmá acá:\n${shareUrl}`;

      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      if (isMobile && navigator.share) {
        await navigator.share({ title: encuentro.titulo || 'Invitación', text: shareText });
        setShareFeedback(true);
      } else {
        await navigator.clipboard.writeText(shareText);
        setCopiedShare(true); setTimeout(() => setCopiedShare(false), 3000);
        setShareFeedback(true);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Error compartiendo invitación general:', err);
        alert('Error al compartir o copiar el enlace.');
      }
    }
  };

  // Marca un invitado como ya compartido en state y localStorage
  const markAsShared = (partId: string) => {
    setSharedInvites(prev => {
      const next = { ...prev, [partId]: true };
      try {
        const raw = localStorage.getItem('puntoencuentro_shared_invites');
        const all = raw ? JSON.parse(raw) : {};
        all[id!] = next;
        localStorage.setItem('puntoencuentro_shared_invites', JSON.stringify(all));
      } catch { /* ignore */ }
      return next;
    });
  };

  const handleShareLink = async (token: string, partId: string, guestName?: string) => {
    if (!token) return;
    const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const shareUrl = `${baseUrl}/invite/${token}`;
    
    let shareText = '';
    if (guestName?.trim()) {
      shareText = hostAlias 
        ? `${guestName.trim()}, ${hostAlias} te invita a este encuentro 👇\nConfirmá si podés asistir:`
        : `${guestName.trim()}, te invito a este encuentro 👇\nConfirmá si podés asistir:`;
    } else {
      shareText = hostAlias
        ? `${hostAlias} te invita a este encuentro 👇\nConfirmá si podés asistir:`
        : `Te invito a este encuentro 👇\nConfirmá si podés asistir:`;
    }
    if (navigator.share) {
      try {
        await navigator.share({ text: shareText, url: shareUrl });
        markAsShared(partId); // marcar solo si el share completó sin error
      } catch (err: any) {
        // AbortError = usuario canceló el diálogo de share → no marcar
        if (err?.name !== 'AbortError') console.error('Error sharing', err);
      }
    } else {
      try {
        await navigator.clipboard.writeText(`${shareText}\n${shareUrl}`);
        markAsShared(partId); // marcar solo si la copia fue exitosa
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
            const sLabel = p.estado === 'confirmado' ? 'Confirmado' : p.estado === 'rechazado' ? 'No asiste' : 'Pendiente';
            const bgChip = p.estado === 'confirmado' ? '#D1FAE5' : p.estado === 'rechazado' ? '#FEE2E2' : '#FEF3C7';
            const fgChip = p.estado === 'confirmado' ? '#065F46' : p.estado === 'rechazado' ? '#991B1B' : '#92400E';
            const bgAvatar = p.estado === 'confirmado' ? '#D1FAE5' : p.estado === 'rechazado' ? '#FEE2E2' : '#F3F4F6';
            const fgAvatar = p.estado === 'confirmado' ? '#047857' : p.estado === 'rechazado' ? '#B91C1C' : '#4B5563';

            return (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 16,
                  background: bgAvatar, color: fgAvatar,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, fontSize: 13, flexShrink: 0
                }}>
                  {avatarChar}
                </div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600, fontSize: 15, color: '#111827', display: 'block' }}>{p.nombre_invitado}</span>
                  {p.user_id && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 1, color: 'var(--color-primary)', fontSize: 11, fontWeight: 500 }}>
                      <User size={12} strokeWidth={2.5} />
                      <span>{t('participant.linked_account', 'Cuenta vinculada')}</span>
                    </div>
                  )}
                  {p.mensaje_respuesta && (
                    <button
                      onClick={() => setSelectedGuestMessage(p)}
                      style={{ 
                        marginTop: 4, 
                        background: 'none', border: 'none', 
                        display: 'flex', alignItems: 'center', gap: 4, 
                        color: 'var(--color-primary)', fontSize: 13, 
                        fontWeight: 500, cursor: 'pointer', padding: 0 
                      }}
                    >
                      <MessageSquare size={14} />
                      <span>Ver mensaje</span>
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {!isReadOnly && !isCancelado && p.estado === 'pendiente' && p.token_invitacion && (
                    <button
                      onClick={() => handleShareLink(p.token_invitacion, p.id, p.nombre_invitado)}
                      style={{
                      background: copiedId === p.id
                          ? 'var(--color-primary-container)'
                          : sharedInvites[p.id]
                          ? '#F0FDF4'
                          : 'var(--color-primary-container)',
                        border: `1.5px solid ${
                          copiedId === p.id
                            ? 'var(--color-primary)'
                            : sharedInvites[p.id]
                            ? '#86EFAC'
                            : 'var(--color-primary)'
                        }`,
                        borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
                        fontFamily: 'var(--font-family)', fontSize: 13, fontWeight: 600,
                        color: copiedId === p.id
                          ? 'var(--color-primary)'
                          : sharedInvites[p.id]
                          ? '#16A34A'
                          : 'var(--color-primary-dark)',
                        transition: 'all 0.15s', whiteSpace: 'nowrap',
                      }}
                    >
                      {copiedId === p.id ? '✓ Copiado' : sharedInvites[p.id] ? '✓ Compartido' : 'Compartir'}
                    </button>
                  )}
                  <span style={{ fontSize: 11, fontWeight: 700, background: bgChip, color: fgChip, borderRadius: 6, padding: '3px 8px', whiteSpace: 'nowrap' }}>
                    {sLabel}
                  </span>
                  {!isReadOnly && !isCancelado && (
                    <button
                      onClick={() => handleDeleteGuest(p.id)}
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'var(--color-on-surface-variant)', fontSize: 14,
                        padding: '4px'
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const getDeleteConfig = () => {
    if (isCancelado) {
      return {
        title: '¿Eliminar este encuentro?',
        desc: 'Este encuentro fue cancelado. Al eliminarlo, desaparecerá de tu historial.'
      };
    }
    if (isFinalizado) {
      return {
        title: '¿Eliminar del historial?',
        desc: 'Este encuentro ya finalizó. Al eliminarlo, dejará de aparecer en tu historial. Esta acción no se puede deshacer.'
      };
    }
    
    // Activo o Próximo
    let desc = 'Este encuentro está programado o en curso. ';
    if (participantes.length > 0) {
      desc = 'Este encuentro fue compartido. Las personas invitadas perderán acceso. ' + desc + '¿Querés eliminarlo?';
      return {
        title: '¿Querés eliminar este encuentro?',
        desc
      };
    } else {
      desc += 'Esta acción no se puede deshacer.';
      return {
        title: '¿Querés eliminar este encuentro?',
        desc
      };
    }
  };

  const delConfig = getDeleteConfig();

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
        <h3 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>{delConfig.title}</h3>
        <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 24 }}>
          {delConfig.desc}
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

  // Bottom sheet de cancelación unificado:
  // 3 opciones en un solo paso para evitar la doble instancia modal → CancelSummary.
  const cancelModal = showCancelModal ? (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    }}>
      <div style={{
        background: '#fff', borderRadius: '24px 24px 0 0',
        padding: '20px 24px 44px', width: '100%', maxWidth: 480,
        boxShadow: '0 -4px 30px rgba(0,0,0,0.15)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Drag handle */}
        <div style={{
          width: 40, height: 4, background: 'rgba(0,0,0,0.1)',
          borderRadius: 2, alignSelf: 'center', marginBottom: 22,
        }} />

        <h3 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8, color: '#111827' }}>
          ¿Qué querés hacer con este encuentro?
        </h3>
        <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 24, lineHeight: 1.5 }}>
          Si lo cancelás, el encuentro quedará marcado como cancelado.
          Después podrás compartir el aviso con los invitados.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Opción 1: Cancelar y quedar en cancel-summary */}
          <Button
            fullWidth
            variant="outline"
            style={{ borderColor: '#DC2626', color: '#DC2626' }}
            onClick={() => { setCancellingMode('cancel'); handleCancelEncuentro(); }}
            disabled={cancelling}
          >
            {cancelling && cancellingMode === 'cancel' ? 'Cancelando…' : 'Cancelar encuentro'}
          </Button>

          {/* Opción 2: Cancelar y crear uno nuevo */}
          <Button
            fullWidth
            variant="primary"
            onClick={() => { setCancellingMode('create'); handleCancelAndCreate(); }}
            disabled={cancelling}
          >
            {cancelling && cancellingMode === 'create' ? 'Cancelando y preparando…' : '✨ Cancelar y crear uno nuevo'}
          </Button>

          {/* Opción 3: Volver sin cancelar */}
          <Button
            fullWidth
            variant="ghost"
            style={{ color: 'var(--color-on-surface-variant)', marginTop: 2 }}
            onClick={() => { setShowCancelModal(false); setCancellingMode(null); }}
            disabled={cancelling}
          >
            Volver
          </Button>
        </div>
      </div>
    </div>
  ) : null;

  const isHost = !!(user && encuentro.host_id === user.id);
  const participanteActual = user ? participantes.find(p => p.user_id === user.id) : null;
  const isParticipant = !!participanteActual;

  const renderParticipantView = () => {
    const pEstado = participanteActual?.estado || 'pendiente';
    const statusLabel = pEstado === 'confirmado' ? 'Confirmaste tu asistencia' :
                        pEstado === 'rechazado' ? 'Rechazaste esta invitación' : 'Todavía no respondiste';
    const statusIcon = pEstado === 'confirmado' ? <CheckCircle2 size={18} color="#059669" /> :
                       pEstado === 'rechazado' ? <XCircle size={18} color="#DC2626" /> : <Clock size={18} color="#6B7280" />;
    
    return (
      <div 
        id="participant-scroll-container" 
        onScroll={handleScroll}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '16px 20px 40px' }}
      >
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
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#4B5563', fontSize: 15 }}>
              <Clock size={18} />
              <span style={{ fontWeight: 600 }}>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#4B5563', fontSize: 15 }}>
              {isVirtual ? <Video size={18} /> : <MapPin size={18} />}
              <span>{isVirtual ? 'Virtual' : (encuentro.lugar_texto || 'Presencial')}</span>
            </div>
            {encuentro.descripcion && (
              <div style={{ marginTop: 8, fontSize: 15, color: '#6B7280', lineHeight: 1.5, background: '#F9FAFB', padding: '12px 16px', borderRadius: 12 }}>
                {encuentro.descripcion}
              </div>
            )}
          </div>
        </div>

        {/* Estado personal */}
        <div style={{
          background: '#fff', borderRadius: 16, padding: '16px 20px', marginBottom: 32,
          border: '1px solid rgba(0,0,0,0.04)', boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
          display: 'flex', alignItems: 'center', gap: 12
        }}>
          {statusIcon}
          <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{statusLabel}</span>
        </div>

        {isCancelado && (
          <div style={{ background: '#FEF2F2', border: '1px solid #FEE2E2', borderRadius: 12, padding: '14px 16px', marginBottom: 32 }}>
            <p style={{ margin: 0, fontSize: 14, color: '#991B1B', fontWeight: 600 }}>El organizador canceló este encuentro.</p>
          </div>
        )}

        {isFinalizado && (
          <div style={{ background: '#F3F4F6', borderRadius: 12, padding: '14px 16px', marginBottom: 32 }}>
            <p style={{ margin: 0, fontSize: 14, color: '#4B5563', fontWeight: 600 }}>Este encuentro ya finalizó.</p>
          </div>
        )}

        {/* Acciones para participantes */}
        {!isCancelado && !isFinalizado && isVirtual && encuentro.link_virtual && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 32 }}>
             <Button fullWidth style={{ height: 54, fontSize: 16, fontWeight: 700 }} onClick={() => openExternalVideoLink(encuentro.link_virtual)}>
               Abrir videollamada
             </Button>
             <button 
               onClick={handleCopyVideoLink} 
               style={{ 
                 background: 'none', border: 'none', color: 'var(--color-primary)', 
                 fontWeight: 600, fontSize: 14, cursor: 'pointer', padding: '8px' 
               }}
             >
               {copiedLink ? 'Copiado' : 'Copiar link de la reunión'}
             </button>
          </div>
        )}

        <div style={{ marginTop: 'auto', paddingTop: 20 }}>
          <Button
            variant="ghost"
            onClick={() => navigate('/')}
            style={{ color: 'var(--color-on-surface-variant)', border: 'none' }}
            fullWidth
          >
            Ir al inicio
          </Button>
        </div>
      </div>
    );
  };

  // Título del AppBar para el host según origen
  const appBarTitle = (!isHost && isParticipant)
    ? 'Tu invitación'
    : isFromShare
      ? (encuentro?.tipo_invitacion === 'link_general' ? 'Invitación lista' : 'Compartir invitación')
      : '';

  return (
    <ScreenContainer style={getThemeStyle(encuentro?.tema)}>
      {cancelModal}
      {deleteModal}
      <AppBar
        title={appBarTitle}
        showBack
        onBack={(!isHost && isParticipant) ? undefined : () => navigate('/')}
        rightAction={(!isHost && isParticipant) ? null : (
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
                    onClick={() => { setShowContextMenu(false); navigate('/', { replace: true }); }}
                    style={{
                      width: '100%', padding: '12px 16px', border: 'none',
                      background: 'transparent', color: '#111827', fontWeight: 600,
                      fontSize: 14, textAlign: 'left', cursor: 'pointer',
                      borderBottom: '1px solid rgba(0,0,0,0.05)'
                    }}
                  >
                    Ir al inicio
                  </button>
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
        )}
      />

      {!isHost && isParticipant ? renderParticipantView() : (
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

          {/* 2. BLOQUE DE INVITACIÓN UNIFICADO */}
          {!isReadOnly && !isCancelado && (
            <div style={{ marginBottom: 24 }}>
              {encuentro.tipo_invitacion === 'link_general' ? (
                // --- Link general: compartir + mensaje del organizador ---
                <div style={{
                  background: '#fff',
                  borderRadius: 16,
                  padding: '16px 20px',
                  border: '1px solid rgba(0,0,0,0.06)',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}>
                  {/* Acción: agregar/editar mensaje */}
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <button
                      onClick={() => setIsSheetOpen(true)}
                      style={{
                        background: 'none', border: 'none',
                        display: 'flex', alignItems: 'center', gap: 8,
                        color: 'var(--color-primary-dark)',
                        fontSize: 14, fontWeight: 600, cursor: 'pointer',
                        padding: '6px 12px', borderRadius: 10,
                        transition: 'background 0.2s ease',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.03)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                    >
                      <PencilLine size={16} />
                      {personalMessage.trim() ? t('edit', 'Editar mensaje') : t('invitation.add_message', 'Agregar mensaje')}
                    </button>
                  </div>

                  {/* Vista previa del mensaje si existe */}
                  {personalMessage.trim() && (
                    <div style={{
                      background: '#F9FAFB', borderRadius: 10,
                      padding: '10px 14px', border: '1px solid rgba(0,0,0,0.05)',
                      animation: 'fadeIn 0.3s ease'
                    }}>
                      <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                        {t('invitation.organizer_message', 'Mensaje del organizador')}
                      </p>
                      <p style={{ margin: 0, fontSize: 13, color: '#374151', lineHeight: 1.5, fontStyle: 'italic' }}>
                        "{personalMessage}"
                      </p>
                    </div>
                  )}

                  {/* Botón principal: compartir */}
                  <Button
                    fullWidth
                    variant={(fromCancelled ? copiedNewShare : copiedShare) ? 'secondary' : 'primary'}
                    style={{ height: 50, fontSize: 15, fontWeight: 700 }}
                    onClick={fromCancelled ? handleShareNewEncuentro : handleShareGeneral}
                  >
                    {(fromCancelled ? copiedNewShare : copiedShare)
                      ? `✓ ${t('share.copied', 'Mensaje copiado')}`
                      : (fromCancelled ? 'Compartir nuevo enlace' : t('share.button_invitation', 'Compartir invitación'))}
                  </Button>

                  {/* Feedback post-compartir */}
                  {shareFeedback && !copiedShare && (
                    <p style={{ fontSize: 13, color: 'var(--color-primary-dark)', textAlign: 'center', margin: 0, fontWeight: 500, animation: 'fadeIn 0.3s ease' }}>
                      {t('share.ready_host', 'Listo. Podés volver al inicio o revisar el encuentro.')}
                    </p>
                  )}
                  {copiedShare && (
                    <p style={{ fontSize: 13, color: 'var(--color-primary-dark)', textAlign: 'center', margin: 0, fontWeight: 500, lineHeight: 1.4, animation: 'fadeIn 0.3s ease' }}>
                      {t('invitation.desktop_copied', 'Mensaje copiado. Pegalo en WhatsApp Web, correo o donde quieras compartirlo.')}
                    </p>
                  )}

                  {/* Aclaración breve */}
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--color-on-surface-variant)', textAlign: 'center', lineHeight: 1.4 }}>
                    Quienes reciban el enlace podrán confirmar o rechazar su asistencia.
                  </p>
                </div>
              ) : (
                // --- Invitación individual o ?guests=1 ---
                <div style={{
                  background: '#fff', borderRadius: 16, padding: '16px 20px',
                  border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                }}>
                  <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: '#111827' }}>Agregar invitados</h3>
                  <div style={{
                    display: 'flex', gap: 0,
                    background: '#F9FAFB', borderRadius: 12,
                    border: '1px solid rgba(0,0,0,0.08)',
                    overflow: 'hidden', marginBottom: 16,
                  }}>
                    <input
                      ref={inputRef}
                      value={nombre}
                      onChange={e => setNombre(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAddGuest(); }}
                      placeholder="Nombre del invitado"
                      style={{
                        flex: 1, minWidth: 0, border: 'none', outline: 'none',
                        padding: '0 16px', height: 48, fontSize: 15,
                        fontFamily: 'var(--font-family)', color: 'var(--color-on-surface)',
                        background: 'transparent',
                      }}
                    />
                    <button
                      onClick={handleAddGuest}
                      disabled={!nombre.trim()}
                      style={{
                        background: nombre.trim() ? 'var(--color-primary)' : 'var(--color-surface-variant)',
                        color: nombre.trim() ? '#fff' : 'var(--color-on-surface-variant)',
                        border: 'none', cursor: nombre.trim() ? 'pointer' : 'not-allowed',
                        padding: '0 16px', fontFamily: 'var(--font-family)',
                        fontWeight: 700, fontSize: 14, transition: 'all 0.18s',
                        whiteSpace: 'nowrap', flexShrink: 0, minWidth: 96,
                      }}
                    >
                      + Agregar
                    </button>
                  </div>

                    Agregá personas y compartiles su invitación individual.
                </div>
              )}

              {/* Google sign-in nudge: solo cuando viene de ?share=1 y usuario no autenticado */}
              {isFromShare && !user && !loading && encuentro && (
                <div style={{
                  background: 'var(--color-primary-container)',
                  borderRadius: 16, padding: '16px 20px',
                  marginTop: 12,
                  border: '1px solid var(--color-primary)',
                  display: 'flex', flexDirection: 'column', gap: 10,
                  animation: 'fadeIn 0.5s ease-out'
                }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: 'var(--color-primary)', lineHeight: 1.3 }}>
                    {t('account.save_encounter_title', 'Guardá este encuentro en tu cuenta')}
                  </p>
                  <p style={{ margin: 0, fontSize: 13, color: '#374151', lineHeight: 1.5 }}>
                    {t('account.save_encounter_desc', 'Accedé desde otros dispositivos y mantené tu historial organizado.')}
                  </p>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 2 }}>
                    <Button
                      variant="primary" size="sm"
                      onClick={() => signInWithGoogle()}
                      style={{ padding: '0 18px', height: 36 }}
                    >
                      {t('account.continue_google', 'Continuar con Google')}
                    </Button>
                  </div>
                </div>
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
                onClick={() => openExternalVideoLink(encuentro.link_virtual)}
                style={{
                  flex: 1, padding: 12, borderRadius: 10,
                  background: 'var(--color-primary-container)', color: 'var(--color-primary-dark)',
                  fontWeight: 600, border: 'none', fontSize: 14, cursor: 'pointer',
                  transition: 'background 0.15s ease'
                }}
              >
                Unirme a la videollamada
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
              <p style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-primary-dark)', marginBottom: 6 }}>
                Encuentro anterior cancelado
              </p>
              <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-on-surface)', marginBottom: 8 }}>
                {fromCancelled.oldTitulo} — {fromCancelled.oldFecha}
              </p>
              <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', margin: 0, lineHeight: 1.4 }}>
                Este nuevo encuentro reemplaza al anterior. Al compartir el enlace, los invitados recibirán la nueva invitación.
              </p>
            </div>
          )}

          {/* 5. PARTICIPANTES */}
          <div style={{ marginBottom: 40 }}>
            <h3 style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginBottom: hasAnyResponse ? 2 : 16 }}>
              Participantes
            </h3>
            {hasAnyResponse && (
              <p style={{ fontSize: 12, color: '#6B7280', marginTop: 0, marginBottom: 16 }}>
                {[
                  formatCount(confirmados.length, 'confirmado', 'confirmados'),
                  formatCount(pendientes.length, 'pendiente', 'pendientes'),
                  formatCount(rechazados.length, 'no asiste', 'no asisten'),
                ].filter(Boolean).join(' · ')}
              </p>
            )}

            <>
              {!hasAnyResponse && (
                (searchParams.get('guests') === '1' || encuentro.tipo_invitacion !== 'link_general')
                  ? (
                    <div style={{
                      padding: '10px 14px',
                      background: 'rgba(0,0,0,0.02)',
                      borderRadius: 10,
                      border: '1px solid rgba(0,0,0,0.06)',
                      marginBottom: 16,
                    }}>
                      <p style={{ margin: 0, fontSize: 13, color: '#6B7280', lineHeight: 1.4 }}>
                        Los invitados aparecerán acá cuando los agregues.
                      </p>
                    </div>
                  )
                  : (
                    <div style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.02)', borderRadius: 10, border: '1px solid rgba(0,0,0,0.06)', marginBottom: 16 }}>
                      <p style={{ margin: 0, fontSize: 13, color: '#6B7280', lineHeight: 1.4 }}>Todavía no hay respuestas. Compartí el enlace para empezar a recibir confirmaciones.</p>
                    </div>
                  )
              )}
              {renderParticipantList('Confirmados', confirmados)}
              {renderParticipantList('Pendientes', pendientes)}
              {renderParticipantList('No asisten', rechazados)}
            </>
          </div>

          {/* 5b. OPCIONES DEL ENCUENTRO — Visibilidad para invitados */}
          {!isReadOnly && !isCancelado && (
            <div style={{
              background: '#fff', borderRadius: 14, padding: '14px 16px',
              border: '1px solid rgba(0,0,0,0.06)',
              boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
              marginBottom: 24,
            }}>
              <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Opciones del encuentro
              </p>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600, color: '#111827', lineHeight: 1.3 }}>
                    Permitir que los invitados vean las respuestas
                  </p>
                  <p style={{ margin: 0, fontSize: 12, color: '#6B7280', lineHeight: 1.45 }}>
                    Si activás esta opción, los invitados podrán ver quién confirmó, quién no asiste y quién todavía falta responder. Los mensajes privados no serán visibles.
                  </p>
                </div>
                {/* Toggle switch */}
                <button
                  onClick={() => handleToggleVisibilidad(!visibilidadRespuestas)}
                  disabled={savingVisibilidad}
                  aria-pressed={visibilidadRespuestas}
                  style={{
                    width: 44, height: 24, borderRadius: 12, border: 'none',
                    background: visibilidadRespuestas ? 'var(--color-primary)' : '#D1D5DB',
                    cursor: savingVisibilidad ? 'not-allowed' : 'pointer',
                    position: 'relative', flexShrink: 0, transition: 'background 0.2s',
                    opacity: savingVisibilidad ? 0.6 : 1,
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 3,
                    left: visibilidadRespuestas ? 23 : 3,
                    width: 18, height: 18, borderRadius: 9,
                    background: '#fff',
                    transition: 'left 0.2s',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                    display: 'block',
                  }} />
                </button>
              </div>
              {visibilidadFeedback && (
                <p style={{
                  margin: '8px 0 0', fontSize: 12, fontWeight: 500,
                  color: visibilidadFeedback === 'ok' ? '#059669' : '#DC2626',
                  animation: 'fadeIn 0.2s ease',
                }}>
                  {visibilidadFeedback === 'ok' ? '✓ Visibilidad actualizada' : '✗ Error al guardar'}
                </p>
              )}
            </div>
          )}

          {!isReadOnly && !isCancelado && (
            <div style={{
              background: '#fff', borderRadius: 14, padding: '14px 16px',
              border: '1px solid rgba(0,0,0,0.06)',
              boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
              marginBottom: 24,
            }}>
              <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Alias del anfitrión
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <p style={{ margin: 0, fontSize: 13, color: '#6B7280', lineHeight: 1.45 }}>
                  Se usará para que tus invitaciones indiquen quién invita. Este nombre sólo se usa para personalizar tus invitaciones en este dispositivo.
                </p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    value={hostAlias}
                    onChange={e => setHostAliasState(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveAlias(); }}
                    placeholder="Ej: Leandro"
                    style={{
                      flex: 1, minWidth: 0, border: '1px solid rgba(0,0,0,0.1)', outline: 'none',
                      padding: '0 12px', height: 40, fontSize: 14, borderRadius: 8,
                      fontFamily: 'var(--font-family)', color: 'var(--color-on-surface)',
                      background: '#F9FAFB',
                    }}
                  />
                  <button
                    onClick={handleSaveAlias}
                    style={{
                      background: 'var(--color-primary-container)',
                      color: 'var(--color-primary-dark)',
                      border: '1px solid var(--color-primary)',
                      cursor: 'pointer', padding: '0 16px', height: 40, borderRadius: 8,
                      fontFamily: 'var(--font-family)', fontWeight: 600, fontSize: 13, 
                      transition: 'all 0.15s', whiteSpace: 'nowrap',
                    }}
                  >
                    Guardar
                  </button>
                </div>
                {aliasFeedback && (
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 500, color: '#059669', animation: 'fadeIn 0.2s ease' }}>
                    ✓ Guardado
                  </p>
                )}
              </div>
            </div>
          )}

          {/* 6. ACCIONES INFERIORES */}
          <div style={{ marginTop: 'auto', paddingTop: 32, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {!isCancelado && !isReadOnly && (
              <Button
                variant="outline"
                onClick={() => setShowCancelModal(true)}
                style={{ borderColor: '#DC2626', color: '#DC2626' }}
                fullWidth
              >
                Cancelar encuentro
              </Button>
            )}

            <Button
              variant="ghost"
              onClick={() => navigate('/')}
              style={{ color: 'var(--color-on-surface-variant)', border: 'none' }}
              fullWidth
            >
              Ir al inicio
            </Button>
          </div>
        </div>
      )}

      {/* OrganizerMessageSheet — para link_general */}
      <OrganizerMessageSheet
        isOpen={isSheetOpen}
        onClose={() => setIsSheetOpen(false)}
        initialMessage={personalMessage}
        onSave={setPersonalMessage}
      />

      {/* Modal para ver mensaje de invitado */}
      {selectedGuestMessage && (
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
            <h3 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>{selectedGuestMessage.nombre_invitado}</h3>
            <span style={{ 
              display: 'inline-block', padding: '4px 8px', borderRadius: 6, fontSize: 12, fontWeight: 700,
              background: selectedGuestMessage.estado === 'confirmado' ? '#D1FAE5' : selectedGuestMessage.estado === 'rechazado' ? '#FEE2E2' : '#F3F4F6',
              color: selectedGuestMessage.estado === 'confirmado' ? '#047857' : selectedGuestMessage.estado === 'rechazado' ? '#B91C1C' : '#4B5563',
              marginBottom: 20
            }}>
              {selectedGuestMessage.estado === 'confirmado' ? 'Confirmado' : selectedGuestMessage.estado === 'rechazado' ? 'No asiste' : 'Pendiente'}
            </span>
            <div style={{
              background: '#F9FAFB', padding: '16px', borderRadius: 12,
              border: '1px solid rgba(0,0,0,0.05)', marginBottom: 24,
              fontSize: 15, color: '#374151', lineHeight: 1.5, fontStyle: 'italic'
            }}>
              "{selectedGuestMessage.mensaje_respuesta}"
            </div>
            <Button fullWidth variant="outline" onClick={() => setSelectedGuestMessage(null)}>
              Cerrar
            </Button>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}} />

      <ScrollHint visible={showScrollHint} />
    </ScreenContainer>
  );
};

export default DetailHost;
