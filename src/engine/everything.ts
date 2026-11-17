// Everything tab (SPEC §11.4): every upgrade left at the current Town Hall, grouped by the tier the engine
// assigns, with totals. Built from one full scheduler run from "now" with the Town Hall frozen, so the
// time-to-max respects every builder, lock, tier and helper rule (not a plain sum).
import { levelInfo, maxLevelAt } from '../data/normalize';
import type { GameData, OreCost, Resource } from '../data/types';
import type { MetaFile } from '../meta/meta';
import { IDS, levelsOf } from '../state/levels';
import type { AccountState } from '../state/parseExport';
import type { Settings } from '../state/settings';
import { heroStatus } from './book';
import { GOLD_PASS_MAX_BOOST } from './constants';
import { equipmentCandidates } from './queues';
import { simulate, type SimResult, type TimelineEntry } from './scheduler';
import { detectMode, TIER_NAMES, type Mode } from './tiers';

export type Costs = Partial<Record<Resource, number>>;

export interface EverythingRow {
  itemKey: string;
  name: string;
  /** Level before the upgrade (0 = new building / merge). */
  fromLevel: number;
  toLevel: number;
  rawTimeSec: number;
  cost: number;
  resource: Resource;
  /** Seconds from now in the simulation (undefined for rows the scheduler never starts). */
  start?: number;
  end?: number;
  ore?: OreCost;
  note?: string;
}

/** All of one item's upgrades in a group, summed (what the UI lists). */
export interface EverythingItem {
  itemKey: string;
  name: string;
  count: number;
  fromLevel: number;
  toLevel: number;
  rawSec: number;
  costs: Costs;
  ore?: OreCost;
  note?: string;
}

export interface EverythingGroup {
  id: string;
  title: string;
  /** Tier number for builder tiers. */
  tier?: number;
  rows: EverythingRow[];
  /** Rows summed per item (by name), in the order the scheduler first starts them. */
  items: EverythingItem[];
  count: number;
  /** Σ raw data time, and the same with the Gold Pass builder/research boost. */
  rawSec: number;
  goldPassSec: number;
  costs: Costs;
  ore?: OreCost;
  /** When the last job of this group finishes in the simulation (seconds from now). */
  doneSec?: number;
}

export interface Everything {
  mode: Mode;
  townHall: number;
  /** Builder time-to-max from the scheduler at the current Gold Pass setting (incl. running jobs). */
  timeToMaxSec: number;
  /** The same with the other Gold Pass setting, for comparison. */
  timeToMaxOtherSec: number;
  goldPass: Settings['goldPass'];
  simulateHelpers: boolean;
  /** Every builder upgrade the scheduler starts, grouped by tier (Tier 0 first). */
  tiers: EverythingGroup[];
  lab: EverythingGroup;
  pets: EverythingGroup;
  blacksmith: EverythingGroup;
  walls: EverythingGroup;
  /** Upgrades the scheduler never starts: book-ready hero levels, weight-0 lab kinds, the next Town Hall. */
  notScheduled: EverythingGroup;
  labDoneSec: number;
  petsDoneSec: number;
  /** Builder tiers + lab + pets + walls (ore separate). "Not scheduled" is its own subtotal (notScheduled.costs). */
  totalCosts: Costs;
  totalOre: OreCost;
  /** Upgrades in the total (builder tiers, lab, pets, blacksmith, walls), not the "Not scheduled" ones. */
  totalCount: number;
}

const addCost = (c: Costs, r: Resource, n: number) => {
  if (n) c[r] = (c[r] ?? 0) + n;
};
const sumOre = (a: OreCost, b?: OreCost): OreCost => ({
  shinyOre: a.shinyOre + (b?.shinyOre ?? 0),
  glowyOre: a.glowyOre + (b?.glowyOre ?? 0),
  starryOre: a.starryOre + (b?.starryOre ?? 0),
});
const NO_ORE: OreCost = { shinyOre: 0, glowyOre: 0, starryOre: 0 };

