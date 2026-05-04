import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWizardStore } from '@/store/wizardStore';
import { encuentrosService } from '@/services/encuentrosService';
import { getHostId } from '@/lib/auth';
import { validateEncounterDate } from '@/lib/formatDate';

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
  const [error, setError] = useState<string | null>(null);

  const handleFinish = async (tipoOverride?: 'individual' | 'link_general') => {
    if (loading) return;
    const tipo: 'individual' | 'link_general' = tipoOverride || wizardData.tipo_invitacion as 'individual' | 'link_general';
    if (!tipo) {
      setError('Elegí un tipo de invitación');
      return;
    }
    const validationError = validateEncounterDate(wizardData.fecha, wizardData.hora);
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      setLoading(true);
      const hostId = getHostId();
      const payload = {
        titulo: wizardData.titulo,
        descripcion: wizardData.descripcion,
        fecha: wizardData.fecha,
        hora: wizardData.hora,
        modalidad: wizardData.modalidad as 'presencial' | 'virtual',
        lugar_texto: wizardData.lugar_texto,
        link_virtual: wizardData.link_virtual,
        tipo_invitacion: tipo,
        host_id: hostId,
        tema: wizardData.tema || 'blue',
        reemplaza_a: (() => {
          const refStr = sessionStorage.getItem('cancel_reference');
          if (refStr) {
            try {
              const ref = JSON.parse(refStr);
              return ref.oldId || ref.fromId || null;
            } catch (e) { return null; }
          }
          return null;
        })(),
      };

      console.log('[CREATE PAYLOAD]', payload);
      const newEncuentro = await encuentrosService.createEncuentro(payload);
      const cancelRefStr = sessionStorage.getItem('cancel_reference');
      if (cancelRefStr) {
        try {
          const ref = JSON.parse(cancelRefStr);
          ref.newId = newEncuentro.id;
          sessionStorage.setItem('cancel_reference', JSON.stringify(ref));
        } catch (e) { console.error('Error updating cancel_reference', e); }
      }

      if (tipo === 'individual') {
        navigate(`/add-guests/${newEncuentro.id}`);
      } else {
        navigate(`/share/${newEncuentro.id}`);
      }
    } catch (error: any) {
      console.error('[CREATE ERROR FULL]', error);
      alert(error?.message || JSON.stringify(error));
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
          style={optionCard(wizardData.tipo_invitacion === 'individual', loading)}
          onClick={async () => {
            if (loading) return;
            setField('tipo_invitacion', 'individual');
            setError(null);
            await handleFinish('individual');
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>👤</div>
          <h4 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Personas específicas</h4>
          <p style={{ margin: 0, fontSize: 14 }}>Invitás a cada uno individualmente</p>
        </div>

        <div
          style={optionCard(wizardData.tipo_invitacion === 'link_general', loading)}
          onClick={async () => {
            if (loading) return;
            setField('tipo_invitacion', 'link_general');
            setError(null);
            await handleFinish('link_general');
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>🔗</div>
          <h4 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Compartir link</h4>
          <p style={{ margin: 0, fontSize: 14 }}>Cualquiera con el link puede sumarse</p>
        </div>
      </div>
      
      {error && (
        <div style={{ 
          marginTop: 20,
          background: 'var(--color-error-container, #fee2e2)', 
          color: 'var(--color-error, #dc2626)', 
          padding: '12px 16px', 
          borderRadius: 14, 
          fontSize: 13, 
          fontWeight: 600,
          textAlign: 'center',
          border: '1px solid var(--color-error, #dc2626)'
        }}>
          {error}
          <div style={{ marginTop: 8, fontSize: 12, textDecoration: 'underline', cursor: 'pointer' }} onClick={() => setField('step', 1)}>
            Volver a corregir fecha y hora
          </div>
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', marginTop: 24, color: 'var(--color-primary)', fontSize: 15, fontWeight: 600 }}>
          Creando encuentro…
        </div>
      )}
    </div>
  );
};

export default Step4InviteType;
