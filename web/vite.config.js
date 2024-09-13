import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard talks to a Nodechain node. In dev it points at localhost:3000
// (CORS is enabled on the node); a production build is served by the node itself
// from web/dist, so same-origin requests just work.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173 }
});
