import { useState, useRef, useEffect, useCallback } from 'react';

export interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}

export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
  item(index: number): SpeechRecognitionAlternativeLike;
}

export interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
  item(index: number): SpeechRecognitionResultLike;
}

export interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

export interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

export interface SpeechRecognitionInstanceLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onaudiostart: ((this: SpeechRecognitionInstanceLike, ev: Event) => any) | null;
  onaudioend: ((this: SpeechRecognitionInstanceLike, ev: Event) => any) | null;
  onstart: ((this: SpeechRecognitionInstanceLike, ev: Event) => any) | null;
  onend: ((this: SpeechRecognitionInstanceLike, ev: Event) => any) | null;
  onerror: ((this: SpeechRecognitionInstanceLike, ev: SpeechRecognitionErrorEventLike) => any) | null;
  onresult: ((this: SpeechRecognitionInstanceLike, ev: SpeechRecognitionEventLike) => any) | null;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionInstanceLike;

export type SpeechDictationStatus = 'idle' | 'listening' | 'error' | 'unsupported';

export type SpeechDictationErrorType =
  | 'not-allowed'
  | 'no-speech'
  | 'audio-capture'
  | 'network'
  | 'aborted'
  | 'unknown';

export interface SpeechDictationError {
  type: SpeechDictationErrorType;
  message: string;
}

export interface UseSpeechDictationOptions {
  lang?: string;
  onTranscriptChange?: (text: string) => void;
  onError?: (error: SpeechDictationError) => void;
}

export interface UseSpeechDictationReturn {
  status: SpeechDictationStatus;
  isListening: boolean;
  isSupported: boolean;
  lang: string;
  error: SpeechDictationError | null;
  interimTranscript: string;
  finalTranscript: string;
  startListening: (currentText?: string) => void;
  stopListening: () => void;
  cancelListening: () => void;
  clearError: () => void;
}

/**
 * Maps an application language code (e.g. from i18next or user setting) to a valid
 * BCP 47 language tag for Web Speech API recognition on desktop browsers.
 *
 * Mapeo extensible:
 * - Español: 'es', 'es-AR', 'es-ES' -> 'es-AR'
 * - Inglés:  'en', 'en-US', 'en-GB' -> 'en-US'
 * - Portugués: 'pt', 'pt-BR', 'pt-PT' -> 'pt-BR'
 * - Fallback seguro: 'es-AR'
 *
 * IMPORTANTE — Diferencia Mobile vs Desktop:
 * Este mapeo aplica exclusivamente al reconocimiento Web Speech API en Desktop.
 * En dispositivos móviles (Android / iOS / iPadOS), el dictado se realiza a través
 * del teclado nativo del sistema (Gboard / teclado de Apple), donde el idioma de
 * dictado depende enteramente de la configuración del teclado del usuario y
 * PuntoEncuentro jamás impone locale.
 */
export function getSpeechRecognitionLocale(appLanguage?: string): string {
  if (!appLanguage || typeof appLanguage !== 'string') {
    return 'es-AR';
  }

  const normalized = appLanguage.trim().toLowerCase();

  // Variantes de español
  if (normalized === 'es' || normalized.startsWith('es-') || normalized.startsWith('es_')) {
    return 'es-AR';
  }

  // Variantes de inglés
  if (normalized === 'en' || normalized.startsWith('en-') || normalized.startsWith('en_')) {
    return 'en-US';
  }

  // Variantes de portugués
  if (normalized === 'pt' || normalized.startsWith('pt-') || normalized.startsWith('pt_')) {
    return 'pt-BR';
  }

  // Fallback seguro a español rioplatense (locale principal del dominio actual)
  return 'es-AR';
}

/**
 * Returns the SpeechRecognition constructor if supported by the runtime browser.
 */
export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

/**
 * Checks if SpeechRecognition is available in the current browser.
 */
export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionConstructor() !== null;
}

