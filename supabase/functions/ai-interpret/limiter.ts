// Supabase Edge Function: ai-interpret abuse limiter
// Server-side enforcement of session turn limits, durable short-burst limit, hourly user rate limits, and off-topic locking.

export interface AbuseLimiterConfig {
  maxTurnsPerSession: number;
  maxRequestsPerHour: number;
  maxBurstRequestsPerMinute: number;
  maxConsecutiveOffTopic: number;
}

export interface SessionTracker {
  turns: number;
  consecutiveOffTopic: number;
  userId: string;
  lastActive: number;
}

export interface LimitCheckResult {
  allowed: boolean;
  error?: 'session_limit_reached' | 'rate_limit_exceeded' | 'session_locked_off_topic' | 'rate_limit_unavailable';
  message?: string;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PROMPT_REPEAT_WINDOW_MS = 120 * 1000; // 2 minutes
const MAX_PROMPT_REPEATS = 3; // Allow up to 3 identical prompts in 2m; 4th is blocked

// In-memory state (fast isolate-level sliding window, prompt repeat tracking, and session trackers)
const sessions = new Map<string, SessionTracker>();
const userRequestTimestamps = new Map<string, number[]>();
const userPromptTimestamps = new Map<string, number[]>();

export function resolveLimiterConfig(env: { get: (k: string) => string | undefined }): AbuseLimiterConfig {
  const turnsRaw = env.get('AI_MAX_TURNS_PER_SESSION');
  const hourlyRaw = env.get('AI_MAX_REQUESTS_PER_USER_HOUR');
  const burstRaw = env.get('AI_MAX_BURST_PER_MINUTE');
  const offTopicRaw = env.get('AI_MAX_CONSECUTIVE_OFF_TOPIC');

  return {
    maxTurnsPerSession: turnsRaw ? parseInt(turnsRaw, 10) : 20,
    maxRequestsPerHour: hourlyRaw ? parseInt(hourlyRaw, 10) : 40,
    maxBurstRequestsPerMinute: burstRaw ? parseInt(burstRaw, 10) : 10,
    maxConsecutiveOffTopic: offTopicRaw ? parseInt(offTopicRaw, 10) : 2,
  };
}

function cleanupStaleEntries(now: number): void {
  for (const [sId, data] of sessions.entries()) {
    if (now - data.lastActive > SESSION_TTL_MS) {
      sessions.delete(sId);
    }
  }

  for (const [uId, timestamps] of userRequestTimestamps.entries()) {
    const valid = timestamps.filter((t) => now - t < ONE_HOUR_MS);
    if (valid.length === 0) {
      userRequestTimestamps.delete(uId);
    } else {
      userRequestTimestamps.set(uId, valid);
    }
  }

  for (const [key, timestamps] of userPromptTimestamps.entries()) {
    const valid = timestamps.filter((t) => now - t < PROMPT_REPEAT_WINDOW_MS);
    if (valid.length === 0) {
      userPromptTimestamps.delete(key);
    } else {
      userPromptTimestamps.set(key, valid);
    }
  }
}

/**
 * Computes a SHA-256 hash of a normalized prompt for safe, privacy-preserving repeat tracking.
 * Never stores or transmits the raw prompt text in tracking structures.
 */
export async function computePromptHash(prompt: string): Promise<string> {
  const normalized = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Checks for abnormal repetition of the exact same normalized prompt within a short window (120s).
 * Allows normal human retries (up to 3 attempts), blocking 4th+ with controlled 429.
 */
export function checkPromptRepetition(userId: string, promptHash: string): LimitCheckResult {
  const now = Date.now();
  if (userPromptTimestamps.size > 500) {
    cleanupStaleEntries(now);
  }

  const key = `${userId}:${promptHash}`;
  const existing = userPromptTimestamps.get(key) || [];
  const valid = existing.filter((t) => now - t < PROMPT_REPEAT_WINDOW_MS);

  if (valid.length >= MAX_PROMPT_REPEATS) {
    userPromptTimestamps.set(key, valid);
    return {
      allowed: false,
      error: 'rate_limit_exceeded',
      message: 'Hubo demasiados intentos en poco tiempo. Probá nuevamente en unos minutos.',
    };
  }

  valid.push(now);
  userPromptTimestamps.set(key, valid);
  return { allowed: true };
}

/**
 * Durable short-burst rate limiter (1-minute window) via atomic PostgreSQL RPC.
 * Guaranteed to operate across distributed Edge Function isolates and limit rapid bursts.
 */
export async function checkShortBurstLimit(
  userId: string,
  config: AbuseLimiterConfig,
  supabaseClient?: any
): Promise<LimitCheckResult> {
  if (!supabaseClient) {
    return {
      allowed: false,
      error: 'rate_limit_unavailable',
      message: 'No pudimos validar temporalmente el uso de Crear con IA. Podés continuar manualmente o intentar nuevamente.',
    };
  }

  try {
    const { data, error } = await supabaseClient.rpc('check_and_increment_ai_burst_limit', {
      p_max_burst_requests: config.maxBurstRequestsPerMinute,
    });

    if (error || !data) {
      return {
        allowed: false,
        error: 'rate_limit_unavailable',
        message: 'No pudimos validar temporalmente el uso de Crear con IA. Podés continuar manualmente o intentar nuevamente.',
      };
    }

    if (data.allowed === false) {
      return {
        allowed: false,
        error: 'rate_limit_exceeded',
        message: data.message || 'Hubo demasiados intentos en poco tiempo. Probá nuevamente en unos minutos.',
      };
    }

    return { allowed: true };
  } catch (_err) {
    return {
      allowed: false,
      error: 'rate_limit_unavailable',
      message: 'No pudimos validar temporalmente el uso de Crear con IA. Podés continuar manualmente o intentar nuevamente.',
    };
  }
}

/**
 * Validates request against server-side session turns, consecutive off-topic limits,
 * and user hourly limits BEFORE calling any external AI provider.
 * Enforces FAIL-CLOSED: if durable rate-limiting cannot be verified, access is denied.
 */
export async function checkAbuseLimits(
  userId: string,
  sessionId: string,
  config: AbuseLimiterConfig,
  supabaseClient?: any,
  promptHash?: string
): Promise<LimitCheckResult> {
  const now = Date.now();
  if (sessions.size > 500 || userRequestTimestamps.size > 500 || userPromptTimestamps.size > 500) {
    cleanupStaleEntries(now);
  }

  // 1. Session-level consecutive off-topic lock (Soft UX lock)
  const session = sessions.get(sessionId);
  if (session && session.consecutiveOffTopic >= config.maxConsecutiveOffTopic) {
    return {
      allowed: false,
      error: 'session_locked_off_topic',
      message: 'Crear con IA está disponible solo para organizar encuentros. Para este encuentro podés continuar editando los datos manualmente.',
    };
  }

  // 2. Session-level max turns (Soft UX lock)
  if (session && session.turns >= config.maxTurnsPerSession) {
    return {
      allowed: false,
      error: 'session_limit_reached',
      message: 'Alcanzaste el límite de mensajes para este borrador. Podés continuar manualmente.',
    };
  }

  // 3. Repeated prompt check (if promptHash provided)
  if (promptHash) {
    const repeatCheck = checkPromptRepetition(userId, promptHash);
    if (!repeatCheck.allowed) {
      return repeatCheck;
    }
  }

  // 4. Fast isolate-level pre-check (soft protection / optimization before touching DB)
  const timestamps = userRequestTimestamps.get(userId) || [];
  const validTimestamps = timestamps.filter((t) => now - t < ONE_HOUR_MS);
  if (validTimestamps.length >= config.maxRequestsPerHour) {
    userRequestTimestamps.set(userId, validTimestamps);
    return {
      allowed: false,
      error: 'rate_limit_exceeded',
      message: 'Alcanzaste el límite de consultas de IA por hora. Podés continuar manualmente.',
    };
  }

  // 5. Durable Distributed Rate Limit via atomic Postgres RPC (Hard Limit, FAIL-CLOSED)
  // Operates exclusively via auth.uid() inside Postgres; no user ID is passed.
  if (!supabaseClient) {
    return {
      allowed: false,
      error: 'rate_limit_unavailable',
      message: 'No pudimos validar temporalmente el uso de Crear con IA. Podés continuar manualmente o intentar nuevamente.',
    };
  }

  try {
    const { data, error } = await supabaseClient.rpc('check_and_increment_ai_rate_limit', {
      p_max_requests: config.maxRequestsPerHour,
    });

    if (error || !data) {
      return {
        allowed: false,
        error: 'rate_limit_unavailable',
        message: 'No pudimos validar temporalmente el uso de Crear con IA. Podés continuar manualmente o intentar nuevamente.',
      };
    }

    if (data.allowed === false) {
      return {
        allowed: false,
        error: (data.error as any) || 'rate_limit_exceeded',
        message: data.message || 'Alcanzaste el límite de consultas de IA por hora. Podés continuar manualmente.',
      };
    }

    // Successfully verified and atomically incremented in Postgres
    return { allowed: true };
  } catch (_err) {
    // FAIL-CLOSED: if Postgres is unreachable or throws, reject request to protect LLM costs
    return {
      allowed: false,
      error: 'rate_limit_unavailable',
      message: 'No pudimos validar temporalmente el uso de Crear con IA. Podés continuar manualmente o intentar nuevamente.',
    };
  }
}

/**
 * Atomic in-memory bucket simulator used for verifying atomic concurrency semantics
 * identical to check_and_increment_ai_rate_limit in unit tests.
 */
export class AtomicRateLimitBucket {
  private count = 0;
  private mutex = Promise.resolve();

  constructor(public readonly maxRequests: number) {}

  async checkAndIncrement(): Promise<{ allowed: boolean; currentCount: number }> {
    return new Promise<{ allowed: boolean; currentCount: number }>((resolve) => {
      this.mutex = this.mutex.then(async () => {
        if (this.count < this.maxRequests) {
          this.count++;
          resolve({ allowed: true, currentCount: this.count });
        } else {
          resolve({ allowed: false, currentCount: this.count });
        }
      });
    });
  }

  getCount(): number {
    return this.count;
  }
}

/**
 * Records a successful AI interaction into server-side session and rate trackers.
 */
export function recordInteraction(
  userId: string,
  sessionId: string,
  scope: 'encounter' | 'off_topic' | 'unclear' | string
): void {
  const now = Date.now();

  // Update session tracker
  const current = sessions.get(sessionId) || {
    turns: 0,
    consecutiveOffTopic: 0,
    userId,
    lastActive: now,
  };

  current.turns += 1;
  current.lastActive = now;

  if (scope === 'off_topic') {
    current.consecutiveOffTopic += 1;
  } else if (scope === 'encounter') {
    current.consecutiveOffTopic = 0; // Reset on valid in-domain interaction
  }
  // scope === 'unclear' deliberately leaves current.consecutiveOffTopic unchanged

  sessions.set(sessionId, current);

  // Update user hourly sliding window
  const timestamps = userRequestTimestamps.get(userId) || [];
  timestamps.push(now);
  userRequestTimestamps.set(userId, timestamps);
}

/**
 * Test helper to reset in-memory maps.
 */
export function resetLimiterStateForTesting(): void {
  sessions.clear();
  userRequestTimestamps.clear();
  userPromptTimestamps.clear();
}
