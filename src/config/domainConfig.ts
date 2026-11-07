/**
 * Configuración centralizada y reutilizable de Dominio, Orígenes y Marca.
 *
 * Principios de Arquitectura y Seguridad:
 * 1. El dominio físico NO forma parte de la identidad de negocio ni de los UUID/tokens persistentes.
 * 2. Separación estricta entre configuración activa (dominio canónico vigente) e histórica (dominios legados).
 * 3. Separación estricta entre variables públicas del cliente (VITE_*) y variables de servidor (process.env).
 *    Jamás almacenar ni leer secretos en este módulo.
 * 4. Rechazo fail-closed de esquemas inseguros, credenciales embebidas, rutas en orígenes y hosts arbitrarios.
 * 5. Aislamiento estricto entre Producción, Staging, Preview y Desarrollo local.
 * 6. Estrategia N→1 sin cadenas para dominios históricos (preparada e inactiva hasta autorización).
 */

export type AppEnvironment = 'production' | 'staging' | 'preview' | 'development';

export type DomainErrorCode =
  | 'missing_canonical_origin'
  | 'invalid_origin_url'
  | 'insecure_origin_scheme'
  | 'origin_contains_credentials'
  | 'origin_contains_path_or_query'
  | 'cross_environment_origin_mismatch'
  | 'unauthorized_canonical_host';

export class DomainConfigError extends Error {
  public readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainConfigError';
    this.code = code;
  }
}

// ============================================================================
// 1. CONSTANTES BASE DEL DOMINIO Y MARCA ACTUALES (VIGENTES HASTA CORTE)
// ============================================================================

/** Dominio canónico vigente de Producción (NO modificar hasta autorizar corte de migración). */
export const DEFAULT_PRODUCTION_ORIGIN = 'https://puntoencuentro.com.ar';

/** Dominio canónico vigente de Staging. */
export const DEFAULT_STAGING_ORIGIN = 'https://staging.puntoencuentro.com.ar';

/** Origen local predeterminado para desarrollo. */
export const DEFAULT_DEVELOPMENT_ORIGIN = 'http://localhost:5173';

/**
 * Orígenes históricos propios retirados.
 * Actualmente vacío porque puntoencuentro.com.ar continúa siendo el origen activo.
 * Al migrar a Dominio B: mover 'https://puntoencuentro.com.ar' aquí.
 * Al migrar a Dominio C: mantener ['https://puntoencuentro.com.ar', 'https://dominio-b.tld']
 * para garantizar redirección directa N→1 sin cadenas (A→C y B→C).
 */
export const DEFAULT_LEGACY_ORIGINS: readonly string[] = Object.freeze([]);

/**
 * Namespace persistente para UID de eventos iCalendar (RFC 5545).
 * Se mantiene estable e independiente del dominio web activo para que actualizaciones
 * de archivos .ics descargados no dupliquen eventos en calendarios de los usuarios.
 */
export const PERSISTENT_CALENDAR_UID_NAMESPACE = 'puntoencuentro.com.ar';

/** Patrón autorizado para despliegues efímeros de preview en Vercel (solo cuando env === 'preview'). */
const VERCEL_PREVIEW_HOST_REGEX = /^puntoencuentro(?:-git-[a-z0-9-]+)?\.vercel\.app$/i;

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const UUID_V4_OR_RFC_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_INVITE_TOKEN_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-zA-Z_-]{8,64}$/;

// ============================================================================
// 2. MODELOS DE CONFIGURACIÓN
// ============================================================================

export interface BrandConfig {
  brandName: string;
  shortName: string;
  defaultTitle: string;
  socialTitle: string;
  defaultDescription: string;
  socialDescription: string;
  socialImageAlt: string;
  openEncounterFallbackTitle: string;
  openEncounterFallbackDescription: string;
  openEncounterCtaLabel: string;
  socialImagePath: string;
  twitterSiteHandle: string;
  publicSupportEmail: string;
  publicSupportMailto: string;
  calendarUidNamespace: string;
}

export interface DomainConfig {
  environment: AppEnvironment;
  canonicalOrigin: string;
  canonicalHost: string;
  productionOrigin: string;
  stagingOrigin: string;
  legacyOrigins: readonly string[];
  legacyHosts: ReadonlySet<string>;
  trustedActiveHosts: ReadonlySet<string>;
  legacyRedirectEnabled: boolean;
  brand: BrandConfig;
}

