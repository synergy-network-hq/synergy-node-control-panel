import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { getRendererPortFromEnv } from './scripts/electron/dev-port.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  resolve: {
    alias: {
      '@': root,
    }
  },
  server: {
    host: '127.0.0.1',
    port: getRendererPortFromEnv(),
    strictPort: true,
    watch: {
      ignored: ['**/control-service/**']
    }
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: false
  }
});
