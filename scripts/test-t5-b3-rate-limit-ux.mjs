import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await server.ssrLoadModule('./scripts/test-t5-b3-rate-limit-ux.ts');
} finally {
  await server.close();
}
