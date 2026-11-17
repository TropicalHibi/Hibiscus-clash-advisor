// Orchestrates parse → simulate → forecast into one Plan used by the UI and the CLI.
import type { GameData, Resource } from '../data/types';
import { dataSourceLabel } from '../data/source';
import { checkMergeConsumption } from '../data/validate';
import { levelsOf } from '../state/levels';
import type { MetaFile } from '../meta/meta';
import { isLikelyUnreleased, unreleasedNote, type AccountState } from '../state/parseExport';
import type { LabKind, Settings } from '../state/settings';
import { heroStatus } from './book';
import { nextHelperTime } from './boosts';
import { HOUR } from './constants';
import { fmtClock } from './format';
import { forecast, wallDump, type Forecast, type WallDump } from './forecast';
import { equipmentCandidates, labSections, researchCandidates, type QueueCandidate } from './queues';
import { boostsFor, simulate, type SimResult, type TimelineEntry } from './scheduler';
import { builderCandidates, detectMode, TIER_NAMES, type Candidate, type Mode } from './tiers';

export interface BookReadyHero {
  itemKey: string;
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
  /** "Simulate helpers" setting (helpers + active boosts applied). */
  simulateHelpers: boolean;
  /** One line about helpers and boosts for the summary ("Builder's Apprentice L8 (8h/day) …"). */
  helperLine: string;
  /** "Apprentice: repeating on Grand Warden. Suggest switching to Town Hall 19 …" (§10.1; suggestion only). */
  helperSuggestions: string[];
  /** "equipment 90000062 (level 1), …": unknown level-1 equipment, likely unreleased (info, not a warning). */
  unrecognized: string;
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

/** Summary of the helpers and boosts the scheduler applied. */
export function helperLine(account: AccountState, sim: SimResult, nowSec: number, on: boolean): string {
  const timeHelpers = account.helpers.filter((h) => h.id === 'builders-apprentice' || h.id === 'lab-assistant');
  if (!on) return timeHelpers.length ? 'not simulated (Settings → Simulate helpers and boosts is off)' : '';
  const parts: string[] = [];
  if (sim.helpers.length) {
    // Helpers share one cooldown, so they all work at the same time.
    const next = Math.min(...sim.helpers.map((h) => nextHelperTime(h, 0)));
    parts.push(`${sim.helpers.map((h) => `${h.name} L${h.level} (−${h.workRate}h/day)`).join(', ')}; next work hour ${fmtClock(nowSec + next, nowSec)}`);
  }
  if (sim.activeBoosts.length) parts.push(`Boosts: ${sim.activeBoosts.join(', ')}`);
  return parts.join(' · ');
}

const HELPER_SHORT: Record<string, string> = { 'builders-apprentice': 'Apprentice', 'lab-assistant': 'Lab Assistant' };

/** One line per helper whose export repeat setting differs from the planner's pick (§10.1). */
export function helperSuggestionLines(sim: SimResult): string[] {
  return sim.helperSuggestions.map((s) => {
    const who = HELPER_SHORT[s.helper.id] ?? s.helper.name;
    return `${who}: repeating on ${s.repeating.itemName}. Suggest switching to ${s.suggested.itemName} ${s.suggested.toLevel} after ${s.repeating.itemName} finishes (or now).`;
  });
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
        itemKey: item.key,
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

  const warnings = [...dataIssues(data), ...account.warnings, ...sim.warnings];
  // Level-1 unknown equipment is likely unreleased: an info note (Import tab, CLI), not a warning.
  for (const u of account.unresolved.filter((x) => !isLikelyUnreleased(x)))
    warnings.push(
      u.upgrading
        ? `Unknown dataId ${u.dataId} in "${u.section}" (not in game data ${data.version}): its running upgrade still occupies a slot until it finishes.`
        : `Unknown dataId ${u.dataId} in "${u.section}" (not in game data ${data.version}); ignored.`,
    );
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
    simulateHelpers: settings.simulateHelpers,
    helperLine: helperLine(account, sim, nowSec, settings.simulateHelpers),
    helperSuggestions: helperSuggestionLines(sim),
    unrecognized: unreleasedNote(account.unresolved),
    bookThresholdSec: data.bookThresholdSec,
    dataVersion: dataSourceLabel(data),
    exportTimestamp: account.exportTimestamp,
    sim,
    startNow: sim.timeline.filter((e) => !e.inProgress && e.start === 0),
    topCandidates: builderCandidates(data, state, settings, { builderBoost: boosts.builder }).slice(0, 15),
    forecast: forecast(sim.timeline, windowSec),
    bookReady,
    wallDump: wallDump(data, account),
    lab,
    labByKind: labSections(lab, settings.lab.pinned),
    pets: researchCandidates(data, state, 'petHouse', settings, meta, boosts.research),
    equipment,
    warnings,
  };
}
