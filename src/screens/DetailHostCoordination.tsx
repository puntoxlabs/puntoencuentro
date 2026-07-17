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
      const shareText = `Hola 👋\n\nTe invito a coordinar la fecha para "${encuentro.titulo}" en PuntoEncuentro.\n\nRespondé tu disponibilidad acá:`;
      const shareData = {
        title: `Coordinar fecha: ${encuentro.titulo}`,
        text: shareText,
        url: shareUrl,
      };

      try {
        if (isMobileShareEnvironment()) {
          await navigator.share(shareData);
        } else {
          await navigator.clipboard.writeText(`${shareText}\n${shareUrl}`);
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

      <div style={{ padding: '20px', paddingBottom: '160px', background: '#F8FAFC', minHeight: '100vh' }}>
        <div style={{ maxWidth: 600, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <span style={{ backgroundColor: '#eef2ff', color: '#4f46e5', padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Esperando respuestas
            </span>
          </div>

          <h1 style={{ fontSize: 26, fontWeight: 800, margin: '0 0 8px 0', color: '#0f172a', letterSpacing: '-0.5px' }}>
            {encuentro.titulo}
          </h1>

          {encuentro.descripcion && (
            <p style={{ fontSize: 16, color: '#475569', marginBottom: 28, lineHeight: 1.6 }}>
              {encuentro.descripcion}
            </p>
          )}

          {!shareUrl && isLinkGeneral && (
            <div style={{ backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', padding: '16px', borderRadius: 16, marginBottom: 24 }}>
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

          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Card 1: General Info */}
            <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)' }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 20px 0', color: '#0f172a', paddingBottom: 16, borderBottom: '1px solid rgba(15,23,42,0.05)' }}>
                Información general
              </h3>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{ background: '#E0F2FE', padding: 8, borderRadius: 10 }}>
                    {encuentro.modalidad === 'presencial' ? <MapPin size={18} color="#0284C7" /> : <Video size={18} color="#0284C7" />}
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                      {encuentro.modalidad === 'presencial' ? 'Presencial' : 'Virtual'}
                    </span>
                    <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                      {encuentro.modalidad === 'presencial' ? encuentro.lugar_texto : encuentro.link_virtual}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{ background: '#EDE9FE', padding: 8, borderRadius: 10 }}>
                    {isLinkGeneral ? <Link size={18} color="#7C3AED" /> : <Users size={18} color="#7C3AED" />}
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                      Tipo de invitación
                    </span>
                    <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                      {isLinkGeneral ? 'Link general' : 'Invitados individuales'}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{ background: '#DCFCE7', padding: 8, borderRadius: 10 }}>
                    <Clock size={18} color="#16A34A" />
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                      Duración
                    </span>
                    <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                      {formatCoordinationDuration(encuentro.duration_minutes, t) || 'Flexible'}
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                  <div style={{ background: '#FCE7F3', padding: 8, borderRadius: 10 }}>
                    <Clock size={18} color="#DB2777" />
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
                      Plazo para responder
                    </span>
                    <span style={{ display: 'block', fontSize: 15, color: '#1e293b', fontWeight: 500 }}>
                      {response_deadline ? formatFriendlyDeadline(response_deadline) : 'Sin plazo definido'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Card 2: Opciones */}
            <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)' }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 20px 0', color: '#0f172a', paddingBottom: 16, borderBottom: '1px solid rgba(15,23,42,0.05)' }}>
                Opciones propuestas
              </h3>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {opciones?.map((opt) => {
                  return (
                    <div key={opt.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderRadius: 14, border: '1px solid rgba(15,23,42,0.05)', background: '#f8fafc' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#475569', fontSize: 14 }}>
                          {opt.orden}
                        </div>
                        <div>
                          <span style={{ display: 'block', fontWeight: 600, color: '#1e293b', fontSize: 15 }}>
                            {formatFriendlyDate(opt.fecha, opt.hora_inicio)}
                          </span>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: '40%' }}>
                        {opt.available_count > 0 && <span style={{ background: '#dcfce7', color: '#166534', fontWeight: 600, fontSize: 12, padding: '2px 8px', borderRadius: 12 }}>Sí: {opt.available_count}</span>}
                        {opt.maybe_count > 0 && <span style={{ background: '#fef9c3', color: '#854d0e', fontWeight: 600, fontSize: 12, padding: '2px 8px', borderRadius: 12 }}>Tal vez: {opt.maybe_count}</span>}
                        {opt.unavailable_count > 0 && <span style={{ background: '#fee2e2', color: '#991b1b', fontWeight: 600, fontSize: 12, padding: '2px 8px', borderRadius: 12 }}>No: {opt.unavailable_count}</span>}
                        {opt.available_count === 0 && opt.maybe_count === 0 && opt.unavailable_count === 0 && <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>0 votos</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Card 3: Respuestas */}
            <div style={{ background: '#ffffff', borderRadius: 20, padding: '24px', border: '1px solid rgba(15,23,42,0.06)', boxShadow: '0 8px 24px rgba(15,23,42,0.06)' }}>
              <h3 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 20px 0', color: '#0f172a', paddingBottom: 16, borderBottom: '1px solid rgba(15,23,42,0.05)' }}>
                Respuestas
              </h3>

              {(!detail.participantes || detail.participantes.filter(p => p.respondio_disponibilidad).length === 0) ? (
                <div style={{ padding: '40px 20px', borderRadius: 16, border: '2px dashed rgba(15,23,42,0.1)', textAlign: 'center', backgroundColor: '#f8fafc', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                  <div style={{ background: '#F1F5F9', width: 48, height: 48, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Users size={24} color="#475569" />
                  </div>
                  <p style={{ margin: 0, fontSize: 15, color: '#64748b', fontWeight: 500 }}>
                    Todavía no recibiste disponibilidades.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {detail.participantes.filter(p => p.respondio_disponibilidad).map((part) => (
                    <div key={part.id} style={{ background: '#ffffff', borderRadius: 16, border: '1px solid #e2e8f0', boxShadow: '0 2px 8px rgba(15,23,42,0.04)', overflow: 'hidden' }}>
                      <div style={{ padding: '16px 20px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                        <span style={{ fontWeight: 800, color: '#0f172a', fontSize: 16 }}>
                          {part.nombre_invitado}
                        </span>
                      </div>
                      <div style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {part.respuestas.map((resp) => {
                          const option = opciones?.find(o => o.id === resp.opcion_fecha_id);
                          if (!option) return null;
                          return (
                            <div key={resp.opcion_fecha_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ color: '#475569', fontWeight: 600, fontSize: 14 }}>Opción {option.orden}</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                {resp.es_preferida && (
                                  <span style={{ background: '#fef3c7', color: '#d97706', fontWeight: 700, fontSize: 11, padding: '4px 8px', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                    ★ Preferida
                                  </span>
                                )}
                                <span style={{ fontWeight: 700, fontSize: 13, padding: '4px 10px', borderRadius: 12, backgroundColor: resp.respuesta === 'available' ? '#dcfce7' : resp.respuesta === 'maybe' ? '#fef9c3' : '#fee2e2', color: resp.respuesta === 'available' ? '#166534' : resp.respuesta === 'maybe' ? '#854d0e' : '#991b1b' }}>
                                  {resp.respuesta === 'available' ? 'Sí puedo' : resp.respuesta === 'maybe' ? 'Tal vez' : 'No puedo'}
                                </span>
                              </div>
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
      </div>

      <div style={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 480, padding: '20px 20px', background: 'rgba(255, 255, 255, 0.85)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', borderTop: '1px solid rgba(15,23,42,0.05)', boxShadow: '0 -4px 24px rgba(0,0,0,0.04)', paddingBottom: 'calc(20px + env(safe-area-inset-bottom))', zIndex: 10 }}>
        <Button
          variant="primary"
          fullWidth
          onClick={handleShare}
          disabled={isLinkGeneral && !shareUrl}
          aria-disabled={isLinkGeneral && !shareUrl}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 14, background: '#4f46e5', boxShadow: '0 4px 12px rgba(79, 70, 229, 0.25)' }}
        >
          {isLinkGeneral ? <Share2 size={20} /> : <Plus size={20} />}
          {isLinkGeneral ? 'Compartir link general' : 'Agregar invitados'}
        </Button>
      </div>
    </ScreenContainer>
  );
};

export default DetailHostCoordination;
