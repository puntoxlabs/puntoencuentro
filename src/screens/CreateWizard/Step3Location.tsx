import React from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useWizardStore } from '@/store/wizardStore';

const Step3Location: React.FC = () => {
  const { modalidad, lugar_texto, link_virtual, setField, nextStep } = useWizardStore();
  const isPresencial = modalidad === 'presencial';
  const isValid = isPresencial ? lugar_texto.trim() !== '' : link_virtual.trim() !== '';

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && isValid) nextStep();
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setField('link_virtual', text);
    } catch (err) { console.error('Failed to read clipboard', err); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 0 }}>
      <div style={{ marginBottom: 28 }}>
        {isPresencial ? (
          <>
            <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>📍 ¿Dónde se encuentran?</h2>
            <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)' }}>Indicá el lugar donde se van a ver.</p>
          </>
        ) : (
          <>
            <h2 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>💻 Link de videollamada</h2>
            <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)' }}>Pegá el enlace de la reunión virtual.</p>
          </>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {isPresencial ? (
          <Input
            label="Lugar"
            value={lugar_texto}
            onChange={(e) => setField('lugar_texto', e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ej: Club Padel Norte - Av. Libertador 1234"
          />
        ) : (
          <div>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface-variant)', marginBottom: 6, letterSpacing: '0.02em' }}>
              Link
            </label>
            <div style={{
              display: 'flex', background: '#fff',
              borderRadius: 12, border: `1.5px solid ${link_virtual ? 'var(--color-primary)' : 'var(--color-outline-variant)'}`,
              overflow: 'hidden',
              boxShadow: link_virtual ? '0 0 0 3px rgba(26,86,240,0.1)' : '0 2px 6px rgba(0,0,0,0.04)',
              transition: 'all 0.18s',
            }}>
              <input
                value={link_virtual}
                onChange={(e) => setField('link_virtual', e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="https://meet.google.com/…"
                type="url"
                style={{
                  flex: 1, border: 'none', outline: 'none',
                  padding: '0 16px', height: 52, fontSize: 15,
                  fontFamily: 'var(--font-family)', color: 'var(--color-on-surface)',
                  background: 'transparent',
                }}
              />
              <button
                onClick={handlePaste}
                style={{
                  background: 'var(--color-primary)',
                  color: '#fff', border: 'none',
                  padding: '0 18px', cursor: 'pointer',
                  fontFamily: 'var(--font-family)',
                  fontWeight: 700, fontSize: 14, flexShrink: 0,
                }}
              >
                Pegar
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={{ paddingTop: 24 }}>
        <Button fullWidth onClick={nextStep} disabled={!isValid}>
          Continuar
        </Button>
      </div>
    </div>
  );
};

export default Step3Location;
