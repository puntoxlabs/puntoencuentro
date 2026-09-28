/**
 * Disable legacy API keys (anon + service_role) for Supabase Staging.
 * Uses Supabase Management API PUT /v1/projects/{ref}/api-keys/legacy
 * Reads access token from ~/.supabase/access-token (never printed).
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const STAGING_REF = 'wougfhfwqgmxhgvjqoua';
const PRODUCTION_REF = 'aurbicjwftjhwryhyjiq';

function request(token, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL('https://api.supabase.com' + urlPath);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const bodyBuf = bodyStr ? Buffer.from(bodyStr, 'utf8') : undefined;
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function main() {
  const home = process.env.USERPROFILE || process.env.HOME;
  const tokenPath = path.join(home, '.supabase', 'access-token');
  if (!fs.existsSync(tokenPath)) {
    throw new Error('Supabase access token not found. Run: npx supabase login');
  }
  const token = fs.readFileSync(tokenPath, 'utf8').trim();

  // Safety: never touch production
  console.log('[CHECK] Targeting Staging project only:', STAGING_REF);
  console.log('[CHECK] Production project is NOT touched:', PRODUCTION_REF);

  // Check current status
  const statusRes = await request(token, 'GET', `/v1/projects/${STAGING_REF}/api-keys/legacy`);
  console.log('[STATUS] Legacy keys current state:', statusRes.body);

  if (statusRes.status !== 200) {
    throw new Error(`Failed to get legacy key status: HTTP ${statusRes.status} — ${statusRes.body}`);
  }

  const currentState = JSON.parse(statusRes.body);
  if (!currentState.enabled) {
    console.log('[SKIP] Legacy keys are already disabled. Nothing to do.');
    return;
  }

  // Disable legacy keys — API requires string "false" (boolean-string, not JSON boolean)
  console.log('[ACTION] Disabling legacy keys for Staging...');
  const disableRes = await request(token, 'PUT', `/v1/projects/${STAGING_REF}/api-keys/legacy`, { enabled: 'false' });
  console.log('[RESULT] HTTP', disableRes.status, '—', disableRes.body);

  if (disableRes.status !== 200 && disableRes.status !== 201) {
    throw new Error(`Failed to disable legacy keys: HTTP ${disableRes.status} — ${disableRes.body}`);
  }

  // Verify
  const verifyRes = await request(token, 'GET', `/v1/projects/${STAGING_REF}/api-keys/legacy`);
  const verifyState = JSON.parse(verifyRes.body);
  console.log('[VERIFY] Legacy keys enabled:', verifyState.enabled);

  if (verifyState.enabled !== false) {
    throw new Error('Legacy keys still enabled after PUT request!');
  }

  console.log('[SUCCESS] Legacy keys are now DISABLED in Staging.');
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});
