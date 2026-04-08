import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3901,
    proxy: {
      '/api': 'http://localhost:3900',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