/**
 * Privacidad / Criterio:
 * PuntoEncuentro no graba, almacena ni envía audio a sus propios servidores
 * ni a OpenAI/Mistral. El reconocimiento de voz es gestionado por el navegador
 * o sistema operativo según sus propias políticas.
 */
export const SPEECH_DICTATION_PRIVACY_POLICY =
  'PuntoEncuentro no graba, almacena ni envía audio a sus propios servidores ni a OpenAI/Mistral. El reconocimiento de voz es gestionado por el navegador o sistema operativo según sus propias políticas.';

/**
 * Detects whether the device operates primarily via touch/coarse pointer (smartphone/tablet),
 * where native keyboard dictation (e.g. Gboard, iOS keyboard mic) is already available.
 *
 * Criterio adaptativo:
 * - Mobile / touch principal cuando: `(pointer: coarse) && (hover: none)`.
 * - Breakpoint / layout mobile (< 768px o userAgent móvil) como señal complementaria,
 *   siempre que NO cuente con puntero fino + hover.
 * - `maxTouchPoints > 0` NO es suficiente por sí solo (evita clasificar erróneamente notebooks o 2-en-1 táctiles).
 * - Equipos con touch + pointer fine/hover (laptops táctiles, 2-en-1) se tratan como desktop/híbrido (retorna false),
 *   permitiendo el micrófono web en la UI si SpeechRecognition existe.
 */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;

  const match = (query: string): boolean => {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };

  const isCoarse = match('(pointer: coarse)');
  const isNoHover = match('(hover: none)');
  const isFine = match('(pointer: fine)');
  const isHover = match('(hover: hover)');

  // Caso C / Híbrido: Laptop táctil o 2-en-1 con puntero fino y hover.
  // Aunque tenga pantalla táctil (maxTouchPoints > 0), se trata como desktop/híbrido.
  if (isFine && isHover) {
    return false;
  }

  // Caso A y D: Smartphone o Tablet táctil primaria (coarse pointer y sin hover).
  if (isCoarse && isNoHover) {
    return true;
  }

  // Señal complementaria: Breakpoint móvil (< 768px) o User-Agent móvil,
  // únicamente si NO tiene puntero fino.
  const isMobileBreakpoint =
    match('(max-width: 767px)') ||
    (typeof window.innerWidth === 'number' && window.innerWidth > 0 && window.innerWidth < 768);
  const isMobileUA =
    typeof navigator !== 'undefined' &&
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

  if ((isMobileBreakpoint || isMobileUA) && !isFine) {
    return true;
  }

  // Por defecto: desktop / híbrido (retorna false)
  return false;
}

/**
 * Maps Web Speech API error codes to user-friendly Spanish messages.
 * Does NOT emit technical internal errors or trigger AI infrastructure banners.
 */
export function getFriendlyDictationErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case 'not-allowed':
    case 'permission-denied':
      return 'No pudimos acceder al micrófono. Podés habilitarlo en el navegador o seguir escribiendo.';
    case 'no-speech':
      return 'No escuché nada. Podés intentarlo nuevamente.';
    case 'audio-capture':
      return 'No se detectó ningún micrófono. Podés seguir escribiendo.';
    case 'network':
      return 'Error de conexión al reconocer voz. Podés seguir escribiendo normalmente.';
    case 'aborted':
      return 'El dictado fue cancelado.';
    default:
      return 'No pudimos iniciar el dictado. Podés seguir escribiendo normalmente.';
  }
}

/**
 * Concatenates session transcript with existing text without awkward spacing or duplication.
 */
export function combineTranscriptWithBase(baseText: string, sessionTranscript: string): string {
  const base = baseText.trim();
  const session = sessionTranscript.trim();
  if (!base) return session;
  if (!session) return base;
  return `${base} ${session}`;
}

