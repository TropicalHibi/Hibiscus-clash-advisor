// Mode detection, tier assignment and eligibility (SPEC §6, §7).
//
// builderCandidates() is built from small generators (heroes, Town Hall, planned buildings, merges,
// generic buildings, supercharges). Each generator emits a Draft with a semantic Group; place() turns a
// Group into its final tier + within-tier order exactly once.
import { countAt, levelInfo, maxLevelAt } from '../data/normalize';
import type { GameData, Item, LevelInfo, OwnedInstance, Resource } from '../data/types';
import { IDS, levelsOf, type Levels } from '../state/levels';
import type { Settings } from '../state/settings';
import { heroStatus } from './book';
import { fmtDuration } from './format';

export { levelsOf, type Levels };

export type Mode = 'rush' | 'maxTH';
export type CandidateKind = 'upgrade' | 'build' | 'merge' | 'supercharge' | 'weapon';

export interface Candidate {
  item: Item;
  instance: OwnedInstance;
  toLevel: number;
  tier: number;
  /** Within-tier sort key, compared lexicographically. */
  order: number[];
  rawTimeSec: number;
  timeSec: number; // boosted
  cost: number;
  resource: Resource;
  reason: string;
  kind: CandidateKind;
  /** Building instance that becomes busy (one upgrade per building at a time). */
  lockUid: string;
  /** Source instance uids consumed by a merge. */
  consumes?: string[];
}

export interface EngineState {
  instances: OwnedInstance[];
  /** Lock uids currently busy (in-progress jobs). */
  busy: Set<string>;
}

/**
 * Tier numbers per mode (SPEC §6.2–6.4). Tier 0 = Laboratory upgrade, then new buildings (incl. ready
 * merges), then the Archer Queen. `gate` = TH gate (merge source upgrades). Merged-defense upgrades past
 * level 1 sit in `defenses`. The TH weapon is part of the TH path in rush mode, a permanent defense at max TH.
 */
export const TIERS = {
  rush: { tier0: 0, thPath: 1, gate: 1, weapon: 1, offense: 2, heroes: 3, resources: 4, defenses: 5, temporary: 6 },
  maxTH: { tier0: 0, thPath: 5, gate: 3, weapon: 5, offense: 1, heroes: 2, resources: 4, defenses: 5, temporary: 6 },
} as const;
type TierMap = (typeof TIERS)[Mode];

export const TIER_NAMES: Record<Mode, string[]> = {
  rush: ['Laboratory + new buildings + Archer Queen', 'Town Hall path + TH gate', 'Offense', 'Heroes', 'Resources', 'Permanent defenses', 'Temporary'],
  maxTH: ['Laboratory + new buildings + Archer Queen', 'Offense', 'Heroes', 'TH gate (merge sources)', 'Resources', 'Permanent defenses', 'Temporary'],
};

/** Offense (non-hero) building order (SPEC §6.3 tier 2). The Laboratory is not here: it is Tier 0. */
export const OFFENSE_ORDER = [
  'army-camp',
  'barracks',
  'dark-barracks',
  'spell-factory',
  'dark-spell-factory',
  'clan-castle',
  'workshop',
  'blacksmith',
  'pet-house',
  'hero-hall',
];

const BUILDABLE = new Set(['defense', 'army', 'resourceStorage', 'resourceCollector', 'trap']);
const NOT_BUILDABLE_IDS = new Set(['builders-hut']);

export function detectMode(th: number, data: GameData): Mode {
  return th < data.maxTH ? 'rush' : 'maxTH';
}

export function lockOf(inst: OwnedInstance): string {
  return inst.parentUid ?? inst.uid;
}

export function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const n = Math.max(a.order.length, b.order.length);
  for (let i = 0; i < n; i++) {
    const x = a.order[i] ?? 0;
    const y = b.order[i] ?? 0;
    if (x !== y) return x - y;
  }
  if (a.item.name !== b.item.name) return a.item.name < b.item.name ? -1 : 1;
  return a.instance.uid < b.instance.uid ? -1 : a.instance.uid > b.instance.uid ? 1 : 0;
}

// ── Drafts: what a candidate is, before it gets a tier ──

/** Semantic group of a candidate. place() maps it to the final tier and order. */
type Group =
  | { g: 'lab' }
  | { g: 'newBuild' } // unbuilt building, missing merge source, or a performable merge
  | { g: 'queen' }
  | { g: 'th' }
  | { g: 'weapon' }
  | { g: 'gate'; neededTH: number; recipe: number; level: number }
  | { g: 'offense'; idx: number; level: number }
  | { g: 'hero'; idx: number }
  | { g: 'storage'; level: number }
  | { g: 'collector'; level: number }
  | { g: 'defense' }
  | { g: 'temporary' };