function group(id: string, title: string, rows: EverythingRow[], boost: number, tier?: number): EverythingGroup {
  const costs: Costs = {};
  let rawSec = 0;
  let goldPassSec = 0;
  let ore: OreCost | undefined;
  let doneSec: number | undefined;
  for (const r of rows) {
    addCost(costs, r.resource, r.cost);
    rawSec += r.rawTimeSec;
    goldPassSec += Math.round(r.rawTimeSec * (1 - boost));
    if (r.ore) ore = sumOre(ore ?? NO_ORE, r.ore);
    if (r.end !== undefined) doneSec = Math.max(doneSec ?? 0, r.end);
  }
  const items = new Map<string, EverythingItem>();
  for (const r of rows) {
    const k = `${r.itemKey}|${r.name}|${r.note ?? ''}`;
    let it = items.get(k);
    if (!it) items.set(k, (it = { itemKey: r.itemKey, name: r.name, count: 0, fromLevel: r.fromLevel, toLevel: r.toLevel, rawSec: 0, costs: {}, note: r.note }));
    it.count++;
    it.fromLevel = Math.min(it.fromLevel, r.fromLevel);
    it.toLevel = Math.max(it.toLevel, r.toLevel);
    it.rawSec += r.rawTimeSec;
    addCost(it.costs, r.resource, r.cost);
    if (r.ore) it.ore = sumOre(it.ore ?? NO_ORE, r.ore);
  }
  return { id, title, tier, rows, items: [...items.values()], count: rows.length, rawSec, goldPassSec, costs, ore, doneSec };
}

function rowOf(e: TimelineEntry, data: GameData): EverythingRow {
  const item = data.items.get(e.itemKey);
  const raw = e.rawTimeSec ?? 0;
  const fromLevel = e.kind === 'build' || e.kind === 'merge' ? 0 : e.toLevel - 1;
  return { itemKey: e.itemKey, name: item?.name ?? e.itemName, fromLevel, toLevel: e.toLevel, rawTimeSec: raw, cost: e.cost, resource: e.resource, start: e.start, end: e.end };
}

const runEnd = (sim: SimResult, queue: 'builder' | 'lab' | 'petHouse') => {
  const ids = new Set(sim.slots.filter((s) => s.queue === queue).map((s) => s.id));
  return sim.timeline.filter((e) => ids.has(e.slotId)).reduce((m, e) => Math.max(m, e.end), 0);
};

