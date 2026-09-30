import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await server.ssrLoadModule('./scripts/test-fase-20c1-trust-backend.ts');
} finally {
  await server.close();
}
