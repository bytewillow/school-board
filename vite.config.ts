import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const backend = process.env.BACKEND || 'http://127.0.0.1:8765';

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true, target: 'es2020' },
  server: {
    fs: { allow: ['..'] },
    proxy: Object.fromEntries(['/api', '/app-api', '/uploads', '/health'].map((p) => [p, backend])),
  },
  plugins: [
    preact(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: false,
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'], rollupFormat: 'iife' },
      devOptions: { enabled: false },
    }),
  ],
});
