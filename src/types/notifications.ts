/**
 * Tipos de dominio para la Infraestructura de Notificaciones e Inbox (Fase 1).
 * Modelo seguro derivado exclusivamente de auth.uid() y contratos aprobados.
 */

export type DomainEventType =
  | 'encounter.opened.v1'
  | 'encounter.updated.v1'
  | 'encounter.cancelled.v1'
  | 'match.detected.v1'
  | 'internal_invitation.created.v1'
  | 'internal_invitation.accepted.v1'
  | 'internal_invitation.declined.v1'
  | 'internal_invitation.cancelled.v1'
  | 'internal_invitation.expired.v1';

export type OutboxEventStatus = 'pending' | 'processing' | 'processed' | 'failed';

export type NotificationType =
  | 'match_found'
  | 'internal_invitation'
  | 'invitation_accepted'
  | 'invitation_declined';

export type TargetType = 'encounter' | 'invitation';

// ============================================================
// Payloads Específicos por Tipo de Notificación
// ============================================================

export interface MatchFoundNotificationPayload {
  encounterId: string;
  encounterTitle: string;
  activitySlug: string;
  categorySlug: string;
  modality: 'presencial' | 'virtual';
  dateText?: string | null;
  approximateZone?: string | null;
  spotsLeft?: number | null;
}

export interface InternalInvitationNotificationPayload {
  invitationId: string;
  encounterId: string;
  encounterTitle: string;
  senderName: string;
  activitySlug: string;
  modality: 'presencial' | 'virtual';
  dateText?: string | null;
}

export interface InvitationResponseNotificationPayload {
  invitationId: string;
  encounterId: string;
  encounterTitle: string;
  responderName: string;
  status: 'aceptada' | 'rechazada';
}

export type InboxNotificationPayload =
  | { type: 'match_found'; data: MatchFoundNotificationPayload }
  | { type: 'internal_invitation'; data: InternalInvitationNotificationPayload }
  | { type: 'invitation_accepted'; data: InvitationResponseNotificationPayload }
  | { type: 'invitation_declined'; data: InvitationResponseNotificationPayload }
  | Record<string, unknown>;

// ============================================================
// DTOs de Presentación y Servicio
// ============================================================

export interface InboxNotificationItem {
  id: string;
  notificationType: NotificationType;
  targetType: TargetType;
  targetId: string;
  deepLink: string;
  title: string;
  body: string;
  payload: InboxNotificationPayload;
  readAt: string | null;
  isRead: boolean;
  expiresAt: string;
  createdAt: string;
}

export interface PaginatedInboxResponse {
  ok: boolean;
  data: InboxNotificationItem[];
  hasMore: boolean;
  nextCursor?: {
    createdAt: string;
    id: string;
  } | null;
  error?: string;
}

export interface InboxUnreadCountResponse {
  ok: boolean;
  unreadCount: number;
  error?: string;
}

export interface MarcarLeidaResponse {
  ok: boolean;
  notificationId?: string;
  readAt?: string;
  error?: string;
}

export interface MarcarTodasLeidasResponse {
  ok: boolean;
  updatedCount?: number;
  error?: string;
}

// ============================================================
// Tipos Operativos Internos (Outbox y Worker)
// ============================================================

export interface OutboxEventRecord {
  id: string;
  eventType: DomainEventType | string;
  eventVersion: number;
  aggregateType: string;
  aggregateId: string;
  actorUserId?: string | null;
  payload: Record<string, unknown>;
  dedupKey: string;
  attemptCount: number;
  createdAt: string;
}

export interface ClaimDomainEventsResponse {
  ok: boolean;
  events: OutboxEventRecord[];
  count: number;
  error?: string;
}

export interface WorkerBatchResult {
  claimedCount: number;
  processedCount: number;
  failedCount: number;
  durationMs: number;
}
