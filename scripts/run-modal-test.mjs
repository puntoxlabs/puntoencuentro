import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await server.ssrLoadModule('./scripts/test-critical-cancellation-modal-ux.tsx');
  console.log('✅ All CriticalCancellationModal UX tests passed successfully.');
} catch (err) {
  console.error('❌ Test execution error:', err);
  process.exitCode = 1;
} finally {
  await server.close();
}