interface Draft {
  item: Item;
  instance: OwnedInstance;
  info: LevelInfo;
  group: Group;
  reason: string;
  kind: CandidateKind;
  lockUid: string;
  consumes?: string[];
}

interface Ctx {
  data: GameData;
  settings: Settings;
  instances: OwnedInstance[];
  busy: Set<string>;
  lv: Levels;
  mode: Mode;
  T: TierMap;
}

const draft = (item: Item, inst: OwnedInstance, info: LevelInfo, group: Group, reason: string, kind: CandidateKind, lockUid = lockOf(inst)): Draft => ({
  item,
  instance: inst,
  info,
  group,
  reason,
  kind,
  lockUid,
});

/** The tier a building belongs to outside Tier 0 (used to order new buildings inside Tier 0). */
function normalTier(item: Item, T: TierMap): number {
  switch (item.category) {
    case 'army':
      return T.offense;
    case 'resourceStorage':
    case 'resourceCollector':
      return T.resources;
    case 'defense':
    case 'trap':
    case 'mergedDefense':
      return T.defenses;
    default:
      return T.temporary;
  }
}

/** The single place where a draft gets its final tier, order and reason prefix. */
function place(d: Draft, T: TierMap, builderBoost: number): Candidate {
  const raw = d.info.timeSec;
  let tier: number;
  let order: number[];
  let reason = d.reason;
  const g = d.group;
  switch (g.g) {
    case 'lab':
      tier = T.tier0;
      order = [0];
      break;
    case 'newBuild':
      tier = T.tier0;
      order = [1, normalTier(d.item, T), -raw, d.info.cost];
      reason = `Tier 0: ${reason}`;
      break;
    case 'queen':
      tier = T.tier0;
      order = [2];
      break;
    case 'th':
      tier = T.thPath;
      order = [0, 0];
      break;
    case 'weapon':
      tier = T.weapon;
      order = [0, 1];
      break;
    case 'gate':
      tier = T.gate;
      order = [g.neededTH, g.recipe, 0, -g.level];
      break;
    case 'offense':
      tier = T.offense;
      order = [g.idx, g.level];
      break;
    case 'hero':
      tier = T.heroes;
      order = [g.idx];
      break;
    case 'storage':
      tier = T.resources;
      order = [0, g.level];
      break;
    case 'collector':
      tier = T.resources;
      order = [1, g.level];
      break;
    case 'defense':
      tier = T.defenses;
      order = [];
      break;
    case 'temporary':
      tier = T.temporary;
      order = [];
      break;
  }
  // Builder efficiency (§6.6): tiers 5–6 longest-processing-time first, cheaper on ties.
  if (tier === T.defenses || tier === T.temporary) order = [-raw, d.info.cost];
  return {
    item: d.item,
    instance: d.instance,
    toLevel: d.info.level,
    tier,
    order,
    rawTimeSec: raw,
    timeSec: Math.round(raw * (1 - builderBoost)),
    cost: d.info.cost,
    resource: d.info.resource,
    reason,
    kind: d.kind,
    lockUid: d.lockUid,
    consumes: d.consumes,
  };
}

// ── Generators ──

/** Heroes: the Queen is Tier 0 (after the Lab and new buildings); the rest follow the hero order. */
function heroDrafts(c: Ctx): Draft[] {
  const out: Draft[] = [];
  for (const inst of c.instances) {
    const item = c.data.items.get(inst.itemKey);
    if (!item || item.category !== 'hero' || c.busy.has(inst.uid)) continue;
    const st = heroStatus(item, inst.level, c.lv.heroHall, c.data.bookThresholdSec);
    if (st.kind !== 'eligible') continue;
    const isQueen = item.id === 'archer-queen';
    const idx = c.settings.heroOrder.indexOf(item.id);
    const cmp = `raw next level ${fmtDuration(st.next.timeSec)} < ${fmtDuration(c.data.bookThresholdSec)} threshold`;
    out.push(
      isQueen
        ? draft(item, inst, st.next, { g: 'queen' }, `Tier 0 (after the Laboratory and new buildings): Queen not book-ready (${cmp})`, 'upgrade')
        : draft(item, inst, st.next, { g: 'hero', idx: idx < 0 ? 99 : idx }, `Hero #${idx + 1} in order; not book-ready (${cmp})`, 'upgrade'),
    );
  }
  return out;
}

