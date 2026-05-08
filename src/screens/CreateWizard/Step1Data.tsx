import React, { useState, useRef } from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { ThemePicker } from '@/components/ui/ThemePicker';
import { TimePicker } from '@/components/ui/TimePicker';
import type { TimePickerRef } from '@/components/ui/TimePicker';
import { useWizardStore } from '@/store/wizardStore';
import type { ThemeId } from '@/lib/themes';
import { validateEncounterDate } from '@/lib/formatDate';
import { useTranslation } from 'react-i18next';

const Step1Data: React.FC = () => {
  const { t } = useTranslation();
  const { titulo, fecha, hora, descripcion, tema, setField, nextStep } = useWizardStore();
  const [error, setError] = useState<string | null>(null);
  const [isNavigating, setIsNavigating] = useState(false);
  const [highlightDescripcion, setHighlightDescripcion] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const timeInputRef = useRef<TimePickerRef>(null);
  const descripcionContainerRef = useRef<HTMLDivElement>(null);
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);

  const now = new Date();
  const localYear = now.getFullYear();
  const localMonth = String(now.getMonth() + 1).padStart(2, '0');
  const localDay = String(now.getDate()).padStart(2, '0');
  const minDate = `${localYear}-${localMonth}-${localDay}`;

  const isToday = fecha === minDate;
  const minTime = isToday ? `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` : undefined;

  const isValid = titulo.trim() !== '' && fecha !== '' && hora !== '';

  const handleNext = () => {
    if (isNavigating) return;
    const validationError = validateEncounterDate(fecha, hora);
    if (validationError) {
      setError(validationError === "La fecha y hora deben ser futuras" ? t('invalid_datetime', 'La fecha y hora deben ser futuras') : validationError);
      return;
    }
    setError(null);
    setIsNavigating(true);
    nextStep();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>, nextRef?: React.RefObject<any>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (nextRef && nextRef.current) {
        const target = nextRef.current;

        // Si el target tiene openPicker (TimePicker custom), abrirlo
        if ('openPicker' in target && typeof target.openPicker === 'function') {
          if ('focus' in target && typeof target.focus === 'function') target.focus();
          setTimeout(() => target.openPicker(), 100);

        // Si es un input de tipo date: solo focus (el onFocus se encarga de abrir el picker en desktop)
        } else if (target instanceof HTMLInputElement && target.type === 'date') {
          target.focus();
          // En mobile, intentamos abrir el picker explícitamente al presionar Enter
          const isMobile = window.matchMedia("(pointer: coarse)").matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
          if (isMobile && 'showPicker' in target && typeof target.showPicker === 'function') {
            try {
              target.showPicker();
            } catch (err) {
              console.warn('showPicker blocked or failed', err);
            }
          }

        // Si es un textarea u otro elemento: solo scroll, NO focus (evita teclado en Android)
        } else if (target instanceof HTMLTextAreaElement) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });

        } else {
          if ('focus' in target && typeof target.focus === 'function') target.focus();
        }
      }
    }
  };

  const handleDateFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    const isMobile = window.matchMedia("(pointer: coarse)").matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    if (!isMobile && 'showPicker' in e.target && typeof (e.target as any).showPicker === 'function') {
      try {
        (e.target as any).showPicker();
      } catch {
        // Silenciar errores si showPicker falla (ej: no detecta gesto de usuario)
      }
    }
  };


  const handleDescriptionKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (isValid && !isNavigating) {
          handleNext();
        }
      }
      // If it's just Enter without Ctrl/Meta, we don't preventDefault, allowing the newline
    }
  };

  const handleFechaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setField('fecha', val);
    
    // Si cambia a una fecha donde la hora actual ya no es válida, validamos
    const err = validateEncounterDate(val, hora);
    setError(err === "La fecha y hora deben ser futuras" ? t('invalid_datetime', 'La fecha y hora deben ser futuras') : err);

    // Si la fecha es hoy y no hay hora, o la hora es vieja, podríamos sugerir una
    if (val === minDate && (!hora || validateEncounterDate(val, hora))) {
      const nextHour = new Date(now.getTime() + 60 * 60 * 1000);
      nextHour.setMinutes(0);
      const sugTime = `${String(nextHour.getHours()).padStart(2, '0')}:00`;
      setField('hora', sugTime);
      setError(null); // Al sugerir una válida, limpiamos el error
    }

    // Auto-avanzar a hora si la fecha es válida
    if (val && val >= minDate) {
      if (timeInputRef.current) {
        timeInputRef.current.focus();
        setTimeout(() => {
          timeInputRef.current?.openPicker();
        }, 100);
      }
    }
  };

  const handleHoraChange = (val: string) => {
    setField('hora', val);
    if (val) {
      const currentErr = validateEncounterDate(fecha, val);
      setError(currentErr === "La fecha y hora deben ser futuras" ? t('invalid_datetime', 'La fecha y hora deben ser futuras') : currentErr);

      // Scroll al contenedor descripción y aplicar highlight visual, SIN hacer focus (no abre teclado)
      if (!currentErr) {
        setTimeout(() => {
          descripcionContainerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setHighlightDescripcion(true);
          setTimeout(() => setHighlightDescripcion(false), 1000);
        }, 150);
      }
    }
  };


  return (
    <form 
      onSubmit={(e) => e.preventDefault()}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 0 }}
    >
      <div style={{ marginBottom: 8 }}>
        <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>¿Cuándo y dónde?</h2>
        <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)', marginBottom: 4 }}>Ponele un nombre y una fecha a tu encuentro.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-primary)', fontSize: 12, fontWeight: 700 }}>
          <span>✨</span>
          <span>Solo podés crear encuentros futuros.</span>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, paddingTop: 24 }}>
        <Input
          label="Nombre del encuentro"
          value={titulo}
          onChange={(e) => setField('titulo', e.target.value)}
          onKeyDown={(e) => handleKeyDown(e, dateInputRef)}
          placeholder="Ej: Cena de fin de año"
          ref={nameInputRef}
          enterKeyHint="next"
        />
        <Input
          label="Fecha"
          type="date"
          value={fecha}
          onChange={handleFechaChange}
          onFocus={handleDateFocus}
          onKeyDown={(e) => handleKeyDown(e, timeInputRef)}
          min={minDate}
          ref={dateInputRef}
          enterKeyHint="next"
        />
        <div>
          <TimePicker
            label="Hora"
            value={hora}
            onChange={handleHoraChange}
            minTime={minTime}
            ref={timeInputRef}
            onKeyDown={(e) => handleKeyDown(e, descriptionInputRef)}
            disabled={!fecha}
          />
          <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', marginTop: 8, marginBottom: 8 }}>
            {isToday ? 'Hoy: debe ser posterior a ahora' : 'Cualquier horario disponible'}
          </p>
        </div>
        <div
          ref={descripcionContainerRef}
          className="input-group"
          style={{
            borderRadius: 12,
            transition: 'box-shadow 0.3s ease, border-color 0.3s ease',
            ...(highlightDescripcion ? {
              boxShadow: '0 0 0 2px var(--color-primary, #6366f1), 0 4px 16px rgba(99,102,241,0.13)',
              background: 'var(--color-primary-container, rgba(99,102,241,0.06))',
            } : {}),
          }}
        >
          <label className="input-label">Descripción (opcional)</label>
          <textarea
            className="input-field"
            value={descripcion}
            onChange={(e) => setField('descripcion', e.target.value)}
            onKeyDown={handleDescriptionKeyDown}
            placeholder="Agregá más detalles…"
            ref={descriptionInputRef}
            style={{ minHeight: '80px', paddingTop: '12px', paddingBottom: '12px', resize: 'vertical' }}
            enterKeyHint="done"
          />
        </div>
        <ThemePicker
          value={(tema || 'blue') as ThemeId}
          onChange={(t) => setField('tema', t)}
        />
      </div>

      <div style={{ paddingTop: 24 }}>
        {error && (
          <div style={{ 
            background: 'var(--color-error-container, #fee2e2)', 
            color: 'var(--color-error, #dc2626)', 
            padding: '10px 14px', 
            borderRadius: 12, 
            fontSize: 13, 
            fontWeight: 600, 
            marginBottom: 16,
            textAlign: 'center',
            border: '1px solid var(--color-error, #dc2626)'
          }}>
            {error}
          </div>
        )}
        <Button fullWidth onClick={handleNext} disabled={!isValid || isNavigating}>
          Continuar
        </Button>
      </div>
    </form>
  );
};

export default Step1Data;

