import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from https://<user>.github.io/Hibiscus-clash-advisor/ (SPEC §15).
// Only `npm run build:pages` (vite build --mode pages) uses that base; `npm run dev`, `npm run build`
// and tests stay at '/'. Runtime fetches use import.meta.env.BASE_URL so both work.
export const PAGES_BASE = '/Hibiscus-clash-advisor/';

export default defineConfig(({ mode }) => ({
  base: mode === 'pages' ? PAGES_BASE : '/',
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 2000 },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
}));
