import React from 'react';
import './ScreenContainer.css';

interface ScreenContainerProps {
  children: React.ReactNode;
  className?: string;
}

export const ScreenContainer: React.FC<ScreenContainerProps> = ({ children, className = '' }) => {
  return (
    <main className={`screen-container ${className}`}>
      {children}
    </main>
  );
};
