/**
 * QA Seed Script: Plan Definitions in Staging
 *
 * Populates temporary plan definitions for QA/E2E testing in Staging ONLY.
 * Never executed in Production. Uses SUPABASE_STAGING_SECRET_KEY.
 */

import { createClient } from '@supabase/supabase-js';
import { assertStagingEnvironment, STAGING_PROJECT_REF, getStagingSecretKey } from './lib/environment-guard';

const url = 'https://wougfhfwqgmxhgvjqoua.supabase.co';

assertStagingEnvironment(url);

const secretKey = getStagingSecretKey();
const admin = createClient(url, secretKey, { auth: { persistSession: false } });

export async function seedPlanDefinitions(): Promise<void> {
  console.log(`[QA Seed] Seeding plan_definitions in Staging (${STAGING_PROJECT_REF})...`);

  const plans = [
    {
      plan: 'free',
      ai_monthly_sessions_limit: 3,
      ai_monthly_enforcement_enabled: true,
      max_active_open_encounters: 2,
      capabilities: {
        ai_creation: true,
        recurring: false,
        habitual_groups: false,
        advanced_discovery: false,
      },
    },
    {
      plan: 'premium',
      ai_monthly_sessions_limit: 20,
      ai_monthly_enforcement_enabled: true,
      max_active_open_encounters: 10,
      capabilities: {
        ai_creation: true,
        recurring: true,
        habitual_groups: true,
        advanced_discovery: true,
      },
    },
    {
      plan: 'organizer',
      ai_monthly_sessions_limit: null,
      ai_monthly_enforcement_enabled: false,
      max_active_open_encounters: 50,
      capabilities: {
        ai_creation: true,
        recurring: true,
        habitual_groups: true,
        advanced_discovery: true,
      },
    },
  ];

  for (const p of plans) {
    const { error } = await admin
      .from('plan_definitions')
      .upsert(p, { onConflict: 'plan' });

    if (error) {
      console.error(`[QA Seed] Error upserting plan ${p.plan}:`, error);
      throw new Error(`Failed to seed plan: ${p.plan}`);
    }
  }

  console.log('[QA Seed] Successfully seeded plan_definitions for QA in Staging.');
}

// Execute if run directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  seedPlanDefinitions()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[QA Seed Error]', err);
      process.exit(1);
    });
}
