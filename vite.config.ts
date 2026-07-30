import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Two renderer entry points: the transparent in-game overlay and the
// full companion window that lives on a second monitor.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        overlay: resolve(import.meta.dirname, 'src/renderer/overlay.html'),
        companion: resolve(import.meta.dirname, 'src/renderer/companion.html'),
      },
    },
  },
  server: { port: 5173, strictPort: true },
});
