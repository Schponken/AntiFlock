import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
  },
  // Rapier ships its wasm inlined by its own loader; keeping it out of the
  // dependency pre-bundle avoids esbuild rewriting that loader.
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
});