interface ThInfo {
  drafts: Draft[];
  thInst?: OwnedInstance;
  /** Rush mode: the next TH level (pushed only once the gate is clear). */
  thNext?: LevelInfo;
  /** The Town Hall itself is upgrading (not just its weapon) → TH-upgrade lookahead. */
  thUpgrading: boolean;
}

/** Town Hall weapon now; the TH upgrade itself waits for the gate (§6.3). */
function townHallDrafts(c: Ctx): ThInfo {
  const thInst = c.instances.find((i) => i.dataId === IDS.townHall);
  const thItem = c.data.byDataId.get(IDS.townHall);
  const info: ThInfo = { drafts: [], thInst, thUpgrading: !!thInst && thInst.upgradingTo !== undefined };
  if (!thInst || !thItem || c.busy.has(thInst.uid)) return info;
  info.thNext = c.mode === 'rush' ? levelInfo(thItem, c.lv.th + 1) : undefined;
  const weapon = c.data.items.get(`${IDS.townHall}:w${c.lv.th}`);
  const wl = thInst.weaponLevel ?? 1;
  const wn = weapon && levelInfo(weapon, wl + 1);
  if (weapon && wn) {
    const reason = c.mode === 'rush' ? 'TH weapon (only when the TH itself cannot be upgraded or is gated)' : 'TH weapon (permanent defense, longest first)';
    info.drafts.push(draft(weapon, { ...thInst, level: wl }, wn, { g: 'weapon' }, reason, 'weapon', thInst.uid));
  }
  return info;
}

/** Recipe source dataIds (items whose countAfterMerges is explained by merges.yaml). */
function recipeSources(data: GameData): Set<number> {
  return new Set(data.merges.flatMap((m) => m.sources.map((s) => s.dataId)));
}

/** Buildings allowed at the TH but not owned: allowed − consumed by existing merges − owned. */
function plannedBuildings(c: Ctx): OwnedInstance[] {
  const consumedBy = new Map<number, number>();
  for (const r of c.data.merges) {
    const mergedOwned = c.instances.filter((i) => i.dataId === r.dataId).length;
    for (const s of r.sources) consumedBy.set(s.dataId, (consumedBy.get(s.dataId) ?? 0) + s.qty * mergedOwned);
  }
  const known = recipeSources(c.data);
  const planned: OwnedInstance[] = [];
  for (const item of c.data.byDataId.values()) {
    if (!BUILDABLE.has(item.category) || NOT_BUILDABLE_IDS.has(item.id) || !item.countPerTH) continue;
    // A merge source that merges.yaml doesn't know: its raw count would suggest copies the player
    // can't build (they were merged away). Never plan copies of it (§7, Plan-tab warning instead).
    if (item.countAfterMergesPerTH && !known.has(item.dataId)) continue;
    const allowed = countAt(item.countPerTH, c.lv.th) ?? 0;
    const owned = c.instances.filter((i) => i.dataId === item.dataId).length;
    const missing = allowed - (consumedBy.get(item.dataId) ?? 0) - owned;
    for (let n = 1; n <= missing; n++) planned.push({ uid: `${item.key}#new${n}`, dataId: item.dataId, itemKey: item.key, level: 0, planned: true });
  }
  return planned;
}

interface MergePlan {
  drafts: Draft[];
  /** Instances fully handled here (merged defenses, allocated sources). */
  handled: Set<string>;
  /** Unfinished TH-gate merges at the current TH. */
  gateOpen: string[];
}

