/** Contratos del cliente Web Push (Fase 3A). */

/** Razones por las que el dispositivo/navegador no puede usar Web Push. */
export type WebPushUnsupportedReason =
  | 'insecure_context'
  | 'no_service_worker'
  | 'no_push_manager'
  | 'no_notification';

/**
 * Estado derivado por feature detection + permiso real + estado en backend.
 * `ios_install_hint` solo afina el MENSAJE (la decisión de soporte la toma la
 * feature detection: en iOS Safari fuera de una PWA instalada no existe PushManager).
 */
export type WebPushDeviceState =
  | { kind: 'unsupported'; reason: WebPushUnsupportedReason; iosInstallHint: boolean }
  | { kind: 'not_configured' }
  | { kind: 'default' }
  | { kind: 'denied' }
  | { kind: 'granted_unsubscribed' }
  | { kind: 'subscribed' };

export type WebPushActivateError =
  | 'unsupported'
  | 'push_not_configured'
  | 'permission_denied'
  | 'permission_dismissed'
  | 'service_worker_failed'
  | 'subscribe_failed'
  | 'invalid_subscription'
  | 'register_failed'
  | 'authentication_required'
  | 'permanent_account_required';

export type WebPushActivateResult =
  | { ok: true }
  | { ok: false; error: WebPushActivateError };

export type WebPushDeactivateResult = {
  ok: boolean;
  /** false si no se pudo revocar en backend (el dispositivo igualmente se desuscribe localmente) */
  remoteRevoked: boolean;
};
