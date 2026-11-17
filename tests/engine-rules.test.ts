// Engine rules added or fixed after REVIEW.md: Laboratory Tier 0, research in parallel with building
// upgrades, merge-source levels at the unlock TH (TH19 deadlock), kind weight 0, unknown merges,
// supercharge eligibility, "now" state for ranked lists, TH weapon, and the remaining missing tests.
import { describe, expect, it } from 'vitest';
import { maxLevelAt } from '../src/data/normalize';
import type { GameData, Item } from '../src/data/types';
import { heroCapAt, heroStatus } from '../src/engine/book';
import { forecast, wallDump } from '../src/engine/forecast';
import { buildPlan } from '../src/engine/plan';
import { equipmentCandidates, nextResearch, researchCandidates } from '../src/engine/queues';
import { simulate, type TimelineEntry } from '../src/engine/scheduler';
import { builderCandidates, type EngineState } from '../src/engine/tiers';
import { coerceMeta, EMPTY_META } from '../src/meta/meta';
import type { AccountState } from '../src/state/parseExport';
import type { Settings } from '../src/state/settings';
import { nextInLab } from '../src/ui/labView';
import {
  addBuildingLevel,
  addTownHallLevel,
  cocData,
  data,
  makeExport,
  MAX_TH,
  maxLab,
  modifiedData,
  parse,
  parseWith,
  rawItem,
  setLevel,
  settings,
  T0,
  type SyntheticExport,
} from './helpers';
import fs from 'node:fs';
const fixtureJson = () => JSON.parse(fs.readFileSync(new URL('./fixtures/export-th16.json', import.meta.url), 'utf8'));

const DAY = 86400;
const stateOf = (a: AccountState): EngineState => {
  const busy = new Set<string>();
  for (const i of a.instances) if (i.upgradingTo !== undefined) busy.add(i.parentUid ?? i.uid);
  return { instances: a.instances, busy };
};
const candsWith = (d: GameData, a: AccountState, s: Settings = settings(), boost = 0) => builderCandidates(d, stateOf(a), s, { builderBoost: boost });
const cands = (a: AccountState, s: Settings = settings(), boost = 0) => candsWith(data, a, s, boost);
const idOf = (id: string) => data.byId.get(id)!.dataId;
const entry = (ex: SyntheticExport, id: string) => ex.buildings.find((b) => b.data === idOf(id))!;
const hhOf = (ex: SyntheticExport) => entry(ex, 'hero-hall').lvl;
const lowerQueen = (ex: SyntheticExport) => setLevel(ex, 'heroes', 'archer-queen', { lvl: Math.min(80, heroCapAt(data.byId.get('archer-queen')!, hhOf(ex)) - 5) }); // below the 8d book levels
const sim = (a: AccountState, s: Settings, days: number, nowSec = T0, meta = EMPTY_META) => simulate(data, a, s, meta, { nowSec, horizonSec: days * DAY });

// A small controlled meta: Rage (spell), Archer + Barbarian (troops) used; everything else unused.
const META = coerceMeta({
  generatedAt: '2026-11-16T12:00:00.000Z',
  windowDays: 14,
  halfLifeDays: 5,
  attacks: 100,
  players: 10,
  units: {
    '26000002': { name: 'Rage Spell', usage: 0.6, threeStarRate: 0.5, avgQty: 2, armyShare: 0.2, kind: 'spell' },
    '4000001': { name: 'Archer', usage: 0.8, threeStarRate: 0.5, avgQty: 3, armyShare: 0.05, kind: 'troop' },
    '4000000': { name: 'Barbarian', usage: 0.2, threeStarRate: 0.5, avgQty: 3, armyShare: 0.02, kind: 'troop' },
  },
});

