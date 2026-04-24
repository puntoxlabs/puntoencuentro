import React, { forwardRef } from 'react';
import './Input.css';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = '', ...props }, ref) => {
    return (
      <div className={`input-group ${className}`}>
        {label && <label className="input-label">{label}</label>}
        <input 
          ref={ref}
          className={`input-field ${error ? 'input-error' : ''}`} 
          {...props} 
        />
        {error && <span className="input-error-text">{error}</span>}
      </div>
    );
  }
);
Input.displayName = 'Input';
