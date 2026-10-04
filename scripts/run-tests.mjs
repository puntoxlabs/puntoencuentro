import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await server.ssrLoadModule('./scripts/setup-telemetry-mock.ts');
  console.log('✅ Telemetry isolation layer loaded successfully.');

  await server.ssrLoadModule('./scripts/test-domain.ts');
  console.log('✅ Domain tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-benchmark.ts');
  console.log('✅ Benchmark harness tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-fallback.ts');
  console.log('✅ Runtime fallback tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-postgres-concurrency.ts');
  console.log('✅ PostgreSQL durable rate-limit & concurrency tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-qa-backend.ts');
  console.log('✅ QA backend & security tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-qa-telemetry.ts');
  console.log('✅ QA Telemetry integration tests (A al S) executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-qa-frontend.ts');
  console.log('✅ QA Frontend (Etapa C) behavioral tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-home-integration.ts');
  console.log('✅ New Mobile-First Home integration & component tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-open-encounters.ts');
  console.log('✅ Open Encounters 1.5 backend, security & UI integration tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-coverage-mvp.ts');
  console.log('✅ Dynamic Coverage MVP backend, security & UI tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-notifications-base.ts');
  console.log('✅ Phase 1 Notifications base & inbox/outbox tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-notifications-frontend.ts');
  console.log('✅ Phase 1.5 In-App Notifications UI & frontend tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-alerts-matching.ts');
  console.log('✅ Phase 2A Avisame subscriptions backend & matching tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-avisame-ux.ts');
  console.log('✅ Phase 2B Avisame user experience & open encounter deep link tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-legacy-alerts-consolidation.ts');
  console.log('✅ Legacy alerts consolidation into inbox tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-web-push-foundation.ts');
  console.log('✅ Phase 3A Web Push foundation & PWA tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-web-push-delivery.ts');
  console.log('✅ Phase 3B Web Push delivery pipeline & outbox tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-mobile-avisame-layout.ts');
  console.log('✅ Mobile Avisame UX & Open Encounters layout tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-open-encounters-modality-normalization.ts');
  console.log('✅ Open Encounters modality & public zone normalization tests executed successfully via Vite SSR loader.');

  console.log('\n--- QA TELEMETRY MOCK REPORT ---');
  console.log(`Intercepted QA calls (Mocked): ${globalThis.__QA_TELEMETRY_INTERCEPTED_CALLS || 0}`);
  console.log(`External QA calls blocked (Failsafe): ${globalThis.__QA_TELEMETRY_EXTERNAL_CALLS || 0}`);
  console.log('--------------------------------\n');
} catch (err) {
  console.error('❌ Test failed:', err);
  process.exit(1);
} finally {
  await server.close();
}
