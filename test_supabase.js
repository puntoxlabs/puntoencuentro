import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const envFile = fs.readFileSync('.env', 'utf-8');
const env = {};
envFile.split('\n').forEach(line => {
  if (line.includes('=')) {
    const [key, val] = line.split('=');
    env[key.trim()] = val.trim();
  }
});

const supabase = createClient(env['VITE_SUPABASE_URL'], env['VITE_SUPABASE_ANON_KEY']);

async function test() {
    
    // Test get_participante_seguro
    const { data: rpc1, error: err1 } = await supabase.rpc('get_participante_seguro', { p_token: part.token_invitacion });
    console.log('get_participante_seguro error:', err1);
    console.log('get_participante_seguro result:', JSON.stringify(rpc1, null, 2));
  } else {
    console.log('No confirmed participant found for this encounter');
  }
}
test().catch(console.error);
