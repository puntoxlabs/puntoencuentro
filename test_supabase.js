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
  // Get an encounter
  const { data: encs } = await supabase.from('encuentros').select('*').eq('modalidad', 'virtual').not('link_virtual', 'is', null).limit(1);
  if (!encs || encs.length === 0) return console.log('No virtual encounter');
  const enc = encs[0];
  console.log('Encounter:', enc.id, 'link_virtual:', enc.link_virtual);

  // Get a confirmed participant for this encounter
  const { data: parts } = await supabase.from('participantes').select('*').eq('encuentro_id', enc.id).eq('estado', 'confirmado').limit(1);
  if (parts && parts.length > 0) {
    const part = parts[0];
    console.log('Participant token:', part.token_invitacion);
    
    // Test get_participante_seguro
    const { data: rpc1, error: err1 } = await supabase.rpc('get_participante_seguro', { p_token: part.token_invitacion });
    console.log('get_participante_seguro error:', err1);
    console.log('get_participante_seguro result:', JSON.stringify(rpc1, null, 2));
  } else {
    console.log('No confirmed participant found for this encounter');
  }
}
test().catch(console.error);
