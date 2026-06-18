import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { useAuth } from '@/contexts/AuthContext';
import { getHostId } from '@/lib/auth';
import { formatFriendlyDate } from '@/lib/formatDate';
import { useTranslation } from 'react-i18next';
import { OrganizerMessageSheet } from '@/components/ui/OrganizerMessageSheet';
import { PencilLine } from 'lucide-react';

const AddGuests: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [encuentro, setEncuentro] = useState<any>(null);
  const [participantes, setParticipantes] = useState<any[]>([]);
  const [nombre, setNombre] = useState('');
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [personalMessage, setPersonalMessage] = useState('');
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { user } = useAuth();

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval>;
    if (id) {
      loadData();
      intervalId = setInterval(async () => {
        try {
          const hostId = user?.id ?? getHostId();
          const parts = await participantesService.getParticipantesByEncuentro(id, hostId);
          setParticipantes(parts || []);
        } catch (error) { console.error('Error polling data', error); }
      }, 10000);
      const handleVisibilityChange = async () => {
        if (document.visibilityState === 'visible') {
          try {
            const hostId = user?.id ?? getHostId();
            const parts = await participantesService.getParticipantesByEncuentro(id, hostId);
            setParticipantes(parts || []);
          } catch (error) { console.error('Error refreshing on visibility change', error); }
        }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => { if (intervalId) clearInterval(intervalId); document.removeEventListener('visibilitychange', handleVisibilityChange); };
    }
  }, [id]);

  const loadData = async () => {
    try {
      setLoading(true);
      const hostId = user?.id ?? getHostId();
      const enc = await encuentrosService.getDetalleHostSeguro(id!, hostId);
      setEncuentro(enc);
      const parts = await participantesService.getParticipantesByEncuentro(id!, hostId);
      setParticipantes(parts || []);
    } catch (error) { console.error('Error loading data', error); } finally { setLoading(false); }
  };

  const handleAdd = async () => {
    const trimNombre = nombre.trim();
    if (!trimNombre) return;
    const isDuplicate = participantes.some(p => p.nombre_invitado.toLowerCase() === trimNombre.toLowerCase());
    if (isDuplicate) { alert('Ya existe un invitado con ese nombre.'); return; }
    try {
      const tokenInvitacion = crypto.randomUUID();
      await participantesService.addParticipanteIndividual(id!, trimNombre, tokenInvitacion);
      setNombre('');
      setTimeout(() => inputRef.current?.focus(), 0);
      const hostId = user?.id ?? getHostId();
      const parts = await participantesService.getParticipantesByEncuentro(id!, hostId);
      setParticipantes(parts || []);
    } catch (error) { console.error('Error adding guest', error); alert('Error al agregar invitado'); }
  };

  const handleDelete = async (partId: string) => {
    try {
      setParticipantes(prev => prev.filter(p => p.id !== partId));
      await participantesService.deleteParticipante(partId, user?.id);
    } catch (error) {
      console.error('Error deleting guest', error);
      alert('Error al eliminar invitado');
      if (id) {
        const hostId = user?.id ?? getHostId();
        const parts = await participantesService.getParticipantesByEncuentro(id, hostId);
        setParticipantes(parts || []);
      }
    }
  };

  const handleShareLink = async (token: string, pid: string) => {
    const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const shareUrl = `${baseUrl}/invite/${token}`;
    
    let shareText = `${t('invitation.share_intro', 'Te invito a un encuentro:')}\n\n*${encuentro.titulo}*\n📅 ${formatFriendlyDate(encuentro.fecha, encuentro.hora)}\n${encuentro.modalidad === 'presencial' ? '📍' : '💻'} ${encuentro.modalidad === 'presencial' ? (encuentro.lugar_texto || 'Presencial') : 'Virtual'}\n\n`;

    if (personalMessage.trim()) {
      shareText += `${personalMessage.trim()}\n\n`;
    }

    shareText += `Confirmá acá:\n${shareUrl}`;

    if (navigator.share) {
      try { await navigator.share({ text: shareText }); }
      catch (err) { console.error('Error sharing', err); }
    } else {
      try {
        await navigator.clipboard.writeText(shareText);
        setCopiedId(pid); setTimeout(() => setCopiedId(null), 2000);
      } catch (err) { console.error('Failed to copy', err); alert('Error al copiar el enlace.'); }
    }
  };

  if (loading) return (
    <ScreenContainer>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p>Cargando…</p>
      </div>
    </ScreenContainer>
  );

  if (!encuentro) return (
    <ScreenContainer>
      <AppBar title="Error" showBack />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <p>Encuentro no encontrado.</p>
        <Button fullWidth onClick={() => navigate('/')} variant="ghost" style={{ color: 'var(--color-on-surface-variant)', border: '1px solid rgba(0,0,0,0.1)' }}>Ir al inicio</Button>
      </div>
    </ScreenContainer>
  );

  return (
    <ScreenContainer>
      <AppBar 
        title="Agregar Invitados" 
        showBack 
        onBack={() => navigate(`/meet/${id}`)}
      />

      {/* Event mini-card */}
      <div style={{
        background: '#fff', borderRadius: 16, padding: '14px 16px',
        border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
        marginTop: 16, marginBottom: 16,
      }}>
        <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{encuentro.titulo}</h3>
        <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', margin: 0 }}>
          📅 {formatFriendlyDate(encuentro.fecha, encuentro.hora)} · {encuentro.modalidad === 'presencial' ? '🤝 Presencial' : '💻 Virtual'}
        </p>
      </div>

      {/* Personal Message Option */}
      <div style={{ marginBottom: 24 }}>
        <button 
          onClick={() => setIsSheetOpen(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: personalMessage ? 'var(--color-primary-container)' : 'transparent',
            border: `1px solid ${personalMessage ? 'var(--color-primary)' : 'rgba(0,0,0,0.1)'}`,
            padding: '6px 12px', borderRadius: 8,
            cursor: 'pointer', transition: 'all 0.2s ease',
          }}
        >
          <PencilLine size={14} color={personalMessage ? 'var(--color-primary)' : '#6B7280'} />
          <span style={{ 
            fontSize: 13, fontWeight: 600, 
            color: personalMessage ? 'var(--color-primary)' : '#6B7280' 
          }}>
            {personalMessage ? t('invitation.edit_message', 'Editar mensaje de invitación') : t('invitation.add_message', 'Mensaje de invitación')}
          </span>
        </button>

        {personalMessage && (
          <p style={{
            marginTop: 10,
            fontSize: 13,
            color: '#6B7280',
            fontStyle: 'italic',
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            paddingLeft: 12,
            borderLeft: '2px solid var(--color-outline-variant)',
            margin: '10px 0 0 4px',
          }}>
            "{personalMessage}"
          </p>
        )}
      </div>

      {/* Inline input + add */}
      <div style={{
        display: 'flex', gap: 0,
        background: '#fff', borderRadius: 12,
        border: '1.5px solid var(--color-outline-variant)',
        overflow: 'hidden', marginBottom: 24,
        boxShadow: '0 2px 6px rgba(0,0,0,0.04)',
      }}>
        <input
          ref={inputRef}
          value={nombre}
          onChange={e => setNombre(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
          placeholder="Nombre del invitado"
          style={{
            flex: 1, border: 'none', outline: 'none',
            padding: '0 16px', height: 52, fontSize: 16,
            fontFamily: 'var(--font-family)', color: 'var(--color-on-surface)',
            background: 'transparent',
          }}
        />
        <button
          onClick={handleAdd}
          disabled={!nombre.trim()}
          style={{
            background: nombre.trim() ? 'var(--color-primary)' : 'var(--color-surface-variant)',
            color: nombre.trim() ? '#fff' : 'var(--color-on-surface-variant)',
            border: 'none', cursor: nombre.trim() ? 'pointer' : 'not-allowed',
            padding: '0 18px', fontFamily: 'var(--font-family)',
            fontWeight: 700, fontSize: 14, transition: 'all 0.18s',
            flexShrink: 0,
          }}
        >
          + Agregar
        </button>
      </div>



      {/* Guest list */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h4 style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface-variant)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
          Invitados · {participantes.length}
        </h4>

        {participantes.length === 0 && (
          <div style={{
            background: '#fff', borderRadius: 14, padding: '24px',
            border: '1.5px dashed var(--color-outline-variant)', textAlign: 'center',
          }}>
            <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)', margin: 0 }}>
              Todavía no hay invitados. ¡Agregá el primero!
            </p>
          </div>
        )}

        {participantes.map(p => (
          <div key={p.id} style={{
            background: '#fff', borderRadius: 14, padding: '14px 16px',
            border: '1px solid rgba(0,0,0,0.06)', boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>{p.nombre_invitado}</span>
              <Badge
                label={p.estado === 'pendiente' ? 'Pendiente' : p.estado === 'confirmado' ? 'Confirmado' : 'No asiste'}
                status={p.estado === 'confirmado' ? 'confirmed' : p.estado === 'rechazado' ? 'rejected' : 'pending'}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {p.estado === 'pendiente' && (
                <button
                  onClick={() => handleShareLink(p.token_invitacion, p.id)}
                  style={{
                    background: copiedId === p.id ? 'var(--color-primary-container)' : 'transparent',
                    border: `1.5px solid ${copiedId === p.id ? 'var(--color-primary)' : 'var(--color-outline-variant)'}`,
                    borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
                    fontFamily: 'var(--font-family)', fontSize: 13, fontWeight: 600,
                    color: copiedId === p.id ? 'var(--color-primary)' : 'var(--color-on-surface-variant)',
                    transition: 'all 0.15s',
                  }}
                >
                  {copiedId === p.id ? '✓ Copiado' : 'Compartir'}
                </button>
              )}
              <button
                onClick={() => handleDelete(p.id)}
                style={{
                  background: 'transparent', border: '1.5px solid var(--color-outline-variant)',
                  borderRadius: 8, width: 34, height: 34, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'var(--color-on-surface-variant)', fontSize: 14, transition: 'all 0.15s',
                }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24 }}>
        <Button fullWidth variant="primary" onClick={() => navigate(`/meet/${id}`)}>
          Ver encuentro
        </Button>
        <Button fullWidth variant="ghost" onClick={() => navigate('/')} style={{ color: 'var(--color-on-surface-variant)', border: '1px solid rgba(0,0,0,0.1)' }}>
          Ir al inicio
        </Button>
      </div>

      <OrganizerMessageSheet 
        isOpen={isSheetOpen}
        onClose={() => setIsSheetOpen(false)}
        initialMessage={personalMessage}
        onSave={(msg) => setPersonalMessage(msg)}
      />
    </ScreenContainer>
  );
};

export default AddGuests;
