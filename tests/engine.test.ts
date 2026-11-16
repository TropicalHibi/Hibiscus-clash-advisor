import { describe, expect, it } from 'vitest';
import { checkHeroCaps, checkLevels, checkMergeConsumption } from '../src/data/validate';
import { heroCapAt, heroStatus } from '../src/engine/book';
import { buildPlan } from '../src/engine/plan';
import { builderCandidates, detectMode, OFFENSE_ORDER, type EngineState } from '../src/engine/tiers';
import { EMPTY_META } from '../src/meta/meta';
import type { AccountState } from '../src/state/parseExport';
import { data, makeExport, maxLab, parse, setLevel, settings, T0 } from './helpers';

function stateOf(a: AccountState): EngineState {
  const busy = new Set<string>();
  for (const i of a.instances) if (i.upgradingTo !== undefined) busy.add(i.parentUid ?? i.uid);
  return { instances: a.instances, busy };
}
const cands = (a: AccountState, s = settings()) => builderCandidates(data, stateOf(a), s, { builderBoost: 0 });
const heroLevel = (id: string, hh: number) => heroCapAt(data.byId.get(id)!, hh);

describe('mode detection', () => {
  it('rush below max TH, max-TH at max TH (max TH comes from data)', () => {
    expect(data.maxTH).toBe(18);
    expect(detectMode(17, data)).toBe('rush');
    expect(detectMode(18, data)).toBe('maxTH');
  });
});

const dataIdOf = (id: string) => data.byId.get(id)!.dataId;

describe('Tier 0: Laboratory, new buildings, then the Archer Queen', () => {
  it('an unbuilt new building outranks the Queen', () => {
    const ex = maxLab(makeExport(15));
    const hh = ex.buildings.find((b) => b.data === 1000071)!.lvl;
    setLevel(ex, 'heroes', 'archer-queen', { lvl: heroLevel('archer-queen', hh) - 5 });
    setLevel(ex, 'buildings', 'x-bow', { cnt: 3 }); // TH15 allows 4: one extra copy unbuilt
    const c = cands(parse(ex));
    expect(c[0].item.id).toBe('x-bow');
    expect(c[0].kind).toBe('build');
    expect(c[0].tier).toBe(0);
    expect(c[0].toLevel).toBe(1);
    expect(c[1].item.id).toBe('archer-queen');
    expect(c[1].tier).toBe(0);
    // The unbuilt X-Bow also keeps the TH gate closed.
    expect(c.some((x) => x.item.id === 'town-hall')).toBe(false);
  });

  it('several new buildings: normal tier first (offense → resources → defenses), then longest first', () => {
    const ex = maxLab(makeExport(15));
    setLevel(ex, 'buildings', 'x-bow', { cnt: 3 });
    setLevel(ex, 'buildings', 'inferno-tower', { cnt: 2 });
    setLevel(ex, 'buildings', 'gold-storage', { cnt: (ex.buildings.find((b) => b.data === dataIdOf('gold-storage'))!.cnt ?? 1) - 1 });
    setLevel(ex, 'buildings', 'army-camp', { cnt: (ex.buildings.find((b) => b.data === dataIdOf('army-camp'))!.cnt ?? 1) - 1 });
    const t0 = cands(parse(ex)).filter((x) => x.tier === 0);
    expect(t0.map((x) => x.item.id).slice(0, 2)).toEqual(['army-camp', 'gold-storage']);
    const defs = t0.slice(2);
    expect(defs.map((x) => x.item.id).sort()).toEqual(['inferno-tower', 'x-bow']);
    expect(defs[0].rawTimeSec).toBeGreaterThanOrEqual(defs[1].rawTimeSec);
  });

  it('the Queen outranks everything else, including the Town Hall, when not book-ready', () => {
    const ex = maxLab(makeExport(15));
    const hh = ex.buildings.find((b) => b.data === 1000071)!.lvl;
    setLevel(ex, 'heroes', 'archer-queen', { lvl: heroLevel('archer-queen', hh) - 5 });
    const c = cands(parse(ex));
    expect(c[0].item.id).toBe('archer-queen');
    expect(c[0].tier).toBe(0);
    expect(c[1].item.id).toBe('town-hall');
  });

  it('is skipped while already upgrading', () => {
    const ex = makeExport(15);
    const hh = ex.buildings.find((b) => b.data === 1000071)!.lvl;
    setLevel(ex, 'heroes', 'archer-queen', { lvl: heroLevel('archer-queen', hh) - 5, timer: 3600 });
    expect(cands(parse(ex)).some((c) => c.item.id === 'archer-queen')).toBe(false);
  });
});

