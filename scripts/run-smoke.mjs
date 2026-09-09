import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

try {
  await server.ssrLoadModule('./scripts/smoke-mistral-production.ts');
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  await server.close();
}
