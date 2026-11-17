// `npm run sync` logic (SPEC §9). syncData: the clash-of-clans-data package (images, TH weapons, backup),
// updated within the current major with a known-good restore. syncAll: that, then ClashKing (the game data).
// Side effects are injected so every branch can be tested.
import { syncClashKing, type ClashKingDeps, type ClashKingResult } from './clashking';
import { isNewerVersion, type RefreshState } from './refresh';
import type { SnapshotResult } from './snapshots';

export interface DataCheck {
  /** False when the installed data can't be used: normalize threw, or levels are broken. */
  ok: boolean;
  /** Why it isn't usable (first error). */
  error?: string;
  /** Non-blocking findings (merge consumption, hero caps, unknown resources). */
  warnings: string[];
  maxTH?: number;
}

export interface SyncDeps {
  installedVersion(): string | undefined;
  /** Newest published version below the next major (npm view clash-of-clans-data@"<N+1.0.0"). */
  latestInMajor(major: number): string;
  /** npm install clash-of-clans-data@<version>. Throws on failure. */
  install(version: string): void;
  /** Loads + validates the currently installed data. */
  check(): DataCheck;
  readState(): RefreshState;
  writeState(s: RefreshState): void;
  /** Writes the normalized snapshot of the installed data and prints the diff vs the previous one. */
  snapshot?(): SnapshotResult | void;
  log(line: string): void;
}

export interface SyncOptions {
  /** Don't ask npm or install anything: validate and snapshot the installed version only. */
  offline?: boolean;
}

export type SyncOutcome = 'up-to-date' | 'updated' | 'restored' | 'failed';

export const majorOf = (v: string | undefined) => Number((v ?? '0').replace(/^v/, '').split('.')[0]) || 0;

/** `npm view … version --json` prints a string for one match and an array for several. */
export function newestOf(npmJson: string): string {
  const parsed = JSON.parse(npmJson.trim() || '""') as string | string[];
  const list = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
  if (!list.length) throw new Error('npm returned no version');
  return list.reduce((best, v) => (isNewerVersion(v, best) ? v : best));
}

function report(d: SyncDeps, c: DataCheck): void {
  if (c.maxTH !== undefined) d.log(`Max TH in data: ${c.maxTH}`);
  if (!c.warnings.length) d.log('Validation: all checks passed.');
  for (const w of c.warnings) d.log(`  [WARN] ${w}`);
  // Snapshot + diff (SPEC §9 steps 2–3). A failure here never fails the sync: the data itself is fine.
  try {
    d.snapshot?.();
  } catch (e) {
    d.log(`  [WARN] snapshot/diff failed: ${(e as Error).message}`);
  }
}

/**
 * Update within the current major. A new version that fails to load is replaced by the last known-good
 * version, and the failure is recorded in refresh-state.json so `npm run dev` warns on every start.
 */
export function syncData(d: SyncDeps, opts: SyncOptions = {}): SyncOutcome {
  const before = d.installedVersion();
  const state = d.readState();
  d.log(`clash-of-clans-data installed: ${before ?? 'none'}`);

  const current = before ? d.check() : { ok: false, error: 'not installed', warnings: [] };
  let lastGood = state.lastGoodDataVersion;
  if (current.ok && before) lastGood = before;

  if (opts.offline) {
    if (!current.ok) {
      d.log(`clash-of-clans-data ${before ?? 'none'} can't be used: ${current.error ?? 'unknown error'} (offline: nothing restored; run npm run sync).`);
      return 'failed';
    }
    d.writeState({ ...state, lastGoodDataVersion: before });
    d.log(`Offline: checked the installed ${before} without asking npm.`);
    report(d, current);
    return 'up-to-date';
  }

  let latest: string;
  try {
    latest = d.latestInMajor(majorOf(before ?? lastGood));
  } catch (e) {
    d.log(`npm view failed: ${(e as Error).message}`);
    return 'failed';
  }

  if (!isNewerVersion(latest, before)) {
    if (current.ok) {
      d.writeState({ ...state, lastGoodDataVersion: before });
      d.log(`clash-of-clans-data ${before} is the newest ${majorOf(before)}.x release (unchanged).`);
      report(d, current);
      return 'up-to-date';
    }
    // The installed version itself is broken (e.g. installed by hand): fall back to the last good one.
    return restore(d, before ?? 'none', current.error ?? 'unknown error', lastGood);
  }

  // Snapshot the installed version first, so there is always a "before" to diff against, even on a fresh
  // checkout with no data/snapshots/ (the daily GitHub Action). A no-op when it's already recorded.
  if (current.ok) {
    try {
      d.snapshot?.();
    } catch (e) {
      d.log(`  [WARN] snapshot of ${before} failed: ${(e as Error).message}`);
    }
  }
  d.log(`Installing clash-of-clans-data ${latest} (newest ${majorOf(latest)}.x)…`);
  try {
    d.install(latest);
  } catch (e) {
    d.log(`npm install failed: ${(e as Error).message}`);
    return 'failed';
  }
  const next = d.check();
  if (!next.ok) return restore(d, latest, next.error ?? 'unknown error', lastGood);
  const { dataFailure: _cleared, ...rest } = d.readState();
  d.writeState({ ...rest, lastGoodDataVersion: latest });
  d.log(`clash-of-clans-data ${before ?? 'none'} → ${latest} (UPDATED: restart npm run dev)`);
  report(d, next);
  return 'updated';
}

