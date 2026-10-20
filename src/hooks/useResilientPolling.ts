import { useEffect, useRef, useCallback } from 'react';

export interface UseResilientPollingOptions {
  /**
   * The polling worker callback. Can be asynchronous.
   */
  fn: () => Promise<void> | void;
  /**
   * Base polling interval in milliseconds while tab is active and visible.
   */
  intervalMs: number;
  /**
   * Relaxed polling interval in milliseconds while tab is VISIBLE but INACTIVE (idle).
   * Polling does NOT halt; it continues at this relaxed cadence to preserve updates.
   * Default: 30,000 ms.
   */
  idleIntervalMs?: number;
  /**
   * Controls whether polling is enabled (default: true).
   */
  enabled?: boolean;
  /**
   * Threshold of user inactivity in milliseconds after which polling relaxes to idleIntervalMs.
   * Default: 180,000 ms (3 minutes).
   */
  idleTimeoutMs?: number;
  /**
   * Whether to exponentially back off on consecutive execution errors (default: true).
   */
  backoffOnError?: boolean;
  /**
   * Maximum interval delay when backing off (default: 30,000 ms).
   */
  maxIntervalMs?: number;
  /**
   * Backoff factor per consecutive error (default: 1.5).
   */
  backoffFactor?: number;
  /**
   * Whether to run immediately upon mount / becoming enabled (default: false).
   */
  immediate?: boolean;
  /**
   * Whether to trigger an immediate refresh when window regains focus (default: true).
   */
  refreshOnFocus?: boolean;
  /**
   * Whether to trigger an immediate refresh when document becomes visible (default: true).
   */
  refreshOnVisible?: boolean;
}

export interface ResilientPollingController {
  refresh: () => Promise<void>;
  isFetching: () => boolean;
}

/**
 * Custom hook providing robust, resilient polling with:
 * 1. Automatic suspension of new periodic requests when document.visibilityState === 'hidden'
 * 2. Continuous relaxed polling when visible and inactive (NO complete halt; updates continue)
 * 3. Immediate refresh on visibility recovery and window focus without duplicate requests
 * 4. Mutual exclusion (in-flight deduplication to avoid overlapping requests)
 * 5. Stale response protection (monotonic request counter so late responses are ignored)
 * 6. Non-disruptive error backoff that never permanently dies on exceptions
 * 7. Clean unmount protection preventing memory leaks and late state mutations
 */
