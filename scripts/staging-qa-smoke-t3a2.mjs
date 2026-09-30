import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await server.ssrLoadModule('./scripts/staging-qa-smoke-t3a2.ts');
} finally {
  await server.close();
}
