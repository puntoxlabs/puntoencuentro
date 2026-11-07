/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** VAPID PUBLIC key (base64url). La clave secreta jamás debe exponerse como VITE_*. */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
  /** Ambiente activo de la aplicación: production | staging | preview | development. */
  readonly VITE_APP_ENV?: string;
  /** Origen público canónico del entorno (ej. https://puntoencuentro.com.ar). */
  readonly VITE_APP_URL?: string;
  /** Nombre visible de la marca (opcional; por defecto PuntoEncuentro). */
  readonly VITE_APP_BRAND_NAME?: string;
  /** Nombre corto para PWA / iconos (opcional; por defecto igual a la marca). */
  readonly VITE_APP_SHORT_NAME?: string;
  /** Correo público de soporte/contacto (opcional; no sensible). */
  readonly VITE_PUBLIC_SUPPORT_EMAIL?: string;
  /** Cuenta pública para metadatos Twitter Card (opcional). */
  readonly VITE_APP_TWITTER_SITE?: string;
  /** Si es 'true', exige VITE_APP_URL explícita en builds publicados (staging/production). */
  readonly VITE_REQUIRE_EXPLICIT_APP_URL?: string;
}

declare const __APP_VERSION__: string;
declare const __APP_ENV__: string;
declare const __GIT_COMMIT__: string;
