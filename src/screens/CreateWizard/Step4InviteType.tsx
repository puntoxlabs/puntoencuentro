import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWizardStore } from '@/store/wizardStore';
import { encuentrosService } from '@/services/encuentrosService';
import { Button } from '@/components/ui/Button';
import type { InvitationTheme } from '@/lib/invitationThemes';
import { resolveInvitationTemplateForTheme } from '@/lib/invitationThemes';
import { supabase } from '@/lib/supabase';
import { rememberEncuentroHost } from '@/lib/meetHostsStorage';
import { validateEncounterDate } from '@/lib/formatDate';
import { intencionesService } from '@/services/intencionesService';
import '../CreateWizard.css';

interface Step4Props {
  onFinish?: (encuentroId: string) => void;
}

const Step4InviteType: React.FC<Step4Props> = () => {
  const { setField, ...wizardData } = useWizardStore();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Estados locales para manejo seguro de fallo y reintento de vinculación (Fase 2.0-A)
  const [linkingError, setLinkingError] = useState<string | null>(null);
  const [retryingLink, setRetryingLink] = useState(false);
  const [createdEncuentroId, setCreatedEncuentroId] = useState<string | null>(null);
  const [resolvedTipo, setResolvedTipo] = useState<'individual' | 'link_general' | null>(null);

  const hasInitialValue = !!wizardData.tipo_invitacion;

  const handleFinish = async (tipoOverride?: 'individual' | 'link_general') => {
    if (loading || retryingLink || !!linkingError) return;
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
      setError(null);
      setLinkingError(null);

      let hostId: string;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user) {
          setError('No encontramos una sesión activa. Elegí cómo continuar para poder guardar el encuentro.');
          setLoading(false);
          return;
        }
        hostId = session.user.id;
      } catch (err) {
        console.error('Error getting session in submit:', err);
        setError('No pudimos crear el encuentro. Revisá tu conexión e intentá nuevamente.');
        setLoading(false);
        return;
      }

      let encuentroId = createdEncuentroId || wizardData.encuentro_id;

      if (!encuentroId) {
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
          invitation_template: resolveInvitationTemplateForTheme(
            wizardData.tema_invitacion,
            wizardData.invitation_template
          ),
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
        setCreatedEncuentroId(encuentroId);

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
          invitation_template: resolveInvitationTemplateForTheme(
            wizardData.tema_invitacion,
            wizardData.invitation_template
          ),
        }, hostId);
      }

      setResolvedTipo(tipo);

      // Bloque 4/5: Vincular intención si el encuentro se originó desde una intención
      let linkFailed = false;
      if (wizardData.sourceIntentionId && encuentroId) {
        try {
          const convRes = await intencionesService.convertirIntencionAEncuentro(
            wizardData.sourceIntentionId,
            encuentroId
          );
          if (convRes.ok) {
            setField('sourceIntentionId', null);
          } else {
            console.warn('[CONVERSION WARNING] No se pudo vincular la intención:', convRes.error);
            linkFailed = true;
          }
        } catch (convErr) {
          console.warn('[CONVERSION ERROR]', convErr);
          linkFailed = true;
        }
      }

      // Si falló la vinculación, NO navegar automáticamente: mantener contexto y mostrar UI de recuperación
      if (linkFailed) {
        setLinkingError('El encuentro se creó correctamente, pero no pudimos vincularlo con tu intención.');
        return;
      }

      if (tipo === 'individual') {
        navigate(`/add-guests/${encuentroId}`, { replace: true });
      } else {
        navigate(`/share/${encuentroId}`, { replace: true });
      }

      import('@/services/qaTelemetryService').then(({ qaTelemetryService }) => {
        qaTelemetryService.trackEvent({
          event_type: 'encounter_created',
          source: 'ui_manual',
          creation_source: 'manual',
          encounter_id: encuentroId ?? undefined,
          status: 'completed',
        });
      });
    } catch (error: any) {
      console.error('[CREATE ERROR FULL]', error);
      const errorCode = error?.code || error?.message;
      let friendlyError = 'No pudimos crear el encuentro. Revisá tu conexión e intentá nuevamente.';
      if (errorCode === 'rate_limit_exceeded') {
        friendlyError = 'Hiciste varias acciones en poco tiempo. Esperá un rato e intentá nuevamente.';
      } else if (errorCode === 'rate_limit_unavailable') {
        friendlyError = 'No pudimos crear el encuentro en este momento. Intentá nuevamente en unos minutos.';
      } else if (error?.message && typeof error.message === 'string' && !error.message.includes('{') && !error.message.includes('create_failed')) {
        friendlyError = error.message;
      }
      setError(friendlyError);
      import('@/services/qaTelemetryService').then(({ qaTelemetryService }) => {
        qaTelemetryService.trackEvent({
          event_type: 'technical_error',
          source: 'ui_manual',
          creation_source: 'manual',
          status: 'started',
          metadata: { error_code: errorCode || 'create_failed' }
        });
      });
    } finally { setLoading(false); }
  };

  const handleRetryLinking = async () => {
    if (retryingLink || loading) return;
    const targetEncuentroId = createdEncuentroId || wizardData.encuentro_id;
    const sourceId = wizardData.sourceIntentionId;
    const tipo = resolvedTipo || (wizardData.tipo_invitacion as 'individual' | 'link_general') || 'link_general';

    if (!targetEncuentroId || !sourceId) {
      handleContinueAnyway();
      return;
    }

    try {
      setRetryingLink(true);
      const convRes = await intencionesService.convertirIntencionAEncuentro(
        sourceId,
        targetEncuentroId
      );

      if (convRes.ok) {
        setField('sourceIntentionId', null);
        setLinkingError(null);

        if (tipo === 'individual') {
          navigate(`/add-guests/${targetEncuentroId}`, { replace: true });
        } else {
          navigate(`/share/${targetEncuentroId}`, { replace: true });
        }
      } else {
        console.warn('[RETRY CONVERSION WARNING] Falló reintento:', convRes.error);
        setLinkingError('El encuentro se creó correctamente, pero no pudimos vincularlo con tu intención.');
      }
    } catch (err: any) {
      console.warn('[RETRY CONVERSION ERROR]', err);
      setLinkingError('El encuentro se creó correctamente, pero no pudimos vincularlo con tu intención.');
    } finally {
      setRetryingLink(false);
    }
  };

  const handleContinueAnyway = () => {
    const targetEncuentroId = createdEncuentroId || wizardData.encuentro_id;
    const tipo = resolvedTipo || (wizardData.tipo_invitacion as 'individual' | 'link_general') || 'link_general';

    // Limpiar sourceIntentionId explícitamente para evitar contaminar futuras creaciones
    setField('sourceIntentionId', null);
    setLinkingError(null);

    if (tipo === 'individual') {
      navigate(`/add-guests/${targetEncuentroId}`, { replace: true });
    } else {
      navigate(`/share/${targetEncuentroId}`, { replace: true });
    }
  };

  return (
    <div className="cw-container">
      <div className="cw-step-header cw-step-header--padded">
        <h2 className="cw-step-title">¿Cómo querés invitar?</h2>
        <p className="cw-step-subtitle">Elegí cómo van a sumarse al encuentro.</p>
      </div>

      <div className="cw-options-grid">
        <div
          className={`cw-option-card ${wizardData.tipo_invitacion === 'link_general' ? 'cw-option-card--selected' : ''} ${loading || retryingLink || !!linkingError || !!wizardData.encuentro_id ? 'cw-option-card--disabled' : ''}`}
          onClick={async () => {
            if (loading || retryingLink || !!linkingError || !!wizardData.encuentro_id) return;
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
          className={`cw-option-card ${wizardData.tipo_invitacion === 'individual' ? 'cw-option-card--selected' : ''} ${loading || retryingLink || !!linkingError || !!wizardData.encuentro_id ? 'cw-option-card--disabled' : ''}`}
          onClick={async () => {
            if (loading || retryingLink || !!linkingError || !!wizardData.encuentro_id) return;
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

      {hasInitialValue && !linkingError && (
        <div className="cw-bottom-actions">
          <Button
            fullWidth
            disabled={loading || retryingLink}
            onClick={async () => {
              if (loading || retryingLink) return;
              setError(null);
              await handleFinish();
            }}
          >
            Continuar
          </Button>
        </div>
      )}

      {linkingError && (
        <div className="cw-bottom-actions" style={{ marginTop: 16 }}>
          <div className="cw-error-banner" role="alert" style={{ textAlign: 'center' }}>
            <p style={{ margin: '0 0 12px 0', fontWeight: 600 }}>
              {linkingError}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Button
                fullWidth
                disabled={retryingLink}
                onClick={handleRetryLinking}
              >
                {retryingLink ? 'Reintentando vinculación…' : 'Reintentar vinculación'}
              </Button>
              <Button
                fullWidth
                variant="secondary"
                disabled={retryingLink}
                onClick={handleContinueAnyway}
              >
                Continuar de todos modos
              </Button>
            </div>
          </div>
        </div>
      )}

      {error && !linkingError && (
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