/** Merge chains (§7): sources → merge (Tier 0) → merged-defense upgrades (tier 5). */
function mergePlan(c: Ctx, all: OwnedInstance[], thUpgrading: boolean): MergePlan {
  const { data, lv, busy } = c;
  const drafts: Draft[] = [];
  const handled = new Set<string>();
  const gateOpen: string[] = [];
  const mergeScopeTH = c.mode === 'rush' && thUpgrading ? lv.th + 1 : lv.th; // TH-upgrading lookahead (TH+1 only)

  const pools = new Map<number, OwnedInstance[]>();
  for (const r of data.merges)
    for (const s of r.sources)
      if (!pools.has(s.dataId)) pools.set(s.dataId, all.filter((i) => i.dataId === s.dataId).sort((a, b) => b.level - a.level || (a.uid < b.uid ? -1 : 1)));
  const allocated = new Set<string>();

  const jobs: { ri: number; neededTH: number }[] = [];
  data.merges.forEach((r, ri) => {
    const merged = data.byDataId.get(r.dataId)!;
    const owned = c.instances.filter((i) => i.dataId === r.dataId);
    const maxLv = maxLevelAt(merged, { th: lv.th });
    for (const inst of owned) {
      handled.add(inst.uid);
      if (busy.has(inst.uid) || inst.level >= maxLv) continue;
      const next = levelInfo(merged, inst.level + 1);
      if (next) drafts.push(draft(merged, inst, next, { g: 'defense' }, 'Merged defense upgrade (permanent defense, longest first)', 'upgrade'));
    }
    const ths = Object.keys(merged.countPerTH ?? {})
      .map(Number)
      .sort((a, b) => a - b);
    for (let k = owned.length; ; k++) {
      const t = ths.find((th) => (merged.countPerTH![th] ?? 0) > k);
      if (t === undefined || t > mergeScopeTH) break;
      jobs.push({ ri, neededTH: t });
    }
  });
  jobs.sort((a, b) => a.neededTH - b.neededTH || a.ri - b.ri);

  let mergeSeq = 0;
  for (const job of jobs) {
    const r = data.merges[job.ri];
    const merged = data.byDataId.get(r.dataId)!;
    const lookahead = job.neededTH > lv.th;
    const alloc: OwnedInstance[] = [];
    let complete = true;
    for (const s of r.sources) {
      const picked = (pools.get(s.dataId) ?? []).filter((i) => !allocated.has(i.uid)).slice(0, s.qty);
      if (picked.length < s.qty) complete = false;
      for (const p of picked) {
        allocated.add(p.uid);
        handled.add(p.uid);
        alloc.push(p);
      }
    }
    // A merge holds the TH gate only if it can actually be performed at this TH: enough source
    // instances exist AND every one of them can reach the required level at the current TH (§6.3, §7).
    const reachable = alloc.every((src) => maxLevelAt(data.items.get(src.itemKey)!, { th: lv.th }) >= r.requiredSourceLevel[data.items.get(src.itemKey)!.id]);
    if (!lookahead && complete && reachable && r.unlockTH <= lv.th) gateOpen.push(merged.name);

    let ready = complete;
    for (const src of alloc) {
      const srcItem = data.items.get(src.itemKey)!;
      const req = r.requiredSourceLevel[srcItem.id];
      if (src.level < req || src.planned) ready = false;
      if (busy.has(src.uid)) {
        ready = false;
        continue;
      }
      if (src.level >= req) continue;
      const next = levelInfo(srcItem, src.level + 1);
      if (!next || (next.thRequired ?? 0) > lv.th) continue;
      const why = `${lookahead ? 'TH-upgrade lookahead: ' : 'TH gate: '}merge for ${merged.name} (TH${job.neededTH}) needs ${srcItem.name} ${req}`;
      drafts.push(
        src.planned
          ? draft(srcItem, src, next, { g: 'newBuild' }, why, 'build')
          : draft(srcItem, src, next, { g: 'gate', neededTH: job.neededTH, recipe: job.ri, level: src.level }, why, 'upgrade'),
      );
    }
    const first = merged.levels[0];
    if (ready && !lookahead && first && r.unlockTH <= lv.th && (first.thRequired ?? 0) <= lv.th) {
      const virt: OwnedInstance = { uid: `${merged.key}#merge${++mergeSeq}`, dataId: merged.dataId, itemKey: merged.key, level: 0, planned: true };
      const reason = `Merge ${r.sources.map((s) => `${s.qty}× ${data.byDataId.get(s.dataId)!.name}`).join(' + ')} → ${merged.name} (TH${job.neededTH})`;
      drafts.push({ ...draft(merged, virt, first, { g: 'newBuild' }, reason, 'merge', virt.uid), consumes: alloc.map((a) => a.uid) });
    }
  }
  return { drafts, handled, gateOpen };
}

