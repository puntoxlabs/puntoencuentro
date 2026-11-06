/**
 * Vercel Serverless Function: api/open-encounter.ts
 *
 * Entrega de metadatos Open Graph / Twitter Cards dinámicos para rastreadores de
 * WhatsApp, Telegram, Facebook, Twitter y redes sociales en Encuentros Abiertos.
 *
 * Invariantes de Seguridad:
 * - Proyecta exclusivamente información pública autorizada mediante la RPC
 *   public.get_encuentro_abierto_publico.
 * - Cero exposición de datos logísticos privados (lugar_texto, link_virtual, tokens, invitados).
 * - Verificación estricta de formato UUID RFC 4122.
 * - Escapado HTML exhaustivo para prevenir inyecciones XSS en metadatos.
 * - Si el encuentro no existe, está cancelado, en revisión o cerrado, retorna
 *   metadatos genéricos institucionales seguros de PuntoEncuentro.
 * - Redirige a usuarios normales (navegadores) a la experiencia interactiva de la SPA.
 */

import { createClient } from '@supabase/supabase-js';

// Lista exhaustiva de identificadores de rastreadores y lectores de vista previa social
const BOT_USER_AGENTS_REGEX =
  /whatsapp|facebookexternalhit|facebot|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|embedly|quora link preview|showyoubot|outbrain|pinterest|applebot|googlebot|bingbot|yandexbot|vkshare|w3c_validator/i;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCrawler(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return BOT_USER_AGENTS_REGEX.test(userAgent);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function generateOpenGraphHtml(params: {
  title: string;
  description: string;
  url: string;
  imageUrl: string;
  siteName?: string;
  targetSpaUrl: string;
}): string {
  const safeTitle = escapeHtml(params.title);
  const safeDesc = escapeHtml(params.description);
  const safeUrl = escapeHtml(params.url);
  const safeImage = escapeHtml(params.imageUrl);
  const safeSiteName = escapeHtml(params.siteName || 'PuntoEncuentro');
  const safeSpaUrl = escapeHtml(params.targetSpaUrl);

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} | ${safeSiteName}</title>
  <meta name="description" content="${safeDesc}" />

  <!-- Open Graph / WhatsApp / Telegram / Facebook -->
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${safeSiteName}" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:url" content="${safeUrl}" />
  <meta property="og:image" content="${safeImage}" />
  <meta property="og:image:secure_url" content="${safeImage}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${safeTitle}" />

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@puntoencuentro" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${safeImage}" />

  <link rel="canonical" href="${safeUrl}" />
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #1e293b; padding: 2rem; text-align: center;">
  <div style="max-width: 480px; margin: 4rem auto; background: #ffffff; border-radius: 16px; padding: 2rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
    <h1 style="font-size: 1.25rem; font-weight: 700; margin-bottom: 0.5rem; color: #0f172a;">${safeTitle}</h1>
    <p style="font-size: 0.95rem; color: #64748b; line-height: 1.5; margin-bottom: 1.5rem;">${safeDesc}</p>
    <a href="${safeSpaUrl}" style="display: inline-block; background: #19345C; color: #ffffff; text-decoration: none; padding: 0.75rem 1.5rem; border-radius: 10px; font-weight: 600; font-size: 0.95rem;">
      Ver encuentro en PuntoEncuentro
    </a>
  </div>
  <script>
    window.location.replace("${safeSpaUrl}");
  </script>
</body>
</html>`;
}

export default async function handler(req: any, res: any) {
  // Extraer ID de query o de params
  const rawId = req.query?.id || req.query?.open_encounter;
  const userAgent = req.headers?.['user-agent'] || '';

  const host = req.headers?.['x-forwarded-host'] || req.headers?.['host'] || 'puntoencuentro.com.ar';
  const proto = req.headers?.['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${host}`;

  // Si no es un bot ni lector de enlaces, redirigir al flujo interactivo de la SPA
  const isBot = isCrawler(userAgent);

  const cleanId = typeof rawId === 'string' ? rawId.trim() : '';
  const isValid = UUID_REGEX.test(cleanId);

  // URL canónica del recurso
  const canonicalUrl = isValid ? `${origin}/e/${cleanId}` : origin;
  const targetSpaUrl = isValid ? `${origin}/?open_encounter=${cleanId}` : `${origin}/`;
  const defaultImageUrl = `${origin}/images/og-share.png`;

  if (!isBot) {
    res.writeHead(302, {
      Location: targetSpaUrl,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end();
    return;
  }

  // Si el UUID no es válido, retornar tarjeta genérica
  if (!isValid) {
    const genericHtml = generateOpenGraphHtml({
      title: 'PuntoEncuentro — Organizá encuentros y compartí momentos',
      description: 'Coordiná fechas, invitá a tu grupo y descubrí planes de forma privada y sin vueltas.',
      url: origin,
      imageUrl: defaultImageUrl,
      targetSpaUrl: origin,
    });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(genericHtml);
    return;
  }

  try {
    const supabaseUrl =
      process.env.VITE_SUPABASE_URL ||
      process.env.SUPABASE_URL;

    const supabaseAnonKey =
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY;

    // Validación estricta y explícita del entorno Supabase correspondiente
    let isValidUrl = false;
    try {
      if (supabaseUrl && typeof supabaseUrl === 'string') {
        const parsed = new URL(supabaseUrl);
        isValidUrl = parsed.protocol === 'https:' || parsed.protocol === 'http:';
      }
    } catch {
      isValidUrl = false;
    }

    if (!isValidUrl || !supabaseAnonKey || typeof supabaseAnonKey !== 'string' || !supabaseAnonKey.trim()) {
      console.warn('[open-encounter] Configuración de Supabase ausente o inconsistente en el entorno. Fallando de forma segura con previsualización institucional.');
      const safeHtml = generateOpenGraphHtml({
        title: 'PuntoEncuentro — Organizá encuentros y compartí momentos',
        description: 'Coordiná fechas, invitá a tu grupo y descubrí planes de forma privada y sin vueltas.',
        url: canonicalUrl,
        imageUrl: defaultImageUrl,
        targetSpaUrl,
      });

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      });
      res.end(safeHtml);
      return;
    }

    const supabase = createClient(supabaseUrl!, supabaseAnonKey, {
      auth: { persistSession: false },
    });

    // Consultar RPC pública segura
    const { data: rpcRes, error } = await supabase.rpc('get_encuentro_abierto_publico', {
      p_encuentro_id: cleanId,
    });

    if (error || !(rpcRes as any)?.ok || !(rpcRes as any)?.data) {
      // Si no existe, no está aprobado o está cancelado: fallback seguro genérico
      const fallbackHtml = generateOpenGraphHtml({
        title: 'Encuentro en PuntoEncuentro',
        description: 'Conocé propuestas y sumate a encuentros de forma simple y cuidada.',
        url: canonicalUrl,
        imageUrl: defaultImageUrl,
        targetSpaUrl,
      });

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=10, s-maxage=30',
      });
      res.end(fallbackHtml);
      return;
    }

    const item = (rpcRes as any).data;
    const title = item.title || 'Encuentro en PuntoEncuentro';

    const metaParts: string[] = [];
    if (item.approximate_zone && item.approximate_zone.trim()) {
      metaParts.push(item.approximate_zone.trim());
    }
    if (item.date_label && item.date_label.trim()) {
      metaParts.push(item.date_label.trim());
    }
    if (item.time_label && item.time_label.trim()) {
      metaParts.push(item.time_label.trim());
    }

    const metaPrefix = metaParts.length > 0 ? `${metaParts.join(' · ')} — ` : '';
    const descText = item.description ? item.description.trim() : 'Conocé la propuesta y solicitá sumarte.';
    const finalDescription = `${metaPrefix}${descText}`;

    const html = generateOpenGraphHtml({
      title,
      description: finalDescription,
      url: canonicalUrl,
      imageUrl: defaultImageUrl,
      targetSpaUrl,
    });

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
    });
    res.end(html);
  } catch (err) {
    console.error('[open-encounter] Error rendering social preview:', err);
    const safeHtml = generateOpenGraphHtml({
      title: 'PuntoEncuentro — Organizá encuentros y compartí momentos',
      description: 'Coordiná fechas, invitá a tu grupo y descubrí planes de forma privada y sin vueltas.',
      url: canonicalUrl,
      imageUrl: defaultImageUrl,
      targetSpaUrl,
    });

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=30',
    });
    res.end(safeHtml);
  }
}
