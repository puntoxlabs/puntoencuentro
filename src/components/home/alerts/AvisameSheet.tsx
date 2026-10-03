import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  X,
  Bell,
  Calendar,
  Clock,
  MapPin,
  Check,
  AlertCircle,
  Pause,
  Play,
  Trash2,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { matchAlertsService } from '@/services/matchAlertsService';
import type {
  MatchAlertSubscription,
  MatchAlertModalidad,
  CrearAlertaParams,
} from '@/types/matchAlerts';
import type { Localidad } from '@/components/home/openEncounters/types';
import { formatFriendlyDate } from '@/lib/formatDate';
import { DevicePushSettings } from './DevicePushSettings';
import '@/components/ui/BottomSheet.css';
import './AvisameSheet.css';

export interface AvisameSheetProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'create' | 'list';
  initialLocalityId?: string | null;
  localidades?: Localidad[];
  initialDraft?: Partial<CrearAlertaParams> | null;
  onAlertCreated?: (subscription: MatchAlertSubscription) => void;
  onRequestLogin?: (draft: CrearAlertaParams) => void;
  isPermanentUser?: boolean;
}

export const AvisameSheet: React.FC<AvisameSheetProps> = ({
  isOpen,
  onClose,
  initialTab = 'create',
  initialLocalityId = null,
  localidades = [],
  initialDraft = null,
  onAlertCreated,
  onRequestLogin,
  isPermanentUser = true,
}) => {
  const { t } = useTranslation();
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Tabs: 'create' | 'list'
  const [activeTab, setActiveTab] = useState<'create' | 'list'>(initialTab);

  // Estados del Formulario
  const [modalidad, setModalidad] = useState<MatchAlertModalidad>(
    initialDraft?.modalidad || (initialLocalityId ? 'presencial' : 'indistinto')
  );
  const [localityId, setLocalityId] = useState<string>(
    initialDraft?.localityId || initialLocalityId || (localidades[0]?.id ?? '')
  );
  const [fechaDesde, setFechaDesde] = useState<string>(initialDraft?.fechaDesde || '');
  const [fechaHasta, setFechaHasta] = useState<string>(initialDraft?.fechaHasta || '');
  const [horaDesde, setHoraDesde] = useState<string>(initialDraft?.horaDesde || '');
  const [horaHasta, setHoraHasta] = useState<string>(initialDraft?.horaHasta || '');
  const [noExpiration, setNoExpiration] = useState<boolean>(!initialDraft?.expiresAt);
  const [expiresAtDate, setExpiresAtDate] = useState<string>(
    initialDraft?.expiresAt ? initialDraft.expiresAt.slice(0, 10) : ''
  );

  // Estados de envío y feedback
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [feedbackMsg, setFeedbackMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Estados de "Mis avisos"
  const [alerts, setAlerts] = useState<MatchAlertSubscription[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(false);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  // Sincronizar tab inicial o draft al abrir
  useEffect(() => {
    if (isOpen) {
      if (initialTab) {
        setActiveTab(initialTab);
      }
      if (initialDraft) {
        if (initialDraft.modalidad) setModalidad(initialDraft.modalidad);
        if (initialDraft.localityId) setLocalityId(initialDraft.localityId);
        if (initialDraft.fechaDesde) setFechaDesde(initialDraft.fechaDesde);
        if (initialDraft.fechaHasta) setFechaHasta(initialDraft.fechaHasta);
        if (initialDraft.horaDesde) setHoraDesde(initialDraft.horaDesde);
        if (initialDraft.horaHasta) setHoraHasta(initialDraft.horaHasta);
        if (initialDraft.expiresAt) {
          setNoExpiration(false);
          setExpiresAtDate(initialDraft.expiresAt.slice(0, 10));
        } else {
          setNoExpiration(true);
        }
      } else if (initialLocalityId && !initialDraft) {
        setLocalityId(initialLocalityId);
      }
    }
  }, [isOpen, initialTab, initialDraft, initialLocalityId]);

  // Cargar mis avisos si el usuario es permanente
  const fetchMisAlertas = useCallback(async () => {
    if (!isPermanentUser) return;
    setLoadingAlerts(true);
    setAlertsError(null);
    try {
      const res = await matchAlertsService.getMisAlertas();
      if (res.ok) {
        // Filtrar canceladas por defecto para no saturar la vista
        const visible = res.subscriptions.filter((s) => s.effectiveStatus !== 'cancelled' && s.status !== 'cancelled');
        setAlerts(visible);
      } else {
        setAlertsError(res.error || 'No se pudieron cargar tus avisos.');
      }
    } catch (err: any) {
      setAlertsError(err?.message || 'Error de conexión.');
    } finally {
      setLoadingAlerts(false);
    }
  }, [isPermanentUser]);

  useEffect(() => {
    if (isOpen && isPermanentUser) {
      void fetchMisAlertas();
    }
  }, [isOpen, isPermanentUser, fetchMisAlertas]);

  // Manejo de tecla Escape y foco inicial
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    const timer = setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 50);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
    };
  }, [isOpen, onClose]);

  // Bloqueo de scroll en body mientras el bottom sheet está abierto para evitar scroll chaining en mobile
  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    const originalOverscrollBehavior = document.body.style.overscrollBehavior;
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';

    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.overscrollBehavior = originalOverscrollBehavior;
    };
  }, [isOpen]);

  // Localidad efectiva y catálogo
  const activeLocalities = useMemo(() => {
    return localidades.length > 0 ? localidades : [];
  }, [localidades]);

  const getLocalityName = (id: string | null) => {
    if (!id) return null;
    const found = activeLocalities.find((l) => l.id === id);
    return found ? found.nombre : id;
  };

  // Conteo de alertas activas
  const activeCount = alerts.filter((a) => a.effectiveStatus === 'active').length;

  // Manejo de envío del formulario
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    setFeedbackMsg(null);

    // Preparar parámetros limpios
    const finalModalidad: MatchAlertModalidad = modalidad;
    const finalLocalityId = (modalidad === 'presencial' || modalidad === 'indistinto') && localityId ? localityId : null;
    const finalFechaDesde = fechaDesde || null;
    const finalFechaHasta = fechaHasta || null;
    const finalHoraDesde = horaDesde || null;
    const finalHoraHasta = horaHasta || null;
    const finalExpiresAt = noExpiration || !expiresAtDate ? null : `${expiresAtDate}T23:59:59.999Z`;

    const draftParams: CrearAlertaParams = {
      modalidad: finalModalidad,
      localityId: finalLocalityId,
      fechaDesde: finalFechaDesde,
      fechaHasta: finalFechaHasta,
      horaDesde: finalHoraDesde,
      horaHasta: finalHoraHasta,
      expiresAt: finalExpiresAt,
    };

    // Si no es permanente, solicitar login conservando draft
    if (!isPermanentUser) {
      if (onRequestLogin) {
        onRequestLogin(draftParams);
      }
      return;
    }

    setSubmitting(true);
    try {
      const res = await matchAlertsService.crearAlerta(draftParams);
      if (!res.ok || !res.subscription) {
        setFormError(res.error || 'Ocurrió un error al crear la alerta. Verificá los datos.');
        return;
      }

      // Éxito: notificar, resetear formulario y cambiar a tab 'list'
      setFeedbackMsg({
        text: '¡Aviso creado! Te notificaremos en tu inbox cuando coincida un encuentro.',
        type: 'success',
      });
      if (onAlertCreated) {
        onAlertCreated(res.subscription);
      }
      void fetchMisAlertas();
      setActiveTab('list');
    } catch (err: any) {
      setFormError(err?.message || 'Error inesperado al conectar con el servidor.');
    } finally {
      setSubmitting(false);
    }
  };

  // Acciones en "Mis avisos"
  const handlePausar = async (subId: string) => {
    if (mutatingId) return;
    setMutatingId(subId);
    try {
      const res = await matchAlertsService.pausarAlerta(subId);
      if (res.ok) {
        setAlerts((prev) =>
          prev.map((s) => (s.id === subId ? { ...s, status: 'paused', effectiveStatus: 'paused' } : s))
        );
        setFeedbackMsg({ text: 'Aviso pausado correctamente.', type: 'success' });
      } else {
        setFeedbackMsg({ text: res.error || 'No se pudo pausar el aviso.', type: 'error' });
      }
    } finally {
      setMutatingId(null);
    }
  };

  const handleReactivar = async (subId: string) => {
    if (mutatingId) return;
    setMutatingId(subId);
    try {
      const res = await matchAlertsService.reactivarAlerta(subId);
      if (res.ok) {
        setAlerts((prev) =>
          prev.map((s) => (s.id === subId ? { ...s, status: 'active', effectiveStatus: 'active' } : s))
        );
        setFeedbackMsg({ text: 'Aviso reactivado correctamente.', type: 'success' });
      } else {
        setFeedbackMsg({ text: res.error || 'No se pudo reactivar el aviso.', type: 'error' });
      }
    } finally {
      setMutatingId(null);
    }
  };

  const handleCancelar = async (subId: string) => {
    if (mutatingId) return;
    if (!window.confirm('¿Seguro que querés cancelar este aviso?')) return;
    setMutatingId(subId);
    try {
      const res = await matchAlertsService.cancelarAlerta(subId);
      if (res.ok) {
        setAlerts((prev) => prev.filter((s) => s.id !== subId));
        setFeedbackMsg({ text: 'Aviso cancelado.', type: 'success' });
      } else {
        setFeedbackMsg({ text: res.error || 'No se pudo cancelar el aviso.', type: 'error' });
      }
    } finally {
      setMutatingId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Overlay */}
      <div className="pe-sheet-overlay" onClick={onClose} aria-hidden="true" />

      {/* Sheet Container */}
      <div
        className="pe-sheet-container pe-avisame-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="avisame-sheet-title"
      >
        <div className="pe-sheet-handle" aria-hidden="true" />

        {/* Encabezado */}
        <header className="pe-avisame-header">
          <div className="pe-avisame-header__title-group">
            <div className="pe-avisame-header__title-row">
              <span className="pe-avisame-header__icon" aria-hidden="true">
                <Bell size={20} />
              </span>
              <h2 id="avisame-sheet-title" className="pe-avisame-header__title">
                {t('avisame.sheet_title', { defaultValue: 'Avisame' })}
              </h2>
            </div>
            <p className="pe-avisame-header__subtitle">
              {t('avisame.sheet_subtitle', {
                defaultValue: 'Te avisamos en tu inbox cuando se abra un encuentro que coincida con lo que buscás.',
              })}
            </p>
          </div>

          <button
            ref={closeBtnRef}
            type="button"
            className="pe-avisame-close-btn"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={20} />
          </button>
        </header>

        {/* Tabs de Navegación */}
        <div className="pe-avisame-tabs" role="tablist" aria-label="Secciones de avisos">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'create'}
            className={`pe-avisame-tab ${activeTab === 'create' ? 'pe-avisame-tab--active' : ''}`}
            onClick={() => {
              setActiveTab('create');
              setFeedbackMsg(null);
            }}
          >
            <Plus size={14} aria-hidden="true" />
            <span>{t('avisame.tab_create', { defaultValue: 'Crear aviso' })}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'list'}
            className={`pe-avisame-tab ${activeTab === 'list' ? 'pe-avisame-tab--active' : ''}`}
            onClick={() => {
              setActiveTab('list');
              setFeedbackMsg(null);
              void fetchMisAlertas();
            }}
          >
            <span>{t('avisame.tab_my_alerts', { defaultValue: 'Mis avisos' })}</span>
            {alerts.length > 0 && <span className="pe-avisame-tab__badge">{activeCount}</span>}
          </button>
        </div>

        {/* Feedback Banner Global si aplica */}
        {feedbackMsg && (
          <div
            className={`pe-avisame-feedback pe-avisame-feedback--${feedbackMsg.type}`}
            role="status"
            style={{ marginBottom: 16 }}
          >
            {feedbackMsg.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}
            <span>{feedbackMsg.text}</span>
          </div>
        )}

        {/* ── Tab: Crear Aviso ── */}
        {activeTab === 'create' && (
          <form className="pe-avisame-form" onSubmit={handleSubmit}>
            {/* Modalidad */}
            <div className="pe-avisame-field">
              <label className="pe-avisame-label">
                {t('avisame.modalidad_label', { defaultValue: 'Modalidad' })}
              </label>
              <div className="pe-avisame-chips" role="radiogroup" aria-label="Modalidad del encuentro">
                <button
                  type="button"
                  role="radio"
                  aria-checked={modalidad === 'presencial'}
                  className={`pe-avisame-chip ${modalidad === 'presencial' ? 'pe-avisame-chip--active' : ''}`}
                  onClick={() => setModalidad('presencial')}
                >
                  🤝 {t('avisame.modalidad_presencial', { defaultValue: 'Presencial' })}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={modalidad === 'virtual'}
                  className={`pe-avisame-chip ${modalidad === 'virtual' ? 'pe-avisame-chip--active' : ''}`}
                  onClick={() => setModalidad('virtual')}
                >
                  💻 {t('avisame.modalidad_virtual', { defaultValue: 'Virtual' })}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={modalidad === 'indistinto'}
                  className={`pe-avisame-chip ${modalidad === 'indistinto' ? 'pe-avisame-chip--active' : ''}`}
                  onClick={() => setModalidad('indistinto')}
                >
                  🌐 {t('avisame.modalidad_indistinto', { defaultValue: 'Indistinto' })}
                </button>
              </div>
            </div>

            {/* Zona / Localidad (solo si no es virtual exclusivo) */}
            {modalidad !== 'virtual' && (
              <div className="pe-avisame-field">
                <label htmlFor="avisame-locality-select" className="pe-avisame-label">
                  <span>{t('avisame.locality_label', { defaultValue: 'Zona / Localidad' })}</span>
                  {modalidad === 'indistinto' && (
                    <span className="pe-avisame-label__optional">
                      {t('avisame.locality_optional', { defaultValue: 'Opcional' })}
                    </span>
                  )}
                </label>
                <select
                  id="avisame-locality-select"
                  className="pe-avisame-select"
                  value={localityId}
                  onChange={(e) => setLocalityId(e.target.value)}
                >
                  {modalidad === 'indistinto' && (
                    <option value="">{t('avisame.locality_any', { defaultValue: 'Cualquier zona' })}</option>
                  )}
                  {activeLocalities.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.nombre}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Rango de Fechas (Opcional) */}
            <div className="pe-avisame-field">
              <label className="pe-avisame-label">
                <span>{t('avisame.date_range_label', { defaultValue: 'Rango de fechas' })}</span>
                <span className="pe-avisame-label__optional">
                  {t('avisame.optional', { defaultValue: 'Opcional' })}
                </span>
              </label>
              <div className="pe-avisame-row">
                <div>
                  <label htmlFor="avisame-fecha-desde" style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
                    {t('avisame.date_from', { defaultValue: 'Desde' })}
                  </label>
                  <input
                    id="avisame-fecha-desde"
                    type="date"
                    className="pe-avisame-input"
                    value={fechaDesde}
                    onChange={(e) => setFechaDesde(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="avisame-fecha-hasta" style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
                    {t('avisame.date_to', { defaultValue: 'Hasta' })}
                  </label>
                  <input
                    id="avisame-fecha-hasta"
                    type="date"
                    min={fechaDesde || undefined}
                    className="pe-avisame-input"
                    value={fechaHasta}
                    onChange={(e) => setFechaHasta(e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* Rango Horario (Opcional) */}
            <div className="pe-avisame-field">
              <label className="pe-avisame-label">
                <span>{t('avisame.time_range_label', { defaultValue: 'Horario preferido' })}</span>
                <span className="pe-avisame-label__optional">
                  {t('avisame.optional', { defaultValue: 'Opcional' })}
                </span>
              </label>
              <div className="pe-avisame-row">
                <div>
                  <label htmlFor="avisame-hora-desde" style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
                    {t('avisame.time_from', { defaultValue: 'Desde' })}
                  </label>
                  <input
                    id="avisame-hora-desde"
                    type="time"
                    className="pe-avisame-input"
                    value={horaDesde}
                    onChange={(e) => setHoraDesde(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="avisame-hora-hasta" style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
                    {t('avisame.time_to', { defaultValue: 'Hasta' })}
                  </label>
                  <input
                    id="avisame-hora-hasta"
                    type="time"
                    className="pe-avisame-input"
                    value={horaHasta}
                    onChange={(e) => setHoraHasta(e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* Expiración / Vigencia */}
            <div className="pe-avisame-field">
              <label className="pe-avisame-label">
                <span>{t('avisame.expiration_label', { defaultValue: 'Vigencia del aviso' })}</span>
              </label>
              <label className="pe-avisame-checkbox-container">
                <input
                  type="checkbox"
                  className="pe-avisame-checkbox"
                  checked={noExpiration}
                  onChange={(e) => setNoExpiration(e.target.checked)}
                />
                <span>{t('avisame.no_expiration', { defaultValue: 'Sin vencimiento (hasta que lo pauses o canceles)' })}</span>
              </label>

              {!noExpiration && (
                <div style={{ marginTop: 8 }}>
                  <label htmlFor="avisame-expires-at" style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
                    {t('avisame.expires_at_label', { defaultValue: 'Vence el' })}
                  </label>
                  <input
                    id="avisame-expires-at"
                    type="date"
                    className="pe-avisame-input"
                    value={expiresAtDate}
                    onChange={(e) => setExpiresAtDate(e.target.value)}
                    required={!noExpiration}
                  />
                </div>
              )}
            </div>

            {/* Error Inline */}
            {formError && (
              <div className="pe-avisame-feedback pe-avisame-feedback--error" role="alert">
                <AlertCircle size={16} />
                <span>{formError}</span>
              </div>
            )}

            {/* Botón Guardar */}
            <button
              type="submit"
              className="pe-avisame-submit-btn"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <RefreshCw size={16} className="pe-spin" style={{ animation: 'spin 1s linear infinite' }} />
                  <span>{t('avisame.submitting_btn', { defaultValue: 'Guardando aviso…' })}</span>
                </>
              ) : (
                <>
                  <Bell size={16} />
                  <span>{t('avisame.submit_btn', { defaultValue: 'Guardar aviso' })}</span>
                </>
              )}
            </button>
          </form>
        )}

        {/* ── Tab: Mis Avisos ── */}
        {activeTab === 'list' && (
          <div className="pe-avisame-list">
            {loadingAlerts ? (
              <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--color-on-surface-variant)' }}>
                <RefreshCw size={24} style={{ animation: 'spin 1s linear infinite', marginBottom: 8 }} />
                <p style={{ fontSize: 13, margin: 0 }}>Cargando tus avisos…</p>
              </div>
            ) : alertsError ? (
              <div className="pe-avisame-empty">
                <AlertCircle size={28} className="pe-avisame-empty__icon" style={{ color: '#ef4444' }} />
                <p className="pe-avisame-empty__title">No se pudieron cargar tus avisos</p>
                <p className="pe-avisame-empty__desc">{alertsError}</p>
                <button
                  type="button"
                  className="pe-avisame-empty__cta"
                  onClick={() => void fetchMisAlertas()}
                >
                  Reintentar
                </button>
              </div>
            ) : alerts.length === 0 ? (
              <div className="pe-avisame-empty">
                <Bell size={32} className="pe-avisame-empty__icon" />
                <p className="pe-avisame-empty__title">
                  {t('avisame.empty_my_alerts', { defaultValue: 'No tenés avisos creados todavía.' })}
                </p>
                <p className="pe-avisame-empty__desc">
                  Creá tu primer aviso para que te notifiquemos en cuanto se abra un encuentro con tus preferencias.
                </p>
                <button
                  type="button"
                  className="pe-avisame-empty__cta"
                  onClick={() => setActiveTab('create')}
                >
                  <Plus size={14} style={{ display: 'inline', marginRight: 4, verticalAlign: 'text-bottom' }} />
                  {t('avisame.empty_my_alerts_cta', { defaultValue: 'Crear mi primer aviso' })}
                </button>
              </div>
            ) : (
              alerts.map((item) => {
                const effectiveStatus = item.effectiveStatus || item.status;
                const isMutating = mutatingId === item.id;
                const locName = item.localityNombre || getLocalityName(item.localityId);

                return (
                  <div
                    key={item.id}
                    className={`pe-avisame-card pe-avisame-card--${effectiveStatus}`}
                  >
                    <div className="pe-avisame-card__header">
                      <span className="pe-avisame-card__tag">
                        {item.modalidad === 'presencial' && '🤝 Presencial'}
                        {item.modalidad === 'virtual' && '💻 Virtual'}
                        {item.modalidad === 'indistinto' && '🌐 Indistinto'}
                        {locName && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 4 }}>
                            <MapPin size={12} aria-hidden="true" />
                            {locName}
                          </span>
                        )}
                      </span>

                      <span className={`pe-avisame-badge pe-avisame-badge--${effectiveStatus}`}>
                        {effectiveStatus === 'active' && t('avisame.status_active', { defaultValue: 'Activa' })}
                        {effectiveStatus === 'paused' && t('avisame.status_paused', { defaultValue: 'Pausada' })}
                        {effectiveStatus === 'expired' && t('avisame.status_expired', { defaultValue: 'Vencida' })}
                      </span>
                    </div>

                    <div className="pe-avisame-card__details">
                      {(item.fechaDesde || item.fechaHasta) && (
                        <div className="pe-avisame-card__detail-item">
                          <Calendar size={13} aria-hidden="true" />
                          <span>
                            {item.fechaDesde && item.fechaHasta
                              ? `${formatFriendlyDate(item.fechaDesde)} al ${formatFriendlyDate(item.fechaHasta)}`
                              : item.fechaDesde
                              ? `Desde ${formatFriendlyDate(item.fechaDesde)}`
                              : `Hasta ${formatFriendlyDate(item.fechaHasta!)}`}
                          </span>
                        </div>
                      )}

                      {(item.horaDesde || item.horaHasta) && (
                        <div className="pe-avisame-card__detail-item">
                          <Clock size={13} aria-hidden="true" />
                          <span>
                            {item.horaDesde && item.horaHasta
                              ? `${item.horaDesde} a ${item.horaHasta} hs`
                              : item.horaDesde
                              ? `Desde ${item.horaDesde} hs`
                              : `Hasta ${item.horaHasta} hs`}
                          </span>
                        </div>
                      )}

                      <div className="pe-avisame-card__detail-item" style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
                        <span>
                          {item.expiresAt
                            ? `Vence: ${formatFriendlyDate(item.expiresAt.slice(0, 10))}`
                            : 'Sin vencimiento'}
                        </span>
                      </div>
                    </div>

                    {/* Acciones según estado efectivo */}
                    <div className="pe-avisame-card__actions">
                      {effectiveStatus === 'active' && (
                        <button
                          type="button"
                          className="pe-avisame-card__action-btn"
                          disabled={isMutating}
                          onClick={() => void handlePausar(item.id)}
                        >
                          <Pause size={12} />
                          <span>{t('avisame.action_pause', { defaultValue: 'Pausar' })}</span>
                        </button>
                      )}

                      {effectiveStatus === 'paused' && (
                        <button
                          type="button"
                          className="pe-avisame-card__action-btn pe-avisame-card__action-btn--primary"
                          disabled={isMutating}
                          onClick={() => void handleReactivar(item.id)}
                        >
                          <Play size={12} />
                          <span>{t('avisame.action_reactivate', { defaultValue: 'Reactivar' })}</span>
                        </button>
                      )}

                      <button
                        type="button"
                        className="pe-avisame-card__action-btn pe-avisame-card__action-btn--danger"
                        disabled={isMutating}
                        onClick={() => void handleCancelar(item.id)}
                      >
                        <Trash2 size={12} />
                        <span>{t('avisame.action_cancel', { defaultValue: 'Cancelar' })}</span>
                      </button>
                    </div>
                  </div>
                );
              })
            )}

            {/* Fase 3A: activar push en este dispositivo (solo tras tener ≥1 aviso; sin interrumpir la creación) */}
            {isPermanentUser && !loadingAlerts && !alertsError && alerts.length > 0 && (
              <DevicePushSettings />
            )}
          </div>
        )}
      </div>
    </>
  );
};
