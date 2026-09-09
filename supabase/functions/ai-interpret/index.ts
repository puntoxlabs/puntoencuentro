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

/**
 * Best-effort in-memory rate limiter for Beta.
 * Keyed by verified user.id.
 *
 * NOTE ON SECURITY BOUNDARY:
 * This is an isolate-local defensive limit for Beta, NOT a global security boundary.
 * In a serverless Edge environment, timestamps may reset on cold starts or when multiple
 * isolates execute concurrently. It protects against runaway loops from a single client instance.
 */
const requestTimestamps = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 30;
const MAX_MAP_ENTRIES = 1000;

function cleanupExpiredEntries(now: number): void {
  for (const [key, timestamps] of requestTimestamps.entries()) {
    const valid = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (valid.length === 0) {
      requestTimestamps.delete(key);
    } else {
      requestTimestamps.set(key, valid);
    }
  }
}

function isRateLimited(userId: string): boolean {
  const now = Date.now();

  // Prevent unbounded growth of memory in long-running isolates
  if (requestTimestamps.size > MAX_MAP_ENTRIES) {
    cleanupExpiredEntries(now);
  }

  const timestamps = requestTimestamps.get(userId) || [];
  const validTimestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (validTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    requestTimestamps.set(userId, validTimestamps);
    return true;
  }

  validTimestamps.push(now);
  requestTimestamps.set(userId, validTimestamps);
  return false;
}

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

    // 2. Best-effort Rate limiting check keyed by verified user.id
    if (isRateLimited(verifiedUserId)) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "rate_limited",
          message: "Demasiadas solicitudes. Esperá un momento."
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Parse input body
    const body = await req.json();
    const { message, currentDraft } = body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return new Response(
        JSON.stringify({ ok: false, error: "invalid_input", message: "El mensaje no puede estar vacío." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (message.length > 2000) {
      return new Response(
        JSON.stringify({ ok: false, error: "input_too_long", message: "El mensaje es demasiado largo." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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

    return new Response(
      JSON.stringify({
        ok: true,
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
