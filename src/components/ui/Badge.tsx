import React from 'react';
import './Badge.css';

interface BadgeProps {
  label: string;
  status?: 'pending' | 'confirmed' | 'rejected' | 'default' | 'active' | 'finished';
}

export const Badge: React.FC<BadgeProps> = ({ label, status = 'default' }) => {
  return (
    <span className={`badge badge-${status}`}>
      {label}
    </span>
  );
};
