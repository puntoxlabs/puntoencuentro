import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { participantesService } from '@/services/participantesService';
import { saveParticipatedToken } from '@/lib/participatedTokens';
import { formatFriendlyDate, isEncuentroPasado } from '@/lib/formatDate';
import { useTranslation } from 'react-i18next';
import { openExternalVideoLink } from '@/lib/openLink';
import { useHomeStore } from '@/store/homeStore';

import { formatCount } from '@/lib/formatCount';
import { useAuth } from '@/contexts/AuthContext';
import { getThemeStyle } from '@/lib/themes';
import { normalizeInvitationTheme, getThemeEyebrow } from '@/lib/invitationThemes';
import { CheckCircle2, CalendarCheck2, MapPin, Video, AlertCircle, CalendarX2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { ScrollHint } from '@/components/ui/ScrollHint';
import { EmptyState } from '@/components/ui/EmptyState';
import { KidsBirthdayInvitationPreview } from '@/components/ui/KidsBirthdayInvitationPreview';
import { CelebrationInvitationPreview } from '@/components/ui/CelebrationInvitationPreview';
import { getCelebrationTemplateConfig } from '@/lib/celebrationTemplates';
import './Guest.css';


const InviteGuest: React.FC = () => {
  const { token } = useParams();
  const { t } = useTranslation();
  const { user, signInWithGoogle } = useAuth();
  const [participante, setParticipante] = useState<any>(null);
  const [encuentro, setEncuentro] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nombre, setNombre] = useState('');
  const [loadingResponse, setLoadingResponse] = useState(false);
  const [step, setStep] = useState<'pending' | 'done'>('pending');
  const [copiedLink, setCopiedLink] = useState(false);
  // true solo si el usuario acaba de responder en ESTA sesión
  const [justConfirmed, setJustConfirmed] = useState(false);
  const [showScrollHint, setShowScrollHint] = useState(false);
  const [mensaje, setMensaje] = useState('');
  // Respuestas visibles para el invitado (sólo si el host lo activó)
  const [respuestasVisibles, setRespuestasVisibles] = useState<{ nombre_invitado: string; estado: string }[]>([]);
  const [visibleEnabled, setVisibleEnabled] = useState(false);
  const [allowedMeetingLink, setAllowedMeetingLink] = useState<string>('');
  const pollRespuestasRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    if (import.meta.env.DEV) console.log('[INVITE] token inicial:', token);
    if (token) { loadData(); } else { setError('Token no proporcionado en la URL.'); setLoading(false); }
  }, [token]);

  // Polling de respuestas visibles — sólo cuando el invitado ya respondió
  useEffect(() => {
    if (step !== 'done' || !token) return;

    const fetchRespuestas = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        // Usa el token de la URL que ya es token_invitacion personal
        const result = await participantesService.getRespuestasVisiblesInvitado(token);
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
  }, [step, token]);

  // Realtime subscription and polling for cancellation / deletion revalidation
  useEffect(() => {
    if (!encuentro?.id) return;

    if (import.meta.env.DEV) console.log('[INVITE REALTIME] Subscribing to encounter updates, id:', encuentro.id);
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
          if (import.meta.env.DEV) console.log('[INVITE REALTIME] Encounter updated:', payload.eventType);
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
        if (import.meta.env.DEV) console.log('[INVITE POLLING] Checking encounter status...');
        if (!token) return;
        const data = await participantesService.getParticipanteByToken(token);
        if (!data) {
          if (import.meta.env.DEV) console.log('[INVITE POLLING] Encounter deleted or unavailable');
          setError('No disponible');
          setEncuentro(null);
          return;
        }
        const enc = Array.isArray(data.encuentros) ? data.encuentros[0] : data.encuentros;
        if (enc && enc.estado !== encuentro?.estado) {
          if (import.meta.env.DEV) console.log('[INVITE POLLING] Status updated to:', enc.estado);
          setEncuentro(enc);
        }
      } catch (err) {
        console.error('[INVITE POLLING] Error running polling check', err);
      }
    }, 8500);

    return () => {
      if (import.meta.env.DEV) console.log('[INVITE REALTIME] Unsubscribing, id:', encuentro.id);
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
      if (import.meta.env.DEV) console.log('[INDIVIDUAL_INVITE] token leído:', token);
      const data = await participantesService.getParticipanteByToken(token!);
      if (import.meta.env.DEV) console.log('[INDIVIDUAL_INVITE] invitación encontrada: ok');
      if (!data) throw new Error("No encontrado");
      setParticipante(data);
      
      // Establecer nombre inicial y mensaje
      let initialName = data.nombre_invitado || '';
      if (user && !initialName) {
        initialName = getSuggestedName(user);
      }
      setNombre(initialName);
      setMensaje(data.mensaje_respuesta || '');

      let enc = Array.isArray(data.encuentros) ? data.encuentros[0] : data.encuentros;
      if (import.meta.env.DEV) console.log("Estado encuentro:", enc?.estado);
      
      setEncuentro({
        ...enc,
        link_virtual: enc?.link_virtual || data.link_virtual || undefined,
      });

      if (data.estado === 'confirmado') {
        const safeLink = enc?.link_virtual || data.link_virtual || '';
        setAllowedMeetingLink(safeLink);
      }

      if (data.estado !== 'pendiente') setStep('done');
    } catch (err) {
      console.error('InviteGuest error:', err);
      setError('No se pudo encontrar la invitación o el enlace es inválido.');
    } finally { setLoading(false); }
  };

  const handleResponse = async (estado: 'confirmado' | 'rechazado') => {
    if (!participante || loadingResponse) return;

    // Validación antes de guardar: si ya finalizó, abortar
    if (isEncuentroPasado(encuentro.fecha, encuentro.hora)) {
      alert('Este encuentro ya finalizó. Ya no es posible modificar la respuesta.');
      loadData();
      return;
    }

    try {
      setLoadingResponse(true);
      if (import.meta.env.DEV) console.log('[INVITE] Paso 1: llamando responderInvitacion, token:', token, 'estado:', estado);

      // Usar RPC responder_participante_seguro via token del URL
      const response = await participantesService.responderInvitacion(
        token!, // el token del URL
        estado,
        nombre.trim() || undefined,
        mensaje.trim() || undefined
      );
      if (import.meta.env.DEV) console.log('[INVITE] Paso 2: RPC ok. response:', response);

      // La confirmación fue exitosa — guardar token y sesión antes de hacer el refresh
      useHomeStore.getState().invalidateCache();
      if (token) saveParticipatedToken(token);
      if (!user) {
        sessionStorage.setItem('puntoencuentro_recent_participant_id', participante.id);
      }

      // Refresh para obtener link_virtual (si confirmado en encuentro virtual)
      // Si falla, NO es fatal — ya tenemos el estado suficiente para mostrar la pantalla de éxito
      try {
        if (import.meta.env.DEV) console.log('[INVITE] Paso 3: refreshing participante...');
        const refreshed = await participantesService.getParticipanteByToken(token!);
        if (import.meta.env.DEV) console.log('[INVITE] Paso 3 resultado:', refreshed);

        if (refreshed) {
          const refEnc = Array.isArray(refreshed.encuentros)
            ? refreshed.encuentros[0]
            : refreshed.encuentros;

          // Actualizar estado con datos frescos del servidor
          setParticipante({ ...refreshed, estado });
          if (refEnc) setEncuentro(refEnc);
        } else {
          // Refresh no encontró datos — usar estado local con el estado actualizado
          if (import.meta.env.DEV) console.warn('[INVITE] Paso 3: refresh devolvió null, usando estado local');
          setParticipante((prev: any) => ({ ...prev, estado }));
        }
      } catch (refreshErr) {
        // Error en el refresh — no es fatal, la confirmación ya fue exitosa
        if (import.meta.env.DEV) console.warn('[INVITE] Paso 3 WARN: refresh falló (no fatal):', refreshErr);
        setParticipante((prev: any) => ({ ...prev, estado }));
      }

      // Actualizar link_virtual usando la respuesta de la RPC directamente
      if (estado === 'confirmado' && response?.link_virtual) {
        setAllowedMeetingLink(response.link_virtual);
        setEncuentro((prev: any) => prev ? { ...prev, link_virtual: response.link_virtual } : prev);
      } else if (estado !== 'confirmado') {
        setAllowedMeetingLink('');
        setEncuentro((prev: any) => prev ? { ...prev, link_virtual: undefined } : prev);
      }

      if (import.meta.env.DEV) console.log('[INVITE] Paso 4: mostrando pantalla de éxito');
      setStep('done');
      setJustConfirmed(true);
    } catch (err: any) {
      if (import.meta.env.DEV) console.error('[INVITE] ERROR en handleResponse:', err?.message, err);
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
        alert('Hubo un problema al enviar tu respuesta. Por favor intenta de nuevo.');
      }
    } finally { setLoadingResponse(false); }
  };

  if (loading) return (
    <ScreenContainer>
      <div className="guest-screen-centered">
        <p className="guest-loading-text">Cargando invitación…</p>
      </div>
    </ScreenContainer>
  );
  const invitationTheme = normalizeInvitationTheme(encuentro?.tema_invitacion);

  // Fondo integrado para Celebración
  const celebrationTemplate = encuentro?.tema_invitacion === 'celebration'
    ? getCelebrationTemplateConfig(encuentro.invitation_template)
    : null;
  const celebrationBgStyle: React.CSSProperties = celebrationTemplate?.background
    ? {
        backgroundImage: `linear-gradient(rgba(255,255,255,0.25), rgba(255,255,255,0.25)), url(${celebrationTemplate.background})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center top',
        backgroundRepeat: 'no-repeat'
      }
    : {};

  if (error || !participante || !encuentro) return (
    <ScreenContainer>
      <AppBar title="Invitación" />
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
        {/* Ícono en contenedor circular */}
        <div className={`guest-success-icon-wrap ${participante.estado === 'confirmado' ? 'guest-success-icon-wrap--confirmed' : 'guest-success-icon-wrap--rejected'}`}>
          {participante.estado === 'confirmado'
            ? <CheckCircle2 size={36} strokeWidth={1.75} />
            : <CalendarCheck2 size={36} strokeWidth={1.75} />
          }
        </div>

        {/* Textos */}
        <div>
          <h2 className="guest-success-title">
            {participante.estado === 'confirmado' 
              ? t('already_confirmed', 'Confirmaste tu asistencia') 
              : t('already_rejected', 'Indicaste que no podés asistir')}
          </h2>
          <p className="guest-success-desc" style={{ marginTop: 8 }}>
            {participante.estado === 'confirmado'
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
        {participante.mensaje_respuesta && (
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
            <span>
              {encuentro.modalidad === 'presencial'
                ? (encuentro.lugar_texto || 'Presencial')
                : 'Virtual'}
            </span>
          </div>
        </div>
      </div>

      {/* ── C. Acción de videollamada (si aplica) ─────────── */}
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

      {/* ―― E. Nudge de login (solo si acabó de responder sin login) ―― */}
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
    <ScreenContainer
      className={`guest-page guest-theme guest-theme--${invitationTheme}`}
      style={{ ...getThemeStyle(encuentro?.tema), ...celebrationBgStyle }}
    >
      <AppBar title="Invitación" />

      {isFinalizado && (
        <div className="guest-expired-notice" style={{ margin: '20px 20px 0', textAlign: 'center' }}>
          <p>Este encuentro ya finalizó.</p>
          <p>Ya no es posible responder a esta invitación.</p>
        </div>
      )}

      <div style={{ padding: isFinalizado ? '16px 20px 0' : '20px 20px 0' }}>
        {encuentro?.tema_invitacion === 'kids_birthday' ? (
          <div style={{ marginBottom: 20 }}>
            <KidsBirthdayInvitationPreview
              templateId={encuentro.invitation_template}
              childName={encuentro.titulo}
              date={encuentro.fecha}
              time={encuentro.hora}
              location={encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}
              hostMessage={encuentro.descripcion || ''}
              confirmationText={undefined}
              isReadOnly={true}
            />
          </div>
        ) : encuentro?.tema_invitacion === 'celebration' ? (
          <div style={{ marginBottom: 20 }}>
            <CelebrationInvitationPreview
              previewData={{
                titulo: encuentro.titulo || '',
                fecha: encuentro.fecha || '',
                hora: encuentro.hora || '',
                lugar_texto: encuentro.lugar_texto,
                modalidad: encuentro.modalidad,
                descripcion: encuentro.descripcion,
                tema_invitacion: encuentro.tema_invitacion,
                invitation_template: encuentro.invitation_template || 'celebration_gold'
              }}
            />
          </div>
        ) : (
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
        )}
      </div>

      <div style={{ padding: '20px 20px 0' }}>
        {!isFinalizado && (
          <div
            className="guest-card"
            style={{
              marginBottom: 20,
              ...(encuentro?.tema_invitacion === 'celebration' ? {
                background: 'rgba(255, 255, 255, 0.88)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                border: '1px solid rgba(255,255,255,0.6)'
              } : {})
            }}
          >
            <div className="guest-form-group">
              <label className="guest-form-label">
                {t('participant.visible_name', 'Tu nombre')}
              </label>
              <Input
                placeholder="Ej: Leandro"
                value={nombre}
                onChange={(e: any) => setNombre(e.target.value)}
              />
              <p className="guest-form-help">
                {t('participant.visible_name_help', 'Así te verá el organizador.')}
              </p>
            </div>

            <div className="guest-form-group" style={{ marginBottom: 0 }}>
              <label className="guest-form-label">
                Mensaje para el organizador (opcional)
              </label>
              <textarea
                placeholder="Ej: Llego 10 min tarde."
                value={mensaje}
                maxLength={120}
                onChange={(e: any) => setMensaje(e.target.value)}
                className="guest-textarea"
              />
            </div>
          </div>
        )}
      </div>

      {!isFinalizado && (
        <div className="guest-bottom-actions" style={{ padding: '0 20px' }}>
          <Button fullWidth variant="primary" onClick={() => handleResponse('confirmado')} disabled={loadingResponse}>
            {loadingResponse ? t('loading_link', 'Cargando…') : t('yes_attend', 'Sí, puedo asistir')}
          </Button>
          <button
            onClick={() => handleResponse('rechazado')}
            disabled={loadingResponse}
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

export default InviteGuest;
