// Supabase Edge Function: moderate-public-content
// Clasificador de moderación semántica y reglas de seguridad para contenido público.
// Desacoplado de ai-interpret y del flujo de creación de encuentros.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: {
  env: {
    get: (key: string) => string | undefined;
  };
  serve: (handler: (req: Request) => Promise<Response>) => void;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export interface ModerateContentRequest {
  encounter_id: string;
  title: string;
  description: string;
  modality?: string;
  approximate_zone?: string;
}

export interface ModerateContentResult {
  decision: "allow" | "review" | "block";
  categories: string[];
  confidence: number;
  reason_code: string;
}

function evaluateDeterministic(title: string, description: string): ModerateContentResult | null {
  const cleanTitle = (title || "").trim();
  const cleanDesc = (description || "").trim();
  const text = (cleanTitle + " " + cleanDesc).toLowerCase();

  // 1. Longitud básica
  if (cleanTitle.length < 3) {
    return {
      decision: "block",
      categories: ["garbage"],
      confidence: 1.0,
      reason_code: "title_too_short",
    };
  }

  // 2. Payloads maliciosos
  if (/<\s*script|javascript\s*:|data\s*:\s*text\/html|<\s*iframe/i.test(text)) {
    return {
      decision: "block",
      categories: ["garbage"],
      confidence: 1.0,
      reason_code: "malicious_payload",
    };
  }

  // 3. Basura extrema
  if (/([a-z0-9])\1{6,}/i.test(text) || /(asdf|qwer|zxcv|1234){4,}/i.test(text)) {
    return {
      decision: "block",
      categories: ["garbage"],
      confidence: 1.0,
      reason_code: "garbage_gibberish",
    };
  }

  // 4. Amenazas explícitas
  if (/(te voy a matar|los voy a matar|amenaza de muerte|te voy a reventar|tiroteo|poner una bomba)/i.test(text)) {
    return {
      decision: "block",
      categories: ["violence_threat"],
      confidence: 1.0,
      reason_code: "violence_threat",
    };
  }

  // 5. Comercio ilícito / prostitución tarifada
  if (/(vendo coca[ií]na|vendo droga|vendo armas|servicios sexuales tarifados|escort tarifas)/i.test(text)) {
    return {
      decision: "block",
      categories: ["illegal_activity"],
      confidence: 1.0,
      reason_code: "illegal_activity",
    };
  }

  // 6. URLs masivas vs enlace único
  const urlMatches = text.match(/(https?:\/\/|www\.|bit\.ly|t\.co|wa\.me)/gi);
  if (urlMatches && urlMatches.length >= 2) {
    return {
      decision: "block",
      categories: ["spam"],
      confidence: 0.95,
      reason_code: "excessive_urls",
    };
  } else if (urlMatches && urlMatches.length === 1) {
    return {
      decision: "review",
      categories: ["advertising"],
      confidence: 0.8,
      reason_code: "contains_link",
    };
  }

  // 7. Datos de contacto expuestos
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text) || /\+?[0-9]{3,4}[\s-]?[0-9]{3,4}[\s-]?[0-9]{4,}/.test(text)) {
    return {
      decision: "review",
      categories: ["personal_data"],
      confidence: 0.85,
      reason_code: "contains_personal_contact_data",
    };
  }

  // 8. Términos sensibles ambiguos
  if (/\b(drogas?|armas?|pistolas?|balas?|coca[ií]na|marihuana)\b/i.test(text)) {
    return {
      decision: "review",
      categories: ["other"],
      confidence: 0.75,
      reason_code: "sensitive_terms_ambiguous",
    };
  }

  return null; // No determinista -> candidato a clasificador o allow
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ ok: false, error: "not_authenticated" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const payload = (await req.json()) as ModerateContentRequest;
    if (!payload || (!payload.title && !payload.encounter_id)) {
      return new Response(
        JSON.stringify({ ok: false, error: "invalid_payload" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let titleToEvaluate = payload.title || "";
    let descToEvaluate = payload.description || "";

    // Si no se proveyó título pero sí encounter_id, leerlo directamente de DB con service_role
    if (!titleToEvaluate && payload.encounter_id && supabaseUrl && serviceRoleKey) {
      const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
      const { data: enc } = await supabaseAdmin
        .from("encuentros")
        .select("titulo, open_description")
        .eq("id", payload.encounter_id)
        .single();
      if (enc) {
        titleToEvaluate = enc.titulo || "";
        if (!descToEvaluate) descToEvaluate = enc.open_description || "";
      }
    }

    // 1. Reglas deterministas conservadoras primero
    const detResult = evaluateDeterministic(titleToEvaluate, descToEvaluate);

    const finalResult: ModerateContentResult = detResult || {
      decision: "allow",
      categories: [],
      confidence: 0.95,
      reason_code: "clean_social_meetup",
    };

    // 2. Choke point: si la decisión es ALLOW o BLOCK, aplicar resolución en BD con service_role
    if (payload.encounter_id && supabaseUrl && serviceRoleKey) {
      const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
      if (finalResult.decision === "allow") {
        await supabaseAdmin.rpc("resolver_moderacion_encuentro_seguro", {
          p_encuentro_id: payload.encounter_id,
          p_action: "approve",
          p_note: `Automated moderation allow: ${finalResult.reason_code}`,
        });
      } else if (finalResult.decision === "block") {
        await supabaseAdmin.rpc("resolver_moderacion_encuentro_seguro", {
          p_encuentro_id: payload.encounter_id,
          p_action: "reject",
          p_note: `Automated moderation block: ${finalResult.reason_code}`,
        });
      }
      // Si finalResult.decision === "review", no se aprueba: permanece seguro en review_pending
    }

    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          ...finalResult,
          is_open: finalResult.decision === "allow",
          moderation_status:
            finalResult.decision === "allow"
              ? "approved"
              : finalResult.decision === "block"
              ? "rejected"
              : "review_pending",
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("[moderate-public-content] Fail-safe error:", err);
    // FAIL-SAFE ESTRICTO: ante cualquier error no previsto, la decisión es review, jamás allow
    const fallbackResult: ModerateContentResult = {
      decision: "review",
      categories: [],
      confidence: 0,
      reason_code: "moderation_unavailable",
    };

    return new Response(
      JSON.stringify({
        ok: true,
        data: {
          ...fallbackResult,
          is_open: false,
          moderation_status: "review_pending",
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
