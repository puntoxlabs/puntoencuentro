import React, { useState, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useWizardStore } from '@/store/wizardStore';

const Step3Location: React.FC = () => {
  const { modalidad, lugar_texto, link_virtual, setField, nextStep } = useWizardStore();
  const [isNavigating, setIsNavigating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const isPresencial = modalidad === 'presencial';
  const isValid = isPresencial ? lugar_texto.trim() !== '' : link_virtual.trim() !== '';

  useEffect(() => {
    // Timeout corto para asegurar que el teclado abra en mobile al montar la pantalla
    const timer = setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  const handleNext = () => {
    if (isNavigating) return;
    setIsNavigating(true);
    nextStep();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isValid) handleNext();
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setField('link_virtual', text);
    } catch (err) { console.error('Failed to read clipboard', err); }
  };

  return (
    <div className="cw-container">
      <div className="cw-step-header cw-step-header--padded">
        {isPresencial ? (
          <>
            <h2 className="cw-step-title">📍 ¿Dónde se encuentran?</h2>
            <p className="cw-step-subtitle">Indicá el lugar donde se van a ver.</p>
          </>
        ) : (
          <>
            <h2 className="cw-step-title">💻 Link de videollamada</h2>
            <p className="cw-step-subtitle">Pegá el enlace de la reunión virtual.</p>
          </>
        )}
      </div>

      <div className="cw-form-body">
        {isPresencial ? (
          <Input
            ref={inputRef}
            label="Lugar"
            value={lugar_texto}
            onChange={(e) => setField('lugar_texto', e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ej: Club Padel Norte - Av. Libertador 1234"
          />
        ) : (
          <div>
            <Input
              ref={inputRef}
              label="Enlace"
              type="url"
              value={link_virtual}
              onChange={(e) => setField('link_virtual', e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ej: https://meet.google.com/abc"
            />
            <p className="cw-helper-text">
              Pegá el enlace de Google Meet, Zoom o similar.
            </p>
            <Button
              variant="outline"
              onClick={handlePaste}
              className="cw-link-paste-btn"
            >
              Pegar enlace
            </Button>
          </div>
        )}
      </div>

      <div className="cw-bottom-actions">
        <Button fullWidth onClick={handleNext} disabled={!isValid || isNavigating}>
          Continuar
        </Button>
      </div>
    </div>
  );
};

export default Step3Location;