describe('hero book threshold', () => {
  const aq = data.byId.get('archer-queen')!;
  const threshold = data.bookThresholdSec;

  it('threshold = longest hero level in the data (not hard-coded)', () => {
    const max = Math.max(...[...data.items.values()].filter((i) => i.category === 'hero').flatMap((h) => h.levels.map((l) => l.timeSec)));
    expect(threshold).toBe(max);
    expect(threshold).toBe(8 * 86400);
  });

  it('next level time ≥ threshold → book-ready; below → eligible', () => {
    const firstBook = aq.levels.find((l) => l.timeSec >= threshold)!;
    const lastBelow = [...aq.levels].reverse().find((l) => l.timeSec < threshold && l.level < firstBook.level)!;
    expect(heroStatus(aq, firstBook.level - 1, 12, threshold).kind).toBe('bookReady');
    expect(heroStatus(aq, lastBelow.level - 1, 12, threshold).kind).toBe('eligible');
  });

  it('book-ready Queen drops out of scheduling and shows on the book-ready list', () => {
    const ex = makeExport(18, 18);
    const firstBook = aq.levels.find((l) => l.timeSec >= threshold)!;
    setLevel(ex, 'heroes', 'archer-queen', { lvl: firstBook.level - 1 });
    const a = parse(ex);
    expect(cands(a).some((c) => c.item.id === 'archer-queen')).toBe(false);
    const plan = buildPlan(data, a, settings(), EMPTY_META, T0);
    expect(plan.bookReady.map((b) => b.name)).toContain('Archer Queen');
  });

  it('hero caps come from per-level heroHallLevelRequired, not the stale Hero Hall table', () => {
    expect(heroCapAt(aq, 12)).toBe(110);
    expect(data.heroHallCaps[12]['archer-queen']).toBe(105);
    expect(heroStatus(aq, 107, 12, threshold).kind).not.toBe('cappedByHeroHall');
    expect(checkHeroCaps(data).some((i) => i.message.includes('Archer Queen'))).toBe(true);
  });

  it('a hero capped by Hero Hall is skipped and the next hero in order is used', () => {
    const ex = makeExport(16, 15); // heroes at their HH cap
    const a = parse(ex);
    const heroes = cands(a).filter((c) => c.item.category === 'hero');
    expect(heroes).toHaveLength(0);
    // Drop Dragon Duke below cap: it becomes the only hero candidate even though GW is earlier in order.
    const hh = ex.buildings.find((b) => b.data === 1000071)!.lvl;
    setLevel(ex, 'heroes', 'dragon-duke', { lvl: heroLevel('dragon-duke', hh) - 1 });
    const h2 = cands(parse(ex)).filter((c) => c.item.category === 'hero');
    expect(h2.map((c) => c.item.id)).toEqual(['dragon-duke']);
  });
});

describe('tier order', () => {
  it('rush mode: TH path → offense → heroes → resources → defenses → temporary', () => {
    const ex = maxLab(makeExport(15, 14));
    const hh = ex.buildings.find((b) => b.data === 1000071)!.lvl;
    setLevel(ex, 'heroes', 'barbarian-king', { lvl: Math.min(50, heroLevel('barbarian-king', hh) - 1) }); // below the 8d book levels
    const c = cands(parse(ex));
    expect(c[0].item.id).toBe('town-hall');
    expect(c[0].tier).toBe(1);
    const firstOf = (pred: (x: (typeof c)[0]) => boolean) => c.findIndex(pred);
    const offense = firstOf((x) => x.item.category === 'army');
    const hero = firstOf((x) => x.item.category === 'hero');
    const storage = firstOf((x) => x.item.category === 'resourceStorage');
    const defense = firstOf((x) => x.item.category === 'defense');
    expect(c[offense].tier).toBe(2);
    expect(c[hero].tier).toBe(3);
    expect(c[storage].tier).toBe(4);
    expect(c[defense].tier).toBe(5);
    expect(offense).toBeLessThan(hero);
    expect(hero).toBeLessThan(storage);
    expect(storage).toBeLessThan(defense);
    // offense follows the configured building order
    const firstOffense = OFFENSE_ORDER.find((id) => c.some((x) => x.item.id === id && x.tier === 2));
    expect(c[offense].item.id).toBe(firstOffense);
    expect(c.some((x) => x.item.id === 'laboratory')).toBe(false); // maxed here; otherwise it would be Tier 0
  });

  it('max-TH mode: offense → heroes → TH gate → resources → defenses → temporary', () => {
    const ex = makeExport(18, 17);
    const hh = ex.buildings.find((b) => b.data === 1000071)!.lvl;
    setLevel(ex, 'heroes', 'barbarian-king', { lvl: Math.min(50, heroLevel('barbarian-king', hh) - 1) }); // below the 8d book levels
    const c = cands(parse(ex));
    expect(c.some((x) => x.item.id === 'town-hall')).toBe(false);
    const tierOf = (id: string) => c.find((x) => x.item.id === id)!.tier;
    expect(tierOf('laboratory')).toBe(0); // Laboratory upgrade is Tier 0 in both modes
    expect(tierOf('army-camp')).toBe(1);
    expect(tierOf('barbarian-king')).toBe(2);
    expect(tierOf('super-wizard-tower')).toBe(5); // merged-defense upgrade past L1 → permanent defense
    expect(tierOf('ricochet-cannon')).toBe(5);
    expect(tierOf('gold-storage')).toBe(4);
    expect(tierOf('x-bow')).toBe(5);
    const tiers = c.map((x) => x.tier);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
  });

  it('storages come before collectors, lowest level first', () => {
    const ex = makeExport(18, 15);
    const c = cands(parse(ex)).filter((x) => x.tier === 4);
    const firstCollector = c.findIndex((x) => x.item.category === 'resourceCollector');
    const lastStorage = c.map((x) => x.item.category).lastIndexOf('resourceStorage');
    expect(lastStorage).toBeLessThan(firstCollector);
    const storageLevels = c.filter((x) => x.item.category === 'resourceStorage').map((x) => x.instance.level);
    expect([...storageLevels].sort((a, b) => a - b)).toEqual(storageLevels);
  });
});

