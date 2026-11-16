import { describe, expect, it } from 'vitest';
import { GOLD_PASS_MAX_BOOST } from '../src/engine/constants';
import { forecast, wallDump } from '../src/engine/forecast';
import { buildPlan } from '../src/engine/plan';
import { simulate, type TimelineEntry } from '../src/engine/scheduler';
import { EMPTY_META } from '../src/meta/meta';
import { data, makeExport, parse, setLevel, settings, T0 } from './helpers';
import fs from 'node:fs';
import { parseExport } from '../src/state/parseExport';

const fixture = () => parseExport(fs.readFileSync(new URL('./fixtures/export-th16.json', import.meta.url), 'utf8'), data);
const DAY = 86400;

describe('scheduler', () => {
  it('in-progress upgrades hold their slot for the remaining time minus export age', () => {
    const sim = simulate(data, fixture(), settings(), EMPTY_META, { nowSec: T0 + 3600, horizonSec: DAY });
    const bk = sim.timeline.find((e) => e.inProgress && e.itemName === 'Barbarian King')!;
    expect(bk.end).toBe(2 * 3600); // 3h timer, export is 1h old
    expect(sim.elapsedSec).toBe(3600);
  });

  it('the goblin builder finishes its job but takes no new work', () => {
    const sim = simulate(data, fixture(), settings(), EMPTY_META, { nowSec: T0, horizonSec: 3 * DAY });
    const gb = sim.timeline.filter((e) => e.slotId === 'GB');
    expect(gb).toHaveLength(1);
    expect(gb[0].inProgress).toBe(true);
  });

  it('Goblin Builder and Goblin Researcher jobs run out their timers but never get new work (SPEC §10.1)', () => {
    const ex = makeExport(16);
    const plain = parse(ex);
    // Goblin Builder: one Gold Mine upgrading, 2h left. Goblin Researcher: Barbarian, 3h left.
    const mineId = data.byId.get('gold-mine')!.dataId;
    const mine = ex.buildings.find((b) => b.data === mineId)!;
    mine.cnt = (mine.cnt ?? 1) - 1;
    ex.buildings.push({ data: mineId, lvl: mine.lvl, cnt: 1, timer: 2 * 3600, extra: true });
    setLevel(ex, 'units', 'barbarian', { timer: 3 * 3600, extra: true });
    const acct = parse(ex);
    expect(acct.builders).toBe(plain.builders); // goblins are not schedulable slots

    const plan = buildPlan(data, acct, settings(), EMPTY_META, T0);
    const goblinSlots = plan.sim.slots.filter((s) => s.goblin).map((s) => s.id);
    expect(goblinSlots.sort()).toEqual(['GB', 'GL']);

    for (const [id, name, end] of [['GB', 'Gold Mine', 2 * 3600], ['GL', 'Barbarian', 3 * 3600]] as const) {
      const jobs = plan.sim.timeline.filter((e) => e.slotId === id);
      expect(jobs).toHaveLength(1); // only the running job: nothing new after it finishes
      expect(jobs[0]).toMatchObject({ inProgress: true, itemName: name, end });
      expect(end).toBeLessThan(plan.forecast.windowSec); // finishes inside the 24h window
    }
    // Not in "Now", not in the 24h forecast.
    expect(plan.startNow.some((e) => goblinSlots.includes(e.slotId))).toBe(false);
    for (const list of Object.values(plan.forecast.neededBy)) expect(list!.some((n) => goblinSlots.includes(n.slotId))).toBe(false);
    // Regular slots keep working: builders and the lab take new upgrades in the window.
    expect(plan.sim.timeline.some((e) => !e.inProgress && e.slotId.startsWith('B'))).toBe(true);
    expect(plan.sim.timeline.filter((e) => !e.inProgress && e.itemName === 'Barbarian').every((e) => e.slotId === 'LAB')).toBe(true);
  });

  it('Gold Pass max shortens new builder and research jobs, not running timers', () => {
    const none = simulate(data, fixture(), settings(), EMPTY_META, { nowSec: T0, horizonSec: DAY });
    const max = simulate(data, fixture(), settings({ goldPass: 'max' }), EMPTY_META, { nowSec: T0, horizonSec: DAY });
    const thNone = none.timeline.find((e) => e.itemName === 'Town Hall')!;
    const thMax = max.timeline.find((e) => e.itemName === 'Town Hall')!;
    expect(thMax.end - thMax.start).toBe(Math.round((thNone.end - thNone.start) * (1 - GOLD_PASS_MAX_BOOST.builder)));
    const xbN = none.timeline.find((e) => e.inProgress && e.itemName === 'X-Bow')!;
    const xbM = max.timeline.find((e) => e.inProgress && e.itemName === 'X-Bow')!;
    expect(xbM.end).toBe(xbN.end);
  });

  it('rush mode: the first free builder takes the Laboratory (Tier 0), the next one the Town Hall', () => {
    const plan = buildPlan(data, fixture(), settings(), EMPTY_META, T0);
    expect(plan.mode).toBe('rush');
    const builders = plan.startNow.filter((e) => e.slotId.startsWith('B')).map((e) => e.itemName);
    expect(builders.slice(0, 2)).toEqual(['Laboratory', 'Town Hall']);
  });

  it('merge builds consume sources and create the merged defense in the simulation', () => {
    const ex = makeExport(16, 15);
    setLevel(ex, 'buildings', 'ricochet-cannon', { cnt: 1 });
    setLevel(ex, 'buildings', 'cannon', { cnt: 5, lvl: 21 });
    const sim = simulate(data, parse(ex), settings(), EMPTY_META, { nowSec: T0, horizonSec: DAY });
    expect(sim.timeline.some((e) => e.kind === 'merge' && e.itemName === 'Ricochet Cannon')).toBe(true);
    expect(sim.finalInstances.filter((i) => i.dataId === 1000008)).toHaveLength(3);
    expect(sim.finalInstances.filter((i) => i.dataId === 1000085)).toHaveLength(2);
  });
});