function restore(d: SyncDeps, badVersion: string, reason: string, lastGood: string | undefined): SyncOutcome {
  d.log(`clash-of-clans-data ${badVersion} can't be used: ${reason}`);
  d.writeState({ ...d.readState(), dataFailure: { version: badVersion, reason, at: Date.now() }, ...(lastGood ? { lastGoodDataVersion: lastGood } : {}) });
  if (!lastGood || lastGood === badVersion) {
    d.log('No known-good version to go back to. Fix the problem above, then run npm run sync again.');
    return 'failed';
  }
  d.log(`Restoring the last known-good version ${lastGood}…`);
  try {
    d.install(lastGood);
  } catch (e) {
    d.log(`Restore failed: ${(e as Error).message}`);
    return 'failed';
  }
  const back = d.check();
  d.log(back.ok ? `Restored ${lastGood}. The site keeps using it until ${badVersion} loads (fix config/merges.yaml or the code, then npm run sync).` : `Restored ${lastGood}, but it fails too: ${back.error}`);
  return 'restored';
}

// ── Full sync (SPEC §9): clash-of-clans-data package, then ClashKing, then the active data's report ──

export interface FullSyncDeps {
  /** clash-of-clans-data package stage (item images, TH weapons, backup source). Its snapshot hook is ignored. */
  coc: SyncDeps;
  /** ClashKing stage (the game data). Its snapshot hook records the active data. */
  clashKing: ClashKingDeps;
  /** Loads + validates the active data (ClashKing, or the backup) after both stages. */
  activeCheck(): DataCheck & { source?: string };
  /** Snapshot + diff of the active data (once per data version). */
  snapshot?(): SnapshotResult | void;
  /** Cross-check report lines (ClashKing vs clash-of-clans-data). Never fails the sync. */
  crossCheck?(): string[];
  log(line: string): void;
}

export interface FullSyncResult {
  outcome: SyncOutcome;
  coc: SyncOutcome;
  clashKing: ClashKingResult;
  /** Diff of the active data, when a new version was recorded. */
  snapshot?: SnapshotResult;
  crossCheck: string[];
}

export function syncAll(d: FullSyncDeps, opts: SyncOptions = {}): FullSyncResult {
  d.log('— clash-of-clans-data (item images, TH weapons, backup source) —');
  const { snapshot: _ignored, ...cocDeps } = d.coc;
  const coc = syncData(cocDeps, opts);
  d.log('— ClashKing (game data) —');
  const clashKing = syncClashKing(d.clashKing, opts);
  d.log('— Active game data —');
  const active = d.activeCheck();
  if (active.source) d.log(`Source: ${active.source}`);
  if (!active.ok) d.log(`  [ERROR] the active game data can't be used: ${active.error}`);
  else report({ ...d.coc, snapshot: undefined, log: d.log }, active);
  let snapshot = clashKing.snapshot;
  if (!snapshot && active.ok) {
    try {
      snapshot = d.snapshot?.() ?? undefined;
    } catch (e) {
      d.log(`  [WARN] snapshot/diff failed: ${(e as Error).message}`);
    }
  }
  let crossCheck: string[] = [];
  try {
    crossCheck = d.crossCheck?.() ?? [];
  } catch (e) {
    crossCheck = [`Cross-check skipped: ${(e as Error).message}`];
  }
  for (const l of crossCheck) d.log(l);

  const ckBad = clashKing.outcome === 'kept-previous' ? 'restored' : ['check-failed', 'download-failed', 'no-copy'].includes(clashKing.outcome) ? 'failed' : undefined;
  const outcome: SyncOutcome =
    coc === 'failed' || ckBad === 'failed' || !active.ok
      ? 'failed'
      : coc === 'restored' || ckBad === 'restored'
        ? 'restored'
        : coc === 'updated' || clashKing.outcome === 'updated'
          ? 'updated'
          : 'up-to-date';
  return { outcome, coc, clashKing, snapshot, crossCheck };
}
