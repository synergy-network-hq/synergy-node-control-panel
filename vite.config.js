import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      '@tauri-apps/api/core': fileURLToPath(new URL('./src/platform/tauri/core.js', import.meta.url)),
      '@tauri-apps/api/tauri': fileURLToPath(new URL('./src/platform/tauri/core.js', import.meta.url)),
      '@tauri-apps/api/app': fileURLToPath(new URL('./src/platform/tauri/app.js', import.meta.url)),
      '@tauri-apps/api/event': fileURLToPath(new URL('./src/platform/tauri/event.js', import.meta.url)),
      '@tauri-apps/api/dialog': fileURLToPath(new URL('./src/platform/tauri/dialog.js', import.meta.url)),
      '@tauri-apps/api/fs': fileURLToPath(new URL('./src/platform/tauri/fs.js', import.meta.url)),
      '@': root,
    }
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: false
  }
});
