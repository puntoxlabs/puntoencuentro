import React, { useState } from 'react';
import { Send, RefreshCw, CheckCircle2, AlertCircle, Clock, ShieldCheck } from 'lucide-react';
import { DevicePushSettings } from '../../components/home/alerts/DevicePushSettings';
import { sendQAPushTest, getQAPushDeliveryStatus, type QAPushDeliveryItem, type QAPushTestResponse } from '../../services/qaAdminService';
import './QAWebPushDiagnostic.css';

export const QAWebPushDiagnostic: React.FC = () => {
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sendResult, setSendResult] = useState<QAPushTestResponse | null>(null);
  const [deliveryItems, setDeliveryItems] = useState<QAPushDeliveryItem[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSendTest = async () => {
    setSending(true);
    setErrorMessage(null);
    setDeliveryItems([]);
    try {
      const res = await sendQAPushTest();
      if (!res.ok) {
        setErrorMessage(res.message || res.error || 'Error al despachar notificación de prueba');
        setSendResult(null);
      } else {
        setSendResult(res);
        if (res.inbox_notification_id) {
          // Consultar el delivery status inicial
          await checkDeliveryStatus(res.inbox_notification_id);
        }
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Error de comunicación con el servidor');
      setSendResult(null);
    } finally {
      setSending(false);
    }
  };

  const checkDeliveryStatus = async (inboxId: string) => {
    setChecking(true);
    try {
      const res = await getQAPushDeliveryStatus(inboxId);
      if (res.ok && res.deliveries) {
        setDeliveryItems(res.deliveries);
      }
    } catch (err: any) {
      console.warn('[QAWebPushDiagnostic] Error consultando status de entrega:', err);
    } finally {
      setChecking(false);
    }
  };

  const renderStatusBadge = (status: string) => {
    switch (status) {
      case 'delivered':
        return (
          <span className="qa-push-chip qa-push-chip--success">
            <CheckCircle2 size={13} /> Entregado
          </span>
        );
      case 'processing':
        return (
          <span className="qa-push-chip qa-push-chip--processing">
            <RefreshCw size={13} className="qa-spin" /> Procesando
          </span>
        );
      case 'pending':
        return (
          <span className="qa-push-chip qa-push-chip--pending">
            <Clock size={13} /> En cola (Pending)
          </span>
        );
      case 'failed':
      case 'cancelled':
        return (
          <span className="qa-push-chip qa-push-chip--error">
            <AlertCircle size={13} /> {status === 'cancelled' ? 'Cancelado' : 'Falló'}
          </span>
        );
      default:
        return <span className="qa-push-chip">{status}</span>;
    }
  };

  return (
    <section className="qa-webpush-card" aria-label="Diagnóstico y prueba Web Push">
      <div className="qa-webpush-header">
        <div className="qa-webpush-header__icon">
          <ShieldCheck size={22} />
        </div>
        <div>
          <h2 className="qa-webpush-title">Diagnóstico y Prueba Web Push</h2>
          <p className="qa-webpush-subtitle">
            Pipeline real de entrega (Inbox → Outbox → Worker → Dispositivo activo). Exclusivo Staging para QA.
          </p>
        </div>
      </div>

      {/* 1. Estado en este dispositivo */}
      <div className="qa-webpush-section">
        <h3 className="qa-webpush-section__label">1. Estado de este dispositivo</h3>
        <DevicePushSettings />
      </div>

      {/* 2. Acción de prueba */}
      <div className="qa-webpush-section">
        <div className="qa-webpush-action-row">
          <div>
            <h3 className="qa-webpush-section__label" style={{ marginBottom: 2 }}>2. Notificación de prueba</h3>
            <p className="qa-webpush-section__hint">
              Envía un push genérico (<code>PuntoEncuentro: Notificación de prueba</code>) a tus dispositivos activos.
            </p>
          </div>
          <button
            type="button"
            className="qa-webpush-btn"
            onClick={handleSendTest}
            disabled={sending}
          >
            {sending ? <RefreshCw size={14} className="qa-spin" /> : <Send size={14} />}
            <span>{sending ? 'Despachando...' : 'Enviar notificación de prueba'}</span>
          </button>
        </div>

        {errorMessage && (
          <div className="qa-webpush-error" role="alert">
            <AlertCircle size={16} />
            <span>{errorMessage}</span>
          </div>
        )}
      </div>

      {/* 3. Trazabilidad del delivery outbox */}
      {sendResult && (
        <div className="qa-webpush-section qa-webpush-section--trace">
          <div className="qa-webpush-trace-header">
            <h3 className="qa-webpush-section__label">3. Trazabilidad de Entrega</h3>
            <button
              type="button"
              className="qa-webpush-refresh-btn"
              onClick={() => sendResult.inbox_notification_id && checkDeliveryStatus(sendResult.inbox_notification_id)}
              disabled={checking}
            >
              <RefreshCw size={12} className={checking ? 'qa-spin' : ''} />
              <span>{checking ? 'Actualizando...' : 'Refrescar estado'}</span>
            </button>
          </div>

          <div className="qa-webpush-summary-grid">
            <div className="qa-webpush-summary-item">
              <span className="qa-webpush-summary-label">Dispositivos activos</span>
              <span className="qa-webpush-summary-value">{sendResult.active_devices_count}</span>
            </div>
            <div className="qa-webpush-summary-item">
              <span className="qa-webpush-summary-label">Endpoint origin</span>
              <span className="qa-webpush-summary-value">{sendResult.endpoint_origin || 'FCM'}</span>
            </div>
            <div className="qa-webpush-summary-item">
              <span className="qa-webpush-summary-label">Inbox ID</span>
              <span className="qa-webpush-summary-code">{sendResult.inbox_notification_id?.slice(0, 8)}...</span>
            </div>
          </div>

          {deliveryItems.length > 0 && (
            <div className="qa-webpush-deliveries">
              {deliveryItems.map((item) => (
                <div key={item.outbox_id} className="qa-webpush-delivery-row">
                  <div className="qa-webpush-delivery-info">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {renderStatusBadge(item.status)}
                      <span className="qa-webpush-delivery-origin">{item.endpoint_origin || 'FCM'}</span>
                    </div>
                    {item.last_error && (
                      <p className="qa-webpush-delivery-error">
                        Último error: {item.last_error}
                      </p>
                    )}
                  </div>
                  <div className="qa-webpush-delivery-meta">
                    <span>Intentos: {item.attempt_count}</span>
                    {item.delivered_at && <span>Entregado: {new Date(item.delivered_at).toLocaleTimeString('es-AR')}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
