import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, Plus, Trash2, AlertCircle, Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { TimePicker } from '@/components/ui/TimePicker';
import {
  getArgentinaTodayISO,
  isArgentinaDateTimeInFuture,
  buildArgentinaLocalKey,
} from '@/lib/argentinaDateTime';
import {
  EDITABLE_FIELD_REGISTRY,
  type EditableField,
  type DateOptionValue,
} from '@/lib/wizardActions';
import type { EncounterDraft, InvitationConfig } from '@/lib/encounterDraft';
import {
  INVITATION_THEMES,
  getTemplateOptionsForTheme,
  getDefaultInvitationTemplate,
  type InvitationTheme,
} from '@/lib/invitationThemes';
import { isValidVirtualLink, normalizeVirtualLink } from '@/lib/draftMerger';
import { formatHumanSchedule } from '@/lib/formatDate';
import { useTranslation } from 'react-i18next';
import '@/components/ui/BottomSheet.css';

export interface FieldEditSheetProps {
  field: EditableField | null;
  draft: EncounterDraft;
  config: InvitationConfig;
  isOpen: boolean;
  onClose: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  externalDiscardRequest?: boolean;
  onExternalDiscardHandled?: () => void;
  onSaveDateOptions: (options: DateOptionValue[]) => void;
  onConvertToFixedFromOption: (option: DateOptionValue) => void;
  onSaveFixedDateTime: (date: string, time: string) => void;
  onSaveTitle: (title: string) => void;
  onSaveLocation: (modality: 'presencial' | 'virtual', value: string) => void;
  onSaveTheme: (theme: InvitationTheme, templateId?: string) => void;
}