export interface EnvSource {
  VITE_APP_ENV?: string;
  VITE_APP_URL?: string;
  VITE_APP_BRAND_NAME?: string;
  VITE_APP_SHORT_NAME?: string;
  VITE_PUBLIC_SUPPORT_EMAIL?: string;
  VITE_APP_TWITTER_SITE?: string;
  VITE_REQUIRE_EXPLICIT_APP_URL?: string;
  PUBLIC_APP_ORIGIN?: string;
  PUBLIC_STAGING_ORIGIN?: string;
  LEGACY_APP_ORIGINS?: string;
  ENABLE_LEGACY_DOMAIN_REDIRECT?: string;
  APP_BRAND_NAME?: string;
  APP_SHORT_NAME?: string;
  PUBLIC_SUPPORT_EMAIL?: string;
  APP_TWITTER_SITE?: string;
  VERCEL_ENV?: string;
  VERCEL_GIT_COMMIT_REF?: string;
  NODE_ENV?: string;
}

// ============================================================================
// 3. LECTURA SEGURA DE ENTORNO (VITE CLIENTE + NODE SERVIDOR)
// ============================================================================

declare const __APP_ENV__: string | undefined;

function readDefaultEnvSource(): EnvSource {
  const procEnv: Record<string, string | undefined> | undefined =
    typeof globalThis !== 'undefined'
      ? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      : undefined;

  const viteMetaEnv =
    typeof import.meta !== 'undefined'
      ? (import.meta as { env?: Record<string, string | undefined> }).env
      : undefined;

  const viteAppEnv = viteMetaEnv?.VITE_APP_ENV;
  const viteAppUrl = viteMetaEnv?.VITE_APP_URL;
  const viteBrandName = viteMetaEnv?.VITE_APP_BRAND_NAME;
  const viteShortName = viteMetaEnv?.VITE_APP_SHORT_NAME;
  const viteSupportEmail = viteMetaEnv?.VITE_PUBLIC_SUPPORT_EMAIL;
  const viteTwitterSite = viteMetaEnv?.VITE_APP_TWITTER_SITE;
  const viteRequireExplicit = viteMetaEnv?.VITE_REQUIRE_EXPLICIT_APP_URL;

  const injectedBuildEnv =
    typeof __APP_ENV__ !== 'undefined' && typeof __APP_ENV__ === 'string'
      ? __APP_ENV__
      : undefined;

  return {
    VITE_APP_ENV: procEnv?.VITE_APP_ENV ?? viteAppEnv ?? injectedBuildEnv,
    VITE_APP_URL: procEnv?.VITE_APP_URL ?? viteAppUrl,
    VITE_APP_BRAND_NAME: procEnv?.VITE_APP_BRAND_NAME ?? viteBrandName,
    VITE_APP_SHORT_NAME: procEnv?.VITE_APP_SHORT_NAME ?? viteShortName,
    VITE_PUBLIC_SUPPORT_EMAIL: procEnv?.VITE_PUBLIC_SUPPORT_EMAIL ?? viteSupportEmail,
    VITE_APP_TWITTER_SITE: procEnv?.VITE_APP_TWITTER_SITE ?? viteTwitterSite,
    VITE_REQUIRE_EXPLICIT_APP_URL:
      procEnv?.VITE_REQUIRE_EXPLICIT_APP_URL ?? viteRequireExplicit,
    PUBLIC_APP_ORIGIN: procEnv?.PUBLIC_APP_ORIGIN,
    PUBLIC_STAGING_ORIGIN: procEnv?.PUBLIC_STAGING_ORIGIN,
    LEGACY_APP_ORIGINS: procEnv?.LEGACY_APP_ORIGINS,
    ENABLE_LEGACY_DOMAIN_REDIRECT: procEnv?.ENABLE_LEGACY_DOMAIN_REDIRECT,
    APP_BRAND_NAME: procEnv?.APP_BRAND_NAME,
    APP_SHORT_NAME: procEnv?.APP_SHORT_NAME,
    PUBLIC_SUPPORT_EMAIL: procEnv?.PUBLIC_SUPPORT_EMAIL,
    APP_TWITTER_SITE: procEnv?.APP_TWITTER_SITE,
    VERCEL_ENV: procEnv?.VERCEL_ENV,
    VERCEL_GIT_COMMIT_REF: procEnv?.VERCEL_GIT_COMMIT_REF,
    NODE_ENV: procEnv?.NODE_ENV,
  };
}

export function resolveAppEnvironment(envInput?: EnvSource): AppEnvironment {
  const env = envInput ?? readDefaultEnvSource();
  const raw = env.VITE_APP_ENV?.trim().toLowerCase();

  if (raw === 'production' || raw === 'staging' || raw === 'preview' || raw === 'development') {
    return raw;
  }

  const branch = env.VERCEL_GIT_COMMIT_REF?.trim();
  if (branch === 'staging') {
    return 'staging';
  }
  if (branch === 'main' || env.VERCEL_ENV === 'production') {
    return 'production';
  }
  if (env.VERCEL_ENV === 'preview') {
    return 'preview';
  }

  return 'development';
}

export function isNonProductionEnvironment(envInput?: EnvSource): boolean {
  return resolveAppEnvironment(envInput) !== 'production';
}

// ============================================================================
// 4. NORMALIZACIÓN Y VALIDACIÓN ESTRICTA DE ORÍGENES
// ============================================================================

