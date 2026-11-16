// Follow-up after Step 3: running upgrades on unknown ids hold their slot, the 23-hour helper cycle,
// boost rules (potion + bite, clock tower cooldown, Research Potion vs Pet Potion), dates in far finish times.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fmtClock } from '../src/engine/format';
import { buildPlan } from '../src/engine/plan';
import { simulate } from '../src/engine/scheduler';
import { EMPTY_META } from '../src/meta/meta';
import { parseExport } from '../src/state/parseExport';
import { data, makeExport, maxLab, parse, setLevel, settings, T0, type Entry, type SyntheticExport } from './helpers';

const H = 3600;
const D = 86400;
const sim = (ex: SyntheticExport, s = settings(), nowSec = T0, horizonSec = D) => simulate(data, parse(ex), s, EMPTY_META, { nowSec, horizonSec });
const entryFor = (r: ReturnType<typeof sim>, id: string) => r.timeline.find((e) => e.itemKey === data.byId.get(id)!.key)!;
const UNKNOWN_BUILDING = 1000999; // not in the game data
const add = (ex: SyntheticExport, section: keyof SyntheticExport, e: Record<string, unknown>) => (ex[section] as Entry[]).push(e as unknown as Entry);

/** TH16, Lab maxed; every regular builder busy for 2 days except the ones we leave free. */
function busyExport(freeBuilders: number): SyntheticExport {
  const ex = maxLab(makeExport(16));
  const builders = ex.buildings.filter((b) => b.data === 1000015).reduce((n, b) => n + (b.cnt ?? 1), 0) + (ex.buildings.some((b) => b.data === 1000064) ? 1 : 0);
  // Heroes as the busy jobs (one instance each).
  const heroes = ex.heroes.slice(0, builders - freeBuilders);
  expect(heroes.length).toBe(builders - freeBuilders);
  for (const h of heroes) h.timer = 2 * D;
  return ex;
}

describe('running upgrades on unknown ids', () => {
  it('a level-0 unknown building under construction holds a builder: nothing to start "Now"', () => {
    const ex = busyExport(1);
    expect(buildPlan(data, parse(ex), settings(), EMPTY_META, T0).startNow.filter((e) => e.slotId.startsWith('B'))).toHaveLength(1);
    add(ex, 'buildings', { data: UNKNOWN_BUILDING, lvl: 0, timer: 10 * H });
    const plan = buildPlan(data, parse(ex), settings(), EMPTY_META, T0);
    expect(plan.startNow.filter((e) => e.slotId.startsWith('B'))).toEqual([]);
    const job = plan.sim.timeline.find((e) => e.itemKey === `unknown:${UNKNOWN_BUILDING}`)!;
    expect(job.itemName).toBe(`Unknown item ${UNKNOWN_BUILDING} (not in game data yet)`);
    expect(job).toMatchObject({ inProgress: true, end: 10 * H, toLevel: 1 });
    expect(plan.sim.slots.filter((s) => s.queue === 'builder' && !s.goblin)).toHaveLength(plan.builders); // no extra slot
    expect(plan.warnings.some((w) => w.includes(`${UNKNOWN_BUILDING}`) && w.includes('occupies a slot'))).toBe(true);
    // When it finishes, that builder takes the next upgrade.
    expect(plan.sim.timeline.some((e) => e.slotId === job.slotId && !e.inProgress && e.start === 10 * H)).toBe(true);
  });

  it('unknown research holds the lab, an unknown pet the pet house, an unknown Goblin job its goblin slot', () => {
    const ex = maxLab(makeExport(16));
    add(ex, 'units', { data: 4999001, lvl: 2, timer: 10 * H });
    add(ex, 'pets', { data: 73999001, lvl: 1, timer: 5 * H });
    add(ex, 'traps', { data: 12999001, lvl: 3, timer: 7 * H, extra: true });
    const r = sim(ex);
    const at = (id: number) => r.timeline.find((e) => e.itemKey === `unknown:${id}`)!;
    expect(at(4999001).slotId).toBe('LAB');
    expect(at(73999001).slotId).toBe('PET');
    expect(at(12999001).slotId).toBe('GB');
    expect(r.timeline.filter((e) => e.slotId === 'LAB' && !e.inProgress)[0].start).toBe(10 * H);
    expect(r.timeline.filter((e) => e.slotId === 'PET' && !e.inProgress)[0].start).toBe(5 * H);
    expect(r.timeline.filter((e) => e.slotId === 'GB' && !e.inProgress)).toEqual([]); // goblins never take new work
  });

  it('an unknown id without a timer is still just a warning (no slot)', () => {
    const ex = maxLab(makeExport(16));
    add(ex, 'equipment', { data: 90999001, lvl: 1 });
    add(ex, 'buildings', { data: UNKNOWN_BUILDING, lvl: 3 });
    const acc = parse(ex);
    expect(acc.unknownJobs).toEqual([]);
    expect(acc.unresolved.map((u) => u.dataId).sort()).toEqual([UNKNOWN_BUILDING, 90999001].sort());
  });

  it('the real export (if present): all builders busy, nothing to start on a builder "Now"', () => {
    const file = 'samples/myexport.json';
    if (!fs.existsSync(file)) return;
    const acc = parseExport(fs.readFileSync(file, 'utf8'), data);
    if (!acc.unknownJobs.some((j) => j.dataId === 1000106)) return; // only the export with the new building
    const plan = buildPlan(data, acc, settings(), EMPTY_META, acc.exportTimestamp!);
    expect(plan.startNow.filter((e) => e.slotId.startsWith('B'))).toEqual([]);
    expect(plan.sim.timeline.some((e) => e.itemName === 'Unknown item 1000106 (not in game data yet)')).toBe(true);
  });
});

