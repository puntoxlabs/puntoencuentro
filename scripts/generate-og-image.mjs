import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const width = 1200;
const height = 630;

// SVG canvas for high-DPI rendering
const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Background Gradient -->
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0a1026" />
      <stop offset="50%" stop-color="#111f4d" />
      <stop offset="100%" stop-color="#184CD4" />
    </linearGradient>

    <!-- Accent Glow -->
    <radialGradient id="glow" cx="80%" cy="20%" r="60%">
      <stop offset="0%" stop-color="#863BFF" stop-opacity="0.45" />
      <stop offset="100%" stop-color="#863BFF" stop-opacity="0" />
    </radialGradient>

    <radialGradient id="glow2" cx="20%" cy="80%" r="50%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.25" />
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0" />
    </radialGradient>

    <!-- Card Background -->
    <linearGradient id="cardBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.08" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.02" />
    </linearGradient>

    <!-- Logo Gradient -->
    <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#863bff" />
      <stop offset="100%" stop-color="#38bdf8" />
    </linearGradient>

    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="12" stdDeviation="24" flood-color="#000000" flood-opacity="0.4" />
    </filter>
  </defs>

  <!-- Background Base -->
  <rect width="${width}" height="${height}" fill="url(#bg)" />
  <rect width="${width}" height="${height}" fill="url(#glow)" />
  <rect width="${width}" height="${height}" fill="url(#glow2)" />

  <!-- Subtle grid lines for modern tech feel -->
  <g stroke="#ffffff" stroke-opacity="0.04" stroke-width="1">
    <line x1="100" y1="0" x2="100" y2="${height}" />
    <line x1="300" y1="0" x2="300" y2="${height}" />
    <line x1="600" y1="0" x2="600" y2="${height}" />
    <line x1="900" y1="0" x2="900" y2="${height}" />
    <line x1="1100" y1="0" x2="1100" y2="${height}" />
    <line x1="0" y1="150" x2="${width}" y2="150" />
    <line x1="0" y1="315" x2="${width}" y2="315" />
    <line x1="0" y1="480" x2="${width}" y2="480" />
  </g>

  <!-- Decorative geometric elements -->
  <circle cx="1020" cy="180" r="140" fill="url(#cardBg)" stroke="#ffffff" stroke-opacity="0.1" stroke-width="1.5" />
  <circle cx="1020" cy="180" r="85" fill="none" stroke="#863BFF" stroke-opacity="0.3" stroke-width="2" stroke-dasharray="6 6" />

  <!-- Center Card / Content Box -->
  <g transform="translate(100, 110)">
    <!-- Brand Emblem -->
    <g transform="translate(0, 0)">
      <rect width="76" height="76" rx="20" fill="#ffffff" fill-opacity="0.12" stroke="#ffffff" stroke-opacity="0.25" stroke-width="1.5" />
      <!-- Logo Pin icon inspired by PuntoEncuentro -->
      <path d="M38 18 C28.0589 18 20 26.0589 20 36 C20 48.5 38 60 38 60 C38 60 56 48.5 56 36 C56 26.0589 47.9411 18 38 18 Z" fill="url(#logoGrad)" filter="url(#shadow)" />
      <circle cx="38" cy="35" r="7" fill="#ffffff" />
    </g>

    <!-- Main Title -->
    <text x="96" y="54" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="52" font-weight="800" fill="#ffffff" letter-spacing="-1.5">
      PuntoEncuentro
    </text>

    <!-- Tagline / Headline -->
    <text x="0" y="165" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="44" font-weight="700" fill="#f8fafc" letter-spacing="-0.5">
      Organizá encuentros y compartí
    </text>
    <text x="0" y="222" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="44" font-weight="700" fill="#38bdf8" letter-spacing="-0.5">
      momentos con amigos.
    </text>

    <!-- Description -->
    <text x="0" y="285" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="22" font-weight="400" fill="#94a3b8">
      Coordiná fechas, invitá a tu grupo y descubrí planes de forma privada y sin vueltas.
    </text>

    <!-- Badges -->
    <g transform="translate(0, 345)">
      <!-- Badge 1 -->
      <rect x="0" y="0" width="180" height="42" rx="21" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.18" stroke-width="1" />
      <text x="90" y="26" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="15" font-weight="600" fill="#e2e8f0">
        ✓ 100% Privado
      </text>

      <!-- Badge 2 -->
      <rect x="195" y="0" width="195" height="42" rx="21" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.18" stroke-width="1" />
      <text x="292" y="26" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="15" font-weight="600" fill="#e2e8f0">
        ✓ Coordinar fechas
      </text>

      <!-- Badge 3 -->
      <rect x="405" y="0" width="195" height="42" rx="21" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.18" stroke-width="1" />
      <text x="502" y="26" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="15" font-weight="600" fill="#e2e8f0">
        ✓ Sin descargas
      </text>
    </g>
  </g>
</svg>
`;

async function main() {
  const outputPath = path.resolve('public/images/og-share.png');
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  await sharp(Buffer.from(svg))
    .png({ quality: 95, compressionLevel: 8 })
    .toFile(outputPath);

  console.log(`✅ Generated ${outputPath} (${width}x${height})`);
}

main().catch(err => {
  console.error('Failed to generate OG image:', err);
  process.exit(1);
});
