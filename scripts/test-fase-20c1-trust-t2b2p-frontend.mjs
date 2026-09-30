import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await server.ssrLoadModule('./scripts/test-fase-20c1-trust-t2b2p-frontend.ts');
} finally {
  await server.close();
}