describe('Tier 0: Laboratory upgrade → new buildings → Archer Queen', () => {
  it('rush: the Laboratory upgrade outranks a new building and the Queen', () => {
    const ex = makeExport(15); // freshly rushed: Laboratory below its TH15 max
    lowerQueen(ex);
    setLevel(ex, 'buildings', 'x-bow', { cnt: 3 });
    const c = cands(parse(ex));
    expect(c.slice(0, 3).map((x) => x.item.id)).toEqual(['laboratory', 'x-bow', 'archer-queen']);
    expect(c.slice(0, 3).every((x) => x.tier === 0)).toBe(true);
  });

  it('max TH: the same Tier 0 order, ahead of offense (tier 1)', () => {
    const ex = makeExport(MAX_TH, MAX_TH - 1);
    lowerQueen(ex);
    setLevel(ex, 'buildings', 'gold-storage', { cnt: entry(ex, 'gold-storage').cnt! - 1 });
    const c = cands(parse(ex));
    expect(c.slice(0, 3).map((x) => x.item.id)).toEqual(['laboratory', 'gold-storage', 'archer-queen']);
    expect(c[3].tier).toBe(1);
  });

  it('the Laboratory upgrade never holds the TH gate; the Pet House stays in the offense tier', () => {
    const ex = makeExport(16, 15);
    setLevel(ex, 'buildings', 'eagle-artillery', { lvl: 7 }); // TH17 requires Eagle Artillery 7 (TH gate)
    const c = cands(parse(ex));
    expect(c[0].item.id).toBe('laboratory');
    expect(c.find((x) => x.item.id === 'town-hall')!.tier).toBe(1);
    expect(c.find((x) => x.item.id === 'pet-house')!.tier).toBe(2);
  });

  it('the Queen ranks ahead of the Town Hall, and ahead of a gated TH (rush)', () => {
    const open = maxLab(makeExport(17, 16));
    lowerQueen(open);
    setLevel(open, 'buildings', 'ricochet-cannon', { cnt: 2 });
    open.buildings.push({ data: idOf('cannon'), lvl: 19, cnt: 2 });
    const c = cands(parse(open));
    expect(c[0].item.id).toBe('archer-queen');
    expect(c.some((x) => x.item.id === 'town-hall')).toBe(false);
    const clear = maxLab(makeExport(17, 16));
    lowerQueen(clear);
    expect(cands(parse(clear)).slice(0, 2).map((x) => x.item.id)).toEqual(['archer-queen', 'town-hall']);
  });
});

describe('research runs in parallel with Laboratory / Pet House upgrades (SPEC §6.6)', () => {
  it('lab and pet research start while the Laboratory and the Pet House are upgrading', () => {
    const ex = makeExport(16, 15);
    setLevel(ex, 'buildings', 'laboratory', { timer: 5 * DAY });
    setLevel(ex, 'buildings', 'pet-house', { timer: 3 * DAY });
    const s = sim(parse(ex), settings(), 1);
    const startsAt0 = (slot: string) => s.timeline.filter((e) => e.slotId === slot && !e.inProgress && e.start === 0);
    expect(startsAt0('LAB')).toHaveLength(1);
    expect(startsAt0('PET')).toHaveLength(1);
  });

  it('the Laboratory upgrade starts while lab research runs', () => {
    const ex = makeExport(16, 15); // Laboratory below max → Tier 0
    setLevel(ex, 'units', 'archer', { timer: 2 * DAY });
    const s = sim(parse(ex), settings(), 1);
    expect(s.timeline.some((e) => e.itemName === 'Laboratory' && e.start === 0)).toBe(true);
    expect(s.timeline.some((e) => e.slotId === 'LAB' && e.inProgress && e.end === 2 * DAY)).toBe(true);
  });

  it('the Pet House upgrade starts while pet research runs', () => {
    const ex = makeExport(16, 16); // everything at its TH16 max …
    setLevel(ex, 'buildings', 'pet-house', { lvl: entry(ex, 'pet-house').lvl - 1 }); // … except the Pet House
    ex.pets[0].timer = 2 * DAY;
    const s = sim(parse(ex), settings(), 1);
    expect(s.timeline.some((e) => e.itemName === 'Pet House' && e.start === 0 && !e.inProgress)).toBe(true);
    expect(s.timeline.some((e) => e.slotId === 'PET' && e.inProgress && e.end === 2 * DAY)).toBe(true);
  });
});

