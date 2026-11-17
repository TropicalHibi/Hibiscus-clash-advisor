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
import { addTownHallLevel, data, makeExport, MAX_TH, modifiedData, parseWith, rawItem, settings, T0 } from './helpers';

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
