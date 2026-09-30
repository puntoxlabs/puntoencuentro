import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await server.ssrLoadModule('./scripts/staging-qa-smoke-t4b1.ts');
} finally {
  await server.close();
}
