// Supabase Edge Function: ai-interpret
// Interprets user natural language input into an EncounterDraftPatch.
// Thin semantic interpreter only: no database mutations, no business rules resolution.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { ENCOUNTER_DRAFT_PATCH_SCHEMA, validatePatchOutput } from "./validation.ts";
import { GoogleGeminiProvider } from "./providers/google.ts";
import { OpenAiProvider } from "./providers/openai.ts";
import { DeepSeekProvider } from "./providers/deepseek.ts";
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

function resolveProvider(): EncounterInterpreterProvider {
  const providerName = (Deno.env.get("AI_PROVIDER") || "google").toLowerCase();
  const modelName = Deno.env.get("AI_MODEL");

  if (providerName === "openai") {
    const apiKey = Deno.env.get("OPENAI_API_KEY") || Deno.env.get("AI_API_KEY");
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY / AI_API_KEY in environment");
    return new OpenAiProvider(apiKey, modelName || "gpt-5.6-luna");
  }

  if (providerName === "deepseek") {
    const apiKey = Deno.env.get("DEEPSEEK_API_KEY") || Deno.env.get("AI_API_KEY");
    if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY / AI_API_KEY in environment");
    return new DeepSeekProvider(apiKey, modelName || "deepseek-v4-flash");
  }

  // Temporary development default (not selected by benchmark): Google Gemini
  const apiKey = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("AI_API_KEY");
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY / AI_API_KEY in environment");
  return new GoogleGeminiProvider(apiKey, modelName || "gemini-3.8-flash");
}

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

    // 4. Resolve provider
    const provider = resolveProvider();

    // 5. Interpret with 1 controlled retry on schema invalidation
    let interpretationResult;
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        interpretationResult = await provider.interpret({
          message: message.trim(),
          currentDraft,
          systemPrompt: SYSTEM_PROMPT,
          jsonSchema: ENCOUNTER_DRAFT_PATCH_SCHEMA
        });

        const validation = validatePatchOutput(interpretationResult.patch);
        if (validation.valid) {
          break; // Succeeded!
        } else if (attempts >= maxAttempts) {
          throw new Error(`Schema validation failed: ${validation.error}`);
        }
      } catch (err) {
        if (attempts >= maxAttempts) {
          throw err;
        }
      }
    }

    if (!interpretationResult) {
      throw new Error("No interpretation result produced");
    }

    const latencyMs = Date.now() - startTime;

    return new Response(
      JSON.stringify({
        ok: true,
        patch: interpretationResult.patch,
        usage: {
          inputTokens: interpretationResult.inputTokens,
          outputTokens: interpretationResult.outputTokens,
          latencyMs
        },
        provider: provider.name,
        model: provider.model
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
        details: error instanceof Error ? error.message : String(error),
        latencyMs
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
