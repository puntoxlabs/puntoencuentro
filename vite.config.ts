import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { execSync } from 'child_process'
import {
  resolveAppEnvironment,
  validateBuildDomainConfig,
  type DomainConfig,
  type EnvSource,
} from './src/config/domainConfig.ts'

function getGitCommit(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  }
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'local';
  }
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createCanonicalHtmlMetadataPlugin(domainCfg: DomainConfig): Plugin {
  return {
    name: 'pe-canonical-html-metadata',
    transformIndexHtml(html) {
      const { canonicalOrigin, brand } = domainCfg;
      const canonicalRootUrl = `${canonicalOrigin}/`;
      const socialImageUrl = `${canonicalOrigin}${brand.socialImagePath}`;

      let output = html
        .replace(
          /<meta name="apple-mobile-web-app-title" content="[^"]*"\s*\/>/,
          `<meta name="apple-mobile-web-app-title" content="${escapeHtmlAttr(brand.shortName)}" />`
        )
        .replace(
          /<title>[^<]*<\/title>/,
          `<title>${escapeHtmlAttr(brand.defaultTitle)}</title>`
        )
        .replace(
          /<meta name="description" content="[^"]*"\s*\/>/,
          `<meta name="description" content="${escapeHtmlAttr(brand.defaultDescription)}" />`
        )
        .replace(
          /<meta property="og:site_name" content="[^"]*"\s*\/>/,
          `<meta property="og:site_name" content="${escapeHtmlAttr(brand.brandName)}" />`
        )
        .replace(
          /<meta property="og:title" content="[^"]*"\s*\/>/,
          `<meta property="og:title" content="${escapeHtmlAttr(brand.socialTitle)}" />`
        )
        .replace(
          /<meta property="og:description" content="[^"]*"\s*\/>/,
          `<meta property="og:description" content="${escapeHtmlAttr(brand.socialDescription)}" />`
        )
        .replace(
          /<meta property="og:url" content="[^"]*"\s*\/>/,
          `<meta property="og:url" content="${escapeHtmlAttr(canonicalRootUrl)}" />`
        )
        .replace(
          /<meta property="og:image" content="[^"]*"\s*\/>/,
          `<meta property="og:image" content="${escapeHtmlAttr(socialImageUrl)}" />`
        )
        .replace(
          /<meta property="og:image:secure_url" content="[^"]*"\s*\/>/,
          `<meta property="og:image:secure_url" content="${escapeHtmlAttr(socialImageUrl)}" />`
        )
        .replace(
          /<meta property="og:image:alt" content="[^"]*"\s*\/>/,
          `<meta property="og:image:alt" content="${escapeHtmlAttr(brand.socialImageAlt)}" />`
        )
        .replace(
          /<meta name="twitter:title" content="[^"]*"\s*\/>/,
          `<meta name="twitter:title" content="${escapeHtmlAttr(brand.socialTitle)}" />`
        )
        .replace(
          /<meta name="twitter:description" content="[^"]*"\s*\/>/,
          `<meta name="twitter:description" content="${escapeHtmlAttr(brand.socialDescription)}" />`
        )
        .replace(
          /<meta name="twitter:image" content="[^"]*"\s*\/>/,
          `<meta name="twitter:image" content="${escapeHtmlAttr(socialImageUrl)}" />`
        );

      if (!output.includes('rel="canonical"')) {
        output = output.replace(
          '</head>',
          `    <link rel="canonical" href="${escapeHtmlAttr(canonicalRootUrl)}" />\n  </head>`
        );
      }

      return output;
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const mergedEnv: EnvSource = {
    VITE_APP_ENV: process.env.VITE_APP_ENV ?? fileEnv.VITE_APP_ENV,
    VITE_APP_URL: process.env.VITE_APP_URL ?? fileEnv.VITE_APP_URL,
    VITE_APP_BRAND_NAME: process.env.VITE_APP_BRAND_NAME ?? fileEnv.VITE_APP_BRAND_NAME,
    VITE_APP_SHORT_NAME: process.env.VITE_APP_SHORT_NAME ?? fileEnv.VITE_APP_SHORT_NAME,
    VITE_PUBLIC_SUPPORT_EMAIL:
      process.env.VITE_PUBLIC_SUPPORT_EMAIL ?? fileEnv.VITE_PUBLIC_SUPPORT_EMAIL,
    VITE_APP_TWITTER_SITE: process.env.VITE_APP_TWITTER_SITE ?? fileEnv.VITE_APP_TWITTER_SITE,
    VITE_REQUIRE_EXPLICIT_APP_URL:
      process.env.VITE_REQUIRE_EXPLICIT_APP_URL ?? fileEnv.VITE_REQUIRE_EXPLICIT_APP_URL,
    PUBLIC_APP_ORIGIN: process.env.PUBLIC_APP_ORIGIN ?? fileEnv.PUBLIC_APP_ORIGIN,
    PUBLIC_STAGING_ORIGIN: process.env.PUBLIC_STAGING_ORIGIN ?? fileEnv.PUBLIC_STAGING_ORIGIN,
    LEGACY_APP_ORIGINS: process.env.LEGACY_APP_ORIGINS ?? fileEnv.LEGACY_APP_ORIGINS,
    ENABLE_LEGACY_DOMAIN_REDIRECT:
      process.env.ENABLE_LEGACY_DOMAIN_REDIRECT ?? fileEnv.ENABLE_LEGACY_DOMAIN_REDIRECT,
    APP_BRAND_NAME: process.env.APP_BRAND_NAME ?? fileEnv.APP_BRAND_NAME,
    APP_SHORT_NAME: process.env.APP_SHORT_NAME ?? fileEnv.APP_SHORT_NAME,
    PUBLIC_SUPPORT_EMAIL: process.env.PUBLIC_SUPPORT_EMAIL ?? fileEnv.PUBLIC_SUPPORT_EMAIL,
    APP_TWITTER_SITE: process.env.APP_TWITTER_SITE ?? fileEnv.APP_TWITTER_SITE,
    VERCEL_ENV: process.env.VERCEL_ENV ?? fileEnv.VERCEL_ENV,
    VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF ?? fileEnv.VERCEL_GIT_COMMIT_REF,
    NODE_ENV: process.env.NODE_ENV,
  };

  const appEnv = resolveAppEnvironment(mergedEnv);

  // En `vite build`, validamos de modo fail-closed cualquier configuración de dominio provista
  const domainCfg =
    command === 'build'
      ? validateBuildDomainConfig({ ...mergedEnv, VITE_APP_ENV: appEnv })
      : validateBuildDomainConfig({ ...mergedEnv, VITE_APP_ENV: appEnv }, { requireExplicitOrigin: false });

  return {
    plugins: [react(), createCanonicalHtmlMetadataPlugin(domainCfg)],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(
        new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
      ),
      __APP_ENV__: JSON.stringify(appEnv),
      __GIT_COMMIT__: JSON.stringify(getGitCommit()),
    },
  };
})
