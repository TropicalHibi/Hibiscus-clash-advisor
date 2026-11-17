// ClashKing as the game-data source (SPEC §3.1, §5, §7, §9, §9b): normalization of a trimmed ClashKing
// fixture, merges / super troops / supercharges / seasonal units, the optional overrides winning, the
// clash-of-clans-data backup, the pinned-copy sync with its known-good rollback, the data-update Action and the
// cross-check report. Everything runs on fixtures and fakes: no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLatestWith, sha256, syncClashKing, validateClashKing, type ClashKingDeps } from '../scripts/lib/clashking';
import { fullCommitMessage, issueTitle, runDataUpdate } from '../scripts/lib/dataUpdate';
import { fetchTextSync } from '../scripts/lib/nodeDeps';
import { refreshGameData, type RefreshDeps, type RefreshState } from '../scripts/lib/refresh';
import type { SyncDeps } from '../scripts/lib/sync';
import { ckSlug, normalizeClashKing, trimClashKing, type ClashKingRaw } from '../src/data/clashking';
import { crossCheck, crossCheckLines } from '../src/data/crossCheck';
import { CK_DIR, loadGameDataFresh } from '../src/data/loadNode';
import { countAt, levelInfo } from '../src/data/normalize';
import { parseOverrides } from '../src/data/overrides';
import { recordSnapshot, type SnapshotIO } from '../scripts/lib/snapshots';
import { snapshotFileName, toSnapshot, type Snapshot } from '../src/data/snapshot';
import { backupWarning, clashKingVersion, dataSourceLabel, pinVersion, versionLabel, versionSlug, type ClashKingPin } from '../src/data/source';
import type { GameData } from '../src/data/types';
import { checkLevels, checkMergeConsumption } from '../src/data/validate';
import { buildCatalog } from '../src/meta/aggregate';
import { data } from './helpers';

const FULL = JSON.parse(fs.readFileSync(new URL('./fixtures/clashking-mini.json', import.meta.url), 'utf8'));
const raw = (): ClashKingRaw => trimClashKing(structuredClone(FULL));
const mini = (o: Parameters<typeof parseOverrides>[0] = {}) => normalizeClashKing(raw(), { version: 'clashking-test', overrides: parseOverrides(o) });
const DAY = 86400;

describe('trimming the downloaded file', () => {
  it('keeps the planner sections, home village only, without info texts and TIDs', () => {
    const t = raw();
    expect(Object.keys(t).sort()).toEqual(['buildings', 'equipment', 'guardians', 'helpers', 'heroes', 'pets', 'spells', 'traps', 'troops']);
    expect(t.buildings.some((b) => b.village === 'builderBase')).toBe(false);
    expect(t.heroes.map((h) => h.name)).toEqual(['Archer Queen']);
    expect(JSON.stringify(t)).not.toContain('"info"');
    expect(JSON.stringify(t)).not.toContain('"TID"');
  });

  it('throws when a section is missing (the file must not be pinned)', () => {
    const { troops: _gone, ...rest } = structuredClone(FULL);
    expect(() => trimClashKing(rest)).toThrow('no "troops" list');
    expect(() => trimClashKing('nope')).toThrow();
  });

  it('item ids are slugs of the names, matching the old clash-of-clans-data file ids', () => {
    expect(ckSlug("Builder's Hut")).toBe('builders-hut');
    expect(ckSlug('P.E.K.K.A')).toBe('pekka');
    expect(ckSlug('L.A.S.S.I')).toBe('lassi');
    expect(ckSlug('B.O.T.O’s Shack')).toBe('botos-shack');
    expect(ckSlug('Multi-Archer Tower')).toBe('multi-archer-tower');
  });
});

