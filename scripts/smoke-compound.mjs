import { createClient } from '@supabase/supabase-js';

// Usar endpoint local y anon key local
// Asume que supabase start está corriendo localmente
const supabaseUrl = process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlZmF1bHQiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTY3MjU0MDgwMCwiZXhwIjoxOTg4MTA4ODAwfQ.1';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const TEST_DRAFT = {
  title: 'Cena',
  dateMode: 'coordination',
  dateOptions: [
    { date: '2026-10-10', time: '20:00' }, // viernes
    { date: '2026-10-10', time: '22:00' }, // viernes
    { date: '2026-10-11', time: '21:00' }
  ]
};

async function runTest(label, promptText, provider, model, expectation) {
  console.log('\\n==============================================');
  console.log(`Test: ${label} (${provider} / ${model})`);
  console.log('==============================================');
  
  try {
    const { data, error } = await supabase.functions.invoke('ai-interpret', {
      body: {
        text: promptText,
        draft: TEST_DRAFT,
        messages: [],
        provider: provider,
        model: model
      }
    });
    
    if (error) {
      console.error('Edge Function Error:', error);
      return;
    }
    
    console.log('Response OK!');
    console.log('Actions generated:', JSON.stringify(data.patch?.actions, null, 2));
    
    expectation(data);
    
  } catch (err) {
    console.error('Network / Execution Error:', err);
  }
}

async function main() {
  console.log('Using Supabase URL:', supabaseUrl);
  
  const promptA = 'Cambiá el tema a familiar y el tipo de invitación a individual';
  const expectationA = (data) => {
    const hasTheme = data.patch?.themeHint?.value === 'family';
    const hasInvitationType = data.patch?.invitationTypeHint === 'individual';
    if (hasTheme && hasInvitationType) {
      console.log('✅ Success: Both mutations were understood by the LLM.');
    } else {
      console.log('❌ Failed: Missing expected mutations.');
      console.log('Theme:', data.patch?.themeHint);
      console.log('Invitation Type:', data.patch?.invitationTypeHint);
    }
  };
  
  const promptB = 'Cambiá la segunda opción para el viernes a las 20';
  const expectationB = (data) => {
    const actions = data.patch?.actions;
    if (actions && actions.length > 0 && actions[0].type === 'modify_date_option') {
      const target = actions[0].target;
      const changes = actions[0].changes;
      console.log('✅ Success: Structured action generated.');
      console.log('Target:', target);
      console.log('Changes:', changes);
    } else {
      console.log('❌ Failed: Expected modify_date_option action.');
    }
  };
  
  const promptC = 'eliminá la opción del viernes';
  const expectationC = (data) => {
    const actions = data.patch?.actions;
    if (actions && actions.length > 0 && actions[0].type === 'remove_date_option') {
      const target = actions[0].target;
      console.log('✅ Success: Structured action generated.');
      console.log('Target:', target);
    } else {
      console.log('❌ Failed: Expected remove_date_option action.');
    }
  };

  // Run tests with OpenAI
  await runTest('Test A (2 independent mutations)', promptA, 'openai', 'gpt-5.6-luna', expectationA);
  await runTest('Test B (Modify specific option)', promptB, 'openai', 'gpt-5.6-luna', expectationB);
  await runTest('Test C (Remove ambiguous option)', promptC, 'openai', 'gpt-5.6-luna', expectationC);
  
  // Run tests with Mistral
  await runTest('Test A (Mistral)', promptA, 'mistral', 'ministral-8b-2512', expectationA);
  await runTest('Test B (Mistral)', promptB, 'mistral', 'ministral-8b-2512', expectationB);
  await runTest('Test C (Mistral)', promptC, 'mistral', 'ministral-8b-2512', expectationC);

  console.log('\\nDone.');
}

main();
