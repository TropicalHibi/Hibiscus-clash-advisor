// Pre-dev refresh (SPEC §9a): keep game data and the Legend I meta fresh without an OS scheduler.
// The decision logic lives here with injected side effects so it can be tested without network.

export const REFRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Printed after a local meta pull that wrote public/meta.json. The daily Meta Action (SPEC §8.4) normally
 * keeps the live site fresh; a local run usually means the Action missed a day.
 */
export const PUSH_META_REMINDER =
  '[refresh] meta.json updated locally (the daily Meta Action normally does this). Run npm run push-meta only if you want this copy on the live site now.';

export interface RefreshState {
  /** When npm was last asked (successfully) for the newest clash-of-clans-data version. */
  lastDataCheck?: number;
  /** Newest version that loaded and validated (written by `npm run sync`). */
  lastGoodDataVersion?: string;
  /** A version that failed to load; sync restored the last good one. Warned about on every start until fixed. */
  dataFailure?: { version: string; reason: string; at: number };
  /** Newest ClashKing version that validated and was pinned (SPEC §9). */
  lastGoodClashKing?: string;
  /** A ClashKing file that failed to load / validate; the pinned copy was kept. Warned about until a sync succeeds. */
  clashKingFailure?: { version: string; reason: string; at: number };
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
  /** True when COC_DEV_EMAIL + COC_DEV_PASSWORD or COC_API_TOKEN are set (values never returned or printed). */
  hasToken(): boolean;
  /** Runs `npm run meta`; returns its exit code and captured stderr. May throw. */
  runMeta(): { code: number; stderr: string };
  /**
   * `git pull --ff-only` (SPEC §9a step 0), so the local copy has what the daily data-update Action
   * committed. Returns whether anything came in and whether package.json / package-lock.json changed.
   * Throws (one-line message) when it can't fast-forward: uncommitted changes, diverged, offline, no repo.
   */
  gitPull?(): { pulled: number; lockChanged: boolean };
  /** `npm install` (after a pull changed the lockfile) so node_modules matches the committed data version. */
  installDeps?(): void;
  /** `npm run sync -- --offline`: validate + snapshot the installed data (no npm registry). */
  syncOffline?(): void;
  /** Pinned ClashKing commit (data/clashking/pin.json), or undefined when nothing is pinned. */
  clashKingPinned?(): string | undefined;
  /** Latest ClashKing release (or main) commit and version label. Throws when GitHub can't be reached. */
  clashKingLatest?(): { commit: string; version: string };
  /** The backup warning when the site would run on clash-of-clans-data (no usable ClashKing copy). */
  backupWarning?(): string | undefined;
  log(line: string): void;
}

export type GitOutcome = 'skipped' | 'up-to-date' | 'pulled' | 'pulled-deps' | 'failed';

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

/**
 * Step 0: fast-forward to origin so the data check sees what the daily Action committed. A pull that
 * changes the lockfile also runs `npm install` (node_modules must match) and an offline sync (local
 * snapshot for the new version). Any failure is a one-line warning and the refresh continues.
 */
export function refreshGit(d: RefreshDeps): GitOutcome {
  if (!d.gitPull) return 'skipped';
  let r: { pulled: number; lockChanged: boolean };
  try {
    r = d.gitPull();
  } catch (e) {
    d.log(`[refresh] warning: git pull --ff-only failed (${oneLine(msg(e), 'git pull failed')}); continuing with the local copy.`);
    return 'failed';
  }
  if (!r.pulled) return 'up-to-date';
  d.log(`[refresh] pulled ${r.pulled} new commit${r.pulled === 1 ? '' : 's'} from origin.`);
  if (!r.lockChanged || !d.installDeps) return 'pulled';
  try {
    d.installDeps();
    d.log('[refresh] package-lock.json changed (e.g. a data update from the daily Action): npm install done.');
    d.syncOffline?.();
  } catch (e) {
    d.log(`[refresh] warning: npm install after the pull failed (${oneLine(msg(e), 'npm install failed')}); run npm install by hand.`);
    return 'failed';
  }
  return 'pulled-deps';
}

