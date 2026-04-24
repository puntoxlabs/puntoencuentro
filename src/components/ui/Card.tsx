import React from 'react';
import './Card.css';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  style?: React.CSSProperties;
}

export const Card: React.FC<CardProps> = ({ children, className = '', onClick, style }) => {
  return (
    <div 
      className={`card ${onClick ? 'card-clickable' : ''} ${className}`} 
      onClick={onClick}
      style={style}
    >
      {children}
    </div>
  );
};