describe('normalizing ClashKing into the Item model', () => {
  const d = mini();

  it('buildings: build_cost / build_time are the cost and time of that level; TH requirement per level', () => {
    const cannon = d.byId.get('cannon')!;
    expect(cannon.category).toBe('defense');
    expect(cannon.levels.map((l) => [l.level, l.cost, l.timeSec, l.thRequired, l.resource])).toEqual([
      [1, 250, 5, 1, 'gold'],
      [2, 1000, 30, 2, 'gold'],
      [3, 5000, 600, 2, 'gold'],
    ]);
    expect(d.byId.get('town-hall')!.levels.map((l) => l.thRequired)).toEqual([0, 1, 2]);
    expect(d.maxTH).toBe(3);
    expect(d.source).toBe('clashking');
    expect(d.version).toBe('clashking-test');
  });

  it('walls with an alternative resource cost gold or elixir; buildings without levels are recognised, never scheduled', () => {
    const wall = d.byId.get('wall')!;
    expect(wall.levels.map((l) => l.resource)).toEqual(['gold', 'goldOrElixir']);
    expect(wall.queue).toBe('none');
    const hut = d.byId.get('helper-hut')!;
    expect(hut).toMatchObject({ category: 'other', queue: 'none', levels: [] });
  });

  it('upgrade-style items: level N costs what row N−1 says (upgrade_cost / upgrade_time), level 1 is free; requirements are not shifted', () => {
    const barb = d.byId.get('barbarian')!;
    expect(barb.levels.map((l) => [l.level, l.cost, l.timeSec, l.thRequired, l.labRequired])).toEqual([
      [1, 0, 0, 1, undefined],
      [2, 10000, 0, 2, 1],
      [3, 50000, 3600, 3, 2],
    ]);
    const aq = d.byId.get('archer-queen')!;
    expect(aq.levels.map((l) => [l.level, l.cost, l.timeSec, l.heroHallRequired, l.resource])).toEqual([
      [1, 0, 0, 1, 'darkElixir'],
      [2, 5000, 7200, 1, 'darkElixir'],
      [3, 5500, 8 * DAY, 2, 'darkElixir'],
    ]);
    expect(d.bookThresholdSec).toBe(8 * DAY);
    const lassi = d.byId.get('lassi')!;
    expect(lassi.levels.map((l) => [l.cost, l.timeSec, l.thRequired, l.petHouseRequired])).toEqual([
      [0, 0, 2, 1],
      [100000, DAY, 3, 2],
    ]);
    const longshot = d.byId.get('longshot')!;
    expect(longshot.levels.map((l) => [l.cost, l.timeSec, l.thRequired])).toEqual([
      [0, 0, 3],
      [18000000, 7 * DAY, 3],
    ]);
  });

  it('equipment: ore costs per level (shifted like upgrades), Blacksmith requirement, owning hero', () => {
    const puppet = d.byId.get('barbarian-puppet')!;
    expect(puppet).toMatchObject({ category: 'equipment', queue: 'blacksmith', hero: 'barbarian-king' });
    expect(puppet.levels.map((l) => [l.level, l.ore, l.blacksmithRequired, l.timeSec])).toEqual([
      [1, { shinyOre: 0, glowyOre: 0, starryOre: 0 }, 1, 0],
      [2, { shinyOre: 120, glowyOre: 0, starryOre: 0 }, 1, 0],
      [3, { shinyOre: 240, glowyOre: 20, starryOre: 0 }, 3, 0],
    ]);
  });

  it('housing space, sieges (Workshop), spells', () => {
    expect(d.byId.get('barbarian')!.housingSpace).toBe(1);
    expect(d.byId.get('wall-wrecker')!).toMatchObject({ category: 'siege', queue: 'lab' });
    expect(d.byId.get('rage-spell')!).toMatchObject({ category: 'spell', queue: 'lab', housingSpace: 2 });
  });

  it('super troops: own dataId → base troop, own housing space; not a lab item', () => {
    expect(d.superTroops).toEqual({ 4000026: { name: 'Super Barbarian', base: 'barbarian', baseDataId: 4000000, housingSpace: 5 } });
    expect(d.byDataId.has(4000026)).toBe(false);
    expect(d.byId.get('barbarian')!.superHousingSpace).toBe(5);
    const cat = buildCatalog(d);
    expect(cat.get(4000026)).toEqual({ kind: 'superTroop', name: 'Super Barbarian', baseId: 4000000, housing: 5 });
  });

  it('seasonal troops and spells are recognised but never in the lab queue or the meta', () => {
    const ice = d.byId.get('ice-wizard')!;
    expect(ice).toMatchObject({ category: 'troop', queue: 'none', seasonal: true });
    expect(d.byId.get('santas-surprise')!).toMatchObject({ queue: 'none', seasonal: true });
    const cat = buildCatalog(d);
    expect(cat.has(4000030)).toBe(false);
    expect(cat.has(26000006)).toBe(false);
    expect(cat.get(4000000)!.kind).toBe('troop');
  });

  it('supercharges come from the `supercharge` block: their own levels and TH requirement', () => {
    const sc = d.items.get('1000008:sc')!;
    expect(sc).toMatchObject({ category: 'supercharge', queue: 'builder', baseKey: '1000008', name: 'Cannon Supercharge' });
    expect(sc.levels.map((l) => [l.level, l.cost, l.timeSec, l.thRequired])).toEqual([
      [1, 9000, 7200, 3],
      [2, 11000, 9000, 3],
    ]);
    expect(d.byId.get('cannon')!.levels).toHaveLength(3); // the supercharge isn't a Cannon level
  });

  it('building counts per TH are cumulative from the Town Hall `unlocks`', () => {
    expect(d.byId.get('cannon')!.countPerTH).toEqual({ 1: 2, 2: 4, 3: 4 });
    expect(d.byId.get('wall')!.countPerTH).toEqual({ 1: 10, 2: 25, 3: 25 });
    expect(d.byId.get('bomb')!.countPerTH).toEqual({ 1: 1, 2: 1, 3: 1 });
    // A TH level with its own merge_requirement absorbs that building (TH17 takes the Eagle Artillery).
    expect(d.byId.get('eagle-artillery')!.countPerTH).toEqual({ 2: 1, 3: 0 });
  });

  it('merges from the level-1 merge_requirement: exact source levels, unlock TH, counts after merges', () => {
    expect(d.merges).toEqual([{ id: 'twin-cannon', dataId: 1000200, sources: [{ id: 'cannon', dataId: 1000008, qty: 2 }], unlockTH: 3, requiredSourceLevel: { cannon: 3 } }]);
    expect(d.byId.get('twin-cannon')!.category).toBe('mergedDefense');
    expect(d.byId.get('cannon')!.countAfterMergesPerTH).toEqual({ 3: 2 });
    expect(countAt(d.byId.get('cannon')!.countAfterMergesPerTH, 2)).toBeUndefined();
    expect(checkMergeConsumption(d)).toEqual([]);
  });

  it('guardians: one each from their first level’s TH; helpers: work rate per level', () => {
    expect(d.byId.get('longshot')!.countPerTH).toEqual({ 3: 1 });
    expect(d.byId.get('builders-apprentice')!.helperWorkRates).toEqual({ 1: 1, 2: 2 });
    expect(d.byId.get('alchemist')!).toMatchObject({ dataId: 93000002, category: 'helper' });
    expect(d.byId.get('alchemist')!.helperWorkRates).toBeUndefined();
    expect(d.byId.get('prospector')!.dataId).toBe(93000003);
  });

  it('crafting station modules: one item per module, keyed by defense and module, with their own levels', () => {
    const hp = d.items.get('103000011:m102000033')!;
    expect(hp).toMatchObject({ id: 'hot-candle-hitpoints', name: 'Hot Candle Hitpoints', category: 'craftedDefense', queue: 'builder', craftedDefenseId: 103000011 });
    expect(hp.levels.map((l) => [l.level, l.cost, l.resource, l.thRequired])).toEqual([
      [1, 0, 'elixir', 3],
      [2, 3500000, 'elixir', 3],
    ]);
    expect(d.items.get('103000011:m102000034')!.levels[1].resource).toBe('gold');
    expect(d.byDataId.get(103000011)!).toMatchObject({ category: 'craftedDefense', queue: 'none' });
  });

  it('the result passes the level checks and has no warnings', () => {
    expect(checkLevels(d)).toEqual([]);
    expect(d.warnings).toEqual([]);
    expect(d.heroHallCaps).toEqual({});
  });
});