export interface NormalizeOriginOptions {
  requireHttps?: boolean;
}

/**
 * Valida y normaliza un origen URL canónico (scheme + host + optional port, sin barra final).
 * Rechaza esquemas inseguros (javascript:, data:, ftp:, http: cuando requireHttps=true),
 * credenciales embebidas, rutas no raíz, query strings, fragmentos y caracteres de control.
 */
export function normalizeAppOrigin(
  rawOrigin: unknown,
  options: NormalizeOriginOptions = {}
): string {
  if (typeof rawOrigin !== 'string' || !rawOrigin.trim()) {
    throw new DomainConfigError('missing_canonical_origin', 'El origen configurado está vacío.');
  }

  const trimmed = rawOrigin.trim();

  if (/[\s\r\n\t\0\\]/.test(trimmed)) {
    throw new DomainConfigError(
      'invalid_origin_url',
      'El origen contiene caracteres de control o barras invertidas no permitidas.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new DomainConfigError('invalid_origin_url', `Formato de URL inválido: ${trimmed}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new DomainConfigError(
      'insecure_origin_scheme',
      `Esquema no permitido (${parsed.protocol}). Solo se admite https (o http en desarrollo local).`
    );
  }

  if (parsed.username || parsed.password) {
    throw new DomainConfigError(
      'origin_contains_credentials',
      'El origen no puede contener credenciales embebidas.'
    );
  }

  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new DomainConfigError(
      'origin_contains_path_or_query',
      'El origen canónico no debe incluir subrutas, query strings ni fragmentos.'
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')) {
    throw new DomainConfigError('invalid_origin_url', 'Hostname inválido en el origen.');
  }

  const isLocalhost = LOCALHOST_HOSTS.has(hostname);
  const mustUseHttps = options.requireHttps ?? !isLocalhost;

  if (mustUseHttps && parsed.protocol !== 'https:') {
    throw new DomainConfigError(
      'insecure_origin_scheme',
      `Se requiere esquema https:// para el origen público (${hostname}).`
    );
  }

  if (!mustUseHttps && parsed.protocol === 'http:' && !isLocalhost) {
    throw new DomainConfigError(
      'insecure_origin_scheme',
      `El esquema http:// solo se permite en localhost, no en ${hostname}.`
    );
  }

  return parsed.origin;
}

function isValidPublicDomainHostname(hostname: string): boolean {
  if (LOCALHOST_HOSTS.has(hostname)) return false;
  // Rechazar literales IPv4 o IPv6 como dominio canónico público
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
    return false;
  }
  const labels = hostname.split('.');
  if (labels.length < 2) return false;
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
}

/**
 * Verifica que un origen ya normalizado sea coherente y seguro para el ambiente activo,
 * impidiendo mezclar Staging con Producción o usar localhost en builds publicados.
 */
export function validateOriginForEnvironment(
  normalizedOrigin: string,
  environment: AppEnvironment,
  options: {
    productionOrigin?: string;
    stagingOrigin?: string;
  } = {}
): void {
  const parsed = new URL(normalizedOrigin);
  const hostname = parsed.hostname.toLowerCase();
  const isLocal = LOCALHOST_HOSTS.has(hostname);

  const knownProdHost = new URL(options.productionOrigin || DEFAULT_PRODUCTION_ORIGIN).hostname.toLowerCase();
  const knownStagingHost = new URL(options.stagingOrigin || DEFAULT_STAGING_ORIGIN).hostname.toLowerCase();

  if (environment === 'production') {
    if (parsed.protocol !== 'https:') {
      throw new DomainConfigError(
        'insecure_origin_scheme',
        'Producción exige estrictamente esquema https://.'
      );
    }
    if (
      isLocal ||
      hostname === knownStagingHost ||
      hostname.startsWith('staging.') ||
      hostname.includes('.staging.') ||
      hostname.endsWith('.vercel.app')
    ) {
      throw new DomainConfigError(
        'cross_environment_origin_mismatch',
        `El host "${hostname}" pertenece a desarrollo, staging o preview y no puede usarse como origen canónico de Producción.`
      );
    }
    if (!isValidPublicDomainHostname(hostname)) {
      throw new DomainConfigError(
        'unauthorized_canonical_host',
        `El host "${hostname}" no es un dominio público válido para Producción.`
      );
    }
    return;
  }

  if (environment === 'staging') {
    if (parsed.protocol !== 'https:') {
      throw new DomainConfigError(
        'insecure_origin_scheme',
        'Staging exige estrictamente esquema https://.'
      );
    }
    if (isLocal || hostname === knownProdHost) {
      throw new DomainConfigError(
        'cross_environment_origin_mismatch',
        `El host "${hostname}" no es válido para Staging (aislamiento estricto Staging/Producción).`
      );
    }
    if (!isValidPublicDomainHostname(hostname)) {
      throw new DomainConfigError(
        'unauthorized_canonical_host',
        `El host "${hostname}" no es un dominio válido para Staging.`
      );
    }
    return;
  }

  if (environment === 'preview') {
    if (parsed.protocol !== 'https:') {
      throw new DomainConfigError(
        'insecure_origin_scheme',
        'Preview exige estrictamente esquema https://.'
      );
    }
    if (isLocal || hostname === knownProdHost) {
      throw new DomainConfigError(
        'cross_environment_origin_mismatch',
        `El host "${hostname}" no puede usarse como origen de Preview.`
      );
    }
    if (!isValidPublicDomainHostname(hostname)) {
      throw new DomainConfigError(
        'unauthorized_canonical_host',
        `El host "${hostname}" no es válido para Preview.`
      );
    }
  }
}

