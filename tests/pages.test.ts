// SPEC §15: GitHub Pages hosting. The Pages base applies only to `--mode pages`, and CI never
// runs anything that needs the API token (predev refresh, meta, sync).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import config, { PAGES_BASE } from '../vite.config';

const resolve = (mode: string, command: 'build' | 'serve') =>
  (config as unknown as (env: { mode: string; command: string }) => { base?: string })({ mode, command });

describe('GitHub Pages', () => {
  it('uses the repo base only for the pages build', () => {
    expect(PAGES_BASE).toBe('/Hibiscus-clash-advisor/');
    expect(resolve('pages', 'build').base).toBe(PAGES_BASE);
    expect(resolve('production', 'build').base).toBe('/');
    expect(resolve('development', 'serve').base).toBe('/');
  });

  it('the workflow tests before building and never runs the refresh, meta or sync', () => {
    const wf = fs.readFileSync('.github/workflows/pages.yml', 'utf8').replace(/#.*$/gm, '');
    const runs = [...wf.matchAll(/^\s*- run: (.+)$/gm)].map((m) => m[1].trim());
    expect(runs).toEqual(['npm ci', 'npm test', 'npm run build:pages']);
    expect(wf).not.toMatch(/npm run (dev|meta|sync|refresh|push-meta)\b|COC_API_TOKEN/);
  });
});
