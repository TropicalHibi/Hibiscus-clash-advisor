// Item images for new items (SPEC §13, §9b): ClashKing assets → Fandom wiki (MediaWiki API) → name only, saved as
// 96 px WebP icons in public/item-images-extra/ with their source, never downloaded twice, clash-of-clans-data's
// image preferred. Fake responses and a fake resizer only: no network, no sharp.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ckAssetFor,
  ckAssetUrl,
  fandomFileTitles,
  imagesCommitMessage,
  itemsNeedingImages,
  parseCkManifest,
  pickFandomFile,
  pickFandomPageImage,
  readSources,
  runExtraImages,
  syncExtraImages,
  type ExtraImageDeps,
} from '../scripts/lib/extraImages';
import { extraImageFiles, itemImagesModule } from '../src/data/itemImages';
import type { Item } from '../src/data/types';
import { data } from './helpers';
import { workflowCode } from './workflow';

const item = (p: Partial<Item> & Pick<Item, 'name' | 'category'>): Item => ({
  key: String(p.dataId ?? 1000107),
  dataId: 1000107,
  id: p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  queue: 'builder',
  levels: [],
  ...p,
});
const lv = (n: number) => Array.from({ length: n }, (_, i) => ({ level: i + 1, cost: 1, resource: 'gold' as const, timeSec: 1 }));
const SPIKY = item({ name: 'Spiky Tower', category: 'defense', levels: lv(2) });
const SQUAD = item({ name: 'P.E.K.K.A Titan Squad', category: 'troop', queue: 'lab', dataId: 4000204, key: '4000204', id: 'pekka-titan-squad' });
const HEROIC = item({ name: 'Heroic Spell', category: 'spell', queue: 'lab', dataId: 26000153, key: '26000153', id: 'heroic-spell' });
const SHRINE = item({ name: 'Guardian Shrine', category: 'army', queue: 'none', dataId: 1000105, key: '1000105', id: 'guardian-shrine' });

const bytes = (s: string) => Buffer.from(s);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const MANIFEST = {
  version: 2,
  assets: {
    buildings: [
      { path: 'buildings/home-village/spiky_tower/level_1.webp', sha: sha('spiky1') },
      { path: 'buildings/home-village/spiky_tower/level_2.webp', sha: sha('spiky2') },
      { path: 'buildings/home-village/spiky_tower/level_3.webp', sha: sha('spiky3') }, // a level the data doesn't have yet
      { path: 'buildings/home-village/town_hall/level_19_archer.webp' },
      { path: 'buildings/builder-base/x-bow/level_1.webp' },
      { path: 'buildings/home-village/guardian_shrine/level_1.webp', sha: sha('shrine') },
      { path: '../../etc/passwd.webp' },
    ],
    troops: [{ path: 'troops/pekka_titan_squad/icon.webp', sha: sha('pts') }, { path: 'troops/pekka_titan_squad/portrait.webp' }],
    spells: [{ path: 'spells/heroic_spell.webp' }],
    traps: [{ path: 'traps/home-village/bomb/level_1.webp' }],
  },
};

describe('ClashKing assets (assets.clashk.ing/manifest.json)', () => {
  const assets = parseCkManifest(MANIFEST);

  it('parses the manifest defensively: bad paths dropped, a non-manifest throws', () => {
    expect(assets.some((a) => a.path.includes('..'))).toBe(false);
    expect(() => parseCkManifest({ nope: 1 })).toThrow(/no "assets"/);
    expect(() => parseCkManifest({ assets: { x: [{ path: 3 }] } })).toThrow(/no images/);
    expect(() => parseCkManifest(null)).toThrow();
  });

  it("a building gets its top level's image (not a level it doesn't have), from home village only", () => {
    expect(ckAssetFor(SPIKY, assets)?.path).toBe('buildings/home-village/spiky_tower/level_2.webp');
    expect(ckAssetFor({ ...SPIKY, levels: [] }, assets)?.path).toBe('buildings/home-village/spiky_tower/level_3.webp'); // no levels: the highest
    expect(ckAssetFor(SHRINE, assets)?.path).toBe('buildings/home-village/guardian_shrine/level_1.webp');
    expect(ckAssetFor(item({ name: 'X-Bow', category: 'defense', levels: lv(3) }), assets)).toBeUndefined();
    expect(ckAssetFor(item({ name: 'Bomb', category: 'trap', levels: lv(3) }), assets)?.path).toBe('traps/home-village/bomb/level_1.webp');
  });

  it('a unit gets its icon (names matched on letters and digits), a spell its flat file', () => {
    expect(ckAssetFor(SQUAD, assets)?.path).toBe('troops/pekka_titan_squad/icon.webp');
    expect(ckAssetFor(HEROIC, assets)?.path).toBe('spells/heroic_spell.webp');
    expect(ckAssetFor(item({ name: 'Nope', category: 'troop' }), assets)).toBeUndefined();
    expect(ckAssetUrl("buildings/home-village/builder's_hut/level_1.webp")).toBe("https://assets.clashk.ing/buildings/home-village/builder's_hut/level_1.webp");
  });
});

