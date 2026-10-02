import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await server.ssrLoadModule('./scripts/test-local-first-mar-del-plata.ts');
} finally {
  await server.close();
}
