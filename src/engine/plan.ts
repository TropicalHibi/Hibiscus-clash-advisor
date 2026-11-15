// Orchestrates parse → simulate → forecast into one Plan used by the UI and the CLI.
import type { GameData, Resource } from '../data/types';
import type { MetaFile } from '../meta/meta';
import type { AccountState } from '../state/parseExport';
import type { Settings } from '../state/settings';
import { heroStatus } from './book';
import { HOUR } from './constants';
import { forecast, wallDump, type Forecast, type WallDump } from './forecast';
import { equipmentCandidates, researchCandidates, type QueueCandidate } from './queues';
import { boostsFor, simulate, type SimResult, type TimelineEntry } from './scheduler';
import { builderCandidates, detectMode, TIER_NAMES, type Candidate, type Mode } from './tiers';

export interface BookReadyHero {
  name: string;
  level: number;
  toLevel: number;
  cost: number;
  resource: Resource;
  timeSec: number; // raw
  afterCurrent: boolean; // book-ready once the running upgrade finishes
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
  lab: QueueCandidate[];
  pets: QueueCandidate[];
  equipment: QueueCandidate[];
  warnings: string[];
}

export function buildPlan(data: GameData, account: AccountState, settings: Settings, meta: MetaFile, nowSec: number): Plan {
  const windowSec = settings.forecast.windowHours * HOUR;
  const sim = simulate(data, account, settings, meta, { nowSec, horizonSec: windowSec });
  const boosts = boostsFor(settings);
  const mode = detectMode(account.townHall, data);

  // Initial engine state for ranked lists (in-progress items are busy).
  const busy = new Set<string>();
  for (const i of account.instances) if (i.upgradingTo !== undefined) busy.add(i.parentUid ?? i.uid);
  const state = { instances: account.instances, busy };

  const equipment = equipmentCandidates(data, account.instances, settings, meta);
  const bookReady: BookReadyHero[] = [];
  for (const inst of account.instances) {
    const item = data.items.get(inst.itemKey);
    if (item?.category !== 'hero') continue;
    const lvl = inst.upgradingTo ?? inst.level;
    const st = heroStatus(item, lvl, account.heroHall, data.bookThresholdSec);
    if (st.kind === 'bookReady')
      bookReady.push({ name: item.name, level: lvl, toLevel: st.next.level, cost: st.next.cost, resource: st.next.resource, timeSec: st.next.timeSec, afterCurrent: inst.upgradingTo !== undefined });
  }

  const warnings = [...sim.warnings];
  for (const u of account.unresolved) warnings.push(`Unknown dataId ${u.dataId} in "${u.section}" (not in game data ${data.version}); ignored.`);
  if (!account.exportTimestamp) warnings.push('Export has no timestamp; timers count from the import time.');

  return {
    nowSec,
    mode,
    tierNames: TIER_NAMES[mode],
    townHall: account.townHall,
    maxTH: data.maxTH,
    heroHall: account.heroHall,
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
    lab: researchCandidates(data, state, 'lab', settings, meta, boosts.research),
    pets: researchCandidates(data, state, 'petHouse', settings, meta, boosts.research),
    equipment,
    warnings,
  };
}
