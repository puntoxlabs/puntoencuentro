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
  // Encuentros Abiertos (Stubs de infraestructura preparados para Fase 2)
  "encounter.opened.v1": async (_event, _adminClient) => {
    // La lógica de matching se conectará en Fase 2.
  },
  "encounter.updated.v1": async (_event, _adminClient) => {
    // No-op en Fase 1.
  },
  "encounter.cancelled.v1": async (_event, _adminClient) => {
    // No-op en Fase 1.
  },

  // Alertas / Matching (Preparado para Fase 2)
  "match.detected.v1": async (_event, _adminClient) => {
    // Inserción en inbox_notifications se conectará en Fase 2.
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
