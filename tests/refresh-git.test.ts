// SPEC §9a step 0 (REVIEW-2 #4): local copies of refresh-generated files never block `git pull --ff-only`.
// The end-to-end cases use throwaway git repos in the temp dir with a local bare "origin" (no network).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeGitPull } from '../scripts/lib/nodeDeps';
import { blockerMessage, pullDiscards, refreshGit, syncOnlyChange, type RefreshDeps } from '../scripts/lib/refresh';

describe('pullDiscards / syncOnlyChange', () => {
  const never = () => false;

  it('discards only refresh-generated files that the incoming commits touch', () => {
    const r = pullDiscards(
      ['public/meta.json', 'data/clashking/pin.json', 'public/data-changes.json', 'src/main.ts', 'README.md'],
      ['public/meta.json', 'data/clashking/pin.json', 'src/main.ts'],
      never,
    );
    expect(r.discard).toEqual(['data/clashking/pin.json', 'public/meta.json']);
    expect(r.blockers).toEqual(['src/main.ts']); // touched by the incoming commits, not generated: never discarded
  });

  it('a generated file the incoming commits do not touch stays as it is', () => {
    expect(pullDiscards(['public/meta.json'], ['src/x.ts'], never)).toEqual({ discard: [], blockers: [] });
  });

  it('package.json / package-lock.json only when sync changed them (the clash-of-clans-data version alone)', () => {
    expect(pullDiscards(['package.json'], ['package.json'], () => true).discard).toEqual(['package.json']);
    expect(pullDiscards(['package.json'], ['package.json'], () => false).blockers).toEqual(['package.json']);
  });

  it('syncOnlyChange: only the clash-of-clans-data dependency and lockfile entries may differ', () => {
    const pkg = (v: string, extra = {}) => JSON.stringify({ name: 'x', dependencies: { 'clash-of-clans-data': v, yaml: '^2' }, ...extra });
    expect(syncOnlyChange('package.json', pkg('^0.19.1'), pkg('^0.19.2'))).toBe(true);
    expect(syncOnlyChange('package.json', pkg('^0.19.1'), pkg('^0.19.2', { scripts: { x: 'y' } }))).toBe(false);
    const lock = (v: string, yaml = '2.9.1') =>
      JSON.stringify({
        packages: {
          '': { dependencies: { 'clash-of-clans-data': `^${v}`, yaml: '^2' } },
          'node_modules/clash-of-clans-data': { version: v, resolved: `https://r/${v}.tgz` },
          'node_modules/yaml': { version: yaml },
        },
      });
    expect(syncOnlyChange('package-lock.json', lock('0.19.1'), lock('0.19.2'))).toBe(true);
    expect(syncOnlyChange('package-lock.json', lock('0.19.1'), lock('0.19.2', '2.9.2'))).toBe(false);
    expect(syncOnlyChange('package.json', undefined, pkg('1'))).toBe(false);
    expect(syncOnlyChange('package.json', '{', pkg('1'))).toBe(false);
    expect(syncOnlyChange('public/meta.json', '{}', '{}')).toBe(false);
  });

  it('the blocker warning names the files and the commands that fix it', () => {
    const m = blockerMessage(['src/main.ts', 'my notes.md']);
    expect(m).toContain('local changes to src/main.ts, my notes.md conflict with the incoming commits');
    expect(m).toContain('`git stash`');
    expect(m).toContain('`git checkout -- src/main.ts "my notes.md"`');
  });

  it('refreshGit logs what it discarded', () => {
    const logs: string[] = [];
    const d = { gitPull: () => ({ pulled: 1, lockChanged: false, discarded: ['public/meta.json'] }), log: (l: string) => logs.push(l) } as unknown as RefreshDeps;
    expect(refreshGit(d)).toBe('pulled');
    expect(logs[0]).toBe('[refresh] discarded the local copy of public/meta.json (written by an earlier refresh; the incoming commits replace it).');
  });
});

