// Daily data-update workflow (SPEC §9b) against a fake npm registry: no newer version, a clean update,
// a merge missing from merges.yaml, broken data, npm failures; the issue text; the predev git pull; and
// the workflow file itself.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commitMessage, issueBody, issueTitle, runDataUpdate, type DataUpdateDeps } from '../scripts/lib/dataUpdate';
import { nodeGitPull } from '../scripts/lib/nodeDeps';
import { refreshGit, type RefreshDeps } from '../scripts/lib/refresh';
import { recordSnapshot, type SnapshotIO } from '../scripts/lib/snapshots';
import { syncData, type DataCheck, type SyncDeps } from '../scripts/lib/sync';
import { toSnapshot, type DataChangesFile, type Snapshot } from '../src/data/snapshot';
import type { GameData } from '../src/data/types';
import { checkLevels, describeMissingMerges, explainMissingMerges } from '../src/data/validate';
import { cocData, data, modifiedData, rawItem } from './helpers';
import { normalizeEol, workflowCode } from './workflow';

// ── fake registry ──
const cannon = data.byId.get('cannon')!;
const cannonTop = cannon.levels[cannon.levels.length - 1];
/** "0.20.0": Cannon's top level is cheaper and faster. */
const nextData = modifiedData((raw) => {
  const l = rawItem(raw, 'cannon').levels.find((x: any) => x.level === cannonTop.level);
  l.build_cost = cannonTop.cost - 1_000_000;
  l.build_time = 2 * 86400;
});
/**
 * "0.20.0" with a merge the recipes don't know. ClashKing carries every merge itself, so this can only happen
 * on the clash-of-clans-data backup (built-in recipes) or through a bad override: here, the backup without
 * the Super Wizard Tower recipe.
 */
const nextDataMissingMerge = cocData(() => {}, { dropRecipes: ['super-wizard-tower'] });

function memIO(initial: Record<string, Snapshot> = {}) {
  const files = new Map(Object.entries(initial));
  let changes: DataChangesFile | undefined;
  const io: SnapshotIO = {
    list: () => [...files.keys()],
    read: (n) => files.get(n)!,
    write: (n, s) => void files.set(n, s),
    remove: (n) => void files.delete(n),
    writeChanges: (f) => void (changes = f),
  };
  return { io, files, changes: () => changes };
}

/** A fake npm registry + installer. `versions` maps version → its data (or an Error = can't be loaded). */
function fakeRegistry(o: { latest?: string | Error; next?: GameData | Error; installFails?: boolean; io?: SnapshotIO } = {}) {
  const versions: Record<string, GameData | Error> = { '0.19.1': data, '0.20.0': o.next ?? nextData };
  let installed = '0.19.1';
  const calls: string[] = [];
  const logs: string[] = [];
  const io = o.io ?? memIO().io;
  const sync: SyncDeps = {
    installedVersion: () => installed,
    latestInMajor: (major) => {
      calls.push(`view <${major + 1}`);
      if (o.latest instanceof Error) throw o.latest;
      return o.latest ?? '0.19.1';
    },
    install: (v) => {
      calls.push(`install ${v}`);
      if (o.installFails && v !== '0.19.1') throw new Error('npm ERR! 404 Not Found');
      installed = v;
    },
    check: (): DataCheck => {
      const d = versions[installed];
      if (d instanceof Error) return { ok: false, error: d.message, warnings: [] };
      const lv = checkLevels(d);
      return lv.length ? { ok: false, error: lv[0].message, warnings: [] } : { ok: true, warnings: [], maxTH: d.maxTH };
    },
    readState: () => ({}),
    writeState: () => {},
    snapshot: () => recordSnapshot(io, { ...toSnapshot(versions[installed] as GameData, '2026-11-20'), version: installed }, (l) => logs.push(l)),
    log: (l) => logs.push(l),
  };
  const deps: DataUpdateDeps = { sync, loadData: () => versions[installed] as GameData };
  return { deps, calls, logs, installed: () => installed };
}

