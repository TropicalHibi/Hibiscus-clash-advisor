// Mode detection, tier assignment and eligibility (SPEC §6, §7).
import { countAt, levelInfo, maxLevelAt } from '../data/normalize';
import type { GameData, Item, LevelInfo, OwnedInstance, Resource } from '../data/types';
import { IDS } from '../state/parseExport';
import type { Settings } from '../state/settings';
import { heroStatus } from './book';
import { fmtDuration } from './format';

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

export interface Levels {
  th: number;
  heroHall: number;
  lab: number;
  petHouse: number;
  blacksmith: number;
}

/**
 * Tier numbers per mode (SPEC §6.2–6.4). Tier 0 = new buildings (incl. ready merges), then the Queen.
 * `gate` = TH gate: merge source upgrades so every available merge can be performed.
 * Merged-defense upgrades past level 1 sit in `defenses`.
 */
export const TIERS = {
  rush: { newBuild: 0, queen: 0, thPath: 1, gate: 1, offense: 2, heroes: 3, resources: 4, defenses: 5, temporary: 6, weapon: 1 },
  maxTH: { newBuild: 0, queen: 0, thPath: 5, gate: 3, offense: 1, heroes: 2, resources: 4, defenses: 5, temporary: 6, weapon: 5 },
} as const;

export const TIER_NAMES: Record<Mode, string[]> = {
  rush: ['New buildings + Archer Queen', 'Town Hall path + TH gate', 'Offense', 'Heroes', 'Resources', 'Permanent defenses', 'Temporary'],
  maxTH: ['New buildings + Archer Queen', 'Offense', 'Heroes', 'TH gate (merge sources)', 'Resources', 'Permanent defenses', 'Temporary'],
};

/** Order of Tier 0: new buildings (sub-group 0) before the Queen (sub-group 1). */
const T0_BUILD = 0;
const T0_QUEEN = 1;

/** Offense (non-hero) building order (SPEC §6.3 tier 2). */
export const OFFENSE_ORDER = [
  'laboratory',
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
  'hero-banner',
];

const BUILDABLE = new Set(['defense', 'army', 'resourceStorage', 'resourceCollector', 'trap']);
const NOT_BUILDABLE_IDS = new Set(['builders-hut']);

export function detectMode(th: number, data: GameData): Mode {
  return th < data.maxTH ? 'rush' : 'maxTH';
}

