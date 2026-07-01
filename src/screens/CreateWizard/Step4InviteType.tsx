import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, Palette } from 'lucide-react';
import { useWizardStore } from '@/store/wizardStore';
import { encuentrosService } from '@/services/encuentrosService';
import { getHostId } from '@/lib/auth';
import { rememberEncuentroHost } from '@/lib/meetHostsStorage';
import { useAuth } from '@/contexts/AuthContext';
import { validateEncounterDate } from '@/lib/formatDate';
import { Button } from '@/components/ui/Button';
import { InvitationPreviewModal } from '@/components/ui/InvitationPreviewModal';
import type { InvitationTheme } from '@/lib/invitationThemes';

const Step4InviteType: React.FC = () => {
  const { setField, ...wizardData } = useWizardStore();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const [hasInitialValue] = useState(!!wizardData.tipo_invitacion);

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
          <h4 className="cw-option-title">Compartir link</h4>
          <p className="cw-option-desc">Cualquiera con el link puede sumarse</p>
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
          <h4 className="cw-option-title">Personas específicas</h4>
          <p className="cw-option-desc">Invitás a cada uno individualmente</p>
        </div>
      </div>

      <div className="cw-preview-section" style={{ marginTop: 24, padding: '20px', background: 'var(--color-surface-variant)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-outline-variant)' }}>
        <h4 style={{ margin: '0 0 8px 0', fontSize: 15, fontWeight: 700, color: 'var(--color-on-surface)' }}>Vista previa de la invitación</h4>
        <p style={{ margin: '0 0 20px 0', fontSize: 13, color: 'var(--color-on-surface-variant)', lineHeight: 1.5 }}>
          Revisá cómo la verán tus invitados antes de compartirla.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Button variant="primary" fullWidth onClick={() => setShowPreview(true)} style={{ height: 48, fontSize: 15, fontWeight: 700 }}>
            <Eye size={18} style={{ marginRight: 8 }} />
            Previsualizar invitación
          </Button>
          <Button variant="outline" fullWidth onClick={() => setField('step', 1)} style={{ height: 44, fontSize: 14, fontWeight: 600 }}>
            <Palette size={18} style={{ marginRight: 8 }} />
            Cambiar estilo
          </Button>
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

      {showPreview && (
        <InvitationPreviewModal 
          onClose={() => setShowPreview(false)}
          onChangeStyle={() => {
            setShowPreview(false);
            setField('step', 1);
          }}
        />
      )}
    </div>
  );
};

export default Step4InviteType;