describe('optional overrides win over ClashKing (config/*.yaml, shipped empty)', () => {
  it('the shipped files are empty', () => {
    const shipped = parseOverrides({
      merges: fs.readFileSync('config/merges.yaml', 'utf8'),
      superTroops: fs.readFileSync('config/super-troops.yaml', 'utf8'),
      ids: fs.readFileSync('config/id-overrides.yaml', 'utf8'),
    });
    expect(shipped.merges).toEqual({});
    expect(shipped.superTroops).toEqual({});
    expect(shipped.ids.size).toBe(0);
  });

  it('merges.yaml: an entry replaces the data recipe (sources, quantities, levels)', () => {
    const d = mini({ merges: 'merges:\n  twin-cannon:\n    dataId: 1000200\n    sources:\n      - { id: cannon, qty: 1, level: 2 }\n      - { id: eagle-artillery, qty: 1 }\n' });
    const r = d.merges.find((m) => m.id === 'twin-cannon')!;
    expect(r.sources.map((s) => [s.id, s.qty])).toEqual([
      ['cannon', 1],
      ['eagle-artillery', 1],
    ]);
    expect(r.requiredSourceLevel).toEqual({ cannon: 2, 'eagle-artillery': 2 }); // no level → max at the unlock TH
  });

  it('merges.yaml: an entry can declare a merge the data lacks', () => {
    const d = mini({ merges: 'merges:\n  eagle-artillery:\n    sources:\n      - { id: cannon, qty: 1 }\n' });
    expect(d.byId.get('eagle-artillery')!.category).toBe('mergedDefense');
    expect(d.merges.map((m) => m.id).sort()).toEqual(['eagle-artillery', 'twin-cannon']);
  });

  it('super-troops.yaml: an entry wins (and can add one)', () => {
    const d = mini({ superTroops: '4000026: { name: Mega Barbarian, base: barbarian }\n4000099: { name: Super Rager, base: barbarian }\n' });
    expect(d.superTroops[4000026]).toMatchObject({ name: 'Mega Barbarian', base: 'barbarian', housingSpace: 5 });
    expect(d.superTroops[4000099]).toMatchObject({ name: 'Super Rager', baseDataId: 4000000 });
    expect(buildCatalog(d).get(4000099)!.kind).toBe('superTroop');
  });

  it('id-overrides.yaml: an entry wins, with a warning; a clash with another item is reported', () => {
    const d = mini({ ids: 'ids:\n  93000009: alchemist\n' });
    expect(d.byId.get('alchemist')!.dataId).toBe(93000009);
    expect(d.byDataId.get(93000009)!.id).toBe('alchemist');
    expect(d.warnings.some((w) => w.includes('id-overrides.yaml maps 93000009 to "alchemist"'))).toBe(true);
    const clash = mini({ ids: 'ids:\n  93000003: alchemist\n' }); // the old clash-of-clans-data mapping
    expect(clash.warnings.some((w) => w.includes('dataId 93000003 is used by both'))).toBe(true);
  });
});

describe('the real pinned ClashKing data', () => {
  it('is the active source, pinned to a release and commit, with the TH19 merge from merge_requirement', () => {
    const pin = JSON.parse(fs.readFileSync(path.join(CK_DIR, 'pin.json'), 'utf8')) as ClashKingPin;
    expect(pin.repo).toBe('ClashKingInc/clashy.go');
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.source).toBe('clashking');
    expect(data.version).toBe(pin.version);
    expect(dataSourceLabel(data)).toMatch(/^ClashKing /);
    const fc = data.merges.find((m) => m.id === 'firecracker-tower');
    if (fc) expect(fc.sources.map((s) => s.id).sort()).toEqual(['archer-tower', 'scattershot']);
    expect(data.merges.map((m) => m.id).slice(0, 4)).toEqual(['ricochet-cannon', 'multi-archer-tower', 'multi-gear-tower', 'super-wizard-tower']);
  });

  it('dataIds ClashKing has right where clash-of-clans-data was wrong (checked against Legend army codes)', () => {
    expect(data.byDataId.get(90000016)!).toMatchObject({ name: 'Monolith Arrow', hero: 'archer-queen' });
    expect(data.byDataId.get(90000059)!).toMatchObject({ name: 'Electro Fangs', hero: 'dragon-duke' });
    expect(data.byDataId.get(93000002)!.id).toBe('alchemist');
  });
});

