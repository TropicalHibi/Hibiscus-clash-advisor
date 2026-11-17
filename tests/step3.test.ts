// Step 3 (SPEC §9, §10.1, §11, §13): sync snapshots + diff, helpers and boosts in the scheduler, the
// Everything tab engine, hero order, id overrides and item image selection.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recordSnapshot, KEEP_SNAPSHOTS, type SnapshotIO } from '../scripts/lib/snapshots';
import { syncData, type DataCheck, type SyncDeps } from '../scripts/lib/sync';
import { itemImagesModule, pickItemImages } from '../src/data/itemImages';
import { levelInfo } from '../src/data/normalize';
import { diffSnapshots, toSnapshot, type DataChangesFile, type Snapshot } from '../src/data/snapshot';
import type { Item } from '../src/data/types';
import { WorkClock, helperGain } from '../src/engine/boosts';
import { buildEverything } from '../src/engine/everything';
import { fmtDuration, fmtNum } from '../src/engine/format';
import { buildPlan } from '../src/engine/plan';
import { planToText } from '../src/engine/planText';
import { renderPlan } from '../src/ui/planView';
import { simulate, type SimResult, type TimelineEntry } from '../src/engine/scheduler';
import { builderCandidates } from '../src/engine/tiers';
import { EMPTY_META } from '../src/meta/meta';
import { parseBoosts, parseExport } from '../src/state/parseExport';
import { coerceSettings, DEFAULT_HERO_ORDER, heroOrder, LOCKED_HERO, moveHero, settingsFromYaml } from '../src/state/settings';
import { addTownHallLevel, data, makeExport, maxLab, modifiedData, parse, rawItem, setLevel, settings, T0, type Entry, type SyntheticExport } from './helpers';

const H = 3600;
const D = 86400;
const sim = (ex: SyntheticExport, s = settings(), nowSec = T0, horizonSec = D) => simulate(data, parse(ex), s, EMPTY_META, { nowSec, horizonSec });
const entryFor = (r: SimResult, itemId: string) => r.timeline.find((e) => e.itemKey === data.byId.get(itemId)!.key)!;
const shape = (t: TimelineEntry[]) => t.map((e) => `${e.slotId}|${e.itemKey}|${e.toLevel}|${e.start}|${e.end}`).sort();

const APPRENTICE = 93000000;
const ASSISTANT = 93000001;
const ALCHEMIST = 93000002; // ClashKing's dataId (clash-of-clans-data had none; the old id-overrides.yaml said 93000003)
const helper = (dataId: number, lvl: number, cooldown?: number) => ({ data: dataId, lvl, ...(cooldown !== undefined ? { helper_cooldown: cooldown } : {}) }) as unknown as Entry;

/** TH16, Lab maxed, BK upgrading with `bkTimer` seconds left (raw), and Archer researching `archerTimer`. */
function baseExport(o: { bkTimer?: number; archerTimer?: number } = {}): SyntheticExport {
  const ex = maxLab(makeExport(16));
  if (o.bkTimer) setLevel(ex, 'heroes', 'barbarian-king', { timer: o.bkTimer });
  if (o.archerTimer) setLevel(ex, 'units', 'archer', { timer: o.archerTimer });
  return ex;
}

