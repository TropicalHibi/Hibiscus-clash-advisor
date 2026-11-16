// Discrete-event simulation of builders, lab and pet house (SPEC §10.1).
import type { GameData, OwnedInstance, Resource } from '../data/types';
import type { MetaFile } from '../meta/meta';
import type { AccountState } from '../state/parseExport';
import type { Settings } from '../state/settings';
import { clocksFor, helperGain, helpersFor, nextHelperTime, PLAIN_CLOCKS, type HelperSpec, type QueueClocks, type WorkClock } from './boosts';
import { GOLD_PASS_MAX_BOOST, HELPER_PERIOD_SEC } from './constants';
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
  /** Unboosted data time of the level (new jobs only; 0 for in-progress jobs). */
  rawTimeSec?: number;
  /** Seconds the helpers took off this job (Builder's Apprentice / Lab Assistant). */
  helperSavedSec?: number;
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
  /** Simulate starts up to this many seconds from now (Infinity = until nothing is left). */
  horizonSec: number;
  /** Never start a Town Hall upgrade (Everything tab: everything left at the current TH). */
  freezeTownHall?: boolean;
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
  /** Helpers applied in this run (empty when "Simulate helpers" is off). */
  helpers: HelperSpec[];
  /** Active boosts applied in this run, as short labels (e.g. "Builder Potion 42m left"). */
  activeBoosts: string[];
  warnings: string[];
}

interface Job {
  slot: Slot;
  start: number;
  end: number;
  lockUid: string;
  entry: TimelineEntry;
  /** A helper is set to repeat on this job's instance (export `helper_recurrent`). */
  recurrent: boolean;
  /** Export `helper_timer`: seconds left of a helper's hour on this job at the export time. */
  helperTimerSec?: number;
  apply: () => void;
}

/** A job already running at the export time (known item, or an id the game data doesn't know yet). */
interface Running {
  q: SlotQueue;
  goblin: boolean;
  lockUid: string;
  remainingSec: number;
  itemKey: string;
  itemName: string;
  toLevel: number;
  recurrent: boolean;
  helperTimerSec?: number;
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
  // Active boosts and helpers (SPEC §10.1), behind the "Simulate helpers" setting.
  const on = settings.simulateHelpers;
  const clocks: QueueClocks = on ? clocksFor(account, elapsedSec) : PLAIN_CLOCKS;
  const helperInfo = on ? helpersFor(data, account, elapsedSec) : { helpers: [] as HelperSpec[], warnings: [] as string[] };
  warnings.push(...helperInfo.warnings);
  const activeBoosts = on ? describeBoosts(account, elapsedSec) : [];
  const clockOf = (q: SlotQueue): WorkClock => (q === 'builder' ? clocks.builder : q === 'lab' ? clocks.lab : clocks.pet);
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

  // In-progress upgrades occupy their slot until their remaining time elapses: known items, and running
  // upgrades on ids the game data doesn't know yet (they still hold a builder / the lab / the pet house).
  const running: Running[] = [];
  for (const inst of instances) {
    if (inst.upgradingTo === undefined) continue;
    const item = data.items.get(inst.itemKey);
    if (!item) continue;
    const q: SlotQueue | undefined = item.queue === 'builder' ? 'builder' : item.queue === 'lab' ? 'lab' : item.queue === 'petHouse' ? 'petHouse' : undefined;
    if (!q) continue;
    const target = inst;
    running.push({
      q,
      goblin: !!inst.goblin,
      lockUid: lockOf(inst),
      remainingSec: inst.remainingSec ?? 0,
      itemKey: item.key,
      itemName: item.name,
      toLevel: inst.upgradingTo,
      recurrent: !!inst.helperRecurrent,
      helperTimerSec: inst.helperTimerSec,
      apply: () => {
        target.level = target.upgradingTo ?? target.level;
        delete target.upgradingTo;
        delete target.remainingSec;
      },
    });
  }
  (account.unknownJobs ?? []).forEach((u, i) =>
    running.push({
      q: u.queue,
      goblin: u.goblin,
      lockUid: `unknown:${u.dataId}#${i + 1}`,
      remainingSec: u.remainingSec,
      itemKey: `unknown:${u.dataId}`,
      itemName: `Unknown item ${u.dataId} (not in game data yet)`,
      toLevel: u.level + 1,
      recurrent: u.helperRecurrent,
      helperTimerSec: u.helperTimerSec,
      apply: () => {},
    }),
  );

