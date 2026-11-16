// @vitest-environment happy-dom
// With no meta.json (404), the site falls back to Step 1 ordering without errors.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { T0 } from './helpers';

const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
const fixture = fs.readFileSync(path.resolve('tests/fixtures/export-th16.json'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('UI without meta.json', () => {
  afterAll(() => vi.useRealTimers());
  beforeAll(async () => {
    // A fixed clock (only Date is faked, so timers and ticks still run): the plan doesn't depend on today's date.
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['Date'] });
    document.body.innerHTML = html.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/<script[\s\S]*?<\/script>/, '');
    localStorage.clear();
    localStorage.setItem('cocPlanner.exportJson', fixture);
    localStorage.setItem('cocPlanner.importedAt', String(Math.floor(Date.now() / 1000)));
    localStorage.setItem('cocPlanner.tab', 'lab');
    vi.stubGlobal('fetch', async () => new Response('not found', { status: 404 }));
    await import('../src/main');
    await tick();
    await tick();
  });

  it('lab tab shows the fallback note and shortest-first lists', () => {
    const tab = document.querySelector('#tab-lab') as HTMLElement;
    expect(tab.hidden).toBe(false);
    expect(tab.textContent).toContain('No Legend I meta yet');
    expect(tab.querySelectorAll('.rank-item').length).toBeGreaterThan(0);
    expect(document.querySelector('#footer')!.textContent).toContain('Legend I meta: none yet');
  });

  it('plan tab still renders', () => {
    (document.querySelector('[data-tab="plan"]') as HTMLButtonElement).click();
    expect(document.querySelector('#tab-plan')!.textContent).toContain('Resources needed');
  });
});