export function buildEverything(data: GameData, account: AccountState, settings: Settings, meta: MetaFile, nowSec: number): Everything {
  const opts = { nowSec, horizonSec: Infinity, freezeTownHall: true };
  const sim = simulate(data, account, settings, meta, opts);
  const other = simulate(data, account, { ...settings, goldPass: settings.goldPass === 'max' ? 'none' : 'max' }, meta, opts);

  const lvNow = levelsOf(sim.nowState.instances);
  const mode = detectMode(lvNow.th, data);
  const names = TIER_NAMES[mode];
  const slotQueue = new Map(sim.slots.map((s) => [s.id, s.queue]));
  const fresh = sim.timeline.filter((e) => !e.inProgress);

  // Builder tiers, in tier order; rows in the order the scheduler starts them.
  const byTier = new Map<number, EverythingRow[]>();
  for (const e of fresh) {
    if (slotQueue.get(e.slotId) !== 'builder') continue;
    const t = e.tier ?? 99;
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t)!.push(rowOf(e, data));
  }
  const tiers = [...byTier.keys()]
    .sort((a, b) => a - b)
    .map((t) => group(`tier${t}`, `T${t} · ${names[t] ?? 'Other'}`, byTier.get(t)!, GOLD_PASS_MAX_BOOST.builder, t));

  const queueRows = (q: 'lab' | 'petHouse') => fresh.filter((e) => slotQueue.get(e.slotId) === q).map((e) => rowOf(e, data));
  const lab = group('lab', 'Laboratory', queueRows('lab'), GOLD_PASS_MAX_BOOST.research);
  const pets = group('pets', 'Pet House', queueRows('petHouse'), GOLD_PASS_MAX_BOOST.research);

  // What the run leaves behind, measured on its final state (after every Lab / Hero Hall / Blacksmith upgrade).
  const fin = sim.finalInstances;
  const lvEnd = levelsOf(fin);
  const leftover: EverythingRow[] = [];
  for (const inst of fin) {
    const item = data.items.get(inst.itemKey);
    if (!item) continue;
    if (item.category === 'hero') {
      // Book-ready levels up to the Hero Hall cap: the scheduler leaves them to you (SPEC §6.5).
      for (let lv = inst.level; ; lv++) {
        const st = heroStatus(item, lv, lvEnd.heroHall, data.bookThresholdSec);
        if (st.kind === 'maxed' || st.kind === 'cappedByHeroHall') break;
        leftover.push({ itemKey: item.key, name: item.name, fromLevel: lv, toLevel: st.next.level, rawTimeSec: st.next.timeSec, cost: st.next.cost, resource: st.next.resource, note: 'book-ready (your call)' });
      }
    } else if (item.queue === 'lab' || item.queue === 'petHouse') {
      const max = maxLevelAt(item, { th: lvEnd.th, lab: lvEnd.lab, petHouse: lvEnd.petHouse });
      for (let lv = inst.level + 1; lv <= max; lv++) {
        const l = levelInfo(item, lv);
        if (l) leftover.push({ itemKey: item.key, name: item.name, fromLevel: lv - 1, toLevel: lv, rawTimeSec: l.timeSec, cost: l.cost, resource: l.resource, note: 'not auto-picked (lab kind weight 0)' });
      }
    }
  }
  const thInst = fin.find((i) => i.dataId === IDS.townHall);
  const thItem = data.byDataId.get(IDS.townHall);
  const thNext = thItem && levelInfo(thItem, lvEnd.th + 1);
  if (mode === 'rush' && thInst && thItem && thNext)
    leftover.push({ itemKey: thItem.key, name: thItem.name, fromLevel: lvEnd.th, toLevel: thNext.level, rawTimeSec: thNext.timeSec, cost: thNext.cost, resource: thNext.resource, note: 'next Town Hall (opens new levels; not counted in time-to-max)' });
  const notScheduled = group('notScheduled', 'Not scheduled', leftover, GOLD_PASS_MAX_BOOST.builder);

  // Blacksmith: instant, ore only — every remaining level up to the max at the final Blacksmith level.
  const smithRows: EverythingRow[] = [];
  for (const c of equipmentCandidates(data, fin, settings, meta)) {
    const max = maxLevelAt(c.item, { th: lvEnd.th, blacksmith: lvEnd.blacksmith });
    for (let lv = c.instance.level + 1; lv <= max; lv++) {
      const l = levelInfo(c.item, lv);
      if (l) smithRows.push({ itemKey: c.item.key, name: c.item.name, fromLevel: lv - 1, toLevel: lv, rawTimeSec: 0, cost: l.cost, resource: l.resource, ore: l.ore });
    }
  }
  const blacksmith = group('blacksmith', 'Blacksmith (equipment)', smithRows, 0);
  // Equipment cost is ore; shown via `ore` only.
  blacksmith.costs = {};
  for (const it of blacksmith.items) it.costs = {};

  // Walls: instant; every wall level up to the max at this TH.
  const wallItem = data.byDataId.get(IDS.wall);
  const wallRows: EverythingRow[] = [];
  if (wallItem) {
    const max = maxLevelAt(wallItem, { th: lvEnd.th });
    for (const w of account.walls)
      for (let lv = w.level + 1; lv <= max; lv++) {
        const l = levelInfo(wallItem, lv);
        if (l) wallRows.push({ itemKey: wallItem.key, name: `${wallItem.name} ×${w.count}`, fromLevel: lv - 1, toLevel: lv, rawTimeSec: 0, cost: l.cost * w.count, resource: l.resource });
      }
  }
  const walls = group('walls', 'Walls', wallRows, 0);

  // "Total cost" = what's left at this TH as scheduled (builder tiers, lab, pets) + walls. The "Not scheduled"
  // group (book-ready hero levels, weight-0 lab kinds, the next Town Hall) has its own subtotal (SPEC §11, REVIEW-2 #10).
  const totalCosts: Costs = {};
  for (const g of [...tiers, lab, pets, walls]) for (const [r, n] of Object.entries(g.costs)) addCost(totalCosts, r as Resource, n ?? 0);
  return {
    mode,
    townHall: lvNow.th,
    timeToMaxSec: runEnd(sim, 'builder'),
    timeToMaxOtherSec: runEnd(other, 'builder'),
    goldPass: settings.goldPass,
    simulateHelpers: settings.simulateHelpers,
    tiers,
    lab,
    pets,
    blacksmith,
    walls,
    notScheduled,
    labDoneSec: runEnd(sim, 'lab'),
    petsDoneSec: runEnd(sim, 'petHouse'),
    totalCosts,
    totalOre: blacksmith.ore ?? NO_ORE,
    totalCount: [...tiers, lab, pets, blacksmith, walls].reduce((n, g) => n + g.count, 0),
  };
}
