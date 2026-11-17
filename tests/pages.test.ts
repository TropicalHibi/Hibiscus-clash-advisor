// SPEC §15: GitHub Pages hosting. The Pages base applies only to `--mode pages`, and CI never
// runs anything that needs the API token (predev refresh, meta, sync).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import config, { PAGES_BASE } from '../vite.config';
import { readWorkflow, workflowCode } from './workflow';

const resolve = (mode: string, command: 'build' | 'serve') =>
  (config as unknown as (env: { mode: string; command: string }) => { base?: string })({ mode, command });

describe('GitHub Pages', () => {
  it('uses the repo base only for the pages build', () => {
    expect(PAGES_BASE).toBe('/Hibiscus-clash-advisor/');
    expect(resolve('pages', 'build').base).toBe(PAGES_BASE);
    expect(resolve('production', 'build').base).toBe('/');
    expect(resolve('development', 'serve').base).toBe('/');
  });

  it('the workflow tests (rules, then the mutated data) before building and never runs the refresh, meta or sync', () => {
    const wf = workflowCode('pages.yml');
    const runs = [...wf.matchAll(/^\s*- run: (.+)$/gm)].map((m) => m[1].trim());
    expect(runs).toEqual(['npm ci', 'npm run test:ci', 'npm run test:mutated', 'npm run build:pages']);
    expect(wf).not.toMatch(/npm run (dev|meta|sync|refresh|push-meta)\b|COC_API_TOKEN/);
  });

  it('pages / id-token write only on the deploy job; no persisted checkout token', () => {
    const wf = workflowCode('pages.yml');
    const [top, jobs] = wf.split(/^jobs:$/m);
    expect(top).not.toMatch(/pages: write|id-token: write/);
    const [build, deploy] = jobs.split(/^ {2}deploy:$/m);
    expect(build).not.toMatch(/pages: write|id-token: write/);
    expect(build).toMatch(/persist-credentials: false/);
    expect(deploy).toMatch(/permissions:\s*\n\s*pages: write\s*\n\s*id-token: write/);
  });

  it('caches the resized item icons between runs', () => {
    const wf = readWorkflow('pages.yml');
    expect(wf).toMatch(/uses: actions\/cache@v\d+[\s\S]*?path: \.cache\/item-images/);
  });

  it('npm test runs everything; test:ci leaves out only the facts about today\'s data', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.scripts['test:ci']).toBe('vitest run --exclude tests/current-data.test.ts');
    expect(pkg.scripts['test:mutated']).toBe('tsx scripts/test-mutated.ts');
  });
});