/** Every other builder item: Laboratory (Tier 0), offense, resources, defenses, temporary; new copies. */
function genericDrafts(c: Ctx, all: OwnedInstance[], handled: Set<string>): Draft[] {
  const out: Draft[] = [];
  for (const inst of all) {
    if (handled.has(inst.uid)) continue;
    const item = c.data.items.get(inst.itemKey);
    if (!item || item.queue !== 'builder') continue;
    let group: Group;
    let reason: string;
    switch (item.category) {
      case 'army':
        if (item.id === 'laboratory') {
          group = { g: 'lab' };
          reason = 'Tier 0: Laboratory upgrade first (research speed and new lab levels)';
        } else {
          const idx = OFFENSE_ORDER.indexOf(item.id);
          group = { g: 'offense', idx: idx < 0 ? 99 : idx, level: inst.level };
          reason = 'Offense building (non-hero)';
        }
        break;
      case 'resourceStorage':
        group = { g: 'storage', level: inst.level };
        reason = 'Storage (storages before collectors, lowest level first)';
        break;
      case 'resourceCollector':
        group = { g: 'collector', level: inst.level };
        reason = 'Collector (lowest level first)';
        break;
      case 'defense':
      case 'trap':
      case 'mergedDefense':
        group = { g: 'defense' };
        reason = 'Permanent defense, longest first (LPT)';
        break;
      case 'guardian':
      case 'craftedDefense':
        group = { g: 'temporary' };
        reason = item.category === 'guardian' ? 'Guardian (temporary tier), longest first' : 'Crafted defense module (temporary tier), longest first';
        break;
      default:
        continue;
    }
    if (c.busy.has(lockOf(inst))) continue;
    if (inst.planned) {
      const first = item.levels[0];
      if (first && (first.thRequired ?? 0) <= c.lv.th) out.push(draft(item, inst, first, { g: 'newBuild' }, `New building available: ${reason}`, 'build'));
      continue;
    }
    if (inst.level >= maxLevelAt(item, { th: c.lv.th })) continue;
    const next = levelInfo(item, inst.level + 1);
    if (next) out.push(draft(item, inst, next, group, reason, 'upgrade'));
  }
  return out;
}

/** Supercharges (temporary tier): the base building must be at its max level for the current TH. */
function superchargeDrafts(c: Ctx): Draft[] {
  const out: Draft[] = [];
  for (const inst of c.instances) {
    const sc = c.data.items.get(`${inst.itemKey}:sc`);
    if (!sc) continue;
    const base = c.data.items.get(inst.itemKey)!;
    const baseMax = maxLevelAt(base, { th: c.lv.th });
    if (!baseMax || inst.level < baseMax || c.busy.has(inst.uid)) continue;
    const next = levelInfo(sc, (inst.superchargeLevel ?? 0) + 1);
    if (!next || (next.thRequired ?? 0) > c.lv.th) continue;
    out.push(draft(sc, inst, next, { g: 'temporary' }, 'Supercharge (temporary tier), longest first', 'supercharge', inst.uid));
  }
  return out;
}

interface GenOpts {
  /** Builder time reduction (0–1). */
  builderBoost: number;
  /** Never offer the Town Hall upgrade (Everything tab: what's left at the current TH). */
  noTownHall?: boolean;
}

/**
 * All currently-eligible builder candidates, sorted by priority (best first).
 * Pure function of the state: the scheduler calls it again whenever a builder frees up.
 */
export function builderCandidates(data: GameData, state: EngineState, settings: Settings, opts: GenOpts): Candidate[] {
  const lv = levelsOf(state.instances);
  const mode = detectMode(lv.th, data);
  const c: Ctx = { data, settings, instances: state.instances, busy: state.busy, lv, mode, T: TIERS[mode] };

  const th = townHallDrafts(c);
  const planned = plannedBuildings(c);
  const all = [...state.instances, ...planned];
  const merges = mergePlan(c, all, th.thUpgrading);
  const handled = new Set(merges.handled);
  if (th.thInst) handled.add(th.thInst.uid);

  const drafts: Draft[] = [...heroDrafts(c), ...th.drafts, ...merges.drafts, ...genericDrafts(c, all, handled), ...superchargeDrafts(c)];

  // Rush: the TH upgrade only once the TH gate is clear — every performable merge done, every new building built.
  if (th.thInst && th.thNext && !opts.noTownHall) {
    const gateOpen = [...merges.gateOpen];
    for (const p of planned) if ((data.items.get(p.itemKey)!.levels[0]?.thRequired ?? 0) <= lv.th) gateOpen.push(p.itemKey);
    if (!gateOpen.length) {
      drafts.push(draft(data.byDataId.get(IDS.townHall)!, th.thInst, th.thNext, { g: 'th' }, 'Rush: Town Hall upgrade, TH gate clear (all merges done, all new buildings built)', 'upgrade'));
    }
  }

  return drafts.map((d) => place(d, c.T, opts.builderBoost)).sort(compareCandidates);
}
