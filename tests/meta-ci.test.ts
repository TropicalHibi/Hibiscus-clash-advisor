// Daily Legend I meta Action (SPEC §8.1, §8.4) with a fake login and a fake API: auth (login / token,
// key names, masking, redaction), the commit decision, the CI run with pseudonymized tags and the
// 14-day prune, the issue text, and the workflow file. No real network calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, createClient } from '../scripts/lib/api';
import { AuthError, CI_KEY_NAME, hasCredentials, LOCAL_KEY_NAME, obtainToken, redact, type LoginFn } from '../scripts/lib/auth';
import { decideMeta, hashTag, MIN_META_ATTACKS, metaIssueBody, runMetaCi, sameMeta } from '../scripts/lib/metaCi';
import { runMeta, type MetaConf, type MetaRunResult } from '../scripts/lib/metaRun';
import { readConfig } from '../src/data/loadNode';
import { buildCatalog, parseSuperTroops } from '../src/meta/aggregate';
import type { MetaFile } from '../src/meta/meta';
import { data } from './helpers';
import { workflowCode } from './workflow';

const EMAIL = 'owner@example.com';
const PASSWORD = 'hunter2-secret';
const TOKEN = 'eyJhbGciOiJIUzUxMiJ9.eyJpc3MiOiJzdXBlcmNlbGwifQ.c2lnbmF0dXJl';

function fakeLogin(o: { fail?: string; keys?: string[] } = {}) {
  const calls: Parameters<LoginFn>[0][] = [];
  const login: LoginFn = async (args) => {
    calls.push(args);
    if (o.fail) throw new Error(o.fail);
    return o.keys ?? [TOKEN];
  };
  return { login, calls };
}

