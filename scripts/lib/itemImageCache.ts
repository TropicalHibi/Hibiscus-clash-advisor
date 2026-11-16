// Build-time icon resizing for `virtual:item-images` (SPEC §13 Step 3). Each referenced package image is
// resized to ICON_PX × ICON_PX WebP (2× the 48 px max display size) with sharp and cached in
// .cache/item-images/, keyed by a hash of the source bytes + the resize settings, so unchanged images are
// never reprocessed. The resizer and file access are injectable so the cache logic is testable without sharp.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ICON_PX = 96;
export const ICON_QUALITY = 80;
/** Bump when the resize settings change: every cached icon is then regenerated. */
const RECIPE = `v1-${ICON_PX}px-webp-q${ICON_QUALITY}-contain`;

export type Resize = (src: Buffer) => Promise<Buffer>;

/** sharp: fit inside ICON_PX², transparent padding, WebP. Loaded lazily so dev and tests never need it. */
export async function sharpResize(src: Buffer): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  return sharp(src)
    .resize(ICON_PX, ICON_PX, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: ICON_QUALITY, alphaQuality: 90, effort: 4 })
    .toBuffer();
}

export interface CacheResult {
  /** Package-relative source path → absolute path of its cached icon. */
  icons: Map<string, string>;
  resized: number;
  fromCache: number;
  /** Cached icons no longer referenced (deleted). */
  pruned: number;
  failed: { path: string; error: string }[];
}

/** Cache file name for a source image: hash of its bytes + the resize recipe. */
export function cacheName(src: Buffer): string {
  return `${createHash('sha256').update(RECIPE).update(src).digest('hex').slice(0, 20)}.webp`;
}

/**
 * Resize every source image that isn't cached yet. Unreadable or failing images are reported in `failed`
 * (that item then shows its name only); the rest still build.
 */
export async function ensureIcons(
  paths: string[],
  o: { srcDir: string; cacheDir: string; resize?: Resize; concurrency?: number },
): Promise<CacheResult> {
  const resize = o.resize ?? sharpResize;
  fs.mkdirSync(o.cacheDir, { recursive: true });
  const icons = new Map<string, string>();
  const failed: CacheResult['failed'] = [];
  let resized = 0;
  let fromCache = 0;
  const queue = [...new Set(paths)];
  const worker = async () => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
      try {
        const src = fs.readFileSync(path.join(o.srcDir, p));
        const out = path.join(o.cacheDir, cacheName(src));
        if (fs.existsSync(out)) fromCache++;
        else {
          const buf = await resize(src);
          fs.writeFileSync(`${out}.tmp`, buf);
          fs.renameSync(`${out}.tmp`, out); // never leave a half-written icon behind
          resized++;
        }
        icons.set(p, out);
      } catch (e) {
        failed.push({ path: p, error: (e as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  const keep = new Set([...icons.values()].map((f) => path.basename(f)));
  let pruned = 0;
  for (const f of fs.readdirSync(o.cacheDir))
    if (!keep.has(f)) {
      fs.rmSync(path.join(o.cacheDir, f), { force: true });
      pruned++;
    }
  return { icons, resized, fromCache, pruned, failed };
}
