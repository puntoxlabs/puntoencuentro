/**
 * Tipos de dominio para Infraestructura de Alertas de Compatibilidad (Fase 2.0-C1).
 * Modelo estrictamente privado y sanitizado derivado exclusivamente de auth.uid().
 */

export type TipoAlertaCompatibilidad = 'interes_convertido';

export interface AlertaCompatibilidadEncuentroPublico {
  id: string;
  titulo: string;
  descripcion?: string | null;
  fecha?: string | null;
  hora?: string | null;
  modalidad?: string;
  approximate_zone?: string;
  locality_id?: string | null;
  is_open?: boolean;
}

export interface AlertaCompatibilidad {
  id: string;
  tipo: TipoAlertaCompatibilidad;
  source_intencion_id: string;
  target_encuentro_id: string;
  leida: boolean;
  created_at: string;
  encuentro_titulo?: string;
  encuentro_fecha?: string | null;
  encuentro_hora?: string | null;
  encuentro_modalidad?: string;
  encuentro_approximate_zone?: string;
  encuentro: AlertaCompatibilidadEncuentroPublico;
}

export interface AlertasServiceResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
  idempotent?: boolean;
}

export interface MarcarLeidaResult {
  id: string;
  leida: boolean;
}

export interface UseAlertasReturn {
  alertas: AlertaCompatibilidad[];
  unreadCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  marcarLeida: (alertaId: string) => Promise<AlertasServiceResult<MarcarLeidaResult>>;
}