describe('Fandom wiki (MediaWiki API), parsed defensively', () => {
  const FILE = (title: string, url = `https://static.wikia.nocookie.net/clashofclans/images/f/f6/${encodeURIComponent(title)}/revision/latest`) => ({
    ns: 6,
    title,
    imageinfo: [{ url, size: 1000, mime: 'image/png' }],
  });

  it('file titles: a building by level, a unit by its info / avatar image', () => {
    expect(fandomFileTitles(SPIKY)).toEqual(['File:Spiky Tower2.png', 'File:Spiky Tower1.png', 'File:Spiky Tower.png']);
    expect(fandomFileTitles(SHRINE)).toEqual(['File:Guardian Shrine1.png', 'File:Guardian Shrine.png']);
    expect(fandomFileTitles(SQUAD)).toEqual(['File:P.E.K.K.A Titan Squad info.png', 'File:Avatar P.E.K.K.A Titan Squad.png', 'File:P.E.K.K.A Titan Squad.png']);
  });

  it('picks the first existing title, following "normalized", in either pages format', () => {
    const titles = fandomFileTitles(SPIKY);
    const v2 = {
      query: {
        normalized: [{ from: 'File:Spiky_Tower2.png', to: 'File:Spiky Tower2.png' }],
        pages: [{ ns: 6, title: 'File:Spiky Tower2.png', missing: true }, FILE('File:Spiky Tower1.png')],
      },
    };
    expect(pickFandomFile(v2, titles)).toContain('Spiky%20Tower1.png');
    const v1 = { query: { pages: { '-1': { title: 'File:Spiky Tower2.png', missing: '' }, '7': FILE('File:Spiky Tower.png') } } };
    expect(pickFandomFile(v1, titles)).toContain('Spiky%20Tower.png');
  });

  it('rejects other hosts, plain http, non-images, huge files and junk', () => {
    const t = ['File:A.png'];
    expect(pickFandomFile({ query: { pages: [FILE('File:A.png', 'https://evil.example/a.png')] } }, t)).toBeUndefined();
    expect(pickFandomFile({ query: { pages: [FILE('File:A.png', 'http://static.wikia.nocookie.net/a.png')] } }, t)).toBeUndefined();
    expect(pickFandomFile({ query: { pages: [{ title: 'File:A.png', imageinfo: [{ url: 'https://static.wikia.nocookie.net/a.pdf', mime: 'application/pdf' }] }] } }, t)).toBeUndefined();
    expect(pickFandomFile({ query: { pages: [{ title: 'File:A.png', imageinfo: [{ url: 'https://static.wikia.nocookie.net/a.png', size: 99e6 }] }] } }, t)).toBeUndefined();
    for (const junk of [null, 'x', 42, {}, { query: {} }, { query: { pages: 'no' } }, { query: { pages: [null, 1] } }]) expect(pickFandomFile(junk, t)).toBeUndefined();
    expect(pickFandomPageImage({ query: { pages: [{ title: 'A', original: { source: 'https://static.wikia.nocookie.net/x.png' } }] } })).toBe('https://static.wikia.nocookie.net/x.png');
    expect(pickFandomPageImage({ query: { pages: [{ title: 'A', original: { source: 'https://evil.example/x.png' } }] } })).toBeUndefined();
    expect(pickFandomPageImage({ query: { pages: [{ title: 'A', missing: true }] } })).toBeUndefined();
    expect(pickFandomPageImage(undefined)).toBeUndefined();
  });
});

