import { sanitizeErrorMessage } from '@/components/ErrorBoundary';

/**
 * Global handler for unhandled asynchronous rejections and uncaught global errors.
 *
 * React Error Boundaries exclusively catch errors that occur during:
 * 1. Component rendering
 * 2. Component lifecycle methods
 * 3. Class component constructors
 *
 * They do NOT catch:
 * 1. Unhandled Promise rejections (e.g. background fetch, supabase calls)
 * 2. Asynchronous timers (setTimeout / setInterval callbacks)
 * 3. Event handler callbacks (e.g. onClick, onSubmit)
 *
 * This handler registers browser-level listeners to sanitize and capture uncaught
 * async failures without leaking private tokens or crashing unpredictably.
 */

let isInitialized = false;

export function initGlobalErrorHandlers(): void {
  if (isInitialized || typeof window === 'undefined') {
    return;
  }
  isInitialized = true;

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const rawReason = event.reason;
    const message =
      typeof rawReason === 'string'
        ? rawReason
        : rawReason?.message || 'Unhandled asynchronous rejection';

    const sanitized = sanitizeErrorMessage(message);

    if (import.meta.env.DEV) {
      console.warn('[GlobalAsyncError] Unhandled rejection intercepted:', sanitized);
    }

    // Do NOT send to third-party paid services or log private session tokens.
  });

  window.addEventListener('error', (event: ErrorEvent) => {
    const message = event.message || 'Uncaught error';
    const sanitized = sanitizeErrorMessage(message);

    if (import.meta.env.DEV) {
      console.warn('[GlobalAsyncError] Uncaught window error intercepted:', sanitized);
    }
  });
}