export const FieldEditSheet: React.FC<FieldEditSheetProps> = ({
  field,
  draft,
  config,
  isOpen,
  onClose,
  onDirtyChange,
  externalDiscardRequest,
  onExternalDiscardHandled,
  onSaveDateOptions,
  onConvertToFixedFromOption,
  onSaveFixedDateTime,
  onSaveTitle,
  onSaveLocation,
  onSaveTheme,
}) => {
  const localToday = getArgentinaTodayISO();
  const { i18n } = useTranslation();
  const appLanguage = i18n?.language || 'es';

  // --------------------------------------------------------------------------
  // Initial Snapshots (for dirty check)
  // --------------------------------------------------------------------------
  const [initialSnapshot, setInitialSnapshot] = useState<any>({});

  // --------------------------------------------------------------------------
  // Local Buffers
  // --------------------------------------------------------------------------
  const [dateOptionsBuffer, setDateOptionsBuffer] = useState<DateOptionValue[]>([]);
  const [fixedDate, setFixedDate] = useState<string>('');
  const [fixedTime, setFixedTime] = useState<string>('');
  const [titleBuffer, setTitleBuffer] = useState<string>('');
  const [modalityBuffer, setModalityBuffer] = useState<'presencial' | 'virtual'>('presencial');
  const [locationBuffer, setLocationBuffer] = useState<string>('');
  const [themeBuffer, setThemeBuffer] = useState<InvitationTheme>('classic');
  const [templateBuffer, setTemplateBuffer] = useState<string>('');

  // UI / Error state
  const [error, setError] = useState<string | null>(null);
  const [pendingConvertToFixedOption, setPendingConvertToFixedOption] = useState<DateOptionValue | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const titleInputRef = useRef<HTMLInputElement>(null);

  // Re-sync buffers when sheet opens or field changes
  useEffect(() => {
    if (!isOpen || !field) {
      setError(null);
      setPendingConvertToFixedOption(null);
      setShowDiscardConfirm(false);
      onDirtyChange?.(false);
      return;
    }

    setError(null);
    setPendingConvertToFixedOption(null);
    setShowDiscardConfirm(false);

    let snapshot: any = {};

    if (field === 'date_options') {
      const initial = draft.dateOptions && draft.dateOptions.length > 0
        ? draft.dateOptions.map((o) => ({ date: o.date, time: o.time }))
        : [
            { date: draft.date || localToday, time: draft.time || '20:00' },
            { date: '', time: '' },
          ];
      setDateOptionsBuffer(initial);
      snapshot = { dateOptionsBuffer: initial };
    } else if (field === 'fixed_datetime') {
      const initDate = draft.date || localToday;
      const initTime = draft.time || '20:00';
      setFixedDate(initDate);
      setFixedTime(initTime);
      snapshot = { fixedDate: initDate, fixedTime: initTime };
    } else if (field === 'title') {
      const initTitle = draft.title || '';
      setTitleBuffer(initTitle);
      snapshot = { titleBuffer: initTitle };
      setTimeout(() => titleInputRef.current?.focus(), 150);
    } else if (field === 'location') {
      const currentMod = draft.modality || (draft.virtualLink ? 'virtual' : 'presencial');
      const currentLoc = currentMod === 'virtual' ? (draft.virtualLink || '') : (draft.locationText || '');
      setModalityBuffer(currentMod);
      setLocationBuffer(currentLoc);
      snapshot = { modalityBuffer: currentMod, locationBuffer: currentLoc };
    } else if (field === 'theme') {
      const currentTheme = config.invitationTheme || 'classic';
      const currentTemp = config.invitationTemplate || getDefaultInvitationTemplate(currentTheme) || '';
      setThemeBuffer(currentTheme);
      setTemplateBuffer(currentTemp);
      snapshot = { themeBuffer: currentTheme, templateBuffer: currentTemp };
    }
    
    setInitialSnapshot(snapshot);
  }, [isOpen, field, draft, config, localToday]);

  const isDirty = useMemo(() => {
    if (!isOpen || !field) return false;
    if (field === 'date_options') return JSON.stringify(dateOptionsBuffer) !== JSON.stringify(initialSnapshot.dateOptionsBuffer);
    if (field === 'fixed_datetime') return fixedDate !== initialSnapshot.fixedDate || fixedTime !== initialSnapshot.fixedTime;
    if (field === 'title') return titleBuffer !== initialSnapshot.titleBuffer;
    if (field === 'location') return modalityBuffer !== initialSnapshot.modalityBuffer || locationBuffer !== initialSnapshot.locationBuffer;
    if (field === 'theme') return themeBuffer !== initialSnapshot.themeBuffer || templateBuffer !== initialSnapshot.templateBuffer;
    return false;
  }, [isOpen, field, dateOptionsBuffer, fixedDate, fixedTime, titleBuffer, modalityBuffer, locationBuffer, themeBuffer, templateBuffer, initialSnapshot]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const requestClose = () => {
    if (isDirty) {
      setShowDiscardConfirm(true);
    } else {
      onClose();
    }
  };

  useEffect(() => {
    if (externalDiscardRequest) {
      onExternalDiscardHandled?.();
      requestClose();
    }
  }, [externalDiscardRequest, onExternalDiscardHandled, isDirty, onClose]); // We omit requestClose to avoid loop, it's fine since we inline the logic conceptually, wait let's use the function

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        requestClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, requestClose]);

  if (!isOpen || !field) return null;

  const fieldMeta = EDITABLE_FIELD_REGISTRY[field];

  // --------------------------------------------------------------------------
  // Actions: date_options
  // --------------------------------------------------------------------------
  const handleAddOption = () => {
    if (dateOptionsBuffer.length >= 3) return;
    setDateOptionsBuffer([...dateOptionsBuffer, { date: '', time: '' }]);
    setError(null);
  };

  const handleUpdateOption = (index: number, key: 'date' | 'time', val: string) => {
    const next = [...dateOptionsBuffer];
    next[index] = { ...next[index], [key]: val };
    setDateOptionsBuffer(next);
    setError(null);
  };

  const handleRequestRemoveOption = (index: number) => {
    if (dateOptionsBuffer.length <= 1) return;

    // If removing this option leaves exactly 1 option:
    if (dateOptionsBuffer.length === 2) {
      const remainingOption = dateOptionsBuffer[index === 0 ? 1 : 0];
      setPendingConvertToFixedOption(remainingOption);
      return;
    }

    // With 3 options, reducing to 2 is always valid
    const next = dateOptionsBuffer.filter((_, i) => i !== index);
    setDateOptionsBuffer(next);
    setError(null);
  };

  const handleConfirmConvertToFixed = () => {
    if (!pendingConvertToFixedOption) return;
    onConvertToFixedFromOption(pendingConvertToFixedOption);
    setPendingConvertToFixedOption(null);
    onClose();
  };

  const handleCancelConvertToFixed = () => {
    setPendingConvertToFixedOption(null);
  };

  const handleSaveDateOptionsClick = () => {
    setError(null);

    if (dateOptionsBuffer.length < 2) {
      setError('Coordinar fechas requiere al menos 2 opciones.');
      return;
    }

    const signatures = new Set<string>();

    for (let i = 0; i < dateOptionsBuffer.length; i++) {
      const opt = dateOptionsBuffer[i];
      if (!opt.date) {
        setError(`Completá la fecha de la opción ${i + 1}.`);
        return;
      }
      if (opt.date < localToday) {
        setError(`La fecha de la opción ${i + 1} no puede ser anterior a hoy.`);
        return;
      }
      if (!opt.time) {
        setError(`Completá el horario de la opción ${i + 1}.`);
        return;
      }
      if (!isArgentinaDateTimeInFuture(opt.date, opt.time)) {
        setError(`La opción ${i + 1} (${opt.date} a las ${opt.time}) debe ser en el futuro.`);
        return;
      }

      const sig = buildArgentinaLocalKey(opt.date, opt.time);
      if (signatures.has(sig)) {
        setError(`No puede haber opciones duplicadas (${opt.date} a las ${opt.time}).`);
        return;
      }
      signatures.add(sig);
    }

    // Sort chronologically and apply
    const sorted = [...dateOptionsBuffer].sort((a, b) =>
      a.date.localeCompare(b.date) || a.time.localeCompare(b.time)
    );

    onSaveDateOptions(sorted);
    onClose();
  };

  // --------------------------------------------------------------------------
  // Actions: fixed_datetime
  // --------------------------------------------------------------------------
  const handleSaveFixedDateTimeClick = () => {
    setError(null);
    if (!fixedDate) {
      setError('Completá la fecha del encuentro.');
      return;
    }
    if (fixedDate < localToday) {
      setError('La fecha no puede ser anterior a hoy.');
      return;
    }
    if (!fixedTime) {
      setError('Completá la hora del encuentro.');
      return;
    }
    if (!isArgentinaDateTimeInFuture(fixedDate, fixedTime)) {
      setError('La fecha y hora del encuentro deben ser posteriores al momento actual.');
      return;
    }

    onSaveFixedDateTime(fixedDate, fixedTime);
    onClose();
  };

  // --------------------------------------------------------------------------
  // Actions: title
  // --------------------------------------------------------------------------
  const handleSaveTitleClick = () => {
    setError(null);
    const clean = titleBuffer.trim();
    if (!clean) {
      setError('El título no puede estar vacío.');
      return;
    }
    if (clean.length > 100) {
      setError('El título no puede superar los 100 caracteres.');
      return;
    }
    onSaveTitle(clean);
    onClose();
  };

  // --------------------------------------------------------------------------
  // Actions: location
  // --------------------------------------------------------------------------
  const handleSaveLocationClick = () => {
    setError(null);
    const clean = locationBuffer.trim();
    if (!clean) {
      setError(
        modalityBuffer === 'virtual'
          ? 'Ingresá el link o plataforma de la videollamada.'
          : 'Ingresá el lugar o dirección del encuentro.'
      );
      return;
    }

    if (modalityBuffer === 'virtual') {
      if (!isValidVirtualLink(clean)) {
        setError('Ingresá un link válido (ej: meet.google.com/abc, https://zoom.us/...). No se permiten enlaces inseguros.');
        return;
      }
      onSaveLocation('virtual', normalizeVirtualLink(clean));
    } else {
      onSaveLocation('presencial', clean);
    }
    
    onClose();
  };

  // --------------------------------------------------------------------------
  // Actions: theme
  // --------------------------------------------------------------------------
  const handleSaveThemeClick = () => {
    setError(null);
    onSaveTheme(themeBuffer, templateBuffer);
    onClose();
  };

  return (
    <>
      <div className="pe-sheet-overlay open" onClick={requestClose} />
      <div
        className="pe-sheet-container open"
        role="dialog"
        aria-modal="true"
        aria-label={fieldMeta.ariaLabel}
        style={{
          maxHeight: '85vh',
          zIndex: 1000,
        }}
      >
        <div className="pe-sheet-handle" />

        {/* Header */}
        <div className="pe-sheet-header">
          <div>
            <h2 className="pe-sheet-title">{fieldMeta.label}</h2>
            {fieldMeta.description && (
              <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--color-on-surface-variant, #64748b)' }}>
                {fieldMeta.description}
              </p>
            )}
          </div>
          <button
            className="pe-sheet-close-btn"
            onClick={requestClose}
            aria-label="Cerrar editor"
            style={{ minWidth: 44, minHeight: 44 }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Discard Confirm Overlay */}
        {showDiscardConfirm && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(255, 255, 255, 0.95)',
              zIndex: 1010,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              padding: 24,
              textAlign: 'center',
            }}
          >
            <h3 style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 8px', color: '#0f172a' }}>
              ¿Descartar los cambios?
            </h3>
            <p style={{ margin: '0 0 24px', fontSize: '14px', color: '#64748b' }}>
              Modificaste algunos campos pero no los guardaste.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
              <Button
                variant="primary"
                fullWidth
                onClick={() => setShowDiscardConfirm(false)}
                style={{ minHeight: 44 }}
              >
                Seguir editando
              </Button>
              <Button
                variant="outline"
                fullWidth
                onClick={() => {
                  setShowDiscardConfirm(false);
                  onClose();
                }}
                style={{ minHeight: 44, color: '#dc2626', borderColor: '#fecaca' }}
              >
                Descartar
              </Button>
            </div>
          </div>
        )}

        {/* Error Alert */}
        {error && (
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 14px',
              borderRadius: 10,
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#dc2626',
              fontSize: '13px',
              fontWeight: 500,
              marginBottom: 16,
            }}
          >
            <AlertCircle size={16} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}

        {/* Content per Field */}
        <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 16 }}>
          {/* ================================================================ */}
          {/* FIELD: date_options                                              */}
          {/* ================================================================ */}
          {field === 'date_options' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Alert: Prompt convert to fixed when leaving 1 option */}
              {pendingConvertToFixedOption && (
                <div
                  style={{
                    background: '#fffbeb',
                    border: '1.5px solid #fde68a',
                    borderRadius: 12,
                    padding: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <AlertCircle size={18} color="#d97706" style={{ flexShrink: 0, marginTop: 2 }} />
                    <div>
                      <p style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#92400e' }}>
                        Con una sola opción, el encuentro pasa a fecha fija.
                      </p>
                      <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#b45309' }}>
                        ¿Querés establecer el encuentro para {formatHumanSchedule(pendingConvertToFixedOption.date, pendingConvertToFixedOption.time, { locale: appLanguage })}?
                      </p>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCancelConvertToFixed}
                      style={{ minHeight: 44 }}
                    >
                      Cancelar
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleConfirmConvertToFixed}
                      style={{ minHeight: 44 }}
                    >
                      Convertir a fecha fija
                    </Button>
                  </div>
                </div>
              )}

              {dateOptionsBuffer.map((opt, idx) => {
                const optMinTime = opt.date === localToday ? undefined : undefined;
                return (
                  <div
                    key={`opt_${idx}`}
                    style={{
                      background: 'var(--color-surface-variant, #f8fafc)',
                      border: '1px solid var(--color-outline-variant, #e2e8f0)',
                      borderRadius: 12,
                      padding: 14,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--color-primary, #4f46e5)' }}>
                        Opción {idx + 1}
                      </span>
                      {dateOptionsBuffer.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRequestRemoveOption(idx)}
                          aria-label={`Eliminar opción ${idx + 1}`}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#dc2626',
                            cursor: 'pointer',
                            padding: 6,
                            borderRadius: 6,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            minWidth: 44,
                            minHeight: 44,
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div className="input-group" style={{ margin: 0 }}>
                        <label className="input-label" style={{ fontSize: '12px' }}>Fecha</label>
                        <Input
                          type="date"
                          value={opt.date}
                          min={localToday}
                          aria-label={`Fecha opción ${idx + 1}`}
                          onChange={(e) => handleUpdateOption(idx, 'date', e.target.value)}
                          style={{ height: 48, fontSize: '14px' }}
                        />
                      </div>

                      <div style={{ margin: 0 }}>
                        <TimePicker
                          label="Horario"
                          value={opt.time}
                          minTime={optMinTime}
                          onChange={(time) => handleUpdateOption(idx, 'time', time)}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Add Option Button */}
              {dateOptionsBuffer.length < 3 ? (
                <button
                  type="button"
                  onClick={handleAddOption}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: '12px',
                    borderRadius: 12,
                    border: '1.5px dashed var(--color-primary, #4f46e5)',
                    background: 'transparent',
                    color: 'var(--color-primary, #4f46e5)',
                    fontSize: '14px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    minHeight: 44,
                  }}
                >
                  <Plus size={16} />
                  <span>Agregar opción</span>
                </button>
              ) : (
                <p style={{ margin: 0, fontSize: '12px', textAlign: 'center', color: '#64748b' }}>
                  Podés coordinar hasta 3 opciones.
                </p>
              )}
            </div>
          )}

          {/* ================================================================ */}
          {/* FIELD: fixed_datetime                                            */}
          {/* ================================================================ */}
          {field === 'fixed_datetime' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="input-group" style={{ margin: 0 }}>
                <label className="input-label">Fecha del encuentro</label>
                <Input
                  type="date"
                  value={fixedDate}
                  min={localToday}
                  aria-label="Fecha del encuentro"
                  onChange={(e) => {
                    setFixedDate(e.target.value);
                    setError(null);
                  }}
                  style={{ height: 48, fontSize: '15px' }}
                />
              </div>

              <div>
                <TimePicker
                  label="Horario del encuentro"
                  value={fixedTime}
                  onChange={(time) => {
                    setFixedTime(time);
                    setError(null);
                  }}
                />
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* FIELD: title                                                     */}
          {/* ================================================================ */}
          {field === 'title' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="input-group" style={{ margin: 0 }}>
                <label className="input-label">Título o motivo</label>
                <Input
                  ref={titleInputRef}
                  type="text"
                  value={titleBuffer}
                  maxLength={100}
                  placeholder="Ej: Cena con amigos, Cumpleaños, Asado..."
                  aria-label="Título del encuentro"
                  onChange={(e) => {
                    setTitleBuffer(e.target.value);
                    setError(null);
                  }}
                  style={{ height: 48, fontSize: '15px' }}
                />
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* FIELD: location                                                  */}
          {/* ================================================================ */}
          {field === 'location' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label className="input-label" style={{ marginBottom: 8, display: 'block' }}>
                  Modalidad
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => {
                      setModalityBuffer('presencial');
                      setError(null);
                    }}
                    style={{
                      flex: 1,
                      padding: '10px 14px',
                      borderRadius: 10,
                      border: modalityBuffer === 'presencial' ? '2px solid var(--color-primary, #4f46e5)' : '1px solid #cbd5e1',
                      background: modalityBuffer === 'presencial' ? 'var(--color-primary-container, #eef2ff)' : '#ffffff',
                      color: modalityBuffer === 'presencial' ? 'var(--color-primary, #4f46e5)' : '#334155',
                      fontWeight: 600,
                      fontSize: '14px',
                      cursor: 'pointer',
                      minHeight: 44,
                    }}
                  >
                    Presencial
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setModalityBuffer('virtual');
                      setError(null);
                    }}
                    style={{
                      flex: 1,
                      padding: '10px 14px',
                      borderRadius: 10,
                      border: modalityBuffer === 'virtual' ? '2px solid var(--color-primary, #4f46e5)' : '1px solid #cbd5e1',
                      background: modalityBuffer === 'virtual' ? 'var(--color-primary-container, #eef2ff)' : '#ffffff',
                      color: modalityBuffer === 'virtual' ? 'var(--color-primary, #4f46e5)' : '#334155',
                      fontWeight: 600,
                      fontSize: '14px',
                      cursor: 'pointer',
                      minHeight: 44,
                    }}
                  >
                    Videollamada
                  </button>
                </div>
              </div>

              <div className="input-group" style={{ margin: 0 }}>
                <label className="input-label">
                  {modalityBuffer === 'virtual' ? 'Link o plataforma virtual' : 'Lugar o dirección'}
                </label>
                <Input
                  type="text"
                  value={locationBuffer}
                  placeholder={modalityBuffer === 'virtual' ? 'Ej: meet.google.com/abc, Zoom...' : 'Ej: Casa de Juan, Bar Palermo...'}
                  aria-label={modalityBuffer === 'virtual' ? 'Link o plataforma virtual' : 'Lugar o dirección'}
                  onChange={(e) => {
                    setLocationBuffer(e.target.value);
                    setError(null);
                  }}
                  style={{ height: 48, fontSize: '15px' }}
                />
              </div>
            </div>
          )}

          {/* ================================================================ */}
          {/* FIELD: theme                                                     */}
          {/* ================================================================ */}
          {field === 'theme' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label className="input-label" style={{ marginBottom: 8, display: 'block' }}>
                  Categoría de tema
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                  {INVITATION_THEMES.map((th) => {
                    const isSelected = themeBuffer === th.id;
                    return (
                      <button
                        key={th.id}
                        type="button"
                        onClick={() => {
                          setThemeBuffer(th.id);
                          setTemplateBuffer(getDefaultInvitationTemplate(th.id) || '');
                          setError(null);
                        }}
                        style={{
                          padding: '10px 12px',
                          borderRadius: 10,
                          border: isSelected ? '2px solid var(--color-primary, #4f46e5)' : '1px solid #e2e8f0',
                          background: isSelected ? 'var(--color-primary-container, #eef2ff)' : '#ffffff',
                          color: isSelected ? 'var(--color-primary, #4f46e5)' : '#1e293b',
                          fontWeight: isSelected ? 700 : 500,
                          fontSize: '13px',
                          textAlign: 'left',
                          cursor: 'pointer',
                          minHeight: 44,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <span>{th.label}</span>
                        {isSelected && <Check size={14} color="var(--color-primary, #4f46e5)" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Template variants for selected category */}
              <div>
                <label className="input-label" style={{ marginBottom: 8, display: 'block' }}>
                  Variante de diseño
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {getTemplateOptionsForTheme(themeBuffer).map((tmpl) => {
                    const isSelected = templateBuffer === tmpl.id;
                    return (
                      <button
                        key={tmpl.id}
                        type="button"
                        onClick={() => {
                          setTemplateBuffer(tmpl.id);
                          setError(null);
                        }}
                        style={{
                          padding: '10px 14px',
                          borderRadius: 8,
                          border: isSelected ? '2px solid var(--color-primary, #4f46e5)' : '1px solid #e2e8f0',
                          background: isSelected ? 'var(--color-primary-container, #f8faff)' : '#ffffff',
                          color: isSelected ? 'var(--color-primary, #4f46e5)' : '#334155',
                          fontWeight: isSelected ? 700 : 500,
                          fontSize: '13px',
                          textAlign: 'left',
                          cursor: 'pointer',
                          minHeight: 44,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <span>{tmpl.name}</span>
                        {isSelected && <Check size={14} color="var(--color-primary, #4f46e5)" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div
          style={{
            display: 'flex',
            gap: 12,
            paddingTop: 16,
            borderTop: '1px solid var(--color-outline-variant, #e2e8f0)',
          }}
        >
          <Button
            variant="outline"
            fullWidth
            onClick={onClose}
            style={{ minHeight: 44 }}
          >
            Cancelar
          </Button>

          <Button
            variant="primary"
            fullWidth
            onClick={() => {
              if (field === 'date_options') handleSaveDateOptionsClick();
              else if (field === 'fixed_datetime') handleSaveFixedDateTimeClick();
              else if (field === 'title') handleSaveTitleClick();
              else if (field === 'location') handleSaveLocationClick();
              else if (field === 'theme') handleSaveThemeClick();
            }}
            style={{ minHeight: 44 }}
          >
            Guardar
          </Button>
        </div>
      </div>
    </>
  );
};
