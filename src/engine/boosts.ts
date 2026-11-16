// Active boosts and helpers in the scheduler (SPEC §10.1).
//
// Times are seconds relative to "now" (the export was taken at −elapsed). A boost makes a queue's
// work run faster for a while; a WorkClock maps wall time ↔ work done so a job needing `w` seconds of
// work that starts at `s` ends at clock.end(s, w). Helpers are discrete events: once per day each helper
// adds `workRate` hours of progress to one job (Builder's Apprentice → a builder job, Lab Assistant → the
// running research).
import type { GameData } from '../data/types';
import type { AccountState } from '../state/parseExport';
import { BOOST_MULTIPLIER, HELPER_PERIOD_SEC, HELPER_WORK_SEC } from './constants';

interface Window {
  from: number;
  to: number;
  /** Extra work per second while active (multiplier − 1). */
  extra: number;
}

/** Wall time ↔ work done for one queue. With no windows, work = wall time. */
export class WorkClock {
  private readonly windows: Window[];
  constructor(windows: Window[] = []) {
    this.windows = windows.filter((w) => w.to > w.from && w.extra > 0);
  }
  get boosted(): boolean {
    return this.windows.length > 0;
  }
  /** Cumulative work at wall time t (only differences matter). */
  work(t: number): number {
    let w = t;
    for (const x of this.windows) w += x.extra * Math.min(Math.max(t - x.from, 0), x.to - x.from);
    return w;
  }
  /** Wall time at which cumulative work reaches `w` (inverse of work(), which is strictly increasing). */
  inv(w: number): number {
    if (!this.windows.length) return w;
    const pts = [...new Set(this.windows.flatMap((x) => [x.from, x.to]))].sort((a, b) => a - b);
    // Before the first breakpoint the rate is 1.
    if (w <= this.work(pts[0])) return w - this.work(pts[0]) + pts[0];
    for (let i = 0; i < pts.length - 1; i++) {
      const w0 = this.work(pts[i]);
      const w1 = this.work(pts[i + 1]);
      if (w <= w1) return pts[i] + ((w - w0) / (w1 - w0)) * (pts[i + 1] - pts[i]);
    }
    const last = pts[pts.length - 1];
    return last + (w - this.work(last));
  }
  /** Wall time a job ends if it starts at `start` and needs `workSec` seconds of work. */
  end(start: number, workSec: number): number {
    return this.boosted ? this.inv(this.work(start) + workSec) : start + workSec;
  }
  /** Work still left at wall time t for a job ending at `end`. */
  remaining(t: number, end: number): number {
    return this.boosted ? Math.max(0, this.work(end) - this.work(t)) : Math.max(0, end - t);
  }
}

export interface QueueClocks {
  builder: WorkClock;
  research: WorkClock;
}

export const PLAIN_CLOCKS: QueueClocks = { builder: new WorkClock(), research: new WorkClock() };

/** Clocks for the export's active boosts. Boost timers count from the export time (t = −elapsed). */
export function clocksFor(account: AccountState, elapsedSec: number): QueueClocks {
  const b = account.boosts;
  const t0 = -elapsedSec;
  const win = (sec: number, mult: number): Window => ({ from: t0, to: t0 + sec, extra: mult - 1 });
  return {
    builder: new WorkClock([win(b.builderPotionSec, BOOST_MULTIPLIER.builderPotion), win(b.builderSnackSec, BOOST_MULTIPLIER.builderSnack)]),
    research: new WorkClock([win(b.researchPotionSec, BOOST_MULTIPLIER.researchPotion), win(b.researchSnackSec, BOOST_MULTIPLIER.researchSnack)]),
  };
}

export interface HelperSpec {
  id: 'builders-apprentice' | 'lab-assistant';
  name: string;
  level: number;
  /** Hours of extra progress per work hour (from the data's `workRate`). */
  workRate: number;
  /** Which slots it helps: builders (Apprentice) or the Laboratory (Assistant). */
  queue: 'builder' | 'lab';
  /** First work hour, seconds from now (may be negative: between the export and now). */
  firstAt: number;
}

const HELPER_QUEUE: Record<HelperSpec['id'], HelperSpec['queue']> = { 'builders-apprentice': 'builder', 'lab-assistant': 'lab' };

/**
 * The account's time helpers. Their first work hour is when the shared helper cooldown ends (counted from
 * the export), or now when the export has no cooldown; then once every HELPER_PERIOD_SEC.
 */
export function helpersFor(data: GameData, account: AccountState, elapsedSec: number): { helpers: HelperSpec[]; warnings: string[] } {
  const helpers: HelperSpec[] = [];
  const warnings: string[] = [];
  for (const h of account.helpers) {
    const queue = HELPER_QUEUE[h.id as HelperSpec['id']];
    if (!queue || h.level <= 0) continue;
    const item = data.byDataId.get(h.dataId);
    const rates = item?.helperWorkRates ?? {};
    const known = Object.keys(rates).map(Number);
    let workRate: number | undefined = rates[h.level];
    if (workRate === undefined && known.length) {
      // A level the data doesn't know yet: use the highest known level at or below it.
      const lv = Math.max(...known.filter((l) => l <= h.level));
      workRate = Number.isFinite(lv) ? rates[lv] : undefined;
      if (workRate !== undefined) warnings.push(`${h.name} level ${h.level} isn't in the game data; using level ${lv}'s work rate (${workRate}).`);
    }
    if (!workRate) continue;
    const firstAt = account.helperCooldownSec !== undefined ? account.helperCooldownSec - elapsedSec : 0;
    helpers.push({ id: h.id as HelperSpec['id'], name: h.name, level: h.level, workRate, queue, firstAt });
  }
  return { helpers, warnings };
}

/**
 * Work a helper adds to a job with `remainingWork` seconds left when its hour starts: `workRate` hours,
 * or less when the job would finish inside the hour (it runs at 1 + workRate speed until done).
 */
export function helperGain(workRate: number, remainingWork: number): number {
  return Math.max(0, Math.min(workRate * HELPER_WORK_SEC, (remainingWork * workRate) / (1 + workRate)));
}

/** Next work-hour start at or after t for a helper (firstAt + k × period, k ≥ 0). */
export function nextHelperTime(h: HelperSpec, t: number): number {
  if (t <= h.firstAt) return h.firstAt;
  return h.firstAt + Math.ceil((t - h.firstAt) / HELPER_PERIOD_SEC) * HELPER_PERIOD_SEC;
}