describe('daily data update (fake npm registry)', () => {
  it('no newer version: exits cleanly, installs nothing, writes no diff', () => {
    const m = memIO();
    const f = fakeRegistry({ io: m.io });
    const r = runDataUpdate(f.deps);
    expect(r).toMatchObject({ status: 'none', from: '0.19.1', to: '0.19.1', changes: [] });
    expect(f.calls).toEqual(['view <1']);
    expect(m.changes()).toBeUndefined();
  });

  it('newer and valid: snapshot before, install, diff, data-changes.json, commit message', () => {
    const m = memIO(); // fresh CI checkout: data/snapshots/ is empty
    const f = fakeRegistry({ latest: '0.20.0', io: m.io });
    const r = runDataUpdate(f.deps);
    expect(r.status).toBe('updated');
    expect(f.calls).toEqual(['view <1', 'install 0.20.0']);
    expect([...m.files.keys()].sort()).toEqual(['2026-11-20_0.19.1.json', '2026-11-20_0.20.0.json']); // before + after
    const texts = r.changes.map((c) => c.text);
    expect(texts.some((t) => t.startsWith(`Cannon ${cannonTop.level}: `) && t.endsWith(' → 2d'))).toBe(true);
    expect(m.changes()).toMatchObject({ version: '0.20.0', previousVersion: '0.19.1' });
    expect(m.changes()!.changes).toEqual(r.changes);
    expect(r.commitMessage).toBe(`data: clash-of-clans-data 0.19.1 → 0.20.0 (${r.changes.length} changes)`);
    expect(commitMessage('0.19.1', '0.20.0', 1)).toBe('data: clash-of-clans-data 0.19.1 → 0.20.0 (1 change)');
  });

  it('gives the same diff as a local `npm run sync` (which already has the old snapshot)', () => {
    const ci = memIO();
    runDataUpdate(fakeRegistry({ latest: '0.20.0', io: ci.io }).deps);
    const local = memIO({ '2026-11-16_0.19.1.json': { ...toSnapshot(data, '2026-11-16'), version: '0.19.1' } });
    const f = fakeRegistry({ latest: '0.20.0', io: local.io });
    expect(syncData(f.deps.sync)).toBe('updated');
    expect(local.changes()!.changes).toEqual(ci.changes()!.changes);
  });

  it('a merge missing from merges.yaml fails the update and names the merged defense and its sources', () => {
    const f = fakeRegistry({ latest: '0.20.0', next: nextDataMissingMerge });
    const r = runDataUpdate(f.deps);
    expect(r).toMatchObject({ status: 'failed', failedStep: 'validation: config/merges.yaml', to: '0.20.0' });
    expect(r.missingMerges).toHaveLength(1);
    expect(r.missingMerges[0]).toContain('most likely: Super Wizard Tower (super-wizard-tower, dataId 1000102) = 2× Wizard Tower');
    expect(r.commitMessage).toBeUndefined();
    const body = issueBody(r);
    expect(issueTitle(r)).toBe('Data update failed: 0.20.0');
    expect(body).toContain('## A merge is missing from config/merges.yaml');
    expect(body).toContain('Super Wizard Tower');
    expect(body).toContain('**Nothing was committed**');
    expect(body).toContain('## Sync and validation output');
  });

  it('new data that fails to load: restored to the known-good version, reported with the reason', () => {
    const f = fakeRegistry({ latest: '0.20.0', next: new Error('merges.yaml: merged defense "wizard-tower" not found in game data') });
    const r = runDataUpdate(f.deps);
    expect(r).toMatchObject({ status: 'failed', failedStep: 'load + validate the new data', to: '0.20.0' });
    expect(r.reason).toContain('wizard-tower');
    expect(f.calls).toEqual(['view <1', 'install 0.20.0', 'install 0.19.1']); // known-good restore
    expect(f.installed()).toBe('0.19.1');
  });

  it('npm view or npm install failing is a failed update with the step named', () => {
    const v = runDataUpdate(fakeRegistry({ latest: new Error('npm registry unreachable: ETIMEDOUT') }).deps);
    expect(v).toMatchObject({ status: 'failed', failedStep: 'npm registry check' });
    expect(issueTitle(v)).toBe('Data update failed: npm check');
    const i = runDataUpdate(fakeRegistry({ latest: '0.20.0', installFails: true }).deps);
    expect(i).toMatchObject({ status: 'failed', failedStep: 'install', to: '0.20.0' });
  });

  it('issue body: failing test step with the end of the test log; a pushed-but-not-deployed run says so', () => {
    const r = runDataUpdate(fakeRegistry({ latest: '0.20.0' }).deps);
    const body = issueBody(r, { step: 'npm test on the new data', testLog: 'FAIL tests/x.test.ts\n  expected 18 to be 19\n', runUrl: 'https://example/run/1' });
    expect(body).toContain('failed at **npm test on the new data**');
    expect(body).toContain('expected 18 to be 19');
    expect(body).toContain('## Diff summary');
    expect(body).toContain('Run: https://example/run/1');
    expect(issueBody(r, { step: 'start the Pages workflow', committed: true })).toContain('The commit was pushed');
    expect(issueBody(undefined, { step: 'npm ci' })).toContain('No result file');
  });

  it('missing-merge candidates: an item new in this release ranks first', () => {
    const found = explainMissingMerges(nextDataMissingMerge, new Set(['1000086'])); // pretend Revenge Tower is new
    expect(found[0].candidates[0].name).toBe('Revenge Tower');
    expect(describeMissingMerges(explainMissingMerges(nextDataMissingMerge))[0]).toContain('Other fits (less likely): Revenge Tower');
    expect(explainMissingMerges(data)).toEqual([]);
  });
});

