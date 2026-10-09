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
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || serviceRoleKey;

  try {
    // 1. Autenticación estricta del caller mediante JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ ok: false, error: "not_authenticated" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "").trim();
    if (!token) {
      return new Response(
        JSON.stringify({ ok: false, error: "not_authenticated" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validar JWT con Supabase Auth
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: authData, error: authErr } = await userClient.auth.getUser();
    if (authErr || !authData?.user) {
      return new Response(
        JSON.stringify({ ok: false, error: "not_authenticated" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const callerId = authData.user.id;

    // 2. Extracción de encounter_id (NO confiar en texto enviado por cliente)
    const payload = (await req.json().catch(() => ({}))) as Partial<ModerateContentRequest>;
    if (!payload || !payload.encounter_id) {
      return new Response(
        JSON.stringify({ ok: false, error: "invalid_payload", message: "encounter_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing Supabase configuration");
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    // 3. Fuente Canónica de Contenido: leer estrictamente desde DB
    // Exclusión estricta de datos privados: NO se lee lugar_texto, link_virtual, public_token, etc.
    const { data: enc, error: encErr } = await supabaseAdmin
      .from("encuentros")
      .select("id, titulo, open_description, modalidad, open_public_zone, host_id, moderation_status, is_open")
      .eq("id", payload.encounter_id)
      .single();

    if (encErr || !enc) {
      return new Response(
        JSON.stringify({ ok: false, error: "encuentro_not_found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Autorización: sólo el host del encuentro o personal QA/Admin puede disparar moderación
    if (enc.host_id !== callerId) {
      const { data: isQa } = await supabaseAdmin
        .from("qa_authorized_users")
        .select("user_id")
        .eq("user_id", callerId)
        .in("role", ["admin", "qa"])
        .maybeSingle();

      if (!isQa) {
        return new Response(
          JSON.stringify({ ok: false, error: "unauthorized", message: "Only the encounter host may trigger moderation" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // 5. State Machine Precondition: sólo puede moderarse si está en 'review_pending'
    if (enc.moderation_status !== "review_pending") {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "invalid_status_transition",
          current_status: enc.moderation_status,
          message: "Encounter is not in review_pending status",
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 6. TOCTOU Protection: calcular fingerprint canónico sobre los campos en DB
    const { data: expectedHash } = await supabaseAdmin.rpc("calcular_content_hash_moderacion", {
      p_title: enc.titulo,
      p_open_description: enc.open_description,
      p_modalidad: enc.modalidad,
      p_open_public_zone: enc.open_public_zone,
    });

    // 7. Evaluación sobre contenido canónico exclusivamente
    const detResult = evaluateDeterministic(enc.titulo, enc.open_description || "");

    const finalResult: ModerateContentResult = detResult || {
      decision: "allow",
      categories: [],
      confidence: 0.95,
      reason_code: "clean_social_meetup",
    };

    // 8. Choke point: aplicar resolución atómica con service_role validando hash
    if (finalResult.decision === "allow") {
      const { data: resolveResult, error: resolveErr } = await supabaseAdmin.rpc(
        "resolver_moderacion_encuentro_seguro",
        {
          p_encuentro_id: payload.encounter_id,
          p_action: "approve",
          p_note: `Automated moderation allow: ${finalResult.reason_code}`,
          p_expected_content_hash: expectedHash,
        }
      );

      if (resolveErr || !resolveResult?.ok) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: resolveResult?.error || "approval_failed",
            moderation_status: "review_pending",
            is_open: false,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    } else if (finalResult.decision === "block") {
      await supabaseAdmin.rpc("resolver_moderacion_encuentro_seguro", {
        p_encuentro_id: payload.encounter_id,
        p_action: "reject",
        p_note: `Automated moderation block: ${finalResult.reason_code}`,
        p_expected_content_hash: expectedHash,
      });
    }

    // Si finalResult.decision === "review", no se aprueba: permanece seguro en review_pending
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
    // FAIL-SAFE ESTRICTO: ante cualquier error no previsto, jamás fail-open
    const fallbackResult: ModerateContentResult = {
      decision: "review",
      categories: [],
      confidence: 0,
      reason_code: "moderation_unavailable",
    };

    return new Response(
      JSON.stringify({
        ok: false,
        error: "moderation_unavailable",
        data: {
          ...fallbackResult,
          is_open: false,
          moderation_status: "review_pending",
        },
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
