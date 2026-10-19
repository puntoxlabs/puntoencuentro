import React from 'react';
import { X } from 'lucide-react';
import './reuse.css';

interface ReuseSheetShellProps {
  title: string;
  subtitle?: string;
  closeLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}

/** Bottom sheet mínimo compartido por "Repetir/Favorito" y "Mis favoritos". */
export const ReuseSheetShell: React.FC<ReuseSheetShellProps> = ({
  title,
  subtitle,
  closeLabel,
  onClose,
  children,
}) => (
  <>
    <div className="pe-reuse-backdrop" onClick={onClose} aria-hidden="true" />
    <div className="pe-reuse-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <div className="pe-reuse-handle" />
      <div className="pe-reuse-header">
        <div>
          <h2 className="pe-reuse-title">{title}</h2>
          {subtitle && <p className="pe-reuse-subtitle">{subtitle}</p>}
        </div>
        <button type="button" className="pe-reuse-close" onClick={onClose} aria-label={closeLabel}>
          <X size={18} />
        </button>
      </div>
      {children}
    </div>
  </>
);
