import React from 'react';
import { X, Calendar, CalendarDays, Sparkles } from 'lucide-react';
import './BottomSheet.css';
import './EncounterModeChoiceSheet.css';
import { AI_CREATION_ENABLED } from '@/config/features';

import { SelectableOptionCard } from './SelectableOptionCard';

export interface EncounterModeChoiceSheetProps {
  open: boolean;
  onSelectFixed: () => void;
  onSelectCoordination: () => void;
  onSelectAI?: () => void;
  onClose: () => void;
}

export const EncounterModeChoiceSheet: React.FC<EncounterModeChoiceSheetProps> = ({
  open,
  onSelectFixed,
  onSelectCoordination,
  onSelectAI,
  onClose,
}) => {
  if (!open) return null;

  return (
    <>
      <div className="pe-sheet-overlay open" onClick={onClose} />
      <div
        className="pe-sheet-container open mode-choice-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="¿Cómo querés organizarlo?"
      >
        <div className="pe-sheet-handle" />

        <div className="pe-sheet-header">
          <h2 className="pe-sheet-title">¿Cómo querés organizarlo?</h2>
          <button
            className="pe-sheet-close-btn"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="pe-sheet-body">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {AI_CREATION_ENABLED && onSelectAI && (
              <SelectableOptionCard
                title="Crear con IA"
                description="Contanos qué querés organizar y preparamos el encuentro."
                icon={<Sparkles size={24} color="#6366f1" />}
                badge={<span style={{ color: 'var(--color-primary, #6366f1)', fontWeight: 700 }}>Beta</span>}
                selected={false}
                onClick={onSelectAI}
              />
            )}

            <SelectableOptionCard
              title="Fecha definida"
              description="Elegí una fecha y compartí la invitación."
              icon={<Calendar size={24} />}
              badge={<span style={{ color: 'var(--pe-primary-dark)' }}>Rápido</span>}
              selected={false}
              onClick={onSelectFixed}
            />

            <SelectableOptionCard
              title="Coordinar una fecha"
              description="Proponé opciones para encontrar el mejor momento entre todos."
              icon={<CalendarDays size={24} />}
              badge={<span style={{ color: 'var(--pe-text-muted)' }}>Requiere cuenta</span>}
              selected={false}
              onClick={onSelectCoordination}
            />
          </div>
        </div>
      </div>
    </>
  );
};
