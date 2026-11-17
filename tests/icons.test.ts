// Build-time icon resizing + cache (SPEC §13 Step 3): every referenced item image becomes a 96×96 WebP,
// cached by content hash so unchanged images are never reprocessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { cacheName, ensureIcons, ICON_PX, sharpResize } from '../scripts/lib/itemImageCache';
import { pickItemImages } from '../src/data/itemImages';
import { PKG_DIR } from '../src/data/loadNode';
import { cocData, data } from './helpers';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coc-icons-'));

function srcDir(files: Record<string, string>): string {
  const dir = tmp();
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), body);
  }
  return dir;
}

describe('icon cache', () => {
  it('resizes each new image once; a second build takes everything from the cache', async () => {
    const src = srcDir({ 'a/icon.png': 'AAA', 'b/level-3.png': 'BBB' });
    const cacheDir = path.join(tmp(), 'cache');
    const calls: string[] = [];
    const resize = async (b: Buffer) => (calls.push(b.toString()), Buffer.from(`small:${b}`));
    const first = await ensureIcons(['a/icon.png', 'b/level-3.png', 'a/icon.png'], { srcDir: src, cacheDir, resize });
    expect(first).toMatchObject({ resized: 2, fromCache: 0, pruned: 0, failed: [] });
    expect(fs.readFileSync(first.icons.get('a/icon.png')!, 'utf8')).toBe('small:AAA');
    const second = await ensureIcons(['a/icon.png', 'b/level-3.png'], { srcDir: src, cacheDir, resize });
    expect(second).toMatchObject({ resized: 0, fromCache: 2 });
    expect(calls.sort()).toEqual(['AAA', 'BBB']);
  });

  it('a changed source image is resized again (the cache is keyed by content), stale icons are removed', async () => {
    const src = srcDir({ 'a/icon.png': 'v1' });
    const cacheDir = path.join(tmp(), 'cache');
    const resize = async (b: Buffer) => Buffer.from(`small:${b}`);
    await ensureIcons(['a/icon.png'], { srcDir: src, cacheDir, resize });
    fs.writeFileSync(path.join(src, 'a/icon.png'), 'v2');
    const r = await ensureIcons(['a/icon.png'], { srcDir: src, cacheDir, resize });
    expect(r).toMatchObject({ resized: 1, fromCache: 0, pruned: 1 });
    expect(fs.readdirSync(cacheDir)).toEqual([cacheName(Buffer.from('v2'))]);
  });

  it('a missing or failing image is reported and left out; the others still build', async () => {
    const src = srcDir({ 'ok.png': 'x', 'bad.png': 'y' });
    const resize = async (b: Buffer) => {
      if (b.toString() === 'y') throw new Error('corrupt');
      return b;
    };
    const r = await ensureIcons(['ok.png', 'bad.png', 'gone.png'], { srcDir: src, cacheDir: path.join(tmp(), 'c'), resize });
    expect([...r.icons.keys()]).toEqual(['ok.png']);
    expect(r.failed.map((f) => f.path).sort()).toEqual(['bad.png', 'gone.png']);
  });

  it('sharp turns a real (4096 px, ~1 MB) package image into a small 96×96 WebP', async () => {
    const big = data.byId.get('overgrowth-spell')!.images![0];
    const src = fs.readFileSync(path.join(PKG_DIR, big));
    expect(src.length).toBeGreaterThan(500_000);
    const out = await sharpResize(src);
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: ICON_PX, height: ICON_PX, hasAlpha: true });
    expect(out.length).toBeLessThan(20_000);
  });

  it('with no size cap, every item clash-of-clans-data also has gets an image (ClashKing-only items: name only)', () => {
    const r = pickItemImages(data.items.values(), (p) => {
      try {
        return fs.statSync(path.join(PKG_DIR, p)).size;
      } catch {
        return undefined;
      }
    });
    expect(r.skipped).toEqual([]);
    const coc = cocData();
    const shared = [...data.items.values()].filter((i) => coc.items.has(i.key));
    expect(shared.length).toBeGreaterThan(180);
    expect(shared.filter((i) => !r.byKey.has(i.key)).map((i) => i.name)).toEqual([]);
  });
});
