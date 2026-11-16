// SPEC §9a: predev refresh. Fake side effects only — no npm, no network, no API.
import { describe, expect, it } from 'vitest';
import { isNewerVersion, oneLine, PUSH_META_REMINDER, refresh, REFRESH_MAX_AGE_MS, type RefreshDeps, type RefreshState } from '../scripts/lib/refresh';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const H = 3_600_000;

function fake(over: Partial<RefreshDeps> & { state?: RefreshState } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  let state: RefreshState = over.state ?? {};
  const d: RefreshDeps = {
    now: () => NOW,
    readState: () => state,
    writeState: (s) => {
      state = s;
      calls.push('writeState');
    },
    installedVersion: () => '0.19.1',
    latestVersion: () => {
      calls.push('npm view');
      return '0.19.1\n';
    },
    runSync: () => {
      calls.push('sync');
    },
    metaGeneratedAt: () => NOW - 2 * H,
    hasToken: () => true,
    runMeta: () => {
      calls.push('meta');
      return { code: 0, stderr: '' };
    },
    log: (l) => logs.push(l),
    ...over,
  };
  return { d, calls, logs, state: () => state };
}

describe('predev refresh', () => {
  it('does nothing when both were checked within 24h', () => {
    const f = fake({ state: { lastDataCheck: NOW - 23 * H } });
    expect(refresh(f.d)).toEqual({ git: 'skipped', data: 'checked-recently', meta: 'fresh' });
    expect(f.calls).toEqual([]);
    expect(f.logs).toEqual([]);
  });

  it('checks npm after 24h; same version → no sync, check time saved', () => {
    const f = fake({ state: { lastDataCheck: NOW - REFRESH_MAX_AGE_MS - 1 } });
    expect(refresh(f.d).data).toBe('up-to-date');
    expect(f.calls).toEqual(['npm view', 'writeState']);
    expect(f.state().lastDataCheck).toBe(NOW);
  });

  it('newer clash-of-clans-data → full sync', () => {
    const f = fake({ latestVersion: () => '0.20.0' });
    expect(refresh(f.d).data).toBe('synced');
    expect(f.calls).toEqual(['sync', 'writeState']);
    expect(f.logs[0]).toContain('0.20.0 is out');
  });

  it('offline → one-line warning, state not saved (retries next start), meta still checked', () => {
    const f = fake({
      latestVersion: () => {
        throw new Error('npm registry unreachable: ENOTFOUND\n  at stack…');
      },
      metaGeneratedAt: () => NOW - 25 * H,
    });
    expect(refresh(f.d)).toEqual({ git: 'skipped', data: 'failed', meta: 'updated' });
    expect(f.logs[0]).toBe('[refresh] warning: game-data check skipped (npm registry unreachable: ENOTFOUND); starting the site anyway.');
    expect(f.state().lastDataCheck).toBeUndefined();
    expect(f.calls).toContain('meta');
  });

  it('failed sync → warning, state not saved', () => {
    const f = fake({
      latestVersion: () => '1.0.0',
      runSync: () => {
        throw new Error('Command failed: npm run sync');
      },
    });
    expect(refresh(f.d).data).toBe('failed');
    expect(f.logs.at(-1)).toMatch(/^\[refresh\] warning: sync failed/);
    expect(f.state().lastDataCheck).toBeUndefined();
  });

  it('meta.json older than 24h (or missing) with a token → npm run meta', () => {
    const f = fake({ state: { lastDataCheck: NOW }, metaGeneratedAt: () => NOW - 24 * H - 1 });
    expect(refresh(f.d).meta).toBe('updated');
    expect(f.calls).toEqual(['meta']);
    const g = fake({ state: { lastDataCheck: NOW }, metaGeneratedAt: () => undefined });
    expect(refresh(g.d).meta).toBe('updated');
  });

  it('a successful meta pull prints the one-line push-meta reminder (SPEC §15); a fresh or failed one does not', () => {
    const f = fake({ state: { lastDataCheck: NOW }, metaGeneratedAt: () => NOW - 25 * H });
    refresh(f.d);
    expect(f.logs).toEqual([expect.stringContaining('running npm run meta'), PUSH_META_REMINDER]);
    expect(PUSH_META_REMINDER).toContain('the daily Meta Action normally does this'); expect(PUSH_META_REMINDER).toContain('npm run push-meta');
    const partial = fake({ state: { lastDataCheck: NOW }, metaGeneratedAt: () => undefined, runMeta: () => ({ code: 2, stderr: '' }) });
    refresh(partial.d);
    expect(partial.logs.at(-1)).toBe(PUSH_META_REMINDER);
    const fresh = fake({ state: { lastDataCheck: NOW } });
    refresh(fresh.d);
    expect(fresh.logs).not.toContain(PUSH_META_REMINDER);
    const failed = fake({ state: { lastDataCheck: NOW }, metaGeneratedAt: () => undefined, runMeta: () => ({ code: 1, stderr: 'boom' }) });
    refresh(failed.d);
    expect(failed.logs).not.toContain(PUSH_META_REMINDER);
  });

  it('stale meta without a token → one-line warning, no run', () => {
    const f = fake({ state: { lastDataCheck: NOW }, metaGeneratedAt: () => NOW - 48 * H, hasToken: () => false });
    expect(refresh(f.d).meta).toBe('no-token');
    expect(f.calls).toEqual([]);
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toContain('no COC_DEV_EMAIL/COC_DEV_PASSWORD or COC_API_TOKEN');
  });

  it('403 → one-line warning with the IP hint; exit 2 (partial) still counts as updated', () => {
    const stderr = 'npm notice run coc-planner meta\n\nAPI error: HTTP 403 accessDenied.invalidIp on /locations\n403 usually means…\nProgress is saved…\n';
    const f = fake({ state: { lastDataCheck: NOW }, metaGeneratedAt: () => undefined, runMeta: () => ({ code: 1, stderr }) });
    expect(refresh(f.d).meta).toBe('failed');
    const warn = f.logs.filter((l) => l.includes('warning'));
    expect(warn).toEqual(['[refresh] warning: meta run failed: API error: HTTP 403 accessDenied.invalidIp on /locations (403: the API key is locked to a different IP); starting the site anyway.']);
    const g = fake({ state: { lastDataCheck: NOW }, metaGeneratedAt: () => undefined, runMeta: () => ({ code: 2, stderr: '' }) });
    expect(refresh(g.d).meta).toBe('updated-with-failures');
  });

  it('never throws, whatever a dependency does', () => {
    const boom = () => {
      throw new Error('boom');
    };
    const f = fake({ readState: boom, metaGeneratedAt: boom, runMeta: boom });
    expect(() => refresh(f.d)).not.toThrow();
    expect(f.logs.every((l) => l.startsWith('[refresh] warning:') && !l.includes('\n'))).toBe(true);
  });

  it('version compare and one-line helper', () => {
    expect(isNewerVersion('0.20.0', '0.19.1')).toBe(true);
    expect(isNewerVersion('0.19.10', '0.19.9')).toBe(true);
    expect(isNewerVersion('0.19.1', '0.19.1')).toBe(false);
    expect(isNewerVersion('0.19.0', '0.19.1')).toBe(false);
    expect(isNewerVersion('1.0.0', undefined)).toBe(true);
    expect(oneLine('npm error code E404\n> x\nreal problem\nmore', 'fb')).toBe('real problem');
    expect(oneLine('', 'fallback')).toBe('fallback');
  });
});
