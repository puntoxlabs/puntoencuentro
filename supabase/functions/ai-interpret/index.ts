// Supabase Edge Function: ai-interpret
// Interprets user natural language input into an EncounterDraftPatch.
// Thin semantic interpreter with server-side entitlement reservation and leak-free metering.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { ENCOUNTER_DRAFT_PATCH_SCHEMA, validatePatchOutput } from "./validation.ts";
import { GoogleGeminiProvider } from "./providers/google.ts";
import { OpenAiProvider } from "./providers/openai.ts";
import { DeepSeekProvider } from "./providers/deepseek.ts";
import { MistralProvider } from "./providers/mistral.ts";
import type { EncounterInterpreterProvider } from "./providers/base.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

import { resolveLimiterConfig, checkAbuseLimits, recordInteraction } from "./limiter.ts";

declare const Deno: {
  env: {
    get: (key: string) => string | undefined;
  };
  serve: (handler: (req: Request) => Promise<Response>) => void;
};

import { resolveProviders, interpretWithFallback } from "./fallback.ts";

function getPublishableKey(): string {
  const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (typeof first === "string") return first;
    } catch {
      // ignore
    }
  }
  return Deno.env.get("SUPABASE_ANON_KEY") || "";
}

function getSecretKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (typeof first === "string") return first;
    } catch {
      // ignore
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();

  let internalAdminClient: any = null;
  let verifiedUserId: string | null = null;
  let effectiveSessionId: string | null = null;
  let activeLeaseId: string | null = null;

  try {
    // 1. Internal Cryptographic JWT Validation via Supabase Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "not_authenticated",
          message: "Header de autorización inválido o ausente."
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const publishableKey = getPublishableKey();
    const secretKey = getSecretKey();

    if (!supabaseUrl || !publishableKey) {
      console.error("[ai-interpret] Missing SUPABASE_URL or publishable key in environment");
      return new Response(
        JSON.stringify({
          ok: false,
          error: "server_misconfiguration",
          message: "Error de configuración en el servidor."
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Client A: userClient with user JWT (preserves auth.uid() inside RPCs)
    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    // Client B: internalAdminClient with secret key for privileged finalize/release
    internalAdminClient = secretKey
      ? createClient(supabaseUrl, secretKey, { auth: { persistSession: false } })
      : null;

    const { data: { user }, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "not_authenticated",
          message: "Token de autenticación inválido o expirado."
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Rule: Crear con IA requires permanent account
    if (user.is_anonymous) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "permanent_account_required",
          message: "Crear con IA requiere una cuenta permanente. Iniciá sesión con Google para continuar."
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    verifiedUserId = user.id;

    // 2. Parse input body
    const body = await req.json();
    const { message, currentDraft, sessionId } = body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return new Response(
        JSON.stringify({ ok: false, error: "invalid_input", message: "El mensaje no puede estar vacío." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (message.length > 1000) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "input_too_long",
          message: "El mensaje es demasiado largo. Contame brevemente qué querés organizar o cambiar."
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate UUID format of sessionId or generate fallback
    effectiveSessionId =
      typeof sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId.trim())
        ? sessionId.trim()
        : crypto.randomUUID();

    // 3. Technical hourly anti-abuse limiter check
    const limiterConfig = resolveLimiterConfig(Deno.env);
    const limitCheck = await checkAbuseLimits(verifiedUserId, effectiveSessionId, limiterConfig, userClient);

    if (!limitCheck.allowed) {
      const statusCode = limitCheck.error === "rate_limit_unavailable" ? 503 : 429;
      return new Response(
        JSON.stringify({
          ok: false,
          error: limitCheck.error || "rate_limit_exceeded",
          message: limitCheck.message || "Alcanzaste el límite de consultas permitidas por hora. Podés continuar manualmente."
        }),
        { status: statusCode, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let activeLeaseId: string | null = null;

    // 4. Resolve providers (PRIMARY + FALLBACK) before database reservation
    let providersConfig;
    try {
      providersConfig = resolveProviders(Deno.env);
    } catch (err: any) {
      console.error("[ai-interpret] Provider resolution failed:", err?.message || err);
      return new Response(
        JSON.stringify({
          ok: false,
          error: "service_unavailable",
          message: "El servicio de IA no está disponible temporalmente. Podés continuar manualmente."
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { primaryProvider, fallbackProvider, primaryTimeoutMs, fallbackTimeoutMs } = providersConfig;

    // 5. Entitlement & In-flight lease reservation via PostgreSQL RPC
    const leaseId = crypto.randomUUID();
    activeLeaseId = leaseId;
    const { data: reserveData, error: reserveErr } = await userClient.rpc("check_and_reserve_ai_session", {
      p_session_id: effectiveSessionId,
      p_lease_id: leaseId,
    });

    if (reserveErr || !reserveData?.allowed) {
      const errCode = reserveData?.error || reserveErr?.message || "ai_reservation_failed";
      let status = 403;
      let msg = "Alcanzaste el límite de creaciones con IA de este mes. Podés continuar manualmente.";

      if (errCode === "ai_session_busy") {
        status = 409;
        msg = "Hay una consulta en proceso para este borrador. Por favor esperá un instante.";
      } else if (errCode === "session_already_terminal") {
        status = 400;
        msg = "Esta sesión ya fue completada o cancelada. Podés iniciar una nueva creación.";
      } else if (errCode === "session_limit_reached") {
        status = 400;
        msg = "Alcanzaste el límite de mensajes para este borrador. Podés continuar manualmente.";
      } else if (errCode === "entitlements_config_unavailable") {
        status = 503;
        msg = "Configuración de plan temporalmente no disponible. Podés continuar creando manualmente.";
      } else if (errCode === "ai_creation_not_available") {
        status = 403;
        msg = "Crear con IA no está habilitado en tu plan actual.";
      }

      return new Response(
        JSON.stringify({ ok: false, error: errCode, message: msg }),
        { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 6. Interpret using Primary -> Fallback execution pipeline
    const fallbackResult = await interpretWithFallback(
      message.trim(),
      currentDraft,
      primaryProvider,
      fallbackProvider,
      {
        systemPrompt: SYSTEM_PROMPT,
        jsonSchema: ENCOUNTER_DRAFT_PATCH_SCHEMA,
        primaryTimeoutMs,
        fallbackTimeoutMs,
      }
    );

    // 7. Post-Provider Resolution (Release or Finalize consumption)
    if (!fallbackResult.ok || !fallbackResult.patch) {
      // Technical provider failure: release monthly reservation and clear lease
      if (internalAdminClient) {
        await internalAdminClient.rpc("internal_release_ai_session_reservation", {
          p_user_id: verifiedUserId,
          p_session_id: effectiveSessionId,
          p_lease_id: leaseId,
          p_reason: "provider_failure",
        });
      }

      const isSafety = fallbackResult.error === "safety_refusal";
      const statusCode = isSafety ? 400 : 503;
      return new Response(
        JSON.stringify({
          ok: false,
          error: fallbackResult.error || "interpretation_failed",
          message: fallbackResult.message || "No pudimos interpretar el encuentro en este momento. Podés continuar manualmente.",
          fallbackUsed: fallbackResult.fallbackUsed,
          primaryProvider: fallbackResult.primaryProvider,
          primaryModel: fallbackResult.primaryModel,
          fallbackProvider: fallbackResult.fallbackProvider,
          fallbackModel: fallbackResult.fallbackModel,
          primaryFailureType: fallbackResult.primaryFailureType,
          fallbackFailureType: fallbackResult.fallbackFailureType,
          primaryLatencyMs: fallbackResult.primaryLatencyMs,
          fallbackLatencyMs: fallbackResult.fallbackLatencyMs,
          totalLatencyMs: fallbackResult.totalLatencyMs,
          latencyMs: fallbackResult.totalLatencyMs,
        }),
        { status: statusCode, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const scope = fallbackResult.scope || ((fallbackResult.patch as any)?.scope as any) || "encounter";
    recordInteraction(verifiedUserId, effectiveSessionId, scope);

    // Finalize or Release according to domain scope
    if (internalAdminClient) {
      if (scope === "off_topic") {
        // Off-topic: release monthly quota reservation, but record durable turn and clear lease
        await internalAdminClient.rpc("internal_release_ai_session_reservation", {
          p_user_id: verifiedUserId,
          p_session_id: effectiveSessionId,
          p_lease_id: leaseId,
          p_reason: "off_topic",
        });
        await internalAdminClient.rpc("internal_record_ai_session_turn", {
          p_user_id: verifiedUserId,
          p_session_id: effectiveSessionId,
          p_lease_id: leaseId,
        });
      } else {
        // In-domain ('encounter' or 'unclear'): finalize consumption, increment turns and clear lease
        await internalAdminClient.rpc("internal_finalize_ai_session_consumption", {
          p_user_id: verifiedUserId,
          p_session_id: effectiveSessionId,
          p_lease_id: leaseId,
        });
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        scope,
        patch: fallbackResult.patch,
        sessionId: effectiveSessionId,
        usage: {
          inputTokens: fallbackResult.usage?.inputTokens || 0,
          outputTokens: fallbackResult.usage?.outputTokens || 0,
          latencyMs: fallbackResult.totalLatencyMs,
          primaryLatencyMs: fallbackResult.primaryLatencyMs,
          fallbackLatencyMs: fallbackResult.fallbackLatencyMs,
        },
        provider: fallbackResult.providerUsed,
        model: fallbackResult.modelUsed,
        fallbackUsed: fallbackResult.fallbackUsed,
        primaryProvider: fallbackResult.primaryProvider,
        primaryModel: fallbackResult.primaryModel,
        fallbackProvider: fallbackResult.fallbackProvider,
        fallbackModel: fallbackResult.fallbackModel,
        primaryFailureType: fallbackResult.primaryFailureType,
        fallbackFailureType: fallbackResult.fallbackFailureType,
        primaryLatencyMs: fallbackResult.primaryLatencyMs,
        fallbackLatencyMs: fallbackResult.fallbackLatencyMs,
        totalLatencyMs: fallbackResult.totalLatencyMs,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("[ai-interpret] Uncaught exception:", err);

    if (internalAdminClient && verifiedUserId && effectiveSessionId && activeLeaseId) {
      try {
        await internalAdminClient.rpc("internal_release_ai_session_reservation", {
          p_user_id: verifiedUserId,
          p_session_id: effectiveSessionId,
          p_lease_id: activeLeaseId,
          p_reason: "internal_error",
        });
      } catch (releaseErr) {
        console.warn("[ai-interpret] Failed safety-net release on uncaught exception:", releaseErr);
      }
    }

    return new Response(
      JSON.stringify({
        ok: false,
        error: "internal_error",
        message: "Ocurrió un error inesperado al interpretar el mensaje. Podés continuar manualmente."
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
