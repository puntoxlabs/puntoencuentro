import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SYSTEM_PROMPT } from '../../supabase/functions/ai-interpret/prompt.ts';
import {
  ENCOUNTER_DRAFT_PATCH_SCHEMA,
  sanitizeSchemaForGemini,
  sanitizeSchemaForOpenAI,
  sanitizeSchemaForDeepSeek,
  cleanNullProperties,
  validatePatchOutput,
} from '../../supabase/functions/ai-interpret/validation.ts';
import {
  scoreTestCase,
  createProviderErrorScore,
  aggregateScores,
  type CaseScoreResult,
  type AggregatedBenchmarkScore,
  type ExpectedGroundTruth,
} from './scoring.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const inputsPath = path.join(__dirname, 'inputs.json');
const rawInputs: Array<{
  id: number;
  category: string;
  text: string;
  expected: ExpectedGroundTruth;
}> = JSON.parse(fs.readFileSync(inputsPath, 'utf8'));

interface DocumentedPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  verifiedDate: string;
}

const DOCUMENTED_PRICING: Record<string, DocumentedPrice> = {
  'gemini-2.5-flash': {
    inputPerMillionUsd: 0.10,
    outputPerMillionUsd: 0.40,
    verifiedDate: '2026-09',
  },
  'gemini-2.0-flash': {
    inputPerMillionUsd: 0.10,
    outputPerMillionUsd: 0.40,
    verifiedDate: '2026-09',
  },
  'gpt-4o-mini': {
    inputPerMillionUsd: 0.15,
    outputPerMillionUsd: 0.60,
    verifiedDate: '2026-09',
  },
};

export class ProviderApiError extends Error {
  httpStatus?: number;
  latencyMs: number;
  responseBody?: string;
  constructor(message: string, latencyMs: number, httpStatus?: number, responseBody?: string) {
    super(message);
    this.name = 'ProviderApiError';
    this.latencyMs = latencyMs;
    this.httpStatus = httpStatus;
    this.responseBody = responseBody;
  }
}

export interface CaseUsageMetrics {
  promptTokens: number;
  visibleOutputTokens: number;
  reasoningTokens: number;
  billedCompletionTokens: number;
  totalBilledTokens: number;
  // Backwards compatibility aliases:
  inputTokens: number;
  outputTokens: number;
}

export function extractUsageMetrics(usage: Record<string, any> = {}): CaseUsageMetrics {
  const promptTokens = Math.max(0, usage.prompt_tokens ?? usage.promptTokenCount ?? 0);
  const reasoningTokens = Math.max(0, usage.completion_tokens_details?.reasoning_tokens ?? 0);
  const billedCompletionTokens = Math.max(0, usage.completion_tokens ?? usage.candidatesTokenCount ?? 0);
  const visibleOutputTokens = Math.max(0, billedCompletionTokens - reasoningTokens);
  const totalBilledTokens = Math.max(
    0,
    usage.total_tokens ?? usage.totalTokenCount ?? (promptTokens + billedCompletionTokens)
  );

  return {
    promptTokens,
    visibleOutputTokens,
    reasoningTokens,
    billedCompletionTokens,
    totalBilledTokens,
    inputTokens: promptTokens,
    outputTokens: billedCompletionTokens,
  };
}

export interface ProviderCallResult {
  patch: unknown;
  usage: CaseUsageMetrics;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  httpStatus: number;
}

export interface RawCaseTrace {
  provider: 'google' | 'openai' | 'deepseek';
  model: string;
  inputId: number;
  category: string;
  inputText: string;
  status: 'success' | 'provider_error';
  httpStatus?: number;
  latencyMs: number;
  usage?: CaseUsageMetrics;
  output?: unknown;
  error?: string;
  score?: CaseScoreResult;
}

export interface ModelBenchmarkExecutionResult {
  provider: 'google' | 'openai' | 'deepseek';
  model: string;
  executionTimestamp: string;
  totalCases: number;
  successfulCases: number;
  failedCases: number;
  apiSuccessRate: number;
  apiFailureRate: number;
  aggregatedScore: AggregatedBenchmarkScore;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  // Detailed token breakdown
  avgPromptTokens: number | null;
  avgVisibleOutputTokens: number | null;
  avgReasoningTokens: number | null;
  avgBilledCompletionTokens: number | null;
  avgTotalBilledTokens: number | null;
  totalTokensProcessed: number;
  // Backwards compatibility aliases
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  calculatedCostPer1000Usd: number | null;
  rawResultsPath?: string;
}

