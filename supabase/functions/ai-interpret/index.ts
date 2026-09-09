// Supabase Edge Function: ai-interpret
// Interprets user natural language input into an EncounterDraftPatch.
// Thin semantic interpreter only: no database mutations, no business rules resolution.

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();

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
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";

    if (!supabaseUrl || !supabaseAnonKey) {
      console.error("[ai-interpret] Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment");
      return new Response(
        JSON.stringify({
          ok: false,
          error: "server_misconfiguration",
          message: "Error de configuración en el servidor."
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Official Supabase client instantiation with user Bearer token (no service_role)
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);
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

    const verifiedUserId = user.id;

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

    // 3. Server-side abuse limiter check (session turns, consecutive off-topic, hourly user limits)
    const effectiveSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : verifiedUserId;
    const limiterConfig = resolveLimiterConfig(Deno.env);
    const limitCheck = await checkAbuseLimits(verifiedUserId, effectiveSessionId, limiterConfig, supabaseClient);

    if (!limitCheck.allowed) {
      const statusCode = limitCheck.error === "rate_limit_unavailable" ? 503 : 429;
      return new Response(
        JSON.stringify({
          ok: false,
          error: limitCheck.error || "rate_limit_exceeded",
          message: limitCheck.message || "Alcanzaste el límite de consultas permitidas. Podés continuar manualmente."
        }),
        { status: statusCode, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Resolve providers (PRIMARY + FALLBACK)
    const { primaryProvider, fallbackProvider, primaryTimeoutMs, fallbackTimeoutMs } = resolveProviders(Deno.env);

    // 5. Interpret using Primary -> Fallback execution pipeline
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

    if (!fallbackResult.ok || !fallbackResult.patch) {
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

    return new Response(
      JSON.stringify({
        ok: true,
        scope,
        patch: fallbackResult.patch,
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
        primaryLatencyMs: fallbackResult.primaryLatencyMs,
        fallbackLatencyMs: fallbackResult.fallbackLatencyMs,
        totalLatencyMs: fallbackResult.totalLatencyMs,
        primaryFailureType: fallbackResult.primaryFailureType,
        fallbackFailureType: fallbackResult.fallbackFailureType,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    const latencyMs = Date.now() - startTime;
    console.error("[ai-interpret error]", error);

    return new Response(
      JSON.stringify({
        ok: false,
        error: "interpretation_failed",
        message: "No pudimos interpretar el encuentro en este momento. Podés continuar manualmente.",
        latencyMs
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
