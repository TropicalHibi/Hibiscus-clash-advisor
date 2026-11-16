import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import { itemImagesModule, pickItemImages } from './src/data/itemImages';
import { loadGameDataFresh, PKG_DIR } from './src/data/loadNode';

// GitHub Pages serves the site from https://<user>.github.io/Hibiscus-clash-advisor/ (SPEC §15).
// Only `npm run build:pages` (vite build --mode pages) uses that base; `npm run dev`, `npm run build`
// and tests stay at '/'. Runtime fetches use import.meta.env.BASE_URL so both work.
export const PAGES_BASE = '/Hibiscus-clash-advisor/';

const IMAGES_ID = 'virtual:item-images';
const RESOLVED_IMAGES_ID = '\0' + IMAGES_ID;

/** Size of a package file in bytes, or undefined when it doesn't exist. */
const pkgFileSize = (p: string) => {
  try {
    return fs.statSync(path.join(PKG_DIR, p)).size;
  } catch {
    return undefined;
  }
};

/**
 * Item images (SPEC §13 Step 3): `virtual:item-images` imports one image per normalized item (the first
 * of Item.images that exists and is ≤ IMAGE_MAX_BYTES), so the build emits only those files and not the
 * package's whole images/ folder. Exports { [itemKey]: url }. Items with no usable image are left out
 * (the UI then shows the name only).
 */
export function itemImagesPlugin(): Plugin {
  return {
    name: 'item-images',
    resolveId(id) {
      return id === IMAGES_ID ? RESOLVED_IMAGES_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_IMAGES_ID) return undefined;
      const { byKey } = pickItemImages(loadGameDataFresh().items.values(), pkgFileSize);
      return itemImagesModule(byKey, (p) => `clash-of-clans-data/${p}`);
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: mode === 'pages' ? PAGES_BASE : '/',
  server: { port: 5173 },
  plugins: [itemImagesPlugin()],
  build: {
    chunkSizeWarningLimit: 2000,
    // Item images stay separate files (lazy-loaded) instead of being inlined into the JS bundle.
    assetsInlineLimit: (file: string) => (file.includes('clash-of-clans-data') ? false : undefined),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
}));
