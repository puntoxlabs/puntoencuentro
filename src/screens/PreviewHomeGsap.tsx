import React, { useEffect, useState } from 'react';
import Home from './Home';
import { Eye, ChevronDown } from 'lucide-react';

const PreviewHomeGsap: React.FC = () => {
  const [isMinimized, setIsMinimized] = useState(true);

  useEffect(() => {
    let metaTag = document.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
    let wasCreated = false;
    let previousContent: string | null = null;

    if (!metaTag) {
      metaTag = document.createElement('meta');
      metaTag.name = 'robots';
      document.head.appendChild(metaTag);
      wasCreated = true;
    } else {
      previousContent = metaTag.getAttribute('content');
    }

    metaTag.setAttribute('content', 'noindex, nofollow');

    return () => {
      if (wasCreated) {
        metaTag?.parentNode?.removeChild(metaTag);
      } else if (metaTag) {
        if (previousContent !== null) {
          metaTag.setAttribute('content', previousContent);
        } else {
          metaTag.removeAttribute('content');
        }
      }
    };
  }, []);

  return (
    <>
      <Home forcedVariant="gsap" />

      {/* Identificación mínima y colapsable en esquina superior derecha para evaluación sin invadir controles */}
      <div
        style={{
          position: 'fixed',
          top: 'calc(10px + env(safe-area-inset-top, 0px))',
          right: '12px',
          zIndex: 1000,
          pointerEvents: 'auto',
          userSelect: 'none',
          opacity: 0.70,
          transition: 'opacity 0.2s ease',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.opacity = '1'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.opacity = '0.70'; }}
      >
        {isMinimized ? (
          <button
            type="button"
            onClick={() => setIsMinimized(false)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              padding: '4px 10px',
              borderRadius: '9999px',
              background: 'rgba(15, 23, 42, 0.88)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              color: '#38bdf8',
              fontSize: '0.70rem',
              fontWeight: 600,
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              cursor: 'pointer',
            }}
            title="Ver información del experimento GSAP"
          >
            <Eye size={11} />
            <span>Preview GSAP</span>
          </button>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              padding: '10px 14px',
              borderRadius: '14px',
              background: 'rgba(15, 23, 42, 0.94)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              color: '#f8fafc',
              fontSize: '0.78rem',
              boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
              maxWidth: '240px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <span style={{ fontWeight: 700, color: '#38bdf8' }}>Motor GSAP Activo</span>
              <button
                type="button"
                onClick={() => setIsMinimized(true)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  padding: '2px',
                }}
              >
                <ChevronDown size={14} />
              </button>
            </div>
            <p style={{ margin: 0, fontSize: '0.72rem', color: '#cbd5e1', lineHeight: 1.3 }}>
              Coreografía continua dirigida con Master Timeline, MotionPath y curvatura orgánica.
            </p>
          </div>
        )}
      </div>
    </>
  );
};

export default PreviewHomeGsap;
