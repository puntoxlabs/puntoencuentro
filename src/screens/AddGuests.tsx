import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate } from '@/lib/formatDate';

const AddGuests: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  
  const [encuentro, setEncuentro] = useState<any>(null);
  const [participantes, setParticipantes] = useState<any[]>([]);
  const [nombre, setNombre] = useState('');
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval>;
    
    if (id) {
      loadData();
      
      // Polling cada 10 segundos
      intervalId = setInterval(async () => {
        try {
          const parts = await participantesService.getParticipantesByEncuentro(id);
          setParticipantes(parts || []);
        } catch (error) {
          console.error('Error polling data', error);
        }
      }, 10000);
      
      // Refrescar al volver a la pestaña
      const handleVisibilityChange = async () => {
        if (document.visibilityState === 'visible') {
          try {
            const parts = await participantesService.getParticipantesByEncuentro(id);
            setParticipantes(parts || []);
          } catch (error) {
            console.error('Error refreshing on visibility change', error);
          }
        }
      };
      
      document.addEventListener('visibilitychange', handleVisibilityChange);
      
      return () => {
        if (intervalId) clearInterval(intervalId);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
    }
  }, [id]);

  const loadData = async () => {
    try {
      setLoading(true);
      const enc = await encuentrosService.getEncuentroById(id!);
      setEncuentro(enc);
      
      const parts = await participantesService.getParticipantesByEncuentro(id!);
      setParticipantes(parts || []);
    } catch (error) {
      console.error('Error loading data', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    const trimNombre = nombre.trim();
    if (!trimNombre) return;

    // Avoid exact duplicates locally
    const isDuplicate = participantes.some(
      (p) => p.nombre_invitado.toLowerCase() === trimNombre.toLowerCase()
    );

    if (isDuplicate) {
      alert('Ya existe un invitado con ese nombre.');
      return;
    }

    try {
      const tokenInvitacion = crypto.randomUUID();
      await participantesService.addParticipanteIndividual(id!, trimNombre, tokenInvitacion);
      
      setNombre('');
      setTimeout(() => inputRef.current?.focus(), 0);
      // Refresh list
      const parts = await participantesService.getParticipantesByEncuentro(id!);
      setParticipantes(parts || []);
    } catch (error) {
      console.error('Error adding guest', error);
      alert('Error al agregar invitado');
    }
  };

  const handleDelete = async (partId: string) => {
    try {
      // Optimistic update to make it disappear immediately
      setParticipantes(prev => prev.filter(p => p.id !== partId));
      await participantesService.deleteParticipante(partId);
    } catch (error) {
      console.error('Error deleting guest', error);
      alert('Error al eliminar invitado');
      // Revert if failed
      if (id) {
        const parts = await participantesService.getParticipantesByEncuentro(id);
        setParticipantes(parts || []);
      }
    }
  };

  const handleShareLink = async (token: string, id: string) => {
    const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const shareUrl = `${baseUrl}/invite/${token}`;
    
    if (navigator.share) {
      try {
        await navigator.share({
          text: 'Te invito a este encuentro 👇 Confirmá si podés asistir:',
          url: shareUrl
        });
      } catch (err) {
        console.error('Error sharing', err);
      }
    } else {
      try {
        await navigator.clipboard.writeText(shareUrl);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
      } catch (err) {
        console.error('Failed to copy', err);
        alert('Error al copiar el enlace.');
      }
    }
  };

  if (loading) return <ScreenContainer><p>Cargando...</p></ScreenContainer>;
  if (!encuentro) {
    return (
      <ScreenContainer>
        <AppBar title="Error" showBack />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <p>Encuentro no encontrado.</p>
          <Button onClick={() => navigate('/')} variant="outline" style={{ marginTop: '16px' }}>Volver al inicio</Button>
        </div>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <AppBar title="Agregar Invitados" showBack />

      <Card style={{ marginBottom: '16px' }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>{encuentro.titulo}</h3>
        <p style={{ margin: 0, color: 'var(--color-on-surface-variant)', fontSize: '14px' }}>
          {formatFriendlyDate(encuentro.fecha, encuentro.hora)} • {encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}
        </p>
      </Card>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
        <div style={{ flex: 1 }}>
          <Input 
            ref={inputRef}
            placeholder="Nombre del invitado" 
            value={nombre} 
            onChange={(e) => setNombre(e.target.value)} 
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          />
        </div>
        <Button onClick={handleAdd} disabled={!nombre.trim()}>
          Agregar
        </Button>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <h4 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>
          Lista de invitados ({participantes.length})
        </h4>
        {participantes.map((p) => (
          <Card key={p.id} style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontWeight: 500 }}>{p.nombre_invitado}</span>
              <Badge 
                label={p.estado.charAt(0).toUpperCase() + p.estado.slice(1)} 
                status={p.estado === 'confirmado' ? 'confirmed' : p.estado === 'rechazado' ? 'rejected' : 'pending'} 
              />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {p.estado === 'pendiente' && (
                <Button variant="outline" style={{ padding: '0 12px', height: '32px' }} onClick={() => handleShareLink(p.token_invitacion, p.id)}>
                  {copiedId === p.id ? 'Link copiado' : 'Compartir invitación'}
                </Button>
              )}
              <Button variant="outline" style={{ padding: '0 12px', height: '32px' }} onClick={() => handleDelete(p.id)}>
                X
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <div style={{ marginTop: '24px', display: 'flex', gap: '12px', flexDirection: 'column' }}>
        <Button fullWidth variant="primary" onClick={() => navigate(`/meet/${id}`)}>
          Ver encuentro
        </Button>
        <Button fullWidth variant="outline" onClick={() => navigate('/')}>
          Volver al inicio
        </Button>
      </div>
    </ScreenContainer>
  );
};

export default AddGuests;
