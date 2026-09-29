import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await server.ssrLoadModule('./scripts/test-fase-20a-intenciones-conversion-frontend.ts');
} finally {
  await server.close();
}
