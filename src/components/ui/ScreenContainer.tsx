import React from 'react';
import './ScreenContainer.css';

interface ScreenContainerProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export const ScreenContainer: React.FC<ScreenContainerProps> = ({ children, className = '', style }) => {
  return (
    <main className={`screen-container ${className}`} style={style}>
      {children}
    </main>
  );
};
