import React from 'react';
import './Button.css';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
  fullWidth?: boolean;
  size?: 'default' | 'sm';
}

export const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'primary', 
  fullWidth = false,
  size = 'default',
  className = '', 
  ...props 
}) => {
  return (
    <button 
      className={`btn btn-${variant} ${fullWidth ? 'btn-full' : ''} ${size === 'sm' ? 'btn-sm' : ''} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};