export function parseLegacyOrigins(
  rawLegacyOrigins: string | undefined,
  activeOriginsToExclude: readonly string[] = []
): string[] {
  const excluded = new Set(activeOriginsToExclude.map((o) => o.toLowerCase()));
  const candidates = rawLegacyOrigins
    ? rawLegacyOrigins
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [...DEFAULT_LEGACY_ORIGINS];

  const valid: string[] = [];
  const seen = new Set<string>();

  for (const item of candidates) {
    const normalized = normalizeAppOrigin(item, { requireHttps: true });
    const parsed = new URL(normalized);
    if (!isValidPublicDomainHostname(parsed.hostname.toLowerCase())) {
      throw new DomainConfigError(
        'unauthorized_canonical_host',
        `Dominio histórico inválido: ${item}`
      );
    }
    const lower = normalized.toLowerCase();
    // Prevención de bucles: el origen canónico vigente jamás puede figurar como legado
    if (!excluded.has(lower) && !seen.has(lower)) {
      seen.add(lower);
      valid.push(normalized);
    }
  }

  return valid;
}

// ============================================================================
// 5. RESOLUCIÓN DE MARCA Y DOMINIO CENTRALIZADO
// ============================================================================

export function resolveBrandConfig(envInput?: EnvSource): BrandConfig {
  const env = envInput ?? readDefaultEnvSource();

  const brandName = (env.APP_BRAND_NAME || env.VITE_APP_BRAND_NAME || 'PuntoEncuentro').trim() || 'PuntoEncuentro';
  const shortName = (env.APP_SHORT_NAME || env.VITE_APP_SHORT_NAME || brandName).trim() || brandName;
  const supportEmailRaw = (
    env.PUBLIC_SUPPORT_EMAIL ||
    env.VITE_PUBLIC_SUPPORT_EMAIL ||
    'soporte@puntoencuentro.com.ar'
  ).trim();
  const publicSupportEmail = supportEmailRaw.replace(/^mailto:/i, '');
  const twitterSiteHandle = (
    env.APP_TWITTER_SITE ||
    env.VITE_APP_TWITTER_SITE ||
    '@puntoencuentro'
  ).trim();

  return {
    brandName,
    shortName,
    defaultTitle: brandName,
    socialTitle: `${brandName} — Organizá encuentros y compartí momentos`,
    defaultDescription: `${brandName} — Organizá encuentros y compartí momentos con amigos de forma simple, privada y sin vueltas.`,
    socialDescription:
      'Coordiná fechas, invitá a tu grupo y descubrí planes de forma privada y sin vueltas.',
    socialImageAlt: `${brandName} — Organizá encuentros con amigos`,
    openEncounterFallbackTitle: `Encuentro en ${brandName}`,
    openEncounterFallbackDescription:
      'Conocé propuestas y sumate a encuentros de forma simple y cuidada.',
    openEncounterCtaLabel: `Ver encuentro en ${brandName}`,
    socialImagePath: '/images/og-share.png',
    twitterSiteHandle,
    publicSupportEmail,
    publicSupportMailto: `mailto:${publicSupportEmail}`,
    calendarUidNamespace: PERSISTENT_CALENDAR_UID_NAMESPACE,
  };
}

export interface ResolveDomainConfigOptions {
  env?: EnvSource;
  /** En modo estricto (builds publicados / validaciones), cualquier variable inválida lanza DomainConfigError. */
  strict?: boolean;
  /** Exige que PUBLIC_APP_ORIGIN o VITE_APP_URL esté explícitamente definida en producción/staging. */
  requireExplicitOrigin?: boolean;
  /** Origen del navegador actual (solo considerado en development o preview autorizado). */
  runtimeBrowserOrigin?: string;
}