describe('merge sources: required level at the unlock TH (no TH gate deadlock)', () => {
  const swtUnmerged = () => {
    const ex = makeExport(MAX_TH, MAX_TH);
    ex.buildings = ex.buildings.filter((b) => b.data !== idOf('super-wizard-tower'));
    entry(ex, 'wizard-tower').cnt = 6;
    return ex;
  };

  it('a new TH adds a Wizard Tower level: a player at the old max TH still merges the Super Wizard Tower and upgrades the TH', () => {
    const wtTop = data.byId.get('wizard-tower')!.levels.at(-1)!.level;
    const dNext = modifiedData((f) => {
      addTownHallLevel(f);
      addBuildingLevel(f, 'wizard-tower', MAX_TH + 1);
    });
    expect(dNext.maxTH).toBe(MAX_TH + 1);
    expect(maxLevelAt(dNext.byId.get('wizard-tower')!, { th: MAX_TH + 1 })).toBe(wtTop + 1);
    expect(dNext.merges.find((m) => m.id === 'super-wizard-tower')!.requiredSourceLevel['wizard-tower']).toBe(17);

    const d19 = dNext;
    const a = parseWith(swtUnmerged(), d19);
    const c = candsWith(d19, a);
    expect(c.find((x) => x.kind === 'merge')?.item.id).toBe('super-wizard-tower');
    expect(c.some((x) => x.item.id === 'town-hall')).toBe(false); // gate open until merged

    const s = simulate(d19, a, settings(), EMPTY_META, { nowSec: T0, horizonSec: 365 * DAY });
    const merges = s.timeline.filter((e) => e.kind === 'merge');
    const th = s.timeline.find((e) => e.itemName === 'Town Hall');
    expect(merges).toHaveLength(2);
    expect(th).toBeDefined();
    // A started merge counts as built (DECISIONS: TH gate), so the TH starts once both merges have started.
    expect(th!.start).toBeGreaterThanOrEqual(Math.max(...merges.map((m) => m.start)));
  });

  it('a merge whose sources cannot reach the required level at the current TH does not hold the gate', () => {
    const tampered: GameData = { ...data, merges: data.merges.map((m) => (m.id === 'ricochet-cannon' ? { ...m, requiredSourceLevel: { cannon: 99 } } : m)) };
    const ex = makeExport(17, 16);
    setLevel(ex, 'buildings', 'ricochet-cannon', { cnt: 2 });
    ex.buildings.push({ data: idOf('cannon'), lvl: 19, cnt: 2 });
    expect(cands(parse(ex)).some((x) => x.item.id === 'town-hall')).toBe(false); // real data: gate held
    expect(candsWith(tampered, parse(ex)).some((x) => x.item.id === 'town-hall')).toBe(true);
  });

  it('a merge with a busy source is not offered, and the busy source gets no second upgrade', () => {
    const ex = maxLab(makeExport(16, 15));
    setLevel(ex, 'buildings', 'ricochet-cannon', { cnt: 1 });
    setLevel(ex, 'buildings', 'cannon', { cnt: 3, lvl: 19 });
    ex.buildings.push({ data: idOf('cannon'), lvl: 21, cnt: 1 }, { data: idOf('cannon'), lvl: 20, cnt: 1, timer: DAY });
    const c = cands(parse(ex));
    expect(c.some((x) => x.kind === 'merge')).toBe(false);
    expect(c.filter((x) => x.item.id === 'cannon' && x.instance.level === 20)).toHaveLength(0);
  });

  it('max TH: gate items ordered by unlock TH, then recipe order', () => {
    const ex = maxLab(makeExport(MAX_TH, MAX_TH));
    setLevel(ex, 'buildings', 'ricochet-cannon', { cnt: 2 });
    setLevel(ex, 'buildings', 'multi-archer-tower', { cnt: 2 });
    setLevel(ex, 'buildings', 'super-wizard-tower', { cnt: 1 });
    // Spare maxed towers would be merged first (ready merge → Tier 0), so keep every source below its required level.
    // (At TH19 every Archer Tower is merged: Multi-Archer, Multi-Gear and the TH19 Firecracker Tower take all 9.)
    setLevel(ex, 'buildings', 'wizard-tower', { lvl: 15 });
    ex.buildings.push({ data: idOf('cannon'), lvl: 19, cnt: 2 }, { data: idOf('archer-tower'), lvl: 19, cnt: 2 }, { data: idOf('wizard-tower'), lvl: 15, cnt: 2 });
    const gate = cands(parse(ex)).filter((x) => x.tier === 3);
    const ids = gate.map((x) => x.item.id);
    expect(ids).toEqual(['cannon', 'cannon', 'archer-tower', 'archer-tower', 'wizard-tower', 'wizard-tower']);
  });
});

