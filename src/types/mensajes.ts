export interface MensajeEncuentro {
  id: string;
  parent_id: string | null;
  autor_nombre: string;
  es_organizador: boolean;
  contenido: string;
  destacado: boolean;
  destacado_en: string | null;
  creado_en: string;
  editado_en: string | null;
  eliminado: boolean;
  eliminado_por_tipo?: 'autor' | 'organizador' | null;
  es_propio: boolean;
  puede_editar: boolean;
  puede_eliminar: boolean;
}

export interface GetMensajesResponse {
  ok: boolean;
  is_host: boolean;
  can_write: boolean;
  writing_window_closed: boolean;
  destacados: MensajeEncuentro[];
  mensajes: MensajeEncuentro[];
  total_count: number;
  has_more: boolean;
  error?: string;
}

export interface PublicarMensajeResponse {
  ok: boolean;
  mensaje_id?: string;
  error?: string;
}

export interface EditarMensajeResponse {
  ok: boolean;
  mensaje_id?: string;
  error?: string;
}

export interface EliminarMensajeResponse {
  ok: boolean;
  mensaje_id?: string;
  tipo?: 'autor' | 'organizador';
  already_deleted?: boolean;
  error?: string;
}

export interface DestacarMensajeResponse {
  ok: boolean;
  destacado?: boolean;
  error?: string;
}
