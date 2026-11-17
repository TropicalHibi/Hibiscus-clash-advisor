// Real (Node) side effects for the refresh and sync logic. Process runners are injectable so the
// wiring — timeouts, npm errors, exit codes — can be tested without npm or the network.
import { execFileSync as realExecFileSync, execSync as realExecSync, spawnSync as realSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { checkHeroCaps, checkLevels, checkMergeConsumption } from '../../src/data/validate';
import { CK_DIR, loadCocDataFresh, loadGameDataFresh, normalizeClashKingNode, PROJECT_ROOT, readClashKing } from '../../src/data/loadNode';
import { crossCheck, crossCheckLines } from '../../src/data/crossCheck';
import { backupWarning, clashKingVersion, dataSourceLabel } from '../../src/data/source';
import { hasCredentials } from './auth';
import { toSnapshot, type DataChangesFile, type Snapshot } from '../../src/data/snapshot';
import { isoDate, recordSnapshot, type SnapshotIO } from './snapshots';
import { refresh, type RefreshDeps, type RefreshState } from './refresh';
import { githubHeaders, rawUrl, resolveLatestWith, type ClashKingDeps } from './clashking';
import { majorOf, newestOf, type DataCheck, type FullSyncDeps, type SyncDeps } from './sync';

type ExecSync = (cmd: string, opts: { cwd: string; encoding?: 'utf8'; timeout?: number; stdio?: unknown }) => string | Buffer;
type SpawnSync = (cmd: string, opts: Record<string, unknown>) => { status: number | null; stderr?: string | null; error?: Error };

export interface NodeOpts {
  root: string;
  execSync?: ExecSync;
  spawnSync?: SpawnSync;
  /** Runs `node -e` for the GitHub fetches (ClashKing); tests inject a fake, so they never touch the network. */
  execFile?: ExecFileSync;
  log?: (line: string) => void;
}

const PKG_NAME = 'clash-of-clans-data';

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function stateIO(root: string) {
  const file = path.join(root, 'data', 'refresh-state.json');
  return {
    readState: (): RefreshState => readJson<RefreshState>(file) ?? {},
    writeState: (s: RefreshState) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
    },
  };
}

const installedVersion = (root: string) => readJson<{ version?: string }>(path.join(root, 'node_modules', PKG_NAME, 'package.json'))?.version;

/** Newest published clash-of-clans-data below the next major. Throws a short message when npm fails. */
export function npmLatestInMajor(root: string, major: number, exec: ExecSync = realExecSync as unknown as ExecSync): string {
  try {
    const out = exec(`npm view "${PKG_NAME}@<${major + 1}.0.0" version --json --fetch-retries=0 --fetch-timeout=10000`, {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return newestOf(String(out));
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? '');
    const code = /npm error code (\S+)/.exec(stderr)?.[1] ?? ((e as { code?: string }).code === 'ETIMEDOUT' ? 'timed out' : undefined);
    throw new Error(`npm registry unreachable${code ? `: ${code}` : ''}`);
  }
}

export function nodeRefreshDeps(o: NodeOpts): RefreshDeps {
  const exec = o.execSync ?? (realExecSync as unknown as ExecSync);
  const spawn = o.spawnSync ?? (realSpawnSync as unknown as SpawnSync);
  return {
    now: () => Date.now(),
    ...stateIO(o.root),
    installedVersion: () => installedVersion(o.root),
    latestVersion: () => npmLatestInMajor(o.root, majorOf(installedVersion(o.root)), exec),
    runSync: () => {
      exec('npm run sync', { cwd: o.root, stdio: 'inherit', timeout: 10 * 60_000 });
    },
    metaGeneratedAt: () => {
      const t = Date.parse(readJson<{ generatedAt?: string | null }>(path.join(o.root, 'public', 'meta.json'))?.generatedAt ?? '');
      return Number.isFinite(t) ? t : undefined;
    },
    hasToken: () => {
      if (hasCredentials(process.env)) return true;
      try {
        return hasCredentials(parseDotenv(fs.readFileSync(path.join(o.root, '.env'))));
      } catch {
        return false;
      }
    },
    gitPull: () => nodeGitPull(o.root, exec),
    installDeps: () => {
      exec('npm install --no-audit --no-fund', { cwd: o.root, stdio: 'inherit', timeout: 10 * 60_000 });
    },
    syncOffline: () => {
      exec('npm run sync -- --offline', { cwd: o.root, stdio: 'inherit', timeout: 5 * 60_000 });
    },
    clashKingPinned: () => readClashKing(path.join(o.root, 'data', 'clashking'))?.pin.commit,
    clashKingLatest: () => {
      const r = resolveLatestWith((url, headers) => fetchTextSync(url, headers, o.execFile), githubHeaders());
      return { commit: r.commit, version: clashKingVersion(r) };
    },
    backupWarning: () => (readClashKing(path.join(o.root, 'data', 'clashking')) ? undefined : backupWarning('data/clashking/static_data.json is missing or unreadable')),
    runMeta: () => {
      // stdout (progress + summary) is shown live; stderr is captured for the one-line warning.
      const r = spawn('npm run meta', { cwd: o.root, shell: true, encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'], timeout: 30 * 60_000 });
      if (r.error) throw r.error;
      return { code: r.status ?? 1, stderr: r.stderr ?? '' };
    },
    log: o.log ?? ((line) => console.log(line)),
  };
}

/**
 * `git pull --ff-only` with a timeout and no credential prompt. Returns how many commits came in and
 * whether package.json / package-lock.json changed. Throws with git's first stderr line on failure.
 */
export function nodeGitPull(root: string, exec: ExecSync = realExecSync as unknown as ExecSync): { pulled: number; lockChanged: boolean } {
  const git = (cmd: string, timeout = 10_000) =>
    String(exec(`git ${cmd}`, { cwd: root, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } } as never)).trim();
  try {
    const before = git('rev-parse HEAD');
    git('pull --ff-only', 30_000);
    const after = git('rev-parse HEAD');
    if (before === after) return { pulled: 0, lockChanged: false };
    const pulled = Number(git(`rev-list --count ${before}..${after}`)) || 1;
    const lockChanged = git(`diff --name-only ${before} ${after} -- package.json package-lock.json`) !== '';
    return { pulled, lockChanged };
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? '');
    const line = stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^hint:/i.test(l));
    throw new Error(line ?? ((e as { code?: string }).code === 'ETIMEDOUT' ? 'timed out' : (e as Error).message));
  }
}

