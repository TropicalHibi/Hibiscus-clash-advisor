// Images for items clash-of-clans-data has no picture for yet (SPEC §13 "Item images", §9b). Run by
// `npm run sync` and the daily data-update Action, never in the browser. For each such item, in order:
//   1. ClashKing's asset host (assets.clashk.ing): its manifest.json lists every file with a sha256;
//   2. the Clash of Clans Fandom wiki, through its MediaWiki API (the item's level / info image by name,
//      then the page's lead image), parsed defensively;
//   3. nothing: the item shows its name only.
// A found image is resized with the build's sharp step (96×96 WebP) and saved in public/item-images-extra/
// (committed), with its source recorded in sources.json. A saved image is never downloaded again, and an
// item that clash-of-clans-data has a picture for is never looked up (the build prefers that one).
// Network, resizing and the clock are injected: tests use fakes, never the network.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pickItemImages } from '../../src/data/itemImages';
import type { GameData, Item } from '../../src/data/types';

export const EXTRA_IMAGES_DIR = 'public/item-images-extra';
export const SOURCES_FILE = 'sources.json';
export const CK_ASSETS = 'https://assets.clashk.ing';
export const FANDOM_API = 'https://clashofclans.fandom.com/api.php';
/** Hosts an image may be downloaded from (Fandom serves its files from its CDN). */
const ALLOWED_HOSTS = new Set(['assets.clashk.ing', 'static.wikia.nocookie.net']);
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageSource = 'clashking' | 'fandom';

export interface ExtraImageRecord {
  /** Item name when it was saved (for people reading the file). */
  name: string;
  /** File name inside public/item-images-extra/. */
  file: string;
  source: ImageSource;
  /** Where the original came from. */
  url: string;
  /** sha256 of the downloaded original. */
  sha256: string;
  fetchedAt: string;
}

/** public/item-images-extra/sources.json: item key → record. */
export interface ExtraSources {
  images: Record<string, ExtraImageRecord>;
}

export interface ExtraImageDeps {
  /** GET + JSON. Throws on a network error or a non-2xx status. */
  fetchJson(url: string): Promise<unknown>;
  /** GET bytes (≤ MAX_IMAGE_BYTES). Throws on a network error, a non-2xx status or a larger file. */
  fetchBytes(url: string): Promise<Buffer>;
  /** The build's icon resize (96×96 WebP). Throws when the bytes aren't an image. */
  resize(src: Buffer): Promise<Buffer>;
  /** Absolute path of public/item-images-extra/. */
  dir: string;
  now(): Date;
  log(line: string): void;
}

export interface ExtraImagesResult {
  /** Images saved by this run. */
  added: { key: string; record: ExtraImageRecord }[];
  /** Items that already had a saved image (not downloaded again). */
  kept: number;
  /** Items no source had a picture for (name only). */
  missing: { key: string; name: string; why: string }[];
  /** Source-level problems (a host down, a bad manifest): never a failure. */
  warnings: string[];
}

// ── Which items need one ──

/**
 * Items shown in the site with no clash-of-clans-data image: base items (no supercharges / modules / weapons)
 * that aren't seasonal (never shown). `hasCocImage` is the build's own pick, so "prefer clash-of-clans-data"
 * means the same thing here and in the build.
 */
export function itemsNeedingImages(data: GameData, hasCocImage: (key: string) => boolean): Item[] {
  return [...data.items.values()].filter((i) => i.key === String(i.dataId) && !i.seasonal && !hasCocImage(i.key)).sort((a, b) => a.dataId - b.dataId);
}

// ── sources.json ──

export function readSources(dir: string): ExtraSources {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, SOURCES_FILE), 'utf8')) as Partial<ExtraSources>;
    const images: ExtraSources['images'] = {};
    for (const [k, r] of Object.entries(j?.images ?? {}))
      if (r && typeof r.file === 'string' && SAFE_FILE.test(r.file) && (r.source === 'clashking' || r.source === 'fandom')) images[k] = r as ExtraImageRecord;
    return { images };
  } catch {
    return { images: {} };
  }
}

const SAFE_FILE = /^[a-z0-9][a-z0-9-]*\.webp$/;

