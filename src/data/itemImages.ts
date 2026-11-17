// Which image each item ships with (SPEC §13 Step 3). Pure: the file size lookup is injected, so the
// Vite plugin (vite.config.ts) passes fs and tests pass a fake.
import type { Item } from './types';

/**
 * No size cap by default: the build resizes every chosen image to a small WebP icon
 * (scripts/lib/itemImageCache.ts), so even the 4096 px / ~1 MB source files ship as a few KB.
 * `maxBytes` stays available for callers that bundle originals.
 */

export interface ImagePick {
  /** Item key → chosen package-relative image path. */
  byKey: Map<string, string>;
  /** Items with candidates that were all missing (or over maxBytes, if given): shown name only. */
  skipped: { key: string; name: string; reason: 'missing' | 'too large' }[];
}

/** For each item, the first candidate image that exists (size ≥ 0) and is ≤ maxBytes. */
export function pickItemImages(items: Iterable<Item>, sizeOf: (path: string) => number | undefined, maxBytes = Infinity): ImagePick {
  const byKey = new Map<string, string>();
  const skipped: ImagePick['skipped'] = [];
  for (const item of items) {
    const cands = item.images ?? [];
    if (!cands.length) continue;
    let anyExists = false;
    const pick = cands.find((p) => {
      const s = sizeOf(p);
      if (s === undefined) return false;
      anyExists = true;
      return s <= maxBytes;
    });
    if (pick) byKey.set(item.key, pick);
    else skipped.push({ key: item.key, name: item.name, reason: anyExists ? 'too large' : 'missing' });
  }
  return { byKey, skipped };
}

/**
 * Source of the `virtual:item-images` module: item key → URL, one import per distinct file. `extraUrls` (item key →
 * URL of a public/item-images-extra/ file, already a small icon) are added as plain URLs.
 */
export function itemImagesModule(byKey: Map<string, string>, specifier: (path: string) => string, extraUrls: Map<string, string> = new Map()): string {
  const paths = [...new Set(byKey.values())].sort();
  const varOf = new Map(paths.map((p, i) => [p, `u${i}`]));
  const imports = paths.map((p) => `import ${varOf.get(p)} from ${JSON.stringify(specifier(p))};`);
  const all: [string, string][] = [...[...byKey].map(([k, p]): [string, string] => [k, varOf.get(p)!]), ...[...extraUrls].filter(([k]) => !byKey.has(k)).map(([k, u]): [string, string] => [k, JSON.stringify(u)])];
  const entries = all.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `  ${JSON.stringify(k)}: ${v},`);
  return `${imports.join('\n')}\nexport default {\n${entries.join('\n')}\n};\n`;
}

/**
 * Items clash-of-clans-data has no picture for, with one saved by `npm run sync` / the data-update Action in
 * public/item-images-extra/ (SPEC §13): item key → file name. clash-of-clans-data's image always wins
 * (`cocKeys`), so a saved image is only used until the package ships one. `sources` is the parsed
 * sources.json (anything malformed is ignored); `exists` checks the file is really there.
 */
export function extraImageFiles(items: Iterable<Item>, cocKeys: Set<string>, sources: unknown, exists: (file: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const images = (sources as { images?: Record<string, { file?: unknown }> } | null)?.images;
  if (!images || typeof images !== 'object') return out;
  for (const item of items) {
    if (cocKeys.has(item.key)) continue;
    const file = images[item.key]?.file;
    if (typeof file === 'string' && /^[a-z0-9][a-z0-9-]*\.webp$/.test(file) && exists(file)) out.set(item.key, file);
  }
  return out;
}