// ── The run, against fake hosts ──
interface Fake {
  json: Record<string, unknown>; // URL prefix → response (an Error = network failure)
  files: Record<string, string>; // exact URL → body
}
function fakeDeps(f: Fake, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extra-img-'))) {
  const calls: string[] = [];
  const log: string[] = [];
  const deps: ExtraImageDeps = {
    fetchJson: async (url) => {
      calls.push(url);
      const hit = Object.entries(f.json).find(([p]) => url.startsWith(p));
      if (!hit) throw new Error('HTTP 404');
      if (hit[1] instanceof Error) throw hit[1];
      return structuredClone(hit[1]);
    },
    fetchBytes: async (url) => {
      calls.push(url);
      if (!(url in f.files)) throw new Error('HTTP 404');
      return bytes(f.files[url]);
    },
    resize: async (src) => bytes(`webp96:${src.toString()}`),
    dir,
    now: () => new Date('2026-11-17T12:00:00Z'),
    log: (l) => log.push(l),
  };
  return { deps, calls, log, dir };
}
const CK_MANIFEST_URL = 'https://assets.clashk.ing/manifest.json';
const FANDOM = 'https://clashofclans.fandom.com/api.php?';
const fandomInfo = (title: string, url: string) => ({ query: { pages: [{ ns: 6, title, imageinfo: [{ url, mime: 'image/png', size: 10 }] }] } });

