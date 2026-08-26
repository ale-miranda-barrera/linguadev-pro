/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: 'auto',
      workbox: {
        // No cachear API ni data dinámica.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // 250 packs CEFR + 40 AWS + 60+ sims tech = bundle grande. Subimos límite a 16 MB.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[^/]+\/(assets|icons)\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'static' },
          },
        ],
      },
      manifest: {
        name: 'LinguaDev Pro',
        short_name: 'LinguaDev',
        description: 'Aprende inglés con SRS, ruta CEFR y práctica de las 4 habilidades.',
        theme_color: '#7c3aed',
        background_color: '#0b0716',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: { port: 5173, host: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