describe('LPT ordering (tiers 5–6)', () => {
  it('orders longest time first, cheaper first on ties', () => {
    const c = cands(parse(makeExport(18, 16)));
    for (const tier of [5, 6]) {
      const t = c.filter((x) => x.tier === tier);
      expect(t.length).toBeGreaterThan(3);
      for (let i = 1; i < t.length; i++) {
        expect(t[i - 1].rawTimeSec).toBeGreaterThanOrEqual(t[i].rawTimeSec);
        if (t[i - 1].rawTimeSec === t[i].rawTimeSec) expect(t[i - 1].cost).toBeLessThanOrEqual(t[i].cost);
      }
    }
  });

  it('free builders take the longest permanent-defense upgrades first', () => {
    const ex = makeExport(18, 18); // everything maxed …
    setLevel(ex, 'buildings', 'x-bow', { lvl: 12 }); // … except 4 X-Bows,
    setLevel(ex, 'buildings', 'inferno-tower', { lvl: 11 }); // 3 Infernos,
    setLevel(ex, 'buildings', 'air-sweeper', { lvl: 5 }); // 2 Air Sweepers
    const a = parse(ex);
    const t5 = cands(a).filter((x) => x.tier === 5);
    expect(t5).toHaveLength(9);
    const plan = buildPlan(data, a, settings(), EMPTY_META, T0);
    const started = plan.startNow.filter((e) => e.slotId.startsWith('B'));
    expect(started).toHaveLength(6);
    const longest6 = t5.slice(0, 6).map((c) => c.rawTimeSec).sort((x, y) => y - x);
    expect(started.map((e) => e.end - e.start).sort((x, y) => y - x)).toEqual(longest6);
    expect(started.some((e) => e.itemName === 'Air Sweeper')).toBe(false);
  });
});

