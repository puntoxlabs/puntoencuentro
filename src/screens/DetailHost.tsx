import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { encuentrosService } from '@/services/encuentrosService';
import { participantesService } from '@/services/participantesService';
import { formatFriendlyDate } from '@/lib/formatDate';
import { useDetailStore } from '@/store/detailStore';
import { useTranslation } from 'react-i18next';
import { openExternalVideoLink } from '@/lib/openLink';
import throttle from 'lodash/throttle';

const DetailHost: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  
  const { getValidCache, setDetailData, setScrollPosition } = useDetailStore();
  const validCache = getValidCache(id!);

  const [encuentro, setEncuentro] = useState<any>(validCache?.encuentro || null);
  const [participantes, setParticipantes] = useState<any[]>(validCache?.participantes || []);
  const [loading, setLoading] = useState(!validCache);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval>;
    
    if (id) {
      loadData();
      
      if (validCache && validCache.scrollPosition > 0) {
        requestAnimationFrame(() => {
          const container = document.getElementById('detail-scroll-container');
          if (container) {
            container.scrollTop = validCache.scrollPosition;
          }
        });
      }
      
      intervalId = setInterval(async () => {
        try {
          const parts = await participantesService.getParticipantesByEncuentro(id);
          setParticipantes(parts || []);
          const currentEnc = useDetailStore.getState().cache[id]?.encuentro;
          if (currentEnc) {
            setDetailData(id, currentEnc, parts || []);
          }
        } catch (err) {
          console.error('Error polling participants', err);
        }
      }, 10000);
    }
    
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [id]);

  const loadData = async () => {
    try {
      if (!useDetailStore.getState().getValidCache(id!)) {
        setLoading(true);
      }
      setError(null);
      const enc = await encuentrosService.getEncuentroById(id!);
      setEncuentro(enc);
      const parts = await participantesService.getParticipantesByEncuentro(id!);
      setParticipantes(parts || []);
      setDetailData(id!, enc, parts || []);
    } catch (err) {
      console.error('Error loading detail', err);
      setError('No se pudo cargar el encuentro.');
    } finally {
      setLoading(false);
    }
  };

  const handleScroll = throttle((e: React.UIEvent<HTMLDivElement>) => {
    if (id) {
      setScrollPosition(id, e.currentTarget.scrollTop);
    }
  }, 200);

  if (loading) {
    return <ScreenContainer><p>Cargando detalle...</p></ScreenContainer>;
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

  const confirmados = participantes.filter(p => p.estado === 'confirmado');
  const pendientes = participantes.filter(p => p.estado === 'pendiente');
  const rechazados = participantes.filter(p => p.estado === 'rechazado');

  const handleShareLink = async (token: string, partId: string) => {
    if (!token) return;
    const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin;
    const shareUrl = `${baseUrl}/invite/${token}`;
    const shareText = "Te invito a este encuentro 👇 Confirmá si podés asistir:";
    
    if (navigator.share) {
      try {
        await navigator.share({
          text: shareText,
          url: shareUrl
        });
      } catch (err) {
        console.error('Error sharing', err);
      }
    } else {
      try {
        await navigator.clipboard.writeText(shareUrl);
        setCopiedId(partId);
        setTimeout(() => setCopiedId(null), 2000);
      } catch (err) {
        console.error('Failed to copy', err);
        alert('Error al copiar el enlace.');
      }
    }
  };

  const handleCopyVideoLink = async () => {
    if (!encuentro?.link_virtual) return;
    try {
      await navigator.clipboard.writeText(encuentro.link_virtual);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch (err) {
      console.error('Failed to copy', err);
      alert('Error al copiar el enlace.');
    }
  };

  const renderParticipantsGroup = (title: string, group: any[], badgeStatus: 'confirmed' | 'pending' | 'rejected') => {
    if (group.length === 0) return null;
    return (
      <div style={{ marginBottom: '16px' }}>
        <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', color: 'var(--color-on-surface-variant)' }}>
          {title} ({group.length})
        </h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {group.map(p => {
            let timeLabel = '';
            if (p.respondido_en) {
              const dateObj = new Date(p.respondido_en);
              timeLabel = `Respondió ${dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            } else if (p.creado_en) {
              const dateObj = new Date(p.creado_en);
              timeLabel = `Creado ${dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            } else {
              timeLabel = 'Pendiente';
            }

            return (
              <Card key={p.id} style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontWeight: 500, fontSize: '15px' }}>{p.nombre_invitado}</span>
                  <span style={{ fontSize: '13px', color: 'var(--color-on-surface-variant)', marginTop: '2px' }}>
                    {timeLabel}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {p.estado === 'pendiente' && p.token_invitacion && (
                    <Button variant="outline" style={{ padding: '0 8px', height: '28px', fontSize: '12px' }} onClick={() => handleShareLink(p.token_invitacion, p.id)}>
                      {copiedId === p.id ? 'Link copiado' : 'Compartir invitación'}
                    </Button>
                  )}
                  <Badge 
                    label={p.estado.charAt(0).toUpperCase() + p.estado.slice(1)} 
                    status={badgeStatus} 
                  />
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <ScreenContainer>
      <AppBar title="Detalle del Encuentro" showBack />
      
      <div 
        id="detail-scroll-container"
        onScroll={handleScroll}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingBottom: '16px' }}
      >
        <Card style={{ marginBottom: '16px', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '20px' }}>{encuentro.titulo}</h3>
            <Badge 
              label={encuentro.estado.charAt(0).toUpperCase() + encuentro.estado.slice(1)} 
              status={encuentro.estado === 'activo' ? 'confirmed' : 'default'} 
            />
          </div>
          
          <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface)', fontSize: '14px' }}>
            <strong>Fecha y hora:</strong><br/>
            {formatFriendlyDate(encuentro.fecha, encuentro.hora)}
          </p>
          <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface)', fontSize: '14px' }}>
            <strong>Modalidad:</strong> {encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}
          </p>
          {encuentro.modalidad === 'presencial' ? (
            <p style={{ margin: '0 0 8px 0', color: 'var(--color-on-surface)', fontSize: '14px' }}>
              <strong>Lugar:</strong><br/>
              {encuentro.lugar_texto}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '8px' }}>
              <p style={{ margin: 0, color: 'var(--color-on-surface)', fontSize: '14px' }}>
                <strong>Link de videollamada:</strong><br/>
                <span style={{ wordBreak: 'break-all' }}>{encuentro.link_virtual}</span>
              </p>
              {encuentro.link_virtual && (
                <>
                  <Button fullWidth onClick={() => openExternalVideoLink(encuentro.link_virtual)} style={{ marginTop: '4px' }}>
                    {t('open_video_call', 'Abrir videollamada')}
                  </Button>
                  
                  <Button fullWidth variant="outline" onClick={handleCopyVideoLink}>
                    {copiedLink ? t('link_copied', 'Link copiado.') : t('copy_link', 'Copiar link')}
                  </Button>
                </>
              )}
            </div>
          )}
          {encuentro.descripcion && (
            <p style={{ margin: 0, color: 'var(--color-on-surface-variant)', fontSize: '14px', fontStyle: 'italic' }}>
              {encuentro.descripcion}
            </p>
          )}
        </Card>

        <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexShrink: 0 }}>
          {encuentro.tipo_invitacion === 'link_general' && (
            <Button fullWidth onClick={() => navigate(`/share/${encuentro.id}`)}>
              Compartir link
            </Button>
          )}
          {encuentro.tipo_invitacion === 'individual' && (
            <Button fullWidth onClick={() => navigate(`/add-guests/${encuentro.id}`)}>
              Agregar invitados
            </Button>
          )}
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px' }}>Participantes</h3>
          
          {participantes.length === 0 ? (
            <div style={{ backgroundColor: 'var(--color-surface)', border: '1px dashed var(--color-outline-variant)', borderRadius: 'var(--radius-md)', padding: '24px', textAlign: 'center' }}>
              <p style={{ margin: 0, color: 'var(--color-on-surface-variant)', fontSize: '14px' }}>Aún no hay participantes en este encuentro.</p>
            </div>
          ) : (
            <>
              {renderParticipantsGroup('Confirmados', confirmados, 'confirmed')}
              {renderParticipantsGroup('No asisten', rechazados, 'rejected')}
              {renderParticipantsGroup('Pendientes', pendientes, 'pending')}
            </>
          )}
        </div>
      </div>
    </ScreenContainer>
  );
};

export default DetailHost;
