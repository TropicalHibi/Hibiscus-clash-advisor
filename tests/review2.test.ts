// Rules added by the second code review (REVIEW-2.md): counted buildings without level data, running jobs on
// levelless items, and the other engine fixes. All on fixed fixtures or modifiedData, never today's numbers.
import { describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { DAY } from '../src/engine/constants';
import { buildPlan } from '../src/engine/plan';
import { planToText } from '../src/engine/planText';
import { queueByCategory, simulate } from '../src/engine/scheduler';
import { builderCandidates, type EngineState } from '../src/engine/tiers';
import { EMPTY_META } from '../src/meta/meta';
import type { AccountState } from '../src/state/parseExport';
import { renderPlan } from '../src/ui/planView';
import { validateClashKing } from '../scripts/lib/clashking';
import { runDataUpdate } from '../scripts/lib/dataUpdate';
import { countAt, maxLevelAt } from '../src/data/normalize';
import { loadWithOverrides, OverrideError, parseMergeOverrides } from '../src/data/overrides';
import { checkFreeLevels } from '../src/data/validate';
import { addTownHallLevel, cocData, data, makeExport, MAX_TH, maxLab, modifiedData, parseWith, rawItem, setLevel, settings, T0, type Entry } from './helpers';

const stateOf = (a: AccountState): EngineState => {
  const busy = new Set<string>();
  for (const i of a.instances) if (i.upgradingTo !== undefined) busy.add(i.parentUid ?? i.uid);
  return { instances: a.instances, busy };
};
const candsWith = (d: GameData, a: AccountState) => builderCandidates(d, stateOf(a), settings(), { builderBoost: 0 });

// The Guardian Shrine is counted by the Town Hall unlocks but has no levels (ClashKing v0.1.20). The mutation
// empties its levels explicitly, so these tests keep the scenario even after ClashKing adds them.
const SHRINE = 'guardian-shrine';
const noShrineLevels = (raw: Parameters<typeof addTownHallLevel>[0]) => {
  rawItem(raw, SHRINE).levels = [];
};

describe('a counted building without level data never holds the TH gate (REVIEW-2 #2)', () => {
  const dNext = modifiedData((raw) => {
    noShrineLevels(raw);
    addTownHallLevel(raw); // a new TH: the old max TH becomes rush
  });
  const shrine = dNext.byId.get(SHRINE)!;
  const withoutShrine = () => {
    const ex = makeExport(MAX_TH, MAX_TH);
    ex.buildings = ex.buildings.filter((b) => b.data !== shrine.dataId); // not built yet
    return parseWith(ex, dNext);
  };

  it('the Town Hall is still offered; the shrine is no candidate', () => {
    expect(shrine.levels).toHaveLength(0);
    expect(shrine.countPerTH).toBeDefined();
    const c = candsWith(dNext, withoutShrine());
    expect(c.some((x) => x.item.id === 'town-hall')).toBe(true);
    expect(c.some((x) => x.item.id === SHRINE)).toBe(false);
  });

  it('a 365-day simulation upgrades the Town Hall (it deadlocked before)', () => {
    const s = simulate(dNext, withoutShrine(), settings(), EMPTY_META, { nowSec: T0, horizonSec: 365 * DAY });
    expect(s.timeline.filter((e) => e.itemName === 'Town Hall' && !e.inProgress).length).toBeGreaterThan(0);
  });

  it('shown as an informational Tier 0 row on the Plan tab and in npm run plan', () => {
    const plan = buildPlan(dNext, withoutShrine(), settings(), EMPTY_META, T0);
    expect(plan.newBuildingsInfo).toEqual(['Build Guardian Shrine (no level data yet)']);
    expect(planToText(plan)).toContain('T0 (info): Build Guardian Shrine (no level data yet)');
    expect(renderPlan(plan)).toContain('Build Guardian Shrine (no level data yet)');
    expect(plan.startNow.some((e) => e.itemName.includes('Guardian Shrine'))).toBe(false);
  });

  it('no row once it is built, or below its unlock TH', () => {
    const ex = makeExport(MAX_TH, MAX_TH); // makeExport includes every counted building
    expect(buildPlan(dNext, parseWith(ex, dNext), settings(), EMPTY_META, T0).newBuildingsInfo).toEqual([]);
    const low = makeExport(15, 14);
    expect(buildPlan(dNext, parseWith(low, dNext), settings(), EMPTY_META, T0).newBuildingsInfo).toEqual([]);
  });
});

describe('a running upgrade on a known item without levels holds its slot (REVIEW-2 #3)', () => {
  const d = modifiedData(noShrineLevels);
  const shrine = d.byId.get(SHRINE)!;

  it('a levelless building under construction keeps a builder busy until its timer runs out', () => {
    const ex = makeExport(18, 17);
    ex.buildings.push({ data: shrine.dataId, lvl: 0, timer: 3 * DAY });
    const a = parseWith(ex, d);
    const plan = buildPlan(d, a, settings(), EMPTY_META, T0);
    const busy = plan.sim.timeline.find((e) => e.inProgress && e.itemName === 'Guardian Shrine (no level data)')!;
    expect(busy).toBeDefined();
    expect(busy.slotId).toMatch(/^B\d$/);
    expect(busy.end).toBe(3 * DAY);
    const newBuilderJobs = plan.startNow.filter((e) => e.slotId.startsWith('B'));
    expect(newBuilderJobs).toHaveLength(a.builders - 1);
    expect(plan.warnings.some((w) => /More in-progress builder upgrades than slots/.test(w))).toBe(false);
  });

  it('slots by category: units → lab, pets → pet house, equipment → none, buildings / heroes / guardians → builder', () => {
    expect(queueByCategory('troop')).toBe('lab');
    expect(queueByCategory('spell')).toBe('lab');
    expect(queueByCategory('siege')).toBe('lab');
    expect(queueByCategory('pet')).toBe('petHouse');
    expect(queueByCategory('equipment')).toBeUndefined();
    for (const c of ['army', 'defense', 'trap', 'hero', 'guardian', 'craftedDefense', 'other'] as const) expect(queueByCategory(c)).toBe('builder');
  });
});

it('sanity: the real data still counts the Guardian Shrine without levels (if this fails, ClashKing added them: fine)', () => {
  // Informational: the tests above don't depend on it.
  const s = data.byId.get(SHRINE);
  if (s) expect(s.queue === 'none' || s.levels.length > 0).toBe(true);
});

// ── #7: a free + instant level above 1 is rejected ──
describe('validation: a level above 1 of a scheduled item that costs nothing and takes no time (REVIEW-2 #7)', () => {
  it('today\'s data has none (no false positives; seasonal units are queue none)', () => {
    expect(checkFreeLevels(data)).toEqual([]);
  });

  it('a new top level with the row before it left at 0 is rejected by validateClashKing', () => {
    const d = modifiedData((raw) => {
      const aq = rawItem(raw, 'archer-queen');
      const top = aq.levels[aq.levels.length - 1]; // upgrade_cost / upgrade_time 0 (it was the top row)
      aq.levels.push({ ...structuredClone(top), level: top.level + 1 });
    });
    const top = d.byId.get('archer-queen')!.levels.at(-1)!;
    expect(top.cost).toBe(0);
    expect(top.timeSec).toBe(0);
    expect(validateClashKing(d)).toBe(`Archer Queen ${top.level}: costs nothing and takes no time (the row before it is probably not filled in yet)`);
  });

  it('equipment: all three ores 0 above level 1 is rejected', () => {
    const d = modifiedData((raw) => {
      const eq = rawItem(raw, 'barbarian-puppet');
      const top = eq.levels[eq.levels.length - 1];
      eq.levels.push({ ...structuredClone(top), level: top.level + 1 });
    });
    expect(checkFreeLevels(d).map((i) => i.message)).toEqual([expect.stringContaining('Barbarian Puppet') as unknown as string]);
    expect(checkFreeLevels(d)[0].message).toContain('costs no ore');
  });

  it('a properly filled new level passes', () => {
    const d = modifiedData((raw) => {
      const aq = rawItem(raw, 'archer-queen');
      const prev = aq.levels[aq.levels.length - 2];
      const top = aq.levels[aq.levels.length - 1];
      top.upgrade_cost = prev.upgrade_cost;
      top.upgrade_time = prev.upgrade_time;
      aq.levels.push({ ...structuredClone(top), level: top.level + 1, upgrade_cost: 0, upgrade_time: 0 });
    });
    expect(validateClashKing(d)).toBeUndefined();
  });
});

// ── #12: small correctness items ──
describe('Resource buildings that are neither storage nor collector (REVIEW-2 #12)', () => {
  it('are category "other" (never the offense tier), with a warning once they have levels', () => {
    expect(data.byId.get('sour-elixir-cauldron')?.category ?? 'other').toBe('other');
    expect(data.warnings.some((w) => w.includes('Sour Elixir Cauldron'))).toBe(false); // no levels yet: no noise
    const d = modifiedData((raw) => {
      const c = rawItem(raw, 'sour-elixir-cauldron');
      c.levels = structuredClone(rawItem(raw, 'gold-mine').levels.slice(0, 3));
    });
    const cauldron = d.byId.get('sour-elixir-cauldron')!;
    expect(cauldron.category).toBe('other');
    expect(d.warnings.some((w) => w.includes('"Sour Elixir Cauldron" is neither a known storage nor a collector'))).toBe(true);
    const ex = makeExport(MAX_TH, MAX_TH - 2);
    ex.buildings.push({ data: cauldron.dataId, lvl: 1 });
    expect(candsWith(d, parseWith(ex, d)).some((c) => c.item.id === 'sour-elixir-cauldron')).toBe(false);
  });
});

describe('override-file errors are reported as override errors (REVIEW-2 #12)', () => {
  it('a YAML error names the file; the data loads without the overrides (not the backup)', () => {
    const d = modifiedData(() => {}, { merges: 'merges: [unclosed' });
    expect(d.source).toBe('clashking');
    expect(d.warnings[0]).toMatch(/^Override file error: config\/merges\.yaml: .+\. The override files are ignored until it's fixed\.$/);
    expect(d.warnings.some((w) => /pinned ClashKing data can't be loaded/.test(w))).toBe(false);
  });

  it('an unknown id in merges.yaml names the file', () => {
    const d = modifiedData(() => {}, { merges: 'merges:\n  not-a-defense:\n    sources: [{ id: cannon, qty: 2 }]\n' });
    expect(d.warnings[0]).toContain('Override file error: config/merges.yaml: merged defense "not-a-defense" not found in game data');
    expect(d.merges.length).toBe(data.merges.length);
  });

  it('the same in the clash-of-clans-data backup', () => {
    expect(() => parseMergeOverrides('merges: [unclosed')).toThrow(OverrideError);
    // normalize() throws an OverrideError naming the file; the loaders (loadWithOverrides) turn it into the warning.
    const bad = { mergesYaml: 'merges:\n  nope:\n    sources: [{ id: cannon, qty: 2 }]\n' };
    expect(() => cocData(() => {}, bad)).toThrow(OverrideError);
    expect(() => cocData(() => {}, bad)).toThrow('config/merges.yaml: merged defense "nope" not found in game data');
    const d = loadWithOverrides((use) => cocData(() => {}, use ? bad : {}));
    expect(d.source).toBe('clash-of-clans-data');
    expect(d.warnings[0]).toContain('Override file error: config/merges.yaml');
  });

  it('the daily Action fails on an override error', () => {
    const d = modifiedData(() => {}, { merges: 'merges: [unclosed' });
    const r = runDataUpdate({
      sync: { installedVersion: () => '0.19.0', latestInMajor: () => '0.19.1', install: () => {}, check: () => ({ ok: true, warnings: [] }), readState: () => ({}), writeState: () => {}, snapshot: () => ({ file: 'x', written: true, changes: [] }), log: () => {} },
      loadData: () => d,
    });
    expect(r).toMatchObject({ status: 'failed', failedStep: 'validation: override files (config/)' });
  });
});

describe('a supercharge needs the base at the level that carries the block (REVIEW-2 ambiguity 2)', () => {
  const mono = data.byId.get('monolith');
  const sc = data.items.get(`${mono?.key}:sc`);
  it.skipIf(!mono || !sc)('Monolith: not offered below the block level, offered at it', () => {
    const block = sc!.superchargeBaseLevel!;
    const scTH = sc!.levels[0].thRequired ?? 0;
    const blockTH = mono!.levels.find((l) => l.level === block)!.thRequired ?? 0;
    const th = Math.min(scTH, blockTH); // TH17 today: the supercharge's TH, below the block level's
    const below = makeExport(th, th);
    setLevel(below, 'buildings', 'monolith', { lvl: maxLevelAt(mono!, { th }) });
    const offered = (ex: ReturnType<typeof makeExport>) => candsWith(data, parseWith(ex, data)).some((c) => c.item.key === sc!.key);
    if (maxLevelAt(mono!, { th }) < block) expect(offered(below)).toBe(false);
    const at = makeExport(Math.max(th, blockTH), Math.max(th, blockTH));
    setLevel(at, 'buildings', 'monolith', { lvl: block });
    expect(offered(at)).toBe(true);
  });
});

describe('the wall line is computed from "now" (REVIEW-2 #12, ambiguity 9)', () => {
  it('a Town Hall upgrade that finished since the export opens the next wall level', () => {
    const wall = data.byId.get('wall')!;
    const th = 15;
    const top = maxLevelAt(wall, { th });
    expect(maxLevelAt(wall, { th: th + 1 })).toBeGreaterThan(top);
    const ex = maxLab(makeExport(th, th - 1));
    setLevel(ex, 'buildings', 'town-hall', { timer: 3600 }); // TH15 → 16, done an hour after the export
    (ex.buildings.find((b) => b.data === wall.dataId) ?? ex.buildings[ex.buildings.push({ data: wall.dataId, lvl: top, cnt: 0 }) - 1]).lvl = top;
    ex.buildings.find((b) => b.data === wall.dataId)!.cnt = 100;
    const a = parseWith(ex, data);
    expect(buildPlan(data, a, settings(), EMPTY_META, T0).wallDump).toBeNull(); // at the export: TH15, walls maxed
    const later = buildPlan(data, a, settings(), EMPTY_META, T0 + 2 * 3600);
    expect(later.townHall).toBe(th + 1);
    expect(later.wallDump).toMatchObject({ fromLevel: top, toLevel: top + 1, countAtLevel: 100 });
  });
});

// ── helpers (§10.1) ──
const APPRENTICE = 93000000;
const helperEntry = (lvl: number, cooldown: number) => ({ data: APPRENTICE, lvl, helper_cooldown: cooldown }) as unknown as Entry;

describe('helpers: the 23-hour cycle starts when a helper is assigned (REVIEW-2 ambiguity 7)', () => {
  it('no eligible job at a work hour: the helper waits and is assigned to the next job (its cycle starts then)', () => {
    // Export 2 days old, nothing running then: the work hours at +1 h, +24 h, +47 h after the export find nothing.
    const ex = maxLab(makeExport(16));
    ex.helpers.push(helperEntry(8, 3600));
    const now = T0 + 2 * DAY;
    const r = simulate(data, parseWith(ex, data), settings(), EMPTY_META, { nowSec: now, horizonSec: 22 * 3600 });
    // Assigned at t = 0 to a job started then (the old rule advanced the cycle and waited until now + 22 h).
    const helped = r.timeline.filter((e) => !e.inProgress && (e.helperSavedSec ?? 0) > 0);
    expect(helped).toHaveLength(1);
    expect(helped[0].start).toBe(0);
    expect(helped[0].helperSavedSec).toBe(8 * 3600);
  });

  it('a helper_recurrent flag on a Goblin job is ignored: the planner picks a regular job, no suggestion', () => {
    const ex = maxLab(makeExport(16));
    setLevel(ex, 'heroes', 'barbarian-king', { timer: 3 * DAY, extra: true, helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push(helperEntry(8, 3600));
    const r = simulate(data, parseWith(ex, data), settings(), EMPTY_META, { nowSec: T0, horizonSec: DAY });
    const king = r.timeline.find((e) => e.itemKey === data.byId.get('barbarian-king')!.key)!;
    expect(king.slotId).toMatch(/^GB/);
    expect(king.helperSavedSec).toBeUndefined();
    expect(r.helperSuggestions).toEqual([]);
    expect(r.timeline.some((e) => !e.slotId.startsWith('GB') && (e.helperSavedSec ?? 0) > 0)).toBe(true);
  });

  it('two flagged builder jobs: the helper takes the one the planner ranks higher (Town Hall first)', () => {
    const ex = maxLab(makeExport(16));
    setLevel(ex, 'heroes', 'barbarian-king', { timer: 4 * DAY, helper_recurrent: true } as Partial<Entry>);
    setLevel(ex, 'buildings', 'town-hall', { timer: 2 * DAY, helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push(helperEntry(8, 3600));
    const r = simulate(data, parseWith(ex, data), settings(), EMPTY_META, { nowSec: T0, horizonSec: DAY });
    expect(r.timeline.find((e) => e.itemName === 'Town Hall' && e.inProgress)!.helperSavedSec).toBe(8 * 3600);
    expect(r.timeline.find((e) => e.itemKey === data.byId.get('barbarian-king')!.key)!.helperSavedSec).toBeUndefined();
    expect(r.helperSuggestions).toEqual([]);
  });

  it('the helper line says "per 23h cycle"', () => {
    const ex = maxLab(makeExport(16));
    ex.helpers.push(helperEntry(8, 3600));
    expect(buildPlan(data, parseWith(ex, data), settings(), EMPTY_META, T0).helperLine).toContain('(−8h per 23h cycle)');
  });
});

describe('the Firecracker merge at its unlock TH, from a real-looking export (REVIEW-2 missing test)', () => {
  const fc = data.merges.find((m) => m.id === 'firecracker-tower');
  it.skipIf(!fc)('Archer Towers + Scattershots at the required levels merge; no "build Archer Tower" suggestions', () => {
    const th = fc!.unlockTH;
    const ex = makeExport(th, th - 1); // just upgraded: last TH's buildings, no Firecracker yet
    const fcItem = data.byId.get('firecracker-tower')!;
    ex.buildings = ex.buildings.filter((b) => b.data !== fcItem.dataId);
    // Each source as the last TH had it (count after its earlier merges), at the level the recipe requires.
    for (const s of fc!.sources) {
      const src = data.byDataId.get(s.dataId)!;
      const cnt = countAt(src.countAfterMergesPerTH, th - 1) ?? countAt(src.countPerTH, th - 1) ?? 0;
      const lvl = fc!.requiredSourceLevel[src.id];
      const e = ex.buildings.find((b) => b.data === src.dataId);
      if (e) Object.assign(e, { cnt, lvl });
      else ex.buildings.push({ data: src.dataId, lvl, cnt });
    }
    const c = candsWith(data, parseWith(ex, data));
    const merges = c.filter((x) => x.kind === 'merge' && x.item.id === 'firecracker-tower');
    expect(merges.length).toBeGreaterThan(0);
    expect(merges[0].tier).toBe(0);
    expect(c.some((x) => x.item.id === 'archer-tower' && x.kind === 'build')).toBe(false);
  });
});
