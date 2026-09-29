import React from 'react';
import { Calendar, MapPin, Edit3, PauseCircle, PlayCircle, XCircle } from 'lucide-react';
import type { Intencion } from '../../../types/intenciones';
import './IntencionCard.css';

export interface IntencionCardProps {
  intencion: Intencion;
  onEdit: (intencion: Intencion) => void;
  onPausar: (id: string) => void;
  onReactivar: (id: string) => void;
  onCerrar: (id: string) => void;
  disabled?: boolean;
}

export const IntencionCard: React.FC<IntencionCardProps> = ({
  intencion,
  onEdit,
  onPausar,
  onReactivar,
  onCerrar,
  disabled = false,
}) => {
  const isPausada = intencion.estado === 'pausada';
  const isActiva = intencion.estado === 'activa';

  const formatModalidad = () => {
    switch (intencion.modalidad) {
      case 'virtual':
        return 'Virtual';
      case 'indistinto':
        return 'Presencial o virtual';
      case 'presencial':
      default:
        return 'Presencial';
    }
  };

  return (
    <article
      className={`pe-intencion-card ${isPausada ? 'pe-intencion-card--pausada' : ''}`}
      aria-label={`Intención: ${intencion.titulo}`}
    >
      <div className="pe-intencion-card__header">
        <h3 className="pe-intencion-card__title">{intencion.titulo}</h3>
        <span
          className={`pe-intencion-card__status-badge ${
            isActiva
              ? 'pe-intencion-card__status-badge--activa'
              : 'pe-intencion-card__status-badge--pausada'
          }`}
        >
          {isActiva ? 'Activa' : 'Pausada'}
        </span>
      </div>

      {intencion.descripcion && (
        <p className="pe-intencion-card__desc">{intencion.descripcion}</p>
      )}

      <div className="pe-intencion-card__meta-row">
        {intencion.temporalidad_texto && (
          <span className="pe-intencion-card__tag" title="Cuándo">
            <Calendar size={13} aria-hidden="true" />
            <span>{intencion.temporalidad_texto}</span>
          </span>
        )}

        <span className="pe-intencion-card__tag" title="Modalidad">
          <span>{formatModalidad()}</span>
        </span>

        {intencion.localidad_nombre && (
          <span className="pe-intencion-card__tag" title="Localidad">
            <MapPin size={13} aria-hidden="true" />
            <span>{`${intencion.localidad_nombre}${intencion.localidad_ciudad ? `, ${intencion.localidad_ciudad}` : ''}`}</span>
          </span>
        )}
      </div>

      <div className="pe-intencion-card__actions">
        <button
          type="button"
          onClick={() => onEdit(intencion)}
          disabled={disabled}
          className="pe-intencion-card__btn pe-intencion-card__btn--edit"
          aria-label={`Editar intención ${intencion.titulo}`}
        >
          <Edit3 size={14} aria-hidden="true" />
          <span>Editar</span>
        </button>

        {isActiva && (
          <button
            type="button"
            onClick={() => onPausar(intencion.id)}
            disabled={disabled}
            className="pe-intencion-card__btn pe-intencion-card__btn--pause"
            aria-label={`Pausar intención ${intencion.titulo}`}
          >
            <PauseCircle size={14} aria-hidden="true" />
            <span>Pausar</span>
          </button>
        )}

        {isPausada && (
          <button
            type="button"
            onClick={() => onReactivar(intencion.id)}
            disabled={disabled}
            className="pe-intencion-card__btn pe-intencion-card__btn--reactivate"
            aria-label={`Reactivar intención ${intencion.titulo}`}
          >
            <PlayCircle size={14} aria-hidden="true" />
            <span>Reactivar</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => onCerrar(intencion.id)}
          disabled={disabled}
          className="pe-intencion-card__btn pe-intencion-card__btn--close"
          aria-label={`Cerrar intención ${intencion.titulo}`}
        >
          <XCircle size={14} aria-hidden="true" />
          <span>Cerrar</span>
        </button>
      </div>
    </article>
  );
};
