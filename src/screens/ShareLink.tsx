import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { encuentrosService } from '@/services/encuentrosService';
import { formatFriendlyDate } from '@/lib/formatDate';

const ShareLink: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [encuentro, setEncuentro] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { if (id) loadData(); }, [id]);

  const loadData = async () => {
    try {
      setLoading(true); setError(null);
      const enc = await encuentrosService.getEncuentroById(id!);
      setEncuentro(enc);
    } catch (err) {
      console.error('Error loading data', err);
      setError('No se pudo cargar el encuentro.');
    } finally { setLoading(false); }
  };

  const shareUrl = encuentro ? `${window.location.origin}/join/${encuentro.public_token}` : '';

  const handleShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: encuentro?.titulo || 'Invitación',
          text: 'Te invito a este encuentro 👇 Confirmá si podés asistir:',
          url: shareUrl
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
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
    <ScreenContainer>
      <AppBar title="Compartir invitación" showBack />

      {/* Event summary */}
      <div style={{
        background: '#fff', borderRadius: 20, padding: '20px',
        border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
        marginTop: 20, marginBottom: 24,
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
      </div>
    </ScreenContainer>
  );
};

export default ShareLink;