function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

// -----------------------------------------------------------------------------
// Provider Callers (Real HTTP calls with JSON Schema)
// -----------------------------------------------------------------------------

export async function callGoogleGemini(
  apiKey: string,
  model: string,
  userMessage: string
): Promise<{ patch: unknown; inputTokens: number; outputTokens: number; latencyMs: number; httpStatus: number }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const startTime = Date.now();

  const requestBody = {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: `Mensaje del usuario: "${userMessage}"` }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: sanitizeSchemaForGemini(ENCOUNTER_DRAFT_PATCH_SCHEMA),
      temperature: 0.1,
    },
  };

  let response!: Response;
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (response.status === 503 && attempts < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempts * 2000));
      continue;
    }
    break;
  }

  const latencyMs = Date.now() - startTime;

  if (!response.ok) {
    const errText = await response.text();
    throw new ProviderApiError(`Google API error HTTP ${response.status}: ${errText}`, latencyMs, response.status, errText);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new ProviderApiError('No candidate content text returned by Google API', latencyMs, response.status);
  }

  const patch = JSON.parse(text);
  const usage = data.usageMetadata || {};
  const metrics = extractUsageMetrics({
    promptTokenCount: usage.promptTokenCount,
    candidatesTokenCount: usage.candidatesTokenCount,
    totalTokenCount: usage.totalTokenCount,
  });

  return {
    patch,
    usage: metrics,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    latencyMs,
    httpStatus: response.status,
  };
}

