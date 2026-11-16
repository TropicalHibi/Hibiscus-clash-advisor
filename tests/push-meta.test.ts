// SPEC §15: `npm run push-meta` commits public/meta.json alone and pushes. Fake git only.
import { describe, expect, it } from 'vitest';
import { META_PATH, pushMeta, type PushMetaDeps } from '../scripts/lib/pushMeta';

function fake(opts: { status?: string; branch?: string; meta?: string; pushFails?: boolean } = {}) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const d: PushMetaDeps = {
    git: (args) => {
      calls.push(args);
      if (args[0] === 'status') return opts.status ?? ` M ${META_PATH}\n`;
      if (args[0] === 'rev-parse') return `${opts.branch ?? 'main'}\n`;
      if (args[0] === 'push' && opts.pushFails) throw new Error('Command failed: git push\n! [rejected] main -> main (fetch first)');
      return '';
    },
    readMeta: () => opts.meta ?? JSON.stringify({ generatedAt: '2026-11-16T10:00:00.000Z', units: {} }),
    log: (l) => logs.push(l),
  };
  return { d, calls, logs };
}

describe('push-meta', () => {
  it('commits only public/meta.json with "meta: <generatedAt>" and pushes main', () => {
    const f = fake();
    expect(pushMeta(f.d)).toBe('pushed');
    expect(f.calls).toEqual([
      ['status', '--porcelain', '--', META_PATH],
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['add', '--', META_PATH],
      ['commit', '--only', '-m', 'meta: 2026-11-16T10:00:00.000Z', '--', META_PATH],
      ['push', 'origin', 'main'],
    ]);
  });

  it('does nothing when meta.json is unchanged', () => {
    const f = fake({ status: '' });
    expect(pushMeta(f.d)).toBe('unchanged');
    expect(f.calls).toHaveLength(1);
  });

  it('refuses off main (the site deploys from main) without committing', () => {
    const f = fake({ branch: 'feature' });
    expect(pushMeta(f.d)).toBe('wrong-branch');
    expect(f.calls.some((c) => c[0] === 'commit')).toBe(false);
  });

  it('unreadable meta.json → "meta: unknown"; a rejected push keeps the commit and says so in one line', () => {
    const f = fake({ meta: '{not json', pushFails: true });
    expect(pushMeta(f.d)).toBe('push-failed');
    expect(f.calls.find((c) => c[0] === 'commit')).toContain('meta: unknown');
    expect(f.logs.at(-1)).toMatch(/^\[push-meta\] push failed \(Command failed: git push\)/);
    expect(f.logs.at(-1)).not.toContain('\n');
  });
});
