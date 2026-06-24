import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served under /app in production (Express serves dashboard/dist at /app).
// In dev, Vite proxies /api to the local Remi backend.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
