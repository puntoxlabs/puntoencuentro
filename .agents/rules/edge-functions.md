---
trigger: glob
globs:
  - "supabase/functions/**"
description: Directivas para Edge Functions en Deno: autenticación, entitlements, providers y mínimo privilegio.
---

# Supabase Edge Functions (Deno Runtime)

## 1. Validación de Identidad y Acceso
- **Autenticación manual obligatoria:** Extraer el token de `Authorization: Bearer <token>` y verificar criptográficamente la sesión con `supabaseClient.auth.getUser(token)`.
- **Autorización por cuenta permanente:** Si la función exige cuenta permanente (ej. Crear con IA), verificar `user.is_anonymous === false` y rechazar anónimos de inmediato con HTTP 403 (`permanent_account_required`).

## 2. Mínimo Privilegio (Patrón Doble Cliente)
- **`userClient`:** Instanciar con `SUPABASE_PUBLISHABLE_KEYS` y `Authorization: Bearer <token>` del usuario. Permite invocar RPCs respetando `auth.uid()` real.
- **`internalAdminClient`:** Instanciar con `SUPABASE_SECRET_KEYS` exclusivamente para invocar RPCs internas de liquidación/liberación restringidas (`service_role`).

## 3. Validación Previa al Consumo de Providers (LLMs)
- Toda validación de límites anti-abuso horarios y de entitlements mensuales debe ejecutarse en base de datos **ANTES** de invocar a proveedores externos (OpenAI, Mistral).
- Si la cuota está agotada o la sesión está ocupada, abortar con el código semántico correspondiente (`ai_monthly_limit_reached`, `ai_session_busy`) sin generar costos de LLM.

## 4. Respuestas Semánticas y Seguridad
- Respuestas de error estables en formato JSON con códigos HTTP adecuados (401, 403, 409, 429, 503).
- **Liberación ante fallas:** Si los proveedores externos fallan (5xx o timeout de ambos), liberar la reserva de cuota (`provider_failure`) para no penalizar injustamente al usuario.
- Jamás registrar en logs de Edge Functions API keys, JWTs ni datos sensibles de usuarios.
