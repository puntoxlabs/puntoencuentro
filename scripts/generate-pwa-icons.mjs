// Genera los iconos PWA a partir del logo existente (public/favicon.svg).
// No introduce identidad nueva: solo compone el logo actual sobre el fondo de la app.
//   node scripts/generate-pwa-icons.mjs
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const svg = fs.readFileSync(path.join(root, 'public', 'favicon.svg'));
const BACKGROUND = '#F5F7FA'; // --color-background

async function render(size, logoRatio, file) {
  const logoSize = Math.round(size * logoRatio);
  const logo = await sharp(svg, { density: 384 })
    .resize(logoSize, logoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({ create: { width: size, height: size, channels: 4, background: BACKGROUND } })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toFile(path.join(root, 'public', 'icons', file));
  console.log('generado', file);
}

fs.mkdirSync(path.join(root, 'public', 'icons'), { recursive: true });
// "any": logo ocupa ~70% del lienzo
await render(192, 0.7, 'icon-192.png');
await render(512, 0.7, 'icon-512.png');
// "maskable": el logo queda dentro de la safe zone (círculo central de 80%) → ~52%
await render(192, 0.52, 'icon-maskable-192.png');
await render(512, 0.52, 'icon-maskable-512.png');
// iOS home screen
await render(180, 0.7, 'apple-touch-icon.png');