export function resolveDomainConfig(options: ResolveDomainConfigOptions = {}): DomainConfig {
  const env = options.env ?? readDefaultEnvSource();
  const environment = resolveAppEnvironment(env);
  const strict = options.strict ?? false;
  const requireExplicit =
    options.requireExplicitOrigin ??
    env.VITE_REQUIRE_EXPLICIT_APP_URL?.trim().toLowerCase() === 'true';

  const configuredRawOrigin = (env.PUBLIC_APP_ORIGIN || env.VITE_APP_URL || '').trim();
  const configuredStagingRaw = (env.PUBLIC_STAGING_ORIGIN || '').trim();

  const stagingOrigin = configuredStagingRaw
    ? normalizeAppOrigin(configuredStagingRaw, { requireHttps: true })
    : DEFAULT_STAGING_ORIGIN;

  const defaultOriginForEnv = (): string => {
    if (environment === 'production') return DEFAULT_PRODUCTION_ORIGIN;
    if (environment === 'staging') return stagingOrigin;
    if (environment === 'preview') {
      const browserOrigin = options.runtimeBrowserOrigin;
      if (browserOrigin) {
        try {
          const norm = normalizeAppOrigin(browserOrigin, { requireHttps: true });
          const host = new URL(norm).hostname.toLowerCase();
          if (VERCEL_PREVIEW_HOST_REGEX.test(host) || host === new URL(stagingOrigin).hostname.toLowerCase()) {
            return norm;
          }
        } catch {
          // Ignorar origen no confiable
        }
      }
      return stagingOrigin;
    }
    // development
    const browserOrigin = options.runtimeBrowserOrigin;
    if (browserOrigin) {
      try {
        const norm = normalizeAppOrigin(browserOrigin, { requireHttps: false });
        const host = new URL(norm).hostname.toLowerCase();
        if (LOCALHOST_HOSTS.has(host)) {
          return norm;
        }
      } catch {
        // Ignorar origen inválido
      }
    }
    return DEFAULT_DEVELOPMENT_ORIGIN;
  };

  let canonicalOrigin: string;

  if (!configuredRawOrigin) {
    if (requireExplicit && (environment === 'production' || environment === 'staging')) {
      throw new DomainConfigError(
        'missing_canonical_origin',
        `Falta configurar explícitamente VITE_APP_URL / PUBLIC_APP_ORIGIN para el entorno publicado "${environment}".`
      );
    }
    canonicalOrigin = defaultOriginForEnv();
  } else {
    try {
      const normalized = normalizeAppOrigin(configuredRawOrigin, {
        requireHttps: environment !== 'development',
      });
      // Cuando se configura un nuevo dominio productivo explícito en VITE_APP_URL / PUBLIC_APP_ORIGIN,
      // ese pasa a ser el productionOrigin de referencia.
      const effectiveProdOrigin =
        environment === 'production' ? normalized : DEFAULT_PRODUCTION_ORIGIN;
      validateOriginForEnvironment(normalized, environment, {
        productionOrigin: effectiveProdOrigin,
        stagingOrigin,
      });
      canonicalOrigin = normalized;
    } catch (err) {
      if (strict || requireExplicit) {
        throw err;
      }
      // Fail-closed seguro en runtime: rechaza el valor inválido/inseguro y cae al canónico registrado del entorno
      canonicalOrigin = defaultOriginForEnv();
    }
  }

  const productionOrigin =
    environment === 'production' ? canonicalOrigin : DEFAULT_PRODUCTION_ORIGIN;

  let legacyOrigins: string[] = [];
  try {
    legacyOrigins = parseLegacyOrigins(env.LEGACY_APP_ORIGINS, [
      canonicalOrigin,
      productionOrigin,
      stagingOrigin,
    ]);
  } catch (err) {
    if (strict) throw err;
    legacyOrigins = [];
  }

  const canonicalHost = new URL(canonicalOrigin).host.toLowerCase();
  const prodHost = new URL(productionOrigin).host.toLowerCase();
  const stgHost = new URL(stagingOrigin).host.toLowerCase();

  const legacyHosts = new Set(legacyOrigins.map((o) => new URL(o).host.toLowerCase()));
  const trustedActiveHosts = new Set<string>([canonicalHost, prodHost, stgHost]);

  const legacyRedirectEnabled =
    env.ENABLE_LEGACY_DOMAIN_REDIRECT?.trim().toLowerCase() === 'true';

  return {
    environment,
    canonicalOrigin,
    canonicalHost,
    productionOrigin,
    stagingOrigin,
    legacyOrigins: Object.freeze(legacyOrigins),
    legacyHosts,
    trustedActiveHosts,
    legacyRedirectEnabled,
    brand: resolveBrandConfig(env),
  };
}

/**
 * Validación de compuerta para builds publicados (ejecutada desde vite.config.ts y tests).
 * Falla cerrado ante cualquier configuración inválida o cruce entre Staging y Producción.
 */
export function validateBuildDomainConfig(
  envInput?: EnvSource,
  options: { requireExplicitOrigin?: boolean } = {}
): DomainConfig {
  return resolveDomainConfig({
    env: envInput,
    strict: true,
    requireExplicitOrigin: options.requireExplicitOrigin,
  });
}

