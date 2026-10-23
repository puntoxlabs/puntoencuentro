import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Calendar, Clock, AlertTriangle, Info, ArrowRight } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { TimePicker } from '@/components/ui/TimePicker';
import { Button } from '@/components/ui/Button';
import { formatFriendlyDate, validateEncounterDate } from '@/lib/formatDate';
import { getArgentinaTodayISO, getArgentinaDateTimeParts } from '@/lib/argentinaDateTime';
import { encuentrosService, type CreateEncuentroDTO } from '@/services/encuentrosService';
import { useDetailStore } from '@/store/detailStore';
import { useHomeStore } from '@/store/homeStore';
import './EditScheduleModal.css';

export interface EditScheduleModalProps {
  isOpen: boolean;
  onClose: () => void;
  encuentro: any;
  hostId: string;
  participantes?: any[];
  onSaveSuccess: () => Promise<void> | void;
}

export const EditScheduleModal: React.FC<EditScheduleModalProps> = ({
  isOpen,
  onClose,
  encuentro,
  hostId,
  participantes = [],
  onSaveSuccess,
}) => {
  const { t } = useTranslation();

  const [fecha, setFecha] = useState<string>('');
  const [hora, setHora] = useState<string>('');
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initialFecha = encuentro?.fecha || '';
  const initialHora = encuentro?.hora ? encuentro.hora.substring(0, 5) : '';

  // Reset state when modal opens or encounter schedule props change
  useEffect(() => {
    if (isOpen) {
      setFecha(initialFecha);
      setHora(initialHora);
      setStep('edit');
      setError(null);
      setSaving(false);
    }
  }, [isOpen, initialFecha, initialHora]);

  // Lock body scroll while modal is active
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (step === 'confirm' && !saving) {
          setStep('edit');
        } else if (!saving) {
          handleCancel();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, step, saving]);

  if (!isOpen || !encuentro) return null;

  const minDate = getArgentinaTodayISO();
  const isToday = fecha === minDate;
  const nowParts = isToday ? getArgentinaDateTimeParts() : null;
  const minTimeToday = nowParts
    ? `${String(nowParts.hour).padStart(2, '0')}:${String(nowParts.minute).padStart(2, '0')}`
    : undefined;

  const isFechaChanged = fecha !== initialFecha;
  const isHoraChanged = hora !== initialHora;
  const hasChanges = isFechaChanged || isHoraChanged;

  const rawValidationErr = fecha && hora ? validateEncounterDate(fecha, hora) : null;
  const validationError = rawValidationErr
    ? rawValidationErr === 'La fecha no puede ser anterior a hoy.'
      ? t('edit_schedule.past_date_error', 'La fecha no puede ser anterior a hoy.')
      : t('edit_schedule.invalid_datetime', 'La fecha y hora deben ser futuras.')
    : null;

  const isOpenEncounter = Boolean(
    encuentro?.is_open ||
    encuentro?.opened_at ||
    (encuentro as any)?.open_public_title
  );
  const inscriptionsClosed = Boolean(encuentro?.inscriptions_closed);
  const hasAnonymousGuests = !isOpenEncounter || participantes.some((p) => !p.user_id);

  const handleCancel = () => {
    if (saving) return;
    setFecha(initialFecha);
    setHora(initialHora);
    setStep('edit');
    setError(null);
    onClose();
  };

  const handleContinueToConfirm = () => {
    if (!hasChanges || validationError || !fecha || !hora || saving) return;
    setError(null);
    setStep('confirm');
  };

  const handleSave = async () => {
    if (saving) return;

    const currentValidation = validateEncounterDate(fecha, hora);
    if (currentValidation) {
      setError(
        currentValidation === 'La fecha no puede ser anterior a hoy.'
          ? t('edit_schedule.past_date_error', 'La fecha no puede ser anterior a hoy.')
          : t('edit_schedule.invalid_datetime', 'La fecha y hora deben ser futuras.')
      );
      setStep('edit');
      return;
    }

    const payload: Partial<CreateEncuentroDTO> = {};
    if (isFechaChanged) payload.fecha = fecha;
    if (isHoraChanged) payload.hora = hora;

    if (!payload.fecha && !payload.hora) {
      setError(t('edit_schedule.no_changes', 'No se modificó la fecha ni el horario.'));
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const res = await encuentrosService.updateEncuentro(
        encuentro.id,
        payload,
        hostId
      );

      if (!res?.ok) {
        throw new Error(res?.error || 'update_failed');
      }

      // Invalidar cachés afectados
      useDetailStore.getState().invalidateCache(encuentro.id);
      useHomeStore.getState().invalidateCache();

      // Recargar datos frescos del backend de forma autorizada
      await onSaveSuccess();

      // Cerrar modal solo tras éxito verificado
      onClose();
    } catch (err: any) {
      console.error('[EditScheduleModal] Error updating schedule:', err);
      setError(t('edit_schedule.error_save', 'No pudimos actualizar la fecha y horario. Revisá tu conexión e intentá nuevamente.'));
      setSaving(false);
    }
  };

  return (
    <div className="pe-edit-schedule-backdrop" onClick={handleCancel} aria-hidden="true">
      <div
        className="pe-edit-schedule-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pe-edit-schedule-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pe-edit-schedule-handle" />

        <div className="pe-edit-schedule-header">
          <div className="pe-edit-schedule-header-titles">
            <h2 id="pe-edit-schedule-title" className="pe-edit-schedule-title">
              {step === 'edit'
                ? t('edit_schedule.modal_title', 'Editar fecha y horario')
                : t('edit_schedule.confirm_title', '¿Confirmar cambio de fecha y horario?')}
            </h2>
            <p className="pe-edit-schedule-subtitle">
              {step === 'edit'
                ? t('edit_schedule.modal_subtitle', 'Modificá la fecha, el horario o ambos para este encuentro.')
                : t('edit_schedule.confirm_subtitle', 'Revisá los datos antes de aplicar el cambio.')}
            </p>
          </div>
          <button
            type="button"
            className="pe-edit-schedule-close"
            onClick={handleCancel}
            disabled={saving}
            aria-label={t('edit_schedule.btn_cancel', 'Cancelar')}
          >
            <X size={18} />
          </button>
        </div>

        {step === 'edit' ? (
          <div className="pe-edit-schedule-body">
            <div className="pe-edit-schedule-current-box">
              <span className="pe-edit-schedule-current-label">
                {t('edit_schedule.current_schedule_label', 'Fecha y horario actual:')}
              </span>
              <div className="pe-edit-schedule-current-value">
                <Calendar size={15} aria-hidden="true" />
                <span>{formatFriendlyDate(initialFecha, initialHora)}</span>
              </div>
            </div>

            <div className="pe-edit-schedule-fields">
              <Input
                label={t('edit_schedule.date_label', 'Fecha')}
                type="date"
                value={fecha}
                onChange={(e) => {
                  setFecha(e.target.value);
                  setError(null);
                }}
                min={minDate}
                disabled={saving}
              />

              <div className="pe-edit-schedule-time-wrapper">
                <TimePicker
                  label={t('edit_schedule.time_label', 'Hora')}
                  value={hora}
                  onChange={(h) => {
                    setHora(h);
                    setError(null);
                  }}
                  minTime={minTimeToday}
                  disabled={!fecha || saving}
                />
                <p className="pe-edit-schedule-time-hint">
                  {isToday
                    ? t('edit_schedule.time_helper_today', 'Hoy: debe ser posterior a la hora actual')
                    : t('edit_schedule.time_helper_any', 'Cualquier horario disponible')}
                </p>
              </div>
            </div>

            {validationError && (
              <div className="pe-edit-schedule-alert pe-edit-schedule-alert--error" role="alert">
                <AlertTriangle size={16} />
                <span>{validationError}</span>
              </div>
            )}

            {!hasChanges && !validationError && (
              <div className="pe-edit-schedule-hint-neutral">
                <Info size={15} />
                <span>{t('edit_schedule.no_changes', 'No se modificó la fecha ni el horario.')}</span>
              </div>
            )}

            <div className="pe-edit-schedule-actions">
              <Button
                type="button"
                variant="outline"
                onClick={handleCancel}
                disabled={saving}
              >
                {t('edit_schedule.btn_cancel', 'Cancelar')}
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={handleContinueToConfirm}
                disabled={!hasChanges || Boolean(validationError) || !fecha || !hora || saving}
              >
                {t('edit_schedule.btn_continue', 'Continuar')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="pe-edit-schedule-body">
            <div className="pe-edit-schedule-comparison">
              <div className="pe-edit-schedule-comparison-item">
                <span className="pe-edit-schedule-comparison-label">
                  {t('edit_schedule.previous_schedule', 'Fecha y hora anterior')}
                </span>
                <span className="pe-edit-schedule-comparison-val pe-edit-schedule-comparison-val--old">
                  {formatFriendlyDate(initialFecha, initialHora)}
                </span>
              </div>

              <div className="pe-edit-schedule-comparison-arrow" aria-hidden="true">
                <ArrowRight size={18} />
              </div>

              <div className="pe-edit-schedule-comparison-item">
                <span className="pe-edit-schedule-comparison-label">
                  {t('edit_schedule.new_schedule', 'Nueva fecha y hora')}
                </span>
                <span className="pe-edit-schedule-comparison-val pe-edit-schedule-comparison-val--new">
                  {formatFriendlyDate(fecha, hora)}
                </span>
              </div>
            </div>

            <div className="pe-edit-schedule-warnings">
              <div className="pe-edit-schedule-warning-item">
                <AlertTriangle size={16} className="pe-edit-schedule-warning-icon" />
                <p>{t('edit_schedule.warning_affects_planning', 'Este cambio afecta la planificación del encuentro.')}</p>
              </div>

              {isOpenEncounter && (
                <div className="pe-edit-schedule-warning-item">
                  <Info size={16} className="pe-edit-schedule-warning-icon" />
                  <p>{t('edit_schedule.warning_open_notifications', 'Al ser un encuentro abierto, los participantes confirmados y solicitantes pendientes recibirán un aviso en su Inbox.')}</p>
                </div>
              )}

              {isOpenEncounter && inscriptionsClosed && (
                <div className="pe-edit-schedule-warning-item pe-edit-schedule-warning-item--reconfirm">
                  <Clock size={16} className="pe-edit-schedule-warning-icon" />
                  <p>{t('edit_schedule.warning_open_reconfirmation', 'Las inscripciones ya estaban cerradas: todos los participantes confirmados deberán volver a confirmar su asistencia.')}</p>
                </div>
              )}

              {hasAnonymousGuests && (
                <div className="pe-edit-schedule-warning-item pe-edit-schedule-warning-item--private">
                  <Info size={16} className="pe-edit-schedule-warning-icon" />
                  <p>{t('edit_schedule.warning_private_communication', 'En encuentros privados o con invitados sin cuenta, recordá comunicarles la nueva fecha y hora de forma directa, ya que no reciben avisos automáticos.')}</p>
                </div>
              )}
            </div>

            {error && (
              <div className="pe-edit-schedule-alert pe-edit-schedule-alert--error" role="alert">
                <AlertTriangle size={16} />
                <span>{error}</span>
              </div>
            )}

            <div className="pe-edit-schedule-actions">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep('edit')}
                disabled={saving}
              >
                {t('edit_schedule.btn_back_to_edit', 'Volver a editar')}
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving
                  ? t('edit_schedule.saving', 'Guardando cambios…')
                  : t('edit_schedule.btn_save_changes', 'Guardar cambios')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
