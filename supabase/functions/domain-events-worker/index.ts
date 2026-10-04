// Supabase Edge Function: domain-events-worker
// Consumidor asíncrono desacoplado del Transactional Outbox (domain_events_outbox).
// Opera exclusivamente sobre claim atómico (FOR UPDATE SKIP LOCKED) y despacho tipado.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: {
  env: {
    get: (key: string) => string | undefined;
  };
  serve: (handler: (req: Request) => Promise<Response>) => void;
};

interface OutboxEventItem {
  id: string;
  event_type: string;
  event_version: number;
  aggregate_type: string;
  aggregate_id: string;
  actor_user_id: string | null;
  payload: Record<string, unknown>;
  dedup_key: string;
  attempt_count: number;
  created_at: string;
}

type EventHandler = (event: OutboxEventItem, adminClient: any) => Promise<void>;

// ============================================================
// Catálogo de Handlers Tipados (Fase 1: Infraestructura)
// ============================================================
const EVENT_HANDLERS: Record<string, EventHandler> = {
  // Encuentros Abiertos (Fase 2A: Reconciliación de Matching)
  "encounter.opened.v1": async (event, adminClient) => {
    const encounterId = event.aggregate_id;
    if (encounterId) {
      await adminClient.rpc("evaluar_matching_encuentro_abierto", {
        p_encuentro_id: encounterId,
      });
    }
  },
  "encounter.updated.v1": async (event, adminClient) => {
    const encounterId = event.aggregate_id;
    if (encounterId) {
      await adminClient.rpc("evaluar_matching_encuentro_abierto", {
        p_encuentro_id: encounterId,
      });
    }
  },
  "encounter.cancelled.v1": async (_event, _adminClient) => {
    // No-op en Fase 1.
  },
  "encounter.join_request.created.v1": async (_event, _adminClient) => {
    // La RPC solicitar_sumarse_encuentro_abierto ya inserta directamente en
    // public.inbox_notifications de forma atómica. No duplicar Inbox ni Push.
    // Marcado exitoso para Transactional Outbox audit/replay.
  },

  // Alertas / Matching (Fase 2A: Inserción en inbox_notifications)
  "match.detected.v1": async (event, adminClient) => {
    const payload = (event.payload || {}) as Record<string, any>;
    const recipientUserId = payload.recipient_user_id;
    if (!recipientUserId) {
      throw new Error("Missing recipient_user_id in match.detected.v1 payload");
    }

    const encounterId = payload.encounter_id || event.aggregate_id;
    const title = payload.title || "Nuevo encuentro compatible";
    const body = payload.body || `Hay un nuevo encuentro compatible: ${payload.encounter_title || "Encuentro abierto"}`;
    const deepLink = payload.deep_link || `/?open_encounter=${encounterId}`;
    const dedupKey = payload.dedup_key || event.dedup_key;
    const expiresAt = payload.expires_at || null;

    const { error } = await adminClient.rpc("insertar_inbox_notification_seguro", {
      p_recipient_user_id: recipientUserId,
      p_notification_type: "match_found",
      p_target_type: "encounter",
      p_target_id: encounterId,
      p_deep_link: deepLink,
      p_title: title,
      p_body: body,
      p_payload: payload,
      p_dedup_key: dedupKey,
      p_expires_at: expiresAt,
    });

    if (error) {
      throw new Error(`Failed to insert inbox notification for match: ${error.message}`);
    }
  },

  // Intención Convertida a Encuentro (Consolidación de Alertas Legacy)
  "intention.converted_to_encounter.v1": async (event, adminClient) => {
    const payload = (event.payload || {}) as Record<string, any>;
    const recipientUserId = payload.recipient_user_id;
    if (!recipientUserId) {
      throw new Error("Missing recipient_user_id in intention.converted_to_encounter.v1 payload");
    }

    const encounterId = payload.encounter_id || event.aggregate_id;
    const intencionId = payload.intencion_id || payload.source_intencion_id;
    const title = payload.title || "Intención convertida en encuentro";
    const body = payload.body || `Una intención que te interesaba se convirtió en un encuentro abierto: ${payload.encounter_title || "Encuentro abierto"}`;
    const deepLink = payload.deep_link || `/?open_encounter=${encounterId}`;
    const dedupKey = payload.dedup_key || (intencionId && encounterId ? `intention:${intencionId}:encounter:${encounterId}` : event.dedup_key);
    const expiresAt = payload.expires_at || null;

    const { error } = await adminClient.rpc("insertar_inbox_notification_seguro", {
      p_recipient_user_id: recipientUserId,
      p_notification_type: "interes_convertido",
      p_target_type: "encounter",
      p_target_id: encounterId,
      p_deep_link: deepLink,
      p_title: title,
      p_body: body,
      p_payload: payload,
      p_dedup_key: dedupKey,
      p_expires_at: expiresAt,
    });

    if (error) {
      throw new Error(`Failed to insert inbox notification for intention conversion: ${error.message}`);
    }
  },

  // Invitaciones Internas (Preparado para Fase 3)
  "internal_invitation.created.v1": async (_event, _adminClient) => {
    // Inserción en inbox_notifications se conectará en Fase 3.
  },
  "internal_invitation.accepted.v1": async (_event, _adminClient) => {
    // No-op en Fase 1.
  },
  "internal_invitation.declined.v1": async (_event, _adminClient) => {
    // No-op en Fase 1.
  },
  "internal_invitation.cancelled.v1": async (_event, _adminClient) => {
    // No-op en Fase 1.
  },
  "internal_invitation.expired.v1": async (_event, _adminClient) => {
    // No-op en Fase 1.
  },
};

function getAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    "";
  return createClient(supabaseUrl, serviceRoleKey);
}

function isAuthorized(req: Request): boolean {
  const configuredSecret = Deno.env.get("DOMAIN_EVENTS_WORKER_SECRET");
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

  // Si no hay secretos configurados en entorno local de pruebas, denegar
  return false;
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

  const startTime = Date.now();
  const adminClient = getAdminClient();

  // 2. Reclamar lote atómico de eventos listos mediante FOR UPDATE SKIP LOCKED
  const batchSize = 10;
  const { data: claimData, error: claimError } = await adminClient.rpc(
    "claim_domain_events_seguro",
    {
      p_batch_size: batchSize,
      p_worker_id: "edge-domain-events-worker",
    }
  );

  if (claimError) {
    console.error("[domain-events-worker] Error reclamo outbox:", claimError);
    return new Response(
      JSON.stringify({ ok: false, error: claimError.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const events: OutboxEventItem[] = (claimData as any)?.events || [];
  let processedCount = 0;
  let failedCount = 0;

  // 3. Procesar cada evento individualmente con aislamiento total de fallos
  for (const event of events) {
    const handler = EVENT_HANDLERS[event.event_type];

    if (!handler) {
      // Evento no soportado: fallo permanente para evitar loop infinito en outbox
      console.warn(`[domain-events-worker] Tipo no soportado: ${event.event_type}`);
      await adminClient.rpc("fallar_domain_event_seguro", {
        p_event_id: event.id,
        p_error_message: `Unsupported event_type: ${event.event_type}`,
        p_is_retryable: false,
      });
      failedCount++;
      continue;
    }

    try {
      await handler(event, adminClient);

      // Éxito: marcar como procesado
      await adminClient.rpc("completar_domain_event_seguro", {
        p_event_id: event.id,
      });
      processedCount++;
    } catch (err: any) {
      const errorMessage = err?.message || "Handler execution failed";
      console.error(
        `[domain-events-worker] Error procesando evento ${event.id} (${event.event_type}):`,
        errorMessage
      );

      // Fallo transitorio con backoff exponencial
      await adminClient.rpc("fallar_domain_event_seguro", {
        p_event_id: event.id,
        p_error_message: errorMessage,
        p_is_retryable: true,
      });
      failedCount++;
    }
  }

  const durationMs = Date.now() - startTime;

  // 4. Observabilidad estructurada (JSON Logging)
  console.log(
    JSON.stringify({
      event: "worker_batch_completed",
      claimed_count: events.length,
      processed_count: processedCount,
      failed_count: failedCount,
      duration_ms: durationMs,
    })
  );

  return new Response(
    JSON.stringify({
      ok: true,
      claimed: events.length,
      processed: processedCount,
      failed: failedCount,
      duration_ms: durationMs,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
