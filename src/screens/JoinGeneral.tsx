import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate, isEncuentroPasado } from '@/lib/formatDate';
import { useTranslation } from 'react-i18next';
import { useHomeStore } from '@/store/homeStore';
import { useAuth } from '@/contexts/AuthContext';
import { openExternalVideoLink } from '@/lib/openLink';
import { getThemeStyle } from '@/lib/themes';
import { normalizeInvitationTheme, getThemeEyebrow } from '@/lib/invitationThemes';
import { formatCount } from '@/lib/formatCount';
import { CheckCircle2, CalendarCheck2, MapPin, Video, AlertCircle, CalendarX2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { ScrollHint } from '@/components/ui/ScrollHint';
import { EmptyState } from '@/components/ui/EmptyState';
import './Guest.css';

interface SavedData {
  encuentros: Record<string, { participant_id?: string; token_invitacion?: string }>;
}


const JoinGeneral: React.FC = () => {
  const { public_token } = useParams();
  const { t } = useTranslation();
  const { user, signInWithGoogle } = useAuth();
  const [encuentro, setEncuentro] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [loadingResponse, setLoadingResponse] = useState(false);
  const [step, setStep] = useState<'pending' | 'done'>('pending');
  const [participante, setParticipante] = useState<any>(null);
  // Token propio del participante generado por link general.
  // Se establece tras la primera respuesta y se usa en todos los cambios posteriores.
  // NUNCA usar public_token para cambiar respuesta una vez que ownInviteToken esté disponible.
  const [ownInviteToken, setOwnInviteToken] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  // true solo si el usuario acaba de confirmar en ESTA sesión (no una visita posterior)
  const [justConfirmed, setJustConfirmed] = useState(false);
  const [showScrollHint, setShowScrollHint] = useState(false);
  // Respuestas visibles para el invitado (sólo si el host lo activó y el invitado ya respondió)
  const [respuestasVisibles, setRespuestasVisibles] = useState<{ nombre_invitado: string; estado: string }[]>([]);
  const [visibleEnabled, setVisibleEnabled] = useState(false);
  const [allowedMeetingLink, setAllowedMeetingLink] = useState<string>('');
  const pollRespuestasRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { if (public_token) loadData(); }, [public_token]);

  // Polling de respuestas visibles
  // SEGURIDAD: usa ownInviteToken (token personal del participante), nunca public_token.
  // Solo activo cuando el invitado ya respondió (step === 'done') y tiene token personal.
  useEffect(() => {
    if (step !== 'done' || !ownInviteToken) return;

    const fetchRespuestas = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const result = await participantesService.getRespuestasVisiblesInvitado(ownInviteToken);
        setVisibleEnabled(result.visible);
        setRespuestasVisibles(result.participantes);
      } catch { /* no fatal */ }
    };

    fetchRespuestas(); // primera consulta inmediata
    if (pollRespuestasRef.current) clearInterval(pollRespuestasRef.current);
    pollRespuestasRef.current = setInterval(fetchRespuestas, 10000);

    return () => {
      if (pollRespuestasRef.current) clearInterval(pollRespuestasRef.current);
    };
  }, [step, ownInviteToken]);

  // Realtime subscription and polling for cancellation / deletion revalidation
  useEffect(() => {
    if (!encuentro?.id) return;

    if (import.meta.env.DEV) console.log('[JOIN REALTIME] Subscribing to encounter updates, id:', encuentro.id);
    const channel = supabase
      .channel(`public:encuentros:id=eq.${encuentro.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'encuentros',
          filter: `id=eq.${encuentro.id}`
        },
        (payload: any) => {
          if (import.meta.env.DEV) console.log('[JOIN REALTIME] Encounter updated:', payload.eventType);
          if (payload.eventType === 'DELETE') {
            setError('No disponible');
            setEncuentro(null);
          } else if (payload.new) {
            setEncuentro(payload.new);
          }
        }
      )
      .subscribe();

    // Fallback Polling every 8.5 seconds
    const pollInterval = setInterval(async () => {
      try {
        if (import.meta.env.DEV) console.log('[JOIN POLLING] Checking encounter status...');
        const updatedEnc = await encuentrosService.getEncuentroByPublicToken(public_token!);

        if (!updatedEnc) {
          if (import.meta.env.DEV) console.log('[JOIN POLLING] Encounter deleted or unavailable');
          setError('No disponible');
          setEncuentro(null);
          return;
        }

        if (updatedEnc.estado !== encuentro.estado) {
          if (import.meta.env.DEV) console.log('[JOIN POLLING] Status updated to:', updatedEnc.estado);
          setEncuentro(updatedEnc);
        }
      } catch (err) {
        console.error('[JOIN POLLING] Error running polling check', err);
      }
    }, 8500);

    return () => {
      if (import.meta.env.DEV) console.log('[JOIN REALTIME] Unsubscribing, id:', encuentro.id);
      supabase.removeChannel(channel);
      clearInterval(pollInterval);
    };
  }, [encuentro?.id, encuentro?.estado]);

  // Scroll indicator listening to window scroll
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
  }, [participante, encuentro, step, loading]);

  const loadData = async () => {
    try {
      setLoading(true); setError(null);
      if (import.meta.env.DEV) console.log('[GENERAL_LINK] cargando token...');
      const data = await encuentrosService.getEncuentroByPublicToken(public_token!);
      if (!data) throw new Error("No encontrado");
      if (import.meta.env.DEV) console.log("Estado encuentro:", data.estado);
      setEncuentro(data);
      let savedData: SavedData = { encuentros: {} };
      try {
        const savedDataStr = localStorage.getItem('encuentros_general');
        if (savedDataStr) {
          savedData = JSON.parse(savedDataStr);
        }
      } catch (e) {
        console.error('Error parsing encuentros_general from localStorage', e);
        localStorage.removeItem('encuentros_general');
      }

      const participantData = savedData?.encuentros?.[public_token!];
      const participantId = participantData?.participant_id;
      const participantToken = participantData?.token_invitacion;
      if (import.meta.env.DEV) console.log('[GENERAL_LINK] datos locales encontrados:', !!(participantToken || participantId));
      let estadoUI = 'pending';
      if (participantToken) {
        // Restaurar ownInviteToken desde localStorage en visitas posteriores
        setOwnInviteToken(participantToken);
        try {
          const partData = await participantesService.getParticipanteByToken(participantToken);
          if (import.meta.env.DEV) console.log('[GENERAL_LINK] participante encontrado por token: ok');
          if (partData) { 
            setParticipante(partData); 
            setNombre(partData.nombre_invitado || '');
            
            // Persistir link_virtual tras el refresh
            const encFromPart = Array.isArray(partData.encuentros) ? partData.encuentros[0] : partData.encuentros;
            const safeLink = encFromPart?.link_virtual || partData.link_virtual || encuentro?.link_virtual || '';
            setEncuentro((prev: any) => ({
              ...prev,
              link_virtual: safeLink,
            }));

            if (partData.estado === 'confirmado' && safeLink) {
              setAllowedMeetingLink(safeLink);
            }

            if (partData.estado !== 'pendiente') {
              setStep('done'); 
              estadoUI = 'done'; 
            }
          }
        } catch (err) { console.error('Participant not found by token', err); }
      }
      if (import.meta.env.DEV) console.log('[GENERAL_LINK] estado final:', estadoUI);

      // Pre-llenado de nombre si está logueado y no hay uno previo
      if (user && !participantToken && !participantId) {
        const suggested = getSuggestedName(user);
        if (suggested) setNombre(suggested);
      }
    } catch (err) {
      console.error('Error loading encuentro', err);
      setError('No se pudo encontrar el encuentro o el enlace es inválido.');
    } finally { setLoading(false); }
  };

  const getSuggestedName = (user: any) => {
    if (!user) return '';
    const meta = user.user_metadata || {};
    if (meta.full_name) return meta.full_name;
    if (meta.name) return meta.name;
    if (user.email) return user.email.split('@')[0];
    return '';
  };

  const handleCopyVideoLink = async () => {
    if (!allowedMeetingLink) return;
    try {
      await navigator.clipboard.writeText(allowedMeetingLink);
      setCopiedLink(true); setTimeout(() => setCopiedLink(false), 2000);
    } catch (err) { console.error('Failed to copy', err); alert('Error al copiar el enlace.'); }
  };

  const handleResponse = async (estado: 'confirmado' | 'rechazado') => {
    if (!encuentro || !nombre.trim()) return;

    // Validación antes de guardar: si ya finalizó, abortar
    if (isEncuentroPasado(encuentro.fecha, encuentro.hora)) {
      alert('Este encuentro ya finalizó. Ya no es posible modificar la respuesta.');
      loadData();
      return;
    }

    try {
      setLoadingResponse(true);

      // Determinar el token efectivo para esta llamada:
      // - ownInviteToken: token propio del participante (disponible tras primera respuesta)
      // - public_token: SOLO para la primera respuesta (cuando no existe ownInviteToken)
      const effectiveToken = ownInviteToken ?? public_token!;
      const isFirstResponse = !ownInviteToken;

      if (import.meta.env.DEV) console.log(
        '[GENERAL] Paso 1: respondiendo. isFirstResponse:', isFirstResponse,
        'effectiveToken:', effectiveToken
      );

      const newPart = await participantesService.responderInvitacion(
        effectiveToken,
        estado,
        nombre.trim() || undefined
      );

      if (import.meta.env.DEV) console.log('[GENERAL] Paso 1 resultado:', newPart);

      // Tras la primera respuesta por link general, la RPC devuelve token_invitacion propio.
      // Guardarlo en estado Y en localStorage para usarlo en todos los cambios posteriores.
      const returnedToken: string | undefined = newPart?.token_invitacion;
      const returnedId: string | undefined = newPart?.id;

      if (isFirstResponse && returnedToken) {
        // Primera respuesta: guardar ownInviteToken en estado React
        setOwnInviteToken(returnedToken);
        if (import.meta.env.DEV) console.log('[GENERAL] Primer submit: ownInviteToken guardado:', returnedToken);
      }

      // Guardar en localStorage usando el token_invitacion devuelto (o el ya conocido)
      const tokenToSave = returnedToken ?? ownInviteToken ?? undefined;
      const idToSave = returnedId ?? participante?.id ?? undefined;

      if (tokenToSave) {
        let savedData: SavedData = { encuentros: {} };
        try {
          const savedDataStr = localStorage.getItem('encuentros_general');
          if (savedDataStr) savedData = JSON.parse(savedDataStr);
        } catch (e) {
          console.error('Error parsing encuentros_general before saving', e);
        }

        if (!savedData.encuentros) savedData.encuentros = {};
        savedData.encuentros[public_token!] = {
          participant_id: idToSave,
          token_invitacion: tokenToSave,
        };
        localStorage.setItem('encuentros_general', JSON.stringify(savedData));

        // Guardar en sessionStorage para vinculación post-login
        if (!user && idToSave) {
          sessionStorage.setItem('puntoencuentro_recent_participant_id', idToSave);
        }

        if (import.meta.env.DEV) console.log('[GENERAL] localStorage actualizado con token_invitacion:', tokenToSave);
      }

      useHomeStore.getState().invalidateCache();
      // Preservar id del participante si la RPC no lo repite en actualizaciones
      setParticipante((prev: any) => ({
        ...(prev || {}),
        ...newPart,
        estado,
        nombre_invitado: nombre.trim(),
        id: returnedId ?? prev?.id,
        token_invitacion: tokenToSave ?? prev?.token_invitacion,
      }));

      // Actualizar link_virtual usando la respuesta de la RPC
      if (estado === 'confirmado' && newPart?.link_virtual) {
        setAllowedMeetingLink(newPart.link_virtual);
        setEncuentro((prev: any) => prev ? { ...prev, link_virtual: newPart.link_virtual } : prev);
      } else if (estado !== 'confirmado') {
        setAllowedMeetingLink('');
        setEncuentro((prev: any) => prev ? { ...prev, link_virtual: undefined } : prev);
      }

      setStep('done');
      setJustConfirmed(true);
      if (import.meta.env.DEV) console.log('[GENERAL] Paso 2: done. estado:', estado);
    } catch (err: any) {
      if (import.meta.env.DEV) console.error('[GENERAL] ERROR en handleResponse:', err?.message, err);
      if (err.message === 'meeting_cancelled') {
        alert('Este encuentro fue cancelado por el organizador.');
        loadData(); // Recargar para mostrar pantalla de cancelado
      } else if (err.message === 'meeting_not_found') {
        alert('Este encuentro ya no está disponible.');
        loadData(); // Recargar para mostrar pantalla de no disponible
      } else if (err.message === 'meeting_expired') {
        alert('Este encuentro ya ha finalizado. No es posible modificar la respuesta.');
        loadData();
      } else {
        alert('Hubo un error al guardar tu respuesta. Por favor intenta de nuevo.');
      }
    } finally { setLoadingResponse(false); }
  };

  if (loading) return (
    <ScreenContainer>
      <div className="guest-screen-centered">
        <p className="guest-loading-text">Cargando encuentro…</p>
      </div>
    </ScreenContainer>
  );

  const invitationTheme = normalizeInvitationTheme(encuentro?.tema_invitacion);

  if (error || !encuentro) return (
    <ScreenContainer>
      <AppBar title="Encuentro" />
      <EmptyState
        icon={<AlertCircle size={48} color="var(--color-danger)" />}
        title="Encuentro no disponible"
        description="Este encuentro ya no existe o el enlace es inválido."
      />
    </ScreenContainer>
  );

  // Encuentro cancelado — mostrar info sin permitir interacción
  if (encuentro?.estado?.toLowerCase() === 'cancelado') return (
    <ScreenContainer className={`guest-page guest-theme guest-theme--${invitationTheme}`} style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Detalle del encuentro" />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', paddingTop: 16, paddingLeft: 20, paddingRight: 20 }}>
        
        {/* Banner destacado */}
        <div className="guest-banner guest-banner--danger">
          <span className="guest-banner-icon"><CalendarX2 size={32} /></span>
          <div>
            <p className="guest-banner-title">Encuentro cancelado</p>
          </div>
        </div>

        {/* Detalle del encuentro (solo lectura) */}
        <div className="guest-card">
          <h2 className="guest-card-title">{encuentro.titulo}</h2>
          <div className="guest-meta-list">
            <div className="guest-meta-row">
              <span className="guest-meta-icon"><CalendarCheck2 size={20} /></span>
              <span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span>
            </div>
            <div className="guest-meta-row">
              <span className="guest-meta-icon">
                {encuentro.modalidad === 'presencial' ? <MapPin size={20} /> : <Video size={20} />}
              </span>
              <span>{encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}</span>
            </div>
          </div>
          {encuentro.modalidad === 'virtual' && encuentro.link_virtual && (
            <div className="guest-video-link-display" style={{ marginTop: 16 }}>
              {encuentro.link_virtual}
            </div>
          )}
        </div>

        <p className="guest-cancel-notice">
          El organizador canceló este encuentro. No es posible unirse.
        </p>

      </div>
      <ScrollHint visible={showScrollHint} />
    </ScreenContainer>
  );

  const isFinalizado = encuentro?.estado?.toLowerCase() !== 'cancelado' && isEncuentroPasado(encuentro.fecha, encuentro.hora);

  if (step === 'done') return (
    <ScreenContainer className={`guest-page guest-theme guest-theme--${invitationTheme}`} style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Respuesta enviada" />

      {/* ── A. Bloque de éxito ──────────────────────────────── */}
      <div className="guest-success-block">
        <div className={`guest-success-icon-wrap ${participante?.estado === 'confirmado' ? 'guest-success-icon-wrap--confirmed' : 'guest-success-icon-wrap--rejected'}`}>
          {participante?.estado === 'confirmado'
            ? <CheckCircle2 size={36} strokeWidth={1.75} />
            : <CalendarCheck2 size={36} strokeWidth={1.75} />
          }
        </div>

        <div>
          <h2 className="guest-success-title">
            {participante?.estado === 'confirmado' 
              ? t('already_confirmed', 'Confirmaste tu asistencia') 
              : t('already_rejected', 'Indicaste que no podés asistir')}
          </h2>
          <p className="guest-success-desc" style={{ marginTop: 8 }}>
            {participante?.estado === 'confirmado'
              ? t('waiting_for_you', 'Te esperamos en el encuentro.')
              : t('not_attending', 'Avisamos que no vas a poder asistir.')}
          </p>
        </div>

        {isFinalizado && (
          <div className="guest-expired-notice">
            <p>Este encuentro ya finalizó.</p>
            <p>Ya no es posible modificar la respuesta.</p>
          </div>
        )}

        {/* Mensaje previo en modo lectura (si existe) */}
        {participante?.mensaje_respuesta && (
          <div className="guest-message-box">
            <p className="guest-message-box-label">Tu mensaje</p>
            <p className="guest-message-box-text">"{participante.mensaje_respuesta}"</p>
          </div>
        )}
      </div>

      {/* ── B. Card del encuentro ──────────────────────────── */}
      <div className="guest-card" style={{ padding: '20px 24px', margin: '0 20px 16px' }}>
        <p className="guest-card-eyebrow">Encuentro</p>
        <h4 className="guest-card-title" style={{ fontSize: 20 }}>
          {encuentro.titulo}
        </h4>
        <div className="guest-meta-list">
          <div className="guest-meta-row">
            <CalendarCheck2 size={18} className="guest-meta-icon" />
            <span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span>
          </div>
          <div className="guest-meta-row">
            {encuentro.modalidad === 'presencial'
              ? <MapPin size={18} className="guest-meta-icon" />
              : <Video size={18} className="guest-meta-icon" />
            }
            <span>{encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}</span>
          </div>
        </div>
      </div>

      {/* ── C. Acción de videollamada ─────────────────────── */}
      {(() => {
        const encDataFromPart = Array.isArray(participante?.encuentros) ? participante.encuentros[0] : participante?.encuentros;
        const isVirtualMeeting = encuentro?.modalidad === 'virtual' || encDataFromPart?.modalidad === 'virtual';
        const hasConfirmed = participante?.estado === 'confirmado';
        
        const showJoinMeetingButton = isVirtualMeeting && hasConfirmed && Boolean(allowedMeetingLink);

        if (!showJoinMeetingButton) return null;

        return (
          <div className="guest-video-box" style={{ padding: '0 20px' }}>
            <div className="guest-video-link-display">
              {allowedMeetingLink}
            </div>
            <Button fullWidth onClick={() => openExternalVideoLink(allowedMeetingLink)}>
              {t('join_meeting', 'Unirme a la reunión')}
            </Button>
            <button onClick={handleCopyVideoLink} className="guest-action-text">
              {copiedLink ? t('link_copied', 'Link copiado.') : t('copy_link', 'Copiar link')}
            </button>
          </div>
        );
      })()}

      {/* ── D. Texto de ayuda ─────────────────────────────── */}
      <p className="guest-help-text" style={{ padding: '0 20px' }}>
        Podés volver a este enlace en cualquier momento para ver los detalles del encuentro.
      </p>

      {visibleEnabled && (
        <div className="guest-responses-box" style={{ margin: '0 20px 24px' }}>
          <p className="guest-responses-title">
            Respuestas del encuentro
          </p>
          {respuestasVisibles.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--color-on-surface-variant)' }}>Todavía no hay respuestas visibles.</p>
          ) : (
            <>
              <p className="guest-responses-summary">
                {[
                  formatCount(respuestasVisibles.filter(p => p.estado === 'confirmado').length, 'confirmado', 'confirmados'),
                  formatCount(respuestasVisibles.filter(p => p.estado === 'rechazado').length, 'no asiste', 'no asisten'),
                  formatCount(respuestasVisibles.filter(p => p.estado === 'pendiente').length, 'falta responder', 'faltan responder')
                ].filter(Boolean).join(' · ')}
              </p>
              
              {respuestasVisibles.filter(p => p.estado === 'confirmado').length > 0 && (
                <div className="guest-responses-group">
                  <p className="guest-responses-group-title guest-responses-group-title--success">Confirmaron</p>
                  <div className="guest-responses-chips">
                    {respuestasVisibles.filter(p => p.estado === 'confirmado').map((p, i) => (
                      <span key={i} className="guest-response-chip">{p.nombre_invitado}</span>
                    ))}
                  </div>
                </div>
              )}
              {respuestasVisibles.filter(p => p.estado === 'rechazado').length > 0 && (
                <div className="guest-responses-group">
                  <p className="guest-responses-group-title guest-responses-group-title--danger">No asisten</p>
                  <div className="guest-responses-chips">
                    {respuestasVisibles.filter(p => p.estado === 'rechazado').map((p, i) => (
                      <span key={i} className="guest-response-chip">{p.nombre_invitado}</span>
                    ))}
                  </div>
                </div>
              )}
              {respuestasVisibles.filter(p => p.estado === 'pendiente').length > 0 && (
                <div className="guest-responses-group">
                  <p className="guest-responses-group-title guest-responses-group-title--pending">Faltan responder</p>
                  <div className="guest-responses-chips">
                    {respuestasVisibles.filter(p => p.estado === 'pendiente').map((p, i) => (
                      <span key={i} className="guest-response-chip">{p.nombre_invitado}</span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── E. Nudge de login ────────────────────────────── */}
      {!user && justConfirmed && (
        <div className="guest-nudge-box" style={{ margin: '0 20px 24px' }}>
          <div>
            <p className="guest-nudge-title">
              {t('save_this_meeting', 'Guardá este encuentro')}
            </p>
            <p className="guest-nudge-desc">
              {t('access_anywhere', 'Accedé a este encuentro desde cualquier dispositivo iniciando sesión.')}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={signInWithGoogle} fullWidth>
            {t('account.continue_google', 'Continuar con Google')}
          </Button>
        </div>
      )}
      
      {/* ── F. Acciones Inferiores ────────────────────────────── */}
      <div className="guest-bottom-actions" style={{ padding: '0 20px' }}>
        {encuentro?.estado?.toLowerCase() === 'activo' && !isEncuentroPasado(encuentro.fecha, encuentro.hora) && (
          <button
            onClick={() => setStep('pending')}
            className="guest-action-secondary"
          >
            {t('change_response', 'Cambiar respuesta')}
          </button>
        )}
      </div>
      <ScrollHint visible={showScrollHint} />
    </ScreenContainer>
  );

  return (
    <ScreenContainer className={`guest-page guest-theme guest-theme--${invitationTheme}`} style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Invitación" />

      {isFinalizado && (
        <div className="guest-expired-notice" style={{ margin: '20px 20px 0', textAlign: 'center' }}>
          <p>Este encuentro ya finalizó.</p>
          <p>Ya no es posible responder a esta invitación.</p>
        </div>
      )}

      <div style={{ padding: isFinalizado ? '16px 20px 0' : '20px 20px 0' }}>
        <div className="guest-card" style={{ marginBottom: 0 }}>
          <p className="guest-card-eyebrow">{getThemeEyebrow(encuentro?.tema_invitacion)}</p>
          <h2 className="guest-card-title">{encuentro.titulo}</h2>
          
          <div className="guest-meta-list">
            <div className="guest-meta-row">
              <CalendarCheck2 size={20} className="guest-meta-icon" />
              <span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span>
            </div>
            {encuentro.modalidad === 'presencial' && encuentro.lugar_texto && (
              <div className="guest-meta-row">
                <MapPin size={20} className="guest-meta-icon" />
                <span>{encuentro.lugar_texto}</span>
              </div>
            )}
            <div className="guest-meta-row">
              {encuentro.modalidad === 'presencial' ? <MapPin size={20} className="guest-meta-icon" /> : <Video size={20} className="guest-meta-icon" />}
              <span>{encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}</span>
            </div>
          </div>
          
          {encuentro.modalidad === 'virtual' && (
            <p className="guest-meta-info">
              {t('virtual_link_pending', 'Confirmá tu asistencia para acceder al enlace de la videollamada.')}
            </p>
          )}
        </div>
      </div>

      {/* ── B. Confirmación ─────────────────────────────── */}
      <div style={{ padding: '20px 20px 0' }}>
        {!isFinalizado && (
          <div className="guest-card" style={{ marginBottom: 20 }}>
            <div className="guest-form-group" style={{ marginBottom: 0 }}>
              <label className="guest-form-label">
                {t('participant.visible_name', 'Nombre visible')}
              </label>
              <Input
                placeholder="Ej: Leandro"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    document.getElementById('btn-confirmar')?.focus();
                  }
                }}
              />
              <p className="guest-form-help">
                {t('participant.visible_name_help', 'Este nombre será visible para el organizador.')}
              </p>
            </div>
          </div>
        )}
      </div>

      {!isFinalizado && (
        <div className="guest-bottom-actions" style={{ padding: '0 20px' }}>
          <Button id="btn-confirmar" fullWidth variant="primary" onClick={() => handleResponse('confirmado')} disabled={!nombre.trim() || loadingResponse}>
            {loadingResponse ? t('loading_link', 'Cargando…') : t('yes_attend', 'Sí, puedo asistir')}
          </Button>
          <button
            onClick={() => handleResponse('rechazado')}
            disabled={!nombre.trim() || loadingResponse}
            className="guest-action-secondary"
          >
            {loadingResponse ? 'Procesando…' : t('no_attend', 'No puedo asistir')}
          </button>
        </div>
      )}
      <ScrollHint visible={showScrollHint} />
    </ScreenContainer>
  );
};

export default JoinGeneral;
