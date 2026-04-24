import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useWizardStore } from '@/store/wizardStore';
import { encuentrosService } from '@/services/encuentrosService';
import { getHostId } from '@/lib/auth';

const Step4InviteType: React.FC = () => {
  const { tipo_invitacion, setField, ...wizardData } = useWizardStore();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  
  const isValid = tipo_invitacion !== null;

  const handleFinish = async () => {
    if (!isValid) return;

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
        tipo_invitacion: tipo_invitacion as 'individual' | 'link_general',
        host_id: hostId
      });

      // Redirigir fuera del wizard según el tipo de invitación
      if (tipo_invitacion === 'individual') {
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
          onClick={() => setField('tipo_invitacion', 'individual')}
          style={{ border: tipo_invitacion === 'individual' ? '2px solid var(--color-primary)' : '1px solid var(--color-outline-variant)' }}
        >
          <h4 style={{ marginBottom: '4px' }}>Invitar personas específicas</h4>
          <p style={{ margin: 0 }}>Agrega nombres a una lista cerrada</p>
        </Card>

        <Card 
          onClick={() => setField('tipo_invitacion', 'link_general')}
          style={{ border: tipo_invitacion === 'link_general' ? '2px solid var(--color-primary)' : '1px solid var(--color-outline-variant)' }}
        >
          <h4 style={{ marginBottom: '4px' }}>Compartir link</h4>
          <p style={{ margin: 0 }}>Un link para que cualquiera pueda sumarse</p>
        </Card>
      </div>
      <Button fullWidth onClick={handleFinish} disabled={!isValid || loading}>
        {loading ? 'Creando...' : 'Finalizar y Crear'}
      </Button>
    </div>
  );
};
export default Step4InviteType;
