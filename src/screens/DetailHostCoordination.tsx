import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ScreenContainer } from '@/components/ui/ScreenContainer';
import { AppBar } from '@/components/ui/AppBar';
import { Button } from '@/components/ui/Button';
import { encuentrosService } from '@/services/encuentrosService';
import type { CoordinationHostDetail } from '@/services/encuentrosService';
import { Clock, MapPin, Video, Link, Users, Share2, Plus } from 'lucide-react';
import { formatFriendlyDate, formatFriendlyDeadline } from '@/lib/formatDate';
import { isMobileShareEnvironment, buildGeneralInvitationUrl } from '@/lib/shareHelper';
import { useTranslation } from 'react-i18next';
import { formatCoordinationDuration } from '@/lib/formatDuration';

const DetailHostCoordination: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [detail, setDetail] = useState<CoordinationHostDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async (isPolling = false) => {
    if (!id) return;
    try {
      if (!isPolling) setLoading(true);
      if (!isPolling) setError(null);
      const data = await encuentrosService.getCoordinacionHost(id);
      if (data && data.ok) {
        setDetail(data);
      } else {
        if (!isPolling) setError(data.error || 'No se pudo cargar la coordinación.');
      }
    } catch (err: any) {
      console.error('[DetailHostCoordination] Error:', err);
      if (!isPolling) setError('Ocurrió un error al cargar la coordinación.');
    } finally {
      if (!isPolling) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData(false);
    const interval = setInterval(() => {
      loadData(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  if (loading) {
    return (
      <ScreenContainer>
        <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <p>Cargando coordinación...</p>
        </div>
      </ScreenContainer>
    );
  }

  if (error || !detail || !detail.encuentro) {
    return (
      <ScreenContainer>
        <AppBar title="Coordinación" showBack onBack={() => navigate('/')} />
        <div style={{ padding: 20, textAlign: 'center' }}>
          <p style={{ color: 'var(--pe-error)', marginBottom: 16 }}>{error || 'No se encontró la coordinación.'}</p>
          <Button variant="outline" onClick={() => navigate('/')}>Volver al inicio</Button>
        </div>
      </ScreenContainer>
    );
  }

  const { encuentro, opciones, response_deadline } = detail;
  const isLinkGeneral = encuentro.tipo_invitacion === 'link_general';

  const shareUrl = buildGeneralInvitationUrl(encuentro.public_token, 'coordination');

  const handleShare = async () => {
    if (isLinkGeneral) {
      if (!shareUrl) {
        console.error('[DetailHostCoordination] Cannot share: Missing public_token');
        return;
      }
      const shareData = {
        title: `Sumate a: ${encuentro.titulo}`,
        text: `Hola. Estoy coordinando la fecha para "${encuentro.titulo}".\n\nEntrá al enlace para indicar en qué opciones estás disponible:\n\n${shareUrl}`,
        url: shareUrl,
      };

      try {
        if (isMobileShareEnvironment()) {
          await navigator.share(shareData);
        } else {
          await navigator.clipboard.writeText(shareData.text);
          alert('¡Link copiado al portapapeles!');
        }
      } catch (err) {
        console.error('Error sharing:', err);
      }
    } else {
      navigate(`/add-guests/${encuentro.id}`);
    }
  };

  return (
    <ScreenContainer>
      <AppBar title="Coordinación" showBack onBack={() => navigate('/')} />

      <div style={{ padding: '20px', paddingBottom: '160px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span style={{ backgroundColor: '#eef2ff', color: '#4f46e5', padding: '4px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600, textTransform: 'uppercase' }}>
            Esperando respuestas
          </span>
        </div>

        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 8px 0', color: 'var(--pe-text)' }}>
          {encuentro.titulo} <span style={{ fontSize: 10, color: 'var(--pe-text-muted)', fontWeight: 400 }}>v2</span>
        </h1>

        {encuentro.descripcion && (
          <p style={{ fontSize: 15, color: 'var(--pe-text-muted)', marginBottom: 24, lineHeight: 1.5 }}>
            {encuentro.descripcion}
          </p>
        )}

        {!shareUrl && isLinkGeneral && (
          <div style={{ backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', padding: '16px', borderRadius: 8, marginBottom: 24 }}>
            <h4 style={{ color: '#1e3a8a', margin: '0 0 8px 0', fontSize: 16, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Link size={18} />
              El enlace todavía no está disponible
            </h4>
            <p style={{ color: '#1e40af', margin: '0 0 8px 0', fontSize: 14 }}>
              Esta coordinación se creó correctamente, pero el enlace para invitados requiere una actualización pendiente del sistema.
            </p>
            <p style={{ color: '#1e40af', margin: 0, fontSize: 13, opacity: 0.9 }}>
              La función de coordinación continúa en preparación y todavía no está habilitada en producción.
            </p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Card 1: General Info */}
          <div style={{ background: 'var(--pe-bg)', borderRadius: 12, padding: '20px', border: '1px solid var(--pe-border)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
              {encuentro.modalidad === 'presencial' ? <MapPin size={20} color="var(--pe-text-muted)" style={{ marginTop: 2 }} /> : <Video size={20} color="var(--pe-text-muted)" style={{ marginTop: 2 }} />}
              <div>
                <span style={{ display: 'block', fontWeight: 600, color: 'var(--pe-text)' }}>
                  {encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}
                </span>
                <span style={{ display: 'block', fontSize: 14, color: 'var(--pe-text-muted)' }}>
                  {encuentro.modalidad === 'presencial' ? encuentro.lugar_texto : encuentro.link_virtual}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
              {isLinkGeneral ? <Link size={20} color="var(--pe-text-muted)" style={{ marginTop: 2 }} /> : <Users size={20} color="var(--pe-text-muted)" style={{ marginTop: 2 }} />}
              <div>
                <span style={{ display: 'block', fontWeight: 600, color: 'var(--pe-text)' }}>
                  Tipo de invitación
                </span>
                <span style={{ display: 'block', fontSize: 14, color: 'var(--pe-text-muted)' }}>
                  {isLinkGeneral ? 'Link general' : 'Invitados individuales'}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
              <Clock size={20} color="var(--pe-text-muted)" style={{ marginTop: 2 }} />
              <div>
                <span style={{ display: 'block', fontWeight: 600, color: 'var(--pe-text)' }}>
                  Duración estimada
                </span>
                <span style={{ display: 'block', fontSize: 14, color: 'var(--pe-text-muted)' }}>
                  {formatCoordinationDuration(encuentro.duration_minutes, t) || 'Duración flexible'}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <Clock size={20} color="var(--pe-text-muted)" style={{ marginTop: 2 }} />
              <div>
                <span style={{ display: 'block', fontWeight: 600, color: 'var(--pe-text)' }}>Plazo para responder</span>
                <span style={{ display: 'block', fontSize: 14, color: 'var(--pe-text-muted)' }}>
                  {response_deadline ? formatFriendlyDeadline(response_deadline) : 'Sin plazo definido'}
                </span>
              </div>
            </div>
          </div>

          {/* Card 2: Opciones */}
          <div style={{ background: 'var(--pe-bg)', borderRadius: 12, padding: '20px', border: '1px solid var(--pe-border)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px 0', color: 'var(--pe-text)' }}>
              Opciones propuestas
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {opciones?.map((opt) => {
                return (
                  <div key={opt.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderRadius: 12, border: '1px solid var(--pe-border)', background: 'var(--pe-bg-hover)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--pe-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: 'var(--pe-text-muted)', border: '1px solid var(--pe-border)' }}>
                        {opt.orden}
                      </div>
                      <div>
                        <span style={{ display: 'block', fontWeight: 600, color: 'var(--pe-text)', fontSize: 15 }}>
                          {formatFriendlyDate(opt.fecha, opt.hora_inicio)}
                        </span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {opt.available_count > 0 && <span style={{ color: '#16a34a', fontWeight: 600, fontSize: 13 }}>{opt.available_count} Sí</span>}
                      {opt.maybe_count > 0 && <span style={{ color: '#ca8a04', fontWeight: 600, fontSize: 13 }}>{opt.maybe_count} Tal vez</span>}
                      {opt.unavailable_count > 0 && <span style={{ color: '#dc2626', fontWeight: 600, fontSize: 13 }}>{opt.unavailable_count} No</span>}
                      {opt.available_count === 0 && opt.maybe_count === 0 && opt.unavailable_count === 0 && <span style={{ color: 'var(--pe-text-muted)', fontSize: 13 }}>0 votos</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Card 3: Respuestas */}
          <div style={{ background: 'var(--pe-bg)', borderRadius: 12, padding: '20px', border: '1px solid var(--pe-border)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px 0', color: 'var(--pe-text)' }}>
              Respuestas
            </h3>

            {(!detail.participantes || detail.participantes.filter(p => p.respondio_disponibilidad).length === 0) ? (
              <div style={{ padding: '24px 16px', borderRadius: 12, border: '1px dashed var(--pe-border)', textAlign: 'center', backgroundColor: 'var(--pe-bg-hover)' }}>
                <p style={{ margin: 0, fontSize: 14, color: 'var(--pe-text-muted)' }}>
                  Todavía no recibiste disponibilidades.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {detail.participantes.filter(p => p.respondio_disponibilidad).map((part) => (
                  <div key={part.id} style={{ padding: 16, borderRadius: 12, border: '1px solid var(--pe-border)', background: 'var(--pe-bg-hover)' }}>
                    <span style={{ fontWeight: 600, color: 'var(--pe-text)', display: 'block', marginBottom: 12, fontSize: 15 }}>
                      {part.nombre_invitado}
                    </span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {part.respuestas.map((resp) => {
                        const option = opciones?.find(o => o.id === resp.opcion_fecha_id);
                        if (!option) return null;
                        return (
                          <div key={resp.opcion_fecha_id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, alignItems: 'center' }}>
                            <span style={{ color: 'var(--pe-text-muted)' }}>Opción {option.orden}:</span>
                            <span style={{ fontWeight: 600, fontSize: 13, padding: '2px 8px', borderRadius: 12, backgroundColor: resp.respuesta === 'available' ? '#dcfce7' : resp.respuesta === 'maybe' ? '#fef08a' : '#fee2e2', color: resp.respuesta === 'available' ? '#166534' : resp.respuesta === 'maybe' ? '#854d0e' : '#991b1b' }}>
                              {resp.respuesta === 'available' ? 'Sí puedo' : resp.respuesta === 'maybe' ? 'Tal vez' : 'No puedo'}
                              {resp.es_preferida && ' ★'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, padding: '16px 20px', background: 'var(--pe-bg)', borderTop: '1px solid var(--pe-border)', paddingBottom: 'calc(16px + env(safe-area-inset-bottom))', zIndex: 10 }}>
        <Button
          variant="primary"
          fullWidth
          onClick={handleShare}
          disabled={isLinkGeneral && !shareUrl}
          aria-disabled={isLinkGeneral && !shareUrl}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          {isLinkGeneral ? <Share2 size={20} /> : <Plus size={20} />}
          {isLinkGeneral ? 'Compartir link general' : 'Agregar invitados'}
        </Button>
      </div>
    </ScreenContainer>
  );
};

export default DetailHostCoordination;
