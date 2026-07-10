import React, { useState, useEffect } from 'react';
import { X, Plus, ImageIcon } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { customDesignsService } from '@/services/customDesignsService';
import type { CustomInvitationTemplate } from '@/lib/customDesigns';
import { CUSTOM_DESIGNS_CONFIG } from '@/lib/customDesigns';
import './BottomSheet.css';

interface CustomDesignsSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CustomDesignsSheet: React.FC<CustomDesignsSheetProps> = ({ isOpen, onClose }) => {
  const { user, signInWithGoogle } = useAuth();
  const [designs, setDesigns] = useState<CustomInvitationTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && user) {
      loadDesigns();
    }
  }, [isOpen, user]);

  const loadDesigns = async () => {
    if (!user) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await customDesignsService.listCustomDesigns(user.id);
      setDesigns(data);
    } catch (err) {
      console.error(err);
      setError('No pudimos cargar tus diseños personalizados. Reintentá más tarde.');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  const renderContent = () => {
    if (!user) {
      return (
        <div className="pe-sheet-slide-section">
          <div className="pe-sheet-header">
            <h2 className="pe-sheet-title">Diseños personalizados</h2>
            <button onClick={onClose} className="pe-sheet-close-btn">
              <X size={18} />
            </button>
          </div>
          
          <div style={{ padding: '24px 0', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <div style={{ width: 64, height: 64, borderRadius: 32, background: 'var(--color-surface-variant)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-primary)' }}>
              <ImageIcon size={32} />
            </div>
            <p className="pe-sheet-text" style={{ textAlign: 'center', margin: 0 }}>
              Para guardar tus diseños personalizados necesitás iniciar sesión.
            </p>
            <button
              onClick={() => signInWithGoogle()}
              style={{
                width: '100%', padding: '14px', borderRadius: 14, border: 'none',
                background: 'var(--color-primary)', color: '#fff', fontWeight: 700,
                fontSize: 16, cursor: 'pointer', transition: 'background 0.2s ease',
                marginTop: 16
              }}
            >
              Continuar con Google
            </button>
            <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', textAlign: 'center', margin: 0, marginTop: 8 }}>
              Podés seguir usando los diseños incluidos sin iniciar sesión.
            </p>
          </div>
        </div>
      );
    }

    // Authenticated state
    const limitReached = designs.length >= CUSTOM_DESIGNS_CONFIG.LIMIT;

    return (
      <div className="pe-sheet-slide-section" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="pe-sheet-header">
          <div>
            <h2 className="pe-sheet-title">Mis diseños</h2>
            <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', margin: 0, marginTop: 2 }}>
              {designs.length}/{CUSTOM_DESIGNS_CONFIG.LIMIT} diseños guardados
            </p>
          </div>
          <button onClick={onClose} className="pe-sheet-close-btn">
            <X size={18} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', paddingTop: 16, paddingBottom: 24 }}>
          {error && (
            <div className="pe-sheet-alert--danger" style={{ marginBottom: 16 }}>
              <p className="pe-sheet-alert-text--danger">{error}</p>
            </div>
          )}

          {isLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-on-surface-variant)' }}>
              Cargando...
            </div>
          ) : designs.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 64, height: 64, borderRadius: 32, background: 'var(--color-surface-variant)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-on-surface-variant)' }}>
                <ImageIcon size={32} opacity={0.5} />
              </div>
              <p style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-on-surface)', margin: 0 }}>
                Todavía no tenés diseños.
              </p>
              <p style={{ fontSize: 14, color: 'var(--color-on-surface-variant)', margin: 0, padding: '0 20px' }}>
                En la próxima etapa vas a poder subir una imagen propia para crear tu tarjeta.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {designs.map(design => (
                <div key={design.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: 'var(--color-surface-variant)', borderRadius: 12 }}>
                  <div style={{ width: 48, height: 64, borderRadius: 8, background: 'var(--color-surface)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {design.thumbnail_path ? (
                      <div style={{ width: '100%', height: '100%', background: '#ddd' }} /> // Placeholder for future actual image
                    ) : (
                      <ImageIcon size={20} color="var(--color-outline)" />
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--color-on-surface)' }}>{design.name}</h4>
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
                      {new Date(design.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <button disabled style={{ padding: '6px 12px', borderRadius: 8, border: 'none', background: 'var(--color-surface)', color: 'var(--color-on-surface-variant)', fontSize: 13, fontWeight: 600 }}>
                    Próximamente
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ paddingTop: 16, borderTop: '1px solid var(--color-outline-variant)' }}>
          {limitReached ? (
            <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', textAlign: 'center', margin: 0, marginBottom: 12 }}>
              Ya tenés 3 diseños guardados. Podés eliminar uno para crear otro.
            </p>
          ) : null}
          <button
            disabled
            style={{
              width: '100%', padding: '14px', borderRadius: 14, border: 'none',
              background: 'var(--color-surface-variant)', color: 'var(--color-on-surface-variant)', fontWeight: 700,
              fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8
            }}
          >
            <Plus size={20} />
            Subir imagen próximamente
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <div onClick={onClose} className="pe-sheet-overlay" />
      <div className="pe-sheet-container" style={{ maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="pe-sheet-handle" />
        {renderContent()}
      </div>
    </>
  );
};
