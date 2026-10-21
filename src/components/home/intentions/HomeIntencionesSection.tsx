import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../contexts/AuthContext';
import { useIntenciones } from '../../../hooks/useIntenciones';
import { openEncountersService } from '../../../services/openEncountersService';
import { preloadWizardFromIntencion } from '../../../lib/preloadWizardFromIntencion';
import type {
  Intencion,
  CrearIntencionPayload,
  EditarIntencionPayload,
} from '../../../types/intenciones';
import type { Localidad } from '../openEncounters/types';
import { IntencionCard } from './IntencionCard';
import { IntencionFormSheet } from './IntencionFormSheet';
import { LoginRequiredSheet } from '../../auth/LoginRequiredSheet';
import './HomeIntencionesSection.css';

export const PENDING_INTENTION_STORAGE_KEY = 'puntoencuentro_pending_intention';

function useSafeNavigate() {
  try {
    return useNavigate();
  } catch {
    return (to: string, _options?: any) => {
      if (typeof window !== 'undefined') window.location.href = to;
    };
  }
}

export interface HomeIntencionesSectionProps {
  onOpenCreateTrigger?: () => void;
  triggerCreateTimestamp?: number;
  isV2Variant?: boolean;
  initialLoading?: boolean;
  mockIntenciones?: Intencion[];
  onSaveSuccess?: () => void;
  /** Callback al pulsar 'Ver opciones' con los IDs de encuentros coincidentes */
  onViewMatches?: (matchedIds: string[]) => void;
}

