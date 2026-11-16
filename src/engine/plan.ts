// Orchestrates parse → simulate → forecast into one Plan used by the UI and the CLI.
import type { GameData, Resource } from '../data/types';
import { checkMergeConsumption } from '../data/validate';
import { levelsOf } from '../state/levels';
import type { MetaFile } from '../meta/meta';
import type { AccountState } from '../state/parseExport';
import type { LabKind, Settings } from '../state/settings';
import { heroStatus } from './book';
import { HOUR } from './constants';
import { forecast, wallDump, type Forecast, type WallDump } from './forecast';
import { equipmentCandidates, labSections, researchCandidates, type QueueCandidate } from './queues';
import { boostsFor, simulate, type SimResult, type TimelineEntry } from './scheduler';
import { builderCandidates, detectMode, TIER_NAMES, type Candidate, type Mode } from './tiers';

export interface BookReadyHero {
  name: string;
  level: number;
  toLevel: number;
  cost: number;
  resource: Resource;
  /** Displayed time: Gold-Pass boosted when the toggle is on (the threshold check itself stays raw). */
  timeSec: number;
  rawTimeSec: number;
  afterCurrent: boolean; // book-ready once the running upgrade finishes
}

/** Merge-consumption check (§7), cached per data object: run in the browser so a stale merges.yaml shows on the Plan tab. */
const mergeIssueCache = new WeakMap<GameData, string[]>();
export function dataIssues(data: GameData): string[] {
  let hit = mergeIssueCache.get(data);
  if (!hit) {
    hit = [...data.warnings, ...checkMergeConsumption(data).map((i) => `Game data vs config/merges.yaml: ${i.message}`)];
    mergeIssueCache.set(data, hit);
  }
  return hit;
}

export interface Plan {
  nowSec: number;
  mode: Mode;
  tierNames: string[];
  townHall: number;
  maxTH: number;
  heroHall: number;
  builders: number;
  goldPass: Settings['goldPass'];
  bookThresholdSec: number;
  dataVersion: string;
  exportTimestamp?: number;
  sim: SimResult;
  /** Builder jobs that start right now (t = 0) — "what each free builder should start". */
  startNow: TimelineEntry[];
  /** Ranked builder candidates at the initial state (top of the list). */
  topCandidates: Candidate[];
  forecast: Forecast;
  bookReady: BookReadyHero[];
  wallDump: WallDump | null;
  /** Lab queue order: pins, then the weighted pick value across kinds (what the scheduler starts). */
  lab: QueueCandidate[];
  /** Lab tab sections: each kind ranked by its own score. */
  labByKind: Record<LabKind, QueueCandidate[]>;
  pets: QueueCandidate[];
  equipment: QueueCandidate[];
  warnings: string[];
}

export function buildPlan(data: GameData, account: AccountState, settings: Settings, meta: MetaFile, nowSec: number): Plan {
  const windowSec = settings.forecast.windowHours * HOUR;
  const sim = simulate(data, account, settings, meta, { nowSec, horizonSec: windowSec });
  const boosts = boostsFor(settings);

  // Ranked lists use the state at "now": jobs finished since the export are applied (SPEC §11).
  const state = sim.nowState;
  const lvNow = levelsOf(state.instances);

  const equipment = equipmentCandidates(data, state.instances, settings, meta);
  const bookReady: BookReadyHero[] = [];
  for (const inst of state.instances) {
    const item = data.items.get(inst.itemKey);
    if (item?.category !== 'hero') continue;
    const lvl = inst.upgradingTo ?? inst.level;
    const st = heroStatus(item, lvl, lvNow.heroHall, data.bookThresholdSec);
    if (st.kind === 'bookReady')
      bookReady.push({
        name: item.name,
        level: lvl,
        toLevel: st.next.level,
        cost: st.next.cost,
        resource: st.next.resource,
        timeSec: Math.round(st.next.timeSec * (1 - boosts.builder)),
        rawTimeSec: st.next.timeSec,
        afterCurrent: inst.upgradingTo !== undefined,
      });
  }

  const warnings = [...dataIssues(data), ...sim.warnings];
  for (const u of account.unresolved) warnings.push(`Unknown dataId ${u.dataId} in "${u.section}" (not in game data ${data.version}); ignored.`);
  if (!account.exportTimestamp) warnings.push('Export has no timestamp; timers count from the import time.');

  const lab = researchCandidates(data, state, 'lab', settings, meta, boosts.research);
  const mode = detectMode(lvNow.th, data);
  return {
    nowSec,
    mode,
    tierNames: TIER_NAMES[mode],
    townHall: lvNow.th,
    maxTH: data.maxTH,
    heroHall: lvNow.heroHall,
    builders: account.builders,
    goldPass: settings.goldPass,
    bookThresholdSec: data.bookThresholdSec,
    dataVersion: data.version,
    exportTimestamp: account.exportTimestamp,
    sim,
    startNow: sim.timeline.filter((e) => !e.inProgress && e.start === 0),
    topCandidates: builderCandidates(data, state, settings, { builderBoost: boosts.builder }).slice(0, 15),
    forecast: forecast(sim.timeline, windowSec, equipment, settings.forecast.blacksmithTopN),
    bookReady,
    wallDump: wallDump(data, account),
    lab,
    labByKind: labSections(lab, settings.lab.pinned),
    pets: researchCandidates(data, state, 'petHouse', settings, meta, boosts.research),
    equipment,
    warnings,
  };
}
