import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import { ensureIcons, ICON_PX } from './scripts/lib/itemImageCache.ts';
import { extraImageFiles, itemImagesModule, pickItemImages } from './src/data/itemImages.ts';
import { loadGameDataFresh, PKG_DIR, PROJECT_ROOT } from './src/data/loadNode.ts';

// GitHub Pages serves the site from https://<user>.github.io/Hibiscus-clash-advisor/ (SPEC §15).
// Only `npm run build:pages` (vite build --mode pages) uses that base; `npm run dev`, `npm run build`
// and tests stay at '/'. Runtime fetches use import.meta.env.BASE_URL so both work.
export const PAGES_BASE = '/Hibiscus-clash-advisor/';

const IMAGES_ID = 'virtual:item-images';
const RESOLVED_IMAGES_ID = '\0' + IMAGES_ID;
/** Resized icons (git-ignored; cached between builds, and between CI runs by actions/cache). */
export const ICON_CACHE_DIR = '.cache/item-images';
/** Icons for items clash-of-clans-data has no picture for, saved by npm run sync / the data-update Action (committed). */
export const EXTRA_IMAGES_PUBLIC = 'item-images-extra';

/**
 * public/item-images-extra/: item key → file, for items without a clash-of-clans-data image (`cocKeys`). They're
 * already 96 px WebP icons, served from public/ as they are (no resize, no import).
 */
function extraImages(items: Iterable<import('./src/data/types.ts').Item>, cocKeys: Set<string>): Map<string, string> {
  const dir = path.join(PROJECT_ROOT, 'public', EXTRA_IMAGES_PUBLIC);
  let sources: unknown;
  try {
    sources = JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8'));
  } catch {
    return new Map();
  }
  return extraImageFiles(items, cocKeys, sources, (file) => fs.existsSync(path.join(dir, file)));
}

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
 * - items clash-of-clans-data has no picture for: the icon saved in public/item-images-extra/ (SPEC §13), if any.
 * An item without a usable image (none in the data, or a resize failure) is left out: name only.
 */
export function itemImagesPlugin(): Plugin {
  let command: 'build' | 'serve' = 'serve';
  let base = '/';
  return {
    name: 'item-images',
    configResolved(c) {
      command = c.command;
      base = c.base;
    },
    resolveId(id) {
      return id === IMAGES_ID ? RESOLVED_IMAGES_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_IMAGES_ID) return undefined;
      const items = [...loadGameDataFresh().items.values()];
      const { byKey } = pickItemImages(items, pkgFileSize);
      const extraUrls = (cocKeys: Set<string>) =>
        new Map([...extraImages(items, cocKeys)].map(([k, file]) => [k, `${base}${EXTRA_IMAGES_PUBLIC}/${file}`]));
      if (command !== 'build') return itemImagesModule(byKey, (p) => `clash-of-clans-data/${p}`, extraUrls(new Set(byKey.keys())));

      const t0 = Date.now();
      const res = await ensureIcons([...byKey.values()], { srcDir: PKG_DIR, cacheDir: path.join(PROJECT_ROOT, ICON_CACHE_DIR) });
      for (const f of res.failed) this.warn(`item image ${f.path} could not be resized (${f.error}); that item shows its name only`);
      // Keys clash-of-clans-data has a picture for (even one that failed to resize) never fall back to an extra icon.
      const cocKeys = new Set(byKey.keys());
      for (const [key, p] of byKey) if (!res.icons.has(p)) byKey.delete(key);
      const extra = extraUrls(cocKeys);
      this.info?.(
        `${res.icons.size} icons at ${ICON_PX}px: ${res.resized} resized, ${res.fromCache} from cache${res.pruned ? `, ${res.pruned} stale removed` : ''}; ${extra.size} from public/${EXTRA_IMAGES_PUBLIC} (${Date.now() - t0} ms)`,
      );
      return itemImagesModule(byKey, (p) => `/${ICON_CACHE_DIR}/${path.basename(res.icons.get(p)!)}`, extra);
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
