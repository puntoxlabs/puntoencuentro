import { getVercelBypassSecret } from './lib/environment-guard';

async function checkSW() {
  try {
    const bypassSecret = getVercelBypassSecret();
    const headers: Record<string, string> = {};
    if (bypassSecret) {
      headers['x-vercel-protection-bypass'] = bypassSecret;
    }

    const res = await fetch('https://staging.puntoencuentro.com.ar/sw.js', {
      headers,
      cache: 'no-store'
    });
    console.log('HTTP Status:', res.status, res.headers.get('content-type'));
    const text = await res.text();
    const hasCritical = text.includes("const isCritical = data.urgency === 'high' || data.is_critical === true;");
    const hasTagUndefined = text.includes("const tag = isCritical ? undefined : (data.tag || 'pe-notification');");
    console.log('Includes isCritical check:', hasCritical);
    console.log('Includes tag undefined check:', hasTagUndefined);
    console.log('Content preview:');
    console.log(text.slice(0, 300));
  } catch (err: any) {
    console.error('Fetch error:', err.message);
  }
}
checkSW();
