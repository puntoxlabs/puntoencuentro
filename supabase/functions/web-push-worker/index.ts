// Supabase Edge Function: web-push-worker
// Consumidor asíncrono desacoplado del Notification Delivery Outbox (notification_delivery_outbox).
// Procesa entregas Web Push utilizando VAPID, con claim atómico, backoff y revocación automática de 410/404.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

declare const Deno: {
  env: {
    get: (key: string) => string | undefined;
  };
  serve: (handler: (req: Request) => Promise<Response>) => void;
};

interface ClaimedDeliveryItem {
  delivery_id: string;
  inbox_notification_id: string;
  recipient_user_id: string;
  web_push_subscription_id: string;
  attempt_count: number;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  title: string;
  body: string;
  deep_link: string;
  expires_at: string | null;
}

function getAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    "";
  return createClient(supabaseUrl, serviceRoleKey);
}

function isAuthorized(req: Request): boolean {
  const configuredSecret = Deno.env.get("WEB_PUSH_WORKER_SECRET");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  const headerSecret = req.headers.get("x-worker-secret");
  const authHeader = req.headers.get("authorization");

  // 1. Validar por header dedicado si está configurado
  if (configuredSecret && headerSecret === configuredSecret) {
    return true;
  }

  // 2. Validar por Bearer Token de service_role
  if (serviceRoleKey && authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token === serviceRoleKey) {
      return true;
    }
  }

  return false;
}

function sanitizeErrorMessage(msg: string): string {
  if (!msg) return "Push delivery failed";
  // Ocultar URLs largas, endpoints y credenciales
  return msg
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[ENDPOINT_REDACTED]")
    .replace(/(key|token|secret|auth|p256dh)=[^\s&"']+/gi, "$1=[REDACTED]")
    .slice(0, 300);
}

Deno.serve(async (req: Request) => {
  // Manejo de preflight CORS si fuese necesario
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200 });
  }

  // 1. Validar autenticación interna
  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Validar credenciales VAPID
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject =
    Deno.env.get("VAPID_SUBJECT") || "mailto:soporte@puntoencuentro.com.ar";

  if (!vapidPublicKey || !vapidPrivateKey) {
    console.error("[web-push-worker] VAPID credentials not configured in environment");
    return new Response(
      JSON.stringify({
        ok: false,
        error: "VAPID credentials not configured",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const startTime = Date.now();
  const adminClient = getAdminClient();

  // 3. Reclamar lote atómico de entregas listas mediante FOR UPDATE SKIP LOCKED
  const batchSize = 25;
  const { data: claimData, error: claimError } = await adminClient.rpc(
    "claim_web_push_deliveries_seguro",
    {
      p_batch_size: batchSize,
      p_worker_id: "edge-web-push-worker",
    }
  );

  if (claimError) {
    console.error("[web-push-worker] Error reclamo outbox:", claimError);
    return new Response(
      JSON.stringify({ ok: false, error: claimError.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const deliveries: ClaimedDeliveryItem[] = (claimData as any)?.deliveries || [];
  let processedCount = 0;
  let failedCount = 0;
  let revokedCount = 0;

  // 4. Procesar cada entrega individualmente con aislamiento total
  for (const delivery of deliveries) {
    // Verificar si expiró antes de enviar
    let ttl = 86400; // 24 horas por defecto
    if (delivery.expires_at) {
      const remainingSeconds = Math.floor(
        (new Date(delivery.expires_at).getTime() - Date.now()) / 1000
      );
      if (remainingSeconds <= 0) {
        // Expiró mientras esperaba en outbox
        await adminClient.rpc("fallar_web_push_delivery_seguro", {
          p_delivery_id: delivery.delivery_id,
          p_error_message: "Inbox notification expired before delivery",
          p_http_status: 410,
          p_is_retryable: false,
        });
        failedCount++;
        continue;
      }
      ttl = Math.max(1, Math.min(86400, remainingSeconds));
    }

    // Payload conservador para el Service Worker
    const payload = JSON.stringify({
      notification_id: delivery.inbox_notification_id,
      title: delivery.title || "PuntoEncuentro",
      body: delivery.body || "Nueva notificación",
      deep_link: delivery.deep_link || "/",
      tag: `pe-notif-${delivery.inbox_notification_id}`,
    });

    const pushSubscription = {
      endpoint: delivery.endpoint,
      keys: {
        p256dh: delivery.p256dh_key,
        auth: delivery.auth_key,
      },
    };

    try {
      await webpush.sendNotification(pushSubscription, payload, {
        TTL: ttl,
        urgency: "normal",
      });

      // Éxito: marcar como entregado y actualizar last_seen_at
      await adminClient.rpc("completar_web_push_delivery_seguro", {
        p_delivery_id: delivery.delivery_id,
        p_http_status: 201,
      });
      processedCount++;
    } catch (err: any) {
      const statusCode = err?.statusCode || (err?.status as number) || 500;
      const isGoneOrNotFound = statusCode === 404 || statusCode === 410;
      const isRetryable =
        statusCode === 429 ||
        (statusCode >= 500 && statusCode < 600) ||
        (!err?.statusCode && !err?.status);

      if (isGoneOrNotFound) {
        // Suscripción inválida / dispositivo desinstalado: revocar y cancelar pendientes
        await adminClient.rpc("revocar_endpoint_invalido_seguro", {
          p_subscription_id: delivery.web_push_subscription_id,
          p_delivery_id: delivery.delivery_id,
          p_http_status: statusCode,
        });
        revokedCount++;
        failedCount++;
      } else {
        const cleanMessage = sanitizeErrorMessage(
          err?.message || "Push service error"
        );
        await adminClient.rpc("fallar_web_push_delivery_seguro", {
          p_delivery_id: delivery.delivery_id,
          p_error_message: cleanMessage,
          p_http_status: statusCode,
          p_is_retryable: isRetryable,
        });
        failedCount++;
      }
    }
  }

  const durationMs = Date.now() - startTime;

  // 5. Observabilidad estructurada (JSON Logging)
  console.log(
    JSON.stringify({
      event: "web_push_batch_completed",
      claimed_count: deliveries.length,
      processed_count: processedCount,
      failed_count: failedCount,
      revoked_count: revokedCount,
      duration_ms: durationMs,
    })
  );

  return new Response(
    JSON.stringify({
      ok: true,
      claimed: deliveries.length,
      processed: processedCount,
      failed: failedCount,
      revoked: revokedCount,
      duration_ms: durationMs,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