describe('nodeGitPull on real repos (local bare origin)', { timeout: 30_000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-git-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const sh = (cwd: string, cmd: string) =>
    execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const git = (cwd: string, args: string) => sh(cwd, `git -c user.name=t -c user.email=t@example.invalid -c core.autocrlf=false -c init.defaultBranch=main ${args}`);
  const write = (dir: string, f: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  };
  let n = 0;
  /** origin (bare) + "local" (the owner's clone) + "action" (another clone that pushes, like the daily Action). */
  const setup = () => {
    const base = path.join(tmp, `r${++n}`);
    const origin = path.join(base, 'origin.git');
    const local = path.join(base, 'local');
    const action = path.join(base, 'action');
    fs.mkdirSync(base, { recursive: true });
    git(base, `init --bare -q "${origin}"`);
    git(base, `clone -q "${origin}" "${action}"`);
    git(action, 'checkout -q -b main');
    write(action, 'public/meta.json', '{"generatedAt":"1"}\n');
    write(action, 'src/main.ts', 'export {};\n');
    write(action, 'package.json', JSON.stringify({ name: 'x', dependencies: { 'clash-of-clans-data': '^0.19.1' } }, null, 2) + '\n');
    git(action, 'add -A');
    git(action, 'commit -q -m init');
    git(action, 'push -q origin main');
    git(base, `clone -q -c core.autocrlf=false "${origin}" "${local}"`); // nodeGitPull runs plain git in it
    return { local, action };
  };
  const push = (action: string, files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) write(action, f, t);
    git(action, 'add -A');
    git(action, 'commit -q -m update');
    git(action, 'push -q origin main');
  };

  it('a locally written public/meta.json that the incoming commit also touches is discarded, then the pull works', () => {
    const { local, action } = setup();
    write(local, 'public/meta.json', '{"generatedAt":"local"}\n'); // a local npm run meta, never pushed
    push(action, { 'public/meta.json': '{"generatedAt":"action"}\n' });
    const r = nodeGitPull(local);
    expect(r).toEqual({ pulled: 1, lockChanged: false, discarded: ['public/meta.json'] });
    expect(fs.readFileSync(path.join(local, 'public/meta.json'), 'utf8')).toBe('{"generatedAt":"action"}\n');
  });

  it('even when the local copy is identical to the incoming one (git refuses that too)', () => {
    const { local, action } = setup();
    write(local, 'public/meta.json', '{"generatedAt":"same"}\n');
    push(action, { 'public/meta.json': '{"generatedAt":"same"}\n' });
    expect(nodeGitPull(local).discarded).toEqual(['public/meta.json']);
  });

  it('a sync-only package.json change is discarded; a hand edit the commit touches blocks with a named fix', () => {
    const { local, action } = setup();
    write(local, 'package.json', JSON.stringify({ name: 'x', dependencies: { 'clash-of-clans-data': '^0.19.2' } }, null, 2) + '\n');
    push(action, { 'package.json': JSON.stringify({ name: 'x', dependencies: { 'clash-of-clans-data': '^0.19.3' } }, null, 2) + '\n' });
    const r = nodeGitPull(local);
    expect(r.discarded).toEqual(['package.json']);
    expect(r.lockChanged).toBe(true);

    write(local, 'src/main.ts', 'export const mine = 1;\n');
    push(action, { 'src/main.ts': 'export const theirs = 1;\n' });
    expect(() => nodeGitPull(local)).toThrow(/local changes to src\/main\.ts conflict with the incoming commits.*git checkout -- src\/main\.ts/);
    expect(fs.readFileSync(path.join(local, 'src/main.ts'), 'utf8')).toBe('export const mine = 1;\n'); // never discarded
  });

  it('local changes the incoming commits do not touch are kept (and do not block)', () => {
    const { local, action } = setup();
    write(local, 'public/meta.json', '{"generatedAt":"local"}\n');
    push(action, { 'src/main.ts': 'export const theirs = 2;\n' });
    expect(nodeGitPull(local)).toEqual({ pulled: 1, lockChanged: false, discarded: [] });
    expect(fs.readFileSync(path.join(local, 'public/meta.json'), 'utf8')).toBe('{"generatedAt":"local"}\n');
  });
});