describe('backup: clash-of-clans-data when there is no usable ClashKing copy', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ck-'));

  it('no pinned copy → clash-of-clans-data with a visible warning (built-in recipes and super troops)', () => {
    const d = loadGameDataFresh(tmp());
    expect(d.source).toBe('clash-of-clans-data');
    expect(d.warnings[0]).toBe(backupWarning('data/clashking/static_data.json is missing or unreadable'));
    expect(d.merges.map((m) => m.id)).toEqual(['ricochet-cannon', 'multi-archer-tower', 'multi-gear-tower', 'super-wizard-tower']);
    expect(Object.keys(d.superTroops)).toHaveLength(17);
    expect(d.byDataId.get(93000003)!.id).toBe('alchemist'); // clash-of-clans-data's own mapping
    expect(dataSourceLabel(d)).toMatch(/\(backup\)$/);
  });

  it('a pinned copy that fails to load → backup with the reason', () => {
    const dir = tmp();
    const broken = structuredClone(raw());
    broken.buildings = broken.buildings.filter((b) => b.type !== 'Town Hall');
    fs.writeFileSync(path.join(dir, 'static_data.json'), JSON.stringify(broken));
    fs.writeFileSync(path.join(dir, 'pin.json'), JSON.stringify({ version: 'clashking-bad' }));
    const d = loadGameDataFresh(dir);
    expect(d.source).toBe('clash-of-clans-data');
    expect(d.warnings[0]).toContain("can't be loaded (ClashKing data has no Town Hall)");
  });

  it('a usable pinned copy is used as is', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'static_data.json'), JSON.stringify(raw()));
    fs.writeFileSync(path.join(dir, 'pin.json'), JSON.stringify({ version: 'clashking-v9.9.9' }));
    const d = loadGameDataFresh(dir);
    expect(d).toMatchObject({ source: 'clashking', version: 'clashking-v9.9.9', maxTH: 3 });
    expect(d.byId.get('town-hall')!.images?.length).toBeGreaterThan(0); // images from clash-of-clans-data, by id
  });
});

// ── the pinned-copy sync (fake GitHub) ──
const OLD = { ref: 'v1.0.0', tag: 'v1.0.0', commit: 'a'.repeat(40) };
const NEW = { ref: 'v1.0.1', tag: 'v1.0.1', commit: 'b'.repeat(40) };
/** Data identity = tag + commit (REVIEW-2 #5). */
const V_OLD = 'clashking-v1.0.0+aaaaaaa';
const V_NEW = 'clashking-v1.0.1+bbbbbbb';
const pinOf = (r: typeof OLD, d: GameData): ClashKingPin => ({
  repo: 'ClashKingInc/clashy.go',
  ref: r.ref,
  tag: r.tag,
  commit: r.commit,
  path: 'static/static_data.json',
  sha256: 'x',
  version: clashKingVersion(r),
  fetchedAt: '2026-11-16T00:00:00.000Z',
  maxTH: d.maxTH,
  items: [...d.items.values()].filter((i) => i.key === String(i.dataId)).length,
});

function fakeGitHub(o: { latest?: typeof OLD | Error; file?: string | Error; pinned?: boolean } = {}) {
  const base = raw();
  let pinned: { raw: ClashKingRaw; pin: ClashKingPin } | undefined = o.pinned === false ? undefined : { raw: base, pin: pinOf(OLD, mini()) };
  let state: RefreshState = {};
  const logs: string[] = [];
  const calls: string[] = [];
  const next = structuredClone(FULL);
  next.buildings.find((b: any) => b.name === 'Cannon').levels[2].build_cost = 4000; // a real change in the new release
  const deps: ClashKingDeps = {
    readPinned: () => pinned,
    resolveLatest: () => {
      calls.push('resolve');
      if (o.latest instanceof Error) throw o.latest;
      return o.latest ?? NEW;
    },
    download: (commit) => {
      calls.push(`download ${commit.slice(0, 1)}`);
      if (o.file instanceof Error) throw o.file;
      return o.file ?? JSON.stringify(next);
    },
    normalize: (r, version) => normalizeClashKing(r, { version }),
    write: (r, pin) => {
      calls.push(`write ${pin.version}`);
      pinned = { raw: r, pin };
    },
    readState: () => state,
    writeState: (s) => void (state = s),
    snapshot: () => {
      calls.push(`snapshot ${pinned?.pin.version}`);
      return pinned?.pin.version === clashKingVersion(NEW) ? { file: 'x', written: true, changes: [{ kind: 'cost', key: '1000008', item: 'Cannon', level: 3, text: 'Cannon 3: 5K gold → 4K gold' }] } : { file: 'y', written: false };
    },
    now: () => new Date('2026-11-17T10:00:00Z'),
    log: (l) => logs.push(l),
  };
  return { deps, calls, logs, state: () => state, pinned: () => pinned };
}