describe('merges', () => {
  it('data passes the merge consumption check with the shipped merges.yaml', () => {
    expect(checkMergeConsumption(data)).toEqual([]);
    expect(checkLevels(data)).toEqual([]);
  });

  it('derives unlock TH and required source level from data', () => {
    const rc = data.merges.find((m) => m.id === 'ricochet-cannon')!;
    expect(rc.unlockTH).toBe(16);
    expect(rc.requiredSourceLevel['cannon']).toBe(21);
    expect(data.merges.find((m) => m.id === 'super-wizard-tower')!.unlockTH).toBe(18);
  });

  it('TH-upgrading lookahead: next TH merge sources are worked while the TH upgrades', () => {
    const ex = maxLab(makeExport(15, 14)); // cannons/archer towers at 20, TH15 allows 21
    const idle = cands(parse(ex));
    expect(idle.some((c) => c.reason.includes('lookahead'))).toBe(false);
    expect(idle[0].item.id).toBe('town-hall');

    setLevel(ex, 'buildings', 'town-hall', { timer: 5 * 86400 });
    const c = cands(parse(ex));
    const look = c.filter((x) => x.reason.includes('lookahead'));
    // Ricochet Cannon ×2 at TH16 = 4 cannons; Multi-Archer Tower ×2 = 4 archer towers.
    expect(look.filter((x) => x.item.id === 'cannon')).toHaveLength(4);
    expect(look.filter((x) => x.item.id === 'archer-tower')).toHaveLength(4);
    expect(look.every((x) => x.tier === 1 && x.toLevel === 21)).toBe(true);
    // No Multi-Gear Tower sources yet (needed at TH17, two THs away).
    expect(look.some((x) => x.reason.includes('Multi-Gear'))).toBe(false);
    // Lookahead sources outrank offense.
    expect(c.findIndex((x) => x.reason.includes('lookahead'))).toBeLessThan(c.findIndex((x) => x.item.category === 'army'));
  });

  it('a merge whose sources are maxed is a new building: Tier 0, ahead of the Queen', () => {
    const ex = maxLab(makeExport(16, 15));
    const hh = ex.buildings.find((b) => b.data === 1000071)!.lvl;
    setLevel(ex, 'heroes', 'archer-queen', { lvl: heroLevel('archer-queen', hh) - 5 });
    // One Ricochet Cannon missing, two spare Cannons at 21.
    setLevel(ex, 'buildings', 'ricochet-cannon', { cnt: 1 });
    setLevel(ex, 'buildings', 'cannon', { cnt: 5, lvl: 21 });
    const c = cands(parse(ex));
    const merge = c.find((x) => x.kind === 'merge')!;
    expect(merge.item.id).toBe('ricochet-cannon');
    expect(merge.tier).toBe(0);
    expect(merge.consumes).toHaveLength(2);
    expect(c[0]).toBe(merge);
    expect(c.findIndex((x) => x.item.id === 'archer-queen')).toBeGreaterThan(0);
  });

  it('rush: the Town Hall waits for the TH gate (available merge not performed yet)', () => {
    const ex = makeExport(17, 16);
    // A Ricochet Cannon (TH16 merge) is missing; its Cannons are below 21.
    setLevel(ex, 'buildings', 'ricochet-cannon', { cnt: 2 });
    ex.buildings.push({ data: dataIdOf('cannon'), lvl: 19, cnt: 2 });
    const c = cands(parse(ex));
    expect(c.some((x) => x.item.id === 'town-hall')).toBe(false);
    const gate = c.filter((x) => x.reason.startsWith('TH gate'));
    expect(gate.map((x) => x.item.id)).toEqual(['cannon', 'cannon']);
    expect(gate.every((x) => x.tier === 1)).toBe(true);
    // Gate clear → the Town Hall is back at the top of tier 1.
    const clear = cands(parse(makeExport(17, 16)));
    expect(clear.find((x) => x.tier === 1)!.item.id).toBe('town-hall');
  });

  it('max TH: an unmerged older merge is a TH gate item (tier 3), above resources and defenses', () => {
    const ex = makeExport(18, 18);
    // Ricochet Cannon is a TH16 merge. One is missing; its two Cannons are still below 21.
    setLevel(ex, 'buildings', 'ricochet-cannon', { cnt: 2 });
    ex.buildings.push({ data: dataIdOf('cannon'), lvl: 19, cnt: 2 });
    const c = cands(parse(ex));
    expect(c.some((x) => x.kind === 'merge')).toBe(false); // sources not ready yet
    const gate = c.filter((x) => x.item.id === 'cannon');
    expect(gate).toHaveLength(2);
    expect(gate.every((x) => x.tier === 3 && x.reason.startsWith('TH gate'))).toBe(true);
    expect(c.find((x) => x.tier === 3)!.item.id).toBe('cannon');
    expect(c.filter((x) => x.tier === 4 || x.tier === 5).every((x) => x.item.id !== 'cannon')).toBe(true);

    // Once the Cannons are maxed, the merge itself jumps to Tier 0.
    const ex2 = makeExport(18, 18);
    setLevel(ex2, 'buildings', 'ricochet-cannon', { cnt: 2 });
    ex2.buildings.push({ data: dataIdOf('cannon'), lvl: 21, cnt: 2 });
    const c2 = cands(parse(ex2));
    expect(c2[0].kind).toBe('merge');
    expect(c2[0].item.id).toBe('ricochet-cannon');
    expect(c2[0].tier).toBe(0);
    expect(c2.some((x) => x.tier === 3)).toBe(false);
  });

  it('merged-defense upgrades past level 1 land in the permanent-defense tier (both modes), longest first', () => {
    for (const [th, levelTH] of [
      [17, 16],
      [18, 17],
    ]) {
      const c = cands(parse(makeExport(th, levelTH)));
      const merged = c.filter((x) => x.item.category === 'mergedDefense' && x.kind === 'upgrade');
      expect(merged.length).toBeGreaterThan(0);
      expect(merged.every((x) => x.tier === 5 && x.toLevel >= 2)).toBe(true);
      // Interleaved with other defenses by LPT, not grouped by merge.
      const t5 = c.filter((x) => x.tier === 5);
      for (let i = 1; i < t5.length; i++) expect(t5[i - 1].rawTimeSec).toBeGreaterThanOrEqual(t5[i].rawTimeSec);
    }
  });
});
