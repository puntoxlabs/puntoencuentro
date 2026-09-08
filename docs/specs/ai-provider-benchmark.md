# Especificación y Estado de Benchmark: Proveedores de IA

> **Documento:** `docs/specs/ai-provider-benchmark.md`  
> **Fecha de Actualización:** Septiembre 2026  
> **Estado Actual:** 🟢 `BENCHMARK EMPÍRICO REAL TRIPARTITO COMPLETADO (60/60 CASOS EN LOS 3 PROVEEDORES)`  
> **Principio de Integridad:** Se prohíbe terminantemente fabricar, simular o hardcodear resultados de benchmarks. Las métricas reportadas provienen 100% de llamadas HTTP reales contra las APIs de los proveedores evaluados con los 60 casos de prueba canónicos.

---

## 1. Historial de Ejecuciones y Trazabilidad Técnica

### 1.1 Primera Corrida Real (Descartada por Errores de Transporte)
* **Google Gemini (`gemini-2.5-flash`):** `HTTP 400 INVALID_ARGUMENT` por incompatibilidad con `additionalProperties: false`.
* **OpenAI (`gpt-4o-mini`):** `HTTP 429 Too Many Requests` (`credit_balance_exhausted`) por cuenta sin fondos.
* **Resolución:** Descartada formalmente. No se computaron métricas semánticas de esta corrida.

### 1.2 Actualización de Modelos y Correcciones de Adaptadores
1. **Google Gemini:**
   - Identificador actualizado a `gemini-3.8-flash` (dado que `gemini-2.5-flash` arrojó `HTTP 404 NOT_FOUND` para nuevas cuentas).
   - Implementación de `sanitizeSchemaForGemini`: deep-clone inmutable que elimina recursivamente `additionalProperties`.
   - Autenticación segura mediante header `x-goog-api-key` en lugar de parámetro en URL.
   - Mecanismo de reintento ante `HTTP 503 Service Unavailable` transitorio.
2. **OpenAI:**
   - Identificador actualizado a `gpt-5.6-luna`.
   - Implementación de `sanitizeSchemaForOpenAI`: compatibilidad estricta con OpenAI Structured Outputs (`strict: true`), garantizando que toda propiedad en `properties` esté en `required`, convirtiendo campos opcionales en nullables.
   - Implementación de `cleanNullProperties`: depuración recursiva de nulls en la respuesta antes de ingresar a la validación de dominio.
   - Eliminación del parámetro `temperature: 0.1` incompatible con modelos `gpt-5.*` (que requieren temperatura por defecto 1).
3. **DeepSeek:**
   - Identificador configurado: `deepseek-v4-flash` (configurable vía `DEEPSEEK_BENCHMARK_MODEL`).
   - Endpoint: `https://api.deepseek.com/chat/completions`.
   - Formato estructurado: `response_format: { type: "json_object" }` con inyección enriquecida del schema JSON canónico en el system prompt (`sanitizeSchemaForDeepSeek`).
   - Depuración de markdown fences y validación determinística local estricta contra `EncounterDraftPatch`.
   - Captura granular de tokens (`CaseUsageMetrics`): discriminación entre tokens de razonamiento interno (`reasoningTokens`), tokens de salida estructurada visible (`visibleOutputTokens`) y tokens de compleción facturados (`billedCompletionTokens`).
   - Directiva estricta de seguridad y privacidad: el texto crudo de `reasoning_content` se depura en memoria antes de la persistencia de trazas; solo se registran recuentos numéricos.

---

## 2. Resultados Empíricos del Benchmark (60 Casos Canónicos Reales)

### 2.1 Tabla Comparativa Oficial (60 Casos Reales por Proveedor)