export function useSpeechDictation(options: UseSpeechDictationOptions = {}): UseSpeechDictationReturn {
  const { lang, onTranscriptChange, onError } = options;
  const effectiveLang = lang || 'es-AR';

  const [status, setStatus] = useState<SpeechDictationStatus>(() =>
    isSpeechRecognitionSupported() ? 'idle' : 'unsupported'
  );
  const [error, setError] = useState<SpeechDictationError | null>(null);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');

  const recognitionRef = useRef<SpeechRecognitionInstanceLike | null>(null);
  const baseTextRef = useRef<string>('');
  const accumulatedFinalRef = useRef<string>('');
  const isStoppingRef = useRef<boolean>(false);

  // Keep callback refs fresh
  const onTranscriptChangeRef = useRef(onTranscriptChange);
  onTranscriptChangeRef.current = onTranscriptChange;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const isSupported = isSpeechRecognitionSupported();

  const stopListening = useCallback(() => {
    isStoppingRef.current = true;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Safe ignore if already stopped
      }
    }
    setStatus('idle');
    setInterimTranscript('');
  }, []);

  const cancelListening = useCallback(() => {
    isStoppingRef.current = true;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Safe ignore
      }
    }
    setStatus('idle');
    setInterimTranscript('');
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    if (status === 'error') {
      setStatus('idle');
    }
  }, [status]);

  const startListening = useCallback(
    (currentText: string = '') => {
      const SpeechRecognitionClass = getSpeechRecognitionConstructor();
      if (!SpeechRecognitionClass) {
        setStatus('unsupported');
        return;
      }

      // Stop previous instance if any
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }

      isStoppingRef.current = false;
      baseTextRef.current = currentText;
      accumulatedFinalRef.current = '';
      setInterimTranscript('');
      setFinalTranscript('');
      setError(null);

      try {
        const recognition = new SpeechRecognitionClass();
        recognition.lang = effectiveLang;
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        recognition.onstart = () => {
          if (!isStoppingRef.current) {
            setStatus('listening');
            setError(null);
          }
        };

        recognition.onresult = (event: SpeechRecognitionEventLike) => {
          let currentInterim = '';
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            const result = event.results[i];
            const transcript = result[0]?.transcript || '';
            if (result.isFinal) {
              accumulatedFinalRef.current = combineTranscriptWithBase(
                accumulatedFinalRef.current,
                transcript
              );
            } else {
              currentInterim += (currentInterim ? ' ' : '') + transcript.trim();
            }
          }

          const sessionText = combineTranscriptWithBase(
            accumulatedFinalRef.current,
            currentInterim
          );
          const fullText = combineTranscriptWithBase(baseTextRef.current, sessionText);

          setInterimTranscript(currentInterim);
          setFinalTranscript(accumulatedFinalRef.current);
          onTranscriptChangeRef.current?.(fullText);
        };

        recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
          if (event.error === 'aborted') {
            return;
          }

          const errType: SpeechDictationErrorType =
            event.error === 'not-allowed' || event.error === 'permission-denied'
              ? 'not-allowed'
              : event.error === 'no-speech'
              ? 'no-speech'
              : event.error === 'audio-capture'
              ? 'audio-capture'
              : event.error === 'network'
              ? 'network'
              : 'unknown';

          const err: SpeechDictationError = {
            type: errType,
            message: getFriendlyDictationErrorMessage(event.error),
          };

          setError(err);
          setStatus('error');
          onErrorRef.current?.(err);
        };

        recognition.onend = () => {
          setStatus('idle');
          setInterimTranscript('');
          // CRITICAL: NEVER AUTO-SEND. The text remains in textarea for user review.
        };

        recognitionRef.current = recognition;
        recognition.start();
      } catch (err) {
        const errObj: SpeechDictationError = {
          type: 'unknown',
          message: getFriendlyDictationErrorMessage('unknown'),
        };
        setError(errObj);
        setStatus('error');
        onErrorRef.current?.(errObj);
      }
    },
    [effectiveLang]
  );

  // Auto-cleanup on unmount and visibilitychange
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && recognitionRef.current) {
        stopListening();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {}
      }
    };
  }, [stopListening]);

  return {
    status,
    isListening: status === 'listening',
    isSupported,
    lang: effectiveLang,
    error,
    interimTranscript,
    finalTranscript,
    startListening,
    stopListening,
    cancelListening,
    clearError,
  };
}