/**
 * Obtiene el origen canónico público en el cliente o en utilidades compartidas.
 * NOTA CRÍTICA: En producción/staging jamás usa un alias antiguo de window.location.origin
 * para construir enlaces compartibles; siempre proyecta el origen canónico configurado.
 */
export function getCanonicalAppOrigin(envInput?: EnvSource): string {
  const globalWin =
    typeof globalThis !== 'undefined'
      ? (globalThis as { window?: { location?: { origin?: string } } }).window
      : undefined;
  const browserOrigin = globalWin?.location?.origin;

  return resolveDomainConfig({
    env: envInput,
    strict: false,
    runtimeBrowserOrigin: browserOrigin,
  }).canonicalOrigin;
}

export function getBrandConfig(envInput?: EnvSource): BrandConfig {
  return resolveBrandConfig(envInput);
}

// ============================================================================
// 6. GENERACIÓN CENTRALIZADA DE URLS PÚBLICAS Y VALIDACIÓN SERVER-SIDE DE HOST
// ============================================================================

/**
 * Construye una URL pública absoluta a partir del origen canónico y una ruta interna segura.
 * Normaliza barras finales/iniciales y rechaza URLs externas, esquemas inyectados o traversal.
 */
export function buildPublicAppUrl(
  relativePath: string,
  options: { baseOrigin?: string; env?: EnvSource } = {}
): string {
  if (typeof relativePath !== 'string') {
    throw new Error('Ruta inválida para construir URL pública.');
  }

  const trimmed = relativePath.trim();
  if (
    trimmed.includes('://') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    /[\s\r\n\t\0]/.test(trimmed)
  ) {
    throw new Error(`Ruta insegura rechazada en buildPublicAppUrl: ${relativePath}`);
  }

  const normalizedPath = trimmed === '' ? '/' : trimmed.startsWith('/') ? trimmed : `/${trimmed}`;

  // Rechazar dobles barras en el pathname o traversal '..'
  const [pathAndQuery] = normalizedPath.split('#');
  const [pathnameOnly] = pathAndQuery.split('?');
  if (pathnameOnly.includes('//') || pathnameOnly.split('/').includes('..')) {
    throw new Error(`Pathname inválido o con traversal rechazado: ${relativePath}`);
  }

  const origin = options.baseOrigin
    ? normalizeAppOrigin(options.baseOrigin, {
        requireHttps: !LOCALHOST_HOSTS.has(new URL(options.baseOrigin).hostname.toLowerCase()),
      })
    : getCanonicalAppOrigin(options.env);

  if (normalizedPath === '/') {
    return origin;
  }

  return `${origin}${normalizedPath}`;
}

export interface ServerOriginResolution {
  /** Origen canónico oficial a proyectar en og:url, link[rel=canonical], og:image y Location 302. */
  canonicalOrigin: string;
  /** Indica si el encabezado Host recibido fue reconocido dentro de la lista blanca confiable. */
  isTrustedRequestHost: boolean;
  /** Indica si la petición ingresó por un dominio histórico registrado. */
  isLegacyRequestHost: boolean;
  brand: BrandConfig;
}

function extractFirstHeaderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0].split(',')[0].trim() : '';
  }
  if (typeof value === 'string') {
    return value.split(',')[0].trim();
  }
  return '';
}

/**
 * Resuelve de forma segura el origen canónico para funciones serverless (ej. api/open-encounter.ts).
 *
 * Mitiga Host Header Injection, Open Redirects (302 Location) y OG Cache Poisoning:
 * - Jamás acepta un encabezado Host / X-Forwarded-Host arbitrario ni protocolo http inseguro.
 * - Si PUBLIC_APP_ORIGIN o VITE_APP_URL está definido y es válido, manda como fuente autoritativa.
 * - Si no está definido, solo admite hosts exactamente presentes en la lista blanca activa
 *   (producción canónica, staging canónico, preview Vercel en VERCEL_ENV=preview, o localhost en dev);
 *   cualquier otro host cae fail-closed a DEFAULT_PRODUCTION_ORIGIN (o staging si VITE_APP_ENV=staging).
 * - Si la solicitud entra por un dominio histórico (LEGACY_APP_ORIGINS), retorna siempre
 *   el origen canónico vigente (1 salto, cero envenenamiento de canónica).
 */