// ── predev: git pull --ff-only (SPEC §9a step 0) ──
describe('predev git pull', () => {
  function deps(o: Partial<RefreshDeps>) {
    const logs: string[] = [];
    const d = { log: (l: string) => logs.push(l), ...o } as RefreshDeps;
    return { d, logs };
  }

  it('skipped without git; silent when already up to date', () => {
    expect(refreshGit(deps({}).d)).toBe('skipped');
    const f = deps({ gitPull: () => ({ pulled: 0, lockChanged: false }) });
    expect(refreshGit(f.d)).toBe('up-to-date');
    expect(f.logs).toEqual([]);
  });

  it('a failed pull (e.g. uncommitted changes) warns and continues', () => {
    const f = deps({
      gitPull: () => {
        throw new Error('error: Your local changes to the following files would be overwritten by merge');
      },
    });
    expect(refreshGit(f.d)).toBe('failed');
    expect(f.logs).toEqual(['[refresh] warning: git pull --ff-only failed (error: Your local changes to the following files would be overwritten by merge); continuing with the local copy.']);
  });

  it('a pulled data update (lockfile changed) runs npm install and an offline sync', () => {
    const calls: string[] = [];
    const f = deps({ gitPull: () => ({ pulled: 2, lockChanged: true }), installDeps: () => void calls.push('install'), syncOffline: () => void calls.push('sync --offline') });
    expect(refreshGit(f.d)).toBe('pulled-deps');
    expect(calls).toEqual(['install', 'sync --offline']);
    expect(f.logs[0]).toBe('[refresh] pulled 2 new commits from origin.');
    const g = deps({ gitPull: () => ({ pulled: 1, lockChanged: false }), installDeps: () => void calls.push('never') });
    expect(refreshGit(g.d)).toBe('pulled');
    expect(calls).not.toContain('never');
  });

  it('nodeGitPull: counts commits, spots a lockfile change, turns git errors into one line', () => {
    let head = 'aaa';
    const run: string[] = [];
    const exec = ((cmd: string) => {
      run.push(cmd);
      if (cmd === 'git rev-parse HEAD') return head;
      if (cmd === 'git pull --ff-only') return void (head = 'bbb');
      if (cmd.startsWith('git rev-list')) return '3';
      if (cmd.startsWith('git diff')) return 'package-lock.json\n';
      return '';
    }) as never;
    expect(nodeGitPull('.', exec)).toEqual({ pulled: 3, lockChanged: true, discarded: [] });
    expect(run).toContain('git diff --name-only aaa bbb -- package.json package-lock.json');
    const same = (() => 'aaa') as never;
    expect(nodeGitPull('.', same)).toEqual({ pulled: 0, lockChanged: false, discarded: [] });
    const failing = ((cmd: string) => {
      if (cmd === 'git pull --ff-only') throw Object.assign(new Error('Command failed'), { stderr: 'hint: something\nfatal: Not possible to fast-forward, aborting.\n' });
      return 'aaa';
    }) as never;
    expect(() => nodeGitPull('.', failing)).toThrow('fatal: Not possible to fast-forward, aborting.');
  });
});

