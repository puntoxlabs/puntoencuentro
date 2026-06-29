import React from 'react';
import './StatusChip.css';

interface StatusChipProps {
  icon?: string | React.ReactNode;
  label: string;
  className?: string;
}

export const StatusChip: React.FC<StatusChipProps> = ({ icon, label, className = '' }) => {
  return (
    <div className={`status-chip ${className}`}>
      {icon && <span className="status-chip-icon">{icon}</span>}
      <span>{label}</span>
    </div>
  );
};
