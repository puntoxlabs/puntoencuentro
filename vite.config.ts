import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { execSync } from 'child_process'

function getGitCommit(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
  }
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'local';
  }
}

function getAppEnv(): string {
  if (process.env.VITE_APP_ENV) {
    return process.env.VITE_APP_ENV;
  }
  const branch = process.env.VERCEL_GIT_COMMIT_REF;
  if (branch === 'staging') {
    return 'staging';
  }
  if (branch === 'main' || process.env.VERCEL_ENV === 'production') {
    return 'production';
  }
  if (process.env.VERCEL_ENV === 'preview') {
    return 'preview';
  }
  return 'development';
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })),
    __APP_ENV__: JSON.stringify(getAppEnv()),
    __GIT_COMMIT__: JSON.stringify(getGitCommit()),
  }
})