describe('lab kind weight 0: listed, never auto-picked (SPEC §6.7)', () => {
  const ex = () => maxLab(makeExport(16, 15));

  it('all weights 0 → the scheduler starts no research', () => {
    const s = settings({ lab: { kindWeights: { troop: 0, spell: 0, siege: 0 } } });
    expect(sim(parse(ex()), s, 1, T0, META).timeline.filter((e) => e.slotId === 'LAB')).toHaveLength(0);
  });

  it('spells and sieges at 0 → only troops are researched, but spells and sieges stay listed', () => {
    const s = settings({ lab: { kindWeights: { troop: 1, spell: 0, siege: 0 } } });
    const a = parse(ex());
    const jobs = sim(a, s, 30, T0, META).timeline.filter((e) => e.slotId === 'LAB');
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((e) => data.items.get(e.itemKey)!.category === 'troop')).toBe(true);
    const plan = buildPlan(data, a, s, META, T0);
    expect(plan.labByKind.spell.length).toBeGreaterThan(0);
    expect(plan.labByKind.siege.length).toBeGreaterThan(0);
    expect(plan.lab.at(-1)!.autoPick).toBe(false); // weight-0 kinds sit at the bottom of the queue order
    expect(nextResearch(plan.lab)!.labKind).toBe('troop');
    expect(plan.lab.find((c) => c.item.id === 'rage-spell')!.reason).toContain('not auto-picked (spell weight 0)');
  });

  it('a pin overrides weight 0', () => {
    const s = settings({ lab: { kindWeights: { troop: 1, spell: 0, siege: 0 }, pinned: ['rage-spell'] } });
    const first = sim(parse(ex()), s, 1, T0, META).timeline.find((e) => e.slotId === 'LAB')!;
    expect(first.itemName).toBe('Rage Spell');
  });
});

describe('merges the recipes do not explain (SPEC §7)', () => {
  // ClashKing carries every merge, so this only happens on the clash-of-clans-data backup (built-in recipes).
  it('never suggests copies of an item with countAfterMerges but no recipe; the Plan tab warns', () => {
    const d = cocData(() => {}, { dropRecipes: ['super-wizard-tower'] });
    const a = parseWith(maxLab(makeExport(18, 18)), d);
    expect(candsWith(d, a).some((x) => x.kind === 'build' && x.item.id === 'wizard-tower')).toBe(false);
    const plan = buildPlan(d, a, settings(), EMPTY_META, T0);
    expect(plan.warnings.some((w) => w.includes('merges.yaml') && w.includes('Wizard Tower'))).toBe(true);
  });

  it('the shipped data (ClashKing) gives no merge warning', () => {
    const plan = buildPlan(data, parse(makeExport(MAX_TH, MAX_TH)), settings(), EMPTY_META, T0);
    expect(plan.warnings.some((w) => w.includes('merges.yaml'))).toBe(false);
  });
});

describe('supercharges', () => {
  // ClashKing's superchargeable buildings (the `supercharge` block): Inferno Tower is one of them.
  const inferno = idOf('inferno-tower');
  const infernoSc = (c: ReturnType<typeof cands>) => c.filter((x) => x.kind === 'supercharge' && x.item.dataId === inferno);
  const infernoMax = maxLevelAt(data.byId.get('inferno-tower')!, { th: MAX_TH });

  it('offered when the base is at its max for the TH: temporary tier, Gold Pass applied', () => {
    const c = cands(parse(makeExport(MAX_TH, MAX_TH)), settings(), 0.2);
    const sc = infernoSc(c);
    expect(sc.length).toBe(entry(makeExport(MAX_TH, MAX_TH), 'inferno-tower').cnt!);
    expect(sc.every((x) => x.tier === 6 && x.timeSec === Math.round(x.rawTimeSec * 0.8))).toBe(true);
    const below = makeExport(MAX_TH, MAX_TH);
    setLevel(below, 'buildings', 'inferno-tower', { lvl: infernoMax - 1 });
    expect(infernoSc(cands(parse(below)))).toHaveLength(0); // base not maxed yet
  });

  it('a new TH level on the base building does not remove the supercharges for players below that TH', () => {
    const dNext = modifiedData((f) => {
      addTownHallLevel(f);
      addBuildingLevel(f, 'inferno-tower', MAX_TH + 1);
    });
    expect(infernoSc(candsWith(dNext, parseWith(makeExport(MAX_TH, MAX_TH), dNext)))).toHaveLength(entry(makeExport(MAX_TH, MAX_TH), 'inferno-tower').cnt!);
  });

  it('reads the `supercharge` export field: next level after it, none once maxed', () => {
    const sc = data.items.get(`${inferno}:sc`)!;
    const one = makeExport(MAX_TH, MAX_TH);
    setLevel(one, 'buildings', 'inferno-tower', { supercharge: 1 });
    expect(infernoSc(cands(parse(one))).every((x) => x.toLevel === 2)).toBe(true);
    const max = makeExport(MAX_TH, MAX_TH);
    setLevel(max, 'buildings', 'inferno-tower', { supercharge: sc.levels.at(-1)!.level });
    expect(infernoSc(cands(parse(max)))).toHaveLength(0);
  });
});

