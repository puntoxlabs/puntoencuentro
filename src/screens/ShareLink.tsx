import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { encuentrosService } from '@/services/encuentrosService';
import { formatFriendlyDate } from '@/lib/formatDate';
import { getThemeStyle } from '@/lib/themes';

const ShareLink: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [encuentro, setEncuentro] = useState<any>(null);
  const [anteriorData, setAnteriorData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { if (id) loadData(); }, [id]);

  const isLinkGeneral = encuentro?.tipo_invitacion === 'link_general';

  useEffect(() => {
    if (isLinkGeneral) {
      const timer = setTimeout(() => {
        navigate('/', { replace: true });
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [isLinkGeneral, navigate]);

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
      let shareText = 'Te invito a este encuentro 👇 Confirmá si podés asistir:';
      
      if (anteriorData) {
        shareText = `El encuentro anterior fue cancelado y reemplazado por este nuevo:\n❌ Anterior: ${anteriorData.titulo} – ${formatFriendlyDate(anteriorData.fecha, anteriorData.hora)}\n✅ Nuevo: ${encuentro.titulo} – ${formatFriendlyDate(encuentro.fecha, encuentro.hora)}\nNuevo enlace:`;
      }

      if (navigator.share) {
        await navigator.share({
          title: encuentro?.titulo || 'Invitación',
          text: shareText,
          url: shareUrl
        });
      } else {
        await navigator.clipboard.writeText(`${shareText}\n${shareUrl}`);
        setCopied(true); setTimeout(() => setCopied(false), 2000);
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
        <Button onClick={() => navigate('/')} variant="outline">Volver al inicio</Button>
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
          <p style={{ fontSize: 12, color: 'var(--color-on-surface-variant)', opacity: 0.7, marginTop: 4 }}>Redirigiendo en unos segundos...</p>
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
      </div>

      {/* Share section */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface-variant)', margin: 0 }}>
          Enlace de invitación
        </p>
        <div style={{
          background: 'var(--color-primary-container)',
          borderRadius: 12, padding: '12px 16px',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ flex: 1, fontSize: 13, color: 'var(--color-primary-dark)', fontWeight: 500, wordBreak: 'break-all' }}>
            {shareUrl}
          </span>
        </div>

        <Button fullWidth onClick={handleShare} variant={copied ? 'secondary' : 'primary'}>
          {copied ? '✓ Link copiado' : 'Compartir invitación'}
        </Button>

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
