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
    return (to: string) => {
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
}

export const HomeIntencionesSection: React.FC<HomeIntencionesSectionProps> = ({
  triggerCreateTimestamp,
  isV2Variant = false,
  initialLoading,
  mockIntenciones,
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

  // ── RECUPERACIÓN DE DRAFT PENDIENTE TRAS OAUTH ──
  useEffect(() => {
    const isPermanent = Boolean(user && !user.is_anonymous);
    if (!isPermanent) return;

    // Evitar restauraciones repetidas durante el mismo mount/render
    if (hasRestoredDraftRef.current) return;

    if (typeof sessionStorage === 'undefined') return;

    const rawDraft = sessionStorage.getItem(PENDING_INTENTION_STORAGE_KEY);
    if (!rawDraft) return;

    try {
      const parsed = JSON.parse(rawDraft) as CrearIntencionPayload;
      if (parsed && typeof parsed.titulo === 'string') {
        hasRestoredDraftRef.current = true;
        setEditingIntencion(null);
        setRestoredDraft(parsed);
        setIsFormOpen(true);
      }
    } catch (err) {
      console.warn('[HomeIntencionesSection] Error recuperando pending draft:', err);
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
    navigate('/create');
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
      await reactivarIntencion(id);
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

    // 1. Si no es usuario permanente: guardar draft en sessionStorage y abrir LoginRequiredSheet
    if (!isPermanent) {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(PENDING_INTENTION_STORAGE_KEY, JSON.stringify(payload));
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
        }
      }

      // Si había algún draft en sessionStorage, limpiarlo
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(PENDING_INTENTION_STORAGE_KEY);
      }
      setRestoredDraft(null);
      setEditingIntencion(null);
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

  return (
    <section
      className="pe-intenciones-section"
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
                  defaultValue: 'Cosas que tenés ganas de hacer, antes de organizar un encuentro.',
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
        <div className="pe-intenciones-list">
          {visibleIntenciones.map((intencion) => (
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
      )}

      {/* Form Sheet: Crear / Editar */}
      <IntencionFormSheet
        isOpen={isFormOpen}
        onClose={() => {
          setIsFormOpen(false);
          setEditingIntencion(null);
          setRestoredDraft(null);
        }}
        onSave={handleSaveForm}
        initialData={editingIntencion || restoredDraft}
        localidades={localidades}
        isEditing={Boolean(editingIntencion)}
        isSubmitting={isSubmitting}
        isV2Variant={isV2Variant}
      />

      {/* Auth Guard Sheet */}
      <LoginRequiredSheet
        isOpen={isLoginSheetOpen}
        onClose={() => setIsLoginSheetOpen(false)}
        onContinueWithGoogle={handleContinueWithGoogle}
        loading={isOAuthStarting}
        action="create_intention"
      />
    </section>
  );
};