describe('ranked lists use the state at "now" (SPEC §11)', () => {
  it('research and hero upgrades that finished since the export are applied', () => {
    const ex = maxLab(makeExport(16, 15));
    setLevel(ex, 'units', 'archer', { timer: 3600 });
    lowerQueen(ex);
    setLevel(ex, 'heroes', 'archer-queen', { timer: 3600 });
    const aqBefore = ex.heroes.find((h) => h.data === idOf('archer-queen'))!.lvl;
    const plan = buildPlan(data, parse(ex), settings(), META, T0 + 2 * 3600);
    expect(plan.lab.find((c) => c.item.id === 'archer')?.toLevel).toBe(5); // 3→4 finished; 4→5 is next
    expect(plan.topCandidates.find((c) => c.item.id === 'archer-queen')?.toLevel).toBe(aqBefore + 2);
    const text = nextInLab(plan).replace(/<[^>]+>/g, '');
    expect(text).not.toContain('starts when');
  });
});

describe('TH weapon', () => {
  const gatedTH17 = () => {
    const ex = maxLab(makeExport(17, 16));
    setLevel(ex, 'buildings', 'x-bow', { cnt: entry(ex, 'x-bow').cnt! - 1 }); // one X-Bow unbuilt → gate open
    return ex;
  };

  it('rush: tier 1 right after the TH; shares the TH lock', () => {
    const c = cands(parse(maxLab(makeExport(17, 16))));
    const t1 = c.filter((x) => x.tier === 1).map((x) => x.kind);
    expect(t1.slice(0, 2)).toEqual(['upgrade', 'weapon']);
    expect(c.find((x) => x.kind === 'weapon')!.lockUid).toBe(c.find((x) => x.item.id === 'town-hall')!.lockUid);
  });

  it('a weapon upgrade does not trigger the TH-upgrade lookahead; a TH upgrade does', () => {
    const a = parse(gatedTH17());
    const th = a.instances.find((i) => i.dataId === 1000001)!;
    const weaponBusy = builderCandidates(data, { instances: a.instances, busy: new Set([th.uid]) }, settings(), { builderBoost: 0 });
    expect(weaponBusy.some((x) => x.reason.includes('lookahead'))).toBe(false);
    expect(weaponBusy.some((x) => x.kind === 'weapon')).toBe(false);
    const ex = gatedTH17();
    setLevel(ex, 'buildings', 'town-hall', { timer: 5 * DAY });
    expect(cands(parse(ex)).some((x) => x.reason.includes('lookahead'))).toBe(true);
  });

  it('max TH: the weapon is a permanent defense (tier 5)', () => {
    const d17 = modifiedData((f) => {
      const th = f.buildings.find((b) => b.type === 'Town Hall')!;
      th.levels = th.levels.filter((l: { level: number }) => l.level <= 17);
    });
    expect(d17.maxTH).toBe(17);
    const w = candsWith(d17, parseWith(makeExport(17, 17), d17)).find((x) => x.kind === 'weapon')!;
    expect(w.tier).toBe(5);
  });
});

