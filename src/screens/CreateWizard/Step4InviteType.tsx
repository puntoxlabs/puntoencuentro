import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Card } from '@/components/ui/Card';
import { useWizardStore } from '@/store/wizardStore';
import { encuentrosService } from '@/services/encuentrosService';
import { getHostId } from '@/lib/auth';

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

      // Redirigir fuera del wizard según el tipo de invitación
      if (tipo === 'individual') {
        navigate(`/add-guests/${newEncuentro.id}`);
      } else {
        navigate(`/share/${newEncuentro.id}`);
      }
    } catch (error) {
      console.error(error);
      alert('Hubo un error al crear el encuentro');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: '16px' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 600 }}>¿Cómo quieres invitar?</h3>
        
        <Card 
          onClick={() => {
            setField('tipo_invitacion', 'individual');
            handleFinish('individual');
          }}
          style={{ 
            border: '1px solid var(--color-outline-variant)',
            opacity: loading ? 0.6 : 1,
            pointerEvents: loading ? 'none' : 'auto'
          }}
        >
          <h4 style={{ marginBottom: '4px' }}>Invitar personas específicas</h4>
          <p style={{ margin: 0 }}>Agrega nombres a una lista cerrada</p>
        </Card>

        <Card 
          onClick={() => {
            setField('tipo_invitacion', 'link_general');
            handleFinish('link_general');
          }}
          style={{ 
            border: '1px solid var(--color-outline-variant)',
            opacity: loading ? 0.6 : 1,
            pointerEvents: loading ? 'none' : 'auto'
          }}
        >
          <h4 style={{ marginBottom: '4px' }}>Compartir link</h4>
          <p style={{ margin: 0 }}>Un link para que cualquiera pueda sumarse</p>
        </Card>
      </div>
      {loading && (
        <div style={{ textAlign: 'center', marginTop: '16px', color: 'var(--color-primary)' }}>
          Creando encuentro...
        </div>
      )}
    </div>
  );
};
export default Step4InviteType;
