// Pre-dev refresh (SPEC §9a): keep game data and the Legend I meta fresh without an OS scheduler.
// The decision logic lives here with injected side effects so it can be tested without network.

export const REFRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RefreshState {
  /** When npm was last asked (successfully) for the newest clash-of-clans-data version. */
  lastDataCheck?: number;
  /** Newest version that loaded and validated (written by `npm run sync`). */
  lastGoodDataVersion?: string;
  /** A version that failed to load; sync restored the last good one. Warned about on every start until fixed. */
  dataFailure?: { version: string; reason: string; at: number };
}

export interface RefreshDeps {
  now(): number;
  readState(): RefreshState;
  writeState(s: RefreshState): void;
  /** Installed clash-of-clans-data version, or undefined if not installed. */
  installedVersion(): string | undefined;
  /** Newest published version within the installed major (npm view). Throws when offline. */
  latestVersion(): string;
  /** Runs the full `npm run sync`. Throws on failure. */
  runSync(): void;
  /** public/meta.json generatedAt in ms, or undefined if missing / unreadable / never generated. */
  metaGeneratedAt(): number | undefined;
  /** True when COC_API_TOKEN is set (the value is never returned or printed). */
  hasToken(): boolean;
  /** Runs `npm run meta`; returns its exit code and captured stderr. May throw. */
  runMeta(): { code: number; stderr: string };
  log(line: string): void;
}

export type DataOutcome = 'checked-recently' | 'up-to-date' | 'synced' | 'known-bad' | 'failed';
export type MetaOutcome = 'fresh' | 'no-token' | 'updated' | 'updated-with-failures' | 'failed';

/** Numeric dotted-version compare ("0.19.1" < "0.20.0"); pre-release tags are ignored. */
export function isNewerVersion(latest: string, installed: string | undefined): boolean {
  if (!installed) return true;
  const parse = (v: string) => v.trim().replace(/^v/, '').split(/[-+]/)[0].split('.').map((x) => Number(x) || 0);
  const a = parse(latest);
  const b = parse(installed);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** First meaningful line of an error / stderr, for a one-line warning. */
export function oneLine(text: string, fallback: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^npm (notice|warn|error)\b/i.test(l) && !/^>/.test(l));
  return (line ?? fallback).slice(0, 200);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function refreshGameData(d: RefreshDeps): DataOutcome {
  const now = d.now();
  const state = d.readState();
  const bad = state.dataFailure;
  // Every start, until a sync succeeds: the site is running on the last known-good data.
  if (bad)
    d.log(
      `[refresh] warning: clash-of-clans-data ${bad.version} can't be used (${oneLine(bad.reason, 'load failed')}); staying on ${d.installedVersion() ?? 'the previous version'}. Fix config/merges.yaml or the code, then run npm run sync.`,
    );
  if (state.lastDataCheck !== undefined && now - state.lastDataCheck < REFRESH_MAX_AGE_MS) return 'checked-recently';
  let latest: string;
  try {
    latest = d.latestVersion().trim();
    if (!latest) throw new Error('npm returned no version');
  } catch (e) {
    d.log(`[refresh] warning: game-data check skipped (${oneLine(msg(e), 'npm view failed')}); starting the site anyway.`);
    return 'failed';
  }
  const installed = d.installedVersion();
  if (bad && latest === bad.version && isNewerVersion(latest, installed)) {
    // Known to fail: don't reinstall it on every start. `npm run sync` by hand retries it after a fix.
    d.writeState({ ...state, lastDataCheck: now });
    return 'known-bad';
  }
  if (!isNewerVersion(latest, installed)) {
    d.writeState({ ...state, lastDataCheck: now });
    d.log(`[refresh] game data up to date (clash-of-clans-data ${installed}).`);
    return 'up-to-date';
  }
  d.log(`[refresh] clash-of-clans-data ${latest} is out (installed: ${installed ?? 'none'}); running npm run sync…`);
  try {
    d.runSync();
  } catch (e) {
    // State is not saved, so the next `npm run dev` tries again.
    d.log(`[refresh] warning: sync failed (${oneLine(msg(e), 'npm run sync failed')}); starting the site anyway.`);
    return 'failed';
  }
  d.writeState({ ...d.readState(), lastDataCheck: now });
  return 'synced';
}

export function refreshMeta(d: RefreshDeps): MetaOutcome {
  const gen = d.metaGeneratedAt();
  if (gen !== undefined && d.now() - gen < REFRESH_MAX_AGE_MS) return 'fresh';
  if (!d.hasToken()) {
    d.log('[refresh] warning: public/meta.json is over 24h old but .env has no COC_API_TOKEN; skipping npm run meta.');
    return 'no-token';
  }
  d.log(`[refresh] public/meta.json is ${gen === undefined ? 'missing' : 'over 24h old'}; running npm run meta…`);
  let res: { code: number; stderr: string };
  try {
    res = d.runMeta();
  } catch (e) {
    d.log(`[refresh] warning: meta run failed (${oneLine(msg(e), 'npm run meta failed')}); starting the site anyway.`);
    return 'failed';
  }
  if (res.code === 0) return 'updated';
  if (res.code === 2) {
    // scripts/meta.ts exits 2 when meta.json was written but some players could not be fetched.
    d.log('[refresh] warning: meta.json updated, but some players failed; the next run retries them.');
    return 'updated-with-failures';
  }
  const hint = /\b403\b/.test(res.stderr) ? ' (403: the API key is locked to a different IP)' : '';
  d.log(`[refresh] warning: meta run failed: ${oneLine(res.stderr, `exit code ${res.code}`)}${hint}; starting the site anyway.`);
  return 'failed';
}

/** Never throws: every failure becomes a one-line warning so `npm run dev` always starts. */
export function refresh(d: RefreshDeps): { data: DataOutcome; meta: MetaOutcome } {
  let data: DataOutcome = 'failed';
  let meta: MetaOutcome = 'failed';
  try {
    data = refreshGameData(d);
  } catch (e) {
    d.log(`[refresh] warning: game-data refresh failed (${oneLine(msg(e), 'unknown error')}); starting the site anyway.`);
  }
  try {
    meta = refreshMeta(d);
  } catch (e) {
    d.log(`[refresh] warning: meta refresh failed (${oneLine(msg(e), 'unknown error')}); starting the site anyway.`);
  }
  return { data, meta };
}
