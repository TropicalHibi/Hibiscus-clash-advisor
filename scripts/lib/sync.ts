// `npm run sync` logic (SPEC §9): update clash-of-clans-data within the current major, validate it,
// and keep the last known-good version. Side effects are injected so every branch can be tested.
import { isNewerVersion, type RefreshState } from './refresh';

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
  log(line: string): void;
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
}

/**
 * Update within the current major. A new version that fails to load is replaced by the last known-good
 * version, and the failure is recorded in refresh-state.json so `npm run dev` warns on every start.
 */
export function syncData(d: SyncDeps): SyncOutcome {
  const before = d.installedVersion();
  const state = d.readState();
  d.log(`clash-of-clans-data installed: ${before ?? 'none'}`);

  const current = before ? d.check() : { ok: false, error: 'not installed', warnings: [] };
  let lastGood = state.lastGoodDataVersion;
  if (current.ok && before) lastGood = before;

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