| Métrica / Parámetro | OpenAI (`gpt-5.6-luna`) | DeepSeek (`deepseek-v4-flash`) | Google Gemini (`gemini-3.8-flash`) |
| :--- | :--- | :--- | :--- |
| **Endpoint / API** | `https://api.openai.com/v1/chat/completions` | `https://api.deepseek.com/chat/completions` | `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent` |
| **Total Casos Ejecutados** | 60 | 60 | 60 |
| **Casos Exitosos (API)** | **60 (100.0%)** | **60 (100.0%)** | **60 (100.0%)** |
| **Casos Fallidos (API)** | **0 (0.0%)** | **0 (0.0%)** | **0 (0.0%)** |
| **Causa de Falla de API** | Ninguna | Ninguna | Ninguna *(billing verificado)* |
| **Casos Evaluables** | **60** | **60** | **60** |
| **Cumplimiento de Schema** | **100.0%** | **100.0%** | **100.0%** |
| **Extracción Exacta (`exactExtractionRate`)** | **87.0%** *(1º)* | **75.0%** *(2º)* | **45.1%** *(3º)* |
| **Tasa de Omisión (`omissionRate`)** | **13.0%** *(1º)* | **25.0%** *(2º)* | **54.9%** *(3º)* |
| **Tasa de Alucinación (`hallucinationRate`)** | **0.0%** *(Empate)* | **0.0%** *(Empate)* | **0.0%** *(Empate)* |
| **Detección de Ambigüedad (`ambiguityDetectionRate`)** | **90.9%** *(1º)* | **81.8%** *(2º)* | **9.1%** *(3º)* |
| **Latencia Promedio** | 4.070 ms | **495 ms** *(Ultrarrápido)* | 3.171 ms |
| **Latencia p50 (Mediana)** | 4.118 ms | **488 ms** | 2.986 ms |
| **Latencia p95** | 5.742 ms | **556 ms** | 5.354 ms |
| **Tokens Prompt (Entrada)** | 1.322 | 1.625 | **685** |
| **Tokens Salida Visible** | 293 | 119 | **69** |
| **Tokens de Razonamiento** | 0 *(no expone/no usa)* | 3.477 | 0 *(no expone/no usa)* |
| **Tokens Salida Facturados** | 293 | 3.596 | **69** |
| **Tokens Totales Facturados** | 1.615 | 5.221 | **754** |
| **Costo Estimado / 1.000 Creaciones** | `null (unverified)` | `null (unverified)` | `null (unverified)` |

### 2.2 Archivos de Trazas Raw Auditables
* **OpenAI Luna (60 casos):** `scripts/ai-benchmark/results/2026-09-08T18-31-26-172Z_openai_gpt-5_6-luna.json`
* **DeepSeek v4 Flash (60 casos):** `scripts/ai-benchmark/results/2026-09-08T20-15-59-393Z_deepseek_deepseek-v4-flash.json`
* **Google Gemini 3.8 Flash (60 casos):** `scripts/ai-benchmark/results/2026-09-08T19-26-46-873Z_google_gemini-3_8-flash.json`
* **Smoke Tests:**
  - DeepSeek (3 casos): `scripts/ai-benchmark/results/2026-09-08T20-04-05-810Z_smoke_deepseek_deepseek-v4-flash.json`
  - Google Gemini (3 casos): `scripts/ai-benchmark/results/2026-09-08T19-26-32-319Z_smoke_google_gemini-3_8-flash.json`

> [!NOTE]
> Todos los archivos de trazas han sido rigurosamente auditados: no contienen tokens de autorización, claves privadas ni texto de razonamiento confidencial.

---

## 3. Análisis de Desempeño Comparativo

### 3.1 OpenAI (`gpt-5.6-luna`)
* **Extracción Semántica:** **Líder absoluto (87.0% de extracción exacta)**. Destaca por una comprensión contextual profunda de fechas relativas complejas, franjas horarias y señales de coordinación implícitas.
* **Seguridad y Confianza:** **0.0% de alucinación**. Respeta estrictamente los límites del texto provisto sin inferir datos ausentes.
* **Manejo de Ambigüedad:** **Líder (90.9%)**. Tipifica correctamente los casos difusos (`confidence: "ambiguous"`) y formula preguntas clarificadoras precisas.
* **Compromiso (Trade-off):** Mayor latencia del grupo (4.070 ms promedio, 4.118 ms p50).

### 3.2 DeepSeek (`deepseek-v4-flash`)
* **Extracción Semántica:** **Muy sólida (75.0% de extracción exacta)**, superando ampliamente a Gemini. Baja tasa de omisión (25.0%).
* **Seguridad y Confianza:** **0.0% de alucinación** y **100% de cumplimiento de schema**.
* **Manejo de Ambigüedad:** **Notable (81.8%)**, sólo un escalón por debajo de OpenAI y muy por encima de Gemini.
* **Latencia Excepcional:** **495 ms promedio (p50: 488 ms, p95: 556 ms)**. Es aproximadamente **8 veces más rápido que OpenAI** y **6 veces más rápido que Gemini**, ofreciendo una experiencia casi instantánea.
* **Particularidad de Consumo:** Utiliza un motor de razonamiento interno que insume 3.477 tokens de pensamiento para producir 119 tokens visibles estructurados, facturando 3.596 tokens de salida por llamada.