describe('syncExtraImages: ClashKing → Fandom → name only', () => {
  it('ClashKing first: downloads the listed file, checks its sha256, saves a 96 px icon and records the source', async () => {
    const { deps, dir, calls } = fakeDeps({
      json: { [CK_MANIFEST_URL]: MANIFEST },
      files: { 'https://assets.clashk.ing/buildings/home-village/spiky_tower/level_2.webp': 'spiky2' },
    });
    const r = await syncExtraImages([SPIKY], deps);
    expect(r.added).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'spiky-tower.webp'), 'utf8')).toBe('webp96:spiky2');
    expect(readSources(dir).images['1000107']).toEqual({
      name: 'Spiky Tower',
      file: 'spiky-tower.webp',
      source: 'clashking',
      url: 'https://assets.clashk.ing/buildings/home-village/spiky_tower/level_2.webp',
      sha256: sha('spiky2'),
      fetchedAt: '2026-11-17T12:00:00.000Z',
    });
    expect(calls.some((c) => c.startsWith(FANDOM))).toBe(false);
  });

  it('not on ClashKing → the Fandom file by name; then the page image; then name only', async () => {
    const wiki = 'https://static.wikia.nocookie.net/clashofclans/images/a/a1/Barch_Squad_info.png/revision/latest';
    const barch = item({ name: 'Barch Squad', category: 'troop', dataId: 4000195, key: '4000195', id: 'barch-squad' });
    const lead = 'https://static.wikia.nocookie.net/clashofclans/images/b/b2/Thing.png';
    const thing = item({ name: 'Thing', category: 'troop', dataId: 4000999, key: '4000999', id: 'thing' });
    const none = item({ name: 'Nothing', category: 'troop', dataId: 4000998, key: '4000998', id: 'nothing' });
    const { deps, dir } = fakeDeps({
      json: {
        [CK_MANIFEST_URL]: MANIFEST,
        [`${FANDOM}action=query&format=json&formatversion=2&titles=File%3ABarch+Squad+info.png`]: fandomInfo('File:Barch Squad info.png', wiki),
        [`${FANDOM}action=query&format=json&formatversion=2&titles=File%3AThing`]: { query: { pages: [{ title: 'File:Thing info.png', missing: true }] } },
        [`${FANDOM}action=query&format=json&formatversion=2&titles=Thing&prop=pageimages`]: { query: { pages: [{ title: 'Thing', original: { source: lead } }] } },
        [`${FANDOM}action=query&format=json&formatversion=2&titles=File%3ANothing`]: { query: { pages: [] } },
        [`${FANDOM}action=query&format=json&formatversion=2&titles=Nothing&prop=pageimages`]: { query: { pages: [{ title: 'Nothing', missing: true }] } },
      },
      files: { [wiki]: 'barch', [lead]: 'thing' },
    });
    const r = await syncExtraImages([barch, thing, none], deps);
    expect(r.added.map((a) => [a.record.name, a.record.source, a.record.url])).toEqual([
      ['Barch Squad', 'fandom', wiki],
      ['Thing', 'fandom', lead],
    ]);
    expect(r.missing).toEqual([{ key: '4000998', name: 'Nothing', why: 'ClashKing: not listed; Fandom: no image' }]);
    expect(fs.existsSync(path.join(dir, 'nothing.webp'))).toBe(false);
    expect(Object.keys(readSources(dir).images)).toEqual(['4000195', '4000999']);
  });

  it('ClashKing down → one warning, Fandom still tried; a sha256 mismatch also falls through', async () => {
    const wiki = 'https://static.wikia.nocookie.net/clashofclans/images/f/f6/Spiky_Tower2.png';
    const down = fakeDeps({
      json: { [CK_MANIFEST_URL]: new Error('HTTP 503'), [FANDOM]: fandomInfo('File:Spiky Tower2.png', wiki) },
      files: { [wiki]: 'wiki' },
    });
    const r = await syncExtraImages([SPIKY, HEROIC], down.deps);
    expect(r.warnings).toEqual(['ClashKing assets unavailable (HTTP 503); trying the Fandom wiki only.']);
    expect(down.calls.filter((c) => c === CK_MANIFEST_URL)).toHaveLength(1); // asked once, not per item
    expect(r.added[0].record).toMatchObject({ source: 'fandom', url: wiki });

    const bad = fakeDeps({
      json: { [CK_MANIFEST_URL]: MANIFEST, [FANDOM]: fandomInfo('File:Spiky Tower2.png', wiki) },
      files: { 'https://assets.clashk.ing/buildings/home-village/spiky_tower/level_2.webp': 'tampered', [wiki]: 'wiki' },
    });
    const r2 = await syncExtraImages([SPIKY], bad.deps);
    expect(r2.added[0].record.source).toBe('fandom');
  });

  it('never downloads an image already saved; never downloads from a host it does not know', async () => {
    const first = fakeDeps({ json: { [CK_MANIFEST_URL]: MANIFEST }, files: { 'https://assets.clashk.ing/troops/pekka_titan_squad/icon.webp': 'pts' } });
    await syncExtraImages([SQUAD], first.deps);
    const again = fakeDeps({ json: {}, files: {} }, first.dir);
    const r = await syncExtraImages([SQUAD], again.deps);
    expect(r).toMatchObject({ added: [], kept: 1, missing: [] });
    expect(again.calls).toEqual([]);

    const evil = fakeDeps({
      json: { [CK_MANIFEST_URL]: { assets: { x: [{ path: 'a/b.webp' }] } }, [FANDOM]: fandomInfo('File:Heroic Spell info.png', 'https://evil.example/x.png') },
      files: { 'https://evil.example/x.png': 'x' },
    });
    const r2 = await syncExtraImages([HEROIC], evil.deps);
    expect(r2.added).toEqual([]);
    expect(evil.calls).not.toContain('https://evil.example/x.png');
  });

  it('a saved record whose file is gone is fetched again; malformed sources.json is ignored', async () => {
    const f = fakeDeps({ json: { [CK_MANIFEST_URL]: MANIFEST }, files: { 'https://assets.clashk.ing/troops/pekka_titan_squad/icon.webp': 'pts' } });
    fs.writeFileSync(path.join(f.dir, 'sources.json'), JSON.stringify({ images: { '4000204': { file: 'pekka-titan-squad.webp', source: 'clashking' } } }));
    expect((await syncExtraImages([SQUAD], f.deps)).added).toHaveLength(1);
    fs.writeFileSync(path.join(f.dir, 'sources.json'), '{nope');
    expect(readSources(f.dir)).toEqual({ images: {} });
    fs.writeFileSync(path.join(f.dir, 'sources.json'), JSON.stringify({ images: { x: { file: '../../evil.webp', source: 'clashking' } } }));
    expect(readSources(f.dir)).toEqual({ images: {} });
  });
});

