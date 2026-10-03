/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** VAPID PUBLIC key (base64url). La clave privada NUNCA debe exponerse como VITE_*. */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}

declare const __APP_VERSION__: string;
declare const __APP_ENV__: string;
declare const __GIT_COMMIT__: string;
