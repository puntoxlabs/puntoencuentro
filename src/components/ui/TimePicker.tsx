import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, X } from 'lucide-react';
import { Button } from './Button';

export interface TimePickerRef {
  openPicker: () => void;
  closePicker: () => void;
  focus: () => void;
  click: () => void;
}

interface TimePickerProps {
  label?: string;
  value: string;
  onChange: (time: string) => void;
  minTime?: string;
  placeholder?: string;
  disabled?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
}

const generateTimeOptions = () => {
  const options = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      const hour = String(h).padStart(2, '0');
      const minute = String(m).padStart(2, '0');
      options.push(`${hour}:${minute}`);
    }
  }
  return options;
};

const TIME_OPTIONS = generateTimeOptions();

export const TimePicker = forwardRef<TimePickerRef, TimePickerProps>(({
  label,
  value,
  onChange,
  minTime,
  placeholder,
  disabled,
  onKeyDown,
}, ref) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useImperativeHandle(ref, () => ({
    openPicker: () => {
      if (!disabled) setIsOpen(true);
    },
    closePicker: () => setIsOpen(false),
    focus: () => {
      containerRef.current?.focus();
    },
    click: () => {
      if (!disabled) setIsOpen(true);
    }
  }));

  // Handle escape key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen]);

  // Scroll to selected time or current time when opened
  useEffect(() => {
    if (isOpen && scrollRef.current) {
      setTimeout(() => {
        if (selectedRef.current) {
          selectedRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else if (value) {
          // If value is not in options (e.g. 10:12), find closest
          const el = document.getElementById(`time-opt-${value}`);
          if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else {
          // Scroll to current time or minTime
          const now = new Date();
          const curH = String(now.getHours()).padStart(2, '0');
          const curM = String(Math.floor(now.getMinutes() / 15) * 15).padStart(2, '0');
          const targetTime = minTime || `${curH}:${curM}`;
          const el = document.getElementById(`time-opt-${targetTime}`);
          if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, 50);
    }
  }, [isOpen, value, minTime]);

  const handleSelect = (time: string) => {
    if (minTime && time < minTime) return;
    onChange(time);
    setIsOpen(false);
    
    // Devolvemos el foco al container despues de seleccionar
    setTimeout(() => {
      containerRef.current?.focus();
    }, 50);
  };

  const handleKeyDownLocal = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (!isOpen) {
        e.preventDefault();
        setIsOpen(true);
      }
    } else if (onKeyDown) {
      onKeyDown(e);
    }
  };

  return (
    <div className="input-group">
      {label && <label className="input-label">{label}</label>}
      
      {/* Visual input */}
      <div
        ref={containerRef}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => !disabled && setIsOpen(true)}
        onKeyDown={handleKeyDownLocal}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 48,
          borderRadius: 12,
          padding: '0 16px',
          background: disabled ? '#F3F4F6' : '#fff',
          border: '1px solid rgba(0,0,0,0.1)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          color: value ? '#111827' : '#9CA3AF',
          fontFamily: 'var(--font-family)',
          fontSize: 16,
          fontWeight: 500,
          outline: 'none',
          transition: 'all 0.2s',
          ...(containerRef.current === document.activeElement ? {
            borderColor: 'var(--color-primary)',
            boxShadow: '0 0 0 4px var(--color-primary-container)'
          } : {})
        }}
      >
        <span>{value || placeholder || t('select_time', 'Seleccionar horario')}</span>
        <Clock size={18} color={value ? '#111827' : '#9CA3AF'} />
      </div>

      {/* Picker Modal / Bottom Sheet */}
      {isOpen && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
          '@media (min-width: 768px)': {
            alignItems: 'center',
          }
        } as React.CSSProperties}>
          
          {/* Overlay */}
          <div 
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }}
            onClick={() => setIsOpen(false)}
          />

          {/* Dialog */}
          <div 
            role="dialog"
            aria-modal="true"
            aria-label={t('select_schedule', 'Seleccionar horario')}
            style={{
              position: 'relative',
              background: '#fff',
              width: '100%',
              maxWidth: 420,
              height: '75vh',
              maxHeight: 600,
              borderRadius: '24px 24px 0 0',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 -4px 24px rgba(0,0,0,0.15)',
              animation: 'slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
              '@media (min-width: 768px)': {
                borderRadius: 24,
                height: '60vh',
              }
            } as React.CSSProperties}
          >
            {/* Header */}
            <div style={{ 
              padding: '20px 20px 16px', 
              borderBottom: '1px solid rgba(0,0,0,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{t('select_schedule', 'Seleccionar horario')}</h3>
              <button 
                onClick={() => setIsOpen(false)}
                style={{ 
                  background: '#F3F4F6', border: 'none', width: 32, height: 32, 
                  borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', color: '#4B5563'
                }}
                aria-label={t('cancel', 'Cancelar')}
              >
                <X size={18} />
              </button>
            </div>

            {/* List */}
            <div 
              ref={scrollRef}
              style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}
            >
              {TIME_OPTIONS.map((time) => {
                const isSelected = value === time;
                const isDisabled = minTime ? time < minTime : false;
                
                return (
                  <button
                    key={time}
                    id={`time-opt-${time}`}
                    ref={isSelected ? selectedRef : null}
                    disabled={isDisabled}
                    onClick={() => handleSelect(time)}
                    style={{
                      width: '100%',
                      padding: '14px',
                      marginBottom: 8,
                      borderRadius: 12,
                      border: 'none',
                      fontSize: 16,
                      fontWeight: isSelected ? 700 : 500,
                      background: isSelected ? 'var(--color-primary)' : 'transparent',
                      color: isSelected ? '#fff' : isDisabled ? '#D1D5DB' : '#111827',
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                      transition: 'all 0.15s ease',
                      textAlign: 'center'
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected && !isDisabled) e.currentTarget.style.background = '#F3F4F6';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected && !isDisabled) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    {time}
                  </button>
                );
              })}
            </div>
            
            <div style={{ padding: '16px 20px', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
              <Button fullWidth variant="outline" onClick={() => setIsOpen(false)}>
                {t('cancel', 'Cancelar')}
              </Button>
            </div>
          </div>
        </div>
      )}
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        @media (min-width: 768px) {
          div[role="dialog"] {
            border-radius: 24px !important;
            height: 60vh !important;
            animation: fadeInScale 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
          }
        }
        @keyframes fadeInScale {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
      `}} />
    </div>
  );
});

TimePicker.displayName = 'TimePicker';
