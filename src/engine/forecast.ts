// 24h needs + wall dump line (SPEC §10.3, §10.4).
import { levelInfo, maxLevelAt } from '../data/normalize';
import type { GameData, OreCost, Resource } from '../data/types';
import type { AccountState } from '../state/parseExport';
import { fmtNum } from './format';
import type { QueueCandidate } from './queues';
import type { TimelineEntry } from './scheduler';

export interface NeededEntry {
  at: number; // seconds from now
  cost: number;
  cumulative: number;
  label: string;
  slotId: string;
}

export interface Forecast {
  windowSec: number;
  totals: Partial<Record<Resource, number>>;
  /** Per resource: upgrades in start order with running totals ("needed by"). */
  neededBy: Partial<Record<Resource, NeededEntry[]>>;
  ore: OreCost;
  oreItems: QueueCandidate[];
}

export function forecast(timeline: TimelineEntry[], windowSec: number, equipment: QueueCandidate[], topN: number): Forecast {
  const totals: Partial<Record<Resource, number>> = {};
  const neededBy: Partial<Record<Resource, NeededEntry[]>> = {};
  const starts = timeline.filter((e) => !e.inProgress && e.start < windowSec && e.cost > 0).sort((a, b) => a.start - b.start);
  for (const e of starts) {
    totals[e.resource] = (totals[e.resource] ?? 0) + e.cost;
    (neededBy[e.resource] ??= []).push({
      at: e.start,
      cost: e.cost,
      cumulative: totals[e.resource]!,
      label: `${e.itemName} ${e.toLevel}`,
      slotId: e.slotId,
    });
  }
  const oreItems = equipment.slice(0, Math.max(0, topN));
  const ore: OreCost = { shinyOre: 0, glowyOre: 0, starryOre: 0 };
  for (const c of oreItems) {
    ore.shinyOre += c.ore?.shinyOre ?? 0;
    ore.glowyOre += c.ore?.glowyOre ?? 0;
    ore.starryOre += c.ore?.starryOre ?? 0;
  }
  return { windowSec, totals, neededBy, ore, oreItems };
}

export interface WallDump {
  fromLevel: number;
  toLevel: number;
  cost: number;
  resource: Resource;
  countAtLevel: number;
  text: string;
}

/** Lowest owned wall level whose next level is available at the player's TH. */
export function wallDump(data: GameData, account: AccountState): WallDump | null {
  const wall = data.byId.get('wall');
  if (!wall) return null;
  const max = maxLevelAt(wall, { th: account.townHall });
  for (const w of account.walls) {
    if (w.level >= max) continue;
    const next = levelInfo(wall, w.level + 1);
    if (!next) continue;
    const res = next.resource === 'goldOrElixir' ? 'gold or elixir' : next.resource;
    return {
      fromLevel: w.level,
      toLevel: next.level,
      cost: next.cost,
      resource: next.resource,
      countAtLevel: w.count,
      text: `Overflow → walls: Lv ${w.level}→${next.level} costs ${fmtNum(next.cost)} ${res} each; ${w.count} walls at Lv ${w.level}.`,
    };
  }
  return null;
}