  let goblinB = 0;
  let goblinL = 0;
  for (const r of running) {
    const q = r.q;
    let slot: Slot | undefined;
    if (r.goblin && q !== 'petHouse') {
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
    const lockUid = r.lockUid;
    // The export's timer counts from the export time (t = −elapsed); boosts active then speed it up.
    const end = clockOf(q).end(-elapsedSec, r.remainingSec);
    state.busy.add(lockUid);
    const entry: TimelineEntry = {
      slotId: slot.id,
      lockUid,
      start: 0,
      end,
      rawTimeSec: 0,
      itemKey: r.itemKey,
      itemName: r.itemName,
      toLevel: r.toLevel,
      cost: 0,
      resource: 'gold',
      reason: 'Already upgrading (paid)',
      kind: 'inProgress',
      inProgress: true,
    };
    timeline.push(entry);
    jobs.push({ slot, start: -elapsedSec, end, lockUid, entry, recurrent: r.recurrent, helperTimerSec: r.helperTimerSec, apply: r.apply });
  }

  // ── Helpers (Builder's Apprentice → a builder job, Lab Assistant → the running research) ──
  const setEnd = (j: Job, end: number, saved: number) => {
    j.end = end;
    j.entry.end = end;
    if (saved > 0) j.entry.helperSavedSec = (j.entry.helperSavedSec ?? 0) + saved;
  };
  const helpJob = (j: Job, workRate: number, t: number, gainOverride?: number) => {
    const clock = clockOf(j.slot.queue);
    const left = clock.remaining(t, j.end);
    const gain = gainOverride ?? helperGain(workRate, left);
    if (gain <= 0) return;
    const end = clock.end(t, left - gain);
    setEnd(j, end, j.end - end);
  };
  // Assignment rule: the job the export marks recurrent if it's running; else the Apprentice takes the
  // builder job with the most time left, the Assistant the running research. Never a Goblin job.
  const helperTarget = (h: HelperSpec, t: number): Job | undefined => {
    const running = jobs.filter((j) => j.slot.queue === h.queue && !j.slot.goblin && j.start <= t && j.end > t);
    const recurrent = running.find((j) => j.recurrent);
    if (recurrent) return recurrent;
    return running.sort((a, b) => b.end - a.end || (a.slot.id < b.slot.id ? -1 : 1))[0];
  };
  for (const h of helperInfo.helpers) {
    // A helper already at work at the export time (helper_timer on the item) adds the rest of its hour.
    for (const j of jobs) {
      const left = j.helperTimerSec;
      if (!left || j.slot.queue !== h.queue || j.slot.goblin) continue;
      const remaining = clockOf(j.slot.queue).remaining(-elapsedSec, j.end);
      helpJob(j, h.workRate, -elapsedSec, Math.min(h.workRate * left, (remaining * h.workRate) / (1 + h.workRate)));
    }
  }
  // Work hours between the export and now help the jobs that were running then.
  const pastHours = helperInfo.helpers
    .flatMap((h) => {
      const out: { h: HelperSpec; at: number }[] = [];
      for (let at = nextHelperTime(h, -elapsedSec); at < 0; at += HELPER_PERIOD_SEC) out.push({ h, at });
      return out;
    })
    .sort((a, b) => a.at - b.at);
  for (const { h, at } of pastHours) {
    const j = helperTarget(h, at);
    if (j) helpJob(j, h.workRate, at);
  }
  const helperNext = new Map<HelperSpec, number>();
  for (const h of helperInfo.helpers) helperNext.set(h, nextHelperTime(h, 0));
  // A job whose (helped / boosted) timer ran out before now finishes at t = 0.
  for (const j of jobs) if (j.end < 0) setEnd(j, 0, 0);

  let newSeq = 0;
  const findInst = (uid: string) => instances.find((i) => i.uid === uid);

  const startBuilder = (slot: Slot, t: number): boolean => {
    const cands = builderCandidates(data, state, settings, { builderBoost: boosts.builder, noTownHall: opts.freezeTownHall });
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
    const end = clocks.builder.end(t, c.timeSec);
    const entry: TimelineEntry = {
      slotId: slot.id,
      lockUid,
      start: t,
      end,
      rawTimeSec: c.rawTimeSec,
      itemKey: c.item.key,
      itemName: c.item.name,
      toLevel: c.toLevel,
      cost: c.cost,
      resource: c.resource,
      reason: c.reason,
      tier: c.tier,
      kind: c.kind,
      inProgress: false,
    };
    timeline.push(entry);
    jobs.push({ slot, start: t, end, lockUid, entry, recurrent: !!t0.helperRecurrent, apply });
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
    const end = clockOf(q).end(t, c.timeSec);
    const entry: TimelineEntry = {
      slotId: slot.id,
      lockUid: target.uid,
      start: t,
      end,
      rawTimeSec: c.rawTimeSec,
      itemKey: c.item.key,
      itemName: c.item.name,
      toLevel: c.toLevel,
      cost: c.cost,
      resource: c.resource,
      reason: c.reason,
      kind: 'upgrade',
      inProgress: false,
    };
    timeline.push(entry);
    jobs.push({
      slot,
      start: t,
      end,
      lockUid: target.uid,
      entry,
      recurrent: !!target.helperRecurrent,
      apply: () => {
        target.level = c.toLevel;
        delete target.upgradingTo;
      },
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
    // Helpers whose work hour starts now (after new jobs started, so a job starting now can be helped).
    for (const [h, at] of helperNext) {
      if (at > t) continue;
      const j = helperTarget(h, t);
      if (j) helpJob(j, h.workRate, t);
      helperNext.set(h, at + HELPER_PERIOD_SEC);
    }
    // A zero-time job finishes immediately; loop again at the same t.
    if (jobs.some((j) => j.end <= t)) continue;
    if (!jobs.length) break;
    t = Math.min(...jobs.map((j) => j.end), ...helperNext.values());
  }

  nowState ??= { instances: instances.map((i) => ({ ...i })), busy: new Set(state.busy) };
  return { slots, timeline, elapsedSec, nowState, idle, finalInstances: instances, helpers: helperInfo.helpers, activeBoosts, warnings };
}

/** Short labels for the boosts still running at "now". The Clock Tower is Builder Base only. */
function describeBoosts(account: AccountState, elapsedSec: number): string[] {
  const b = account.boosts;
  const out: string[] = [];
  const add = (name: string, sec: number) => {
    const left = sec - elapsedSec;
    if (left > 0) out.push(`${name} ${fmtDuration(left)} left`);
  };
  add('Builder Potion', b.builderPotionSec);
  add('Research Potion', b.researchPotionSec);
  add('Pet Potion', b.petPotionSec);
  add('Builder Bite', b.builderSnackSec);
  add('Study Soup', b.researchSnackSec);
  return out;
}