export function refreshGameData(d: RefreshDeps): DataOutcome {
  const now = d.now();
  const state = d.readState();
  const bad = state.dataFailure;
  // Every start, until a sync succeeds: the site is running on the last known-good data.
  if (bad)
    d.log(
      `[refresh] warning: clash-of-clans-data ${bad.version} can't be used (${oneLine(bad.reason, 'load failed')}); staying on ${d.installedVersion() ?? 'the previous version'}. Fix config/merges.yaml or the code, then run npm run sync.`,
    );
  const ckBad = state.clashKingFailure;
  if (ckBad)
    d.log(`[refresh] warning: ClashKing ${ckBad.version} can't be used (${oneLine(ckBad.reason, 'load failed')}); staying on the pinned known-good copy. Run npm run sync after a fix.`);
  try {
    const backup = d.backupWarning?.();
    if (backup) d.log(`[refresh] warning: ${backup}`);
  } catch {
    // the check itself failing is not worth a second warning
  }
  if (state.lastDataCheck !== undefined && now - state.lastDataCheck < REFRESH_MAX_AGE_MS) return 'checked-recently';
  // ClashKing (SPEC §9a step 1): a newer release than the pinned commit → full sync. Optional dependency.
  let ckReason: string | undefined;
  let ckKnownBad = false;
  if (d.clashKingLatest) {
    try {
      const latest = d.clashKingLatest();
      const pinned = d.clashKingPinned?.();
      if (latest.commit !== pinned) {
        if (ckBad && latest.version === ckBad.version) ckKnownBad = true; // don't retry a known-bad file on every start
        else ckReason = `ClashKing ${latest.version} is out (pinned: ${pinned ? pinned.slice(0, 7) : 'none'})`;
      }
    } catch (e) {
      d.log(`[refresh] warning: ClashKing check skipped (${oneLine(msg(e), 'GitHub unreachable')}); starting the site anyway.`);
    }
  }
  let latest: string;
  try {
    latest = d.latestVersion().trim();
    if (!latest) throw new Error('npm returned no version');
  } catch (e) {
    d.log(`[refresh] warning: game-data check skipped (${oneLine(msg(e), 'npm view failed')}); starting the site anyway.`);
    if (!ckReason) return 'failed';
    latest = d.installedVersion() ?? '';
  }
  const installed = d.installedVersion();
  const npmKnownBad = !!(bad && latest === bad.version && isNewerVersion(latest, installed));
  const npmNew = !npmKnownBad && isNewerVersion(latest, installed);
  if (!npmNew && !ckReason) {
    d.writeState({ ...state, lastDataCheck: now });
    // Known to fail: don't reinstall it on every start. `npm run sync` by hand retries it after a fix.
    if (npmKnownBad || ckKnownBad) return 'known-bad';
    d.log(`[refresh] game data up to date (${d.clashKingPinned?.() ? 'ClashKing pinned, ' : ''}clash-of-clans-data ${installed}).`);
    return 'up-to-date';
  }
  if (npmNew) d.log(`[refresh] clash-of-clans-data ${latest} is out (installed: ${installed ?? 'none'}); running npm run sync…`);
  else d.log(`[refresh] ${ckReason}; running npm run sync…`);
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

/**
 * Meta: skipped while public/meta.json (normally the copy the daily Action committed, pulled in step 0)
 * is under 24h old. Older means the Action missed a day: run `npm run meta` locally if credentials exist.
 */
export function refreshMeta(d: RefreshDeps): MetaOutcome {
  const gen = d.metaGeneratedAt();
  if (gen !== undefined && d.now() - gen < REFRESH_MAX_AGE_MS) return 'fresh';
  if (!d.hasToken()) {
    d.log('[refresh] warning: public/meta.json is over 24h old (did the daily Meta Action fail?) and .env has no COC_DEV_EMAIL/COC_DEV_PASSWORD or COC_API_TOKEN; skipping npm run meta.');
    return 'no-token';
  }
  d.log(`[refresh] public/meta.json is ${gen === undefined ? 'missing' : 'over 24h old (the daily Meta Action missed it)'}; running npm run meta…`);
  let res: { code: number; stderr: string };
  try {
    res = d.runMeta();
  } catch (e) {
    d.log(`[refresh] warning: meta run failed (${oneLine(msg(e), 'npm run meta failed')}); starting the site anyway.`);
    return 'failed';
  }
  if (res.code === 0) {
    d.log(PUSH_META_REMINDER);
    return 'updated';
  }
  if (res.code === 2) {
    // scripts/meta.ts exits 2 when meta.json was written but some players could not be fetched.
    d.log('[refresh] warning: meta.json updated, but some players failed; the next run retries them.');
    d.log(PUSH_META_REMINDER);
    return 'updated-with-failures';
  }
  const hint = /\b403\b/.test(res.stderr) ? ' (403: the API key is locked to a different IP)' : '';
  d.log(`[refresh] warning: meta run failed: ${oneLine(res.stderr, `exit code ${res.code}`)}${hint}; starting the site anyway.`);
  return 'failed';
}

/** Never throws: every failure becomes a one-line warning so `npm run dev` always starts. */
export function refresh(d: RefreshDeps): { git: GitOutcome; data: DataOutcome; meta: MetaOutcome } {
  let git: GitOutcome = 'failed';
  let data: DataOutcome = 'failed';
  let meta: MetaOutcome = 'failed';
  try {
    git = refreshGit(d);
  } catch (e) {
    d.log(`[refresh] warning: git pull step failed (${oneLine(msg(e), 'unknown error')}); continuing.`);
  }
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
  return { git, data, meta };
}