describe('helpers: 23-hour cycle, potions never speed up the helper', () => {
  it('work hours come every 23 hours from the end of the shared cooldown', () => {
    const ex = maxLab(makeExport(16));
    setLevel(ex, 'heroes', 'barbarian-king', { timer: 10 * D, helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push({ data: 93000000, lvl: 8, helper_cooldown: 2 * H } as unknown as Entry);
    // Hours at +2 h, +25 h, +48 h, +71 h → 4 in a 72 h window.
    expect(entryFor(sim(ex, settings(), T0, 72 * H), 'barbarian-king').helperSavedSec).toBe(4 * 8 * H);
    expect(entryFor(sim(ex, settings(), T0, 70 * H), 'barbarian-king').helperSavedSec).toBe(3 * 8 * H);
  });

  it('a Builder Potion during the work hour adds its own progress; the helper still saves exactly L hours', () => {
    const ex = maxLab(makeExport(16));
    setLevel(ex, 'heroes', 'barbarian-king', { timer: 5 * D, helper_recurrent: true } as Partial<Entry>);
    ex.helpers.push({ data: 93000000, lvl: 8, helper_cooldown: 0 } as unknown as Entry);
    ex.boosts = { builder_boost: H }; // potion running during the same hour
    const bk = entryFor(sim(ex, settings(), T0, 2 * H), 'barbarian-king');
    expect(bk.helperSavedSec).toBe(8 * H); // not 80 h
    expect(bk.end).toBe(5 * D - 9 * H - 8 * H); // potion: 9 extra hours; helper: 8 hours
  });
});

describe('boosts', () => {
  it('Builder Potion (10×) + Builder Bite (+1×) stack additively to 11×', () => {
    const ex = maxLab(makeExport(16));
    setLevel(ex, 'heroes', 'barbarian-king', { timer: 3 * D });
    ex.boosts = { builder_boost: H, builder_consumable: H };
    expect(entryFor(sim(ex), 'barbarian-king').end).toBe(3 * D - 10 * H);
    ex.boosts = { builder_consumable: H };
    expect(entryFor(sim(ex), 'barbarian-king').end).toBe(3 * D - H);
  });

  it('clocktower_cooldown (and the Clock Tower) never speed anything up', () => {
    const ex = maxLab(makeExport(16));
    setLevel(ex, 'heroes', 'barbarian-king', { timer: 3 * D });
    ex.boosts = { clocktower_cooldown: 16501, clocktower_boost: 1800 };
    const r = sim(ex);
    expect(entryFor(r, 'barbarian-king').end).toBe(3 * D);
    expect(r.activeBoosts).toEqual([]);
  });

  it('the Research Potion speeds up the Laboratory only; the Pet Potion (24×) the Pet House only', () => {
    const ex = maxLab(makeExport(16));
    setLevel(ex, 'units', 'archer', { timer: 3 * D });
    setLevel(ex, 'pets', 'lassi', { timer: 2 * D });
    ex.boosts = { lab_boost: H };
    let r = sim(ex);
    expect(entryFor(r, 'archer').end).toBe(3 * D - 23 * H);
    expect(entryFor(r, 'lassi').end).toBe(2 * D);
    ex.boosts = { pet_boost: H };
    r = sim(ex);
    expect(entryFor(r, 'lassi').end).toBe(2 * D - 23 * H);
    expect(entryFor(r, 'archer').end).toBe(3 * D);
    expect(r.activeBoosts).toEqual(['Pet Potion 1h left']);
  });
});

describe('finish times', () => {
  const ref = Date.UTC(2026, 10, 16, 17, 0) / 1000;
  it('more than 6 days out shows the date, within 6 days the weekday', () => {
    const far = fmtClock(ref + 8 * D, ref);
    expect(far).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
    expect(far).toContain('Nov 24');
    expect(fmtClock(ref + 2 * D, ref)).toMatch(/^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/);
    expect(fmtClock(ref + 60, ref)).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
  });
});