// ── the workflow file ──
describe('.github/workflows/data-update.yml', () => {
  const code = workflowCode('data-update.yml');

  it('reads the same under a CRLF checkout (Windows core.autocrlf=true)', () => {
    const crlf = fs.readFileSync('.github/workflows/data-update.yml', 'utf8').replace(/\r?\n/g, '\r\n');
    expect(normalizeEol(crlf).replace(/#.*$/gm, '')).toBe(code);
    expect(fs.readFileSync('.gitattributes', 'utf8')).toMatch(/^\* text=auto eol=lf$/m);
  });

  it('keeps the write token out of .git/config, installs without scripts, pushes through git-auth.sh', () => {
    expect(code).toMatch(/persist-credentials: false/);
    expect(code).toContain('npm ci --ignore-scripts');
    expect(code).not.toMatch(/^\s*git (push|pull)\b/m);
    expect(code).toContain('bash .github/scripts/git-auth.sh push origin HEAD:main');
  });

  it('runs the rule tests (test:ci), not the facts about the previous data', () => {
    expect(code).toContain('npm run test:ci');
    expect(code).not.toMatch(/\bnpm test\b/);
  });

  it('the shared issue script passes the title to jq with --arg (a quote in it cannot pick another issue)', () => {
    expect(code).toContain('bash .github/scripts/upsert-issue.sh');
    const sh = normalizeEol(fs.readFileSync('.github/scripts/upsert-issue.sh', 'utf8'));
    expect(sh).toContain(`jq -r --arg t "$title" 'map(select(.title == $t))`);
    expect(sh).not.toMatch(/--jq/);
  });

  it('runs daily at 10:17 UTC and on demand, with no secrets and never the meta pipeline', () => {
    expect(code).toMatch(/schedule:\s*\n\s*- cron: '17 10 \* \* \*'/);
    expect(code).toMatch(/workflow_dispatch:/);
    expect(code).not.toMatch(/secrets\.|COC_API_TOKEN|npm run (meta|dev|refresh|push-meta)\b/);
  });

  it('commits only the three data files, then starts the Pages workflow by dispatch', () => {
    expect(code).toContain('git add package.json package-lock.json public/data-changes.json');
    expect(code).toContain('gh workflow run pages.yml --ref main');
    expect(code).toMatch(/actions: write/);
    expect(fs.readFileSync('.github/workflows/pages.yml', 'utf8')).toMatch(/workflow_dispatch:/);
  });

  it('only tests, commits and deploys after an update; reports any failure as one issue per version', () => {
    for (const id of ['test', 'commit', 'deploy']) expect(code).toMatch(new RegExp(`id: ${id}\\n[\\s\\S]*?if: steps\\.check\\.outputs\\.status == 'updated'`));
    expect(code).toMatch(/if: failure\(\)/);
    const sh = fs.readFileSync('.github/scripts/upsert-issue.sh', 'utf8');
    expect(sh).toMatch(/gh issue list --state open/);
    expect(sh).toMatch(/gh issue edit/);
    expect(sh).toMatch(/gh issue create --title/);
  });
});
