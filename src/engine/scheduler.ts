// Discrete-event simulation of builders, lab and pet house (SPEC §10.1).
import type { GameData, OwnedInstance, Resource } from '../data/types';
import type { MetaFile } from '../meta/meta';
import type { AccountState } from '../state/parseExport';
import type { Settings } from '../state/settings';
import { GOLD_PASS_MAX_BOOST } from './constants';
import { fmtDuration } from './format';
import { nextResearch, researchCandidates } from './queues';

/** An export timestamp more than this far ahead of "now" is reported as clock skew. */
export const FUTURE_TOLERANCE_SEC = 300;
import { builderCandidates, lockOf, type CandidateKind, type EngineState } from './tiers';

export type SlotQueue = 'builder' | 'lab' | 'petHouse';

export interface Slot {
  id: string; // B1.., GB (goblin builder), LAB, GL (goblin lab), PET
  queue: SlotQueue;
  goblin: boolean;
  label: string;
}

export interface TimelineEntry {
  slotId: string;
  /** Building / unit lock the job holds (one upgrade per lock at a time). */
  lockUid: string;
  /** Seconds from "now". In-progress jobs start at 0. */
  start: number;
  end: number;
  itemKey: string;
  itemName: string;
  toLevel: number;
  cost: number;
  resource: Resource;
  reason: string;
  tier?: number;
  kind: CandidateKind | 'inProgress';
  inProgress: boolean;
}

export interface SimOptions {
  /** Unix seconds for "now". */
  nowSec: number;
  /** Simulate starts up to this many seconds from now. */
  horizonSec: number;
}

export interface SimResult {
  slots: Slot[];
  timeline: TimelineEntry[];
  /** Seconds the export is old (now − export timestamp); 0 if no timestamp or a future timestamp. */
  elapsedSec: number;
  /**
   * Engine state at "now" (t = 0): jobs that finished since the export are applied, nothing new is
   * started yet. The ranked lists (top builder priorities, lab, pets, equipment, book-ready) use it.
   */
  nowState: EngineState;
  /** Slots that had nothing eligible to start at some point, with the time it happened. */
  idle: { slotId: string; at: number }[];
  finalInstances: OwnedInstance[];
  warnings: string[];
}

interface Job {
  slot: Slot;
  end: number;
  lockUid: string;
  apply: () => void;
}

export function boostsFor(settings: Settings): { builder: number; research: number } {
  return settings.goldPass === 'max' ? { ...GOLD_PASS_MAX_BOOST } : { builder: 0, research: 0 };
}