function writeSources(dir: string, s: ExtraSources): void {
  const images = Object.fromEntries(Object.entries(s.images).sort(([a], [b]) => Number(a) - Number(b) || (a < b ? -1 : 1)));
  fs.writeFileSync(path.join(dir, SOURCES_FILE), JSON.stringify({ images }, null, 2) + '\n');
}

// ── ClashKing assets ──

/** Letters and digits only: "Builder's Hut" and "builder's_hut", "P.E.K.K.A Titan Squad" and "pekka_titan_squad" match. */
export const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface CkAsset {
  path: string;
  sha?: string;
}

/** manifest.json → its assets; throws when it doesn't look like the manifest (no `assets` lists). */
export function parseCkManifest(j: unknown): CkAsset[] {
  const assets = (j as { assets?: unknown } | null)?.assets;
  if (!assets || typeof assets !== 'object') throw new Error('manifest.json has no "assets"');
  const out: CkAsset[] = [];
  for (const list of Object.values(assets as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      const p = (a as { path?: unknown })?.path;
      if (typeof p !== 'string' || !/^[A-Za-z0-9_'.\-/]+\.webp$/.test(p) || p.includes('..')) continue;
      const sha = (a as { sha?: unknown }).sha;
      out.push({ path: p, ...(typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha) ? { sha } : {}) });
    }
  }
  if (!out.length) throw new Error('manifest.json lists no images');
  return out;
}

const BUILDING_LIKE = new Set(['townHall', 'defense', 'mergedDefense', 'army', 'resourceStorage', 'resourceCollector', 'wall', 'other']);
const ICON_FOLDER: Partial<Record<Item['category'], string>> = { troop: 'troops', siege: 'troops', hero: 'heroes', pet: 'pets', guardian: 'guardians' };
const FLAT_FOLDER: Partial<Record<Item['category'], string>> = { spell: 'spells', equipment: 'equipment', helper: 'helpers' };

/** The item's ClashKing asset, best first: a building's level image (its top level, else the highest), a unit's icon. */
export function ckAssetFor(item: Item, assets: CkAsset[]): CkAsset | undefined {
  const key = nameKey(item.name);
  if (BUILDING_LIKE.has(item.category) || item.category === 'trap') {
    const prefix = item.category === 'trap' ? 'traps/home-village/' : 'buildings/home-village/';
    const top = item.levels.length ? item.levels[item.levels.length - 1].level : Infinity;
    let best: { a: CkAsset; level: number } | undefined;
    for (const a of assets) {
      if (!a.path.startsWith(prefix)) continue;
      const m = /^([^/]+)\/level_(\d+)\.webp$/.exec(a.path.slice(prefix.length));
      if (!m || nameKey(m[1]) !== key) continue;
      const level = Number(m[2]);
      const rank = (l: number) => (l <= top ? l : -l); // levels the item has beat levels it doesn't
      if (!best || rank(level) > rank(best.level)) best = { a, level };
    }
    return best?.a;
  }
  const icon = ICON_FOLDER[item.category];
  if (icon) return assets.find((a) => a.path.startsWith(`${icon}/`) && a.path.endsWith('/icon.webp') && nameKey(a.path.split('/')[1]) === key);
  const flat = FLAT_FOLDER[item.category];
  if (flat) return assets.find((a) => a.path.split('/').length === 2 && a.path.startsWith(`${flat}/`) && nameKey(a.path.slice(flat.length + 1, -5)) === key);
  return undefined;
}

export const ckAssetUrl = (p: string) => `${CK_ASSETS}/${p.split('/').map(encodeURIComponent).join('/')}`;

// ── Fandom (MediaWiki API) ──

/** File titles to try, best first: a building's level image ("Spiky Tower2.png"), a unit's info / avatar image. */
export function fandomFileTitles(item: Item): string[] {
  const n = item.name;
  if (BUILDING_LIKE.has(item.category) || item.category === 'trap') {
    const levels = item.levels.map((l) => l.level);
    const top = levels.length ? Math.max(...levels) : undefined;
    return [...new Set([...(top ? [`File:${n}${top}.png`] : []), `File:${n}1.png`, `File:${n}.png`])];
  }
  return [`File:${n} info.png`, `File:Avatar ${n}.png`, `File:${n}.png`];
}

const fandomQuery = (params: Record<string, string>) =>
  `${FANDOM_API}?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params }).toString()}`;

/** MediaWiki `query.pages` as a list (formatversion 2 gives a list, 1 an object). */
function pagesOf(j: unknown): Record<string, unknown>[] {
  const pages = (j as { query?: { pages?: unknown } } | null)?.query?.pages;
  const list = Array.isArray(pages) ? pages : pages && typeof pages === 'object' ? Object.values(pages) : [];
  return list.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object');
}

/** requested title → normalized title (the API renames "File:A_B.png" to "File:A B.png"). */
function normalizedOf(j: unknown): Map<string, string> {
  const m = new Map<string, string>();
  const list = (j as { query?: { normalized?: unknown } } | null)?.query?.normalized;
  if (Array.isArray(list)) for (const n of list) if (typeof n?.from === 'string' && typeof n?.to === 'string') m.set(n.from, n.to);
  return m;
}

const okImageUrl = (u: unknown): u is string => {
  if (typeof u !== 'string') return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
};

/** The first of `titles` that exists on the wiki as an image, from one imageinfo response. */
export function pickFandomFile(j: unknown, titles: string[]): string | undefined {
  const norm = normalizedOf(j);
  const byTitle = new Map(pagesOf(j).map((p) => [String(p.title), p]));
  for (const t of titles) {
    const p = byTitle.get(norm.get(t) ?? t);
    if (!p || p.missing !== undefined || p.invalid !== undefined) continue;
    const info = Array.isArray(p.imageinfo) ? (p.imageinfo[0] as Record<string, unknown> | undefined) : undefined;
    if (!info || !okImageUrl(info.url)) continue;
    if (typeof info.mime === 'string' && !info.mime.startsWith('image/')) continue;
    if (typeof info.size === 'number' && info.size > MAX_IMAGE_BYTES) continue;
    return info.url;
  }
  return undefined;
}

/** The page's lead image (pageimages `original`), from one response. */
export function pickFandomPageImage(j: unknown): string | undefined {
  for (const p of pagesOf(j)) {
    if (p.missing !== undefined) continue;
    const src = (p.original as { source?: unknown } | undefined)?.source;
    if (okImageUrl(src)) return src;
  }
  return undefined;
}

// ── The run ──

/**
 * Looks up and saves an image for each of `items` that has none saved yet. Never throws for a source problem
 * (a host down, a bad response): that item falls through to the next source, then to name only.
 */
export async function syncExtraImages(items: Item[], d: ExtraImageDeps): Promise<ExtraImagesResult> {
  fs.mkdirSync(d.dir, { recursive: true });
  const sources = readSources(d.dir);
  const res: ExtraImagesResult = { added: [], kept: 0, missing: [], warnings: [] };
  let manifest: CkAsset[] | null | undefined; // undefined = not fetched yet, null = unavailable

  const save = async (item: Item, url: string, source: ImageSource, sha?: string): Promise<boolean> => {
    if (!okImageUrl(url)) throw new Error(`refusing to download from ${url}`);
    const src = await d.fetchBytes(url);
    const sum = createHash('sha256').update(src).digest('hex');
    if (sha && sha !== sum) throw new Error(`sha256 mismatch for ${url}`);
    const icon = await d.resize(src);
    const file = `${SAFE_FILE.test(`${item.id}.webp`) ? item.id : `item-${item.dataId}`}.webp`;
    const out = path.join(d.dir, file);
    fs.writeFileSync(`${out}.tmp`, icon);
    fs.renameSync(`${out}.tmp`, out);
    const record: ExtraImageRecord = { name: item.name, file, source, url, sha256: sum, fetchedAt: d.now().toISOString() };
    sources.images[item.key] = record;
    res.added.push({ key: item.key, record });
    d.log(`  ${item.name}: ${source === 'clashking' ? 'ClashKing assets' : 'Fandom wiki'} (${url})`);
    return true;
  };

  for (const item of items) {
    const have = sources.images[item.key];
    if (have && fs.existsSync(path.join(d.dir, have.file))) {
      res.kept++;
      continue;
    }
    const why: string[] = [];

    // 1. ClashKing assets
    if (manifest === undefined) {
      try {
        manifest = parseCkManifest(await d.fetchJson(`${CK_ASSETS}/manifest.json`));
      } catch (e) {
        manifest = null;
        res.warnings.push(`ClashKing assets unavailable (${(e as Error).message}); trying the Fandom wiki only.`);
      }
    }
    if (manifest) {
      const a = ckAssetFor(item, manifest);
      if (!a) why.push('ClashKing: not listed');
      else {
        try {
          if (await save(item, ckAssetUrl(a.path), 'clashking', a.sha)) continue;
        } catch (e) {
          why.push(`ClashKing: ${(e as Error).message}`);
        }
      }
    }

    // 2. Fandom: the item's level / info image by name, then the page's lead image
    try {
      const titles = fandomFileTitles(item);
      const info = await d.fetchJson(fandomQuery({ titles: titles.join('|'), prop: 'imageinfo', iiprop: 'url|size|mime' }));
      let url = pickFandomFile(info, titles);
      if (!url) {
        const page = await d.fetchJson(fandomQuery({ titles: item.name, prop: 'pageimages', piprop: 'original', redirects: '1' }));
        url = pickFandomPageImage(page);
      }
      if (url && (await save(item, url, 'fandom'))) continue;
      why.push('Fandom: no image');
    } catch (e) {
      why.push(`Fandom: ${(e as Error).message}`);
    }

    res.missing.push({ key: item.key, name: item.name, why: why.join('; ') });
    d.log(`  ${item.name}: no image found (${why.join('; ')}); shows its name only`);
  }
  if (res.added.length) writeSources(d.dir, sources);
  return res;
}

/** Commit-message part / summary line, e.g. "3 new item images (Spiky Tower, Squad Barracks, …)". */
export function imagesLine(added: ExtraImagesResult['added'], max = 4): string {
  const names = added.map((a) => a.record.name);
  const list = names.length > max ? `${names.slice(0, max).join(', ')}, …` : names.join(', ');
  return `${added.length} new item image${added.length === 1 ? '' : 's'} (${list})`;
}

// ── Node wiring ──

const UA = 'clash-advisor-image-sync/1.0';

async function get(url: string, accept: string): Promise<Response> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(30_000), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

/** Real network (global fetch, 30 s timeouts) and the build's sharp resize. */
export async function nodeExtraImageDeps(root: string, log: (l: string) => void = console.log): Promise<ExtraImageDeps> {
  const { sharpResize } = await import('./itemImageCache');
  return {
    fetchJson: async (url) => (await get(url, 'application/json')).json(),
    fetchBytes: async (url) => {
      const r = await get(url, 'image/*');
      if (Number(r.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) throw new Error('image too large');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large');
      return buf;
    },
    resize: sharpResize,
    dir: path.join(root, EXTRA_IMAGES_DIR),
    now: () => new Date(),
    log,
  };
}

/**
 * The sync / Action step: items without a clash-of-clans-data image (the build's own pick, `pkgDir` =
 * node_modules/clash-of-clans-data), then `syncExtraImages`. Logs a section; never throws for a source problem.
 */
export async function runExtraImages(data: GameData, d: ExtraImageDeps, pkgDir: string): Promise<ExtraImagesResult> {
  const sizeOf = (p: string) => {
    try {
      return fs.statSync(path.join(pkgDir, p)).size;
    } catch {
      return undefined;
    }
  };
  const { byKey } = pickItemImages(data.items.values(), sizeOf);
  const items = itemsNeedingImages(data, (k) => byKey.has(k));
  d.log(`— Item images for new items (${items.length} without a clash-of-clans-data picture) —`);
  const r = await syncExtraImages(items, d);
  for (const w of r.warnings) d.log(`  [WARN] ${w}`);
  d.log(`  ${r.added.length} saved, ${r.kept} already saved, ${r.missing.length} name only`);
  return r;
}

/**
 * The data-update commit message: the data update's own message with the images appended, or an images-only
 * message ("data: 2 new item images (Spiky Tower, Squad Barracks)"). Empty when there's nothing to commit.
 */
export function imagesCommitMessage(dataMessage: string | undefined, added: ExtraImagesResult['added']): string {
  if (!added.length) return dataMessage ?? '';
  return dataMessage ? `${dataMessage}; ${imagesLine(added)}` : `data: ${imagesLine(added)}`;
}