export function resolveServerCanonicalOrigin(params: {
  headers?: Record<string, unknown>;
  env?: EnvSource;
}): ServerOriginResolution {
  const env = params.env ?? readDefaultEnvSource();
  const explicitOriginRaw = (env.PUBLIC_APP_ORIGIN || env.VITE_APP_URL || '').trim();
  const hasExplicitEnv = Boolean(env.VITE_APP_ENV?.trim());
  const config = resolveDomainConfig({ env, strict: false });

  const rawHostHeader =
    extractFirstHeaderValue(params.headers?.['x-forwarded-host']) ||
    extractFirstHeaderValue(params.headers?.['host']);

  let parsedHost = '';
  let parsedHostname = '';
  if (rawHostHeader && !/[\s\r\n\t\0\\/@]/.test(rawHostHeader)) {
    try {
      const candidate = new URL(`https://${rawHostHeader}`);
      if (candidate.pathname === '/' && !candidate.search && !candidate.hash && !candidate.username) {
        parsedHost = candidate.host.toLowerCase();
        parsedHostname = candidate.hostname.toLowerCase();
      }
    } catch {
      parsedHost = '';
      parsedHostname = '';
    }
  }

  const isLegacyRequestHost = Boolean(parsedHost && config.legacyHosts.has(parsedHost));

  // 1. Si hay un origen canónico explícito configurado por entorno, úsese siempre como fuente de verdad
  if (explicitOriginRaw) {
    const isTrustedRequestHost =
      Boolean(parsedHost) &&
      (config.trustedActiveHosts.has(parsedHost) || isLegacyRequestHost);
    return {
      canonicalOrigin: config.canonicalOrigin,
      isTrustedRequestHost,
      isLegacyRequestHost,
      brand: config.brand,
    };
  }

  // 2. Sin PUBLIC_APP_ORIGIN/VITE_APP_URL explícito: validar estrictamente contra hosts confiables
  if (parsedHost) {
    if (isLegacyRequestHost) {
      return {
        canonicalOrigin:
          config.environment === 'staging' ? config.stagingOrigin : config.productionOrigin,
        isTrustedRequestHost: true,
        isLegacyRequestHost: true,
        brand: config.brand,
      };
    }

    const prodHost = new URL(config.productionOrigin).host.toLowerCase();
    const stgHost = new URL(config.stagingOrigin).host.toLowerCase();

    if (parsedHost === stgHost && (!hasExplicitEnv || config.environment !== 'production')) {
      return {
        canonicalOrigin: config.stagingOrigin,
        isTrustedRequestHost: true,
        isLegacyRequestHost: false,
        brand: config.brand,
      };
    }

    if (parsedHost === prodHost && (!hasExplicitEnv || config.environment === 'production')) {
      return {
        canonicalOrigin: config.productionOrigin,
        isTrustedRequestHost: true,
        isLegacyRequestHost: false,
        brand: config.brand,
      };
    }

    if (config.environment === 'preview' && VERCEL_PREVIEW_HOST_REGEX.test(parsedHostname)) {
      return {
        canonicalOrigin: `https://${parsedHostname}`,
        isTrustedRequestHost: true,
        isLegacyRequestHost: false,
        brand: config.brand,
      };
    }

    if (
      config.environment === 'development' &&
      !hasExplicitEnv &&
      LOCALHOST_HOSTS.has(parsedHostname)
    ) {
      return {
        canonicalOrigin: `http://${parsedHost}`,
        isTrustedRequestHost: true,
        isLegacyRequestHost: false,
        brand: config.brand,
      };
    }
  }

  // 3. Host ausente o NO autorizado -> Fail-closed al origen público registrado del entorno
  const safeFallbackOrigin =
    config.environment === 'staging' ? config.stagingOrigin : config.productionOrigin;

  return {
    canonicalOrigin: safeFallbackOrigin,
    isTrustedRequestHost: false,
    isLegacyRequestHost: false,
    brand: config.brand,
  };
}

// ============================================================================
// 7. ESTRATEGIA PREPARADA (INACTIVA) DE REDIRECCIÓN N→1 DE DOMINIOS HISTÓRICOS
// ============================================================================

/** Rutas exentas de redirección automática para preservar rescate de sesión, PKCE y Service Worker. */
const LEGACY_REDIRECT_EXEMPT_PATHS = new Set([
  '/migrate-domain',
  '/auth/domain-bridge',
  '/sw.js',
  '/manifest.webmanifest',
]);

export type LegacyRedirectDecision =
  | {
      shouldRedirect: false;
      reason:
        | 'redirect_disabled'
        | 'invalid_request_url'
        | 'already_canonical_or_non_legacy'
        | 'exempt_bridge_or_worker_route'
        | 'exempt_oauth_callback_in_flight'
        | 'unsafe_path_rejected';
    }
  | {
      shouldRedirect: true;
      statusCode: 302 | 308;
      destinationUrl: string;
    };

function isOAuthCallbackInFlight(parsed: URL): boolean {
  if (parsed.searchParams.has('code') || parsed.searchParams.has('error_description')) {
    return true;
  }
  const hash = parsed.hash.toLowerCase();
  return hash.includes('access_token=') || hash.includes('refresh_token=') || hash.includes('error=');
}

