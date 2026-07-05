import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWizardStore } from '@/store/wizardStore';
import { encuentrosService } from '@/services/encuentrosService';
import { Button } from '@/components/ui/Button';
import type { InvitationTheme } from '@/lib/invitationThemes';
import { getHostId } from '@/lib/auth';
import { rememberEncuentroHost } from '@/lib/meetHostsStorage';
import { useAuth } from '@/contexts/AuthContext';
import { validateEncounterDate } from '@/lib/formatDate';
import '../CreateWizard.css';

interface Step4Props {
  onFinish?: (encuentroId: string) => void;
}

const Step4InviteType: React.FC<Step4Props> = () => {
  const { setField, ...wizardData } = useWizardStore();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasInitialValue = !!wizardData.tipo_invitacion;

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
      
      let encuentroId = wizardData.encuentro_id;

      if (!encuentroId) {
        // Si está logueado → user.id (UUID de Supabase Auth).
        // Si es anónimo  → UUID local del dispositivo (sin FK en host_id).
        const hostId = user?.id ?? getHostId();
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
          tema_invitacion: (wizardData.tema_invitacion as InvitationTheme) || 'classic',
          invitation_template: wizardData.invitation_template || null,
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

        if (import.meta.env.DEV) console.log('[CREATE PAYLOAD]', payload);
        const newEncuentro = await encuentrosService.createEncuentro(payload);
        encuentroId = newEncuentro.id;
        setField('encuentro_id', encuentroId);

        // Persistir mapeo encuentroId → hostId antes de navegar.
        // Esto permite que DetailHost resuelva hostId al refrescar /meet/:id
        // sin necesidad de pasar por Home primero.
        rememberEncuentroHost(encuentroId!, hostId!);
        if (import.meta.env.DEV) console.log('[CREATE] Mapeado', encuentroId, '→', hostId);

        const cancelRefStr = sessionStorage.getItem('cancel_reference');
        if (cancelRefStr) {
          try {
            const ref = JSON.parse(cancelRefStr);
            ref.newId = newEncuentro.id;
            sessionStorage.setItem('cancel_reference', JSON.stringify(ref));
          } catch (e) { console.error('Error updating cancel_reference', e); }
        }
      } else {
        if (import.meta.env.DEV) console.log('[REUSING ENCUENTRO]', encuentroId);
        // Actualizamos por si cambió algo en pasos previos (título, fecha, etc.)
        const hostId = user?.id ?? getHostId();
        await encuentrosService.updateEncuentro(encuentroId, {
          titulo: wizardData.titulo,
          descripcion: wizardData.descripcion,
          fecha: wizardData.fecha,
          hora: wizardData.hora,
          modalidad: wizardData.modalidad as 'presencial' | 'virtual',
          lugar_texto: wizardData.lugar_texto,
          link_virtual: wizardData.link_virtual,
          tipo_invitacion: tipo,
          tema: wizardData.tema || 'blue',
          tema_invitacion: (wizardData.tema_invitacion as InvitationTheme) || 'classic',
          invitation_template: wizardData.invitation_template || null,
        }, hostId);
      }

      if (tipo === 'individual') {
        navigate(`/add-guests/${encuentroId}`, { replace: true });
      } else {
        navigate(`/share/${encuentroId}`, { replace: true });
      }
    } catch (error: any) {
      console.error('[CREATE ERROR FULL]', error);
      alert(error?.message || JSON.stringify(error));
    } finally { setLoading(false); }
  };

  return (
    <div className="cw-container">
      <div className="cw-step-header cw-step-header--padded">
        <h2 className="cw-step-title">¿Cómo querés invitar?</h2>
        <p className="cw-step-subtitle">Elegí cómo van a sumarse al encuentro.</p>
      </div>

      <div className="cw-options-grid">
        <div
          className={`cw-option-card ${wizardData.tipo_invitacion === 'link_general' ? 'cw-option-card--selected' : ''} ${loading || !!wizardData.encuentro_id ? 'cw-option-card--disabled' : ''}`}
          onClick={async () => {
            if (loading || !!wizardData.encuentro_id) return;
            setField('tipo_invitacion', 'link_general');
            setError(null);
            await handleFinish('link_general');
          }}
        >
          <div className="cw-option-icon">🔗</div>
          <h4 className="cw-option-title">Invitación grupal</h4>
          <p className="cw-option-desc">Un único enlace para que cualquiera pueda sumarse.</p>
        </div>

        <div
          className={`cw-option-card ${wizardData.tipo_invitacion === 'individual' ? 'cw-option-card--selected' : ''} ${loading || !!wizardData.encuentro_id ? 'cw-option-card--disabled' : ''}`}
          onClick={async () => {
            if (loading || !!wizardData.encuentro_id) return;
            setField('tipo_invitacion', 'individual');
            setError(null);
            await handleFinish('individual');
          }}
        >
          <div className="cw-option-icon">👤</div>
          <h4 className="cw-option-title">Invitación individual</h4>
          <p className="cw-option-desc">Una invitación separada para cada persona.</p>
        </div>
      </div>



      {hasInitialValue && (
        <div className="cw-bottom-actions">
          <Button 
            fullWidth 
            disabled={loading}
            onClick={async () => {
              if (loading) return;
              setError(null);
              await handleFinish();
            }}
          >
            Continuar
          </Button>
        </div>
      )}
      
      {error && (
        <div className="cw-bottom-actions">
          <div className="cw-error-banner">
            {error}
            <div style={{ marginTop: 8, fontSize: 12, textDecoration: 'underline', cursor: 'pointer' }} onClick={() => setField('step', 1)}>
              Volver a corregir fecha y hora
            </div>
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