### 3.3 Google Gemini (`gemini-3.8-flash`)
* **Velocidad y Consumo:** Latencia competitiva (3.171 ms media, 2.986 ms p50) y el menor volumen de tokens (685 in, 69 out).
* **Seguridad:** **0.0% de alucinación** y **100% de cumplimiento de schema**.
* **Debilidad Crítica — Alta Tasa de Omisión (54.9%):** Tiende a omitir sistemáticamente entidades temporales o espaciales cuando coexisten con el título, logrando solo un **45.1% de extracción exacta**.
* **Debilidad Crítica — Detección de Ambigüedad (9.1%):** Desatiende la formulación de aclaraciones cuando los datos son imprecisos.

---

## 4. Metodología de Tokens y Facturación en Modelos de Razonamiento

En modelos con proceso de pensamiento como DeepSeek (`deepseek-v4-flash`), la API reporta:
```typescript
completion_tokens = completion_tokens_details.reasoning_tokens + visible_output_tokens
```
Para evitar distorsiones en las métricas de eficiencia, el arnés de benchmark registra:
1. `promptTokens`: Tokens de entrada consumidos por la instrucción y el contexto.
2. `visibleOutputTokens`: Tokens netos de la respuesta estructurada JSON (`billedCompletionTokens - reasoningTokens`).
3. `reasoningTokens`: Tokens consumidos internamente durante la fase de razonamiento.
4. `billedCompletionTokens`: Total de tokens de salida facturados por el proveedor.
5. `totalBilledTokens`: Suma global facturada (`promptTokens + billedCompletionTokens`).

---

## 5. Recomendación Arquitectónica Provisional

Aplicando rigurosamente el orden de prioridad estipulado:
1. Menor tasa de alucinación (Empate en 0.0%)
2. Mayor tasa de extracción exacta (**OpenAI 87.0%** > DeepSeek 75.0% > Gemini 45.1%)
3. Mejor detección de ambigüedad (**OpenAI 90.9%** > DeepSeek 81.8% > Gemini 9.1%)
4. Menor tasa de omisión (**OpenAI 13.0%** < DeepSeek 25.0% < Gemini 54.9%)
5. Cumplimiento de schema (Empate en 100.0%)
6. Estabilidad de API (Empate en 100.0%)
7. Latencia (**DeepSeek 495 ms** < Gemini 3.171 ms < OpenAI 4.070 ms)
8. Costo verificado

### 5.1 Proveedor Primario Provisional (`PROVISIONAL_PRIMARY`)
* **Seleccionado:** **OpenAI (`gpt-5.6-luna`)**
* **Fundamento:** Máxima precisión semántica (87.0% de extracción exacta) y superioridad en la detección de ambigüedad (90.9%). En una experiencia conversacional de creación de encuentros, la precisión semántica inicial reduce las repreguntas y fricciones del usuario.

### 5.2 Proveedor de Contingencia Provisional (`PROVISIONAL_FALLBACK`)
* **Seleccionado:** **DeepSeek (`deepseek-v4-flash`)**
* **Fundamento:** Excelente extracción semántica (75.0%), 0% de alucinaciones, 100% de cumplimiento de schema y una velocidad récord insuperable (495 ms). Constituye un respaldo inmediato extraordinario ante saturaciones, caídas o tiempos de espera elevados del proveedor primario.

### 5.3 Tercera Alternativa / Descarte
* **Google Gemini (`gemini-3.8-flash`):** Queda posicionado como alternativa secundaria terciaria debido a su severa tasa de omisión (54.9%) y pobre detección de ambigüedad (9.1%), requiriendo futuros ajustes de prompt o finetuning si se deseara reevaluar.

> [!IMPORTANT]
> **Estado de Implementación:** El runtime fallback en tiempo de ejecución **ha sido implementado y testeado** (`supabase/functions/ai-interpret/fallback.ts` con OpenAI `gpt-5.6-luna` como Primary y DeepSeek `deepseek-v4-flash` como Fallback, con máximo 1 reintento y preservación de borrador ante double failure).

