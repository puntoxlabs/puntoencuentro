/**
 * Tipos de dominio para el módulo de Intenciones (Fase 2.0-A)
 */

export type EstadoIntencion = 'activa' | 'pausada' | 'convertida' | 'cerrada';

export type ModalidadIntencion = 'presencial' | 'virtual' | 'indistinto';

export interface Intencion {
  id: string;
  user_id: string;
  titulo: string;
  descripcion: string | null;
  temporalidad_texto: string | null;
  fecha_desde: string | null;
  fecha_hasta: string | null;
  modalidad: ModalidadIntencion;
  locality_id: string | null;
  localidad_nombre?: string | null;
  localidad_ciudad?: string | null;
  localidad_zona?: string | null;
  estado: EstadoIntencion;
  encuentro_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrearIntencionPayload {
  titulo: string;
  descripcion?: string | null;
  temporalidad_texto?: string | null;
  fecha_desde?: string | null;
  fecha_hasta?: string | null;
  modalidad?: ModalidadIntencion;
  locality_id?: string | null;
}

export interface EditarIntencionPayload {
  id: string;
  titulo: string;
  descripcion?: string | null;
  temporalidad_texto?: string | null;
  fecha_desde?: string | null;
  fecha_hasta?: string | null;
  modalidad?: ModalidadIntencion;
  locality_id?: string | null;
}

export interface IntencionesServiceResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}
