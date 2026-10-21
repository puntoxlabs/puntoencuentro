import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await server.ssrLoadModule('./scripts/setup-telemetry-mock.ts');
  console.log('✅ Telemetry isolation layer loaded.');

  await server.ssrLoadModule('./scripts/test-mini-sprint-b.ts');
  console.log('✅ Mini-sprint B tests executed successfully via Vite SSR loader.');
} catch (error) {
  console.error('❌ Mini-sprint B tests failed:', error);
  process.exit(1);
} finally {
  await server.close();
}
