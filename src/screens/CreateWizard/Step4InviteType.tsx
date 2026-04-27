import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWizardStore } from '@/store/wizardStore';
import { encuentrosService } from '@/services/encuentrosService';
import { getHostId } from '@/lib/auth';

const optionCard = (selected: boolean, disabled: boolean): React.CSSProperties => ({
  background: selected ? 'var(--color-primary-container)' : '#fff',
  border: selected ? '2px solid var(--color-primary)' : '1.5px solid var(--color-outline-variant)',
  borderRadius: 16,
  padding: '18px 20px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled && !selected ? 0.5 : 1,
  transition: 'all 0.18s ease',
  boxShadow: selected ? '0 0 0 3px rgba(26, 86, 240, 0.1)' : '0 2px 6px rgba(0,0,0,0.04)',
});

const Step4InviteType: React.FC = () => {
  const { setField, ...wizardData } = useWizardStore();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const handleFinish = async (tipo: 'individual' | 'link_general') => {
    try {
      setLoading(true);
      const hostId = getHostId();
      const newEncuentro = await encuentrosService.createEncuentro({
        titulo: wizardData.titulo,
        descripcion: wizardData.descripcion,
        fecha: wizardData.fecha,
        hora: wizardData.hora,
        modalidad: wizardData.modalidad as 'presencial' | 'virtual',
        lugar_texto: wizardData.lugar_texto,
        link_virtual: wizardData.link_virtual,
        tipo_invitacion: tipo,
        host_id: hostId
      });
      if (tipo === 'individual') {
        navigate(`/add-guests/${newEncuentro.id}`);
      } else {
        navigate(`/share/${newEncuentro.id}`);
      }
    } catch (error) {
      console.error(error);
      alert('Hubo un error al crear el encuentro');
    } finally { setLoading(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 0 }}>
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>¿Cómo querés invitar?</h2>
        <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)' }}>Elegí cómo van a sumarse al encuentro.</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div
          style={optionCard(false, loading)}
          onClick={() => { if (!loading) { setField('tipo_invitacion', 'individual'); handleFinish('individual'); } }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>👤</div>
          <h4 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Personas específicas</h4>
          <p style={{ margin: 0, fontSize: 14 }}>Invitás a cada uno individualmente</p>
        </div>

        <div
          style={optionCard(false, loading)}
          onClick={() => { if (!loading) { setField('tipo_invitacion', 'link_general'); handleFinish('link_general'); } }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>🔗</div>
          <h4 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Compartir link</h4>
          <p style={{ margin: 0, fontSize: 14 }}>Cualquiera con el link puede sumarse</p>
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', marginTop: 24, color: 'var(--color-primary)', fontSize: 15, fontWeight: 600 }}>
          Creando encuentro…
        </div>
      )}
    </div>
  );
};

export default Step4InviteType;