describe('npm run sync: the ClashKing stage', () => {
  it('same commit as pinned → up to date, nothing downloaded', () => {
    const f = fakeGitHub({ latest: OLD });
    expect(syncClashKing(f.deps)).toMatchObject({ outcome: 'up-to-date', from: V_OLD });
    expect(f.calls).toEqual(['resolve']);
  });

  it('new release → snapshot before, download at the commit, validate, pin (version, commit, sha256), snapshot after', () => {
    const f = fakeGitHub();
    const r = syncClashKing(f.deps);
    expect(r).toMatchObject({ outcome: 'updated', from: V_OLD, to: V_NEW });
    expect(f.calls).toEqual(['resolve', `snapshot ${V_OLD}`, 'download b', `write ${V_NEW}`, `snapshot ${V_NEW}`]);
    const pin = f.pinned()!.pin;
    expect(pin).toMatchObject({ ref: 'v1.0.1', tag: 'v1.0.1', commit: NEW.commit, version: V_NEW, maxTH: 3, fetchedAt: '2026-11-17T10:00:00.000Z' });
    expect(pin.sha256).toBe(sha256(f.deps.download(NEW.commit))); // of the downloaded (untrimmed) text
    expect((f.pinned()!.raw as Record<string, unknown>).achievements).toBeUndefined(); // stored trimmed
    expect(f.state().lastGoodClashKing).toBe(V_NEW);
    expect(r.snapshot?.changes?.[0].text).toBe('Cannon 3: 5K gold → 4K gold');
  });

  it('a new file that fails to load keeps the known-good copy and records the failure', () => {
    const f = fakeGitHub({ file: '{"buildings": "oops"' });
    const r = syncClashKing(f.deps);
    expect(r.outcome).toBe('kept-previous');
    expect(f.pinned()!.pin.version).toBe(V_OLD);
    expect(f.calls).not.toContain(`write ${V_NEW}`);
    expect(f.state().clashKingFailure).toMatchObject({ version: V_NEW });
    expect(f.logs.some((l) => l.includes(`Keeping the known-good ClashKing ${V_OLD}`))).toBe(true);
  });

  it('a new file that fails validation (max TH dropped) keeps the known-good copy', () => {
    const smaller = structuredClone(FULL);
    const th = smaller.buildings.find((b: any) => b.name === 'Town Hall');
    th.levels = th.levels.slice(0, 2);
    const f = fakeGitHub({ file: JSON.stringify(smaller) });
    const r = syncClashKing(f.deps);
    expect(r).toMatchObject({ outcome: 'kept-previous', reason: 'max TH dropped from 3 to 2' });
    expect(f.pinned()!.pin.version).toBe(V_OLD);
  });

  it('GitHub unreachable or download failing → the pinned copy stays', () => {
    expect(syncClashKing(fakeGitHub({ latest: new Error('HTTP 503') }).deps)).toMatchObject({ outcome: 'check-failed', reason: 'GitHub check failed: HTTP 503' });
    const f = fakeGitHub({ file: new Error('HTTP 404') });
    expect(syncClashKing(f.deps)).toMatchObject({ outcome: 'download-failed' });
    expect(f.pinned()!.pin.version).toBe(V_OLD);
  });

  it('nothing pinned and GitHub down → no copy: the backup is used', () => {
    const f = fakeGitHub({ pinned: false, latest: new Error('offline') });
    expect(syncClashKing(f.deps).outcome).toBe('no-copy');
    expect(f.logs.at(-1)).toContain('falls back to clash-of-clans-data');
  });

  it('offline: validates the pinned copy only', () => {
    const f = fakeGitHub();
    expect(syncClashKing(f.deps, { offline: true })).toMatchObject({ outcome: 'up-to-date', to: V_OLD });
    expect(f.calls).toEqual([]);
  });

  it('validation rejects files missing core items or losing >10% of items', () => {
    const d = mini();
    expect(validateClashKing(d)).toBeUndefined();
    expect(validateClashKing(d, { maxTH: 3, items: 100, version: 'x' })).toContain('item count dropped');
    const noLab = structuredClone(raw());
    noLab.buildings = noLab.buildings.filter((b) => b.name !== 'Laboratory');
    expect(validateClashKing(normalizeClashKing(noLab, { version: 'x' }))).toBe('"laboratory" is missing');
  });
});

