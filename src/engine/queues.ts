// Lab, Pet House and Blacksmith ordering (SPEC §6.7–6.9).
import { levelInfo, maxLevelAt } from '../data/normalize';
import type { GameData, Item, OreCost, OwnedInstance, Resource } from '../data/types';
import { metaScore, type MetaFile } from '../meta/meta';
import type { Settings } from '../state/settings';
import { fmtDuration } from './format';
import { levelsOf, type EngineState } from './tiers';

export interface QueueCandidate {
  item: Item;
  instance: OwnedInstance;
  toLevel: number;
  rawTimeSec: number;
  timeSec: number;
  cost: number;
  resource: Resource;
  ore?: OreCost;
  usage: number;
  threeStarRate?: number;
  pinned: boolean;
  reason: string;
}

function rank(list: QueueCandidate[], pins: string[], unusedKey: (c: QueueCandidate) => number[]): QueueCandidate[] {
  const pinIdx = (c: QueueCandidate) => {
    const i = pins.indexOf(c.item.id);
    return i < 0 ? Infinity : i;
  };
  return list.sort((a, b) => {
    const pa = pinIdx(a);
    const pb = pinIdx(b);
    if (pa !== pb) return pa - pb;
    const ua = a.usage > 0 ? 1 : 0;
    const ub = b.usage > 0 ? 1 : 0;
    if (ua !== ub) return ub - ua;
    if (a.usage !== b.usage) return b.usage - a.usage;
    const ka = unusedKey(a);
    const kb = unusedKey(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.item.name < b.item.name ? -1 : a.item.name > b.item.name ? 1 : 0;
  });
}

function reasonFor(c: QueueCandidate, unusedText: string): string {
  if (c.pinned) return 'Pinned';
  if (c.usage > 0) return `Legend I usage ${(c.usage * 100).toFixed(1)}%`;
  return unusedText;
}

/** Ranked research candidates for the lab or pet house. */
export function researchCandidates(
  data: GameData,
  state: EngineState,
  queue: 'lab' | 'petHouse',
  settings: Settings,
  meta: MetaFile,
  boost: number,
): QueueCandidate[] {
  const lv = levelsOf(state.instances);
  const pins = queue === 'lab' ? settings.lab.pinned : settings.petHouse.pinned;
  const out: QueueCandidate[] = [];
  for (const inst of state.instances) {
    const item = data.items.get(inst.itemKey);
    if (!item || item.queue !== queue || state.busy.has(inst.uid)) continue;
    const max = maxLevelAt(item, { th: lv.th, lab: lv.lab, petHouse: lv.petHouse });
    if (inst.level >= max) continue;
    const next = levelInfo(item, inst.level + 1);
    if (!next) continue;
    const u = meta.units[String(item.dataId)];
    out.push({
      item,
      instance: inst,
      toLevel: next.level,
      rawTimeSec: next.timeSec,
      timeSec: Math.round(next.timeSec * (1 - boost)),
      cost: next.cost,
      resource: next.resource,
      usage: metaScore(meta, item.dataId),
      threeStarRate: u?.threeStarRate,
      pinned: pins.includes(item.id),
      reason: '',
    });
  }
  const ranked = rank(out, pins, (c) => [c.rawTimeSec, c.cost]);
  for (const c of ranked) c.reason = reasonFor(c, `Not seen in Legend I meta: shortest first (${fmtDuration(c.timeSec)})`);
  return ranked;
}

/** Ranked equipment upgrades (instant, ore-limited). */
export function equipmentCandidates(data: GameData, instances: OwnedInstance[], settings: Settings, meta: MetaFile): QueueCandidate[] {
  const lv = levelsOf(instances);
  const pins = settings.blacksmith.pinned;
  const out: QueueCandidate[] = [];
  for (const inst of instances) {
    const item = data.items.get(inst.itemKey);
    if (!item || item.queue !== 'blacksmith') continue;
    const max = maxLevelAt(item, { th: lv.th, blacksmith: lv.blacksmith });
    if (inst.level >= max) continue;
    const next = levelInfo(item, inst.level + 1);
    if (!next) continue;
    const u = meta.units[String(item.dataId)];
    out.push({
      item,
      instance: inst,
      toLevel: next.level,
      rawTimeSec: 0,
      timeSec: 0,
      cost: next.cost,
      resource: next.resource,
      ore: next.ore,
      usage: metaScore(meta, item.dataId),
      threeStarRate: u?.threeStarRate,
      pinned: pins.includes(item.id),
      reason: '',
    });
  }
  // Unused fallback: cheapest first (rarest ore weighs most).
  const ranked = rank(out, pins, (c) => [c.ore?.starryOre ?? 0, c.ore?.glowyOre ?? 0, c.ore?.shinyOre ?? 0]);
  for (const c of ranked) c.reason = reasonFor(c, 'Not seen in Legend I meta: cheapest first');
  return ranked;
}
