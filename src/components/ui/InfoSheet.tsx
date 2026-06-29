import React, { useState } from 'react';
import { X, Info, Shield, MessageSquare, Tag, ChevronRight } from 'lucide-react';
import './BottomSheet.css';

interface InfoSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

const FEEDBACK_FORM_URL = "https://forms.gle/XXXXXXXXXXXX";

export const InfoSheet: React.FC<InfoSheetProps> = ({ isOpen, onClose }) => {
  const [activeSection, setActiveSection] = useState<number | null>(null);

  if (!isOpen) return null;

  const handleFeedback = () => {
    window.open(FEEDBACK_FORM_URL, '_blank');
  };

  const renderContent = () => {
    switch (activeSection) {
      case 1:
        return (
          <div className="pe-sheet-slide-section">
            <div className="pe-sheet-back-header">
              <button onClick={() => setActiveSection(null)} className="pe-sheet-back-btn">
                <span className="pe-sheet-back-icon">‹</span>
              </button>
              <h2 className="pe-sheet-title">Cómo funciona</h2>
            </div>
            <p className="pe-sheet-text">
              PuntoEncuentro te ayuda a organizar encuentros sin crear grupos ni perder respuestas en chats.
            </p>
            <ol className="pe-sheet-list">
              <li className="pe-sheet-list-item">Creás un encuentro.</li>
              <li className="pe-sheet-list-item">Compartís el enlace.</li>
              <li className="pe-sheet-list-item">Los invitados responden.</li>
              <li className="pe-sheet-list-item">Ves quién confirma y quién no.</li>
              <li className="pe-sheet-list-item">Si cambia algo, podés cancelar y crear uno nuevo.</li>
            </ol>
            <button
              onClick={() => setActiveSection(null)}
              style={{
                width: '100%', padding: '16px', borderRadius: 14, border: 'none',
                background: 'var(--color-primary)', color: '#fff', fontWeight: 700,
                fontSize: 16, cursor: 'pointer', transition: 'background 0.2s ease'
              }}
            >
              Entendido
            </button>
          </div>
        );
      case 2:
        return (
          <div className="pe-sheet-slide-section">
            <div className="pe-sheet-back-header">
              <button onClick={() => setActiveSection(null)} className="pe-sheet-back-btn">
                <span className="pe-sheet-back-icon">‹</span>
              </button>
              <h2 className="pe-sheet-title">Acerca de PuntoEncuentro</h2>
            </div>
            <p className="pe-sheet-text">
              PuntoEncuentro es una herramienta simple para coordinar reuniones, salidas y videollamadas compartiendo un enlace.
            </p>
            <div className="pe-sheet-alert--info">
              <p className="pe-sheet-alert-text--info">Versión beta de prueba.</p>
            </div>
            <p style={{ fontSize: 14, color: '#9CA3AF', fontWeight: 600, textAlign: 'center' }}>
              PuntoX Labs
            </p>
          </div>
        );
      case 3:
        return (
          <div className="pe-sheet-slide-section">
            <div className="pe-sheet-back-header">
              <button onClick={() => setActiveSection(null)} className="pe-sheet-back-btn">
                <span className="pe-sheet-back-icon">‹</span>
              </button>
              <h2 className="pe-sheet-title">Privacidad</h2>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="pe-sheet-alert--danger">
                <p className="pe-sheet-alert-title--danger">No compartas información sensible.</p>
                <p className="pe-sheet-alert-text--danger">Los enlaces pueden ser abiertos por quienes los reciban.</p>
              </div>
              <p className="pe-sheet-text">
                Los datos se utilizan únicamente para gestionar el encuentro y mostrar las respuestas de los participantes.
              </p>
            </div>
          </div>
        );
      case 5:
        return (
          <div className="pe-sheet-slide-section">
            <div className="pe-sheet-back-header">
              <button onClick={() => setActiveSection(null)} className="pe-sheet-back-btn">
                <span className="pe-sheet-back-icon">‹</span>
              </button>
              <h2 className="pe-sheet-title">Versión</h2>
            </div>
            <div className="pe-sheet-version-container">
              <div className="pe-sheet-version-icon-box">
                <span style={{ fontSize: 32 }}>📍</span>
              </div>
              <h3 className="pe-sheet-version-title">PuntoEncuentro</h3>
              <p className="pe-sheet-version-subtitle">Versión Beta</p>
              
              <div className="pe-sheet-build-info">
                <p className="pe-sheet-build-label">Build</p>
                <p className="pe-sheet-build-version">
                  {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'Local'}
                </p>
              </div>
            </div>
          </div>
        );
      default:
        return (
          <div className="pe-sheet-slide-section">
            <div className="pe-sheet-header">
              <h2 className="pe-sheet-title">Información</h2>
              <button onClick={onClose} className="pe-sheet-close-btn">
                <X size={18} />
              </button>
            </div>

            <div className="pe-sheet-buttons-group">
              <button onClick={() => setActiveSection(1)} className="pe-sheet-nav-btn">
                <div className="pe-sheet-nav-content">
                  <span className="pe-sheet-nav-icon"><Info size={20} /></span>
                  <span className="pe-sheet-nav-text">Cómo funciona</span>
                </div>
                <ChevronRight size={18} className="pe-sheet-nav-arrow" />
              </button>

              <button onClick={() => setActiveSection(2)} className="pe-sheet-nav-btn">
                <div className="pe-sheet-nav-content">
                  <span className="pe-sheet-nav-icon"><Tag size={20} /></span>
                  <span className="pe-sheet-nav-text">Acerca de</span>
                </div>
                <ChevronRight size={18} className="pe-sheet-nav-arrow" />
              </button>

              <button onClick={() => setActiveSection(3)} className="pe-sheet-nav-btn">
                <div className="pe-sheet-nav-content">
                  <span className="pe-sheet-nav-icon"><Shield size={20} /></span>
                  <span className="pe-sheet-nav-text">Privacidad y Seguridad</span>
                </div>
                <ChevronRight size={18} className="pe-sheet-nav-arrow" />
              </button>

              <button onClick={handleFeedback} className="pe-sheet-nav-btn">
                <div className="pe-sheet-nav-content">
                  <span className="pe-sheet-nav-icon"><MessageSquare size={20} /></span>
                  <span className="pe-sheet-nav-text">Dejar sugerencia o reporte</span>
                </div>
                <ChevronRight size={18} className="pe-sheet-nav-arrow" />
              </button>

              <button onClick={() => setActiveSection(5)} className="pe-sheet-nav-btn">
                <div className="pe-sheet-nav-content">
                  <span className="pe-sheet-nav-text" style={{ color: 'var(--color-on-surface-variant)', fontSize: 14 }}>Versión 0.1 Beta</span>
                </div>
                <ChevronRight size={18} className="pe-sheet-nav-arrow" />
              </button>
            </div>
          </div>
        );
    }
  };

  return (
    <>
      <div onClick={onClose} className="pe-sheet-overlay" />
      <div className="pe-sheet-container">
        <div className="pe-sheet-handle" />
        {renderContent()}
      </div>
    </>
  );
};
