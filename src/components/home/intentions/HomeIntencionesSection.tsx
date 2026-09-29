import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Sparkles } from 'lucide-react';
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
}

export const HomeIntencionesSection: React.FC<HomeIntencionesSectionProps> = () => {
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
          alert(`No se pudo actualizar la intención: ${res.error || 'error desconocido'}`);
          return false;
        }
      } else {
        const res = await crearIntencion(payload as CrearIntencionPayload);
        if (!res.ok) {
          alert(`No se pudo crear la intención: ${res.error || 'error desconocido'}`);
          return false;
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
      alert(`Error al guardar: ${err?.message || 'error desconocido'}`);
      return false;
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

  // Filtrar cerradas: sólo mostrar activas y pausadas
  const visibleIntenciones = intenciones.filter(
    (i) => i.estado === 'activa' || i.estado === 'pausada'
  );

  return (
    <section className="pe-intenciones-section" aria-label="Sección de Intenciones">
      {/* Cabecera */}
      <div className="pe-intenciones-header">
        <div className="pe-intenciones-title-group">
          <h2 className="pe-intenciones-title">Mis intenciones</h2>
          <p className="pe-intenciones-subtitle">
            Cosas que tenés ganas de hacer, antes de organizar un encuentro.
          </p>
        </div>

        <button
          type="button"
          onClick={handleOpenCreate}
          className="pe-intenciones-add-btn"
          aria-label="Expresar intención"
        >
          <Plus size={16} aria-hidden="true" />
          <span>+ Expresar intención</span>
        </button>
      </div>

      {/* Estados */}
      {loading ? (
        <div className="pe-intenciones-loading">
          <p className="pe-intenciones-loading-text">Cargando tus intenciones…</p>
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
          <h3 className="pe-intenciones-empty__title">Todavía no expresaste intenciones</h3>
          <p className="pe-intenciones-empty__desc">
            ¿Tenés ganas de hacer algo pero todavía no armaste un encuentro? Expresá tu
            intención para recordarla o coordinar con otros más adelante.
          </p>
          <button
            type="button"
            onClick={handleOpenCreate}
            className="pe-intenciones-add-btn"
            style={{ margin: '0 auto' }}
          >
            + Expresar intención
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