describe('auth: developer-site login or COC_API_TOKEN', () => {
  it('in GitHub Actions: logs in with key "hibiscus-ci" and masks the token before anything else', async () => {
    const f = fakeLogin();
    const printed: string[] = [];
    const t = await obtainToken({ env: { GITHUB_ACTIONS: 'true', COC_DEV_EMAIL: EMAIL, COC_DEV_PASSWORD: PASSWORD }, login: f.login, print: (l) => printed.push(l) });
    expect(t).toEqual({ token: TOKEN, source: 'login', keyName: CI_KEY_NAME });
    expect(f.calls).toEqual([{ email: EMAIL, password: PASSWORD, keyName: 'hibiscus-ci', keyCount: 1, keyDescription: expect.stringContaining('auto-managed') }]);
    expect(printed).toEqual([`::add-mask::${TOKEN}`]);
  });

  it('locally: key "hibiscus-local", nothing printed; without login it falls back to COC_API_TOKEN', async () => {
    const f = fakeLogin();
    const printed: string[] = [];
    const t = await obtainToken({ env: { COC_DEV_EMAIL: EMAIL, COC_DEV_PASSWORD: PASSWORD, COC_API_TOKEN: 'old' }, login: f.login, print: (l) => printed.push(l) });
    expect(t.keyName).toBe(LOCAL_KEY_NAME);
    expect(printed).toEqual([]);
    const fb = await obtainToken({ env: { COC_API_TOKEN: 'fixed-token' }, login: fakeLogin().login });
    expect(fb).toEqual({ token: 'fixed-token', source: 'token' });
    // A fixed token is masked in Actions too.
    const p2: string[] = [];
    await obtainToken({ env: { GITHUB_ACTIONS: 'true', COC_API_TOKEN: 'fixed-token' }, print: (l) => p2.push(l) });
    expect(p2).toEqual(['::add-mask::fixed-token']);
  });

  it('no credentials, a failed login, or no key → AuthError with no secret in the message', async () => {
    await expect(obtainToken({ env: { GITHUB_ACTIONS: 'true' } })).rejects.toThrow('COC_DEV_EMAIL and COC_DEV_PASSWORD repository secrets');
    await expect(obtainToken({ env: {} })).rejects.toThrow('.env');
    const leaky = `Invalid email or password. {"email":"${EMAIL}","password":"${PASSWORD}","token":"${TOKEN}","ip":"20.1.2.3"}`;
    const err = await obtainToken({ env: { COC_DEV_EMAIL: EMAIL, COC_DEV_PASSWORD: PASSWORD }, login: fakeLogin({ fail: leaky }).login }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain('Developer-site login failed');
    for (const secret of [EMAIL, PASSWORD, TOKEN, '20.1.2.3']) expect(err.message).not.toContain(secret);
    await expect(obtainToken({ env: { COC_DEV_EMAIL: EMAIL, COC_DEV_PASSWORD: PASSWORD }, login: fakeLogin({ keys: [] }).login })).rejects.toThrow('returned no API key');
  });

  it('redact() removes listed secrets, JWT-like tokens, emails, player tags and IPs', () => {
    expect(redact(`x ${PASSWORD} ${TOKEN} a.b@c.de #2PP0JQ8 10.0.0.1`, [PASSWORD])).toBe('x [redacted] [token] [email] #[tag] [ip]');
    expect(hasCredentials({ COC_DEV_EMAIL: 'a', COC_DEV_PASSWORD: 'b' })).toBe(true);
    expect(hasCredentials({ COC_DEV_EMAIL: 'a' })).toBe(false);
    expect(hasCredentials({ COC_API_TOKEN: 't' })).toBe(true);
  });
});

// ── commit decision ──
const meta = (attacks: number, extra: Partial<MetaFile> = {}): MetaFile => ({ generatedAt: '2026-11-17T11:10:00.000Z', windowDays: 14, halfLifeDays: 5, attacks, players: 900, units: {}, ...extra });
const run = (stats: Partial<NonNullable<MetaRunResult['stats']>> = {}): MetaRunResult => ({
  exitCode: stats.failed ? 2 : 0,
  failed: [],
  resumed: false,
  carriedOver: 0,
  rows: 20000,
  pruned: 0,
  summary: [],
  stats: { gathered: 1000, fetched: 1000, failed: 0, newRows: 8000, ...stats },
  attacks: 0,
  players: 0,
});

describe('commit decision (never a worse meta.json)', () => {
  it('a clean run commits; the same meta (apart from generatedAt) does not', () => {
    expect(decideMeta(meta(13000), meta(14000), run())).toMatchObject({ status: 'commit', commit: true, store: true, issue: false });
    expect(decideMeta(meta(14000, { generatedAt: 'old' }), meta(14000), run())).toMatchObject({ status: 'unchanged', commit: false });
    expect(sameMeta(undefined, meta(1))).toBe(false);
  });

  it(`a partial run with enough attacks commits and reports; too few players fetched does not`, () => {
    expect(decideMeta(meta(13000), meta(12000), run({ failed: 40, fetched: 960 }))).toMatchObject({ status: 'partial-commit', commit: true, issue: true, step: 'collect (partial)' });
    expect(decideMeta(meta(13000), meta(12000), run({ failed: 600, fetched: 400 }))).toMatchObject({ status: 'failed', commit: false, store: true, step: 'quality check' });
  });

  it(`fewer than ${MIN_META_ATTACKS} attacks, or under half the current meta's attacks, is never committed`, () => {
    expect(decideMeta(undefined, meta(MIN_META_ATTACKS - 1), run())).toMatchObject({ status: 'failed', commit: false });
    expect(decideMeta(undefined, meta(MIN_META_ATTACKS), run())).toMatchObject({ status: 'commit' });
    const worse = decideMeta(meta(30000), meta(14000), run());
    expect(worse).toMatchObject({ status: 'failed', commit: false, step: 'quality check' });
    expect(worse.reason).toContain('14000 attacks vs 30000');
  });

  it('API down: no players or no battle logs → failed, nothing stored', () => {
    expect(decideMeta(meta(13000), meta(13000), run({ gathered: 0, fetched: 0, newRows: 0 }))).toMatchObject({ status: 'failed', store: false, step: 'collect' });
    expect(decideMeta(meta(13000), meta(13000), run({ fetched: 0, failed: 1000, newRows: 0 }))).toMatchObject({ status: 'failed', store: false });
  });
});

describe('CI run (fake login + fake API)', () => {
  it('login failure → step "login", redacted reason, nothing committed or stored', async () => {
    const r = await runMetaCi({
      current: meta(13000),
      secrets: [EMAIL, PASSWORD],
      getToken: () => obtainToken({ env: { GITHUB_ACTIONS: 'true', COC_DEV_EMAIL: EMAIL, COC_DEV_PASSWORD: PASSWORD }, login: fakeLogin({ fail: `bad ${EMAIL} ${PASSWORD}` }).login, print: () => {} }),
      collect: async () => {
        throw new Error('unreachable');
      },
      readNext: () => meta(0),
    });
    expect(r).toMatchObject({ status: 'failed', step: 'login', commit: false, store: false, issue: true });
    expect(r.reason).not.toContain(PASSWORD);
    expect(r.reason).not.toContain(EMAIL);
  });

  it('a 403 from the API → step "collect (HTTP 403)"; the token never appears in the reason', async () => {
    const r = await runMetaCi({
      current: meta(13000),
      secrets: [],
      getToken: async () => ({ token: TOKEN, source: 'login', keyName: CI_KEY_NAME }),
      collect: async () => {
        throw new ApiError(403, 'accessDenied.invalidIp', `Invalid authorization: API key ${TOKEN} does not allow access from IP 20.1.2.3`, '/locations');
      },
      readNext: () => meta(0),
    });
    expect(r).toMatchObject({ status: 'failed', step: 'collect (HTTP 403)', source: 'login', keyName: 'hibiscus-ci' });
    expect(r.reason).not.toContain(TOKEN);
    expect(r.reason).not.toContain('20.1.2.3');
  });

  it('collects with pseudonymized tags, dedupes across runs and prunes to the 14-day window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-meta-ci-'));
    const log = JSON.parse(fs.readFileSync('tests/fixtures/api/battlelog-1.json', 'utf8'));
    const ranked = { items: ['#A', '#B', '#C'].map((tag) => ({ tag, name: 'x', leagueTier: { id: 105000036, name: 'Legend League I' } })) };
    const fetchImpl = (async (url: string) => {
      const p = url.replace('https://api.clashofclans.com/v1', '');
      if (p === '/locations') return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (p === '/locations/global/rankings/players') return new Response(JSON.stringify(ranked), { status: 200 });
      if (/battlelog$/.test(p)) return new Response(JSON.stringify(log), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const conf: MetaConf = { leagueTierId: 105000036, maxPlayers: 3, windowDays: 14, halfLifeDays: 5, requestsPerSecond: 1000 };
    const latest = Math.max(...log.items.map((b: { battleTimestamp: string }) => Date.parse(b.battleTimestamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6'))));
    // An old row (20 days) restored from meta-data must be pruned.
    fs.writeFileSync(path.join(dir, 'battles.jsonl'), JSON.stringify({ tag: hashTag('#OLD'), ts: new Date(latest - 20 * 86400_000).toISOString(), stars: 3, destruction: 100, armyShareCode: 'u1x0' }) + '\n');
    const go = () =>
      runMeta({
        dir,
        outFile: path.join(dir, 'meta.json'),
        conf,
        api: createClient({ token: 't', requestsPerSecond: 1000, fetchImpl, sleep: async () => {} }),
        catalog: buildCatalog(data, parseSuperTroops(readConfig('super-troops.yaml'))),
        dataVersion: 'test',
        now: () => latest + 3600_000,
        log: () => {},
        pruneDays: 14,
        tagMap: hashTag,
        noRunState: true,
      });
    const first = await go();
    const text = fs.readFileSync(path.join(dir, 'battles.jsonl'), 'utf8');
    expect(text).not.toMatch(/"tag":"#/);
    expect(text).toContain(hashTag('#A'));
    expect(text).not.toContain(hashTag('#OLD'));
    expect(first.stats).toEqual({ gathered: 3, fetched: 3, failed: 0, newRows: first.rows });
    expect(first.pruned).toBe(1);
    const second = await go(); // same battle logs again: all duplicates
    expect(second.stats!.newRows).toBe(0);
    expect(second.rows).toBe(first.rows);
    expect(fs.existsSync(path.join(dir, 'run-state.json'))).toBe(false);
    expect(hashTag('#A')).toMatch(/^h[0-9a-f]{16}$/);
  });
});

describe('issue text', () => {
  it('names the step, the numbers and the minimums; scrubs secrets once more', () => {
    const r = decideMeta(meta(30000), meta(14000), run());
    const body = metaIssueBody({ ...r, reason: `${r.reason} ${PASSWORD}`, source: 'login', keyName: 'hibiscus-ci' }, { runUrl: 'https://example/run/9', committed: false, secrets: [PASSWORD] });
    expect(body).toContain('failed at **quality check**');
    expect(body).toContain('`public/meta.json` was not changed');
    expect(body).toContain('Attacks in the 14-day window: 14000 (current meta.json: 30000)');
    expect(body).toContain('key "hibiscus-ci"');
    expect(body).not.toContain(PASSWORD);
    const partial = metaIssueBody(decideMeta(meta(13000), meta(12000), run({ failed: 40, fetched: 960 })), { committed: true });
    expect(partial).toContain('**partial**');
    expect(partial).toContain('committed anyway');
  });
});

describe('.github/workflows/meta.yml', () => {
  const code = workflowCode('meta.yml');

  it('keeps the write token out of .git/config, installs without scripts, pushes through git-auth.sh', () => {
    expect(code).toMatch(/persist-credentials: false/);
    expect(code).toContain('npm ci --ignore-scripts');
    expect(code).not.toMatch(/^\s*git (push|pull)\b/m);
    expect(code).toContain('bash .github/scripts/upsert-issue.sh');
    expect(code).not.toMatch(/--jq/);
  });

  it('runs daily at 11:07 UTC and on demand; only the two login secrets, never printed', () => {
    expect(code).toMatch(/schedule:\s*\n\s*- cron: '7 11 \* \* \*'/);
    expect(code).toMatch(/workflow_dispatch:/);
    expect([...code.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(['COC_DEV_EMAIL', 'COC_DEV_EMAIL', 'COC_DEV_PASSWORD', 'COC_DEV_PASSWORD']);
    expect(code).not.toMatch(/echo[^\n]*\$\{?COC_DEV|COC_API_TOKEN/);
  });

  it('restores from meta-data, commits only meta.json ("meta: <generatedAt>"), deploys by dispatch, force-pushes one commit', () => {
    expect(code).toMatch(/git show FETCH_HEAD:battles\.jsonl\.gz \| gunzip > data\/meta\/battles\.jsonl/);
    expect(code).toContain('git add public/meta.json');
    expect(code).toContain('git commit -m "meta: $GENERATED_AT"');
    expect(code).toContain('gh workflow run pages.yml --ref main');
    expect(code).toMatch(/git commit-tree "\$tree"/); // a parentless commit: no history growth
    expect(code).toContain('bash .github/scripts/git-auth.sh push --force origin "$commit:refs/heads/meta-data"');
    const order = ['id: restore', 'id: meta', 'id: commit', 'id: deploy', 'id: store'].map((s) => code.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('reports failures and partial runs as one "Meta update failed" issue, closed by the next clean run', () => {
    expect(code).toMatch(/if: failure\(\) \|\| steps\.meta\.outputs\.issue == 'true'/);
    expect(fs.readFileSync('.github/scripts/upsert-issue.sh', 'utf8')).toMatch(/gh issue edit/);
    expect(code).toMatch(/gh issue close/);
  });
});
