import React, { useState } from 'react';
import { useCoordinationWizardStore } from '@/store/coordinationWizardStore';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Plus, Trash2 } from 'lucide-react';
import { isArgentinaDateTimeInFuture, buildArgentinaDeadlineIso, buildArgentinaLocalKey, compareArgentinaLocalDateTimes } from '@/lib/argentinaDateTime';
import { TimePicker } from '@/components/ui/TimePicker';
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
      setOptions([
        { localId: generateLocalId(), date: '', time: '' },
        { localId: generateLocalId(), date: '', time: '' },
      ]);
    }
  }, [draft.options.length, setOptions]);

  const [hasDeadline, setHasDeadline] = useState(!!draft.responseDeadline);
  const [deadlineDate, setDeadlineDate] = useState(draft.responseDeadline ? draft.responseDeadline.split('T')[0] : '');
  const [deadlineTime, setDeadlineTime] = useState(draft.responseDeadline ? draft.responseDeadline.split('T')[1].substring(0, 5) : '');

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
      if (!opt.date || !opt.time) {
        newErrors[`opt_${opt.localId}`] = 'Completá fecha y hora';
        return;
      }
      if (!isArgentinaDateTimeInFuture(opt.date, opt.time)) {
        newErrors[`opt_${opt.localId}`] = 'Todas las opciones deben ser futuras.';
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
    }
  };

  return (
    <div className="pe-wizard-step fade-in" style={{ padding: '20px', display: 'flex', flexDirection: 'column', flex: 1 }}>
      <div style={{ flex: 1 }}>
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8, color: 'var(--pe-text)' }}>
          Proponé algunas opciones
        </h2>
        <p style={{ color: 'var(--pe-text-muted)', marginBottom: 24, fontSize: 15, lineHeight: 1.5 }}>
          Tus invitados podrán indicar en cuáles están disponibles y marcar una preferida.
        </p>

        {errors.global && (
          <p style={{ color: 'var(--pe-error)', fontSize: 14, marginBottom: 16 }}>{errors.global}</p>
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
                    value={opt.date}
                    onChange={(e) => handleOptionChange(opt.localId, 'date', e.target.value)}
                  />
                </div>
                <div style={{ flex: '1 1 140px' }}>
                  <TimePicker
                    value={opt.time}
                    onChange={(val) => handleOptionChange(opt.localId, 'time', val)}
                    placeholder="HH:MM"
                    minTime={opt.date === new Date().toISOString().split('T')[0] ? new Date().toTimeString().substring(0, 5) : undefined}
                  />
                </div>
              </div>
              {opt.date && opt.time && !errors[`opt_${opt.localId}`] && (
                <div style={{ marginTop: 12, fontSize: 14, color: 'var(--pe-text-muted)' }}>
                  {new Date(opt.date + 'T' + opt.time).toLocaleString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' })} · {opt.time}
                </div>
              )}
              {errors[`opt_${opt.localId}`] && (
                <p style={{ color: 'var(--pe-error)', fontSize: 13, marginTop: 8, marginBottom: 0 }}>{errors[`opt_${opt.localId}`]}</p>
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
                    value={deadlineDate}
                    onChange={(e) => {
                      setDeadlineDate(e.target.value);
                      setErrors({});
                    }}
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
                <p style={{ color: 'var(--pe-error)', fontSize: 13, marginTop: 8, marginBottom: 0 }}>{errors.deadline}</p>
              )}
            </div>
          )}

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
