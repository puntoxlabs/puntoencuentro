/**
 * Tipos de dominio para la Base Factual y Trayectoria en Encuentros Abiertos (Mini-Sprint D).
 * Exclusivamente Encuentros Abiertos (aislado de privados), sin scoring público ni valoraciones subjetivas.
 */

export type SampleStatus = 'sin_antecedentes' | 'preliminar' | 'establecida';

export interface ContextoFactual {
  total_experiencias_unicas: number;
  anfitriones_distintos_interactuados: number;
  antiguedad_primer_encuentro: string | null;
  recencia_ultimo_encuentro: string | null;
  muestra_suficiente: boolean;
  estado_muestra: SampleStatus;
  tratamiento_neutral: boolean;
  scoring_publico_habilitado: boolean;
}

export interface TrayectoriaAnfitrionDatosObjetivos {
  encuentros_abiertos_organizados: number;
  encuentros_abiertos_programados_futuros?: number;
  encuentros_abiertos_cancelados: number;
  participantes_recibidos_total: number;
  cierres_a_tiempo: number;
  cierres_tardios: number;
  cierres_auto_regularizados: number;
  cierres_pendientes: number;
}

export interface TrayectoriaAnfitrionDeclaraciones {
  encuentros_declarados_realizados: number;
  encuentros_declarados_no_realizados: number;
}

export interface TrayectoriaAnfitrionObservaciones {
  reclamos_recibidos_pendientes: number;
  ausencias_anfitrion_acreditadas: number;
  no_realizaciones_acreditadas: number;
  errores_cierre_acreditados: number;
  reclamos_desestimados_insuficientes: number;
  reclamos_rectificados: number;
}

export interface TrayectoriaAnfitrion {
  datos_objetivos: TrayectoriaAnfitrionDatosObjetivos;
  declaraciones_host: TrayectoriaAnfitrionDeclaraciones;
  observaciones_y_moderacion: TrayectoriaAnfitrionObservaciones;
}

export interface TrayectoriaParticipanteDatosObjetivos {
  encuentros_abiertos_confirmados: number;
  encuentros_abiertos_programados_futuros?: number;
  reconfirmaciones_completadas: number;
  retiros_voluntarios_registrados: number;
}

export interface TrayectoriaParticipanteDeclaracionesHost {
  asistencias_declaradas_host: number;
  inasistencias_reportadas_host: number;
  asistencias_sin_verificar: number;
}

export interface TrayectoriaParticipanteHechosCorroborados {
  asistencias_corroboradas: number;
  inasistencias_reconocidas_expresamente: number;
  inasistencias_confirmadas_moderacion: number;
  inasistencias_justificadas: number;
  inasistencias_no_verificadas_timeout: number;
}

export interface TrayectoriaParticipante {
  datos_objetivos: TrayectoriaParticipanteDatosObjetivos;
  declaraciones_anfitrion: TrayectoriaParticipanteDeclaracionesHost;
  hechos_corroborados: TrayectoriaParticipanteHechosCorroborados;
}

export interface FactualTrajectoryResponse {
  ok: boolean;
  user_id?: string;
  consultado_en?: string;
  contexto_factual?: ContextoFactual;
  trayectoria_anfitrion?: TrayectoriaAnfitrion;
  trayectoria_participante?: TrayectoriaParticipante;
  error?: string;
  message?: string;
}