describe('24h forecast', () => {
  it('sums the cost of every upgrade that starts inside the window, excluding running ones', () => {
    const tl: TimelineEntry[] = [
      { slotId: 'B1', lockUid: 'L', start: 0, end: 10, itemKey: 'a', itemName: 'A', toLevel: 2, cost: 999, resource: 'gold', reason: '', kind: 'inProgress', inProgress: true },
      { slotId: 'B1', lockUid: 'L', start: 10, end: 100, itemKey: 'b', itemName: 'B', toLevel: 2, cost: 3_000_000, resource: 'gold', reason: '', kind: 'upgrade', inProgress: false },
      { slotId: 'B2', lockUid: 'L', start: 50, end: 100, itemKey: 'c', itemName: 'C', toLevel: 5, cost: 2_000_000, resource: 'gold', reason: '', kind: 'upgrade', inProgress: false },
      { slotId: 'B3', lockUid: 'L', start: 70, end: 100, itemKey: 'd', itemName: 'D', toLevel: 5, cost: 150_000, resource: 'darkElixir', reason: '', kind: 'upgrade', inProgress: false },
      { slotId: 'B2', lockUid: 'L', start: DAY, end: DAY + 9, itemKey: 'e', itemName: 'E', toLevel: 5, cost: 7_000_000, resource: 'elixir', reason: '', kind: 'upgrade', inProgress: false },
    ];
    const f = forecast(tl, DAY, [], 3);
    expect(f.totals).toEqual({ gold: 5_000_000, darkElixir: 150_000 });
    expect(f.neededBy.gold!.map((n) => [n.at, n.cumulative])).toEqual([
      [10, 3_000_000],
      [50, 5_000_000],
    ]);
  });

  it('plan totals match the simulated starts in the window', () => {
    const plan = buildPlan(data, fixture(), settings(), EMPTY_META, T0);
    const sums: Record<string, number> = {};
    for (const e of plan.sim.timeline) if (!e.inProgress && e.start < DAY && e.cost > 0) sums[e.resource] = (sums[e.resource] ?? 0) + e.cost;
    expect(plan.forecast.totals).toEqual(sums);
    expect(Object.keys(sums).length).toBeGreaterThan(0);
  });

  it('ore totals cover the top-N equipment picks', () => {
    const plan = buildPlan(data, fixture(), settings(), EMPTY_META, T0);
    const shiny = plan.forecast.oreItems.reduce((s, c) => s + (c.ore?.shinyOre ?? 0), 0);
    expect(plan.forecast.ore.shinyOre).toBe(shiny);
    expect(plan.forecast.oreItems.length).toBeLessThanOrEqual(3);
  });
});

describe('wall dump', () => {
  it('uses the lowest owned wall level with an available next level', () => {
    const ex = makeExport(18, 18);
    ex.buildings = ex.buildings.filter((b) => b.data !== 1000010);
    ex.buildings.push({ data: 1000010, lvl: 17, cnt: 148 }, { data: 1000010, lvl: 18, cnt: 177 });
    const w = wallDump(data, parse(ex))!;
    expect(w.fromLevel).toBe(17);
    expect(w.toLevel).toBe(18);
    expect(w.countAtLevel).toBe(148);
    expect(w.text).toBe('Overflow → walls: Lv 17→18 costs 7M gold or elixir each; 148 walls at Lv 17.');
  });

  it('is null when every wall is maxed for the TH', () => {
    expect(wallDump(data, parse(makeExport(18, 18)))).toBeNull();
  });
});
