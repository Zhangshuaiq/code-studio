import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ['@codegen/code-intelligence/editor-appearance.cjs'] },
  build: { commonjsOptions: { include: [/node_modules/, /editor-appearance\.cjs$/] } },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