describe('which items are looked up, and the build preferring clash-of-clans-data', () => {
  it("only shown base items without a clash-of-clans-data image: no seasonal units, supercharges or modules", () => {
    const list = itemsNeedingImages(data, () => false);
    expect(list.some((i) => i.seasonal)).toBe(false);
    expect(list.every((i) => i.key === String(i.dataId))).toBe(true);
    expect(itemsNeedingImages(data, () => true)).toEqual([]);
  });

  it('runExtraImages skips every item clash-of-clans-data has a picture for', async () => {
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-pkg-'));
    for (const it of data.items.values()) for (const p of it.images ?? []) {
      fs.mkdirSync(path.dirname(path.join(pkg, p)), { recursive: true });
      fs.writeFileSync(path.join(pkg, p), 'x');
    }
    const f = fakeDeps({ json: {}, files: {} });
    const r = await runExtraImages(data, f.deps, pkg);
    // Every item looked up has no clash-of-clans-data image candidate at all.
    const looked = [...r.missing.map((m) => m.key)];
    for (const k of looked) expect(data.items.get(k)!.images ?? []).toEqual([]);
    expect(looked.length).toBe(itemsNeedingImages(data, (k) => (data.items.get(k)!.images ?? []).length > 0).length);
  });

  it('the build uses a saved icon only when clash-of-clans-data has none, and only if the file exists', () => {
    const items = [SPIKY, SQUAD, HEROIC];
    const sources = { images: { '1000107': { file: 'spiky-tower.webp' }, '4000204': { file: 'pekka-titan-squad.webp' }, '26000153': { file: '../x.webp' } } };
    const files = extraImageFiles(items, new Set(['4000204']), sources, (f) => f !== 'gone.webp');
    expect([...files]).toEqual([['1000107', 'spiky-tower.webp']]);
    expect(extraImageFiles(items, new Set(), { images: { '1000107': { file: 'gone.webp' } } }, (f) => f !== 'gone.webp').size).toBe(0);
    expect(extraImageFiles(items, new Set(), 'junk', () => true).size).toBe(0);

    const mod = itemImagesModule(new Map([['4000204', 'images/a.png']]), (p) => `pkg/${p}`, new Map([['1000107', '/base/item-images-extra/spiky-tower.webp'], ['4000204', '/base/item-images-extra/x.webp']]));
    expect(mod).toContain(`"1000107": "/base/item-images-extra/spiky-tower.webp",`);
    expect(mod).toContain(`"4000204": u0,`);
    expect(mod).not.toContain('x.webp');
  });
});

describe('the daily data-update Action runs the lookups', () => {
  const code = workflowCode('data-update.yml');

  it('runs the images step on every run, never in the browser, and commits public/item-images-extra/', () => {
    expect(code).toMatch(/- id: images\n\s+name: [^\n]+\n\s+run: npx tsx scripts\/data-update\.ts images --check "\$RUNNER_TEMP\/data-update\.json"/);
    expect(code).toContain('git add package.json package-lock.json public/data-changes.json data/clashking/ public/item-images-extra/');
    for (const id of ['test', 'commit', 'deploy']) expect(code).toMatch(new RegExp(`id: ${id}\\n[\\s\\S]*?if: [^\\n]*steps\\.images\\.outputs\\.added`));
    expect(code).toContain('MESSAGE: ${{ steps.images.outputs.message || steps.check.outputs.message }}');
    // Nothing in src/ (the browser bundle) talks to the image hosts.
    const srcFiles = fs.readdirSync('src', { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
    for (const f of srcFiles) expect(fs.readFileSync(path.join('src', f), 'utf8'), f).not.toMatch(/clashk\.ing|fandom\.com|wikia/);
  });

  it('commit message: images appended to a data update, or on their own', () => {
    const added = [{ key: '1', record: { name: 'Spiky Tower' } }, { key: '2', record: { name: 'Squad Barracks' } }] as Parameters<typeof imagesCommitMessage>[1];
    expect(imagesCommitMessage(undefined, added)).toBe('data: 2 new item images (Spiky Tower, Squad Barracks)');
    expect(imagesCommitMessage('data: ClashKing v0.1.20 → v0.1.21 (3 changes)', added)).toBe('data: ClashKing v0.1.20 → v0.1.21 (3 changes); 2 new item images (Spiky Tower, Squad Barracks)');
    expect(imagesCommitMessage('data: x', [])).toBe('data: x');
    expect(imagesCommitMessage(undefined, [])).toBe('');
  });
});
