import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // The molecular viewer is a lazy chunk; keep React in its own cacheable chunk.
        manualChunks: (id) => (id.includes('node_modules/react') || id.includes('node_modules/scheduler') ? 'react' : id.includes('3dmol') ? 'viewer' : undefined),
      },
    },
  },
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } } },
});
