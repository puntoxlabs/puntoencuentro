import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type {
  CrearIntencionPayload,
  EditarIntencionPayload,
  Intencion,
  ModalidadIntencion,
} from '../../../types/intenciones';
import type { Localidad } from '../openEncounters/types';
import {
  TEMPORALIDAD_CHIPS,
  resolverTemporalidadIntencion,
  type TemporalidadChip,
} from '../../../lib/temporalidadIntencion';
import { useTranslation } from 'react-i18next';
import './IntencionFormSheet.css';

export interface IntencionFormSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (payload: CrearIntencionPayload | EditarIntencionPayload) => Promise<boolean>;
  initialData?: Intencion | CrearIntencionPayload | null;
  localidades: Localidad[];
  isEditing?: boolean;
  isSubmitting?: boolean;
  isV2Variant?: boolean;
}

export const IntencionFormSheet: React.FC<IntencionFormSheetProps> = ({
  isOpen,
  onClose,
  onSave,
  initialData,
  localidades,
  isEditing = false,
  isSubmitting = false,
  isV2Variant = false,
}) => {
  const { t } = useTranslation();
  const [titulo, setTitulo] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [selectedChip, setSelectedChip] = useState<TemporalidadChip>('flexible');
  const [temporalidadTexto, setTemporalidadTexto] = useState<string | null>('Flexible');
  const [fechaDesde, setFechaDesde] = useState<string | null>(null);
  const [fechaHasta, setFechaHasta] = useState<string | null>(null);
  const [modalidad, setModalidad] = useState<ModalidadIntencion>('presencial');
  const [localityId, setLocalityId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    if (initialData) {
      setTitulo(initialData.titulo || '');
      setDescripcion(initialData.descripcion || '');
      setModalidad(initialData.modalidad || 'presencial');
      setLocalityId(initialData.locality_id || null);
      setFechaDesde(initialData.fecha_desde || null);
      setFechaHasta(initialData.fecha_hasta || null);
      setTemporalidadTexto(initialData.temporalidad_texto || 'Flexible');

      // Mapear chip según temporalidad_texto
      const txt = (initialData.temporalidad_texto || '').toLowerCase();
      if (txt.includes('hoy')) {
        setSelectedChip('hoy');
      } else if (txt.includes('esta semana')) {
        setSelectedChip('esta_semana');
      } else if (txt.includes('finde')) {
        setSelectedChip('este_finde');
      } else {
        setSelectedChip('flexible');
      }
    } else {
      // Valores iniciales limpios
      setTitulo('');
      setDescripcion('');
      const defaultTiming = resolverTemporalidadIntencion('flexible');
      setSelectedChip('flexible');
      setTemporalidadTexto(defaultTiming.temporalidad_texto);
      setFechaDesde(defaultTiming.fecha_desde);
      setFechaHasta(defaultTiming.fecha_hasta);
      setModalidad('presencial');
      setLocalityId(null);
    }
    setErrorMsg(null);
  }, [isOpen, initialData]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleChipSelect = (chip: TemporalidadChip) => {
    setSelectedChip(chip);
    const resolved = resolverTemporalidadIntencion(chip);
    setTemporalidadTexto(resolved.temporalidad_texto);
    setFechaDesde(resolved.fecha_desde);
    setFechaHasta(resolved.fecha_hasta);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = titulo.trim();
    if (!cleanTitle) {
      setErrorMsg('Por favor ingresá qué te gustaría hacer.');
      return;
    }
    if (cleanTitle.length > 120) {
      setErrorMsg('El título no puede superar los 120 caracteres.');
      return;
    }

    setErrorMsg(null);

    const basePayload = {
      titulo: cleanTitle,
      descripcion: descripcion.trim() || null,
      temporalidad_texto: temporalidadTexto,
      fecha_desde: fechaDesde,
      fecha_hasta: fechaHasta,
      modalidad,
      locality_id: modalidad === 'virtual' ? null : localityId || null,
    };

    setErrorMsg(null);
    try {
      let success = false;
      if (isEditing && initialData && 'id' in initialData) {
        success = await onSave({
          id: initialData.id,
          ...basePayload,
        });
      } else {
        success = await onSave(basePayload);
      }

      if (success) {
        onClose();
      }
    } catch (err: any) {
      setErrorMsg(
        err?.message ||
          (isV2Variant
            ? 'No pudimos guardarlo. Intentá nuevamente.'
            : 'No pudimos guardar la intención. Intentá nuevamente.')
      );
    }
  };

  const modalContent = (
    <>
      <div className="pe-intencion-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="pe-intencion-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="intencion-sheet-title"
      >
        <div className="pe-intencion-sheet__handle" aria-hidden="true" />

        <div className="pe-intencion-sheet__header">
          <h2 id="intencion-sheet-title" className="pe-intencion-sheet__title">
            {isEditing
              ? isV2Variant
                ? t('your_encounters.intentions_sheet_edit_title_v2', {
                    defaultValue: 'Editar lo que tenés ganas de hacer',
                  })
                : 'Editar intención'
              : isV2Variant
              ? t('your_encounters.intentions_sheet_create_title_v2', {
                  defaultValue: 'Tengo ganas de…',
                })
              : 'Expresar intención'}
          </h2>
          <button
            type="button"
            className="pe-intencion-sheet__close"
            onClick={onClose}
            aria-label="Cerrar"
            disabled={isSubmitting}
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="pe-intencion-form">
          {errorMsg && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: '#fef2f2',
                color: '#dc2626',
                fontSize: '0.85rem',
                fontWeight: 500,
              }}
              role="alert"
            >
              {errorMsg}
            </div>
          )}

          {/* 1. TÍTULO */}
          <div className="pe-form-field">
            <label htmlFor="intencion-titulo" className="pe-form-label">
              ¿Qué te gustaría hacer? *
            </label>
            <input
              id="intencion-titulo"
              type="text"
              className="pe-form-input"
              placeholder="Ej. Salir a correr, jugar al pádel, tomar un café..."
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              maxLength={120}
              autoFocus
              required
              disabled={isSubmitting}
            />
          </div>

          {/* 2. DETALLES */}
          <div className="pe-form-field">
            <label htmlFor="intencion-desc" className="pe-form-label">
              Detalles <span className="pe-form-label-desc">(opcional)</span>
            </label>
            <textarea
              id="intencion-desc"
              className="pe-form-textarea"
              placeholder="Agregá cualquier detalle que ayude a entender tu plan..."
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              maxLength={500}
              disabled={isSubmitting}
            />
          </div>

          {/* 3. CUÁNDO (CHIPS) */}
          <div className="pe-form-field">
            <span className="pe-form-label">¿Cuándo?</span>
            <div className="pe-chips-row" role="group" aria-label="Opciones de cuándo">
              {TEMPORALIDAD_CHIPS.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => handleChipSelect(chip.id)}
                  className={`pe-chip-btn ${
                    selectedChip === chip.id ? 'pe-chip-btn--active' : ''
                  }`}
                  disabled={isSubmitting}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>

          {/* 4. MODALIDAD */}
          <div className="pe-form-field">
            <span className="pe-form-label">Modalidad</span>
            <div className="pe-segmented-row" role="group" aria-label="Modalidad">
              <button
                type="button"
                className={`pe-segmented-btn ${
                  modalidad === 'presencial' ? 'pe-segmented-btn--active' : ''
                }`}
                onClick={() => setModalidad('presencial')}
                disabled={isSubmitting}
              >
                Presencial
              </button>
              <button
                type="button"
                className={`pe-segmented-btn ${
                  modalidad === 'virtual' ? 'pe-segmented-btn--active' : ''
                }`}
                onClick={() => setModalidad('virtual')}
                disabled={isSubmitting}
              >
                Virtual
              </button>
              <button
                type="button"
                className={`pe-segmented-btn ${
                  modalidad === 'indistinto' ? 'pe-segmented-btn--active' : ''
                }`}
                onClick={() => setModalidad('indistinto')}
                disabled={isSubmitting}
              >
                Indistinto
              </button>
            </div>
          </div>

          {/* 5. LOCALIDAD (SI NO ES VIRTUAL) */}
          {modalidad !== 'virtual' && localidades.length > 0 && (
            <div className="pe-form-field">
              <label htmlFor="intencion-locality" className="pe-form-label">
                Zona o localidad <span className="pe-form-label-desc">(opcional)</span>
              </label>
              <select
                id="intencion-locality"
                className="pe-form-select"
                value={localityId || ''}
                onChange={(e) => setLocalityId(e.target.value || null)}
                disabled={isSubmitting}
              >
                <option value="">Cualquier zona o a coordinar</option>
                {localidades.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {`${loc.nombre} (${loc.ciudad})`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* ACCIONES */}
          <div className="pe-intencion-sheet__actions">
            <button
              type="button"
              className="pe-intencion-sheet__cancel-btn"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="pe-intencion-sheet__submit-btn"
              disabled={isSubmitting || !titulo.trim()}
            >
              {isSubmitting
                ? 'Guardando...'
                : isEditing
                ? 'Guardar cambios'
                : isV2Variant
                ? t('your_encounters.intentions_sheet_submit_create_v2', {
                    defaultValue: 'Tengo ganas de…',
                  })
                : '+ Expresar intención'}
            </button>
          </div>
        </form>
      </div>
    </>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(modalContent, document.body);
  }

  return modalContent;
};
