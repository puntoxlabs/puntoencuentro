import { createClient } from '@supabase/supabase-js';

const processEnv = typeof globalThis !== 'undefined' ? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env : undefined;
const env = (
  (typeof import.meta !== 'undefined' && (import.meta as { env?: Record<string, string | undefined> }).env) ||
  processEnv ||
  {}
) as Record<string, string | undefined>;
const supabaseUrl = env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';

// Prefer new publishable key; fall back to legacy anon key during transition
const supabaseKey =
  env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  env.VITE_SUPABASE_ANON_KEY ||
  'placeholder_key';

export const supabase = createClient(supabaseUrl, supabaseKey);
