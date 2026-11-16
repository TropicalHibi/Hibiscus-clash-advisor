// Real (Node) side effects for the refresh and sync logic. Process runners are injectable so the
// wiring — timeouts, npm errors, exit codes — can be tested without npm or the network.
import { execSync as realExecSync, spawnSync as realSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { checkHeroCaps, checkLevels, checkMergeConsumption } from '../../src/data/validate';
import { loadGameDataFresh } from '../../src/data/loadNode';
import { toSnapshot, type DataChangesFile, type Snapshot } from '../../src/data/snapshot';
import { isoDate, recordSnapshot, type SnapshotIO } from './snapshots';
import { refresh, type RefreshDeps, type RefreshState } from './refresh';
import { majorOf, newestOf, type DataCheck, type SyncDeps } from './sync';

type ExecSync = (cmd: string, opts: { cwd: string; encoding?: 'utf8'; timeout?: number; stdio?: unknown }) => string | Buffer;
type SpawnSync = (cmd: string, opts: Record<string, unknown>) => { status: number | null; stderr?: string | null; error?: Error };

export interface NodeOpts {
  root: string;
  execSync?: ExecSync;
  spawnSync?: SpawnSync;
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
      if (process.env.COC_API_TOKEN?.trim()) return true;
      try {
        return Boolean(parseDotenv(fs.readFileSync(path.join(o.root, '.env'))).COC_API_TOKEN?.trim());
      } catch {
        return false;
      }
    },
    runMeta: () => {
      // stdout (progress + summary) is shown live; stderr is captured for the one-line warning.
      const r = spawn('npm run meta', { cwd: o.root, shell: true, encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'], timeout: 30 * 60_000 });
      if (r.error) throw r.error;
      return { code: r.status ?? 1, stderr: r.stderr ?? '' };
    },
    log: o.log ?? ((line) => console.log(line)),
  };
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
    writeChanges: (f: DataChangesFile) => fs.writeFileSync(path.join(root, 'public', 'data-changes.json'), JSON.stringify(f, null, 2) + '\n'),
  };
}

export function nodeSyncDeps(o: NodeOpts): SyncDeps {
  const exec = o.execSync ?? (realExecSync as unknown as ExecSync);
  const log = o.log ?? ((line: string) => console.log(line));
  return {
    // Reads the installed package fresh (after an install the cached copy would be stale).
    snapshot: () => {
      recordSnapshot(nodeSnapshotIO(o.root), toSnapshot(loadGameDataFresh(), isoDate(new Date())), log);
    },
    ...stateIO(o.root),
    installedVersion: () => installedVersion(o.root),
    latestInMajor: (major) => npmLatestInMajor(o.root, major, exec),
    install: (version) => {
      exec(`npm install ${PKG_NAME}@${version}`, { cwd: o.root, stdio: 'inherit' });
    },
    check: checkInstalledData,
    log: o.log ?? ((line) => console.log(line)),
  };
}
