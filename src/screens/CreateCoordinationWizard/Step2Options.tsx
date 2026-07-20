import React, { useState, useRef, useEffect } from 'react';
import { useCoordinationWizardStore } from '@/store/coordinationWizardStore';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Plus, Trash2 } from 'lucide-react';
import { isArgentinaDateTimeInFuture, buildArgentinaDeadlineIso, buildArgentinaLocalKey, compareArgentinaLocalDateTimes, getArgentinaTodayISO } from '@/lib/argentinaDateTime';
import { TimePicker } from '@/components/ui/TimePicker';
import type { TimePickerRef } from '@/components/ui/TimePicker';
import { AlertCircle } from 'lucide-react';
import { SelectableOptionCard } from '@/components/ui/SelectableOptionCard';

interface Step2OptionsProps {
  onNext: () => void;
  onBack: () => void;
}

const generateLocalId = () => Math.random().toString(36).substr(2, 9);

const Step2Options: React.FC<Step2OptionsProps> = ({ onNext, onBack }) => {
  const { draft, updateDraft, setOptions } = useCoordinationWizardStore();
  const [errors, setErrors] = useState<{ [key: string]: string }>({});

  // Initialize with 2 options if empty
  React.useEffect(() => {
    if (draft.options.length === 0) {
      const today = getArgentinaTodayISO();
      setOptions([
        { localId: generateLocalId(), date: today, time: '' },
        { localId: generateLocalId(), date: '', time: '' },
      ]);
    }
  }, [draft.options.length, setOptions]);

  const [hasDeadline, setHasDeadline] = useState(!!draft.responseDeadline);
  const [deadlineDate, setDeadlineDate] = useState(draft.responseDeadline ? draft.responseDeadline.split('T')[0] : '');
  const [deadlineTime, setDeadlineTime] = useState(draft.responseDeadline ? draft.responseDeadline.split('T')[1].substring(0, 5) : '');

  const firstDateRef = useRef<HTMLInputElement>(null);
  const firstTimePickerRef = useRef<TimePickerRef>(null);
  const didAutoFocusRef = useRef(false);
  const localToday = getArgentinaTodayISO();

  useEffect(() => {
    if (didAutoFocusRef.current || draft.options.length === 0) return;
    didAutoFocusRef.current = true;
    
    // Auto focus primer campo útil
    const runFocus = () => {
      const firstOpt = draft.options[0];
      if (firstOpt && firstOpt.date === localToday) {
        const timePicker = firstTimePickerRef.current;
        if (timePicker) {
          window.scrollTo({ top: 0, behavior: 'auto' });
          timePicker.focus();
        }
      } else {
        const input = firstDateRef.current;
        if (input) {
          window.scrollTo({ top: 0, behavior: 'auto' });
          input.focus();
        }
      }
    };

    requestAnimationFrame(() => {
      setTimeout(runFocus, 120);
    });
  }, [draft.options]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>, nextFieldSelector?: string, localId?: string, isTime?: boolean) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      
      if (localId) {
        const opt = draft.options.find(o => o.localId === localId);
        if (opt) {
          if (!isTime) {
            if (!opt.date) { setErrors({ ...errors, [`opt_${localId}`]: 'Completá la fecha' }); return; }
            if (opt.date < localToday) { setErrors({ ...errors, [`opt_${localId}`]: 'La fecha debe ser igual o posterior a hoy.' }); return; }
          } else {
            if (!opt.time) { setErrors({ ...errors, [`opt_${localId}`]: 'Completá la hora' }); return; }
            if (!isArgentinaDateTimeInFuture(opt.date, opt.time)) {
               setErrors({ ...errors, [`opt_${localId}`]: 'La hora debe ser posterior a la actual.' }); return; 
            }
          }
        }
      }

      if (nextFieldSelector) {
        const nextElement = document.querySelector(nextFieldSelector) as HTMLElement;
        if (nextElement && 'focus' in nextElement) {
          nextElement.focus();
        }
      }
    }
  };

  const handleAddOption = () => {
    if (draft.options.length < 3) {
      setOptions([...draft.options, { localId: generateLocalId(), date: '', time: '' }]);
    }
  };

  const handleRemoveOption = (localId: string) => {
    if (draft.options.length > 2) {
      setOptions(draft.options.filter(o => o.localId !== localId));
      // Reset errors to avoid orphaned errors
      setErrors({});
    }
  };

  const handleOptionChange = (localId: string, field: 'date' | 'time', value: string) => {
    setOptions(draft.options.map(o => o.localId === localId ? { ...o, [field]: value } : o));
    setErrors({});
  };

  const validate = () => {
    const newErrors: { [key: string]: string } = {};
    const signatures = new Set<string>();
    let earliestOptionKey: string | null = null;

    draft.options.forEach((opt) => {
      if (!opt.date) {
        newErrors[`opt_${opt.localId}`] = 'Completá la fecha.';
        return;
      }
      if (opt.date < localToday) {
        newErrors[`opt_${opt.localId}`] = 'La fecha debe ser igual o posterior a hoy.';
        return;
      }
      if (!opt.time) {
        newErrors[`opt_${opt.localId}`] = 'Completá la hora.';
        return;
      }
      if (!isArgentinaDateTimeInFuture(opt.date, opt.time)) {
        newErrors[`opt_${opt.localId}`] = 'La hora debe ser posterior a la actual.';
        return;
      }
      const sig = buildArgentinaLocalKey(opt.date, opt.time);
      if (signatures.has(sig)) {
        newErrors[`opt_${opt.localId}`] = 'No puede haber dos opciones iguales.';
      }
      signatures.add(sig);

      if (!earliestOptionKey || compareArgentinaLocalDateTimes(earliestOptionKey, sig) > 0) {
        earliestOptionKey = sig;
      }
    });

    if (draft.options.length < 2) {
      newErrors.global = 'Agregá al menos dos opciones.';
    }

    if (hasDeadline) {
      if (!deadlineDate || !deadlineTime) {
        newErrors.deadline = 'Completá la fecha y hora del plazo.';
      } else {
        if (!isArgentinaDateTimeInFuture(deadlineDate, deadlineTime)) {
          newErrors.deadline = 'El plazo debe ser futuro.';
        } else if (earliestOptionKey) {
          const deadlineKey = buildArgentinaLocalKey(deadlineDate, deadlineTime);
          if (compareArgentinaLocalDateTimes(deadlineKey, earliestOptionKey) >= 0) {
            newErrors.deadline = 'El plazo debe finalizar antes de la primera opción.';
          }
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleNext = () => {
    if (validate()) {
      // Sort options chronologically
      const sorted = [...draft.options].sort((a, b) => {
        return a.date.localeCompare(b.date) || a.time.localeCompare(b.time);
      });
      setOptions(sorted);

      if (hasDeadline && deadlineDate && deadlineTime) {
        const isoString = buildArgentinaDeadlineIso(deadlineDate, deadlineTime);
        updateDraft({ responseDeadline: isoString });
      } else {
        updateDraft({ responseDeadline: null });
      }

      onNext();
    } else {
      setTimeout(() => {
        const firstError = document.querySelector('.input-error, [style*="color: #DC2626"]');
        if (firstError) {
          firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
          (firstError as HTMLElement).focus?.();
        }
      }, 50);
    }
  };

  return (
    <div className="pe-wizard-step fade-in" style={{ padding: '20px', display: 'flex', flexDirection: 'column', flex: 1, paddingBottom: '120px' }}>
      <div style={{ flex: 1 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8, color: 'var(--pe-text)' }}>
          Proponé algunas opciones
        </h2>
        <p style={{ color: 'var(--pe-text-muted)', marginBottom: 24, fontSize: 15, lineHeight: 1.5 }}>
          Tus invitados podrán indicar en cuáles están disponibles y marcar una preferida.
        </p>

        {errors.global && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, color: '#DC2626', marginBottom: 16 }}>
            <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            <p style={{ margin: 0, fontSize: 14, fontWeight: 500 }}>{errors.global}</p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
          {draft.options.map((opt, index) => (
            <div key={opt.localId} style={{ background: 'var(--pe-bg-hover)', padding: 16, borderRadius: 12, border: '1px solid var(--pe-border)', position: 'relative' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--pe-text)' }}>Opción {index + 1}</span>
                {draft.options.length > 2 && (
                  <button
                    onClick={() => handleRemoveOption(opt.localId)}
                    style={{ background: 'none', border: 'none', color: 'var(--pe-error)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 4 }}
                    aria-label={`Eliminar opción ${index + 1}`}
                    type="button"
                  >
                    <Trash2 size={18} />
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 140px' }}>
                  <Input
                    type="date"
                    id={`opt-date-${index}`}
                    min={localToday}
                    ref={index === 0 ? firstDateRef : undefined}
                    value={opt.date}
                    enterKeyHint="next"
                    error={errors[`opt_${opt.localId}`] ? " " : undefined} 
                    onKeyDown={(e) => handleKeyDown(e, `#opt-time-${index}`, opt.localId, false)}
                    onChange={(e) => handleOptionChange(opt.localId, 'date', e.target.value)}
                  />
                </div>
                <div style={{ flex: '1 1 140px' }} id={`opt-time-${index}`} tabIndex={-1}>
                  <TimePicker
                    ref={index === 0 ? firstTimePickerRef : undefined}
                    value={opt.time}
                    onChange={(val) => handleOptionChange(opt.localId, 'time', val)}
                    placeholder="HH:MM"
                    onKeyDown={(e) => handleKeyDown(e, index < draft.options.length - 1 ? `#opt-date-${index + 1}` : undefined, opt.localId, true)}
                    minTime={opt.date === localToday ? new Date().toTimeString().substring(0, 5) : undefined}
                  />
                </div>
              </div>
              {opt.date && opt.time && !errors[`opt_${opt.localId}`] && (
                <div style={{ marginTop: 12, fontSize: 14, color: 'var(--pe-text-muted)' }}>
                  {new Date(opt.date + 'T' + opt.time).toLocaleString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' })} · {opt.time}
                </div>
              )}
              {errors[`opt_${opt.localId}`] && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, color: '#DC2626', marginTop: 10 }}>
                  <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                  <p style={{ fontWeight: 500, fontSize: 13, margin: 0 }}>{errors[`opt_${opt.localId}`]}</p>
                </div>
              )}
            </div>
          ))}
        </div>

        {draft.options.length < 3 && (
          <Button
            variant="outline"
            fullWidth
            onClick={handleAddOption}
            style={{ marginBottom: 32 }}
          >
            <Plus size={18} style={{ marginRight: 8 }} />
            Agregar otra opción
          </Button>
        )}

        <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid var(--pe-border)' }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--pe-text)', marginBottom: 8 }}>
            Plazo para responder
          </h3>
          <p style={{ color: 'var(--pe-text-muted)', marginBottom: 16, fontSize: 14, lineHeight: 1.4 }}>
            Después de este momento ya no se aceptarán nuevas disponibilidades.
          </p>

          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexDirection: 'row' }}>
            <div style={{ flex: 1 }}>
              <SelectableOptionCard
                compact
                title="Sin plazo"
                selected={!hasDeadline}
                onClick={() => {
                  setHasDeadline(false);
                  setErrors({});
                }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <SelectableOptionCard
                compact
                title="Definir plazo"
                selected={hasDeadline}
                onClick={() => setHasDeadline(true)}
              />
            </div>
          </div>

          {hasDeadline && (
            <div className="slide-from-right" style={{ background: 'var(--pe-bg-hover)', padding: 16, borderRadius: 12, border: '1px solid var(--pe-border)' }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 140px' }}>
                  <Input
                    type="date"
                    min={localToday}
                    value={deadlineDate}
                    onChange={(e) => {
                      setDeadlineDate(e.target.value);
                      setErrors({});
                    }}
                    error={errors.deadline ? " " : undefined}
                  />
                </div>
                <div style={{ flex: '1 1 140px' }}>
                  <TimePicker
                    value={deadlineTime}
                    placeholder="HH:MM"
                    onChange={(val) => {
                      setDeadlineTime(val);
                      setErrors({});
                    }}
                  />
                </div>
              </div>
              {errors.deadline && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, color: '#DC2626', marginTop: 10 }}>
                  <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                  <p style={{ fontWeight: 500, fontSize: 13, margin: 0 }}>{errors.deadline}</p>
                </div>
              )}
            </div>
          )}
          
          <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--pe-text)', marginTop: 24, marginBottom: 16 }}>
            Visibilidad de respuestas
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SelectableOptionCard
              title="No mostrar respuestas"
              description="Los invitados no verán las respuestas de los demás."
              selected={draft.visibilidadRespuestas === 'hidden'}
              onClick={() => updateDraft({ visibilidadRespuestas: 'hidden', mostrarRespuestasAInvitados: false })}
            />
            <SelectableOptionCard
              title="Resumen anónimo"
              description="Los invitados verán un conteo anónimo por opción."
              selected={draft.visibilidadRespuestas === 'summary'}
              onClick={() => updateDraft({ visibilidadRespuestas: 'summary', mostrarRespuestasAInvitados: true })}
            />
            <SelectableOptionCard
              title="Detalle por invitado"
              description="Otros invitados verán el nombre declarado y disponibilidad por fecha."
              selected={draft.visibilidadRespuestas === 'detail'}
              onClick={() => updateDraft({ visibilidadRespuestas: 'detail', mostrarRespuestasAInvitados: true })}
            />
          </div>

        </div>
      </div>

      <div style={{ position: 'sticky', bottom: 0, padding: '16px 0', background: 'var(--pe-bg)', marginTop: 'auto', display: 'flex', gap: 12 }}>
        <Button variant="outline" onClick={onBack} style={{ flex: 1 }}>
          Atrás
        </Button>
        <Button variant="primary" onClick={handleNext} style={{ flex: 2 }}>
          Siguiente
        </Button>
      </div>
    </div>
  );
};

export default Step2Options;
