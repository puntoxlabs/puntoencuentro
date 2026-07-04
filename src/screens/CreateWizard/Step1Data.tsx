import React, { useState, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { TimePicker } from '@/components/ui/TimePicker';
import type { TimePickerRef } from '@/components/ui/TimePicker';
import { InvitationThemeSelector } from '@/components/ui/InvitationThemeSelector';
import { KidsBirthdayTemplateSelector } from '@/components/ui/KidsBirthdayTemplateSelector';
import { CelebrationTemplateSelector } from '@/components/ui/CelebrationTemplateSelector';
import { RomanticTemplateSelector } from '@/components/ui/RomanticTemplateSelector';
import { FormalTemplateSelector } from '@/components/ui/FormalTemplateSelector';
import { useWizardStore } from '@/store/wizardStore';
import { validateEncounterDate } from '@/lib/formatDate';
import { useTranslation } from 'react-i18next';

const Step1Data: React.FC = () => {
  const { t } = useTranslation();
  const { titulo, fecha, hora, descripcion, tema_invitacion, invitation_template, setField, nextStep } = useWizardStore();
  const [error, setError] = useState<string | null>(null);
  const [isNavigating, setIsNavigating] = useState(false);
  const [highlightDescripcion, setHighlightDescripcion] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const timeInputRef = useRef<TimePickerRef>(null);
  const descripcionContainerRef = useRef<HTMLDivElement>(null);
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);

  const locationState = useLocation().state as { autoFocusTitle?: boolean } | null;
  const didAutoFocusRef = useRef(false);

  useEffect(() => {
    if (!locationState?.autoFocusTitle) return;
    if (didAutoFocusRef.current) return;

    didAutoFocusRef.current = true;

    const runFocus = () => {
      const input = nameInputRef.current;
      if (!input) return;

      // Primero llevar el formulario arriba.
      window.scrollTo({ top: 0, behavior: 'auto' });

      // Luego enfocar el input sin preventScroll para que el teclado se abra
      input.focus();

      // Asegurar que el campo quede visible después de abrir teclado.
      setTimeout(() => {
        input.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });

        const length = input.value.length;
        input.setSelectionRange(length, length);
        
        // Remove from history state so it doesn't fire again on step-back
        window.history.replaceState({}, document.title);
      }, 250);
    };

    requestAnimationFrame(() => {
      setTimeout(runFocus, 120);
    });
  }, [locationState]);

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
      className="cw-container"
    >
      <div className="cw-step-header">
        <h2 className="cw-step-title">¿Cuándo y dónde?</h2>
        <p className="cw-step-subtitle">Ponele un nombre y una fecha a tu encuentro.</p>
        <div className="cw-step-notice">
          <span>✨</span>
          <span>Solo podés crear encuentros futuros.</span>
        </div>
      </div>

      <div className="cw-form-body">
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
          <p className="cw-helper-text">
            {isToday ? 'Hoy: debe ser posterior a ahora' : 'Cualquier horario disponible'}
          </p>
        </div>
        <div
          ref={descripcionContainerRef}
          className={`input-group cw-textarea-wrapper ${highlightDescripcion ? 'cw-textarea-wrapper--highlight' : ''}`}
        >
          <label className="input-label">Descripción (opcional)</label>
          <textarea
            className="input-field cw-textarea-field"
            value={descripcion}
            onChange={(e) => setField('descripcion', e.target.value)}
            onKeyDown={handleDescriptionKeyDown}
            placeholder="Agregá más detalles…"
            ref={descriptionInputRef}
            enterKeyHint="done"
          />
        </div>
        <InvitationThemeSelector
          value={tema_invitacion || 'classic'}
          onChange={(t) => {
            setField('tema_invitacion', t);
            
            // Siempre limpiar el template al cambiar de tema principal
            let newTemplate: string | null = null;
            
            // Asignar default solo para los temas que lo requieren
            if (t === 'kids_birthday') {
              newTemplate = 'kids_jungle';
            } else if (t === 'celebration') {
              newTemplate = 'celebration_gold';
            }
            
            setField('invitation_template', newTemplate);
          }}
        />
        {tema_invitacion === 'kids_birthday' && (
          <KidsBirthdayTemplateSelector
            selectedTemplateId={invitation_template}
            onSelect={(id) => setField('invitation_template', id)}
          />
        )}
        {tema_invitacion === 'celebration' && (
          <CelebrationTemplateSelector
            selectedTemplateId={invitation_template}
            onSelect={(id) => setField('invitation_template', id)}
          />
        )}
        {tema_invitacion === 'romantic' && (
          <RomanticTemplateSelector
            selectedTemplateId={invitation_template}
            onSelect={(id) => setField('invitation_template', id)}
          />
        )}
        {tema_invitacion === 'formal' && (
          <FormalTemplateSelector
            selectedTemplateId={invitation_template}
            onSelect={(id) => setField('invitation_template', id)}
          />
        )}
      </div>

      <div className="cw-bottom-actions">
        {error && (
          <div className="cw-error-banner">
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

