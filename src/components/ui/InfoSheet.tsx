import React, { useState } from 'react';
import { X, Info, Shield, MessageSquare, Tag, ChevronRight } from 'lucide-react';

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
          <div style={{ animation: 'slideIn 0.2s ease' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
              <button onClick={() => setActiveSection(null)} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', marginRight: 12, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 24, lineHeight: 1 }}>‹</span>
              </button>
              <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: 'var(--color-on-surface)' }}>Cómo funciona</h2>
            </div>
            <p style={{ fontSize: 15, color: 'var(--color-on-surface-variant)', marginBottom: 24, lineHeight: 1.5 }}>
              PuntoEncuentro te ayuda a organizar encuentros sin crear grupos ni perder respuestas en chats.
            </p>
            <ol style={{ paddingLeft: 20, fontSize: 15, color: 'var(--color-on-surface)', lineHeight: 1.8, marginBottom: 32 }}>
              <li style={{ paddingLeft: 8, marginBottom: 8 }}>Creás un encuentro.</li>
              <li style={{ paddingLeft: 8, marginBottom: 8 }}>Compartís el enlace.</li>
              <li style={{ paddingLeft: 8, marginBottom: 8 }}>Los invitados responden.</li>
              <li style={{ paddingLeft: 8, marginBottom: 8 }}>Ves quién confirma y quién no.</li>
              <li style={{ paddingLeft: 8, marginBottom: 0 }}>Si cambia algo, podés cancelar y crear uno nuevo.</li>
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
          <div style={{ animation: 'slideIn 0.2s ease' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
              <button onClick={() => setActiveSection(null)} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', marginRight: 12, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 24, lineHeight: 1 }}>‹</span>
              </button>
              <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: 'var(--color-on-surface)' }}>Acerca de PuntoEncuentro</h2>
            </div>
            <p style={{ fontSize: 15, color: 'var(--color-on-surface-variant)', marginBottom: 24, lineHeight: 1.6 }}>
              PuntoEncuentro es una herramienta simple para coordinar reuniones, salidas y videollamadas compartiendo un enlace.
            </p>
            <div style={{ background: 'var(--color-primary-container)', padding: '16px', borderRadius: 12, marginBottom: 32 }}>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--color-primary-dark)', fontWeight: 600 }}>Versión beta de prueba.</p>
            </div>
            <p style={{ fontSize: 14, color: '#9CA3AF', fontWeight: 600, textAlign: 'center' }}>
              PuntoX Labs
            </p>
          </div>
        );
      case 3:
        return (
          <div style={{ animation: 'slideIn 0.2s ease' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
              <button onClick={() => setActiveSection(null)} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', marginRight: 12, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 24, lineHeight: 1 }}>‹</span>
              </button>
              <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: 'var(--color-on-surface)' }}>Privacidad</h2>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ background: '#FEF2F2', padding: '16px', borderRadius: 12, border: '1px solid #FEE2E2' }}>
                <p style={{ margin: 0, fontSize: 14, color: '#B91C1C', fontWeight: 600 }}>No compartas información sensible.</p>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: '#991B1B' }}>Los enlaces pueden ser abiertos por quienes los reciban.</p>
              </div>
              <p style={{ fontSize: 15, color: 'var(--color-on-surface-variant)', lineHeight: 1.6 }}>
                Los datos se utilizan únicamente para gestionar el encuentro y mostrar las respuestas de los participantes.
              </p>
            </div>
          </div>
        );
      case 5:
        return (
          <div style={{ animation: 'slideIn 0.2s ease' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
              <button onClick={() => setActiveSection(null)} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', marginRight: 12, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                <span style={{ fontSize: 24, lineHeight: 1 }}>‹</span>
              </button>
              <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: 'var(--color-on-surface)' }}>Versión</h2>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '24px 0' }}>
              <div style={{ width: 64, height: 64, background: 'var(--color-primary-container)', borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 32 }}>📍</span>
              </div>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: 'var(--color-on-surface)' }}>PuntoEncuentro</h3>
              <p style={{ margin: 0, fontSize: 15, color: 'var(--color-primary)', fontWeight: 600 }}>Versión Beta</p>
              
              <div style={{ background: '#F3F4F6', padding: '12px 20px', borderRadius: 12, marginTop: 16, textAlign: 'center' }}>
                <p style={{ margin: 0, fontSize: 12, color: '#6B7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Build</p>
                {/* Asumiendo que __APP_VERSION__ está inyectado por Vite según vite.config.ts */}
                <p style={{ margin: '4px 0 0', fontSize: 14, color: '#374151', fontWeight: 500 }}>
                  {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'Local'}
                </p>
              </div>
            </div>
          </div>
        );
      default:
        return (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-on-surface)' }}>Información</h2>
              <button
                onClick={onClose}
                style={{
                  background: 'var(--color-surface-variant)', border: 'none',
                  borderRadius: '50%', width: 32, height: 32,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', color: 'var(--color-on-surface)'
                }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <MenuButton icon={<Info size={20} />} label="Cómo funciona" onClick={() => setActiveSection(1)} />
              <MenuButton icon={<Info size={20} />} label="Acerca de PuntoEncuentro" onClick={() => setActiveSection(2)} />
              <MenuButton icon={<Shield size={20} />} label="Privacidad" onClick={() => setActiveSection(3)} />
              
              <div style={{ height: 1, background: 'rgba(0,0,0,0.05)', margin: '8px 0' }} />
              
              <MenuButton 
                icon={<MessageSquare size={20} />} 
                label="Enviar comentario" 
                subtitle="¿Encontraste un problema o tenés una sugerencia? Tu opinión nos ayuda a mejorar."
                onClick={handleFeedback}
                external
              />
              
              <div style={{ height: 1, background: 'rgba(0,0,0,0.05)', margin: '8px 0' }} />
              
              <MenuButton icon={<Tag size={20} />} label="Versión" onClick={() => setActiveSection(5)} />
            </div>
          </>
        );
    }
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0, 0, 0, 0.4)', zIndex: 999,
          backdropFilter: 'blur(2px)',
        }}
      />
      <div
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0,
          margin: '0 auto', width: '100%', maxWidth: 520,
          background: '#fff', zIndex: 1000,
          borderTopLeftRadius: 24, borderTopRightRadius: 24,
          padding: '24px 20px 30px 20px',
          maxHeight: '85vh', overflowY: 'auto',
          boxShadow: '0 -4px 24px rgba(0,0,0,0.2)',
          display: 'flex', flexDirection: 'column',
          animation: 'slideUp 0.25s cubic-bezier(0.25, 0.8, 0.25, 1) forwards',
        }}
      >
        <style dangerouslySetInnerHTML={{__html: `
          @keyframes slideUp {
            from { transform: translateY(100%); }
            to { transform: translateY(0); }
          }
          @keyframes slideIn {
            from { transform: translateX(20px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
        `}} />
        <div style={{
          width: 40, height: 4, background: 'rgba(0,0,0,0.1)',
          borderRadius: 2, alignSelf: 'center', marginBottom: 20
        }} />

        {renderContent()}
      </div>
    </>
  );
};

const MenuButton: React.FC<{ icon: React.ReactNode; label: string; subtitle?: string; onClick: () => void; external?: boolean }> = ({ icon, label, subtitle, onClick, external }) => (
  <button
    onClick={onClick}
    style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '16px', background: 'transparent', border: 'none',
      borderRadius: 16, cursor: 'pointer', transition: 'background 0.15s ease',
      width: '100%', textAlign: 'left'
    }}
    onMouseEnter={(e) => (e.currentTarget.style.background = '#F3F4F6')}
    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: 1 }}>
      <div style={{ color: 'var(--color-primary)' }}>
        {icon}
      </div>
      <div style={{ flex: 1 }}>
        <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-on-surface)', display: 'block' }}>{label}</span>
        {subtitle && <span style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', marginTop: 4, display: 'block', lineHeight: 1.4 }}>{subtitle}</span>}
      </div>
    </div>
    <div style={{ color: '#9CA3AF', marginLeft: 16 }}>
      {external ? <span style={{ fontSize: 18 }}>↗</span> : <ChevronRight size={20} />}
    </div>
  </button>
);
