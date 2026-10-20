import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';
import './ErrorBoundary.css';

/**
 * Sanitizes error messages by scrubbing potential sensitive tokens,
 * passwords, JWTs, UUID hashes, and internal technical paths.
 */
export function sanitizeErrorMessage(message?: string): string {
  if (!message || typeof message !== 'string') {
    return 'Error de renderizado no especificado';
  }

  return message
    // Mask JWTs (three base64 segments separated by dots)
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED_JWT]')
    // Mask query params with tokens or keys
    .replace(/([?&](?:token|key|secret|password|auth|apiKey|invitation_token)=)[^&\s]+/gi, '$1[REDACTED]')
    // Mask Bearer tokens
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]+/gi, '$1[REDACTED]')
    // Mask Supabase secret keys
    .replace(/sb_secret_[a-zA-Z0-9_-]+/g, '[REDACTED_KEY]')
    // Mask invitation and join path tokens (e.g. /invite/uuid-123, /join/uuid-123)
    .replace(/(\/(?:invite|join|invitation)\/)[a-zA-Z0-9_-]{8,}/gi, '$1[REDACTED_TOKEN]')
    // Mask email addresses
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    // Truncate excessively long strings
    .slice(0, 200);
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((props: { error: Error | null; resetError: () => void }) => ReactNode);
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  onReset?: () => void;
  maxRetries?: number;
  retryWindowMs?: number;
}

export interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  retryTimestamps: number[];
  recoveryLoopDetected: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    retryTimestamps: [],
    recoveryLoopDetected: false,
  };

  private readonly maxRetries: number;
  private readonly retryWindowMs: number;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.maxRetries = props.maxRetries ?? 3;
    this.retryWindowMs = props.retryWindowMs ?? 15000; // 15 seconds
  }

  public static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    if (import.meta.env.DEV) {
      console.warn(
        '[ErrorBoundary] Render error intercepted:',
        sanitizeErrorMessage(error?.message),
      );
    }
  }

  public resetError = (): void => {
    const now = Date.now();
    // Keep only timestamps within retryWindowMs
    const recentRetries = this.state.retryTimestamps.filter(
      (ts) => now - ts < this.retryWindowMs,
    );

    if (recentRetries.length >= this.maxRetries) {
      // Loop detected: prevent further immediate re-renders to avoid browser lockup
      this.state = {
        ...this.state,
        recoveryLoopDetected: true,
      };
      this.setState({
        recoveryLoopDetected: true,
      });
      return;
    }

    const newTimestamps = [...recentRetries, now];

    if (this.props.onReset) {
      this.props.onReset();
    }

    this.state = {
      ...this.state,
      hasError: false,
      error: null,
      retryTimestamps: newTimestamps,
      recoveryLoopDetected: false,
    };
    this.setState({
      hasError: false,
      error: null,
      retryTimestamps: newTimestamps,
      recoveryLoopDetected: false,
    });
  };

  public handleGoHome = (): void => {
    // Direct browser navigation guarantees a clean reset of React contexts and router tree
    if (typeof window !== 'undefined') {
      window.location.href = '/';
    }
  };

  public handleReloadPage = (): void => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      // Custom fallback if provided
      if (this.props.fallback) {
        if (typeof this.props.fallback === 'function') {
          return this.props.fallback({
            error: this.state.error,
            resetError: this.resetError,
          });
        }
        return this.props.fallback;
      }

      const { recoveryLoopDetected } = this.state;

      return (
        <div className="error-boundary-container" role="alert">
          <div className="error-boundary-card">
            <div className="error-boundary-icon-wrapper" aria-hidden="true">
              <AlertTriangle size={36} />
            </div>

            <div className="error-boundary-header">
              <h1 className="error-boundary-title">
                Algo no salió como esperábamos
              </h1>
              <p className="error-boundary-subtitle">
                Something went wrong
              </p>
            </div>

            <div className="error-boundary-body">
              <p className="error-boundary-desc-es">
                Ocurrió un problema inesperado al cargar esta pantalla. Podés intentar nuevamente o volver al inicio.
              </p>
              <p className="error-boundary-desc-en">
                An unexpected issue occurred while rendering this section. You can try again or return home.
              </p>
            </div>

            {recoveryLoopDetected && (
              <div className="error-boundary-loop-notice" role="status">
                <strong>El problema persiste de forma continua.</strong>
                <br />
                Te sugerimos recargar la página o volver a la pantalla de inicio.
                <br />
                <span style={{ fontSize: '0.85em', opacity: 0.85 }}>
                  The issue persists repeatedly. Please reload or go home.
                </span>
              </div>
            )}

            <div className="error-boundary-actions">
              {recoveryLoopDetected ? (
                <button
                  type="button"
                  className="error-boundary-btn-retry"
                  onClick={this.handleReloadPage}
                >
                  <RotateCcw size={18} aria-hidden="true" />
                  Recargar página / Reload page
                </button>
              ) : (
                <button
                  type="button"
                  className="error-boundary-btn-retry"
                  onClick={this.resetError}
                >
                  <RotateCcw size={18} aria-hidden="true" />
                  Reintentar / Try again
                </button>
              )}

              <button
                type="button"
                className="error-boundary-btn-home"
                onClick={this.handleGoHome}
              >
                <Home size={18} aria-hidden="true" />
                Volver al inicio / Go to Home
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