describe('GitHub release lookup (latest release, main as fallback)', () => {
  const get = (routes: Record<string, { status: number; body?: unknown }>) => (url: string) => {
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    const r = key ? routes[key] : { status: 404 };
    return { status: r.status, text: JSON.stringify(r.body ?? {}) };
  };
  it('uses the latest release tag when it has the file', () => {
    const r = resolveLatestWith(get({ '/releases/latest': { status: 200, body: { tag_name: 'v0.1.20' } }, '/commits/v0.1.20': { status: 200, body: { sha: 'c'.repeat(40) } }, 'ref=v0.1.20': { status: 200 } }), {});
    expect(r).toEqual({ ref: 'v0.1.20', tag: 'v0.1.20', commit: 'c'.repeat(40) });
    expect(clashKingVersion(r)).toBe('clashking-v0.1.20+ccccccc'); // tag + commit (REVIEW-2 #5)
    expect(versionLabel(clashKingVersion(r))).toBe('ClashKing v0.1.20'); // the UI shows the tag only
  });
  it('no release with the file → main, with the reason (a release pin is kept, see "release without the file")', () => {
    const main = { '/commits/main': { status: 200, body: { sha: 'd'.repeat(40) } } };
    expect(resolveLatestWith(get(main), {})).toEqual({ ref: 'main', commit: 'd'.repeat(40), releaseProblem: { reason: 'ClashKing has no release' } });
    const r = resolveLatestWith(get({ ...main, '/releases/latest': { status: 200, body: { tag_name: 'v2' } }, '/commits/v2': { status: 200, body: { sha: 'e'.repeat(40) } } }), {});
    expect(r).toMatchObject({ ref: 'main', releaseProblem: { tag: 'v2', reason: 'the latest ClashKing release "v2" has no static/static_data.json' } });
    expect(clashKingVersion({ commit: 'd'.repeat(40) })).toBe('clashking-main-ddddddd');
  });
  it("a GitHub error on the release's commit or contents throws instead of switching to main", () => {
    const rel = { '/releases/latest': { status: 200, body: { tag_name: 'v2' } }, '/commits/main': { status: 200, body: { sha: 'd'.repeat(40) } } };
    expect(() => resolveLatestWith(get({ ...rel, '/commits/v2': { status: 502 } }), {})).toThrow('HTTP 502');
    expect(() => resolveLatestWith(get({ ...rel, '/commits/v2': { status: 200, body: { sha: 'e'.repeat(40) } }, 'ref=v2': { status: 500 } }), {})).toThrow('HTTP 500');
  });
  it('a GitHub error is thrown (the caller keeps the pinned copy)', () => {
    expect(() => resolveLatestWith(get({ '/releases/latest': { status: 500 } }), {})).toThrow('HTTP 500');
  });
  it('the fetch child process: parses its JSON, reports a short error without the URL or headers', () => {
    const seen: Record<string, unknown>[] = [];
    const ok = ((_f: string, _a: string[], opts: Record<string, unknown>) => {
      seen.push(opts);
      return JSON.stringify({ status: 200, text: 'hi' });
    }) as never;
    expect(fetchTextSync('https://example.test/x', { Authorization: 'Bearer secret' }, ok)).toEqual({ status: 200, text: 'hi' });
    expect((seen[0].env as Record<string, string>).CK_URL).toBe('https://example.test/x');
    const bad = (() => {
      throw Object.assign(new Error('Command failed: node -e …'), { stderr: 'getaddrinfo ENOTFOUND' });
    }) as never;
    let msg = '';
    try {
      fetchTextSync('https://example.test/x', { Authorization: 'Bearer secret' }, bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe('network error (getaddrinfo ENOTFOUND)');
    expect(msg).not.toContain('secret');
  });
});

describe('daily data-update Action with ClashKing (fake GitHub + npm)', () => {
  const npm = (latest = '0.19.1'): SyncDeps => ({
    installedVersion: () => '0.19.1',
    latestInMajor: () => latest,
    install: () => {},
    check: () => ({ ok: true, warnings: [], maxTH: 18 }),
    readState: () => ({}),
    writeState: () => {},
    log: () => {},
  });

  it('a new ClashKing release → updated, commit message names it, cross-check included', () => {
    const f = fakeGitHub();
    const r = runDataUpdate({ sync: npm(), clashKing: f.deps, loadData: () => mini(), crossCheck: () => ['Cross-check: …'] });
    expect(r).toMatchObject({ status: 'updated', clashKingFrom: V_OLD, clashKingTo: V_NEW, crossCheck: ['Cross-check: …'] });
    expect(r.commitMessage).toBe('data: ClashKing v1.0.0 → v1.0.1 (1 change)');
    expect(fullCommitMessage({ ck: ['clashking-v1', 'clashking-v2'], coc: ['0.19.1', '0.20.0'], changes: 3 })).toBe('data: ClashKing v1 → v2, clash-of-clans-data 0.19.1 → 0.20.0 (3 changes)');
  });

  it('nothing new on either side → none', () => {
    const r = runDataUpdate({ sync: npm(), clashKing: fakeGitHub({ latest: OLD }).deps, loadData: () => mini() });
    expect(r.status).toBe('none');
  });

  it('a new clash-of-clans-data alone (images / backup) commits without a game-data diff', () => {
    const r = runDataUpdate({ sync: npm('0.20.0'), clashKing: fakeGitHub({ latest: OLD }).deps, loadData: () => mini() });
    expect(r).toMatchObject({ status: 'updated', changes: [], commitMessage: 'data: clash-of-clans-data 0.19.1 → 0.20.0 (0 changes)' });
  });

  it('a bad ClashKing file fails the update: known-good copy kept, issue titled with the version', () => {
    const f = fakeGitHub({ file: 'not json' });
    const r = runDataUpdate({ sync: npm(), clashKing: f.deps, loadData: () => mini() });
    expect(r).toMatchObject({ status: 'failed', failedStep: 'ClashKing load + validate the new data', clashKingTo: V_NEW });
    expect(issueTitle(r)).toBe(`Data update failed: ${V_NEW}`);
    expect(f.pinned()!.pin.version).toBe(V_OLD);
    expect(issueTitle(runDataUpdate({ sync: npm(), clashKing: fakeGitHub({ latest: new Error('503') }).deps, loadData: () => mini() }))).toBe('Data update failed: ClashKing check');
  });
});

describe('predev refresh: ClashKing check', () => {
  function deps(o: Partial<RefreshDeps> = {}, state: RefreshState = {}) {
    const logs: string[] = [];
    const calls: string[] = [];
    let s = state;
    const d: RefreshDeps = {
      now: () => 10 * DAY * 1000,
      readState: () => s,
      writeState: (x) => void (s = x),
      installedVersion: () => '0.19.1',
      latestVersion: () => '0.19.1',
      runSync: () => void calls.push('sync'),
      metaGeneratedAt: () => undefined,
      hasToken: () => false,
      runMeta: () => ({ code: 0, stderr: '' }),
      clashKingPinned: () => OLD.commit,
      clashKingLatest: () => ({ commit: NEW.commit, version: V_NEW }),
      log: (l) => logs.push(l),
      ...o,
    };
    return { d, logs, calls, state: () => s };
  }

  it('a newer ClashKing release than the pinned commit runs the full sync', () => {
    const f = deps();
    expect(refreshGameData(f.d)).toBe('synced');
    expect(f.calls).toEqual(['sync']);
    expect(f.logs[0]).toContain('ClashKing v1.0.1 (bbbbbbb) is out (pinned: aaaaaaa)');
  });

  it('same commit and same npm version → up to date', () => {
    const f = deps({ clashKingLatest: () => ({ commit: OLD.commit, version: V_OLD }) });
    expect(refreshGameData(f.d)).toBe('up-to-date');
    expect(f.calls).toEqual([]);
  });

  it('a recorded ClashKing failure warns on every start and is not retried automatically', () => {
    const f = deps({}, { clashKingFailure: { version: V_NEW, reason: 'max TH dropped', at: 0 } });
    expect(refreshGameData(f.d)).toBe('known-bad');
    expect(f.logs[0]).toContain("ClashKing v1.0.1 can't be used (max TH dropped); staying on the pinned known-good copy");
    expect(f.calls).toEqual([]);
  });

  it('running on the backup warns on every start', () => {
    const f = deps({ backupWarning: () => backupWarning('x'), clashKingLatest: () => ({ commit: OLD.commit, version: 'v' }) });
    refreshGameData(f.d);
    expect(f.logs[0]).toContain('using the clash-of-clans-data backup');
  });

  it('GitHub unreachable: one warning line, the npm check still runs', () => {
    const f = deps({
      clashKingLatest: () => {
        throw new Error('network error (ENOTFOUND)');
      },
    });
    expect(refreshGameData(f.d)).toBe('up-to-date');
    expect(f.logs[0]).toBe('[refresh] warning: ClashKing check skipped (network error (ENOTFOUND)); starting the site anyway.');
  });
});

describe('cross-check report (ClashKing vs clash-of-clans-data)', () => {
  it('lists cost / time / TH differences, items and levels only one side has, and who has the higher max TH', () => {
    const a = mini();
    const b2 = structuredClone(FULL);
    const cannon = b2.buildings.find((x: any) => x.name === 'Cannon');
    cannon.levels[1].build_cost = 1500;
    cannon.levels[1].build_time = 60;
    cannon.levels[1].required_townhall = 1;
    b2.troops = b2.troops.filter((t: any) => t.name !== 'Wall Wrecker');
    const th = b2.buildings.find((x: any) => x.name === 'Town Hall');
    th.levels = th.levels.slice(0, 2);
    const b = normalizeClashKing(trimClashKing(b2), { version: '0.19.1' });
    const r = crossCheck(a, b);
    expect(r.higherMaxTH).toBe('clashking');
    expect(r.onlyClashKing.map((x) => x.name)).toEqual(['Wall Wrecker']);
    expect(r.levelsOnlyClashKing).toEqual([{ key: '1000001', name: 'Town Hall', levels: [3] }]);
    expect(r.diffs.filter((d) => d.item === 'Cannon').map((d) => `${d.level} ${d.field}: ${d.clashking} / ${d.cocData}`)).toEqual(['2 cost: 1K gold / 1.5K gold', '2 time: 30s / 1m', '2 th: TH2 / TH1']);
    const lines = crossCheckLines(r);
    expect(lines[1]).toBe('  Max TH: ClashKing is ahead (TH3 vs TH2).');
    expect(lines.join('\n')).toContain('Only in ClashKing: Wall Wrecker');
    expect(lines.join('\n')).toMatch(/Differences on shared levels: \d+ \(\d+ cost, \d+ time, \d+ TH requirement\)/);
    expect(crossCheck(a, a).diffs).toEqual([]);
  });

  it('levelInfo still finds levels in ClashKing items', () => {
    expect(levelInfo(mini().byId.get('cannon')!, 3)!.cost).toBe(5000);
  });
});

// ── REVIEW-2 #5, #8, #9, ambiguity 10 ──
const npmSame = (): SyncDeps => ({
  installedVersion: () => '0.19.1',
  latestInMajor: () => '0.19.1',
  install: () => {},
  check: () => ({ ok: true, warnings: [], maxTH: 18 }),
  readState: () => ({}),
  writeState: () => {},
  log: () => {},
});

describe('data identity = tag + commit (REVIEW-2 #5)', () => {
  const memIO = (initial: Record<string, Snapshot> = {}) => {
    const files = new Map(Object.entries(initial));
    let changes: unknown;
    const io: SnapshotIO = {
      list: () => [...files.keys()],
      read: (n) => files.get(n)!,
      write: (n, s) => void files.set(n, s),
      remove: (n) => void files.delete(n),
      writeChanges: (f) => void (changes = f),
    };
    return { io, files, changes: () => changes };
  };

  it('a re-pointed tag (same tag, new commit) is a new version: snapshot + diff, not "no diff was produced"', () => {
    const before = toSnapshot(normalizeClashKing(raw(), { version: clashKingVersion({ tag: 'v0.1.20', commit: '04babd0'.padEnd(40, '0') }) }), '2026-11-16');
    const changed = structuredClone(FULL);
    changed.buildings.find((b: any) => b.name === 'Cannon').levels[2].build_cost = 4000;
    const after = toSnapshot(normalizeClashKing(trimClashKing(changed), { version: clashKingVersion({ tag: 'v0.1.20', commit: 'f'.repeat(40) }) }), '2026-11-17');
    expect(before.version).toBe('clashking-v0.1.20+04babd0');
    expect(after.version).toBe('clashking-v0.1.20+fffffff');
    const m = memIO({ [snapshotFileName(before)]: before });
    const r = recordSnapshot(m.io, after, () => {});
    expect(r.written).toBe(true);
    expect(r.changes!.map((c) => c.text)).toContain('Cannon 3: 5K gold → 4K gold');
    expect(m.changes()).toMatchObject({ version: 'clashking-v0.1.20+fffffff', previousVersion: 'clashking-v0.1.20+04babd0' });
  });

  it('the Action: same tag at a new commit → updated, with the commits in the commit message', () => {
    const f = fakeGitHub({ latest: { ...OLD, commit: 'f'.repeat(40) } });
    const deps: ClashKingDeps = {
      ...f.deps,
      snapshot: () => ({ file: 'x', written: true, changes: [{ kind: 'cost', key: '1', item: 'Cannon', level: 3, text: 'Cannon 3: 5K gold → 4K gold' }] }),
    };
    const r = runDataUpdate({ sync: npmSame(), clashKing: deps, loadData: () => mini() });
    expect(r).toMatchObject({ status: 'updated', clashKingFrom: V_OLD, clashKingTo: 'clashking-v1.0.0+fffffff' });
    expect(r.commitMessage).toBe('data: ClashKing v1.0.0+aaaaaaa → v1.0.0+fffffff (1 change)');
  });

  it('old pins (version = tag only) get the identity from their tag + commit; the UI shows the tag only', () => {
    expect(pinVersion({ tag: 'v0.1.20', commit: '04babd0'.padEnd(40, '1'), version: 'clashking-v0.1.20' })).toBe('clashking-v0.1.20+04babd0');
    expect(pinVersion({ commit: '', version: 'clashking-v9.9.9' })).toBe('clashking-v9.9.9');
    expect(dataSourceLabel({ source: 'clashking', version: 'clashking-v0.1.20+04babd0' })).toBe('ClashKing v0.1.20');
    expect(dataSourceLabel({ source: 'clashking', version: 'clashking-main-04babd0' })).toBe('ClashKing main@04babd0');
    expect(versionLabel('0.19.1')).toBe('clash-of-clans-data 0.19.1');
  });

  it('the committed pin and data-changes.json use the identity, so the banner still matches', () => {
    const pin = JSON.parse(fs.readFileSync(path.join(CK_DIR, 'pin.json'), 'utf8')) as ClashKingPin;
    expect(pin.version).toBe(pinVersion(pin));
    if (!process.env.CK_DATA_DIR) {
      const dc = JSON.parse(fs.readFileSync('public/data-changes.json', 'utf8'));
      expect(dc.version).toBe(data.version);
    }
  });
});

describe('issue titles name the ClashKing version whenever it changed (REVIEW-2 #8)', () => {
  const base = { from: '0.19.1', to: '0.19.1', clashKingFrom: 'clashking-v0.1.20+04babd0', clashKingTo: 'clashking-v0.1.21+abcdef0' };
  it('a ClashKing update failing after the check (tests, commit, deploy): the ClashKing version', () => {
    expect(issueTitle(base)).toBe('Data update failed: clashking-v0.1.21+abcdef0');
    expect(issueTitle({ ...base, failedStep: 'snapshot + diff' })).toBe('Data update failed: clashking-v0.1.21+abcdef0');
  });
  it('both changed: both named', () => {
    expect(issueTitle({ ...base, to: '0.20.0' })).toBe('Data update failed: clashking-v0.1.21+abcdef0, clash-of-clans-data 0.20.0');
  });
  it('only clash-of-clans-data changed: its version; nothing known: the check names', () => {
    expect(issueTitle({ ...base, clashKingTo: base.clashKingFrom, to: '0.20.0' })).toBe('Data update failed: 0.20.0');
    expect(issueTitle({ failedStep: 'ClashKing check (GitHub)', from: '0.19.1', to: '0.19.1', clashKingFrom: 'clashking-v0.1.20+04babd0' })).toBe('Data update failed: ClashKing check');
    expect(issueTitle({ failedStep: 'npm registry check', from: '0.19.1' })).toBe('Data update failed: npm check');
  });
});

describe('release tags are validated and slugged (REVIEW-2 #9)', () => {
  it('a tag outside [A-Za-z0-9._-] is treated as no tag: main-<sha7>, and not stored as the pin tag', () => {
    expect(clashKingVersion({ tag: 'v0.2/beta', commit: 'c'.repeat(40) })).toBe('clashking-main-ccccccc');
    expect(clashKingVersion({ tag: 'v1"); rm -rf ("', commit: 'c'.repeat(40) })).toBe('clashking-main-ccccccc');
    const f = fakeGitHub({ latest: { ref: 'v2/beta', tag: 'v2/beta', commit: 'b'.repeat(40) } });
    const r = syncClashKing(f.deps);
    expect(r.to).toBe('clashking-main-bbbbbbb');
    expect(f.pinned()!.pin.tag).toBeUndefined();
    expect(f.logs.some((l) => l.includes("isn't a plain name"))).toBe(true);
  });
  it('snapshot file names stay one file inside data/snapshots/', () => {
    expect(snapshotFileName({ date: '2026-11-17', version: 'clashking-v0.2/beta"x' })).toBe('2026-11-17_clashking-v0.2-beta-x.json');
    expect(versionSlug('clashking-v0.1.20+04babd0')).toBe('clashking-v0.1.20+04babd0');
  });
});

describe('no release has the file: the release pin stays (REVIEW-2 ambiguity 10)', () => {
  const main = { ref: 'main', commit: 'c'.repeat(40), releaseProblem: { tag: 'v1.0.2', reason: 'the latest ClashKing release "v1.0.2" has no static/static_data.json' } };
  it('keeps the pin, downloads nothing, records the failure', () => {
    const f = fakeGitHub({ latest: main as never });
    const r = syncClashKing(f.deps);
    expect(r).toMatchObject({ outcome: 'release-missing-file', from: V_OLD, to: 'clashking-v1.0.2' });
    expect(r.reason).toContain('keeping the release pin');
    expect(f.calls).toEqual(['resolve']);
    expect(f.pinned()!.pin.version).toBe(V_OLD);
    expect(f.state().clashKingFailure).toMatchObject({ version: 'clashking-main-ccccccc' });
  });
  it('the Action fails with a stable issue title (one issue, updated daily, not one per main commit)', () => {
    const f = fakeGitHub({ latest: main as never });
    const r = runDataUpdate({ sync: npmSame(), clashKing: f.deps, loadData: () => mini() });
    expect(r).toMatchObject({ status: 'failed', failedStep: 'ClashKing release check' });
    expect(issueTitle(r)).toBe('Data update failed: clashking-v1.0.2');
  });
  it('nothing pinned yet: main is still followed', () => {
    const f = fakeGitHub({ latest: main as never, pinned: false });
    expect(syncClashKing(f.deps).outcome).toBe('updated');
  });
});
