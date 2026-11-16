import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import { ensureIcons, ICON_PX } from './scripts/lib/itemImageCache.ts';
import { itemImagesModule, pickItemImages } from './src/data/itemImages.ts';
import { loadGameDataFresh, PKG_DIR, PROJECT_ROOT } from './src/data/loadNode.ts';

// GitHub Pages serves the site from https://<user>.github.io/Hibiscus-clash-advisor/ (SPEC §15).
// Only `npm run build:pages` (vite build --mode pages) uses that base; `npm run dev`, `npm run build`
// and tests stay at '/'. Runtime fetches use import.meta.env.BASE_URL so both work.
export const PAGES_BASE = '/Hibiscus-clash-advisor/';

const IMAGES_ID = 'virtual:item-images';
const RESOLVED_IMAGES_ID = '\0' + IMAGES_ID;
/** Resized icons (git-ignored; cached between builds, and between CI runs by actions/cache). */
export const ICON_CACHE_DIR = '.cache/item-images';

/** Size of a package file in bytes, or undefined when it doesn't exist. */
const pkgFileSize = (p: string) => {
  try {
    return fs.statSync(path.join(PKG_DIR, p)).size;
  } catch {
    return undefined;
  }
};

/**
 * Item images (SPEC §13 Step 3): `virtual:item-images` exports { [itemKey]: url } with one image per
 * normalized item (the first of Item.images that exists), so only those are bundled, not the package's
 * images/ folder.
 * - `vite build`: each image is resized to ICON_PX² WebP with sharp, cached in .cache/item-images/ by a hash
 *   of its bytes (unchanged images are never reprocessed), and the small icon is what ships.
 * - dev server and tests: the original package files (no sharp needed).
 * An item without a usable image (none in the data, or a resize failure) is left out: name only.
 */
export function itemImagesPlugin(): Plugin {
  let command: 'build' | 'serve' = 'serve';
  return {
    name: 'item-images',
    configResolved(c) {
      command = c.command;
    },
    resolveId(id) {
      return id === IMAGES_ID ? RESOLVED_IMAGES_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_IMAGES_ID) return undefined;
      const { byKey } = pickItemImages(loadGameDataFresh().items.values(), pkgFileSize);
      if (command !== 'build') return itemImagesModule(byKey, (p) => `clash-of-clans-data/${p}`);

      const t0 = Date.now();
      const res = await ensureIcons([...byKey.values()], { srcDir: PKG_DIR, cacheDir: path.join(PROJECT_ROOT, ICON_CACHE_DIR) });
      for (const f of res.failed) this.warn(`item image ${f.path} could not be resized (${f.error}); that item shows its name only`);
      for (const [key, p] of byKey) if (!res.icons.has(p)) byKey.delete(key);
      this.info?.(
        `${res.icons.size} icons at ${ICON_PX}px: ${res.resized} resized, ${res.fromCache} from cache${res.pruned ? `, ${res.pruned} stale removed` : ''} (${Date.now() - t0} ms)`,
      );
      return itemImagesModule(byKey, (p) => `/${ICON_CACHE_DIR}/${path.basename(res.icons.get(p)!)}`);
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: mode === 'pages' ? PAGES_BASE : '/',
  server: { port: 5173 },
  plugins: [itemImagesPlugin()],
  build: {
    chunkSizeWarningLimit: 2000,
    // Item icons stay separate files (lazy-loaded) instead of being inlined into the JS bundle as base64.
    assetsInlineLimit: (file: string) => (file.includes('clash-of-clans-data') || file.includes('item-images') ? false : undefined),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
}));
