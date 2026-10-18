export type InternalInvitationStatus =
  | 'pendiente'
  | 'aceptada'
  | 'rechazada'
  | 'cancelada'
  | 'expirada';

export interface HostInternalInvitationItem {
  id: string;
  destinatario_email: string;
  estado: InternalInvitationStatus;
  mensaje?: string | null;
  respondido_en?: string | null;
  cancelado_en?: string | null;
  expira_en: string;
  created_at: string;
}

export interface MyInternalInvitationItem {
  id: string;
  encuentro_id: string;
  encuentro_titulo: string;
  encuentro_fecha?: string | null;
  encuentro_hora?: string | null;
  encuentro_modalidad: 'presencial' | 'virtual';
  encuentro_date_mode: 'fixed' | 'coordination';
  encuentro_estado: string;
  host_id: string;
  estado: InternalInvitationStatus;
  mensaje?: string | null;
  expira_en: string;
  created_at: string;
}

export interface InternalInvitationDetail {
  invitacion: {
    id: string;
    estado: InternalInvitationStatus;
    mensaje?: string | null;
    respondido_en?: string | null;
    cancelado_en?: string | null;
    expira_en: string;
    created_at: string;
    is_host: boolean;
    token_invitacion?: string | null;
  };
  encuentro: {
    id: string;
    titulo: string;
    descripcion?: string | null;
    fecha?: string | null;
    hora?: string | null;
    modalidad: 'presencial' | 'virtual';
    lugar_texto?: string | null;
    date_mode: 'fixed' | 'coordination';
    estado: string;
    tema?: string | null;
    host_name: string;
  };
}

export interface SendInternalInvitationResponse {
  ok: boolean;
  sent: boolean;
  invitation_id?: string;
  message?: string;
  error?: string;
}

export interface RespondInternalInvitationResponse {
  ok: boolean;
  estado?: InternalInvitationStatus;
  encuentro_id?: string;
  date_mode?: 'fixed' | 'coordination';
  token_invitacion?: string;
  message?: string;
  error?: string;
}