// ── §10.1 helpers ──
describe('helpers in the scheduler', () => {
  it('Builder Apprentice: one work hour takes its work rate (hours) off the job it repeats on', () => {
    const ex = baseExport({ bkTimer: 2 * D });
    setLevel(ex, 'heroes', 'barbarian-king', { helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push(helper(APPRENTICE, 8, H)); // works 1 h after the export
    const off = entryFor(sim(ex, settings({ simulateHelpers: false })), 'barbarian-king');
    const on = entryFor(sim(ex), 'barbarian-king');
    expect(off.end).toBe(2 * D);
    expect(on.end).toBe(2 * D - 8 * H); // level 8 → workRate 8 → 8 h of progress
    expect(on.helperSavedSec).toBe(8 * H);
  });

  it('Builder Apprentice without a recurrent target: helps the highest-priority builder job, longest remaining on ties (never a Goblin)', () => {
    const ex = baseExport({ bkTimer: 2 * D });
    ex.helpers.push(helper(APPRENTICE, 4, H));
    const off = sim(ex, settings({ simulateHelpers: false }));
    const on = sim(ex);
    const helped = on.timeline.filter((e) => e.helperSavedSec);
    expect(helped).toHaveLength(1);
    expect(helped[0].helperSavedSec).toBe(4 * H);
    const builders = new Set(off.slots.filter((s) => s.queue === 'builder' && !s.goblin).map((s) => s.id));
    const runningAt = off.timeline.filter((e) => builders.has(e.slotId) && e.start <= H && e.end > H);
    // The running Barbarian King (export) is a hero: tier 3 in rush mode. New jobs carry their candidate tier.
    const key = (e: TimelineEntry) => (e.itemKey === data.byId.get('town-hall')!.key ? -1 : (e.tier ?? 3));
    const best = [...runningAt].sort((x, y) => key(x) - key(y) || y.end - x.end)[0];
    expect(key(best)).toBeLessThan(3); // a higher tier than the King's beats his longer timer
    expect(`${helped[0].slotId}|${helped[0].itemKey}`).toBe(`${best.slotId}|${best.itemKey}`);
    expect(helped[0].end).toBe(best.end - 4 * H);
    expect(on.helperSuggestions).toEqual([]); // nothing set to repeat → nothing to suggest
  });

  it('a repeating helper on a running upgrade is respected even when the planner would pick another job; the plan suggests the switch', () => {
    const ex = baseExport({ bkTimer: 3 * D });
    setLevel(ex, 'buildings', 'town-hall', { timer: 5 * D }); // TH16 → 17 upgrading: the planner's pick
    setLevel(ex, 'heroes', 'barbarian-king', { helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push(helper(APPRENTICE, 8, H));
    const r = sim(ex);
    expect(entryFor(r, 'barbarian-king').helperSavedSec).toBe(8 * H); // the timeline follows the export
    expect(entryFor(r, 'town-hall').helperSavedSec).toBeUndefined();
    expect(r.helperSuggestions).toHaveLength(1);
    expect(r.helperSuggestions[0]).toMatchObject({ at: H, repeating: { itemName: 'Barbarian King' }, suggested: { itemName: 'Town Hall', toLevel: 17 } });
    const plan = buildPlan(data, parse(ex), settings(), EMPTY_META, T0);
    expect(plan.helperSuggestions).toEqual(['Apprentice: repeating on Barbarian King. Suggest switching to Town Hall 17 after Barbarian King finishes (or now).']);
    expect(renderPlan(plan)).toContain('Apprentice: repeating on Barbarian King. Suggest switching to Town Hall 17');
    expect(planToText(plan)).toContain('Suggestion: Apprentice: repeating on Barbarian King.');
  });

  it('no suggestion when the repeat target is what the planner would pick (Town Hall first)', () => {
    const ex = baseExport({ bkTimer: 3 * D });
    setLevel(ex, 'buildings', 'town-hall', { timer: 5 * D, helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push(helper(APPRENTICE, 8, H));
    const r = sim(ex);
    expect(entryFor(r, 'town-hall').helperSavedSec).toBe(8 * H);
    expect(r.helperSuggestions).toEqual([]);
    const plan = buildPlan(data, parse(ex), settings(), EMPTY_META, T0);
    expect(plan.helperSuggestions).toEqual([]);
    expect(renderPlan(plan)).not.toContain('helper-suggestion');
  });

  it('once the repeated upgrade finishes, the planner picks the target (new jobs never inherit the repeat setting)', () => {
    const ex = baseExport({ bkTimer: 12 * H });
    setLevel(ex, 'buildings', 'town-hall', { timer: 5 * D });
    setLevel(ex, 'heroes', 'barbarian-king', { helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push(helper(APPRENTICE, 8, H)); // hours at +1 h (King running), +24 h and +47 h (King done)
    const r = sim(ex, settings(), T0, 2 * D);
    const king = r.timeline.filter((e) => e.itemKey === data.byId.get('barbarian-king')!.key);
    expect(king[0].inProgress && king[0].helperSavedSec).toBe(8 * H);
    for (const k of king.slice(1)) expect(k.helperSavedSec).toBeUndefined(); // a later King job: no repeat
    expect(entryFor(r, 'town-hall').helperSavedSec).toBe(2 * 8 * H); // later hours: the planner's pick
  });

  it('a repeat target that has finished before the work hour counts as nothing set: planner pick, no suggestion', () => {
    const ex = baseExport({ bkTimer: 30 * 60 });
    setLevel(ex, 'buildings', 'town-hall', { timer: 5 * D });
    setLevel(ex, 'heroes', 'barbarian-king', { helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push(helper(APPRENTICE, 8, H));
    const r = sim(ex);
    expect(entryFor(r, 'town-hall').helperSavedSec).toBe(8 * H);
    expect(r.helperSuggestions).toEqual([]);
  });

  it('Lab Assistant repeating on the running research: works on it, no suggestion', () => {
    const ex = baseExport({ archerTimer: 3 * D });
    setLevel(ex, 'units', 'archer', { helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push(helper(ASSISTANT, 6, 0));
    const r = sim(ex);
    expect(entryFor(r, 'archer').end).toBe(3 * D - 2 * 6 * H);
    expect(r.helperSuggestions).toEqual([]);
  });

  it('Lab Assistant: shortens the running research by its work rate, once per 23-hour cycle', () => {
    const ex = baseExport({ archerTimer: 3 * D });
    ex.helpers.push(helper(ASSISTANT, 7, 0)); // ready now
    const off = entryFor(sim(ex, settings({ simulateHelpers: false })), 'archer');
    const on = entryFor(sim(ex), 'archer');
    expect(off.end).toBe(3 * D);
    expect(on.end).toBe(3 * D - 2 * 7 * H); // work hours at now and now + 23 h (both in the 24 h window)
    expect(on.slotId).toBe('LAB');
  });

  it('a job that ends inside the work hour finishes early at 1 + rate speed (not below the hour start)', () => {
    expect(helperGain(8, 4.5 * H)).toBe(4 * H); // 4.5 h left at 9× speed → done in 0.5 h, gaining 4 h
    expect(helperGain(8, 20 * H)).toBe(8 * H);
  });

  it('helper_timer on an upgrade = a helper already working: adds the rest of its hour', () => {
    const ex = baseExport({ bkTimer: 2 * D });
    setLevel(ex, 'heroes', 'barbarian-king', { helper_timer: 1800 } as Partial<Entry>);
    ex.helpers.push(helper(APPRENTICE, 6, 23 * H));
    expect(entryFor(sim(ex), 'barbarian-king').end).toBe(2 * D - 6 * 1800);
  });

  it('work hours between the export and now count for jobs that were running then', () => {
    const ex = baseExport({ bkTimer: 4 * D });
    setLevel(ex, 'heroes', 'barbarian-king', { helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push(helper(APPRENTICE, 8, H));
    // Two days after the export: hours at +1 h, +24 h and +47 h have passed (23 h cycle) → 24 h saved, so
    // 2 days − 24 h = 24 h of work left at now. The next hour (export + 70 h = now + 22 h) finds 2 h left:
    // at 9× speed it finishes in 2/9 h, saving 16/9 h.
    const r = sim(ex, settings(), T0 + 2 * D);
    expect(entryFor(r, 'barbarian-king').end).toBe(22 * H + (2 * H) / 9);
    expect(entryFor(r, 'barbarian-king').helperSavedSec).toBeCloseTo(3 * 8 * H + (16 * H) / 9, 6);
  });

  it('a recurrent assistant target that is not researching falls back to the running research', () => {
    const ex = baseExport({ archerTimer: 3 * D });
    setLevel(ex, 'units', 'barbarian', { helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push(helper(ASSISTANT, 5, 0));
    expect(entryFor(sim(ex), 'archer').end).toBe(3 * D - 2 * 5 * H); // hours at now and now + 23 h
  });
});

// ── §10.1 boosts ──
describe('active boosts', () => {
  it('a Builder Potion (10×) running at the export speeds up every builder job while it lasts', () => {
    const ex = baseExport({ bkTimer: 2 * D });
    ex.boosts = { builder_boost: H };
    const r = sim(ex);
    // 1 h at 10× = 10 h of work in the first hour.
    expect(entryFor(r, 'barbarian-king').end).toBe(H + (2 * D - 10 * H));
    const started = r.timeline.find((e) => !e.inProgress && e.start === 0 && e.slotId.startsWith('B') && (e.rawTimeSec ?? 0) > 10 * H)!;
    expect(started.end - started.start).toBe(Math.round(started.rawTimeSec!) - 9 * H);
  });

  it('a Research Potion (24×) speeds up research, not builders', () => {
    const ex = baseExport({ bkTimer: 2 * D, archerTimer: 3 * D });
    ex.boosts = { lab_boost: H };
    const r = sim(ex);
    expect(entryFor(r, 'archer').end).toBe(H + 3 * D - 24 * H);
    expect(entryFor(r, 'barbarian-king').end).toBe(2 * D);
  });

  it('a boost that ran out before now only counts for the part before now', () => {
    const ex = baseExport({ bkTimer: 2 * D });
    ex.boosts = { builder_boost: H };
    expect(entryFor(sim(ex, settings(), T0 + 2 * H), 'barbarian-king').end).toBe(2 * D - 9 * H - 2 * H);
  });

  it('WorkClock: end() and remaining() invert each other across a window', () => {
    const c = new WorkClock([{ from: -100, to: 3600, extra: 9 }]);
    for (const [s, w] of [[0, 100], [0, 40000], [3000, 10000], [5000, 7000]]) expect(c.remaining(s, c.end(s, w))).toBeCloseTo(w, 6);
  });

  it('"Simulate helpers" off = the old behaviour (raw timers, no helpers, no boosts)', () => {
    const ex = baseExport({ bkTimer: 2 * D, archerTimer: 3 * D });
    setLevel(ex, 'heroes', 'barbarian-king', { helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push(helper(APPRENTICE, 8, H), helper(ASSISTANT, 7, 0));
    ex.boosts = { builder_boost: 1800, lab_boost: 900, builder_consumable: 600, lab_consumable: 600 };
    const plain: SyntheticExport = { ...structuredClone(ex), helpers: [], boosts: {} };
    const off = sim(ex, settings({ simulateHelpers: false }), T0, 7 * D);
    expect(shape(off.timeline)).toEqual(shape(sim(plain, settings(), T0, 7 * D).timeline));
    expect(off.helpers).toEqual([]);
    expect(off.activeBoosts).toEqual([]);
    expect(shape(sim(ex, settings(), T0, 7 * D).timeline)).not.toEqual(shape(off.timeline));
  });
});

// ── export parsing: boosts, helpers, Alchemist ──
describe('export: boosts and helpers', () => {
  it('reads the coc.py boost keys; unknown keys and shapes are warnings, not errors', () => {
    const w: string[] = [];
    const r = parseBoosts({ builder_boost: 10, lab_boost: 20, clocktower_boost: 30, builder_consumable: 40, lab_consumable: 50, clocktower_cooldown: 60, helper_cooldown: 70, mystery: 1 }, w);
    expect(r.boosts).toEqual({ builderPotionSec: 10, researchPotionSec: 20, petPotionSec: 0, clockTowerSec: 30, builderSnackSec: 40, researchSnackSec: 50, clockTowerCooldownSec: 60 });
    expect(r.helperCooldownSec).toBe(70);
    expect(w).toEqual([expect.stringContaining('Unknown boost "mystery"')]);
    for (const bad of [[1, 2], 'x', 5]) {
      const ww: string[] = [];
      expect(parseBoosts(bad, ww).boosts.builderPotionSec).toBe(0);
      expect(ww[0]).toContain('unexpected shape');
    }
    const ww: string[] = [];
    parseBoosts({ builder_boost: 'soon' }, ww);
    expect(ww[0]).toContain('unexpected value');
  });

  it('parses helpers (shared cooldown, both recurrent spellings) and resolves the Alchemist from the ClashKing dataId', () => {
    const ex = baseExport({ bkTimer: D });
    ex.helpers.push(helper(APPRENTICE, 8, 8426), helper(ASSISTANT, 7, 8426), helper(ALCHEMIST, 1, 8426));
    setLevel(ex, 'heroes', 'barbarian-king', { helper_recurrent: true } as Partial<Entry>);
    setLevel(ex, 'units', 'archer', { recurrent_helper: true } as Partial<Entry>);
    const acc = parse(ex);
    expect(acc.unresolved).toEqual([]);
    expect(acc.helpers.map((h) => `${h.id}:${h.level}`)).toEqual(['builders-apprentice:8', 'lab-assistant:7', 'alchemist:1']);
    expect(acc.helperCooldownSec).toBe(8426);
    expect(acc.instances.filter((i) => i.helperRecurrent).map((i) => data.items.get(i.itemKey)!.id).sort()).toEqual(['archer', 'barbarian-king']);
    expect(data.byDataId.get(ALCHEMIST)?.id).toBe('alchemist');
    expect(data.byId.get('builders-apprentice')!.helperWorkRates![8]).toBe(8);
  });

  it('the plan shows a boost warning instead of crashing on an unknown boost', () => {
    const ex = baseExport();
    ex.boosts = { future_boost: 5 };
    const plan = buildPlan(data, parse(ex), settings(), EMPTY_META, T0);
    expect(plan.warnings.some((w) => w.includes('future_boost'))).toBe(true);
  });

  it('the real export (if present) resolves the helpers (incl. the Alchemist) and has a helper line', () => {
    const file = 'samples/myexport.json';
    if (!fs.existsSync(file)) return;
    const acc = parseExport(fs.readFileSync(file, 'utf8'), data);
    expect(acc.unresolved.filter((u) => u.section === 'helpers')).toEqual([]);
    const plan = buildPlan(data, acc, settings(), EMPTY_META, acc.exportTimestamp!);
    expect(plan.helperLine).toContain("Builder's Apprentice");
  });
});

// ── §9 snapshots + diff ──
describe('npm run sync: snapshots and diff', () => {
  const base = { ...toSnapshot(data, '2026-11-16'), version: '0.19.1' };
  const cannon = data.byId.get('cannon')!;
  const top = cannon.levels[cannon.levels.length - 1];
  const changed = modifiedData((raw) => {
    const l = rawItem(raw, 'cannon').levels.find((x: any) => x.level === top.level);
    l.build_cost = top.cost - 1_000_000;
    l.build_time = 26 * 3600;
    addTownHallLevel(raw); // NEW: Town Hall <max+1>
    raw.pets = raw.pets.filter((p) => p.name !== 'L.A.S.S.I'); // REMOVED ITEM
    const archer = rawItem(raw, 'archer');
    raw.troops.push({ ...structuredClone(archer), name: 'Test Troop', _id: 4999999 });
  });
  const next = { ...toSnapshot(changed, '2026-11-20'), version: '0.20.0' };
  const changes = diffSnapshots(base, next);
  const texts = changes.map((c) => c.text);

  it('cost and time changes per level', () => {
    expect(texts).toContain(`Cannon ${top.level}: ${fmtNum(top.cost)} gold → ${fmtNum(top.cost - 1_000_000)} gold`);
    expect(texts).toContain(`Cannon ${top.level}: ${fmtDuration(top.timeSec)} → 1d 2h`);
  });

  it('new levels, new items and removed items', () => {
    expect(texts.some((t) => t.startsWith(`NEW: Town Hall ${data.maxTH + 1} (`))).toBe(true);
    expect(texts).toContain('REMOVED ITEM: L.A.S.S.I');
    expect(texts.some((t) => t.startsWith('NEW ITEM: Test Troop'))).toBe(true);
    expect(changes.find((c) => c.kind === 'newItem')!.key).toBe('4999999');
  });

  it('no changes between identical data', () => {
    expect(diffSnapshots(base, { ...toSnapshot(data, '2026-11-17'), version: '0.19.1' })).toEqual([]);
  });

  it('the snapshot holds the Item model only (no raw JSON, no image paths)', () => {
    const it0 = base.items.find((i) => i.key === cannon.key)!;
    expect(Object.keys(it0)).not.toContain('images');
    expect(it0.levels[0]).toHaveProperty('timeSec');
    expect(JSON.stringify(base)).not.toContain('"buildCost"');
    expect(JSON.stringify(base)).not.toContain('"build_cost"');
  });

  function memIO(initial: Record<string, Snapshot> = {}) {
    const files = new Map(Object.entries(initial));
    let changesFile: DataChangesFile | undefined;
    const io: SnapshotIO = {
      list: () => [...files.keys()],
      read: (n) => files.get(n)!,
      write: (n, s) => void files.set(n, s),
      remove: (n) => void files.delete(n),
      writeChanges: (f) => void (changesFile = f),
    };
    return { io, files, changes: () => changesFile };
  }

  it('first snapshot: written, nothing to compare with', () => {
    const m = memIO();
    const logs: string[] = [];
    const r = recordSnapshot(m.io, base, (l) => logs.push(l));
    expect(r).toMatchObject({ written: true, file: '2026-11-16_0.19.1.json' });
    expect(m.changes()).toBeUndefined();
    expect(logs.join('\n')).toContain('No earlier snapshot');
  });

  it('same version again: not rewritten, no diff', () => {
    const m = memIO({ '2026-11-10_0.19.1.json': base });
    expect(recordSnapshot(m.io, base, () => {}).written).toBe(false);
    expect([...m.files.keys()]).toEqual(['2026-11-10_0.19.1.json']);
  });

  it('new version: prints the diff, saves data-changes.json and keeps the newest snapshots', () => {
    const m = memIO({ '2026-10-01_0.18.0.json': { ...base, version: '0.18.0' }, '2026-11-16_0.19.1.json': base });
    const logs: string[] = [];
    const r = recordSnapshot(m.io, next, (l) => logs.push(l));
    expect(r.previous).toBe('2026-11-16_0.19.1.json');
    expect(m.changes()).toMatchObject({ version: '0.20.0', previousVersion: '0.19.1', date: '2026-11-20' });
    expect(m.changes()!.changes.length).toBe(changes.length);
    expect(logs.some((l) => l.includes(`Game data changes 0.19.1 → 0.20.0: ${changes.length}`))).toBe(true);
    expect(logs.some((l) => l.includes('Max TH changed'))).toBe(true);
    expect([...m.files.keys()].sort()).toEqual(['2026-11-16_0.19.1.json', '2026-11-20_0.20.0.json']);
    expect(KEEP_SNAPSHOTS).toBe(2);
  });

  function fake(o: { snapshot?: () => void } = {}) {
    const logs: string[] = [];
    const calls: string[] = [];
    const d: SyncDeps = {
      installedVersion: () => '0.19.1',
      latestInMajor: () => {
        calls.push('view');
        return '0.19.1';
      },
      install: () => calls.push('install'),
      check: (): DataCheck => ({ ok: true, warnings: [], maxTH: 18 }),
      readState: () => ({}),
      writeState: () => {},
      snapshot: o.snapshot ?? (() => calls.push('snapshot')),
      log: (l) => logs.push(l),
    };
    return { d, logs, calls };
  }

  it('sync runs the snapshot after validation; --offline never calls npm', () => {
    const f = fake();
    expect(syncData(f.d)).toBe('up-to-date');
    expect(f.calls).toEqual(['view', 'snapshot']);
    const g = fake();
    expect(syncData(g.d, { offline: true })).toBe('up-to-date');
    expect(g.calls).toEqual(['snapshot']);
  });

  it('a snapshot failure is a warning, not a failed sync', () => {
    const f = fake({
      snapshot: () => {
        throw new Error('disk full');
      },
    });
    expect(syncData(f.d)).toBe('up-to-date');
    expect(f.logs.some((l) => l.includes('snapshot/diff failed: disk full'))).toBe(true);
  });
});

// ── §11.4 Everything tab ──
describe('Everything tab engine', () => {
  const fixture = parseExport(fs.readFileSync('tests/fixtures/export-th16.json', 'utf8'), data);
  const now = fixture.exportTimestamp!;
  const ev = buildEverything(data, fixture, settings(), EMPTY_META, now);
  const full = simulate(data, fixture, settings(), EMPTY_META, { nowSec: now, horizonSec: Infinity, freezeTownHall: true });

  it('groups every builder upgrade by the tier the engine assigns, in tier order, with totals', () => {
    const tiers = ev.tiers.map((g) => g.tier!);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    const builderIds = new Set(full.slots.filter((s) => s.queue === 'builder').map((s) => s.id));
    const fresh = full.timeline.filter((e) => !e.inProgress && builderIds.has(e.slotId));
    expect(ev.tiers.reduce((n, g) => n + g.count, 0)).toBe(fresh.length);
    for (const g of ev.tiers) {
      const rows = fresh.filter((e) => e.tier === g.tier);
      expect(g.count).toBe(rows.length);
      expect(g.rawSec).toBe(rows.reduce((s, e) => s + (e.rawTimeSec ?? 0), 0));
      expect(g.goldPassSec).toBeLessThan(g.rawSec);
      const gold = rows.filter((e) => e.resource === 'gold').reduce((s, e) => s + e.cost, 0);
      expect(g.costs.gold ?? 0).toBe(gold);
      expect(g.items.reduce((n, it) => n + it.count, 0)).toBe(g.count);
      expect(g.title).toMatch(/^T\d · /);
    }
  });

  it('time to max comes from the scheduler (the last builder job), not a plain sum', () => {
    const builderIds = new Set(full.slots.filter((s) => s.queue === 'builder').map((s) => s.id));
    const last = Math.max(...full.timeline.filter((e) => builderIds.has(e.slotId)).map((e) => e.end));
    expect(ev.timeToMaxSec).toBe(last);
    const sum = ev.tiers.reduce((s, g) => s + g.rawSec, 0);
    expect(ev.timeToMaxSec).toBeLessThan(sum);
    expect(ev.timeToMaxOtherSec).toBeLessThan(ev.timeToMaxSec); // the other setting = Max Gold Pass here
  });

  it('stays at the current Town Hall; the next TH is listed as not scheduled (rush)', () => {
    expect(ev.mode).toBe('rush');
    expect(full.timeline.some((e) => !e.inProgress && e.itemKey === '1000001')).toBe(false);
    expect(ev.notScheduled.rows.some((r) => r.name === 'Town Hall' && r.toLevel === 17)).toBe(true);
  });

  it('has Lab, Pet House, Blacksmith and Walls sections with their own totals', () => {
    expect(ev.lab.count).toBeGreaterThan(0);
    expect(ev.lab.doneSec).toBe(ev.labDoneSec);
    expect(ev.pets.count).toBeGreaterThan(0);
    expect(ev.blacksmith.count).toBeGreaterThan(0);
    expect(ev.blacksmith.ore!.shinyOre).toBeGreaterThan(0);
    expect(ev.walls.costs.goldOrElixir).toBeGreaterThan(0);
    const total = (r: 'gold' | 'elixir') => [...ev.tiers, ev.lab, ev.pets, ev.walls, ev.notScheduled].reduce((s, g) => s + (g.costs[r] ?? 0), 0);
    expect(ev.totalCosts.gold).toBe(total('gold'));
    expect(ev.totalCosts.elixir).toBe(total('elixir'));
  });
});

// ── hero order ──
describe('hero order', () => {
  it('moveHero moves one hero (drag or ↑/↓); out-of-range moves change nothing', () => {
    const o = DEFAULT_HERO_ORDER;
    expect(moveHero(o, 1, 3)).toEqual(['archer-queen', 'dragon-duke', 'barbarian-king', 'grand-warden', 'royal-champion', 'minion-prince']);
    expect(moveHero(o, 5, 1)).toEqual(['archer-queen', 'minion-prince', 'grand-warden', 'dragon-duke', 'barbarian-king', 'royal-champion']);
    expect(moveHero(o, 1, 9)).toEqual(o);
  });

  it('the Archer Queen is locked at position 1: she never moves and nothing moves above her', () => {
    const o = DEFAULT_HERO_ORDER;
    expect(LOCKED_HERO).toBe('archer-queen');
    expect(moveHero(o, 0, 3)).toEqual(o); // drag / ↓ on the Queen: unchanged
    expect(moveHero(o, 0, 1)).toEqual(o);
    expect(moveHero(o, 5, 0)).toEqual(moveHero(o, 5, 1)); // a drop on her slot lands just below her
    expect(moveHero(o, 5, 0)[0]).toBe('archer-queen');
    expect(moveHero(o, 1, 0)).toEqual(o); // ↑ on #2: no-op
  });

  it('saved orders keep their order (incl. ids newer than the defaults), drop duplicates and append missing heroes', () => {
    expect(heroOrder(['royal-champion', 'new-hero', 'royal-champion'])).toEqual(['archer-queen', 'royal-champion', 'new-hero', 'grand-warden', 'dragon-duke', 'barbarian-king', 'minion-prince']);
    expect(heroOrder('junk')).toEqual(DEFAULT_HERO_ORDER);
  });

  it('a saved order with the Archer Queen elsewhere is normalized to put her first (rest unchanged)', () => {
    const saved = ['barbarian-king', 'grand-warden', 'archer-queen', 'minion-prince', 'dragon-duke', 'royal-champion'];
    expect(heroOrder(saved)).toEqual(['archer-queen', 'barbarian-king', 'grand-warden', 'minion-prince', 'dragon-duke', 'royal-champion']);
    expect(coerceSettings({ heroOrder: saved }).heroOrder[0]).toBe('archer-queen');
    expect(settingsFromYaml('heroOrder: [minion-prince, archer-queen]\n').heroOrder.slice(0, 2)).toEqual(['archer-queen', 'minion-prince']);
  });

  it('a custom order changes hero candidate order; the Queen keeps Tier 0', () => {
    const ex = maxLab(makeExport(16));
    for (const id of ['archer-queen', 'grand-warden', 'barbarian-king', 'royal-champion']) {
      const h = ex.heroes.find((x) => x.data === data.byId.get(id)!.dataId)!;
      h.lvl = Math.max(1, h.lvl - 5);
    }
    const order = moveHero(DEFAULT_HERO_ORDER, 3, 1); // barbarian-king right after the locked Queen
    expect(order.slice(0, 2)).toEqual(['archer-queen', 'barbarian-king']);
    const acc = parse(ex);
    const cands = builderCandidates(data, { instances: acc.instances, busy: new Set() }, settings({ heroOrder: order }), { builderBoost: 0 });
    const heroes = cands.filter((c) => c.item.category === 'hero');
    expect(heroes[0].item.id).toBe('archer-queen');
    expect(heroes[0].tier).toBe(0);
    expect(heroes.slice(1).map((c) => c.item.id)).toEqual(['barbarian-king', 'grand-warden', 'royal-champion']);
    const dflt = builderCandidates(data, { instances: acc.instances, busy: new Set() }, settings(), { builderBoost: 0 }).filter((c) => c.item.category === 'hero');
    expect(dflt.slice(1).map((c) => c.item.id)).toEqual(['grand-warden', 'barbarian-king', 'royal-champion']);
  });
});

// ── §13 item images ──
describe('item images', () => {
  const item = (key: string, images?: string[]) => ({ key, name: key, images }) as Item;

  it('picks the first candidate that exists and fits the size cap; otherwise name only', () => {
    const sizes: Record<string, number> = { 'a/icon.png': 500_000, 'a/l2.png': 40_000, 'b/icon.png': 900_000 };
    const r = pickItemImages([item('a', ['a/icon.png', 'a/l2.png']), item('b', ['b/icon.png']), item('c', ['c/missing.png']), item('d')], (p) => sizes[p], 300_000);
    expect([...r.byKey]).toEqual([['a', 'a/l2.png']]);
    expect(r.skipped).toEqual([
      { key: 'b', name: 'b', reason: 'too large' },
      { key: 'c', name: 'c', reason: 'missing' },
    ]);
  });

  it('the generated module imports each file once and maps item keys to them', () => {
    const src = itemImagesModule(new Map([['1', 'x.png'], ['2', 'x.png'], ['3', 'y.png']]), (p) => `pkg/${p}`);
    expect(src.match(/^import /gm)).toHaveLength(2);
    expect(src).toContain('"2": u0,');
    expect(src).toContain('"3": u1,');
  });

  it('every bundled item image is a real file in the package (current data)', () => {
    const r = pickItemImages(data.items.values(), (p) => {
      try {
        return fs.statSync(`node_modules/clash-of-clans-data/${p}`).size;
      } catch {
        return undefined;
      }
    });
    expect(r.byKey.size).toBeGreaterThan(150);
    expect(r.skipped.filter((s) => s.reason === 'missing')).toEqual([]);
    // Troops/heroes use their icon. Buildings use the highest level image clash-of-clans-data has, which can lag
    // ClashKing's top level (SPEC §9 "which source updated first"), so this is relative to the package's files.
    expect(data.byId.get('archer-queen')!.images![0]).toMatch(/icon\.png$/);
    const cannon = data.byId.get('cannon')!;
    const picked = r.byKey.get(cannon.key)!;
    expect(picked).toMatch(/level-\d+\.png$/);
    const dir = picked.slice(0, picked.lastIndexOf('/'));
    const levelsWithImage = fs
      .readdirSync(`node_modules/clash-of-clans-data/${dir}`)
      .map((f) => /^level-(\d+)\.png$/.exec(f)?.[1])
      .filter((x): x is string => !!x)
      .map(Number)
      .filter((n) => levelInfo(cannon, n));
    expect(picked).toBe(`${dir}/level-${Math.max(...levelsWithImage)}.png`);
  });
});