/**
 * Evalúa si una URL entrante sobre un dominio histórico debe redirigirse directamente (1 salto)
 * al origen canónico vigente, conservando path, query y fragmento legítimos.
 *
 * IMPORTANTE: Por restricción operativa actual, `legacyRedirectEnabled` está desactivado (`false`)
 * por defecto. Esta función prepara y verifica la lógica N→1 (Dominio A -> C y Dominio B -> C,
 * cero cadenas) antes de cualquier activación futura.
 */
export function resolveLegacyDomainRedirect(
  rawRequestUrl: string,
  config: Pick<DomainConfig, 'canonicalOrigin' | 'legacyHosts' | 'legacyRedirectEnabled'>,
  options: { permanent?: boolean } = {}
): LegacyRedirectDecision {
  if (!config.legacyRedirectEnabled) {
    return { shouldRedirect: false, reason: 'redirect_disabled' };
  }

  if (typeof rawRequestUrl !== 'string' || !rawRequestUrl.trim() || /[\s\r\n\t\0\\]/.test(rawRequestUrl)) {
    return { shouldRedirect: false, reason: 'invalid_request_url' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawRequestUrl);
  } catch {
    return { shouldRedirect: false, reason: 'invalid_request_url' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { shouldRedirect: false, reason: 'invalid_request_url' };
  }

  const canonicalUrlObj = new URL(config.canonicalOrigin);
  const requestHost = parsed.host.toLowerCase();

  // Nunca redirigir si ya estamos en el canónico o si el host no es un dominio histórico propio
  if (requestHost === canonicalUrlObj.host.toLowerCase() || !config.legacyHosts.has(requestHost)) {
    return { shouldRedirect: false, reason: 'already_canonical_or_non_legacy' };
  }

  // Rechazar cualquier intento de path ambiguo (//evil.com, traversal ..)
  if (parsed.pathname.includes('//') || parsed.pathname.split('/').includes('..')) {
    return { shouldRedirect: false, reason: 'unsafe_path_rejected' };
  }

  // Eximir rutas de puente migratorio y Service Worker / Manifest
  if (LEGACY_REDIRECT_EXEMPT_PATHS.has(parsed.pathname)) {
    return { shouldRedirect: false, reason: 'exempt_bridge_or_worker_route' };
  }

  // Eximir callbacks OAuth / PKCE en vuelo iniciados en el origen antiguo
  if (isOAuthCallbackInFlight(parsed)) {
    return { shouldRedirect: false, reason: 'exempt_oauth_callback_in_flight' };
  }

  // Construcción estricta sobre canonicalUrlObj (imposible cambiar host/esquema desde el request)
  const target = new URL(canonicalUrlObj.origin);
  target.pathname = parsed.pathname || '/';
  target.search = parsed.search;
  target.hash = parsed.hash;

  return {
    shouldRedirect: true,
    // 302 durante ventana piloto reversible; 308 solo cuando se autorice corte definitivo
    statusCode: options.permanent ? 308 : 302,
    destinationUrl: target.href,
  };
}

// ============================================================================
// 8. SANITIZACIÓN DE TOKENS SENSIBLES EN LOGS Y DIAGNÓSTICOS
// ============================================================================

const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'public_token',
  'invite_token',
  'code',
  'ticket',
  'transfer_ticket',
  'access_token',
  'refresh_token',
]);

/**
 * Enmascara tokens privados en rutas de invitación y parámetros sensibles
 * antes de cualquier registro en logs, telemetría o mensajes de diagnóstico.
 */
export function redactSensitiveUrlForLogs(rawUrlOrPath: string): string {
  if (!rawUrlOrPath || typeof rawUrlOrPath !== 'string') return '';

  const maskPath = (pathname: string): string =>
    pathname
      .replace(/^(\/coordination\/(?:invite|join)\/)[^/?#]+/i, '$1[REDACTED_TOKEN]')
      .replace(/^(\/(?:invite|join)\/)[^/?#]+/i, '$1[REDACTED_TOKEN]');

  try {
    const isRelative = rawUrlOrPath.startsWith('/');
    const parsed = new URL(rawUrlOrPath, 'https://redaction.internal');
    parsed.pathname = maskPath(parsed.pathname);

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }

    if (parsed.hash) {
      parsed.hash = '#[REDACTED_FRAGMENT]';
    }

    return isRelative
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return maskPath(rawUrlOrPath).replace(
      /([?&#](?:token|public_token|code|ticket|access_token|refresh_token)=)[^&#\s]+/gi,
      '$1[REDACTED]'
    );
  }
}

/** Valida tokens de invitación (/join/:token, /invite/:token, /coordination/*) de forma uniforme. */
export function isValidRouteInvitationToken(token: unknown): token is string {
  return typeof token === 'string' && SAFE_INVITE_TOKEN_REGEX.test(token.trim());
}

/** Valida identificadores UUID de rutas (/e/:id, /meet/:id, /invitation/:id, /share/:id). */
export function isValidRouteUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_V4_OR_RFC_REGEX.test(id.trim());
}
