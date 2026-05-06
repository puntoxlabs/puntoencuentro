import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { encuentrosService } from '@/services/encuentrosService';
import { formatFriendlyDate } from '@/lib/formatDate';
import { getThemeStyle } from '@/lib/themes';
import { OrganizerMessageSheet } from '@/components/ui/OrganizerMessageSheet';
import { PencilLine } from 'lucide-react';

const ShareLink: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { user, signInWithGoogle } = useAuth();
  const [encuentro, setEncuentro] = useState<any>(null);
  const [anteriorData, setAnteriorData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [shareFeedback, setShareFeedback] = useState(false);
  const [personalMessage, setPersonalMessage] = useState('');
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  useEffect(() => { if (id) loadData(); }, [id]);

  const isLinkGeneral = encuentro?.tipo_invitacion === 'link_general';

  const loadData = async () => {
    try {
      setLoading(true); setError(null);
      const enc = await encuentrosService.getEncuentroById(id!);
      setEncuentro(enc);

      // 1. Detect replacement from DB
      if (enc.reemplaza_a) {
        try {
          const ant = await encuentrosService.getEncuentroById(enc.reemplaza_a);
          setAnteriorData(ant);
        } catch (e) { console.error('Error loading anterior', e); }
      } 
      // 2. Fallback: sessionStorage
      else {
        const refStr = sessionStorage.getItem('cancel_reference');
        if (refStr) {
          try {
            const ref = JSON.parse(refStr);
            if (ref.newId === id || ref.fromId) {
              setAnteriorData({
                titulo: ref.title,
                fecha: ref.date,
                hora: ref.time
              });
            }
          } catch (e) { console.error('Error parsing ref', e); }
        }
      }

      // Cleanup session storage after processing
      sessionStorage.removeItem('cancel_reference');

    } catch (err) {
      console.error('Error loading data', err);
      setError('No se pudo cargar el encuentro.');
    } finally { setLoading(false); }
  };

  const shareUrl = encuentro ? `${window.location.origin}/join/${encuentro.public_token}` : '';

  const handleShare = async () => {
    try {
      let shareText = '';
      
      if (anteriorData) {
        shareText = `El encuentro anterior fue cancelado y reemplazado por este nuevo:\n\n❌ Anterior: ${anteriorData.titulo} – ${formatFriendlyDate(anteriorData.fecha, anteriorData.hora)}\n✅ Nuevo: ${encuentro.titulo} – ${formatFriendlyDate(encuentro.fecha, encuentro.hora)}\n\n`;
      } else {
        shareText = `Te invitaron a un encuentro:\n\n*${encuentro.titulo}*\n📅 ${formatFriendlyDate(encuentro.fecha, encuentro.hora)}\n${encuentro.modalidad === 'presencial' ? '📍' : '💻'} ${encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}\n\n`;
      }

      if (personalMessage.trim()) {
        shareText += `${t('invitation.organizer_message', 'Mensaje del organizador:')}\n${personalMessage.trim()}\n\n`;
      }

      shareText += `Confirmá acá:\n${shareUrl}`;

      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

      if (isMobile && navigator.share) {
        // Comportamiento Mobile: Usar share nativo
        await navigator.share({
          title: encuentro?.titulo || 'Invitación',
          text: shareText
        });
        setShareFeedback(true);
      } else {
        // Comportamiento Desktop/Web o fallback: Copiar al portapapeles
        await navigator.clipboard.writeText(shareText);
        setCopied(true); setTimeout(() => setCopied(false), 3000);
        setShareFeedback(true);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Error sharing/copying', err);
        alert('Error al compartir o copiar el enlace.');
      }
    }
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
      <AppBar title="Error" showBack />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <p>{error || 'Encuentro no encontrado.'}</p>
        <Button fullWidth onClick={() => navigate('/')} variant="ghost" style={{ color: 'var(--color-on-surface-variant)', border: '1px solid rgba(0,0,0,0.1)' }}>Ir al inicio</Button>
      </div>
    </ScreenContainer>
  );

  return (
    <ScreenContainer style={getThemeStyle(encuentro?.tema)}>
      <AppBar title="Compartir invitación" showBack />

      {/* Success Message for Link General */}
      {isLinkGeneral && (
        <div style={{ textAlign: 'center', marginTop: 16, marginBottom: 8, animation: 'fadeIn 0.5s ease-out' }}>
          <h2 style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-primary-dark)', marginBottom: 4 }}>Invitación lista ✔</h2>
          <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)', margin: 0 }}>Compartila con quien quieras</p>
        </div>
      )}

      {/* Replacement Banner */}
      {anteriorData && (
        <div style={{
          background: 'rgba(255, 255, 255, 0.8)',
          backdropFilter: 'blur(10px)',
          borderRadius: 16,
          padding: '12px 16px',
          marginTop: 16,
          border: '1.5px dashed var(--color-primary)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          animation: 'fadeIn 0.5s ease-out'
        }}>
          <span style={{ fontSize: 18 }}>✨</span>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--color-primary-dark)' }}>
            Este encuentro reemplaza a: <span style={{ fontWeight: 800 }}>{anteriorData.titulo}</span>
          </p>
        </div>
      )}

      {/* Event summary */}
      <div style={{
        background: '#fff', borderRadius: 20, padding: '20px',
        border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
        marginTop: anteriorData ? 12 : 20, marginBottom: 24,
      }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
          Encuentro
        </p>
        <h3 style={{ fontSize: 20, fontWeight: 800, marginBottom: 10, lineHeight: 1.2 }}>{encuentro.titulo}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 6 }}>
          <span>📅</span><span>{formatFriendlyDate(encuentro.fecha, encuentro.hora)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--color-on-surface-variant)' }}>
          <span>{encuentro.modalidad === 'presencial' ? '📍' : '💻'}</span>
          <span>{encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}</span>
        </div>

        {/* Mensaje Personal (si existe) */}
        {personalMessage.trim() && (
          <div style={{ 
            marginTop: 16, 
            paddingTop: 16, 
            borderTop: '1px solid rgba(0,0,0,0.06)',
            animation: 'fadeIn 0.3s ease'
          }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              {t('invitation.organizer_message', 'Mensaje del organizador')}
            </p>
            <p style={{ margin: 0, fontSize: 14, color: '#374151', lineHeight: 1.5, fontStyle: 'italic' }}>
              "{personalMessage}"
            </p>
          </div>
        )}
      </div>

      {/* Acción: Agregar Mensaje */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
        <button
          onClick={() => setIsSheetOpen(true)}
          style={{
            background: 'none',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: 'var(--color-primary-dark)',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            padding: '8px 12px',
            borderRadius: 10,
            transition: 'background 0.2s ease',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.03)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'none')}
        >
          <PencilLine size={16} />
          {personalMessage.trim() ? t('edit', 'Editar mensaje') : t('invitation.add_message', 'Agregar mensaje')}
        </button>
      </div>

      {/* Share section */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Button fullWidth onClick={handleShare} variant={copied ? 'secondary' : 'primary'}>
          {copied 
            ? `✓ ${t('share.copied', 'Mensaje copiado')}` 
            : t('share.button_invitation', 'Compartir invitación')}
        </Button>

        {copied && !/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) && (
          <p style={{ 
            fontSize: 13, 
            color: 'var(--color-primary-dark)', 
            textAlign: 'center', 
            margin: '0 0 8px', 
            fontWeight: 500, 
            lineHeight: 1.4,
            animation: 'fadeIn 0.3s ease' 
          }}>
            {t('invitation.desktop_copied', 'Mensaje copiado. Pegalo en WhatsApp Web, correo o donde quieras compartirlo.')}
          </p>
        )}

        {shareFeedback && !copied && (
          <p style={{ fontSize: 13, color: 'var(--color-primary-dark)', textAlign: 'center', margin: '4px 0 8px', fontWeight: 500, animation: 'fadeIn 0.3s ease' }}>
            {t('share.ready_host', 'Listo. Podés volver al inicio o revisar el encuentro.')}
          </p>
        )}

        {/* Nudge: Save to account */}
        {!user && !loading && encuentro && (
          <div style={{
            background: 'var(--color-primary-container)',
            borderRadius: 16,
            padding: '16px 20px',
            marginTop: 8,
            marginBottom: 8,
            border: '1px solid var(--color-primary)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            animation: 'fadeIn 0.5s ease-out'
          }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: 'var(--color-primary)', lineHeight: 1.3 }}>
              {t('account.save_encounter_title', 'Guardá este encuentro en tu cuenta')}
            </p>
            <p style={{ margin: 0, fontSize: 13, color: '#374151', lineHeight: 1.5 }}>
              {t('account.save_encounter_desc', 'Accedé desde otros dispositivos y mantené tu historial organizado.')}
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => signInWithGoogle()}
              style={{ alignSelf: 'flex-start', padding: '0 18px', height: 36 }}
            >
              <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true" style={{ marginRight: 8 }}>
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
              </svg>
              {t('account.continue_google', 'Continuar con Google')}
            </Button>
          </div>
        )}

        <Button fullWidth variant="outline" onClick={() => navigate(`/meet/${id}`)}>
          Ver encuentro
        </Button>

        <Button
          fullWidth
          variant="ghost"
          onClick={() => navigate('/', { replace: true })}
          style={{ 
            color: 'var(--color-on-surface-variant)', 
            marginTop: 4,
            border: '1px solid rgba(0,0,0,0.1)'
          }}
        >
          Ir al inicio
        </Button>
      </div>

      <OrganizerMessageSheet
        isOpen={isSheetOpen}
        onClose={() => setIsSheetOpen(false)}
        initialMessage={personalMessage}
        onSave={setPersonalMessage}
      />

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}} />
    </ScreenContainer>
  );
};

export default ShareLink;