/** Never throws: `npm run dev` must always start (SPEC §9a). */
export function runRefresh(deps: RefreshDeps): void {
  try {
    refresh(deps);
  } catch (e) {
    deps.log(`[refresh] warning: ${(e as Error).message}; starting the site anyway.`);
  }
}

/** Loads the installed data from disk (no cache) and validates it. */
export function checkInstalledData(): DataCheck {
  try {
    const data = loadGameDataFresh();
    if (!data.maxTH || !data.items.size) return { ok: false, error: 'no Town Hall levels / items in the data', warnings: [] };
    const levelErrors = checkLevels(data);
    if (levelErrors.length) return { ok: false, error: levelErrors[0].message, warnings: [] };
    const warnings = [...data.warnings, ...[...checkMergeConsumption(data), ...checkHeroCaps(data)].map((i) => `${i.check}: ${i.message}`)];
    return { ok: true, warnings, maxTH: data.maxTH };
  } catch (e) {
    return { ok: false, error: (e as Error).message, warnings: [] };
  }
}

/** Snapshot files in data/snapshots, data-changes.json in public/. */
export function nodeSnapshotIO(root: string): SnapshotIO {
  const dir = path.join(root, 'data', 'snapshots');
  return {
    list: () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []),
    read: (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Snapshot,
    write: (name, s) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), JSON.stringify(s) + '\n');
    },
    remove: (name) => fs.rmSync(path.join(dir, name), { force: true }),
    writeChanges: (f: DataChangesFile) => {
      const file = path.join(root, 'public', 'data-changes.json');
      // Same diff already saved (e.g. by the daily Action, then again locally after git pull): keep the file,
      // so only the date wouldn't differ and the working tree stays clean.
      const old = readJson<DataChangesFile>(file);
      if (old && old.version === f.version && old.previousVersion === f.previousVersion && JSON.stringify(old.changes) === JSON.stringify(f.changes)) return;
      fs.writeFileSync(file, JSON.stringify(f, null, 2) + '\n');
    },
  };
}

export function nodeSyncDeps(o: NodeOpts): SyncDeps {
  const exec = o.execSync ?? (realExecSync as unknown as ExecSync);
  const log = o.log ?? ((line: string) => console.log(line));
  return {
    // Reads the installed package fresh (after an install the cached copy would be stale).
    snapshot: () => recordSnapshot(nodeSnapshotIO(o.root), toSnapshot(loadGameDataFresh(), isoDate(new Date())), log),
    ...stateIO(o.root),
    installedVersion: () => installedVersion(o.root),
    latestInMajor: (major) => npmLatestInMajor(o.root, major, exec),
    install: (version) => {
      // A data-only package: no install scripts needed (REVIEW-2 #13; the daily Action installs with --ignore-scripts too).
      exec(`npm install --ignore-scripts ${PKG_NAME}@${version}`, { cwd: o.root, stdio: 'inherit' });
    },
    check: checkInstalledData,
    log: o.log ?? ((line) => console.log(line)),
  };
}