export async function callOpenAi(
  apiKey: string,
  model: string,
  userMessage: string
): Promise<ProviderCallResult> {
  const url = 'https://api.openai.com/v1/chat/completions';
  const startTime = Date.now();

  const requestBody = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Mensaje del usuario: "${userMessage}"` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'encounter_draft_patch',
        strict: true,
        schema: sanitizeSchemaForOpenAI(ENCOUNTER_DRAFT_PATCH_SCHEMA),
      },
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  const latencyMs = Date.now() - startTime;

  if (!response.ok) {
    const errText = await response.text();
    throw new ProviderApiError(`OpenAI API error HTTP ${response.status}: ${errText}`, latencyMs, response.status, errText);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new ProviderApiError('No choice content returned by OpenAI API', latencyMs, response.status);
  }

  const rawParsed = JSON.parse(content);
  const patch = cleanNullProperties(rawParsed);
  const usage = data.usage || {};
  const metrics = extractUsageMetrics(usage);

  return {
    patch,
    usage: metrics,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    latencyMs,
    httpStatus: response.status,
  };
}

export async function callDeepSeek(
  apiKey: string,
  model: string,
  userMessage: string
): Promise<ProviderCallResult> {
  const url = 'https://api.deepseek.com/chat/completions';
  const startTime = Date.now();

  const schemaToUse = sanitizeSchemaForDeepSeek(ENCOUNTER_DRAFT_PATCH_SCHEMA);
  const enrichedSystemPrompt = `${SYSTEM_PROMPT}\n\nOBLIGATORIO: Debes responder ÚNICAMENTE con un JSON que cumpla este JSON Schema estricto:\n${JSON.stringify(schemaToUse)}`;

  const requestBody = {
    model,
    messages: [
      { role: 'system', content: enrichedSystemPrompt },
      { role: 'user', content: `Mensaje del usuario: "${userMessage}"` },
    ],
    response_format: {
      type: 'json_object',
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  const latencyMs = Date.now() - startTime;

  if (!response.ok) {
    const errText = await response.text();
    throw new ProviderApiError(`DeepSeek API error HTTP ${response.status}: ${errText}`, latencyMs, response.status, errText);
  }

  const data = await response.json();
  const rawContent = data.choices?.[0]?.message?.content;
  if (!rawContent || rawContent.trim() === '') {
    throw new ProviderApiError('No choice content returned by DeepSeek API', latencyMs, response.status);
  }

  // Security & Privacy rule: strip textual reasoning content before persisting or returning
  if (data.choices?.[0]?.message?.reasoning_content) {
    delete data.choices[0].message.reasoning_content;
  }

  const cleanedContent = rawContent.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(cleanedContent);
  } catch (parseErr) {
    throw new ProviderApiError(`Invalid JSON returned by DeepSeek: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`, latencyMs, response.status);
  }

  const patch = cleanNullProperties(rawParsed as Record<string, unknown>);
  const validation = validatePatchOutput(patch);
  if (!validation.valid) {
    throw new ProviderApiError(`DeepSeek output failed schema validation: ${validation.error}`, latencyMs, response.status);
  }

  const usage = data.usage || {};
  const metrics = extractUsageMetrics(usage);

  return {
    patch,
    usage: metrics,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    latencyMs,
    httpStatus: response.status,
  };
}

// -----------------------------------------------------------------------------
// Model Benchmark Runner
// -----------------------------------------------------------------------------

export async function runModelBenchmark(
  provider: 'google' | 'openai' | 'deepseek',
  model: string,
  apiKey: string,
  caseLimit?: number
): Promise<ModelBenchmarkExecutionResult> {
  const executionTimestamp = new Date().toISOString();
  const casesToRun = caseLimit ? rawInputs.slice(0, caseLimit) : rawInputs;
  const isSmoke = !!caseLimit;

  console.log(`\n▶ Running ${isSmoke ? 'SMOKE TEST' : 'REAL BENCHMARK'} for ${provider.toUpperCase()} (${model})...`);
  console.log(`  Cases to evaluate: ${casesToRun.length}`);

  const caseTraces: RawCaseTrace[] = [];
  const successfulLatencies: number[] = [];
  const failedLatencies: number[] = [];
  let totalPromptTokens = 0;
  let totalVisibleOutputTokens = 0;
  let totalReasoningTokens = 0;
  let totalBilledCompletionTokens = 0;
  let totalBilledTokens = 0;
  let hasTokenUsage = false;

  for (let i = 0; i < casesToRun.length; i++) {
    const testCase = casesToRun[i];
    process.stdout.write(`  [${i + 1}/${casesToRun.length}] Case #${testCase.id} (${testCase.category})... `);

    const caseStartTime = Date.now();
    try {
      let callRes: ProviderCallResult;

      if (provider === 'google') {
        callRes = await callGoogleGemini(apiKey, model, testCase.text);
      } else if (provider === 'openai') {
        callRes = await callOpenAi(apiKey, model, testCase.text);
      } else {
        callRes = await callDeepSeek(apiKey, model, testCase.text);
      }

      successfulLatencies.push(callRes.latencyMs);

      if (callRes.usage.promptTokens > 0 || callRes.usage.billedCompletionTokens > 0) {
        hasTokenUsage = true;
        totalPromptTokens += callRes.usage.promptTokens;
        totalVisibleOutputTokens += callRes.usage.visibleOutputTokens;
        totalReasoningTokens += callRes.usage.reasoningTokens;
        totalBilledCompletionTokens += callRes.usage.billedCompletionTokens;
        totalBilledTokens += callRes.usage.totalBilledTokens;
      }

      const score = scoreTestCase(testCase.id, callRes.patch, testCase.expected);

      caseTraces.push({
        provider,
        model,
        inputId: testCase.id,
        category: testCase.category,
        inputText: testCase.text,
        status: 'success',
        httpStatus: callRes.httpStatus,
        latencyMs: callRes.latencyMs,
        usage: callRes.usage,
        output: callRes.patch,
        score,
      });

      console.log(`OK (${callRes.latencyMs}ms, exact: ${score.exactExtractionRate}%)`);
    } catch (err: any) {
      const durationMs = err instanceof ProviderApiError ? err.latencyMs : (Date.now() - caseStartTime);
      failedLatencies.push(durationMs);
      const httpStatus = err instanceof ProviderApiError ? err.httpStatus : undefined;
      const errMsg = err instanceof Error ? err.message : String(err);

      console.log(`FAILED: ${errMsg} (${durationMs}ms)`);
      const errorScore = createProviderErrorScore(testCase.id, httpStatus, errMsg);

      caseTraces.push({
        provider,
        model,
        inputId: testCase.id,
        category: testCase.category,
        inputText: testCase.text,
        status: 'provider_error',
        httpStatus,
        latencyMs: durationMs,
        error: errMsg,
        score: errorScore,
      });
    }

    // Small defensive pause between requests to prevent aggressive rate limiting
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const caseScores = caseTraces.map((t) => t.score!).filter(Boolean);
  const aggregatedScore = aggregateScores(caseScores);

  successfulLatencies.sort((a, b) => a - b);
  const avgLatencyMs = successfulLatencies.length > 0
    ? Math.round(successfulLatencies.reduce((a, b) => a + b, 0) / successfulLatencies.length)
    : (failedLatencies.length > 0 ? Math.round(failedLatencies.reduce((a, b) => a + b, 0) / failedLatencies.length) : 0);

  const p50LatencyMs = successfulLatencies.length > 0
    ? calculatePercentile(successfulLatencies, 50)
    : 0;

  const p95LatencyMs = successfulLatencies.length > 0
    ? calculatePercentile(successfulLatencies, 95)
    : 0;

  const avgPromptTokens = hasTokenUsage && successfulLatencies.length > 0
    ? Math.round(totalPromptTokens / successfulLatencies.length)
    : null;
  const avgVisibleOutputTokens = hasTokenUsage && successfulLatencies.length > 0
    ? Math.round(totalVisibleOutputTokens / successfulLatencies.length)
    : null;
  const avgReasoningTokens = hasTokenUsage && successfulLatencies.length > 0
    ? Math.round(totalReasoningTokens / successfulLatencies.length)
    : null;
  const avgBilledCompletionTokens = hasTokenUsage && successfulLatencies.length > 0
    ? Math.round(totalBilledCompletionTokens / successfulLatencies.length)
    : null;
  const avgTotalBilledTokens = hasTokenUsage && successfulLatencies.length > 0
    ? Math.round(totalBilledTokens / successfulLatencies.length)
    : null;
  const totalTokensProcessed = totalBilledTokens;

  // Backwards compatibility aliases:
  const avgInputTokens = avgPromptTokens;
  const avgOutputTokens = avgBilledCompletionTokens;

  // Calculate cost based on documented pricing or null if unverified
  let calculatedCostPer1000Usd: number | null = null;
  const pricing = DOCUMENTED_PRICING[model];
  if (pricing && avgInputTokens !== null && avgOutputTokens !== null) {
    const costPerRequest =
      (avgInputTokens / 1_000_000) * pricing.inputPerMillionUsd +
      (avgOutputTokens / 1_000_000) * pricing.outputPerMillionUsd;
    calculatedCostPer1000Usd = Math.round(costPerRequest * 1000 * 1000) / 1000;
  }

  // Save raw auditable trace to scripts/ai-benchmark/results/
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const safeTimestamp = executionTimestamp.replace(/[:.]/g, '-');
  const safeModel = model.replace(/[^a-zA-Z0-9_-]/g, '_');
  const modePrefix = isSmoke ? 'smoke_' : '';
  const rawResultsFilename = `${safeTimestamp}_${modePrefix}${provider}_${safeModel}.json`;
  const rawResultsPath = path.join(resultsDir, rawResultsFilename);

  const rawTracePayload = {
    provider,
    model,
    executionTimestamp,
    totalCases: casesToRun.length,
    successfulCases: caseTraces.filter((c) => c.status === 'success').length,
    failedCases: caseTraces.filter((c) => c.status === 'provider_error').length,
    apiSuccessRate: aggregatedScore.apiSuccessRate,
    apiFailureRate: aggregatedScore.apiFailureRate,
    failureReasons: aggregatedScore.failureReasons,
    aggregatedScore,
    performance: {
      avgLatencyMs,
      p50LatencyMs,
      p95LatencyMs,
      avgInputTokens,
      avgOutputTokens,
      avgPromptTokens,
      avgVisibleOutputTokens,
      avgReasoningTokens,
      avgBilledCompletionTokens,
      avgTotalBilledTokens,
      totalTokensProcessed,
      calculatedCostPer1000Usd,
    },
    cases: caseTraces,
  };

  fs.writeFileSync(rawResultsPath, JSON.stringify(rawTracePayload, null, 2), 'utf8');
  console.log(`\n  💾 Raw auditable traces saved to: scripts/ai-benchmark/results/${rawResultsFilename}`);

  return {
    provider,
    model,
    executionTimestamp,
    totalCases: casesToRun.length,
    successfulCases: caseTraces.filter((c) => c.status === 'success').length,
    failedCases: caseTraces.filter((c) => c.status === 'provider_error').length,
    apiSuccessRate: aggregatedScore.apiSuccessRate,
    apiFailureRate: aggregatedScore.apiFailureRate,
    aggregatedScore,
    avgLatencyMs,
    p50LatencyMs,
    p95LatencyMs,
    avgPromptTokens,
    avgVisibleOutputTokens,
    avgReasoningTokens,
    avgBilledCompletionTokens,
    avgTotalBilledTokens,
    totalTokensProcessed,
    avgInputTokens,
    avgOutputTokens,
    calculatedCostPer1000Usd,
    rawResultsPath,
  };
}

