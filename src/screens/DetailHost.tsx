import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { MoreVertical, PencilLine, MessageSquare } from 'lucide-react';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate, isEncuentroPasado } from '@/lib/formatDate';
import { formatFechaHoraWhatsApp, preventNumberLinking } from '@/lib/formatWhatsapp';
import { useDetailStore } from '@/store/detailStore';
import { openExternalVideoLink } from '@/lib/openLink';
import throttle from 'lodash/throttle';
import { getThemeStyle } from '@/lib/themes';
import { useHomeStore } from '@/store/homeStore';
import { useAuth } from '@/contexts/AuthContext';
import { getHostId } from '@/lib/auth';
import { getEncuentroHost, rememberEncuentroHost } from '@/lib/meetHostsStorage';
import { MapPin, Video, CheckCircle2, XCircle, Clock, User, Eye, Palette, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ScrollHint } from '@/components/ui/ScrollHint';
import { OrganizerMessageSheet } from '@/components/ui/OrganizerMessageSheet';
import { InvitationPreviewModal } from '@/components/ui/InvitationPreviewModal';
import { InvitationThemeSelector } from '@/components/ui/InvitationThemeSelector';
import { KidsBirthdayTemplateSelector } from '@/components/ui/KidsBirthdayTemplateSelector';
import { CelebrationTemplateSelector } from '@/components/ui/CelebrationTemplateSelector';
import { RomanticTemplateSelector } from '@/components/ui/RomanticTemplateSelector';
import { FormalTemplateSelector } from '@/components/ui/FormalTemplateSelector';
import { FriendsTemplateSelector } from '@/components/ui/FriendsTemplateSelector';
import { FamilyTemplateSelector } from '@/components/ui/FamilyTemplateSelector';
import { SpecialTemplateSelector } from '@/components/ui/SpecialTemplateSelector';
import { SportsTemplateSelector } from '@/components/ui/SportsTemplateSelector';
import { EntertainmentTemplateSelector } from '@/components/ui/EntertainmentTemplateSelector';
import { LearningTemplateSelector } from '@/components/ui/LearningTemplateSelector';
import { WellnessTemplateSelector } from '@/components/ui/WellnessTemplateSelector';
import type { InvitationTheme } from '@/lib/invitationThemes';
import { getDefaultInvitationTemplate, getThemeFromTemplate } from '@/lib/invitationThemes';
import { useWizardStore } from '@/store/wizardStore';
import { getHostAlias, setHostAlias } from '@/lib/hostAliasStorage';
import { formatCount } from '@/lib/formatCount';
import { isMobileShareEnvironment, buildGeneralInvitationUrl } from '@/lib/shareHelper';
import './DetailHost.css';

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

  // UX: Preview and Theme Selector
  const [showPreview, setShowPreview] = useState(false);
  const [showThemeSelector, setShowThemeSelector] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);

  const { user, loading: authLoading, signInWithGoogle } = useAuth();

  // Estados para invitado individual
  const [nombre, setNombre] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedGuestMessage, setSelectedGuestMessage] = useState<any>(null);
  // Marca local de invitaciones ya compartidas (persiste en localStorage)
  const [sharedInvites, setSharedInvites] = useState<Record<string, boolean>>({});
  // Opciones de visibilidad
  const [visibilidadRespuestas, setVisibilidadRespuestas] = useState(false);
  const [savingVisibilidad, setSavingVisibilidad] = useState(false);
  const [visibilidadFeedback, setVisibilidadFeedback] = useState<'ok' | 'error' | null>(null);

  const [isParticipantsExpanded, setIsParticipantsExpanded] = useState(false);

  // Estados para alias de anfitrión
  const [hostAlias, setHostAliasState] = useState(getHostAlias());
  const [isEditingAlias, setIsEditingAlias] = useState(false);
  const [tempAlias, setTempAlias] = useState('');

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

  useEffect(() => {
    if (participantes && participantes.length > 0) {
      setIsParticipantsExpanded(true);
    }
  }, [participantes.length]);

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

  useEffect(() => {
    if (encuentro?.descripcion && personalMessage === '') {
      setPersonalMessage(encuentro.descripcion);
    }
  }, [encuentro?.descripcion]);

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

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const handleApplyDesign = async (theme: string, template: string | null) => {
    if (!encuentro || themeSaving) return;
    setThemeSaving(true);

    const payload = {
      tema_invitacion: theme as InvitationTheme,
      invitation_template: template ?? null
    };

    try {
      await encuentrosService.updateEncuentro(encuentro.id, payload, hostIdRef.current!);
      const updatedEnc = { ...encuentro, ...payload };

      setEncuentro(updatedEnc);
      useDetailStore.getState().setDetailData(encuentro.id, updatedEnc, participantes);
      setShowPreview(false);
    } catch (err) {
      console.error('Error al aplicar diseño:', err);
    } finally {
      setThemeSaving(false);
    }
  };

  const handleThemeChange = async (newThemeOrTemplate: string) => {
    if (!encuentro || themeSaving) return;
    setThemeSaving(true);
    const oldTema = encuentro.tema_invitacion;
    const oldTemplate = encuentro.invitation_template;

    // Detectar si el valor recibido es un template interno (kids o celebration)
    const kidTemplates = ['kids_jungle', 'kids_unicorn', 'kids_space'];
    const celebrationTemplates = ['celebration_gold', 'celebration_festiva', 'celebration_blue_party'];
    const romanticTemplates = ['romantic_classic', 'romantic_young', 'romantic_pride'];
    const formalTemplates = ['formal_black_tie', 'formal_ivory', 'formal_executive'];
    const friendsTemplates = ['friends_coffee', 'friends_night', 'friends_picnic'];
    const familyTemplates = ['family_home', 'family_sunday', 'family_memories'];
    const specialTemplates = ['special_moment', 'special_surprise', 'special_tribute'];
    const sportsTemplates = ['sports_field', 'sports_team', 'sports_competition'];
    const entertainmentTemplates = ['entertainment_cinema', 'entertainment_music', 'entertainment_show'];
    const learningTemplates = ['learning_class', 'learning_course', 'learning_talk'];
    const wellnessTemplates = ['wellness_calm', 'wellness_nature', 'wellness_movement'];

    const isKidsTemplate = kidTemplates.includes(newThemeOrTemplate);
    const isCelebrationTemplate = celebrationTemplates.includes(newThemeOrTemplate);
    const isRomanticTemplate = romanticTemplates.includes(newThemeOrTemplate);
    const isFormalTemplate = formalTemplates.includes(newThemeOrTemplate);
    const isFriendsTemplate = friendsTemplates.includes(newThemeOrTemplate);
    const isFamilyTemplate = familyTemplates.includes(newThemeOrTemplate);
    const isSpecialTemplate = specialTemplates.includes(newThemeOrTemplate);
    const isSportsTemplate = sportsTemplates.includes(newThemeOrTemplate);
    const isEntertainmentTemplate = entertainmentTemplates.includes(newThemeOrTemplate);
    const isLearningTemplate = learningTemplates.includes(newThemeOrTemplate);
    const isWellnessTemplate = wellnessTemplates.includes(newThemeOrTemplate);

    let updates: Record<string, string | null>;
    if (isKidsTemplate) {
      updates = { tema_invitacion: 'kids_birthday', invitation_template: newThemeOrTemplate };
    } else if (isCelebrationTemplate) {
      updates = { tema_invitacion: 'celebration', invitation_template: newThemeOrTemplate };
    } else if (isRomanticTemplate) {
      updates = { tema_invitacion: 'romantic', invitation_template: newThemeOrTemplate };
    } else if (isFormalTemplate) {
      updates = { tema_invitacion: 'formal', invitation_template: newThemeOrTemplate };
    } else if (isFriendsTemplate) {
      updates = { tema_invitacion: 'friends', invitation_template: newThemeOrTemplate };
    } else if (isFamilyTemplate) {
      updates = { tema_invitacion: 'family', invitation_template: newThemeOrTemplate };
    } else if (isSpecialTemplate) {
      updates = { tema_invitacion: 'special', invitation_template: newThemeOrTemplate };
    } else if (isSportsTemplate) {
      updates = { tema_invitacion: 'sports', invitation_template: newThemeOrTemplate };
    } else if (isEntertainmentTemplate) {
      updates = { tema_invitacion: 'entertainment', invitation_template: newThemeOrTemplate };
    } else if (isLearningTemplate) {
      updates = { tema_invitacion: 'learning', invitation_template: newThemeOrTemplate };
    } else if (isWellnessTemplate) {
      updates = { tema_invitacion: 'wellness', invitation_template: newThemeOrTemplate };
    } else if (newThemeOrTemplate.startsWith('custom_')) {
      updates = { tema_invitacion: 'custom', invitation_template: newThemeOrTemplate };
    } else {
      // Cambio de tema principal (classic, formal, friends, celebration, kids_birthday, etc.)
      updates = { tema_invitacion: newThemeOrTemplate as InvitationTheme, invitation_template: null };

      const defaultTemplate = getDefaultInvitationTemplate(newThemeOrTemplate as InvitationTheme);
      if (defaultTemplate) {
        updates.invitation_template = defaultTemplate;
      }
    }

    // Optimistic local update
    setEncuentro((prev: any) => ({ ...prev, ...updates }));

    try {
      await encuentrosService.updateEncuentro(encuentro.id, updates, hostIdRef.current!);

      const themesWithVariants = ['kids_birthday', 'celebration', 'sports', 'romantic', 'formal', 'friends', 'family', 'special', 'entertainment', 'learning', 'wellness'];
      if (themesWithVariants.includes(newThemeOrTemplate)) {
        // Keep the bottom sheet open so the user can see the variants selector immediately.
      } else {
        setShowThemeSelector(false);
      }
    } catch (e: any) {
      console.error('Failed to change theme', e);
      // Rollback
      setEncuentro((prev: any) => ({ ...prev, tema_invitacion: oldTema, invitation_template: oldTemplate }));
      alert('Error al cambiar el diseño: ' + (e?.message || 'Intente nuevamente'));
    } finally {
      setThemeSaving(false);
    }
  };

  const handleSavePersonalMessage = async (msg: string) => {
    setPersonalMessage(msg);
    if (!encuentro) return;
    try {
      setEncuentro((prev: any) => ({ ...prev, descripcion: msg }));
      await encuentrosService.updateEncuentro(encuentro.id, { descripcion: msg }, hostIdRef.current!);
    } catch (err) {
      console.error('Error saving message', err);
    }
  };

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
      const isBottom = totalHeight - scrollY - viewportHeight < 120;
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
      navigate('/create', { state: { autoFocusTitle: true } });
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


    const alias = getHostAlias();
    const intro = alias
      ? `${alias} creó un nuevo encuentro en reemplazo del anterior 👇`
      : 'Creé un nuevo encuentro en reemplazo del anterior 👇';

    const msg = `${intro}\n\nConfirmá si podés asistir:\n${newLink}`;

    if (isMobileShareEnvironment() && navigator.share) {
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
      <div className="dh-centered">
        <p className="dh-loading-text">Cargando detalle…</p>
      </div>
    </ScreenContainer>
  );

  if (error || !encuentro) return (
    <ScreenContainer>
      <AppBar title="Error" showBack />
      <div className="dh-error-container">
        <span className="dh-error-icon">⚠️</span>
        <p className="dh-error-text">
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
    if (isCancelado) return { label: 'Cancelado', className: 'dh-badge--cancelled' };
    if (!encuentro.fecha || !encuentro.hora) return { label: 'Activo', className: 'dh-badge--active' };

    const now = new Date();
    const eventDate = new Date(`${encuentro.fecha}T${encuentro.hora}`);
    const diffMinutes = Math.round((eventDate.getTime() - now.getTime()) / 60000);

    if (diffMinutes < -45) return { label: 'Finalizado', className: 'dh-badge--finished' };
    if (diffMinutes <= 0) return { label: '🟢 En curso ahora', className: 'dh-badge--live' };
    if (diffMinutes <= 15) return { label: '🟢 Encuentro activo', className: 'dh-badge--live' };
    if (diffMinutes <= 60) return { label: `🟡 Empieza en ${diffMinutes} min`, className: 'dh-badge--soon' };

    return { label: 'Activo', className: 'dh-badge--active' };
  };

  const badge = getEventStatusBadge();

  // Handler para compartir invitación general (link_general)
  const handleToggleVisibilidad = async (newValue: boolean) => {
    if (savingVisibilidad) return;
    const hostId = hostIdRef.current ?? (user?.id ?? getHostId());
    setSavingVisibilidad(true);
    setVisibilidadFeedback(null);
    try {
      await encuentrosService.setVisibilidadRespuestasInvitados(id!, hostId, newValue ? 'summary' : 'hidden');
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
      const shareUrl = buildGeneralInvitationUrl(encuentro.public_token);
      if (!shareUrl) return;
      const { fechaStr, horaStr } = formatFechaHoraWhatsApp(encuentro.fecha, encuentro.hora);

      const alias = getHostAlias();
      const isKids = encuentro.tema_invitacion === 'kids_birthday';
      const aliasIntro = isKids
        ? (alias ? `🎉 ${alias} te invita al cumpleaños de 👇` : `🎉 Te invito al cumpleaños de 👇`)
        : (alias ? `${alias} te invita a este encuentro 👇` : `Te invito a este encuentro 👇`);

      const cleanLocation = preventNumberLinking(encuentro.lugar_texto || 'Presencial');
      const locStr = `${encuentro.modalidad === 'presencial' ? '📍' : '💻'} ${encuentro.modalidad === 'presencial' ? cleanLocation : 'Virtual'}`;

      let shareText = `${aliasIntro}\n\n*${encuentro.titulo.trim()}*\n📅 ${fechaStr} · ${horaStr}\n`;
      if (encuentro.modalidad === 'presencial' && encuentro.lugar_texto) {
        shareText += `${locStr}\n\n`;
      } else if (encuentro.modalidad === 'virtual') {
        shareText += `${locStr}\n\n`;
      } else {
        shareText += '\n'; // en caso de presencial sin lugar, evitamos salto grande si no es necesario o lo dejamos para consistencia
      }

      if (personalMessage.trim()) {
        shareText += `${personalMessage.trim()}\n\n`;
      }
      shareText += `👉 Confirmá acá:\n${shareUrl}`;

      if (isMobileShareEnvironment() && navigator.share) {
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
    if (!token || !encuentro) return;
    const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const shareUrl = `${baseUrl}/invite/${token}`;

    const { fechaStr, horaStr } = formatFechaHoraWhatsApp(encuentro.fecha, encuentro.hora);
    const alias = getHostAlias();
    const isKids = encuentro.tema_invitacion === 'kids_birthday';

    let aliasIntro = '';
    if (isKids) {
      if (guestName?.trim()) {
        aliasIntro = alias
          ? `🎉 ${guestName.trim()}, ${alias} te invita al cumpleaños de 👇`
          : `🎉 ${guestName.trim()}, te invito al cumpleaños de 👇`;
      } else {
        aliasIntro = alias ? `🎉 ${alias} te invita al cumpleaños de 👇` : `🎉 Te invito al cumpleaños de 👇`;
      }
    } else {
      if (guestName?.trim()) {
        aliasIntro = alias
          ? `${guestName.trim()}, ${alias} te invita a este encuentro 👇`
          : `${guestName.trim()}, te invito a este encuentro 👇`;
      } else {
        aliasIntro = alias ? `${alias} te invita a este encuentro 👇` : `Te invito a este encuentro 👇`;
      }
    }

    const cleanLocation = preventNumberLinking(encuentro.lugar_texto || 'Presencial');
    const locStr = `${encuentro.modalidad === 'presencial' ? '📍' : '💻'} ${encuentro.modalidad === 'presencial' ? cleanLocation : 'Virtual'}`;

    let shareText = `${aliasIntro}\n\n*${encuentro.titulo.trim()}*\n📅 ${fechaStr} · ${horaStr}\n`;
    if (encuentro.modalidad === 'presencial' && encuentro.lugar_texto) {
      shareText += `${locStr}\n\n`;
    } else if (encuentro.modalidad === 'virtual') {
      shareText += `${locStr}\n\n`;
    } else {
      shareText += '\n';
    }

    if (personalMessage.trim()) {
      shareText += `${personalMessage.trim()}\n\n`;
    }
    shareText += `👉 Confirmá acá:\n${shareUrl}`;

    if (isMobileShareEnvironment() && navigator.share) {
      try {
        await navigator.share({ title: encuentro.titulo || 'Invitación', text: shareText });
        markAsShared(partId); // marcar solo si el share completó sin error
      } catch (err: any) {
        // AbortError = usuario canceló el diálogo de share → no marcar
        if (err?.name !== 'AbortError') console.error('Error sharing', err);
      }
    } else {
      try {
        await navigator.clipboard.writeText(shareText);
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
      <div className="dh-participant-group">
        <h4 className="dh-participant-group-title">
          {title}
        </h4>
        <div className="dh-participant-list">
          {list.map(p => {
            const avatarChar = p.nombre_invitado ? p.nombre_invitado.charAt(0).toUpperCase() : '?';
            const sLabel = p.estado === 'confirmado' ? 'Confirmado' : p.estado === 'rechazado' ? 'No asiste' : 'Pendiente';
            const statusClass = p.estado === 'confirmado' ? 'confirmado' : p.estado === 'rechazado' ? 'rechazado' : 'pendiente';

            return (
              <div key={p.id} className="dh-participant-row">
                <div className={`dh-participant-avatar dh-participant-avatar--${statusClass}`}>
                  {avatarChar}
                </div>
                <div className="dh-participant-info" title={p.nombre_invitado}>
                  <span className="dh-participant-name">{p.nombre_invitado}</span>
                  {p.user_id && (
                    <div className="dh-participant-linked">
                      <User size={12} strokeWidth={2.5} />
                      <span>{t('participant.linked_account', 'Cuenta vinculada')}</span>
                    </div>
                  )}
                  {p.mensaje_respuesta && (
                    <button
                      onClick={() => setSelectedGuestMessage(p)}
                      className="dh-participant-msg-btn"
                    >
                      <MessageSquare size={14} />
                      <span>Ver mensaje</span>
                    </button>
                  )}
                </div>
                <div className="dh-participant-status-col">
                  <span className={`dh-participant-chip dh-participant-chip--${statusClass}`}>
                    {sLabel}
                  </span>
                </div>
                <div className="dh-participant-share-col">
                  {!isReadOnly && !isCancelado && p.token_invitacion && (
                    <button
                      onClick={() => handleShareLink(p.token_invitacion, p.id, p.nombre_invitado)}
                      className={`dh-participant-share-btn ${
                        copiedId === p.id
                          ? 'dh-participant-share-btn--copied'
                          : p.estado !== 'pendiente'
                          ? 'dh-participant-share-btn--reshare'
                          : sharedInvites[p.id]
                          ? 'dh-participant-share-btn--shared'
                          : 'dh-participant-share-btn--pending'
                      }`}
                    >
                      {copiedId === p.id ? '✓ Copiado' : p.estado !== 'pendiente' ? 'Reenviar' : (sharedInvites[p.id] ? '✓ Compartido' : 'Compartir')}
                    </button>
                  )}
                </div>
                <div className="dh-participant-delete-col">
                  {!isReadOnly && !isCancelado && (
                    <button
                      onClick={() => handleDeleteGuest(p.id)}
                      className="dh-participant-delete-btn"
                      title="Eliminar invitado"
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
    <div className="dh-modal-overlay">
      <div className="dh-bottom-sheet" style={{ paddingTop: 28 }}>
        <h3 className="dh-sheet-title">{delConfig.title}</h3>
        <p className="dh-sheet-text">
          {delConfig.desc}
        </p>
        <div className="dh-sheet-actions">
          <Button fullWidth variant="primary" style={{ background: 'var(--color-danger)', color: '#fff', border: 'none' }} onClick={handleDeleteEncuentro} disabled={isDeleting}>
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
    <div className="dh-modal-overlay">
      <div className="dh-bottom-sheet">
        {/* Drag handle */}
        <div className="dh-sheet-handle" />

        <h3 className="dh-sheet-title">
          ¿Qué querés hacer con este encuentro?
        </h3>
        <p className="dh-sheet-text">
          Si lo cancelás, el encuentro quedará marcado como cancelado.
          Después podrás compartir el aviso con los invitados.
        </p>

        <div className="dh-sheet-actions">
          {/* Opción 1: Cancelar y quedar en cancel-summary */}
          <Button
            fullWidth
            variant="outline"
            style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}
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
    const statusIcon = pEstado === 'confirmado' ? <CheckCircle2 size={18} color="var(--color-success)" /> :
                       pEstado === 'rechazado' ? <XCircle size={18} color="var(--color-danger)" /> : <Clock size={18} color="var(--color-on-surface-variant)" />;

    return (
      <div
        id="participant-scroll-container"
        onScroll={handleScroll}
        className="dh-participant-view-container"
      >
        <div className="dh-event-header">
          <div className="dh-title-row">
            <h2 className="dh-title">
              {encuentro.titulo}
            </h2>
            <div className={`dh-badge ${badge.className}`}>
              {badge.label}
            </div>
          </div>

          <div className="dh-meta-list">
            <div className="dh-meta-row">
              <Clock size={18} />
              <span className="dh-meta-text">{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span>
            </div>
            <div className="dh-meta-row">
              {isVirtual ? <Video size={18} /> : <MapPin size={18} />}
              <span>{isVirtual ? 'Virtual' : (encuentro.lugar_texto || 'Presencial')}</span>
            </div>
            {encuentro.descripcion && (
              <div className="dh-participant-view-desc">
                {encuentro.descripcion}
              </div>
            )}
          </div>
        </div>

        {/* Estado personal */}
        <div className="dh-participant-status-card">
          {statusIcon}
          <span className="dh-participant-status-label">{statusLabel}</span>
        </div>

        {isCancelado && (
          <div className="dh-participant-banner dh-participant-banner--cancelled">
            <p className="dh-participant-banner-text">El organizador canceló este encuentro.</p>
          </div>
        )}

        {isFinalizado && (
          <div className="dh-participant-banner dh-participant-banner--finished">
            <p className="dh-participant-banner-text">Este encuentro ya finalizó.</p>
          </div>
        )}

        {/* Acciones para participantes */}
        {!isCancelado && !isFinalizado && isVirtual && encuentro.link_virtual && (
          <div className="dh-participant-video-actions">
             <Button fullWidth className="dh-participant-video-btn" onClick={() => openExternalVideoLink(encuentro.link_virtual)}>
               Abrir videollamada
             </Button>
             <button
               onClick={handleCopyVideoLink}
               className="dh-participant-video-copy-btn"
             >
               {copiedLink ? 'Copiado' : 'Copiar link de la reunión'}
             </button>
          </div>
        )}

        <div className="dh-participant-bottom-actions">
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
          <div className="dh-context-menu-container">
            <button
              onClick={() => setShowContextMenu(!showContextMenu)}
              className="dh-context-menu-btn"
            >
              <MoreVertical size={20} />
            </button>
            {showContextMenu && (
              <>
                <div
                  onClick={() => setShowContextMenu(false)}
                  className="dh-context-menu-overlay"
                />
                <div className="dh-context-menu-dropdown">
                  <button
                    onClick={() => { setShowContextMenu(false); navigate('/', { replace: true }); }}
                    className="dh-context-menu-item dh-context-menu-item--regular"
                  >
                    Ir al inicio
                  </button>
                  <button
                    onClick={() => { setShowContextMenu(false); setShowDeleteModal(true); }}
                    className="dh-context-menu-item dh-context-menu-item--danger"
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
          <div className="dh-event-header">
            <div className="dh-title-row">
              <h2 className="dh-title">
                {encuentro.titulo}
              </h2>
              <div className={`dh-badge ${badge.className}`}>
                {badge.label}
              </div>
            </div>
            <div className="dh-meta-list">
              <div className="dh-meta-row">
                <span>📅</span> <span className="dh-meta-text">{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span>
              </div>
              <div className="dh-meta-row">
                <span>{isVirtual ? '💻' : '📍'}</span> <span className="dh-meta-text">{isVirtual ? 'Virtual' : (encuentro.lugar_texto || 'Presencial')}</span>
              </div>
              {encuentro.descripcion && (
                <div className="dh-description">
                  {encuentro.descripcion}
                </div>
              )}
            </div>
          </div>

          {/* MODO SOLO LECTURA BANNER */}
          {isReadOnly && (
            <div className="dh-banner dh-banner--readonly">
              <span className="dh-banner-icon">🔒</span>
              <span className="dh-banner-text">
                Este encuentro ya finalizó. No se puede modificar.
              </span>
            </div>
          )}

          {/* 1.5 ALIAS DEL ANFITRIÓN COMPACTO */}
          {!isReadOnly && !isCancelado && (
            <div className="dh-alias-bar">
              {isEditingAlias ? (
                <div className="dh-alias-editing-group">
                  <input
                    value={tempAlias}
                    onChange={e => setTempAlias(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        setHostAlias(tempAlias);
                        setHostAliasState(tempAlias.trim().substring(0, 40));
                        setIsEditingAlias(false);
                      }
                    }}
                    placeholder="Tu nombre o apodo"
                    autoFocus
                    className="dh-alias-input"
                  />
                  <button
                    onClick={() => {
                      setHostAlias(tempAlias);
                      setHostAliasState(tempAlias.trim().substring(0, 40));
                      setIsEditingAlias(false);
                    }}
                    className="dh-alias-save-btn"
                  >
                    Guardar
                  </button>
                </div>
              ) : (
                <>
                  <div className="dh-alias-text">
                    Invitás como: <span className="dh-alias-name">{hostAlias || 'Sin alias'}</span>
                  </div>
                  <button
                    onClick={() => {
                      setTempAlias(hostAlias);
                      setIsEditingAlias(true);
                    }}
                    className="dh-alias-toggle-btn"
                  >
                    {hostAlias ? 'Cambiar' : 'Agregar'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* 2. BLOQUE DE INVITACIÓN UNIFICADO */}
          {!isReadOnly && !isCancelado && (
            <div style={{ marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* BLOQUE: AGREGAR MENSAJE (solo link_general) */}
              {encuentro.tipo_invitacion === 'link_general' && (
                <div className="dh-invite-card" style={{ padding: '20px' }}>
                  <h4 style={{ margin: '0 0 12px 0', fontSize: 15, fontWeight: 700, color: 'var(--color-on-surface)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <MessageSquare size={18} />
                    Mensaje del organizador
                  </h4>
                  {personalMessage.trim() ? (
                    <>
                      <div className="dh-invite-msg-preview dh-fade-in" style={{ marginBottom: 16 }}>
                        <p className="dh-invite-msg-text" style={{ margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          "{personalMessage}"
                        </p>
                      </div>
                      <Button variant="outline" fullWidth onClick={() => setIsSheetOpen(true)} style={{ height: 44, fontSize: 14, fontWeight: 600 }}>
                        <PencilLine size={18} style={{ marginRight: 8 }} />
                        Editar mensaje
                      </Button>
                    </>
                  ) : (
                    <>
                      <p style={{ margin: '0 0 16px 0', fontSize: 13, color: 'var(--color-on-surface-variant)', lineHeight: 1.5 }}>
                        Sumá un mensaje opcional para tus invitados.
                      </p>
                      <Button variant="outline" fullWidth onClick={() => setIsSheetOpen(true)} style={{ height: 44, fontSize: 14, fontWeight: 600 }}>
                        <PencilLine size={18} style={{ marginRight: 8 }} />
                        Agregar mensaje
                      </Button>
                    </>
                  )}
                </div>
              )}

              {/* BLOQUE: REVISÁ ANTES DE COMPARTIR */}
              <div className="dh-review-section" style={{ padding: '20px', background: 'var(--color-surface-variant)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-outline-variant)' }}>
                <h4 style={{ margin: '0 0 8px 0', fontSize: 15, fontWeight: 700, color: 'var(--color-on-surface)' }}>Revisá antes de compartir</h4>
                <p style={{ margin: '0 0 20px 0', fontSize: 13, color: 'var(--color-on-surface-variant)', lineHeight: 1.5 }}>
                  Podés ver cómo recibirán la invitación tus invitados o cambiar el diseño antes de enviarla.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Button variant="primary" fullWidth onClick={() => setShowPreview(true)} style={{ height: 48, fontSize: 15, fontWeight: 700 }}>
                    <Eye size={18} style={{ marginRight: 8 }} />
                    Previsualizar invitación
                  </Button>
                  <Button variant="outline" fullWidth onClick={() => setShowThemeSelector(true)} style={{ height: 44, fontSize: 14, fontWeight: 600 }}>
                    <Palette size={18} style={{ marginRight: 8 }} />
                    Cambiar diseño
                  </Button>
                </div>
              </div>

              {/* BLOQUE: COMPARTIR INVITACIÓN O AGREGAR INVITADOS */}
              {encuentro.tipo_invitacion === 'link_general' ? (
                // --- Link general: compartir ---
                <div className="dh-invite-card" style={{ padding: '20px' }}>
                  <h4 style={{ margin: '0 0 16px 0', fontSize: 15, fontWeight: 700, color: 'var(--color-on-surface)' }}>Compartir invitación</h4>
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

                  {shareFeedback && !copiedShare && (
                    <p className="dh-fade-in" style={{ fontSize: 13, color: 'var(--color-primary-dark)', textAlign: 'center', marginTop: 16, marginBottom: 0, fontWeight: 500 }}>
                      {t('share.ready_host', 'Listo. Podés volver al inicio o revisar el encuentro.')}
                    </p>
                  )}
                  {copiedShare && (
                    <p className="dh-fade-in" style={{ fontSize: 13, color: 'var(--color-primary-dark)', textAlign: 'center', marginTop: 16, marginBottom: 0, fontWeight: 500, lineHeight: 1.4 }}>
                      {t('invitation.desktop_copied', 'Mensaje copiado. Pegalo en WhatsApp Web, correo o donde quieras compartirlo.')}
                    </p>
                  )}

                  <p className="dh-invite-help" style={{ marginTop: 16, marginBottom: 0 }}>
                    Quienes reciban el enlace podrán confirmar o rechazar su asistencia.
                  </p>
                </div>
              ) : (
                // --- Invitación individual o ?guests=1 ---
                <div className="dh-invite-card" style={{ padding: '20px' }}>
                  <h3 className="dh-invite-title" style={{ margin: '0 0 16px 0' }}>Agregar invitados</h3>
                  <div className="dh-add-guest-input-group">
                    <input
                      ref={inputRef}
                      value={nombre}
                      onChange={e => setNombre(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAddGuest(); }}
                      placeholder="Nombre del invitado"
                      className="dh-add-guest-input"
                    />
                    <button
                      onClick={handleAddGuest}
                      disabled={!nombre.trim()}
                      className="dh-add-guest-btn"
                    >
                      + Agregar
                    </button>
                  </div>

                  <p className="dh-invite-help" style={{ marginTop: 16, marginBottom: 0 }}>
                    Agregá personas y compartiles su invitación individual.
                  </p>
                </div>
              )}

              {/* Google sign-in nudge: solo cuando viene de ?share=1 y usuario no autenticado */}
              {isFromShare && !user && !loading && encuentro && (
                <div className="dh-fade-in" style={{
                  background: 'var(--color-primary-container)',
                  borderRadius: 16, padding: '16px 20px',
                  border: '1px solid var(--color-primary)',
                  display: 'flex', flexDirection: 'column', gap: 10,
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
                      onClick={async () => {
                        const result = await signInWithGoogle();
                        if (!result.ok && result.error !== 'anonymous_account_linking_pending') {
                          alert('Hubo un problema al iniciar sesión.');
                        }
                      }}
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
            <div className="dh-compact-link-bar" style={{ marginBottom: isReadOnly ? 32 : 16 }}>
              <span className="dh-compact-link-text">
                🔗 {encuentro.link_virtual.replace(/^https?:\/\//, '')}
              </span>
              {!isReadOnly && (
                <button onClick={handleCopyVideoLink} className="dh-compact-link-copy-btn">
                  {copiedLink ? 'Copiado' : 'Copiar enlace'}
                </button>
              )}
            </div>
          )}

          {/* 4. ACCIONES SECUNDARIAS */}
          {!isReadOnly && !isCancelado && isVirtual && (
            <div className="dh-secondary-actions-group">
              <button
                onClick={() => openExternalVideoLink(encuentro.link_virtual)}
                className="dh-join-video-btn"
              >
                Unirme a la videollamada
              </button>
            </div>
          )}

          {/* BANNER REPETIR CANCELADO */}
          {fromCancelled && (
            <div className="dh-banner--info">
              <p className="dh-banner-title">
                Encuentro anterior cancelado
              </p>
              <p className="dh-banner-subtitle">
                {fromCancelled.oldTitulo} — {fromCancelled.oldFecha}
              </p>
              <p className="dh-banner-text">
                Este nuevo encuentro reemplaza al anterior. Al compartir el enlace, los invitados recibirán la nueva invitación.
              </p>
            </div>
          )}

          {/* 5. OPCIONES DEL ENCUENTRO — Visibilidad para invitados */}
          {!isReadOnly && !isCancelado && (
            <div className="dh-options-card" style={{ marginBottom: 24 }}>
              <p className="dh-options-label">
                Opciones del encuentro
              </p>
              <div className="dh-options-row">
                <div className="dh-options-text-group">
                  <p className="dh-options-title">
                    Invitados ven respuestas
                  </p>
                  <p className="dh-options-desc">
                    Verán confirmados, no asisten y pendientes. Los mensajes privados no se comparten.
                  </p>
                </div>
                {/* Toggle switch */}
                <button
                  onClick={() => handleToggleVisibilidad(!visibilidadRespuestas)}
                  disabled={savingVisibilidad}
                  aria-pressed={visibilidadRespuestas}
                  className="dh-toggle-switch"
                >
                  <span className="dh-toggle-thumb" />
                </button>
              </div>
              {visibilidadFeedback && (
                <p className={`dh-fade-in dh-options-feedback dh-options-feedback--${visibilidadFeedback === 'ok' ? 'success' : 'error'}`}>
                  {visibilidadFeedback === 'ok' ? '✓ Visibilidad actualizada' : '✗ Error al guardar'}
                </p>
              )}
            </div>
          )}

          {/* 6. PARTICIPANTES */}
          <div className="dh-participants-section" style={{ paddingBottom: isParticipantsExpanded ? 20 : 0 }}>
            <button
              onClick={() => setIsParticipantsExpanded(!isParticipantsExpanded)}
              style={{
                width: '100%',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'transparent',
                border: 'none',
                padding: '20px',
                margin: 0,
                textAlign: 'left',
                cursor: 'pointer'
              }}
            >
              <div>
                <h3 className="dh-participants-title" style={{ margin: 0, marginBottom: hasAnyResponse ? 4 : 0 }}>
                  Participantes
                </h3>
                {hasAnyResponse ? (
                  <p className="dh-participants-summary" style={{ margin: 0, fontSize: 13 }}>
                    {[
                      formatCount(confirmados.length, 'confirmado', 'confirmados'),
                      formatCount(pendientes.length, 'pendiente', 'pendientes'),
                      formatCount(rechazados.length, 'no asiste', 'no asisten'),
                    ].filter(Boolean).join(' · ')}
                  </p>
                ) : (
                  <p className="dh-participants-summary" style={{ margin: 0, fontSize: 13, color: 'var(--color-on-surface-variant)' }}>
                    Sin respuestas
                  </p>
                )}
              </div>
              <div style={{ color: 'var(--color-on-surface-variant)', display: 'flex', alignItems: 'center' }}>
                {isParticipantsExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </div>
            </button>

            {isParticipantsExpanded && (
              <div style={{ padding: '0 20px' }}>
                {!hasAnyResponse && (
                  (searchParams.get('guests') === '1' || encuentro.tipo_invitacion !== 'link_general')
                    ? (
                      <div className="dh-participants-empty" style={{ margin: 0 }}>
                        <p className="dh-participants-empty-text">
                          Los invitados aparecerán acá cuando los agregues.
                        </p>
                      </div>
                    )
                    : (
                      <div className="dh-participants-empty" style={{ margin: 0 }}>
                        <p className="dh-participants-empty-text">
                          Todavía no hay respuestas. Compartí el enlace para empezar a recibir confirmaciones.
                        </p>
                      </div>
                    )
                )}
                {renderParticipantList('Confirmados', confirmados)}
                {renderParticipantList('Pendientes', pendientes)}
                {renderParticipantList('No asisten', rechazados)}
              </div>
            )}
          </div>

          {/* 6. ACCIONES INFERIORES */}
          <div className="dh-bottom-actions">
            <div className="dh-bottom-actions-block">
              {!isCancelado && !isReadOnly && (
                <Button
                  variant="outline"
                  onClick={() => setShowCancelModal(true)}
                  style={{ borderColor: 'var(--color-danger)', color: 'var(--color-danger)' }}
                  fullWidth
                >
                  Cancelar encuentro
                </Button>
              )}

              <Button
                variant="outline"
                onClick={() => navigate('/')}
                style={{ color: 'var(--color-on-surface-variant)', borderColor: 'var(--color-outline-variant)' }}
                fullWidth
              >
                Ir al inicio
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* OrganizerMessageSheet — para link_general */}
      <OrganizerMessageSheet
        isOpen={isSheetOpen}
        onClose={() => setIsSheetOpen(false)}
        initialMessage={personalMessage}
        onSave={handleSavePersonalMessage}
      />

      {/* Modal para ver mensaje de invitado */}
      {selectedGuestMessage && (
        <div className="dh-modal-overlay">
          <div className="dh-bottom-sheet" style={{ paddingTop: 28 }}>
            <h3 className="dh-sheet-title">{selectedGuestMessage.nombre_invitado}</h3>
            <span className={`dh-sheet-guest-status dh-sheet-guest-status--${selectedGuestMessage.estado}`}>
              {selectedGuestMessage.estado === 'confirmado' ? 'Confirmado' : selectedGuestMessage.estado === 'rechazado' ? 'No asiste' : 'Pendiente'}
            </span>
            <div className="dh-sheet-message-box">
              "{selectedGuestMessage.mensaje_respuesta}"
            </div>
            <Button fullWidth variant="outline" onClick={() => setSelectedGuestMessage(null)}>
              Cerrar
            </Button>
          </div>
        </div>
      )}

      {/* Modal para ver preview de la invitación */}
      {showPreview && (
        <InvitationPreviewModal
          onClose={() => setShowPreview(false)}
          onApplyDesign={handleApplyDesign}
          previewData={{
            ...encuentro,
            descripcion: personalMessage?.trim() || encuentro.descripcion || ''
          }}
        />
      )}

      {/* Modal / Sheet para cambiar diseño */}
      {showThemeSelector && (
        (() => {
          const inferred = getThemeFromTemplate(encuentro.invitation_template);
          const resolvedSheetTheme = (encuentro.tema_invitacion === 'classic' && inferred)
            ? inferred
            : encuentro.tema_invitacion || inferred || 'classic';

          return (
            <div className="dh-modal-overlay" style={{ zIndex: 10000 }}>
              <div className="dh-bottom-sheet" style={{ padding: '24px 20px', maxHeight: '85vh', overflowY: 'auto' }}>
                <h3 className="dh-sheet-title" style={{ marginBottom: 16 }}>Cambiar diseño</h3>
                {resolvedSheetTheme === 'kids_birthday' ? (
                  <KidsBirthdayTemplateSelector
                    selectedTemplateId={encuentro.invitation_template || 'kids_jungle'}
                    onSelect={(id) => handleThemeChange(id)}
                    titulo={encuentro.titulo}
                    descripcion={encuentro.descripcion}
                    fecha={encuentro.fecha}
                    hora={encuentro.hora}
                    lugar_texto={encuentro.lugar_texto}
                  />
                ) : resolvedSheetTheme === 'celebration' ? (
                  <CelebrationTemplateSelector
                    selectedTemplateId={encuentro.invitation_template || 'celebration_gold'}
                    onSelect={(id) => handleThemeChange(id)}
                    titulo={encuentro.titulo}
                    descripcion={encuentro.descripcion}
                    fecha={encuentro.fecha}
                    hora={encuentro.hora}
                    lugar_texto={encuentro.lugar_texto}
                  />
                ) : resolvedSheetTheme === 'romantic' ? (
                  <RomanticTemplateSelector
                    selectedTemplateId={encuentro.invitation_template}
                    onSelect={(id) => handleThemeChange(id)}
                    titulo={encuentro.titulo}
                    descripcion={encuentro.descripcion}
                    fecha={encuentro.fecha}
                    hora={encuentro.hora}
                    lugar_texto={encuentro.lugar_texto}
                  />
                ) : resolvedSheetTheme === 'formal' ? (
                  <FormalTemplateSelector
                    selectedTemplateId={encuentro.invitation_template}
                    onSelect={(id) => handleThemeChange(id)}
                    titulo={encuentro.titulo}
                    descripcion={encuentro.descripcion}
                    fecha={encuentro.fecha}
                    hora={encuentro.hora}
                    lugar_texto={encuentro.lugar_texto}
                  />
                ) : resolvedSheetTheme === 'friends' ? (
                  <FriendsTemplateSelector
                    selectedTemplateId={encuentro.invitation_template}
                    onSelect={handleThemeChange}
                    titulo={encuentro.titulo}
                    descripcion={encuentro.descripcion}
                    fecha={encuentro.fecha}
                    hora={encuentro.hora}
                    lugar_texto={encuentro.lugar_texto}
                  />
                ) : resolvedSheetTheme === 'family' ? (
                  <FamilyTemplateSelector
                    selectedTemplateId={encuentro.invitation_template}
                    onSelect={(id) => handleThemeChange(id)}
                    titulo={encuentro.titulo}
                    descripcion={encuentro.descripcion}
                    fecha={encuentro.fecha}
                    hora={encuentro.hora}
                    lugar_texto={encuentro.lugar_texto}
                  />
                ) : resolvedSheetTheme === 'special' ? (
                  <SpecialTemplateSelector
                    selectedTemplateId={encuentro.invitation_template}
                    onSelect={(id) => handleThemeChange(id)}
                    titulo={encuentro.titulo}
                    descripcion={encuentro.descripcion}
                    fecha={encuentro.fecha}
                    hora={encuentro.hora}
                    lugar_texto={encuentro.lugar_texto}
                  />
                ) : resolvedSheetTheme === 'sports' ? (
                  <SportsTemplateSelector
                    selectedTemplateId={encuentro.invitation_template}
                    onSelect={(id) => handleThemeChange(id)}
                    titulo={encuentro.titulo}
                    descripcion={encuentro.descripcion}
                    fecha={encuentro.fecha}
                    hora={encuentro.hora}
                    lugar_texto={encuentro.lugar_texto}
                  />
                ) : resolvedSheetTheme === 'entertainment' ? (
                  <EntertainmentTemplateSelector
                    selectedTemplateId={encuentro.invitation_template}
                    onSelect={(id) => handleThemeChange(id)}
                    titulo={encuentro.titulo}
                    descripcion={encuentro.descripcion}
                    fecha={encuentro.fecha}
                    hora={encuentro.hora}
                    lugar_texto={encuentro.lugar_texto}
                  />
                ) : resolvedSheetTheme === 'learning' ? (
                  <LearningTemplateSelector
                    selectedTemplateId={encuentro.invitation_template}
                    onSelect={(id) => handleThemeChange(id)}
                    titulo={encuentro.titulo}
                    descripcion={encuentro.descripcion}
                    fecha={encuentro.fecha}
                    hora={encuentro.hora}
                    lugar_texto={encuentro.lugar_texto}
                  />
                ) : resolvedSheetTheme === 'wellness' ? (
                  <WellnessTemplateSelector
                    selectedTemplateId={encuentro.invitation_template}
                    onSelect={(id) => handleThemeChange(id)}
                    titulo={encuentro.titulo}
                    descripcion={encuentro.descripcion}
                    fecha={encuentro.fecha}
                    hora={encuentro.hora}
                    lugar_texto={encuentro.lugar_texto}
                  />
                ) : (
                  <InvitationThemeSelector
                    value={resolvedSheetTheme}
                    template={encuentro.invitation_template}
                    onChange={(themeId, templateId) => {
                      if (themeId === 'custom') {
                        if (templateId?.startsWith('custom_')) {
                          handleApplyDesign(themeId, templateId);
                          setShowThemeSelector(false);
                        }
                        return;
                      }
                      handleThemeChange(themeId);
                    }}
                  />
                )}
                <Button fullWidth variant="outline" onClick={() => setShowThemeSelector(false)} style={{ marginTop: 24 }}>
                  Cancelar
                </Button>
              </div>
            </div>
          );
        })()
      )}

      <ScrollHint visible={showScrollHint} />
    </ScreenContainer>
  );
};

export default DetailHost;
