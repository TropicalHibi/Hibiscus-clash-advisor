// 24h needs + wall dump line (SPEC §10.3, §10.4).
// Ore is never forecast: it's time-gated (daily attacks, wars, raids, events), so a "needed in 24 h" total
// would be meaningless. Equipment ore costs are shown on the Lab / Pets / Equipment tab instead (§6.9).
import { levelInfo, maxLevelAt } from '../data/normalize';
import type { GameData, Resource } from '../data/types';
import type { AccountState } from '../state/parseExport';
import { fmtNum } from './format';
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
}

/** Gold / elixir / dark elixir for every builder, lab and pet upgrade that starts in the window. */
export function forecast(timeline: TimelineEntry[], windowSec: number): Forecast {
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
  return { windowSec, totals, neededBy };
}

export interface WallDump {
  fromLevel: number;
  toLevel: number;
  cost: number;
  resource: Resource;
  countAtLevel: number;
  text: string;
}

/**
 * Lowest owned wall level whose next level is available at the player's TH. `th` = the Town Hall at "now"
 * (SPEC §10.4: a TH upgrade that finished since the export counts); defaults to the export's.
 */
export function wallDump(data: GameData, account: Pick<AccountState, 'townHall' | 'walls'>, th = account.townHall): WallDump | null {
  const wall = data.byId.get('wall');
  if (!wall) return null;
  const max = maxLevelAt(wall, { th });
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
