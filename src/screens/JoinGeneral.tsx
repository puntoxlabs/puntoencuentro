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
import { formatCount } from '@/lib/formatCount';
import { CheckCircle2, CalendarCheck2, MapPin, Video } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { ScrollHint } from '@/components/ui/ScrollHint';

interface SavedData {
  encuentros: Record<string, { participant_id?: string; token_invitacion?: string }>;
}

const metaRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  fontSize: 15, color: 'var(--color-on-surface-variant)', marginBottom: 10,
};
const metaIcon: React.CSSProperties = { fontSize: 17, width: 22, textAlign: 'center', flexShrink: 0 };
const eventCard: React.CSSProperties = {
  background: '#fff', borderRadius: 20, padding: '20px',
  border: '1px solid rgba(0,0,0,0.06)',
  boxShadow: '0 2px 10px rgba(0,0,0,0.06)', marginBottom: 24,
};


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
    if (!encuentro?.link_virtual) return;
    try {
      await navigator.clipboard.writeText(encuentro.link_virtual);
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
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p>Cargando encuentro…</p>
      </div>
    </ScreenContainer>
  );

  if (error || !encuentro) return (
    <ScreenContainer>
      <AppBar title="Encuentro" />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '0 20px' }}>
        <span style={{ fontSize: 40 }}>❌</span>
        <p style={{ textAlign: 'center', fontSize: 16, fontWeight: 600, color: '#374151', margin: 0 }}>
          Este encuentro ya no está disponible
        </p>
      </div>
    </ScreenContainer>
  );

  // Encuentro cancelado — mostrar info sin permitir interacción
  if (encuentro?.estado?.toLowerCase() === 'cancelado') return (
    <ScreenContainer style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Detalle del encuentro" />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', paddingTop: 8 }}>

        {/* Banner destacado */}
        <div style={{
          background: '#B91C1C',
          borderRadius: 16, padding: '18px 20px',
          marginBottom: 20,
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <span style={{ fontSize: 28, lineHeight: 1 }}>❌</span>
          <div>
            <p style={{ margin: 0, fontWeight: 800, fontSize: 17, color: '#fff' }}>Encuentro cancelado</p>
          </div>
        </div>

        {/* Detalle del encuentro (solo lectura) */}
        <div style={{
          background: '#fff', borderRadius: 20, padding: '20px',
          border: '1px solid rgba(0,0,0,0.06)',
          boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
          marginBottom: 20,
        }}>
          <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 14 }}>{encuentro.titulo}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 8 }}>
            <span>📅</span><span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 8 }}>
            <span>{encuentro.modalidad === 'presencial' ? '📍' : '💻'}</span>
            <span>{encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}</span>
          </div>
          {encuentro.modalidad === 'virtual' && encuentro.link_virtual && (
            <div style={{
              background: 'var(--color-primary-container)', borderRadius: 10, padding: '8px 12px',
              fontSize: 13, color: 'var(--color-on-surface-variant)', wordBreak: 'break-all',
              marginTop: 4, userSelect: 'text',
            }}>
              {encuentro.link_virtual}
            </div>
          )}
        </div>

        <p style={{ margin: 0, fontSize: 15, color: '#B91C1C', fontWeight: 600, textAlign: 'center' }}>
          El organizador canceló este encuentro. No es posible unirse.
        </p>

      </div>
      <ScrollHint visible={showScrollHint} />
    </ScreenContainer>
  );

  const isFinalizado = encuentro?.estado?.toLowerCase() !== 'cancelado' && isEncuentroPasado(encuentro.fecha, encuentro.hora);

  if (step === 'done') return (
    <ScreenContainer style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Respuesta enviada" />

      {/* ── A. Bloque de éxito ──────────────────────────────── */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '40px 24px 28px', textAlign: 'center', gap: 14,
      }}>
        <div style={{
          width: 72, height: 72, borderRadius: '50%',
          background: participante?.estado === 'confirmado'
            ? 'var(--color-primary-container)'
            : 'rgba(107,114,128,0.1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {participante?.estado === 'confirmado'
            ? <CheckCircle2 size={36} strokeWidth={1.75} color="var(--color-primary)" />
            : <CalendarCheck2 size={36} strokeWidth={1.75} color="#6B7280" />
          }
        </div>

        <h2 style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.25, color: '#111827', margin: 0 }}>
          {participante?.estado === 'confirmado' 
            ? t('already_confirmed', 'Confirmaste tu asistencia') 
            : t('already_rejected', 'Indicaste que no podés asistir')}
        </h2>

        <p style={{ fontSize: 15, color: 'var(--color-on-surface-variant)', margin: 0, lineHeight: 1.55 }}>
          {participante?.estado === 'confirmado'
            ? t('waiting_for_you', 'Te esperamos en el encuentro.')
            : t('not_attending', 'Avisamos que no vas a poder asistir.')}
        </p>

        {isFinalizado && (
          <div style={{ marginTop: 8, padding: '10px 16px', background: '#F3F4F6', borderRadius: 12 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#374151' }}>Este encuentro ya finalizó.</p>
            <p style={{ margin: '2px 0 0', fontSize: 13, color: '#6B7280' }}>Ya no es posible modificar la respuesta.</p>
          </div>
        )}

        {/* Mensaje previo en modo lectura (si existe) */}
        {participante?.mensaje_respuesta && (
          <div style={{ width: '100%', textAlign: 'left', marginTop: 12, padding: '12px 16px', background: 'var(--color-surface-variant)', borderRadius: 12 }}>
            <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tu mensaje</p>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--color-on-surface)', fontStyle: 'italic' }}>"{participante.mensaje_respuesta}"</p>
          </div>
        )}

        {/* Botón Cambiar respuesta - SOLO si el encuentro está activo y no ha pasado */}
        {encuentro?.estado?.toLowerCase() === 'activo' && !isEncuentroPasado(encuentro.fecha, encuentro.hora) && (
          <button
            onClick={() => setStep('pending')}
            style={{
              background: 'none', border: 'none',
              color: 'var(--color-primary)', fontSize: 14,
              fontFamily: 'var(--font-family)', fontWeight: 600,
              cursor: 'pointer', padding: '4px 0', textAlign: 'center',
              marginTop: 4,
              textDecoration: 'underline', textUnderlineOffset: 3,
            }}
          >
            {t('change_response', 'Cambiar respuesta')}
          </button>
        )}
      </div>

      {/* ── B. Card del encuentro ──────────────────────────── */}
      <div style={{
        background: '#fff', borderRadius: 20, padding: '20px',
        border: '1px solid rgba(0,0,0,0.06)',
        boxShadow: '0 2px 10px rgba(0,0,0,0.05)',
        marginBottom: 16,
      }}>
        <p style={{
          fontSize: 10, fontWeight: 700, color: 'var(--color-on-surface-variant)',
          textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px',
        }}>Encuentro</p>
        <h4 style={{ fontSize: 18, fontWeight: 800, marginBottom: 14, lineHeight: 1.25, color: '#111827' }}>
          {encuentro.titulo}
        </h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: 'var(--color-on-surface-variant)' }}>
            <CalendarCheck2 size={15} strokeWidth={2} color="var(--color-primary)" style={{ flexShrink: 0 }} />
            <span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: 'var(--color-on-surface-variant)' }}>
            {encuentro.modalidad === 'presencial'
              ? <MapPin size={15} strokeWidth={2} color="var(--color-primary)" style={{ flexShrink: 0 }} />
              : <Video size={15} strokeWidth={2} color="var(--color-primary)" style={{ flexShrink: 0 }} />
            }
            <span>{encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}</span>
          </div>
        </div>
      </div>

      {/* ── C. Acción de videollamada ─────────────────────── */}
      {encuentro.modalidad === 'virtual' && participante?.estado === 'confirmado' && encuentro.link_virtual && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          <div style={{
            background: 'var(--color-primary-container)',
            borderRadius: 12, padding: '10px 14px',
            fontSize: 13, color: 'var(--color-primary-dark)',
            fontWeight: 500, wordBreak: 'break-all',
          }}>
            {encuentro.link_virtual}
          </div>
          <Button fullWidth onClick={() => openExternalVideoLink(encuentro.link_virtual)}>
            {t('open_video_call', 'Abrir videollamada')}
          </Button>
          <button
            onClick={handleCopyVideoLink}
            style={{
              background: 'none', border: 'none',
              color: 'var(--color-on-surface-variant)', fontSize: 14,
              fontFamily: 'var(--font-family)', fontWeight: 500,
              cursor: 'pointer', padding: '6px 0', textAlign: 'center',
              textDecoration: 'underline', textUnderlineOffset: 3,
            }}
          >
            {copiedLink ? t('link_copied', 'Link copiado.') : t('copy_link', 'Copiar link')}
          </button>
        </div>
      )}

      {/* ── D. Texto de ayuda ─────────────────────────────── */}
      <p style={{
        fontSize: 13, color: 'var(--color-on-surface-variant)',
        textAlign: 'center', lineHeight: 1.6, margin: '0 0 20px',
      }}>
        Podés volver a este enlace en cualquier momento para ver los detalles del encuentro.
      </p>

      {visibleEnabled && (
        <div style={{
          background: 'rgba(0,0,0,0.02)', borderRadius: 14,
          border: '1px solid rgba(0,0,0,0.06)',
          padding: '14px 16px', marginBottom: 16,
        }}>
          <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: respuestasVisibles.length === 0 ? 10 : 6 }}>
            Respuestas del encuentro
          </p>
          {respuestasVisibles.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: '#6B7280' }}>Todavía no hay respuestas visibles.</p>
          ) : (
            <>
              <p style={{ fontSize: 12, color: '#6B7280', marginTop: 0, marginBottom: 16 }}>
                {[
                  formatCount(respuestasVisibles.filter(p => p.estado === 'confirmado').length, 'confirmado', 'confirmados'),
                  formatCount(respuestasVisibles.filter(p => p.estado === 'rechazado').length, 'no asiste', 'no asisten'),
                  formatCount(respuestasVisibles.filter(p => p.estado === 'pendiente').length, 'falta responder', 'faltan responder')
                ].filter(Boolean).join(' · ')}
              </p>
              {respuestasVisibles.filter(p => p.estado === 'confirmado').length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#059669' }}>Confirmaron</p>
                  {respuestasVisibles.filter(p => p.estado === 'confirmado').map((p, i) => (
                    <p key={i} style={{ margin: '2px 0', fontSize: 14, color: '#111827' }}>{p.nombre_invitado}</p>
                  ))}
                </div>
              )}
              {respuestasVisibles.filter(p => p.estado === 'rechazado').length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#DC2626' }}>No asisten</p>
                  {respuestasVisibles.filter(p => p.estado === 'rechazado').map((p, i) => (
                    <p key={i} style={{ margin: '2px 0', fontSize: 14, color: '#111827' }}>{p.nombre_invitado}</p>
                  ))}
                </div>
              )}
              {respuestasVisibles.filter(p => p.estado === 'pendiente').length > 0 && (
                <div>
                  <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#6B7280' }}>Faltan responder</p>
                  {respuestasVisibles.filter(p => p.estado === 'pendiente').map((p, i) => (
                    <p key={i} style={{ margin: '2px 0', fontSize: 14, color: '#4B5563' }}>{p.nombre_invitado}</p>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── E. Nudge de login ────────────────────────────── */}
      {!user && justConfirmed && (
        <div style={{
          padding: '16px', borderRadius: 14,
          background: 'rgba(0,0,0,0.03)',
          border: '1px solid rgba(0,0,0,0.07)',
          display: 'flex', flexDirection: 'column', gap: 10,
          marginBottom: 8,
        }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#374151', lineHeight: 1.35 }}>
            {t('save_this_meeting', 'Guardá este encuentro')}
          </p>
          <p style={{ margin: 0, fontSize: 12, color: '#6B7280', lineHeight: 1.5 }}>
            {t('access_anywhere', 'Accedé a este encuentro desde cualquier dispositivo iniciando sesión.')}
          </p>
          <Button variant="outline" size="sm" onClick={signInWithGoogle} style={{ width: '100%' }}>
            {t('account.continue_google', 'Continuar con Google')}
          </Button>
        </div>
      )}
      <ScrollHint visible={showScrollHint} />
    </ScreenContainer>
  );

  return (
    <ScreenContainer style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Invitación" />

      {isFinalizado && (
        <div style={{ margin: '20px 20px 0', background: '#F3F4F6', borderRadius: 16, padding: '16px', textAlign: 'center' }}>
          <p style={{ margin: 0, fontSize: 16, fontWeight: 800, color: '#374151' }}>Este encuentro ya finalizó.</p>
          <p style={{ margin: '4px 0 0', fontSize: 14, color: '#6B7280' }}>Ya no es posible responder a esta invitación.</p>
        </div>
      )}

      <div style={{ ...eventCard, marginTop: isFinalizado ? 16 : 20 }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Te invitan a</p>
        <h2 style={{ fontSize: 28, fontWeight: 800, marginBottom: 16, lineHeight: 1.15 }}>{encuentro.titulo}</h2>
        <div style={metaRow}><span style={metaIcon}>📅</span><span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span></div>
        {encuentro.modalidad === 'presencial' && encuentro.lugar_texto && (
          <div style={metaRow}><span style={metaIcon}>📍</span><span>{encuentro.lugar_texto}</span></div>
        )}
        <div style={metaRow}>
          <span style={metaIcon}>{encuentro.modalidad === 'presencial' ? '🤝' : '💻'}</span>
          <span>{encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}</span>
        </div>
        {encuentro.modalidad === 'virtual' && (
          <p style={{ marginTop: 4, fontSize: 13, color: 'var(--color-on-surface-variant)', fontStyle: 'italic' }}>
            {t('virtual_link_pending', 'Confirmá tu asistencia para acceder al enlace de la videollamada.')}
          </p>
        )}
      </div>

      {/* ── B. Confirmación ─────────────────────────────── */}
      {!isFinalizado && (
        <div style={{ ...eventCard, padding: '24px 20px' }}>
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface)', marginBottom: 8 }}>
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
            <p style={{ margin: '8px 0 0 0', fontSize: 12, color: 'var(--color-on-surface-variant)', lineHeight: 1.4 }}>
              {t('participant.visible_name_help', 'Este nombre será visible para el organizador.')}
            </p>
          </div>
        </div>
      )}

      {!isFinalizado && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 'auto' }}>
        <Button id="btn-confirmar" fullWidth variant="primary" onClick={() => handleResponse('confirmado')} disabled={!nombre.trim() || loadingResponse}>
          {loadingResponse ? t('loading_link', 'Cargando…') : t('yes_attend', 'Sí, puedo asistir')}
        </Button>
        <button
          onClick={() => handleResponse('rechazado')}
          disabled={!nombre.trim() || loadingResponse}
          style={{
            background: 'none', border: 'none',
            color: !nombre.trim() || loadingResponse ? 'var(--color-outline-variant)' : 'var(--color-on-surface-variant)',
            fontSize: 15, fontFamily: 'var(--font-family)', fontWeight: 500,
            cursor: !nombre.trim() || loadingResponse ? 'not-allowed' : 'pointer',
            padding: '10px 0', textAlign: 'center', width: '100%',
          }}
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