describe('scheduler details', () => {
  it('warns about an export timestamp in the future (clock skew), not about a few seconds', () => {
    const a = parse(makeExport(16, 15));
    expect(sim(a, settings(), 1, T0 - 3600).warnings.some((w) => w.includes('in the future'))).toBe(true);
    expect(sim(a, settings(), 1, T0 - 60).warnings.some((w) => w.includes('in the future'))).toBe(false);
  });

  it('a custom hero order reorders hero candidates', () => {
    const ex = maxLab(makeExport(16, 15));
    setLevel(ex, 'heroes', 'barbarian-king', { lvl: 40 });
    setLevel(ex, 'heroes', 'royal-champion', { lvl: 20 });
    const heroes = (s: Settings) => cands(parse(ex), s).filter((x) => x.tier === 3).map((x) => x.item.id);
    expect(heroes(settings())).toEqual(['barbarian-king', 'royal-champion']);
    const custom = ['royal-champion', 'barbarian-king', 'archer-queen', 'grand-warden', 'dragon-duke', 'minion-prince'];
    expect(heroes(settings({ heroOrder: custom }))).toEqual(['royal-champion', 'barbarian-king']);
  });

  it('crafted-defense modules: one module upgrade at a time per crafted defense', () => {
    const byDef = new Map<number, Item[]>();
    for (const it of data.items.values()) if (it.craftedDefenseId && it.levels.length > 2) byDef.set(it.craftedDefenseId, [...(byDef.get(it.craftedDefenseId) ?? []), it]);
    const [defId, mods] = [...byDef].find(([, m]) => m.length >= 2)!;
    const ex = maxLab(makeExport(MAX_TH, MAX_TH));
    ex.buildings.push({ data: 1000097, lvl: 1, types: [{ data: defId, modules: mods.slice(0, 2).map((m) => ({ data: m.dataId, lvl: 1 })) }] });
    const a = parse(ex);
    const mine = (c: ReturnType<typeof cands>) => c.filter((x) => x.item.craftedDefenseId === defId);
    expect(mine(cands(a)).length).toBe(2); // both offered …
    expect(new Set(mine(cands(a)).map((x) => x.lockUid)).size).toBe(1); // … on one shared lock
    const s = sim(a, settings(), 60);
    const jobs = s.timeline.filter((e) => data.items.get(e.itemKey)?.craftedDefenseId === defId).sort((x, y) => x.start - y.start);
    expect(jobs.length).toBeGreaterThan(1);
    for (let i = 1; i < jobs.length; i++) expect(jobs[i].start).toBeGreaterThanOrEqual(jobs[i - 1].end);
  });

  it('every lock holds at most one upgrade at a time over 30 days (fixture)', () => {
    const fx = fixtureJson();
    const s = sim(parse(fx), settings(), 30);
    const byLock = new Map<string, TimelineEntry[]>();
    for (const e of s.timeline) byLock.set(e.lockUid, [...(byLock.get(e.lockUid) ?? []), e]);
    expect(byLock.size).toBeGreaterThan(10);
    for (const list of byLock.values()) {
      list.sort((x, y) => x.start - y.start);
      for (let i = 1; i < list.length; i++) expect(list[i].start).toBeGreaterThanOrEqual(list[i - 1].end);
    }
  });

  it('nothing starts exactly at the horizon; "Now" holds only t = 0 starts', () => {
    const fx = parse(fixtureJson());
    const s = simulate(data, fx, settings(), EMPTY_META, { nowSec: fx.exportTimestamp!, horizonSec: 3 * 3600 }); // BK frees at exactly 3h
    expect(s.timeline.some((e) => !e.inProgress && e.start >= 3 * 3600)).toBe(false);
    const plan = buildPlan(data, fx, settings(), EMPTY_META, fx.exportTimestamp!);
    expect(plan.startNow.length).toBeGreaterThan(0);
    expect(plan.startNow.every((e) => e.start === 0 && !e.inProgress)).toBe(true);
    const f = forecast([{ ...s.timeline[0], inProgress: false, start: DAY, cost: 5, resource: 'gold' }], DAY);
    expect(f.totals).toEqual({});
  });
});

