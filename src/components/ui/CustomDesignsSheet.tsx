import React, { useState, useEffect, useRef } from 'react';
import { X, Plus, ImageIcon, Upload, Loader2, AlertCircle, Edit2, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { customDesignsService } from '@/services/customDesignsService';
import type { CustomInvitationTemplate } from '@/lib/customDesigns';
import { CUSTOM_DESIGNS_CONFIG } from '@/lib/customDesigns';
import { validateAndProcessImage } from '@/lib/imageProcessor';
import type { ProcessedImage } from '@/lib/imageProcessor';
import './BottomSheet.css';

interface CustomDesignsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectDesign?: (templateId: string) => void;
}

export const CustomDesignsSheet: React.FC<CustomDesignsSheetProps> = ({ isOpen, onClose, onSelectDesign }) => {
  const { user, signInWithGoogle } = useAuth();
  const [designs, setDesigns] = useState<CustomInvitationTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Uploader states
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [processedImage, setProcessedImage] = useState<ProcessedImage | null>(null);
  const [designName, setDesignName] = useState('Mi diseño');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Manage designs states
  const [editingDesignId, setEditingDesignId] = useState<string | null>(null);
  const [editDesignName, setEditDesignName] = useState('');
  const [confirmDeleteDesignId, setConfirmDeleteDesignId] = useState<string | null>(null);
  const [isActionLoading, setIsActionLoading] = useState(false);

  useEffect(() => {
    if (isOpen && user) {
      loadDesigns();
    } else if (!isOpen) {
      resetUploader();
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

  const resetUploader = () => {
    setIsCreating(false);
    if (processedImage) {
      URL.revokeObjectURL(processedImage.previewUrl);
    }
    setProcessedImage(null);
    setDesignName('Mi diseño');
    setIsUploading(false);
    setUploadError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadError(null);
    try {
      const processed = await validateAndProcessImage(file);
      setProcessedImage(processed);
      setIsCreating(true);
    } catch (err: any) {
      setError(err.message || 'Error procesando la imagen.');
    } finally {
      // Clear input so same file can be selected again
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSaveDesign = async () => {
    if (!user || !processedImage) return;

    setIsUploading(true);
    setUploadError(null);

    try {
      const templateId = crypto.randomUUID();
      const imagePath = `${user.id}/${templateId}/background.webp`;
      const thumbnailPath = `${user.id}/${templateId}/thumbnail.webp`;

      await customDesignsService.createCustomDesign({
        userId: user.id,
        templateId,
        name: designName.trim() || 'Mi diseño',
        backgroundBlob: processedImage.backgroundBlob,
        thumbnailBlob: processedImage.thumbnailBlob,
        imagePath,
        thumbnailPath
      });

      // Success
      await loadDesigns();
      resetUploader();
    } catch (err: any) {
      setUploadError(err.message || 'No pudimos guardar el diseño.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleStartEdit = (design: CustomInvitationTemplate) => {
    setEditingDesignId(design.id);
    setEditDesignName(design.name);
    setConfirmDeleteDesignId(null);
  };

  const handleSaveEdit = async (designId: string) => {
    if (!user) return;
    setIsActionLoading(true);
    try {
      const finalName = editDesignName.trim() || 'Mi diseño';
      await customDesignsService.updateCustomDesignName(designId, finalName.substring(0, 40));
      setDesigns(designs.map(d => d.id === designId ? { ...d, name: finalName.substring(0, 40) } : d));
      setEditingDesignId(null);
    } catch (err: any) {
      setError(err.message || 'No pudimos actualizar el nombre. Reintentá más tarde.');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleDelete = async (designId: string) => {
    if (!user) return;
    setIsActionLoading(true);
    try {
      await customDesignsService.deactivateCustomDesign(designId);
      setDesigns(designs.filter(d => d.id !== designId));
      setConfirmDeleteDesignId(null);
    } catch (err: any) {
      setError(err.message || 'No pudimos eliminar el diseño. Reintentá más tarde.');
    } finally {
      setIsActionLoading(false);
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
              onClick={async () => {
                const result = await signInWithGoogle();
                if (!result.ok) {
                  if (result.error === 'anonymous_account_linking_pending') {
                    alert('Próximamente podrás vincular tu cuenta. Por ahora, tus diseños están guardados de forma segura en este dispositivo.');
                  } else {
                    alert('Hubo un problema al iniciar sesión. Por favor, intentá nuevamente.');
                  }
                }
              }}
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

    if (isCreating && processedImage) {
      return (
        <div className="pe-sheet-slide-section" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div className="pe-sheet-header">
            <h2 className="pe-sheet-title">Crear diseño personalizado</h2>
            <button onClick={resetUploader} disabled={isUploading} className="pe-sheet-close-btn">
              <X size={18} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', paddingTop: 16, paddingBottom: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '9/16',
              maxHeight: '40vh',
              borderRadius: 16,
              overflow: 'hidden',
              background: '#000',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <img
                src={processedImage.previewUrl}
                alt="Preview"
                style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.9 }}
              />
              <div style={{
                position: 'absolute',
                top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                background: 'rgba(255,255,255,0.75)',
                backdropFilter: 'blur(8px)',
                padding: '16px 24px',
                borderRadius: 12,
                textAlign: 'center',
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
              }}>
                <h3 style={{ margin: 0, fontSize: 18, color: '#111' }}>Tu Evento</h3>
                <p style={{ margin: '4px 0 0 0', fontSize: 13, color: '#444' }}>Fecha y Lugar</p>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface)' }}>
                Nombre del diseño
              </label>
              <input
                type="text"
                value={designName}
                onChange={(e) => setDesignName(e.target.value)}
                maxLength={40}
                disabled={isUploading}
                style={{
                  width: '100%', padding: '12px 14px', borderRadius: 12, border: '1px solid var(--color-outline)',
                  background: 'var(--color-surface)', fontSize: 16, outline: 'none'
                }}
              />
            </div>

            {uploadError && (
              <div className="pe-sheet-alert--danger">
                <p className="pe-sheet-alert-text--danger">{uploadError}</p>
              </div>
            )}

            <div style={{ background: 'var(--color-surface-variant)', padding: 12, borderRadius: 12, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <AlertCircle size={20} color="var(--color-on-surface-variant)" style={{ flexShrink: 0 }} />
              <p style={{ margin: 0, fontSize: 13, color: 'var(--color-on-surface-variant)', lineHeight: 1.4 }}>
                La imagen será visible para quienes reciban el link de invitación. No subas imágenes privadas o sensibles.
              </p>
            </div>
          </div>

          <div style={{ paddingTop: 16, paddingBottom: 'calc(24px + env(safe-area-inset-bottom))', borderTop: '1px solid var(--color-outline-variant)', display: 'flex', gap: 12 }}>
            <button
              onClick={resetUploader}
              disabled={isUploading}
              style={{
                flex: 1, padding: '14px', borderRadius: 14, border: '1px solid var(--color-outline)',
                background: 'transparent', color: 'var(--color-on-surface)', fontWeight: 700,
                fontSize: 16, cursor: isUploading ? 'not-allowed' : 'pointer', opacity: isUploading ? 0.5 : 1
              }}
            >
              Cancelar
            </button>
            <button
              onClick={handleSaveDesign}
              disabled={isUploading || !designName.trim()}
              style={{
                flex: 1, padding: '14px', borderRadius: 14, border: 'none',
                background: 'var(--color-primary)', color: '#fff', fontWeight: 700,
                fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                cursor: (isUploading || !designName.trim()) ? 'not-allowed' : 'pointer', opacity: (isUploading || !designName.trim()) ? 0.5 : 1
              }}
            >
              {isUploading ? <><Loader2 size={20} className="animate-spin" /> Guardando...</> : 'Guardar diseño'}
            </button>
          </div>
        </div>
      );
    }

    // Authenticated list state
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
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {designs.map(design => {
                const isEditing = editingDesignId === design.id;
                const isConfirmingDelete = confirmDeleteDesignId === design.id;

                return (
                  <div key={design.id} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, background: 'var(--color-surface-variant)', borderRadius: 12 }}>

                    {isConfirmingDelete ? (
                      <div style={{ padding: '8px 4px' }}>
                        <h4 style={{ margin: '0 0 8px 0', fontSize: 15, fontWeight: 600, color: '#d32f2f' }}>Eliminar diseño personalizado</h4>
                        <p style={{ margin: '0 0 16px 0', fontSize: 13, color: 'var(--color-on-surface-variant)', lineHeight: 1.4 }}>
                          Este diseño dejará de aparecer en tu lista y liberará un lugar para crear otro. Si lo usaste en una invitación existente, esa invitación podría dejar de mostrar esta imagen personalizada.
                        </p>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            onClick={() => setConfirmDeleteDesignId(null)}
                            disabled={isActionLoading}
                            style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid var(--color-outline)', background: 'transparent', color: 'var(--color-on-surface)', fontSize: 13, fontWeight: 600, cursor: isActionLoading ? 'not-allowed' : 'pointer', opacity: isActionLoading ? 0.5 : 1 }}
                          >
                            Cancelar
                          </button>
                          <button
                            onClick={() => handleDelete(design.id)}
                            disabled={isActionLoading}
                            style={{ flex: 1, padding: '8px', borderRadius: 8, border: 'none', background: '#d32f2f', color: '#fff', fontSize: 13, fontWeight: 600, cursor: isActionLoading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: isActionLoading ? 0.5 : 1 }}
                          >
                            {isActionLoading ? <Loader2 size={16} className="animate-spin" /> : 'Eliminar diseño'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ width: 48, height: 64, borderRadius: 8, background: 'var(--color-surface)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            {design.thumbnail_path ? (
                              <img
                                src={customDesignsService.getCustomDesignPublicUrl(design.thumbnail_path)}
                                alt=""
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            ) : (
                              <ImageIcon size={20} color="var(--color-outline)" />
                            )}
                          </div>

                          <div style={{ flex: 1, minWidth: 0 }}>
                            {isEditing ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <input
                                  type="text"
                                  value={editDesignName}
                                  onChange={(e) => setEditDesignName(e.target.value)}
                                  maxLength={40}
                                  autoFocus
                                  disabled={isActionLoading}
                                  style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-primary)', fontSize: 14, outline: 'none' }}
                                />
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <button onClick={() => setEditingDesignId(null)} disabled={isActionLoading} style={{ padding: '4px 8px', fontSize: 12, borderRadius: 4, border: '1px solid var(--color-outline)', background: 'transparent' }}>Cancelar</button>
                                  <button onClick={() => handleSaveEdit(design.id)} disabled={isActionLoading || !editDesignName.trim()} style={{ padding: '4px 8px', fontSize: 12, borderRadius: 4, border: 'none', background: 'var(--color-primary)', color: '#fff' }}>Guardar</button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--color-on-surface)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{design.name}</h4>
                                <p style={{ margin: 0, fontSize: 12, color: 'var(--color-on-surface-variant)' }}>
                                  {new Date(design.created_at).toLocaleDateString()}
                                </p>
                              </>
                            )}
                          </div>

                          {!isEditing && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end', flexShrink: 0 }}>
                              <button
                                onClick={() => {
                                  if (onSelectDesign) onSelectDesign(design.id);
                                }}
                                disabled={isActionLoading}
                                style={{ padding: '6px 12px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', width: '100%' }}
                              >
                                Usar este diseño
                              </button>

                              <div style={{ display: 'flex', gap: 4, width: '100%', justifyContent: 'space-between', marginTop: 4 }}>
                                <button
                                  onClick={() => handleStartEdit(design)}
                                  disabled={isActionLoading}
                                  style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: 'transparent', color: 'var(--color-on-surface-variant)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, cursor: 'pointer' }}
                                  title="Editar nombre"
                                >
                                  <Edit2 size={14} />
                                </button>
                                <button
                                  onClick={() => setConfirmDeleteDesignId(design.id)}
                                  disabled={isActionLoading}
                                  style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--color-outline-variant)', background: 'transparent', color: '#d32f2f', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, cursor: 'pointer' }}
                                  title="Eliminar diseño"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ paddingTop: 16, paddingBottom: 'calc(24px + env(safe-area-inset-bottom))', borderTop: '1px solid var(--color-outline-variant)' }}>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
          />
          {limitReached ? (
            <p style={{ fontSize: 13, color: 'var(--color-on-surface-variant)', textAlign: 'center', margin: 0, marginBottom: 12 }}>
              Ya tenés 3 diseños guardados. Eliminá uno para crear otro.
            </p>
          ) : null}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={limitReached}
            style={{
              width: '100%', padding: '14px', borderRadius: 14, border: 'none',
              background: limitReached ? 'var(--color-surface-variant)' : 'var(--color-primary-container)',
              color: limitReached ? 'var(--color-on-surface-variant)' : 'var(--color-primary)',
              fontWeight: 700,
              fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              cursor: limitReached ? 'not-allowed' : 'pointer'
            }}
          >
            {limitReached ? <Upload size={20} /> : <Plus size={20} />}
            Subir imagen
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
