import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import './AppBar.css';

interface AppBarProps {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
  rightAction?: React.ReactNode;
}

export const AppBar: React.FC<AppBarProps> = ({ title, showBack = false, onBack, rightAction }) => {
  const navigate = useNavigate();

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      navigate(-1);
    }
  };

  return (
    <header className="app-bar">
      {showBack ? (
        <button className="app-bar-back" onClick={handleBack} aria-label="Atrás">
          <ArrowLeft size={24} />
        </button>
      ) : (
        <div style={{ width: 36 }} />
      )}
      <h1 className="app-bar-title">{title}</h1>
      {rightAction ? (
        <div className="app-bar-right">{rightAction}</div>
      ) : (
        <div className="app-bar-placeholder" />
      )}
    </header>
  );
};
