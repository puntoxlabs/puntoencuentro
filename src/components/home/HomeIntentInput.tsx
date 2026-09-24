import React, { useRef, useEffect } from 'react';
import { Mic, Square, X, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useSpeechDictation, getSpeechRecognitionLocale } from '@/hooks/useSpeechDictation';
import './HomeIntentInput.css';

interface HomeIntentInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  isSubmitting?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

export const HomeIntentInput: React.FC<HomeIntentInputProps> = ({
  value,
  onChange,
  onSubmit,
  isSubmitting = false,
  placeholder = 'Quiero organizar una cena con amigos el sábado...',
  disabled = false,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    isListening,
    isSupported: isSpeechSupported,
    startListening,
    stopListening,
  } = useSpeechDictation({
    lang: getSpeechRecognitionLocale('es'),
    onTranscriptChange: (newText) => {
      onChange(newText);
    },
  });

  // Auto-resize textarea height smoothly
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 72), 160)}px`;
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.key === 'Enter' && !e.shiftKey) || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
      e.preventDefault();
      if (value.trim() && !isSubmitting && !disabled) {
        if (isListening) stopListening();
        onSubmit();
      }
    }
  };

  const handleMicClick = () => {
    if (disabled || isSubmitting) return;
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  const handleClear = () => {
    if (disabled || isSubmitting) return;
    if (isListening) stopListening();
    onChange('');
    textareaRef.current?.focus();
  };

  const isValid = Boolean(value.trim());

  return (
    <div className="home-intent-wrapper">
      <div className="home-intent-card" onClick={() => textareaRef.current?.focus()}>
        <textarea
          ref={textareaRef}
          className="home-intent-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || isSubmitting}
          rows={3}
          aria-label="¿Qué querés hacer?"
          data-testid="home-intent-textarea"
        />

        <div className="home-intent-actions">
          <div className="home-intent-tools">
            {isSpeechSupported && (
              <button
                type="button"
                className={`home-intent-tool-btn ${isListening ? 'home-intent-tool-btn--active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleMicClick();
                }}
                title={isListening ? 'Detener dictado' : 'Dictar por voz'}
                aria-label={isListening ? 'Detener dictado' : 'Dictar por voz'}
                disabled={disabled || isSubmitting}
              >
                {isListening ? <Square size={16} /> : <Mic size={18} />}
              </button>
            )}

            {value && (
              <button
                type="button"
                className="home-intent-tool-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClear();
                }}
                title="Borrar texto"
                aria-label="Borrar texto"
                disabled={disabled || isSubmitting}
              >
                <X size={16} />
              </button>
            )}
          </div>

          <span className="home-intent-hint">
            {isListening ? 'Escuchando…' : 'Enter para enviar'}
          </span>
        </div>
      </div>

      <Button
        variant="primary"
        fullWidth
        className="home-intent-submit-btn"
        disabled={!isValid || isSubmitting || disabled}
        onClick={() => {
          if (isListening) stopListening();
          onSubmit();
        }}
        data-testid="home-intent-submit-btn"
      >
        {isSubmitting ? (
          <>
            <span className="home-intent-spinner" />
            <span>Preparando encuentro…</span>
          </>
        ) : (
          <>
            <Sparkles size={18} />
            <span>Hacer que pase</span>
          </>
        )}
      </Button>
    </div>
  );
};
