import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: '../../node_modules/.vite',
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_PROXY_TARGET || 'http://localhost:3000' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