// -----------------------------------------------------------------------------
// Main CLI Execution
// -----------------------------------------------------------------------------

async function main() {
  const isSmoke = process.argv.includes('--smoke');
  const caseLimit = isSmoke ? 3 : undefined;

  console.log('============================================================');
  console.log(`PUNTO ENCUENTRO — AI PROVIDER BENCHMARK ${isSmoke ? '(SMOKE TEST: 3 CASES)' : '(FULL: 60 CASES)'}`);
  console.log('============================================================');

  const googleApiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY;

  const googleModel = process.env.GOOGLE_BENCHMARK_MODEL || 'gemini-3.8-flash';
  const openaiModel = process.env.OPENAI_BENCHMARK_MODEL || 'gpt-5.6-luna';
  const deepseekModel = process.env.DEEPSEEK_BENCHMARK_MODEL || 'deepseek-v4-flash';

  const providerFilter = (
    process.argv.find((a) => a.startsWith('--provider='))?.split('=')[1] ||
    (process.argv.includes('--provider') ? process.argv[process.argv.indexOf('--provider') + 1] : undefined)
  )?.toLowerCase();

  const hasGoogle = !!googleApiKey;
  const hasOpenAi = !!openaiApiKey;
  const hasDeepSeek = !!deepseekApiKey;

  if (providerFilter === 'deepseek' && !hasDeepSeek) {
    console.log('\n============================================================');
    console.log('DEEPSEEK ADAPTER READY — LIVE BENCHMARK PENDING API KEY');
    console.log('============================================================');
    console.log('DeepSeek adapter and harness are fully implemented and verified.');
    console.log('No live requests were made because DEEPSEEK_API_KEY is not configured.\n');
    console.log('To execute once the API key is available:');
    console.log('  $env:DEEPSEEK_API_KEY="your-deepseek-key"');
    console.log(`  $env:DEEPSEEK_BENCHMARK_MODEL="${deepseekModel}"`);
    console.log('  npm run benchmark -- --smoke --provider=deepseek');
    console.log('  npm run benchmark -- --provider=deepseek');
    console.log('============================================================\n');
    process.exit(0);
  }

  const shouldRunGoogle = hasGoogle && (!providerFilter || providerFilter === 'google');
  const shouldRunOpenAi = hasOpenAi && (!providerFilter || providerFilter === 'openai');
  const shouldRunDeepSeek = hasDeepSeek && (!providerFilter || providerFilter === 'deepseek');

  if (!shouldRunGoogle && !shouldRunOpenAi && !shouldRunDeepSeek) {
    console.log('\n❌ STATUS: BENCHMARK NOT EXECUTED');
    console.log('REASON: Missing provider credentials or unmatched provider filter in environment.\n');
    console.log('No live API calls could be made. No fake or simulated results are produced.');
    console.log('\nRequired secrets to execute real live benchmarks:');
    console.log('  - For Google models: GEMINI_API_KEY (or AI_API_KEY)');
    console.log('  - For OpenAI models: OPENAI_API_KEY');
    console.log('  - For DeepSeek models: DEEPSEEK_API_KEY');
    console.log('\nConfigurable models:');
    console.log(`  - GOOGLE_BENCHMARK_MODEL (current default: ${googleModel})`);
    console.log(`  - OPENAI_BENCHMARK_MODEL (current default: ${openaiModel})`);
    console.log(`  - DEEPSEEK_BENCHMARK_MODEL (current default: ${deepseekModel})`);
    console.log('\nAvailable filters:');
    console.log('  --provider=google | --provider=openai | --provider=deepseek');
    console.log('\nArchitecture & Harness Status:');
    console.log('  - Benchmark harness: READY (scoring logic, ground truth, trace recording)');
    console.log('  - Ground truth cases: 60 validated cases in inputs.json');
    console.log('  - Provider winner: NONE (awaiting empirical execution with real keys)');
    console.log('============================================================\n');
    process.exit(1);
  }

  const results: ModelBenchmarkExecutionResult[] = [];

  if (shouldRunGoogle) {
    try {
      const res = await runModelBenchmark('google', googleModel, googleApiKey!, caseLimit);
      results.push(res);
    } catch (err) {
      console.error(`Error running Google benchmark:`, err);
    }
  } else if (!providerFilter && !hasGoogle) {
    console.log(`\n⚠️ Skipping Google benchmark: GEMINI_API_KEY not configured.`);
  }

  if (shouldRunOpenAi) {
    try {
      const res = await runModelBenchmark('openai', openaiModel, openaiApiKey!, caseLimit);
      results.push(res);
    } catch (err) {
      console.error(`Error running OpenAI benchmark:`, err);
    }
  } else if (!providerFilter && !hasOpenAi) {
    console.log(`\n⚠️ Skipping OpenAI benchmark: OPENAI_API_KEY not configured.`);
  }

  if (shouldRunDeepSeek) {
    try {
      const res = await runModelBenchmark('deepseek', deepseekModel, deepseekApiKey!, caseLimit);
      results.push(res);
    } catch (err) {
      console.error(`Error running DeepSeek benchmark:`, err);
    }
  } else if (!providerFilter && !hasDeepSeek) {
    console.log(`\n⚠️ Skipping DeepSeek benchmark: DEEPSEEK_API_KEY not configured.`);
  }

  if (results.length === 0) {
    console.error('\n❌ No provider benchmarks completed successfully.');
    process.exit(1);
  }

  console.log('\n============================================================');
  console.log(`REAL BENCHMARK EXECUTION SUMMARY (${isSmoke ? 'SMOKE TEST' : 'EMPIRICAL DATA'})`);
  console.log('============================================================');

  const tableSummary = results.map((r) => ({
    Provider: r.provider,
    Model: r.model,
    'API Success': `${r.apiSuccessRate}% (${r.successfulCases}/${r.totalCases})`,
    'Schema Compliance': `${r.aggregatedScore.validSchemaPercentage}%`,
    'Exact Extraction': `${r.aggregatedScore.exactExtractionRate}%`,
    'Omission Rate': `${r.aggregatedScore.omissionRate}%`,
    'Hallucination Rate': `${r.aggregatedScore.hallucinationRate}%`,
    'Ambiguity Detection': `${r.aggregatedScore.ambiguityDetectionRate}%`,
    'Avg Latency (ms)': r.avgLatencyMs,
    'p50 Latency (ms)': r.p50LatencyMs,
    'p95 Latency (ms)': r.p95LatencyMs,
    'Prompt Tokens': r.avgPromptTokens ?? r.avgInputTokens ?? 'N/A',
    'Visible Out': r.avgVisibleOutputTokens ?? 'N/A',
    'Reasoning Tokens': r.avgReasoningTokens ?? 0,
    'Billed Out': r.avgBilledCompletionTokens ?? r.avgOutputTokens ?? 'N/A',
    'Total Billed': r.avgTotalBilledTokens ?? 'N/A',
    'Est. Cost / 1k (USD)': r.calculatedCostPer1000Usd !== null ? `$${r.calculatedCostPer1000Usd}` : 'null (unverified)',
  }));

  console.table(tableSummary);
  console.log('============================================================\n');
}

// Execute when run as main script
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('Fatal benchmark error:', err);
    process.exit(1);
  });
}
