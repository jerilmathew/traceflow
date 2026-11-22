import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.TRACEFLOW_API_URL ?? 'http://127.0.0.1:4400';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5180),
    strictPort: true,
    // Same-origin in development: the browser only ever talks to Vite.
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  preview: { host: '127.0.0.1', port: 5180, proxy: { '/api': apiTarget } },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: (id: string) =>
          id.includes('recharts') || id.includes('d3-')
            ? 'charts'
            : id.includes('@xyflow')
              ? 'flow'
              : undefined,
      },
    },
  },
});
