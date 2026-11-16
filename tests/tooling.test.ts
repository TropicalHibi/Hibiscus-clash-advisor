// Tooling after REVIEW.md: sync with last known-good data (#7), refresh warnings, the real Node wiring,
// the meta run (resume, carry-over #9, prune, dedupe, exit codes), API retries (#12), fixture redaction (#11).
// Everything is faked: no npm, no network, no API; files go to a temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/data/loadNode';
import { buildCatalog, parseSuperTroops, type BattleRow } from '../src/meta/aggregate';
import { ApiError, createClient, retryAfterMs } from '../scripts/lib/api';
import { gatherPlayers } from '../scripts/lib/collect';
import { runMeta, type MetaConf } from '../scripts/lib/metaRun';
import { nodeRefreshDeps, npmLatestInMajor, runRefresh } from '../scripts/lib/nodeDeps';
import { createRedactor, PSEUDONYM, TAG_VALUE } from '../scripts/lib/redact';
import { refreshGameData, type RefreshDeps, type RefreshState } from '../scripts/lib/refresh';
import { majorOf, newestOf, syncData, type DataCheck, type SyncDeps } from '../scripts/lib/sync';
import { data } from './helpers';

const H = 3_600_000;
const NOW = Date.parse('2026-11-16T12:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coc-planner-test-'));
const apiFixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/api/${name}`, import.meta.url), 'utf8'));

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── #7 sync: newest within the major, last known-good on failure ──
function fakeSync(o: { installed?: string; latest?: string; good?: (v: string) => boolean; state?: RefreshState } = {}) {
  let installed = o.installed ?? '0.19.1';
  let state: RefreshState = o.state ?? {};
  const calls: string[] = [];
  const logs: string[] = [];
  const good = o.good ?? (() => true);
  const d: SyncDeps = {
    installedVersion: () => installed,
    latestInMajor: (major) => {
      calls.push(`view <${major + 1}`);
      return o.latest ?? installed;
    },
    install: (v) => {
      calls.push(`install ${v}`);
      installed = v;
    },
    check: (): DataCheck => (good(installed) ? { ok: true, warnings: [], maxTH: 18 } : { ok: false, error: 'merges.yaml: merged defense "x" not found in game data', warnings: [] }),
    readState: () => state,
    writeState: (s) => void (state = s),
    log: (l) => logs.push(l),
  };
  return { d, calls, logs, state: () => state, installed: () => installed };
}

describe('npm run sync (#7)', () => {
  it('up to date: records the installed version as last known-good', () => {
    const f = fakeSync();
    expect(syncData(f.d)).toBe('up-to-date');
    expect(f.calls).toEqual(['view <1']); // pinned to the current major (0.x → <1.0.0)
    expect(f.state().lastGoodDataVersion).toBe('0.19.1');
  });

  it('a newer version that loads: installed, becomes last known-good, clears an old failure', () => {
    const f = fakeSync({ latest: '0.20.0', state: { dataFailure: { version: '0.19.9', reason: 'x', at: 1 } } });
    expect(syncData(f.d)).toBe('updated');
    expect(f.calls).toEqual(['view <1', 'install 0.20.0']);
    expect(f.state()).toMatchObject({ lastGoodDataVersion: '0.20.0' });
    expect(f.state().dataFailure).toBeUndefined();
  });

  it('a newer version that fails to load: restore the last known-good one and record the failure', () => {
    const f = fakeSync({ latest: '0.20.0', good: (v) => v !== '0.20.0' });
    expect(syncData(f.d)).toBe('restored');
    expect(f.calls).toEqual(['view <1', 'install 0.20.0', 'install 0.19.1']);
    expect(f.installed()).toBe('0.19.1');
    expect(f.state().dataFailure).toMatchObject({ version: '0.20.0' });
    expect(f.state().dataFailure!.reason).toContain('merges.yaml');
    expect(f.state().lastGoodDataVersion).toBe('0.19.1');
  });

  it('a broken installed version with nothing better published: back to the recorded last good one', () => {
    const f = fakeSync({ installed: '0.20.0', good: (v) => v !== '0.20.0', state: { lastGoodDataVersion: '0.19.1' } });
    expect(syncData(f.d)).toBe('restored');
    expect(f.installed()).toBe('0.19.1');
  });

  it('no known-good version: fails without installing anything else', () => {
    const f = fakeSync({ installed: '0.20.0', good: () => false });
    expect(syncData(f.d)).toBe('failed');
    expect(f.calls).toEqual(['view <1']);
  });

  it('version helpers: newest of npm --json output; major of a version', () => {
    expect(newestOf('"0.19.1"')).toBe('0.19.1');
    expect(newestOf('["0.18.0","0.20.1","0.19.4"]')).toBe('0.20.1');
    expect(() => newestOf('')).toThrow();
    expect(majorOf('1.4.2')).toBe(1);
    expect(majorOf(undefined)).toBe(0);
  });
});

// ── refresh: warn on every start while running on the last known-good data ──
function fakeRefresh(state: RefreshState, latest = '0.20.0') {
  const calls: string[] = [];
  const logs: string[] = [];
  let st = state;
  const d: RefreshDeps = {
    now: () => NOW,
    readState: () => st,
    writeState: (s) => {
      st = s;
      calls.push('writeState');
    },
    installedVersion: () => '0.19.1',
    latestVersion: () => {
      calls.push('npm view');
      return latest;
    },
    runSync: () => void calls.push('sync'),
    metaGeneratedAt: () => NOW,
    hasToken: () => true,
    runMeta: () => ({ code: 0, stderr: '' }),
    log: (l) => logs.push(l),
  };
  return { d, calls, logs };
}

describe('predev refresh with a failed data version', () => {
  const failure = { version: '0.20.0', reason: 'merges.yaml: source "cannon" not found', at: NOW - 2 * H };

  it('warns on every start, even when the 24h check is not due', () => {
    const f = fakeRefresh({ lastDataCheck: NOW - H, dataFailure: failure });
    expect(refreshGameData(f.d)).toBe('checked-recently');
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toContain("0.20.0 can't be used");
    expect(f.logs[0]).toContain('staying on 0.19.1');
  });

  it('does not reinstall the known-bad version on every start', () => {
    const f = fakeRefresh({ lastDataCheck: NOW - 25 * H, dataFailure: failure }, '0.20.0');
    expect(refreshGameData(f.d)).toBe('known-bad');
    expect(f.calls).toEqual(['npm view', 'writeState']);
  });

  it('a release newer than the bad one is synced', () => {
    const f = fakeRefresh({ lastDataCheck: NOW - 25 * H, dataFailure: failure }, '0.20.1');
    expect(refreshGameData(f.d)).toBe('synced');
    expect(f.calls).toContain('sync');
  });
});

describe('real refresh wiring (scripts/lib/nodeDeps.ts)', () => {
  it('npm view is pinned to the installed major and parsed from --json', () => {
    const cmds: string[] = [];
    const exec = ((cmd: string) => {
      cmds.push(cmd);
      return '["0.19.1","0.20.0"]';
    }) as never;
    expect(npmLatestInMajor('.', 0, exec)).toBe('0.20.0');
    expect(cmds[0]).toContain('clash-of-clans-data@<1.0.0');
  });

  it('offline (every command times out) → one warning line per step, the refresh never throws, nothing is written', () => {
    vi.stubEnv('COC_API_TOKEN', '');
    const root = tmp();
    const logs: string[] = [];
    const exec = (() => {
      throw Object.assign(new Error('spawnSync npm ETIMEDOUT'), { code: 'ETIMEDOUT', stderr: '' });
    }) as never;
    expect(() => runRefresh(nodeRefreshDeps({ root, execSync: exec, log: (l) => logs.push(l) }))).not.toThrow();
    expect(logs[0]).toBe('[refresh] warning: git pull --ff-only failed (timed out); continuing with the local copy.');
    expect(logs[1]).toBe('[refresh] warning: game-data check skipped (npm registry unreachable: timed out); starting the site anyway.');
    expect(logs[2]).toContain('no COC_API_TOKEN'); // meta.json missing in the temp root, no token
    expect(fs.existsSync(path.join(root, 'data', 'refresh-state.json'))).toBe(false);
  });

  it('a stale meta.json with a token runs npm run meta; a non-zero exit is one warning line', () => {
    vi.stubEnv('COC_API_TOKEN', 'x');
    const root = tmp();
    const logs: string[] = [];
    const spawned: string[] = [];
    const exec = (() => '"0.19.1"') as never;
    const spawn = ((cmd: string) => {
      spawned.push(cmd);
      return { status: 1, stderr: 'npm error code 1\nAPI error: HTTP 403 on /locations: accessDenied' };
    }) as never;
    runRefresh(nodeRefreshDeps({ root, execSync: exec, spawnSync: spawn, log: (l) => logs.push(l) }));
    expect(spawned).toEqual(['npm run meta']);
    expect(logs.at(-1)).toContain('(403: the API key is locked to a different IP)');
  });
});

// ── meta run (#9 carry-over, resume, prune, dedupe, exit codes) ──
const conf: MetaConf = { leagueTierId: 105000036, maxPlayers: 3, windowDays: 14, halfLifeDays: 5, requestsPerSecond: 1000 };
const catalog = buildCatalog(data, parseSuperTroops(readConfig('super-troops.yaml')));

function metaApi(failing = new Set<string>()) {
  const calls: string[] = [];
  const log = apiFixture('battlelog-1.json');
  const ranked = (tags: string[]) => ({ items: tags.map((tag) => ({ tag, name: 'x', leagueTier: { id: 105000036, name: 'Legend League I' } })) });
  const fetchImpl = (async (url: string) => {
    const p = url.replace('https://api.clashofclans.com/v1', '');
    calls.push(p);
    if (p === '/locations') return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (p === '/locations/global/rankings/players') return new Response(JSON.stringify(ranked(['#A', '#B', '#C', '#D'])), { status: 200 });
    const m = /^\/players\/%23(\w+)\/battlelog$/.exec(p);
    if (m && failing.has(m[1])) return new Response('{}', { status: 500 });
    if (m) return new Response(JSON.stringify(log), { status: 200 });
    return new Response('{"reason":"notFound"}', { status: 404 });
  }) as unknown as typeof fetch;
  const api = createClient({ token: 't', requestsPerSecond: 1000, maxRetries: 1, fetchImpl, sleep: async () => {} });
  return { api, calls, battlelogs: () => calls.filter((c) => c.includes('battlelog')) };
}

function runAt(dir: string, nowMs: number, api: ReturnType<typeof metaApi>['api'] | undefined, extra: { fresh?: boolean; aggregateOnly?: boolean; maxPlayers?: number } = {}) {
  return runMeta({
    dir,
    outFile: path.join(dir, 'meta.json'),
    conf: { ...conf, maxPlayers: extra.maxPlayers ?? conf.maxPlayers },
    fresh: extra.fresh,
    aggregateOnly: extra.aggregateOnly,
    api,
    catalog,
    dataVersion: 'test',
    now: () => nowMs,
    log: () => {},
  });
}
const lastBattleMs = () => Math.max(...apiFixture('battlelog-1.json').items.map((b: { battleTimestamp: string }) => Date.parse(b.battleTimestamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'))));

describe('npm run meta (scripts/lib/metaRun.ts)', () => {
  it('a clean run: rows appended once, meta.json written, run state removed, exit 0', async () => {
    const dir = tmp();
    const t = lastBattleMs() + H;
    const r = await runAt(dir, t, metaApi().api);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dir, 'run-state.json'))).toBe(false);
    const rows = fs.readFileSync(path.join(dir, 'battles.jsonl'), 'utf8').trim().split('\n');
    expect(r.rows).toBe(rows.length);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).attacks).toBeGreaterThan(0);
  });

  it('failed players → exit 2 and kept state; the next run (25h later) retries them first', async () => {
    const dir = tmp();
    const t = lastBattleMs() + H;
    const first = await runAt(dir, t, metaApi(new Set(['B'])).api);
    expect(first.exitCode).toBe(2);
    expect(first.failed).toEqual(['#B']);
    expect(fs.existsSync(path.join(dir, 'run-state.json'))).toBe(true);
    const second = metaApi();
    const r = await runAt(dir, t + 25 * H, second.api); // too old to resume, recent enough to carry over
    expect(r.resumed).toBe(false);
    expect(r.carriedOver).toBe(1);
    expect(second.battlelogs()[0]).toBe('/players/%23B/battlelog');
    expect(r.exitCode).toBe(0);
  });

  it('an interrupted run resumes within 24h (only the remaining players); --fresh and a new maxPlayers start over', async () => {
    const dir = tmp();
    const t = lastBattleMs() + H;
    fs.writeFileSync(
      path.join(dir, 'run-state.json'),
      JSON.stringify({ startedAt: new Date(t - H).toISOString(), maxPlayers: 3, tags: ['#A', '#B', '#C'], done: ['#A', '#B'], stats: { entries: 0, legendAttacks: 0, newRows: 0, duplicates: 0, missingCode: 0, notFound: 0 } }),
    );
    const resumed = metaApi();
    expect((await runAt(dir, t, resumed.api)).resumed).toBe(true);
    expect(resumed.battlelogs()).toEqual(['/players/%23C/battlelog']);
    expect(resumed.calls).not.toContain('/locations');

    for (const extra of [{ fresh: true }, { maxPlayers: 2 }]) {
      fs.writeFileSync(
        path.join(dir, 'run-state.json'),
        JSON.stringify({ startedAt: new Date(t - H).toISOString(), maxPlayers: 3, tags: ['#A', '#B', '#C'], done: ['#A'], stats: { entries: 0, legendAttacks: 0, newRows: 0, duplicates: 0, missingCode: 0, notFound: 0 } }),
      );
      const api = metaApi();
      const r = await runAt(dir, t, api.api, extra);
      expect(r.resumed).toBe(false);
      expect(api.calls).toContain('/locations');
    }
  });

  it('prunes rows older than 60 days and duplicates on load (aggregate-only, no API)', async () => {
    const dir = tmp();
    const t = NOW;
    const row = (tag: string, daysAgo: number): BattleRow => ({ tag, ts: new Date(t - daysAgo * 86_400_000).toISOString(), stars: 3, destruction: 100, armyShareCode: 'u10x0' });
    const lines = [row('#A', 1), row('#A', 1), row('#B', 2), row('#C', 61)].map((r) => JSON.stringify(r));
    fs.writeFileSync(path.join(dir, 'battles.jsonl'), lines.join('\n') + '\n{"torn');
    const r = await runAt(dir, t, undefined, { aggregateOnly: true });
    expect(r.rows).toBe(2);
    expect(r.pruned).toBe(2);
    expect(fs.readFileSync(path.join(dir, 'battles.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(r.exitCode).toBe(0);
  });

  it('401/403 aborts the run with an ApiError (progress kept)', async () => {
    const dir = tmp();
    const fetchImpl = (async (url: string) =>
      url.endsWith('/locations')
        ? new Response('{"items":[]}', { status: 200 })
        : url.includes('rankings')
          ? new Response(JSON.stringify({ items: [{ tag: '#A', leagueTier: { id: 105000036 } }] }), { status: 200 })
          : new Response('{"reason":"accessDenied"}', { status: 403 })) as unknown as typeof fetch;
    const api = createClient({ token: 't', requestsPerSecond: 1000, fetchImpl, sleep: async () => {} });
    await expect(runAt(dir, NOW, api)).rejects.toBeInstanceOf(ApiError);
    expect(fs.existsSync(path.join(dir, 'run-state.json'))).toBe(true);
  });
});

// ── API client + rankings (#12) ──
describe('API client and rankings', () => {
  it('401/403 are never retried; network errors are retried, then thrown', async () => {
    for (const status of [401, 403]) {
      let n = 0;
      const api = createClient({ token: 't', fetchImpl: (async () => (n++, new Response('{}', { status }))) as unknown as typeof fetch, sleep: async () => {} });
      await expect(api.get('/x')).rejects.toMatchObject({ status });
      expect(n).toBe(1);
    }
    let n = 0;
    const net = createClient({
      token: 't',
      maxRetries: 2,
      fetchImpl: (async () => {
        n++;
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expect(net.get('/x')).rejects.toThrow('fetch failed');
    expect(n).toBe(3);
  });

  it('honours Retry-After on 429 (capped at 60s)', async () => {
    const waits: number[] = [];
    let n = 0;
    const api = createClient({
      token: 't',
      requestsPerSecond: 1000,
      fetchImpl: (async () => (++n === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '12' } }) : new Response('{"ok":1}', { status: 200 }))) as unknown as typeof fetch,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(await api.get('/x')).toEqual({ ok: 1 });
    expect(Math.max(...waits)).toBe(12_000);
    expect(retryAfterMs('600', 0)).toBe(60_000);
    expect(retryAfterMs(null, 0)).toBeLessThan(1_300);
  });

  it('a location that keeps failing is skipped; a 403 still aborts', async () => {
    const locations = { items: [{ id: 1, name: 'A', isCountry: true }, { id: 3, name: 'B', isCountry: true }] };
    const country = apiFixture('rankings-country-limit5.json');
    const skipped: string[] = [];
    const mk = (bad: number) =>
      createClient({
        token: 't',
        requestsPerSecond: 1000,
        maxRetries: 1,
        sleep: async () => {},
        fetchImpl: (async (url: string) => {
          const p = url.replace('https://api.clashofclans.com/v1', '');
          if (p === '/locations') return new Response(JSON.stringify(locations), { status: 200 });
          if (p === '/locations/global/rankings/players') return new Response('{}', { status: bad });
          if (p === '/locations/3/rankings/players') return new Response(JSON.stringify(country), { status: 200 });
          return new Response('{}', { status: 404 });
        }) as unknown as typeof fetch,
      });
    const tags = await gatherPlayers(mk(503), { maxPlayers: 50, onSkip: ({ location }) => skipped.push(location) });
    expect(skipped).toEqual(['Global']);
    expect(tags.length).toBeGreaterThan(0);
    await expect(gatherPlayers(mk(403), { maxPlayers: 50 })).rejects.toMatchObject({ status: 403 });
  });
});

// ── #11 fixture redaction ──
describe('API fixture redaction', () => {
  it('no committed fixture holds a real-looking tag (only #PLAYERn / #CLANn pseudonyms)', () => {
    const dir = new URL('./fixtures/api/', import.meta.url);
    const leaks: string[] = [];
    const walk = (x: unknown, where: string) => {
      if (typeof x === 'string') {
        if (TAG_VALUE.test(x) && !PSEUDONYM.test(x)) leaks.push(`${where}: ${x}`);
      } else if (Array.isArray(x)) x.forEach((v, i) => walk(v, `${where}[${i}]`));
      else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) walk(v, `${where}.${k}`);
    };
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) walk(JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')), f);
    expect(leaks).toEqual([]);
    const player = apiFixture('player.json');
    expect(player.previousLeagueGroupTag).toBeUndefined();
    expect(player.trophies).toBe(0);
  });

  it('the redactor removes league group tags and profile stats, and is idempotent', () => {
    const raw = { tag: '#ABC123', name: 'Real Name', previousLeagueGroupTag: '#8UG890J', trophies: 5000, achievements: [{ name: 'Gold Grab', value: 123, completionInfo: 'x' }], clan: { tag: '#CL4N', name: 'Clan' }, note: '#XYZ99' };
    const once = createRedactor()(raw) as Record<string, unknown>;
    expect(once).toMatchObject({ tag: '#PLAYER1', name: 'Redacted Player', trophies: 0, clan: { tag: '#CLAN1', name: 'Redacted Clan' }, note: '#REDACTED' });
    expect(once.previousLeagueGroupTag).toBeUndefined();
    expect(once.achievements).toEqual([{ name: 'Gold Grab' }]);
    expect(createRedactor()(once)).toEqual(once);
  });
});
