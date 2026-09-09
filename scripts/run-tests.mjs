import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await server.ssrLoadModule('./scripts/test-domain.ts');
  console.log('✅ Domain tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-benchmark.ts');
  console.log('✅ Benchmark harness tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-fallback.ts');
  console.log('✅ Runtime fallback tests executed successfully via Vite SSR loader.');

  await server.ssrLoadModule('./scripts/test-postgres-concurrency.ts');
  console.log('✅ PostgreSQL durable rate-limit & concurrency tests executed successfully via Vite SSR loader.');
} catch (err) {
  console.error('❌ Test failed:', err);
  process.exit(1);
} finally {
  await server.close();
}
