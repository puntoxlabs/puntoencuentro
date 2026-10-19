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

  await server.ssrLoadModule('./scripts/test-mi-espacio-mobile.ts');
  console.log('✅ Mi espacio Mobile (360px, 390px, 412px, font scaling) tests executed successfully via Vite SSR loader.');

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

  await server.ssrLoadModule('./scripts/test-open-encounters-coexistence-and-requests.ts');
  console.log('✅ Open Encounters coexistence, private location & join requests tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-fase-20c1-trust-generic-rate-limiting.ts');
  console.log('✅ Generic server-side rate limiter tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-fase-20c1-trust-rate-limiting-enforcement.ts');
  console.log('✅ Rate limiting enforcement on core social actions tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-t5-b3-rate-limit-ux.ts');
  console.log('✅ Antiabuse UX and error feedback tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-public-content-moderation.ts');
  console.log('✅ Moderación Pública v1 core, antiabuso & privacy tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-public-content-moderation-ui.ts');
  console.log('✅ Moderación Pública v1 UI & UX tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-intentions-matching.ts');
  console.log('✅ Phase 20D Mis ganas matching & activity relevance tests (27 casos) executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-matching-ver-opciones-ux.ts');
  console.log('✅ Phase 20D Mis ganas UX "Ver opciones" & highlighting tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-open-public-title.ts');
  console.log('✅ Private and public open encounter titles tests (17 casos) executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-quotas-and-multi-seat.ts');
  console.log('✅ Canonical quotas & multi-seat V1 tests (26 casos) executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-discovery-realtime-modal-auth.ts');
  console.log('✅ Discovery V1 Closure: Realtime, Modal Stacking & Anonymous Auth tests (26 casos) executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-participante-aprobado-detalle.ts');
  console.log('✅ Approved Participant Authorized Experience & Privacy tests (7 casos) executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-lifecycle-cancellation-and-quotas.ts');
  console.log('✅ Lifecycle cancellation, deletion guard, strict quotas & host discovery tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-lifecycle-realization-and-inscriptions.ts');
  console.log('✅ Lifecycle realization by minimum, cancellation reason, inscriptions & reconfirmation tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-lifecycle-concurrency-and-hardening.ts');
  console.log('✅ Lifecycle concurrency, invariants, security & discovery filtering hardening tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-web-push-device-settings-and-qa.ts');
  console.log('✅ Web Push device settings UX states, multi-device isolation & QA test action tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-critical-communications-p0.ts');
  console.log('✅ P0 Block 1: Critical Communications & State Integrity tests (H1, H5, H8) executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-open-encounter-withdrawal-h9-h10.ts');
  console.log('✅ H9/H10: Voluntary withdrawal, quotas & participant synchronization tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-open-encounter-h2-h3-concurrency-and-legacy-rpcs.ts');
  console.log('✅ H2/H3: Legacy RPC security, canonical lock hierarchy & concurrency tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-lifecycle-notifications-h4-h6-h7.ts');
  console.log('✅ H4/H6/H7: Cancellation integrity, lifecycle cycle notifications & safe navigation tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-pre-staging-verification-h1-h10.ts');
  console.log('✅ Pre-Staging Verification: H1-H10 Migrations, Notifications Dedup & Safe Navigation tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-schema-parity-guard.ts');
  console.log('✅ Schema Parity Guard: Staging schema compatibility & mock parity tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-microfix-reconfirmation-and-rate-limiting.ts');
  console.log('✅ Post-H1-H10 Microfix: Reconfirmation reset on re-approval & hardened fail-closed rate limiting tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-h2-h3-restored-guards.ts');
  console.log('✅ H2/H3 Restored Guards: Security controls, invariants & concurrency tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-internal-invitations-backend.ts');
  console.log('✅ Internal Invitations V1: Backend, RLS, idempotency & edge cases tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-internal-invitations-frontend.tsx');
  console.log('✅ Internal Invitations V1: Frontend, UI & privacy invariants tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-encounter-templates-backend.ts');
  console.log('✅ Encounter Templates & Repeat V1: Backend, RLS, privacy & isolation tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-encounter-templates-frontend.tsx');
  console.log('✅ Encounter Templates & Repeat V1: Frontend, wizard preload & confirmation invariants tests executed successfully via Vite SSR loader.');


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
