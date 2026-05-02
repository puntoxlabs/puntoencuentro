import React, { useState, useRef } from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { ThemePicker } from '@/components/ui/ThemePicker';
import { useWizardStore } from '@/store/wizardStore';
import type { ThemeId } from '@/lib/themes';
import { validateEncounterDate } from '@/lib/formatDate';

const Step1Data: React.FC = () => {
  const { titulo, fecha, hora, descripcion, tema, setField, nextStep } = useWizardStore();
  const [error, setError] = useState<string | null>(null);
  const [isNavigating, setIsNavigating] = useState(false);

  const fechaRef = useRef<HTMLInputElement>(null);
  const horaRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLInputElement>(null);

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
      setError(validationError);
      return;
    }
    setError(null);
    setIsNavigating(true);
    nextStep();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, nextRef?: React.RefObject<HTMLInputElement | null>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (nextRef && nextRef.current) {
        nextRef.current.focus();
      } else if (isValid && !nextRef) {
        handleNext();
      }
    }
  };

  const handleFechaChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setField('fecha', val);
    
    // Si cambia a una fecha donde la hora actual ya no es válida, validamos
    const err = validateEncounterDate(val, hora);
    setError(err);

    // Si la fecha es hoy y no hay hora, o la hora es vieja, podríamos sugerir una
    if (val === minDate && (!hora || validateEncounterDate(val, hora))) {
      const nextHour = new Date(now.getTime() + 60 * 60 * 1000);
      nextHour.setMinutes(0);
      const sugTime = `${String(nextHour.getHours()).padStart(2, '0')}:00`;
      setField('hora', sugTime);
      setError(null); // Al sugerir una válida, limpiamos el error
    }
  };

  const handleHoraChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setField('hora', val);
    if (val) {
      setError(validateEncounterDate(fecha, val));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 0 }}>
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
          onKeyDown={(e) => handleKeyDown(e, fechaRef)}
          placeholder="Ej: Cena de fin de año"
        />
        <Input
          label="Fecha"
          type="date"
          value={fecha}
          onChange={handleFechaChange}
          onKeyDown={(e) => handleKeyDown(e, horaRef)}
          min={minDate}
          ref={fechaRef}
        />
        <div style={{ position: 'relative' }}>
          <Input
            label="Hora"
            type="time"
            value={hora}
            onChange={handleHoraChange}
            onKeyDown={(e) => handleKeyDown(e, descRef)}
            min={minTime}
            ref={horaRef}
          />
          <p style={{ fontSize: 11, color: 'var(--color-on-surface-variant)', marginTop: -12, marginBottom: 8, opacity: 0.8 }}>
            {isToday ? 'Hoy: debe ser posterior a ahora' : 'Cualquier horario disponible'}
          </p>
        </div>
        <Input
          label="Descripción (opcional)"
          value={descripcion}
          onChange={(e) => setField('descripcion', e.target.value)}
          onKeyDown={(e) => handleKeyDown(e)}
          placeholder="Agregá más detalles…"
          ref={descRef}
        />
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
    </div>
  );
};

export default Step1Data;

