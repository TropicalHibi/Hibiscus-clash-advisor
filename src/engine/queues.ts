// Lab, Pet House and Blacksmith ordering (SPEC §6.7–6.9).
import { levelInfo, maxLevelAt } from '../data/normalize';
import type { GameData, Item, OreCost, OwnedInstance, Resource } from '../data/types';
import { metaStats, type MetaFile, type ScoreKind } from '../meta/meta';
import type { LabKind, Settings } from '../state/settings';
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
  /** Meta score used for ranking (army share for troops/spells, usage otherwise). */
  score: number;
  scoreKind: ScoreKind;
  /** Legend I usage share (incl. super troops). */
  usage: number;
  threeStarRate?: number;
  /** Super troops whose usage / army share is credited to this base troop. */
  supers?: { name: string; usage: number; armyShare?: number }[];
  /** Lab only: troop / spell / siege. */
  labKind?: LabKind;
  /** Lab only: score ÷ the top score of its kind in the Legend I meta (0–1). */
  normScore?: number;
  /** Lab only: normScore × the kind weight from settings — what the lab queue picks by. */
  pickValue?: number;
  pinned: boolean;
  reason: string;
}

export const LAB_KINDS: LabKind[] = ['troop', 'spell', 'siege'];
const LAB_KIND_OF: Record<string, LabKind | undefined> = { troop: 'troop', spell: 'spell', siege: 'siege' };

/**
 * Top meta score per lab kind across every lab unit in the game data (not just the player's
 * candidates), so a kind's Legend I #1 = 1.0. Cached per meta file (the scheduler asks often).
 */
const topCache = new WeakMap<MetaFile, WeakMap<GameData, Record<LabKind, number>>>();
export function labKindTops(data: GameData, meta: MetaFile): Record<LabKind, number> {
  let byData = topCache.get(meta);
  const hit = byData?.get(data);
  if (hit) return hit;
  const tops: Record<LabKind, number> = { troop: 0, spell: 0, siege: 0 };
  for (const item of data.items.values()) {
    const kind = LAB_KIND_OF[item.category];
    if (!kind || item.queue !== 'lab' || item.key !== String(item.dataId)) continue;
    tops[kind] = Math.max(tops[kind], metaStats(meta, item.dataId).score);
  }
  if (!byData) topCache.set(meta, (byData = new WeakMap()));
  byData.set(data, tops);
  return tops;
}

/** Per-kind lists for the Lab tab, each ranked by its own score (pins first, unused at the bottom). */
export function labSections(lab: QueueCandidate[], pins: string[]): Record<LabKind, QueueCandidate[]> {
  const out: Record<LabKind, QueueCandidate[]> = { troop: [], spell: [], siege: [] };
  for (const c of lab) if (c.labKind) out[c.labKind].push(c);
  for (const k of LAB_KINDS) rank(out[k], pins, (c) => [c.rawTimeSec, c.cost]);
  return out;
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
    if (a.score !== b.score) return b.score - a.score;
    if (a.usage !== b.usage) return b.usage - a.usage;
    const ka = unusedKey(a);
    const kb = unusedKey(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.item.name < b.item.name ? -1 : a.item.name > b.item.name ? 1 : 0;
  });
}

function reasonFor(c: QueueCandidate, unusedText: string): string {
  if (c.pinned) return 'Pinned';
  if (c.usage > 0) {
    const p = (x: number) => `${(x * 100).toFixed(1)}%`;
    if (c.scoreKind === 'armyShare') {
      const sup = c.supers?.length ? `; incl. ${c.supers.map((x) => `${x.name} ${p(x.armyShare ?? 0)}`).join(', ')}` : '';
      const space = c.item.category === 'spell' ? 'spell' : 'troop';
      return `Legend I: ${p(c.score)} of ${space} space${sup} (in ${p(c.usage)} of attacks)`;
    }
    const sup = c.supers?.length ? ` (incl. ${c.supers.map((x) => `${x.name} ${p(x.usage)}`).join(', ')})` : '';
    return `Legend I usage ${p(c.usage)}${sup}`;
  }
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
    const ms = metaStats(meta, item.dataId);
    out.push({
      item,
      instance: inst,
      toLevel: next.level,
      rawTimeSec: next.timeSec,
      timeSec: Math.round(next.timeSec * (1 - boost)),
      cost: next.cost,
      resource: next.resource,
      score: ms.score,
      scoreKind: ms.scoreKind,
      usage: ms.usage,
      threeStarRate: ms.threeStarRate,
      supers: ms.supers,
      pinned: pins.includes(item.id),
      reason: '',
    });
  }
  let ranked: QueueCandidate[];
  if (queue === 'lab') {
    const tops = labKindTops(data, meta);
    const weights = settings.lab.kindWeights;
    for (const c of out) {
      const kind = LAB_KIND_OF[c.item.category] ?? 'troop';
      c.labKind = kind;
      c.normScore = tops[kind] > 0 ? Math.min(1, c.score / tops[kind]) : 0;
      c.pickValue = c.normScore * weights[kind];
    }
    // Lab queue pick (SPEC §6.7): pins first, then the weighted value across all three kinds.
    const pinIdx = (c: QueueCandidate) => (pins.includes(c.item.id) ? pins.indexOf(c.item.id) : Infinity);
    ranked = out.sort(
      (a, b) =>
        pinIdx(a) - pinIdx(b) ||
        b.pickValue! - a.pickValue! ||
        (b.usage > 0 ? 1 : 0) - (a.usage > 0 ? 1 : 0) ||
        b.normScore! - a.normScore! ||
        a.rawTimeSec - b.rawTimeSec ||
        a.cost - b.cost ||
        (a.item.name < b.item.name ? -1 : a.item.name > b.item.name ? 1 : 0),
    );
  } else ranked = rank(out, pins, (c) => [c.rawTimeSec, c.cost]);
  for (const c of ranked) {
    c.reason = reasonFor(c, `${meta.attacks ? 'Not seen in Legend I meta' : 'No meta data yet'}: shortest first (${fmtDuration(c.timeSec)})`);
    if (queue === 'lab' && !c.pinned && c.usage > 0)
      c.reason += ` · lab pick ${c.pickValue!.toFixed(2)} (${c.normScore!.toFixed(2)} of top ${c.labKind} × ${settings.lab.kindWeights[c.labKind!]})`;
  }
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
    const ms = metaStats(meta, item.dataId);
    out.push({
      item,
      instance: inst,
      toLevel: next.level,
      rawTimeSec: 0,
      timeSec: 0,
      cost: next.cost,
      resource: next.resource,
      ore: next.ore,
      score: ms.score,
      scoreKind: ms.scoreKind,
      usage: ms.usage,
      threeStarRate: ms.threeStarRate,
      supers: ms.supers,
      pinned: pins.includes(item.id),
      reason: '',
    });
  }
  // Unused fallback: cheapest first (rarest ore weighs most).
  const ranked = rank(out, pins, (c) => [c.ore?.starryOre ?? 0, c.ore?.glowyOre ?? 0, c.ore?.shinyOre ?? 0]);
  for (const c of ranked) c.reason = reasonFor(c, `${meta.attacks ? 'Not seen in Legend I meta' : 'No meta data yet'}: cheapest first`);
  return ranked;
}