export function levelsOf(instances: OwnedInstance[]): Levels {
  const lv: Levels = { th: 0, heroHall: 0, lab: 0, petHouse: 0, blacksmith: 0 };
  for (const i of instances) {
    if (i.dataId === IDS.townHall) lv.th = Math.max(lv.th, i.level);
    else if (i.dataId === IDS.heroHall) lv.heroHall = Math.max(lv.heroHall, i.level);
    else if (i.dataId === IDS.laboratory) lv.lab = Math.max(lv.lab, i.level);
    else if (i.dataId === IDS.petHouse) lv.petHouse = Math.max(lv.petHouse, i.level);
    else if (i.dataId === IDS.blacksmith) lv.blacksmith = Math.max(lv.blacksmith, i.level);
  }
  return lv;
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

interface GenOpts {
  /** Builder time reduction (0–1). */
  builderBoost: number;
}

/**
 * All currently-eligible builder candidates, sorted by priority (best first).
 * Pure function of the state: the scheduler calls it again whenever a builder frees up.
 */
export function builderCandidates(data: GameData, state: EngineState, settings: Settings, opts: GenOpts): Candidate[] {
  const { instances, busy } = state;
  const lv = levelsOf(instances);
  const mode = detectMode(lv.th, data);
  const T = TIERS[mode];
  const out: Candidate[] = [];
  const handled = new Set<string>();

  const push = (c: Omit<Candidate, 'timeSec'>) => {
    out.push({ ...c, timeSec: Math.round(c.rawTimeSec * (1 - opts.builderBoost)) });
  };
  const fromLevel = (item: Item, inst: OwnedInstance, info: LevelInfo, tier: number, order: number[], reason: string, kind: CandidateKind, lockUid = lockOf(inst)) =>
    push({ item, instance: inst, toLevel: info.level, tier, order, rawTimeSec: info.timeSec, cost: info.cost, resource: info.resource, reason, kind, lockUid });

  const thInst = instances.find((i) => i.dataId === IDS.townHall);
  const thItem = data.byDataId.get(IDS.townHall);
  const thBusy = !!thInst && busy.has(thInst.uid);

  // ── Heroes (tier 0 Queen + hero tier) ──
  for (const inst of instances) {
    const item = data.items.get(inst.itemKey);
    if (!item || item.category !== 'hero' || busy.has(inst.uid)) continue;
    const st = heroStatus(item, inst.level, lv.heroHall, data.bookThresholdSec);
    if (st.kind !== 'eligible') continue;
    const isQueen = item.id === 'archer-queen';
    const idx = settings.heroOrder.indexOf(item.id);
    const tier = isQueen ? T.queen : T.heroes;
    const reason = isQueen
      ? `Tier 0 (after new buildings): Queen not book-ready (raw next level ${fmtDuration(st.next.timeSec)} < ${fmtDuration(data.bookThresholdSec)} threshold)`
      : `Hero #${idx + 1} in order; not book-ready (raw next level ${fmtDuration(st.next.timeSec)} < ${fmtDuration(data.bookThresholdSec)} threshold)`;
    fromLevel(item, inst, st.next, tier, isQueen ? [T0_QUEEN] : [idx < 0 ? 99 : idx], reason, 'upgrade');
  }

  // ── Town Hall + weapon ──
  let thNext: LevelInfo | undefined;
  if (thInst && thItem && !thBusy) {
    handled.add(thInst.uid);
    // The TH upgrade itself is pushed after the merge section: it waits for the TH gate (§6.3).
    thNext = mode === 'rush' ? levelInfo(thItem, lv.th + 1) : undefined;
    const weapon = data.items.get(`${IDS.townHall}:w${lv.th}`);
    if (weapon) {
      const wl = thInst.weaponLevel ?? 1;
      const wn = levelInfo(weapon, wl + 1);
      if (wn)
        fromLevel(
          weapon,
          { ...thInst, level: wl },
          wn,
          T.weapon,
          [0, 1],
          mode === 'rush' ? 'TH weapon (only when the TH itself cannot be upgraded or is gated)' : 'TH weapon',
          'weapon',
          thInst.uid,
        );
    }
  } else if (thInst) handled.add(thInst.uid);

  // ── Planned new buildings (count allowed at TH − merge consumption − owned) ──
  const consumedBy = new Map<number, number>(); // source dataId → instances consumed by existing merges
  for (const r of data.merges) {
    const mergedOwned = instances.filter((i) => i.dataId === r.dataId).length;
    for (const s of r.sources) consumedBy.set(s.dataId, (consumedBy.get(s.dataId) ?? 0) + s.qty * mergedOwned);
  }
  const planned: OwnedInstance[] = [];
  for (const item of data.byDataId.values()) {
    if (!BUILDABLE.has(item.category) || NOT_BUILDABLE_IDS.has(item.id) || !item.countPerTH) continue;
    const allowed = countAt(item.countPerTH, lv.th) ?? 0;
    const owned = instances.filter((i) => i.dataId === item.dataId).length;
    const missing = allowed - (consumedBy.get(item.dataId) ?? 0) - owned;
    for (let n = 1; n <= missing; n++) planned.push({ uid: `${item.key}#new${n}`, dataId: item.dataId, itemKey: item.key, level: 0, planned: true });
  }
  const all = [...instances, ...planned];

  // ── Merges (§7) ──
  const mergeScopeTH = mode === 'rush' && thBusy ? lv.th + 1 : lv.th; // TH-upgrading lookahead
  const pools = new Map<number, OwnedInstance[]>();
  for (const r of data.merges)
    for (const s of r.sources)
      if (!pools.has(s.dataId))
        pools.set(
          s.dataId,
          all.filter((i) => i.dataId === s.dataId).sort((a, b) => b.level - a.level || (a.uid < b.uid ? -1 : 1)),
        );
  const allocated = new Set<string>();

  type Job = { ri: number; neededTH: number };
  const jobs: Job[] = [];
  data.merges.forEach((r, ri) => {
    const merged = data.byDataId.get(r.dataId)!;
    const owned = instances.filter((i) => i.dataId === r.dataId);
    // Merged-defense upgrades past level 1 are not part of the TH gate: permanent-defense tier (LPT).
    const maxLv = maxLevelAt(merged, { th: lv.th });
    for (const inst of owned) {
      handled.add(inst.uid);
      if (busy.has(inst.uid) || inst.level >= maxLv) continue;
      const next = levelInfo(merged, inst.level + 1);
      if (next) fromLevel(merged, inst, next, T.defenses, [], 'Merged defense upgrade (permanent defense, longest first)', 'upgrade');
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
  const gateOpen: string[] = []; // unfinished TH-gate items at the current TH
  for (const job of jobs) {
    const r = data.merges[job.ri];
    const merged = data.byDataId.get(r.dataId)!;
    const tier = T.gate;
    const lookahead = job.neededTH > lv.th;
    const alloc: OwnedInstance[] = [];
    let complete = true;
    for (const s of r.sources) {
      const pool = pools.get(s.dataId) ?? [];
      const picked = pool.filter((i) => !allocated.has(i.uid)).slice(0, s.qty);
      if (picked.length < s.qty) complete = false;
      for (const p of picked) {
        allocated.add(p.uid);
        handled.add(p.uid);
        alloc.push(p);
      }
    }
    // A merge counts against the gate only if it can actually be performed (enough sources exist).
    if (!lookahead && complete && (merged.levels[0].thRequired ?? 0) <= lv.th) gateOpen.push(merged.name);
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
      fromLevel(srcItem, src, next, tier, [job.neededTH, job.ri, 0, -src.level], why, src.planned ? 'build' : 'upgrade');
    }
    const first = levelInfo(merged, merged.levels[0].level);
    if (ready && !lookahead && first && (first.thRequired ?? 0) <= lv.th) {
      const virt: OwnedInstance = { uid: `${merged.key}#merge${++mergeSeq}`, dataId: merged.dataId, itemKey: merged.key, level: 0, planned: true };
      push({
        item: merged,
        instance: virt,
        toLevel: first.level,
        tier,
        order: [job.neededTH, job.ri, 1],
        rawTimeSec: first.timeSec,
        cost: first.cost,
        resource: first.resource,
        reason: `Merge ${r.sources.map((s) => `${s.qty}× ${data.byDataId.get(s.dataId)!.name}`).join(' + ')} → ${merged.name} (TH${job.neededTH})`,
        kind: 'merge',
        lockUid: virt.uid,
        consumes: alloc.map((a) => a.uid),
      });
    }
  }

  // ── Town Hall (rush): only once the TH gate is clear — every available merge performed, every new building built ──
  if (thInst && thItem && thNext) {
    for (const p of planned) {
      const it = data.items.get(p.itemKey)!;
      if ((it.levels[0]?.thRequired ?? 0) <= lv.th) gateOpen.push(it.name);
    }
    if (!gateOpen.length) fromLevel(thItem, thInst, thNext, T.thPath, [0, 0], 'Rush: Town Hall upgrade, TH gate clear (all merges done, all new buildings built)', 'upgrade');
  }

  // ── Everything else ──
  for (const inst of all) {
    if (handled.has(inst.uid)) continue;
    const item = data.items.get(inst.itemKey);
    if (!item || item.queue !== 'builder') continue;
    let tier: number;
    let order: number[];
    let reason: string;
    switch (item.category) {
      case 'army': {
        const idx = OFFENSE_ORDER.indexOf(item.id);
        tier = T.offense;
        order = [idx < 0 ? 99 : idx, inst.level];
        reason = 'Offense building (non-hero)';
        break;
      }
      case 'resourceStorage':
        tier = T.resources;
        order = [0, inst.level];
        reason = 'Storage (storages before collectors, lowest level first)';
        break;
      case 'resourceCollector':
        tier = T.resources;
        order = [1, inst.level];
        reason = 'Collector (lowest level first)';
        break;
      case 'defense':
      case 'trap':
      case 'mergedDefense':
        tier = T.defenses;
        order = [];
        reason = 'Permanent defense, longest first (LPT)';
        break;
      case 'guardian':
      case 'craftedDefense':
        tier = T.temporary;
        order = [];
        reason = item.category === 'guardian' ? 'Guardian (temporary tier), longest first' : 'Crafted defense module (temporary tier), longest first';
        break;
      default:
        continue;
    }
    if (busy.has(lockOf(inst))) continue;
    if (inst.planned) {
      const first = item.levels[0];
      if (first && (first.thRequired ?? 0) <= lv.th) fromLevel(item, inst, first, tier, order, `New building available: ${reason}`, 'build');
      continue;
    }
    const maxLv = maxLevelAt(item, { th: lv.th });
    if (inst.level >= maxLv) continue;
    const next = levelInfo(item, inst.level + 1);
    if (next) fromLevel(item, inst, next, tier, order, reason, 'upgrade');
  }

  // ── Supercharges (temporary tier) ──
  for (const inst of instances) {
    const sc = data.items.get(`${inst.itemKey}:sc`);
    if (!sc) continue;
    const base = data.items.get(inst.itemKey)!;
    if (inst.level < base.levels[base.levels.length - 1].level || busy.has(inst.uid)) continue;
    const next = levelInfo(sc, (inst.superchargeLevel ?? 0) + 1);
    if (!next || (next.thRequired ?? 0) > lv.th) continue;
    fromLevel(sc, inst, next, T.temporary, [], 'Supercharge (temporary tier), longest first', 'supercharge', inst.uid);
  }

  // Tier 0 (§6.2): every new building (incl. extra copies, missing merge sources, and merges whose sources
  // are ready) goes ahead of the Queen. Among them: the tier the building normally belongs to, then longest first.
  const normalTier = (item: Item): number => {
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
  };
  for (const c of out) {
    if (c.kind !== 'build' && c.kind !== 'merge') continue;
    c.tier = T.newBuild;
    c.order = [T0_BUILD, normalTier(c.item), -c.rawTimeSec, c.cost];
    c.reason = `Tier 0: ${c.reason}`;
  }

  // Builder efficiency (§6.6): tiers 5–6 longest-processing-time first, cheaper on ties.
  for (const c of out) if (c.tier === T.defenses || c.tier === T.temporary) c.order = [-c.rawTimeSec, c.cost];

  return out.sort(compareCandidates);
}
