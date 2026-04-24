import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { encuentrosService } from '@/services/encuentrosService';
import { formatFriendlyDate } from '@/lib/formatDate';

const ShareLink: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  
  const [encuentro, setEncuentro] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (id) {
      loadData();
    }
  }, [id]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const enc = await encuentrosService.getEncuentroById(id!);
      setEncuentro(enc);
    } catch (err) {
      console.error('Error loading data', err);
      setError('No se pudo cargar el encuentro.');
    } finally {
      setLoading(false);
    }
  };

  const shareUrl = encuentro ? `${window.location.origin}/join/${encuentro.public_token}` : '';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy', err);
      alert('Error al copiar el enlace.');
    }
  };

  if (loading) {
    return <ScreenContainer><p>Cargando...</p></ScreenContainer>;
  }

  if (error || !encuentro) {
    return (
      <ScreenContainer>
        <AppBar title="Error" showBack />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <p>{error || 'Encuentro no encontrado.'}</p>
          <Button onClick={() => navigate('/')} variant="outline" style={{ marginTop: '16px' }}>Volver al inicio</Button>
        </div>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <AppBar title="Compartir Enlace" showBack />

      <Card style={{ marginBottom: '24px' }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>{encuentro.titulo}</h3>
        <p style={{ margin: 0, color: 'var(--color-on-surface-variant)', fontSize: '14px', marginBottom: '8px' }}>
          {formatFriendlyDate(encuentro.fecha, encuentro.hora)} • {encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}
        </p>
        <p style={{ margin: 0, color: 'var(--color-on-surface-variant)', fontSize: '14px' }}>
          <strong>{encuentro.modalidad === 'presencial' ? 'Lugar:' : 'Link:'}</strong>{' '}
          {encuentro.modalidad === 'presencial' ? encuentro.lugar_texto : encuentro.link_virtual}
        </p>
      </Card>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <p style={{ margin: 0, fontSize: '14px', color: 'var(--color-on-surface)' }}>
          Copiá este link y compartilo por WhatsApp o donde quieras
        </p>
        <Card style={{ padding: '16px', wordBreak: 'break-all', backgroundColor: 'var(--color-surface-variant)' }}>
          <span style={{ fontSize: '14px', color: 'var(--color-primary)' }}>{shareUrl}</span>
        </Card>
        
        <Button onClick={handleCopy} variant={copied ? 'secondary' : 'primary'}>
          {copied ? '¡Copiado!' : 'Copiar link'}
        </Button>
      </div>

      <div style={{ marginTop: '24px', display: 'flex', gap: '12px', flexDirection: 'column' }}>
        <Button fullWidth onClick={() => navigate(`/meet/${id}`)}>
          Ver encuentro
        </Button>
        <Button fullWidth variant="outline" onClick={() => navigate('/')}>
          Volver al inicio
        </Button>
      </div>
    </ScreenContainer>
  );
};

export default ShareLink;