describe('Gold Pass', () => {
  it('shortens research and pet jobs by the research boost; running timers unchanged', () => {
    const fx = parse(fixtureJson());
    const pet = (gp: Settings['goldPass']) => sim(fx, settings({ goldPass: gp }), 1).timeline.find((e) => e.slotId === 'PET' && !e.inProgress)!;
    expect(pet('max').end - pet('max').start).toBe(Math.round((pet('none').end - pet('none').start) * 0.8));
    const lab = (gp: Settings['goldPass']) => sim(fx, settings({ goldPass: gp }), 3).timeline.find((e) => e.slotId === 'LAB' && !e.inProgress)!;
    expect(lab('max').end - lab('max').start).toBe(Math.round((lab('none').end - lab('none').start) * 0.8));
  });

  it('book-ready list shows the Gold-Pass time when the toggle is on; the threshold check stays raw', () => {
    const ex = makeExport(MAX_TH, MAX_TH);
    const aq = data.byId.get('archer-queen')!;
    const firstBook = aq.levels.find((l) => l.timeSec >= data.bookThresholdSec)!;
    setLevel(ex, 'heroes', 'archer-queen', { lvl: firstBook.level - 1 });
    const none = buildPlan(data, parse(ex), settings(), EMPTY_META, T0).bookReady.find((b) => b.name === 'Archer Queen')!;
    const max = buildPlan(data, parse(ex), settings({ goldPass: 'max' }), EMPTY_META, T0).bookReady.find((b) => b.name === 'Archer Queen')!;
    expect(none.timeSec).toBe(firstBook.timeSec);
    expect(max.timeSec).toBe(Math.round(firstBook.timeSec * 0.8));
    expect(max.rawTimeSec).toBe(firstBook.timeSec);
  });
});

describe('book threshold follows the data', () => {
  it('a hero level one day longer raises the threshold (8d → 9d today); the old threshold levels become eligible', () => {
    const T = data.bookThresholdSec;
    // A hero level at today's threshold, and another hero whose top level gets one day longer than that.
    const hero = [...data.items.values()].find((i) => i.category === 'hero' && i.levels.some((l) => l.timeSec === T))!;
    const other = hero.id === 'barbarian-king' ? 'grand-warden' : 'barbarian-king';
    const d = modifiedData((f) => {
      // ClashKing: row N's upgrade_time is the time of level N+1, so this changes the top level's time.
      const h = rawItem(f, other);
      h.levels[h.levels.length - 2].upgrade_time = T + DAY;
    });
    expect(d.bookThresholdSec).toBe(T + DAY);
    const atOld = hero.levels.find((l) => l.timeSec === T)!;
    const hh = atOld.heroHallRequired ?? 0;
    expect(heroStatus(hero, atOld.level - 1, hh, d.bookThresholdSec).kind).toBe('eligible');
    expect(heroStatus(data.items.get(hero.key)!, atOld.level - 1, hh, data.bookThresholdSec).kind).toBe('bookReady');
  });
});

describe('walls, equipment and pins', () => {
  it('wall dump: the lowest wall level with an available next level, across several levels', () => {
    const wall = data.byId.get('wall')!;
    const max16 = maxLevelAt(wall, { th: 16 });
    const a = parse(makeExport(16, 15));
    expect(wallDump(data, { ...a, walls: [{ level: max16 - 2, count: 10 }, { level: max16 - 1, count: 5 }] })!.fromLevel).toBe(max16 - 2);
    const top = wallDump(data, { ...a, walls: [{ level: max16 - 1, count: 5 }, { level: max16, count: 50 }] })!;
    expect(top.fromLevel).toBe(max16 - 1);
    expect(top.countAtLevel).toBe(5);
  });

  it('unused equipment: cheapest first, rarest ore weighing most (starry, then glowy, then shiny)', () => {
    const ex = makeExport(16, 15);
    for (const it of [...data.items.values()].filter((i) => i.category === 'equipment').slice(0, 12)) if (!ex.equipment.some((e) => e.data === it.dataId)) ex.equipment.push({ data: it.dataId, lvl: 1 });
    const list = equipmentCandidates(data, parse(ex).instances, settings(), EMPTY_META);
    expect(list.length).toBeGreaterThan(5);
    const key = (c: (typeof list)[0]) => [c.ore!.starryOre, c.ore!.glowyOre, c.ore!.shinyOre];
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [key(list[i - 1]), key(list[i])];
      const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it('pins stay on top of the lab, pet and blacksmith lists after a meta refresh', () => {
    const ex = makeExport(16, 15);
    const a = parse(ex);
    const s = settings({ lab: { pinned: ['wall-wrecker'] }, petHouse: { pinned: ['lassi'] }, blacksmith: { pinned: ['barbarian-puppet'] } });
    for (const meta of [EMPTY_META, META]) {
      const st = stateOf(a);
      expect(researchCandidates(data, st, 'lab', s, meta, 0)[0].item.id).toBe('wall-wrecker');
      expect(researchCandidates(data, st, 'petHouse', s, meta, 0)[0].item.id).toBe('lassi');
      expect(equipmentCandidates(data, a.instances, s, meta)[0].item.id).toBe('barbarian-puppet');
    }
  });
});