export function useResilientPolling({
  fn,
  intervalMs,
  idleIntervalMs = 30000,
  enabled = true,
  idleTimeoutMs = 180000,
  backoffOnError = true,
  maxIntervalMs = 30000,
  backoffFactor = 1.5,
  immediate = false,
  refreshOnFocus = true,
  refreshOnVisible = true,
}: UseResilientPollingOptions): ResilientPollingController {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFetchingRef = useRef(false);
  const consecutiveErrorsRef = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const isIdleRef = useRef(false);
  const isMountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const lastFetchCompletedAtRef = useRef(0);

  // Keep latest callback reference without retriggering effects
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const runPoll = useCallback(
    async (isManualOrEventTrigger = false) => {
      if (!isMountedRef.current || !enabled) return;

      // Never initiate new periodic queries if document is hidden.
      // Note: any query already in flight on the wire will settle safely.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        clearTimer();
        return;
      }

      // Check inactivity threshold
      const timeSinceActivity = Date.now() - lastActivityRef.current;
      const isCurrentlyIdle =
        !isManualOrEventTrigger && idleTimeoutMs > 0 && timeSinceActivity > idleTimeoutMs;
      isIdleRef.current = isCurrentlyIdle;

      // Avoid overlapping requests (mutual exclusion / in-flight deduplication)
      if (isFetchingRef.current) {
        return;
      }

      // If triggered by focus or visibility, avoid duplicate rapid requests if one just completed < 1s ago
      if (isManualOrEventTrigger && Date.now() - lastFetchCompletedAtRef.current < 1000) {
        return;
      }

      const currentRequestId = ++requestIdRef.current;
      isFetchingRef.current = true;

      try {
        await fnRef.current();

        // If a newer request was dispatched while this one was running, discard this response
        if (currentRequestId !== requestIdRef.current || !isMountedRef.current) {
          return;
        }

        consecutiveErrorsRef.current = 0;
        lastFetchCompletedAtRef.current = Date.now();
      } catch (err) {
        if (currentRequestId === requestIdRef.current) {
          consecutiveErrorsRef.current += 1;
        }
        if (import.meta.env.DEV) {
          console.warn('[useResilientPolling] Poll callback error:', err);
        }
      } finally {
        if (currentRequestId === requestIdRef.current) {
          isFetchingRef.current = false;
        }

        // Schedule next poll if still mounted, enabled, and visible
        if (isMountedRef.current && enabled) {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') {
            // Determine active vs relaxed idle delay (DO NOT SUSPEND COMPLETELY)
            const effectiveBaseDelay = isIdleRef.current
              ? Math.max(idleIntervalMs, intervalMs)
              : intervalMs;

            let nextDelay = effectiveBaseDelay;
            if (backoffOnError && consecutiveErrorsRef.current > 0) {
              const multiplier = Math.pow(backoffFactor, consecutiveErrorsRef.current);
              nextDelay = Math.min(Math.round(effectiveBaseDelay * multiplier), maxIntervalMs);
            }

            clearTimer();
            timerRef.current = setTimeout(() => {
              runPoll(false);
            }, nextDelay);
          }
        }
      }
    },
    [
      enabled,
      intervalMs,
      idleIntervalMs,
      idleTimeoutMs,
      backoffOnError,
      maxIntervalMs,
      backoffFactor,
      clearTimer,
    ],
  );

  // Main lifecycle effect
  useEffect(() => {
    isMountedRef.current = true;
    lastActivityRef.current = Date.now();
    isIdleRef.current = false;

    if (!enabled) {
      clearTimer();
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      clearTimer();
    } else {
      if (immediate) {
        runPoll(true);
      } else {
        clearTimer();
        timerRef.current = setTimeout(() => {
          runPoll(false);
        }, intervalMs);
      }
    }

    return () => {
      clearTimer();
    };
  }, [enabled, intervalMs, immediate, runPoll, clearTimer]);

  // Window visibility and focus handlers
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined' || !enabled) {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        // Tab hidden: freeze scheduling of new periodic queries immediately
        clearTimer();
      } else if (document.visibilityState === 'visible') {
        // Tab visible: wake up, reset idle and errors, and refresh immediately
        isIdleRef.current = false;
        lastActivityRef.current = Date.now();
        consecutiveErrorsRef.current = 0;
        if (refreshOnVisible) {
          clearTimer();
          runPoll(true);
        }
      }
    };

    const handleFocus = () => {
      if (document.visibilityState === 'visible' && refreshOnFocus) {
        isIdleRef.current = false;
        lastActivityRef.current = Date.now();
        clearTimer();
        runPoll(true);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [enabled, refreshOnVisible, refreshOnFocus, runPoll, clearTimer]);

  // User interaction tracking (idle detection & wake up)
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      !enabled ||
      idleTimeoutMs <= 0 ||
      !Number.isFinite(idleTimeoutMs)
    ) {
      return;
    }

    let lastRecorded = 0;
    const handleUserInteraction = () => {
      const now = Date.now();
      // Throttle interaction recording to once every 2 seconds
      if (now - lastRecorded < 2000) return;
      lastRecorded = now;
      lastActivityRef.current = now;

      // If polling was in relaxed idle mode, wake up to active cadence immediately
      if (isIdleRef.current) {
        isIdleRef.current = false;
        if (document.visibilityState === 'visible') {
          clearTimer();
          runPoll(true);
        }
      }
    };

    const eventNames = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;
    eventNames.forEach((evt) => {
      window.addEventListener(evt, handleUserInteraction, { passive: true });
    });

    return () => {
      eventNames.forEach((evt) => {
        window.removeEventListener(evt, handleUserInteraction);
      });
    };
  }, [enabled, idleTimeoutMs, runPoll, clearTimer]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      // Invalidate any in-flight request on unmount
      requestIdRef.current++;
      clearTimer();
    };
  }, [clearTimer]);

  const refresh = useCallback(async () => {
    clearTimer();
    await runPoll(true);
  }, [clearTimer, runPoll]);

  const isFetching = useCallback(() => isFetchingRef.current, []);

  return { refresh, isFetching };
}