// ── ClashKing (SPEC §3.1, §9) ──

type ExecFileSync = (file: string, args: string[], opts: Record<string, unknown>) => string | Buffer;

/**
 * Synchronous HTTP GET via a child `node` process using fetch (same on Windows and Linux; the sync code is
 * synchronous like its npm calls). The URL and headers go in through the environment and are never printed.
 */
export function fetchTextSync(url: string, headers: Record<string, string>, execFile: ExecFileSync = realExecFileSync as unknown as ExecFileSync): { status: number; text: string } {
  const script =
    'fetch(process.env.CK_URL,{headers:JSON.parse(process.env.CK_HEADERS),signal:AbortSignal.timeout(30000)})' +
    '.then(async r=>process.stdout.write(JSON.stringify({status:r.status,text:await r.text()})))' +
    '.catch(e=>{process.stderr.write(String(e&&e.message||e));process.exit(1)})';
  try {
    const out = execFile(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CK_URL: url, CK_HEADERS: JSON.stringify(headers) },
    });
    return JSON.parse(String(out)) as { status: number; text: string };
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? '').trim();
    throw new Error(`network error (${(stderr || (e as Error).message).split(/\r?\n/)[0].slice(0, 120)})`);
  }
}

export function nodeClashKingDeps(o: NodeOpts & { dir?: string }): ClashKingDeps {
  const dir = o.dir ?? (o.root === PROJECT_ROOT ? CK_DIR : path.join(o.root, 'data', 'clashking'));
  const get = (url: string, headers: Record<string, string>) => fetchTextSync(url, headers, o.execFile);
  const log = o.log ?? ((line: string) => console.log(line));
  return {
    readPinned: () => readClashKing(dir),
    resolveLatest: () => resolveLatestWith(get, githubHeaders()),
    download: (commit) => {
      // raw.githubusercontent.com never gets the token.
      const r = get(rawUrl(commit), { 'User-Agent': 'hibiscus-clash-advisor-sync' });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return r.text;
    },
    normalize: (raw, version) => normalizeClashKingNode(raw, version),
    write: (raw, pin) => {
      fs.mkdirSync(dir, { recursive: true });
      // One space indent: reviewable git diffs between versions without doubling the file size.
      fs.writeFileSync(path.join(dir, 'static_data.json'), JSON.stringify(raw, null, 1) + '\n');
      fs.writeFileSync(path.join(dir, 'pin.json'), JSON.stringify(pin, null, 2) + '\n');
    },
    ...stateIO(o.root),
    snapshot: () => recordSnapshot(nodeSnapshotIO(o.root), toSnapshot(loadGameDataFresh(), isoDate(new Date())), log),
    now: () => new Date(),
    log,
  };
}

/** clash-of-clans-data as the backup: does it load? (Its own merge / hero-cap findings aren't repeated.) */
export function checkCocBackup(): DataCheck {
  try {
    const data = loadCocDataFresh();
    if (!data.maxTH || !data.items.size) return { ok: false, error: 'no Town Hall levels / items in the data', warnings: [] };
    const levelErrors = checkLevels(data);
    if (levelErrors.length) return { ok: false, error: levelErrors[0].message, warnings: [] };
    return { ok: true, warnings: [], maxTH: data.maxTH };
  } catch (e) {
    return { ok: false, error: (e as Error).message, warnings: [] };
  }
}

/** ClashKing vs clash-of-clans-data report lines; empty when either side can't be loaded. */
export function nodeCrossCheck(max = 60): string[] {
  const ck = readClashKing();
  if (!ck) return ['Cross-check skipped: no pinned ClashKing copy.'];
  let coc;
  try {
    coc = loadCocDataFresh();
  } catch (e) {
    return [`Cross-check skipped: clash-of-clans-data can't be loaded (${(e as Error).message}).`];
  }
  return crossCheckLines(crossCheck(normalizeClashKingNode(ck.raw, ck.pin.version), coc), max);
}

export function nodeFullSyncDeps(o: NodeOpts): FullSyncDeps {
  const log = o.log ?? ((line: string) => console.log(line));
  const coc = nodeSyncDeps({ ...o, log });
  return {
    coc: { ...coc, check: checkCocBackup },
    clashKing: nodeClashKingDeps({ ...o, log }),
    activeCheck: () => {
      const c = checkInstalledData();
      let source: string | undefined;
      try {
        source = dataSourceLabel(loadGameDataFresh());
      } catch {
        source = undefined;
      }
      return { ...c, source };
    },
    snapshot: coc.snapshot,
    crossCheck: () => nodeCrossCheck(),
    log,
  };
}
