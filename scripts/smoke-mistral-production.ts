import { MistralProvider } from '../supabase/functions/ai-interpret/providers/mistral.ts';
import { SYSTEM_PROMPT } from '../supabase/functions/ai-interpret/prompt.ts';
import { ENCOUNTER_DRAFT_PATCH_SCHEMA } from '../supabase/functions/ai-interpret/validation.ts';
import { mergeDraftPatch } from '../src/lib/draftMerger.ts';
import { createEmptyEncounterDraft, createDefaultInvitationConfig } from '../src/lib/encounterDraft.ts';

const apiKey = process.env.MISTRAL_API_KEY;

if (!apiKey || !apiKey.trim()) {
  console.error('CRITICAL: MISTRAL_API_KEY is not defined in process.env.');
  console.error('Set it in the environment via: $env:MISTRAL_API_KEY="..."');
  process.exit(1);
}

const cases = [
  { id: 1, input: 'Cena en familia hoy a las 21' },
  { id: 2, input: 'Reunión mañana a las 10' },
  { id: 3, input: 'Cena por Zoom con la familia' },
  { id: 4, input: 'Cena en restaurante https://restaurante.com' },
  { id: 5, input: 'El viernes a las 9' },
];

async function runSmoke() {
  console.log('===============================================================');
  console.log('MISTRAL PRODUCTION ADAPTER SMOKE TEST (5 CASES)');
  console.log('Provider: Mistral AI | Model: ministral-8b-2512');
  console.log('Source: process.env.MISTRAL_API_KEY (strictly verified)');
  console.log('===============================================================\n');

  const provider = new MistralProvider(apiKey!, 'ministral-8b-2512');
  const results = [];

  for (const c of cases) {
    console.log(`\n--- Case ${c.id}: "${c.input}" ---`);
    const start = Date.now();
    try {
      const result = await provider.interpret({
        message: c.input,
        systemPrompt: SYSTEM_PROMPT,
        jsonSchema: ENCOUNTER_DRAFT_PATCH_SCHEMA,
      });
      const latency = Date.now() - start;

      const patch = result.patch as any;
      const emptyDraft = createEmptyEncounterDraft();
      const emptyConfig = createDefaultInvitationConfig();
      const { draft } = mergeDraftPatch(emptyDraft, emptyConfig, patch);

      const caseReport = {
        caseId: c.id,
        input: c.input,
        status: 200,
        latencyMs: latency,
        modality: patch.modality?.value ?? null,
        dateIntent: patch.dateIntent?.value ?? null,
        timeIntent: patch.timeIntent?.value ?? null,
        locationText: patch.locationText?.value ?? null,
        virtualLink: patch.virtualLink?.value ?? null,
        patch,
        mergedDraft: {
          title: draft.title,
          date: draft.date,
          time: draft.time,
          modality: draft.modality,
          locationText: draft.locationText,
          virtualLink: draft.virtualLink,
        },
      };

      console.log(`HTTP Status: 200 OK | Latency: ${latency}ms`);
      console.log(`Modality: ${caseReport.modality}`);
      console.log(`DateIntent: ${JSON.stringify(caseReport.dateIntent)}`);
      console.log(`TimeIntent: ${JSON.stringify(caseReport.timeIntent)}`);
      console.log(`LocationText: ${caseReport.locationText}`);
      console.log(`VirtualLink: ${caseReport.virtualLink}`);
      console.log(`Merged Draft:`, JSON.stringify(caseReport.mergedDraft, null, 2));

      results.push(caseReport);
    } catch (err: any) {
      const latency = Date.now() - start;
      console.error(`ERROR: ${err.message} (${latency}ms)`);
      results.push({
        caseId: c.id,
        input: c.input,
        status: err.httpStatus || 500,
        error: err.message,
        latencyMs: latency,
      });
    }
  }

  console.log('\n===============================================================');
  console.log('SUMMARY JSON OUTPUT:');
  console.log(JSON.stringify(results, null, 2));
  console.log('===============================================================');
}

runSmoke().catch((err) => {
  console.error('Fatal error running smoke tests:', err);
  process.exit(1);
});