export function simulate(data: GameData, account: AccountState, settings: Settings, meta: MetaFile, opts: SimOptions): SimResult {
  const boosts = boostsFor(settings);
  const warnings: string[] = [];
  const ahead = account.exportTimestamp ? account.exportTimestamp - opts.nowSec : 0;
  if (ahead > FUTURE_TOLERANCE_SEC)
    warnings.push(`The export timestamp is ${fmtDuration(ahead)} in the future; check the device clock. Timers are counted from now.`);
  const elapsedSec = account.exportTimestamp ? Math.max(0, opts.nowSec - account.exportTimestamp) : 0;
  const instances: OwnedInstance[] = account.instances.map((i) => ({ ...i }));
  const state: EngineState = { instances, busy: new Set() };
  let nowState: EngineState | undefined;
  const timeline: TimelineEntry[] = [];
  const idle: { slotId: string; at: number }[] = [];

  const slots: Slot[] = [];
  for (let n = 1; n <= account.builders; n++) slots.push({ id: `B${n}`, queue: 'builder', goblin: false, label: `Builder ${n}` });
  if (account.lab > 0) slots.push({ id: 'LAB', queue: 'lab', goblin: false, label: 'Laboratory' });
  if (account.petHouse > 0) slots.push({ id: 'PET', queue: 'petHouse', goblin: false, label: 'Pet House' });

  const jobs: Job[] = [];
  const slotBusy = (s: Slot) => jobs.some((j) => j.slot === s);

  // In-progress upgrades occupy their slot until their (raw) remaining time elapses.
  let goblinB = 0;
  let goblinL = 0;
  for (const inst of instances) {
    if (inst.upgradingTo === undefined) continue;
    const item = data.items.get(inst.itemKey);
    if (!item) continue;
    const q: SlotQueue | undefined = item.queue === 'builder' ? 'builder' : item.queue === 'lab' ? 'lab' : item.queue === 'petHouse' ? 'petHouse' : undefined;
    if (!q) continue;
    let slot: Slot | undefined;
    if (inst.goblin && q !== 'petHouse') {
      const id = q === 'builder' ? `GB${++goblinB > 1 ? goblinB : ''}` : `GL${++goblinL > 1 ? goblinL : ''}`;
      slot = { id, queue: q, goblin: true, label: q === 'builder' ? 'Goblin Builder' : 'Goblin Researcher' };
      slots.push(slot);
    } else {
      slot = slots.find((s) => s.queue === q && !s.goblin && !slotBusy(s));
      if (!slot) {
        const n = slots.filter((s) => s.queue === q).length + 1;
        slot = { id: q === 'builder' ? `B${n}` : `${q.toUpperCase()}${n}`, queue: q, goblin: false, label: `${q} ${n} (extra)` };
        slots.push(slot);
        warnings.push(`More in-progress ${q} upgrades than slots; added ${slot.id}. Check builder count.`);
      }
    }
    const lockUid = lockOf(inst);
    const end = Math.max(0, (inst.remainingSec ?? 0) - elapsedSec);
    const target = inst;
    state.busy.add(lockUid);
    jobs.push({
      slot,
      end,
      lockUid,
      apply: () => {
        target.level = target.upgradingTo ?? target.level;
        delete target.upgradingTo;
        delete target.remainingSec;
      },
    });
    timeline.push({
      slotId: slot.id,
      lockUid,
      start: 0,
      end,
      itemKey: item.key,
      itemName: item.name,
      toLevel: inst.upgradingTo,
      cost: 0,
      resource: 'gold',
      reason: 'Already upgrading (paid)',
      kind: 'inProgress',
      inProgress: true,
    });
  }

  let newSeq = 0;
  const findInst = (uid: string) => instances.find((i) => i.uid === uid);

  const startBuilder = (slot: Slot, t: number): boolean => {
    const cands = builderCandidates(data, state, settings, { builderBoost: boosts.builder });
    const c = cands.find((x) => !state.busy.has(x.lockUid) && !(x.consumes ?? []).some((u) => state.busy.has(u)));
    if (!c) return false;
    let target: OwnedInstance | undefined;
    let lockUid = c.lockUid;
    let apply: () => void;
    if (c.kind === 'merge') {
      const consumed = new Set(c.consumes ?? []);
      for (let i = instances.length - 1; i >= 0; i--) if (consumed.has(instances[i].uid)) instances.splice(i, 1);
      target = { uid: `${c.item.key}#b${++newSeq}`, dataId: c.item.dataId, itemKey: c.item.key, level: 0, upgradingTo: c.toLevel };
      instances.push(target);
      lockUid = target.uid;
    } else if (c.instance.planned) {
      target = { uid: `${c.item.key}#b${++newSeq}`, dataId: c.item.dataId, itemKey: c.item.key, level: 0, upgradingTo: c.toLevel };
      instances.push(target);
      lockUid = target.uid;
    } else {
      target = findInst(c.instance.uid);
      if (!target) return false;
    }
    const t0 = target;
    if (c.kind === 'supercharge') {
      apply = () => {
        t0.superchargeLevel = c.toLevel;
      };
    } else if (c.kind === 'weapon') {
      apply = () => {
        t0.weaponLevel = c.toLevel;
      };
    } else {
      t0.upgradingTo = c.toLevel;
      apply = () => {
        t0.level = c.toLevel;
        delete t0.upgradingTo;
        // A new TH starts its weapon at level 1.
        if (c.item.category === 'townHall') t0.weaponLevel = 1;
      };
    }
    state.busy.add(lockUid);
    jobs.push({ slot, end: t + c.timeSec, lockUid, apply });
    timeline.push({
      slotId: slot.id,
      lockUid,
      start: t,
      end: t + c.timeSec,
      itemKey: c.item.key,
      itemName: c.item.name,
      toLevel: c.toLevel,
      cost: c.cost,
      resource: c.resource,
      reason: c.reason,
      tier: c.tier,
      kind: c.kind,
      inProgress: false,
    });
    return true;
  };

  const startResearch = (slot: Slot, t: number): boolean => {
    const q = slot.queue as 'lab' | 'petHouse';
    // Research and Laboratory / Pet House building upgrades run fully in parallel (SPEC §6.6).
    const c = nextResearch(researchCandidates(data, state, q, settings, meta, boosts.research));
    if (!c) return false;
    const target = findInst(c.instance.uid);
    if (!target) return false;
    target.upgradingTo = c.toLevel;
    state.busy.add(target.uid);
    jobs.push({
      slot,
      end: t + c.timeSec,
      lockUid: target.uid,
      apply: () => {
        target.level = c.toLevel;
        delete target.upgradingTo;
      },
    });
    timeline.push({
      slotId: slot.id,
      lockUid: target.uid,
      start: t,
      end: t + c.timeSec,
      itemKey: c.item.key,
      itemName: c.item.name,
      toLevel: c.toLevel,
      cost: c.cost,
      resource: c.resource,
      reason: c.reason,
      kind: 'upgrade',
      inProgress: false,
    });
    return true;
  };

  let t = 0;
  const idleNoted = new Set<string>();
  for (let guard = 0; guard < 100000; guard++) {
    // Complete everything due at t.
    jobs.sort((a, b) => a.end - b.end);
    while (jobs.length && jobs[0].end <= t) {
      const j = jobs.shift()!;
      j.apply();
      state.busy.delete(j.lockUid);
    }
    if (!nowState) nowState = { instances: instances.map((i) => ({ ...i })), busy: new Set(state.busy) };
    if (t >= opts.horizonSec) break;
    // Fill free slots. Goblin slots never take new work (temporary helpers).
    for (const slot of slots) {
      if (slot.goblin || slotBusy(slot)) continue;
      const ok = slot.queue === 'builder' ? startBuilder(slot, t) : startResearch(slot, t);
      if (!ok && !idleNoted.has(slot.id)) {
        idleNoted.add(slot.id);
        idle.push({ slotId: slot.id, at: t });
      }
      if (ok) idleNoted.delete(slot.id);
    }
    // A zero-time job finishes immediately; loop again at the same t.
    if (jobs.some((j) => j.end <= t)) continue;
    if (!jobs.length) break;
    t = Math.min(...jobs.map((j) => j.end));
  }

  nowState ??= { instances: instances.map((i) => ({ ...i })), busy: new Set(state.busy) };
  return { slots, timeline, elapsedSec, nowState, idle, finalInstances: instances, warnings };
}