export const HomeIntencionesSection: React.FC<HomeIntencionesSectionProps> = ({
  triggerCreateTimestamp,
  isV2Variant = false,
  initialLoading,
  mockIntenciones,
  onSaveSuccess,
  onViewMatches,
}) => {
  const { t } = useTranslation();
  const navigate = useSafeNavigate();
  const { user, signInWithGoogleForDiscovery } = useAuth();
  const {
    intenciones,
    loading,
    error,
    refresh,
    crearIntencion,
    editarIntencion,
    pausarIntencion,
    reactivarIntencion,
    cerrarIntencion,
  } = useIntenciones();

  const effectiveLoading = initialLoading !== undefined ? initialLoading : loading;

  const [localidades, setLocalidades] = useState<Localidad[]>([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingIntencion, setEditingIntencion] = useState<Intencion | null>(null);
  const [restoredDraft, setRestoredDraft] = useState<CrearIntencionPayload | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionInProgressId, setActionInProgressId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [matchFeedback, setMatchFeedback] = useState<{ count: number; encounterIds: string[] } | null>(null);
  const hasRestoredDraftRef = useRef(false);

  // Auth Guard Sheet
  const [isLoginSheetOpen, setIsLoginSheetOpen] = useState(false);
  const [isOAuthStarting, setIsOAuthStarting] = useState(false);

  // Cargar catálogo de localidades para el selector
  useEffect(() => {
    let mounted = true;
    openEncountersService.getLocalidades().then((locs) => {
      if (mounted) setLocalidades(locs);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const [formErrorMsg, setFormErrorMsg] = useState<string | null>(null);
  const autoSubmitLockRef = useRef(false);

  // ── RECUPERACIÓN / AUTO-SUBMIT TRAS OAUTH ──
  useEffect(() => {
    const isPermanent = Boolean(user && !user.is_anonymous);
    if (!isPermanent) return;

    // Evitar ejecuciones repetidas durante el mismo mount/render o renders concurrentes
    if (autoSubmitLockRef.current || hasRestoredDraftRef.current) return;

    if (typeof sessionStorage === 'undefined') return;

    const rawDraft = sessionStorage.getItem(PENDING_INTENTION_STORAGE_KEY);
    if (!rawDraft) return;

    try {
      const parsed = JSON.parse(rawDraft);
      if (!parsed) return;

      // Verificar si es un payload válido con título
      const cleanTitle = (parsed.titulo || '').trim();
      if (!cleanTitle) {
        sessionStorage.removeItem(PENDING_INTENTION_STORAGE_KEY);
        return;
      }

      // 1. CONSUMO SÍNCRONO ESTRICTO INMEDIATO:
      // Removemos de sessionStorage y activamos el lock síncrono ANTES de cualquier await.
      sessionStorage.removeItem(PENDING_INTENTION_STORAGE_KEY);
      hasRestoredDraftRef.current = true;
      autoSubmitLockRef.current = true;

      // Distinguir si fue un submit validado pendiente de autenticación
      const isValidatedSubmit = parsed.readyForAutoSubmit === true;
      const intentionPayload: CrearIntencionPayload = {
        titulo: cleanTitle,
        descripcion: parsed.descripcion || null,
        temporalidad_texto: parsed.temporalidad_texto || null,
        fecha_desde: parsed.fecha_desde || null,
        fecha_hasta: parsed.fecha_hasta || null,
        modalidad: parsed.modalidad || 'presencial',
        locality_id: parsed.locality_id || null,
      };

      if (isValidatedSubmit) {
        // Ejecutar creación automática sin requerir segundo click
        setIsSubmitting(true);
        crearIntencion(intentionPayload)
          .then((res) => {
            if (res.ok) {
              setRestoredDraft(null);
              setEditingIntencion(null);
              setFormErrorMsg(null);
              setIsFormOpen(false);
              onSaveSuccess?.();
            } else {
              // Si falla la creación, restaurar formulario visible con mensaje comprensible
              const errCode = res.error;
              let friendly = isV2Variant
                ? 'No pudimos guardar lo que tenés ganas de hacer. Podés revisar los datos e intentar de nuevo.'
                : 'No se pudo crear la intención. Podés intentar nuevamente.';
              if (errCode === 'rate_limit_exceeded') {
                friendly = 'Hiciste varias acciones en poco tiempo. Esperá un rato e intentá nuevamente.';
              } else if (errCode === 'rate_limit_unavailable') {
                friendly = isV2Variant
                  ? 'No pudimos guardar en este momento. Intentá nuevamente en unos minutos.'
                  : 'No pudimos crear la intención en este momento. Intentá nuevamente en unos minutos.';
              }
              setFormErrorMsg(friendly);
              setEditingIntencion(null);
              setRestoredDraft(intentionPayload);
              setIsFormOpen(true);
            }
          })
          .catch((err) => {
            console.error('[HomeIntencionesSection] Error en auto-submit:', err);
            setFormErrorMsg(
              isV2Variant
                ? 'Ocurrió un error al guardar lo que tenés ganas de hacer. Podés intentar de nuevo.'
                : 'Ocurrió un error al guardar la intención. Podés intentar nuevamente.'
            );
            setEditingIntencion(null);
            setRestoredDraft(intentionPayload);
            setIsFormOpen(true);
          })
          .finally(() => {
            setIsSubmitting(false);
            autoSubmitLockRef.current = false;
          });
      } else {
        // Si no era submit validado sino borrador editable, abrir formulario sin auto-submit
        setFormErrorMsg(null);
        setEditingIntencion(null);
        setRestoredDraft(intentionPayload);
        setIsFormOpen(true);
        autoSubmitLockRef.current = false;
      }
    } catch (err) {
      console.warn('[HomeIntencionesSection] Error recuperando pending draft:', err);
      autoSubmitLockRef.current = false;
    }
  }, [user?.id, user?.is_anonymous]);

  const handleOpenCreate = () => {
    setEditingIntencion(null);
    setRestoredDraft(null);
    setIsFormOpen(true);
  };

  // Disparador externo reutilizado (ej. banda Tengo ganas de...)
  useEffect(() => {
    if (triggerCreateTimestamp && triggerCreateTimestamp > 0) {
      handleOpenCreate();
    }
  }, [triggerCreateTimestamp]);

  const handleEdit = (intencion: Intencion) => {
    setRestoredDraft(null);
    setEditingIntencion(intencion);
    setIsFormOpen(true);
  };

  const handleOrganizar = (intencion: Intencion) => {
    preloadWizardFromIntencion(intencion);
    navigate('/create', { state: { seeded: true, fromIntention: true } });
  };

  const handlePausar = async (id: string) => {
    setActionInProgressId(id);
    try {
      await pausarIntencion(id);
    } finally {
      setActionInProgressId(null);
    }
  };

  const handleReactivar = async (id: string) => {
    setActionInProgressId(id);
    try {
      const res = await reactivarIntencion(id);
      if (res.ok && res.data?.matchesFoundCount && res.data.matchesFoundCount > 0) {
        setMatchFeedback({
          count: res.data.matchesFoundCount,
          encounterIds: res.data.matchedEncounterIds || [],
        });
      }
    } finally {
      setActionInProgressId(null);
    }
  };

  const handleCerrar = async (id: string) => {
    setActionInProgressId(id);
    try {
      await cerrarIntencion(id);
    } finally {
      setActionInProgressId(null);
    }
  };

  const handleSaveForm = async (
    payload: CrearIntencionPayload | EditarIntencionPayload
  ): Promise<boolean> => {
    const isPermanent = Boolean(user && !user.is_anonymous);

    // 1. Si no es usuario permanente: guardar submit validado con readyForAutoSubmit: true y abrir LoginRequiredSheet
    if (!isPermanent) {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(
          PENDING_INTENTION_STORAGE_KEY,
          JSON.stringify({
            ...payload,
            readyForAutoSubmit: true,
          })
        );
      }
      setIsFormOpen(false);
      setIsLoginSheetOpen(true);
      return false;
    }

    // 2. Si es permanente: persistir mediante useIntenciones
    setIsSubmitting(true);
    try {
      if ('id' in payload && payload.id) {
        const res = await editarIntencion(payload as EditarIntencionPayload);
        if (!res.ok) {
          const errCode = res.error;
          let friendly = isV2Variant
            ? 'No pudimos guardar lo que tenés ganas de hacer. Intentá nuevamente.'
            : 'No se pudo actualizar la intención. Intentá nuevamente.';
          if (errCode === 'rate_limit_exceeded') {
            friendly = 'Hiciste varias acciones en poco tiempo. Esperá un rato e intentá nuevamente.';
          } else if (errCode === 'rate_limit_unavailable') {
            friendly = isV2Variant
              ? 'No pudimos guardar en este momento. Intentá nuevamente en unos minutos.'
              : 'No pudimos actualizar la intención en este momento. Intentá nuevamente en unos minutos.';
          }
          throw new Error(friendly);
        }
      } else {
        const res = await crearIntencion(payload as CrearIntencionPayload);
        if (!res.ok) {
          const errCode = res.error;
          let friendly = isV2Variant
            ? 'No pudimos guardar lo que tenés ganas de hacer. Intentá nuevamente.'
            : 'No se pudo crear la intención. Intentá nuevamente.';
          if (errCode === 'rate_limit_exceeded') {
            friendly = 'Hiciste varias acciones en poco tiempo. Esperá un rato e intentá nuevamente.';
          } else if (errCode === 'rate_limit_unavailable') {
            friendly = isV2Variant
              ? 'No pudimos guardar en este momento. Intentá nuevamente en unos minutos.'
              : 'No pudimos crear la intención en este momento. Intentá nuevamente en unos minutos.';
          }
          throw new Error(friendly);
        } else if (res.data?.matchesFoundCount && res.data.matchesFoundCount > 0) {
          setMatchFeedback({
            count: res.data.matchesFoundCount,
            encounterIds: res.data.matchedEncounterIds || [],
          });
        }
      }

      // Si había algún draft en sessionStorage, limpiarlo
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(PENDING_INTENTION_STORAGE_KEY);
      }
      setRestoredDraft(null);
      setEditingIntencion(null);
      onSaveSuccess?.();
      return true;
    } catch (err: any) {
      console.error('[HomeIntencionesSection] Error saving intention:', err);
      throw err;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleContinueWithGoogle = async () => {
    setIsOAuthStarting(true);
    try {
      await signInWithGoogleForDiscovery();
    } catch (err) {
      console.error('[HomeIntencionesSection] Error en OAuth:', err);
    } finally {
      setIsOAuthStarting(false);
    }
  };

  const effectiveIntencionesList = mockIntenciones !== undefined ? mockIntenciones : intenciones;

  // Filtrar cerradas: sólo mostrar activas y pausadas
  const visibleIntenciones = effectiveIntencionesList.filter(
    (i) => i.estado === 'activa' || i.estado === 'pausada'
  );

  // En Home V2: limitar inicialmente a 3 elementos salvo que se expanda explícitamente
  const shouldLimit = isV2Variant && !isExpanded && visibleIntenciones.length > 3;
  const itemsToRender = shouldLimit ? visibleIntenciones.slice(0, 3) : visibleIntenciones;

  return (
    <section
      className={`pe-intenciones-section${isV2Variant ? ' pe-intenciones-section--v2' : ''}`}
      aria-label={isV2Variant ? t('your_encounters.tab_intentions_v2', { defaultValue: 'Mis ganas' }) : 'Sección de Intenciones'}
    >
      {/* Cabecera */}
      <div className="pe-intenciones-header">
        <div className="pe-intenciones-title-group">
          {!isV2Variant ? (
            <h2 className="pe-intenciones-title">Mis intenciones</h2>
          ) : (
            <h2 className="sr-only">{t('your_encounters.tab_intentions_v2', { defaultValue: 'Mis ganas' })}</h2>
          )}
          <p className="pe-intenciones-subtitle">
            {isV2Variant
              ? t('your_encounters.intentions_subtitle_v2', {
                  defaultValue: 'Lo que tenés ganas de hacer. Si aparece algo relacionado, te avisamos.',
                })
              : 'Cosas que tenés ganas de hacer, antes de organizar un encuentro.'}
          </p>
        </div>

        {(!isV2Variant || visibleIntenciones.length > 0) && (
          <button
            type="button"
            onClick={handleOpenCreate}
            className="pe-intenciones-add-btn"
            aria-label={
              isV2Variant
                ? t('your_encounters.intentions_cta_v2', { defaultValue: 'Tengo ganas de…' })
                : 'Expresar intención'
            }
          >
            <Plus size={16} aria-hidden="true" />
            <span>
              {isV2Variant
                ? t('your_encounters.intentions_cta_v2', { defaultValue: 'Tengo ganas de…' })
                : '+ Expresar intención'}
            </span>
          </button>
        )}
      </div>

      {/* Banner de Feedback Inmediato */}
      {matchFeedback && matchFeedback.count > 0 && (
        <div className="pe-intenciones-match-feedback" role="alert">
          <span className="pe-intenciones-match-feedback-text">
            {t('your_encounters.intentions_matches_found', {
              count: matchFeedback.count,
              defaultValue: `Encontramos ${matchFeedback.count} ${matchFeedback.count === 1 ? 'opción relacionada' : 'opciones relacionadas'}.`,
            })}
          </span>
          <div className="pe-intenciones-match-feedback-actions">
            <button
              type="button"
              className="pe-intenciones-match-feedback-cta"
              onClick={() => {
                const matchedIds = matchFeedback?.encounterIds || [];
                if (onViewMatches && matchedIds.length > 0) {
                  onViewMatches(matchedIds);
                } else {
                  const discoveryEl = document.getElementById('home-discovery-section');
                  if (discoveryEl) {
                    const prefersReducedMotion =
                      typeof window !== 'undefined' &&
                      window.matchMedia &&
                      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                    discoveryEl.scrollIntoView({
                      behavior: prefersReducedMotion ? 'auto' : 'smooth',
                      block: 'start',
                    });
                  }
                }
                setMatchFeedback(null);
              }}
            >
              {t('your_encounters.intentions_matches_cta', { defaultValue: 'Ver opciones' })}
            </button>
            <button
              type="button"
              className="pe-intenciones-match-feedback-close"
              onClick={() => setMatchFeedback(null)}
              aria-label="Cerrar aviso"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Estados */}
      {effectiveLoading ? (
        <div className="pe-intenciones-loading">
          <p className="pe-intenciones-loading-text">
            {isV2Variant
              ? t('your_encounters.intentions_loading_v2', { defaultValue: 'Cargando tus ganas…' })
              : 'Cargando tus intenciones…'}
          </p>
        </div>
      ) : error ? (
        <div className="pe-intenciones-error">
          <p className="pe-intenciones-error-text">{error}</p>
          <button
            type="button"
            onClick={refresh}
            className="pe-intenciones-retry-btn"
          >
            Reintentar
          </button>
        </div>
      ) : visibleIntenciones.length === 0 ? (
        <div className="pe-intenciones-empty">
          <div className="pe-intenciones-empty__icon" aria-hidden="true">
            <Sparkles size={28} />
          </div>
          <h3 className="pe-intenciones-empty__title">
            {isV2Variant
              ? t('your_encounters.intentions_empty_title_v2', {
                  defaultValue: 'Todavía no contaste qué tenés ganas de hacer',
                })
              : 'Todavía no expresaste intenciones'}
          </h3>
          <p className="pe-intenciones-empty__desc">
            {isV2Variant
              ? t('your_encounters.intentions_empty_desc_v2', {
                  defaultValue: 'Decí qué te gustaría hacer y guardalo para más adelante.',
                })
              : '¿Tenés ganas de hacer algo pero todavía no armaste un encuentro? Expresá tu intención para recordarla o coordinar con otros más adelante.'}
          </p>
          <button
            type="button"
            onClick={handleOpenCreate}
            className="pe-intenciones-add-btn"
            style={{ margin: '0 auto' }}
            aria-label={
              isV2Variant
                ? t('your_encounters.intentions_empty_cta_v2', { defaultValue: 'Tengo ganas de…' })
                : 'Expresar intención'
            }
          >
            {isV2Variant && <Plus size={16} aria-hidden="true" />}
            <span>
              {isV2Variant
                ? t('your_encounters.intentions_empty_cta_v2', { defaultValue: 'Tengo ganas de…' })
                : '+ Expresar intención'}
            </span>
          </button>
        </div>
      ) : (
        <>
          <div
            className={`pe-intenciones-list${isV2Variant ? ' pe-intenciones-list--v2' : ''}`}
            role="region"
            aria-label={t('your_encounters.tab_intentions_v2', { defaultValue: 'Mis ganas' })}
          >
            {itemsToRender.map((intencion) => (
              <IntencionCard
                key={intencion.id}
                intencion={intencion}
                onEdit={handleEdit}
                onPausar={handlePausar}
                onReactivar={handleReactivar}
                onCerrar={handleCerrar}
                onOrganizar={handleOrganizar}
                disabled={actionInProgressId === intencion.id}
                isV2Variant={isV2Variant}
              />
            ))}
          </div>

          {isV2Variant && visibleIntenciones.length > 3 && (
            <div className="pe-intenciones-footer-actions">
              <button
                type="button"
                className="pe-intenciones-expand-btn"
                onClick={() => setIsExpanded((prev) => !prev)}
              >
                {isExpanded
                  ? t('your_encounters.intentions_show_less_v2', { defaultValue: 'Mostrar menos' })
                  : t('your_encounters.intentions_view_all_v2', {
                      count: visibleIntenciones.length,
                      defaultValue: `Ver todas mis ganas (${visibleIntenciones.length})`,
                    })}
              </button>
            </div>
          )}
        </>
      )}

      {/* Form Sheet: Crear / Editar */}
      <IntencionFormSheet
        isOpen={isFormOpen}
        onClose={() => {
          setIsFormOpen(false);
          setEditingIntencion(null);
          setRestoredDraft(null);
          setFormErrorMsg(null);
        }}
        onSave={handleSaveForm}
        initialData={editingIntencion || restoredDraft}
        localidades={localidades}
        isEditing={Boolean(editingIntencion)}
        isSubmitting={isSubmitting}
        isV2Variant={isV2Variant}
        initialErrorMsg={formErrorMsg}
      />

      {/* Auth Guard Sheet */}
      <LoginRequiredSheet
        isOpen={isLoginSheetOpen}
        onClose={() => {
          setIsLoginSheetOpen(false);
          if (typeof sessionStorage !== 'undefined') {
            sessionStorage.removeItem(PENDING_INTENTION_STORAGE_KEY);
          }
        }}
        onContinueWithGoogle={handleContinueWithGoogle}
        loading={isOAuthStarting}
        action="create_intention"
      />
    </section>
  );
};
