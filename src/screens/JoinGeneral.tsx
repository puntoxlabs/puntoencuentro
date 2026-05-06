import React, { useEffect, useState } from 'react';
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
import { CheckCircle2, CalendarCheck2, MapPin, Video } from 'lucide-react';

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
  const [copiedLink, setCopiedLink] = useState(false);
  // true solo si el usuario acaba de confirmar en ESTA sesión (no una visita posterior)
  const [justConfirmed, setJustConfirmed] = useState(false);

  useEffect(() => { if (public_token) loadData(); }, [public_token]);

  const loadData = async () => {
    try {
      setLoading(true); setError(null);
      console.log('[GENERAL_LINK] token:', public_token);
      const data = await encuentrosService.getEncuentroByPublicToken(public_token!);
      if (!data) throw new Error("No encontrado");
      console.log('[GENERAL_LINK] encuentro:', data);
      console.log("Estado encuentro:", data.estado);
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
      console.log('[GENERAL_LINK] token local:', participantToken, 'id local:', participantId);
      let estadoUI = 'pending';
      if (participantToken) {
        try {
          const partData = await participantesService.getParticipanteByToken(participantToken);
          console.log('[GENERAL_LINK] participante backend token:', partData);
          if (partData) { 
            setParticipante(partData); 
            setNombre(partData.nombre_invitado || '');
            if (partData.estado !== 'pendiente') {
              setStep('done'); 
              estadoUI = 'done'; 
            }
          }
        } catch (err) { console.error('Participant not found by token', err); }
      } else if (participantId) {
        try {
          const partData = await participantesService.getParticipanteById(participantId);
          console.log('[GENERAL_LINK] participante backend id:', partData);
          if (partData) { 
            setParticipante(partData); 
            setNombre(partData.nombre_invitado || '');
            if (partData.estado !== 'pendiente') {
              setStep('done'); 
              estadoUI = 'done'; 
            }
          }
        } catch (err) { console.error('Participant not found by id', err); }
      }
      console.log('[GENERAL_LINK] estado final:', estadoUI);
    } catch (err) {
      console.error('Error loading encuentro', err);
      setError('No se pudo encontrar el encuentro o el enlace es inválido.');
    } finally { setLoading(false); }
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
    try {
      setLoadingResponse(true);
      
      let newPart;
      if (participante && participante.id) {
        // Caso: Ya existe el participante, actualizar respuesta
        newPart = await participantesService.updateParticipanteEstado(
          participante.id, estado, user?.id ?? null
        );
      } else {
        // Caso: Nuevo participante
        newPart = await participantesService.addParticipanteGenerico(
          encuentro.id, nombre.trim(), estado, user?.id ?? null
        );
      }

      if (newPart && newPart.id) {
        let savedData: SavedData = { encuentros: {} };
        try {
          const savedDataStr = localStorage.getItem('encuentros_general');
          if (savedDataStr) savedData = JSON.parse(savedDataStr);
        } catch (e) {
          console.error('Error parsing encuentros_general before saving', e);
        }

        if (!savedData.encuentros) savedData.encuentros = {};
        savedData.encuentros[public_token!] = { participant_id: newPart.id, token_invitacion: newPart.token_invitacion };
        localStorage.setItem('encuentros_general', JSON.stringify(savedData));

        // Guardar en sessionStorage para vinculación post-login
        if (!user) {
          sessionStorage.setItem('puntoencuentro_recent_participant_id', newPart.id);
        }
      }
      useHomeStore.getState().invalidateCache();
      setParticipante(newPart || { estado, nombre_invitado: nombre.trim() });
      setStep('done');
      setJustConfirmed(true);
      console.log('[GENERAL_LINK] estado final:', 'done');
    } catch (err) {
      console.error('Error responding', err);
      alert('Hubo un error al guardar tu respuesta. Por favor intenta de nuevo.');
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
    </ScreenContainer>
  );


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
    </ScreenContainer>
  );

  return (
    <ScreenContainer style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Invitación" />
      <div style={{ ...eventCard, marginTop: 20 }}>
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

      <div style={{ marginBottom: 20 }}>
        <Input
          label="¿Cómo te llamás?"
          placeholder="Ej: Marcos"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              document.getElementById('btn-confirmar')?.focus();
            }
          }}
        />
      </div>

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
    </ScreenContainer>
  );
};

export default JoinGeneral;
