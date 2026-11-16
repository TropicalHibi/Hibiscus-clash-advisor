// @vitest-environment happy-dom
// UI smoke test: boot main.ts, paste an export, switch to the Plan tab.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { T0 } from './helpers';

const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
const fixture = fs.readFileSync(path.resolve('tests/fixtures/export-th16.json'), 'utf8');
// Controlled meta (Balloon heavily used, Super Archer credited to Archer) so the UI test doesn't depend on the last meta run.
const meta = JSON.stringify({
  generatedAt: '2026-11-16T12:00:00.000Z', windowDays: 14, halfLifeDays: 5, attacks: 1234, players: 99,
  units: {
    '4000005': { name: 'Balloon', usage: 0.42, threeStarRate: 0.81, avgQty: 6, armyShare: 0.2, kind: 'troop' },
    '4000027': { name: 'Super Archer', usage: 0.1, threeStarRate: 0.7, avgQty: 3, armyShare: 0.05, kind: 'superTroop', baseId: 4000001 },
  },
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('UI', () => {
  afterAll(() => vi.useRealTimers());
  beforeAll(async () => {
    // A fixed clock (only Date is faked, so timers and ticks still run): the plan doesn't depend on today's date.
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['Date'] });
    document.body.innerHTML = html.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/<script[\s\S]*?<\/script>/, '');
    localStorage.clear();
    vi.stubGlobal('fetch', async () => new Response(meta, { status: 200 }));
    await import('../src/main');
    await tick();
    await tick();
  });

  it('starts on Import when nothing is saved, with the data version in the footer', () => {
    expect((document.querySelector('#tab-import') as HTMLElement).hidden).toBe(false);
    expect(document.querySelector('#footer')!.textContent).toContain('clash-of-clans-data v');
  });

  it('shows a clear error for bad input', () => {
    (document.querySelector('#export-text') as HTMLTextAreaElement).value = '{nope';
    (document.querySelector('#btn-import') as HTMLButtonElement).click();
    expect(document.querySelector('.msg.error')!.textContent).toContain('Not valid JSON');
  });

  it('imports, persists to localStorage, and renders the plan', () => {
    (document.querySelector('#export-text') as HTMLTextAreaElement).value = fixture;
    (document.querySelector('#btn-import') as HTMLButtonElement).click();
    expect(document.querySelector('.msg.ok')!.textContent).toContain('Imported TH16');
    expect(document.querySelector('#tab-import')!.textContent).toContain('Rush mode');
    expect(localStorage.getItem('cocPlanner.exportJson')).toBeTruthy();

    (document.querySelector('[data-tab="plan"]') as HTMLButtonElement).click();
    const plan = document.querySelector('#tab-plan') as HTMLElement;
    expect(plan.hidden).toBe(false);
    expect(plan.textContent).toContain('Rush mode');
    expect(plan.textContent).toContain('Town Hall');
    expect(plan.textContent).toContain('Resources needed');
    expect(plan.textContent).toContain('Overflow → walls');
    expect(plan.querySelectorAll('.slot-card').length).toBeGreaterThanOrEqual(6);
  });

  it('Gold Pass toggle persists to settings', () => {
    (document.querySelector('[data-tab="import"]') as HTMLButtonElement).click();
    const max = document.querySelector('input[name="gp"][value="max"]') as HTMLInputElement;
    max.checked = true;
    max.dispatchEvent(new Event('change'));
    expect(JSON.parse(localStorage.getItem('cocPlanner.settings')!).goldPass).toBe('max');
  });

  it('footer shows the meta date and attack count', () => {
    expect(document.querySelector('#footer')!.textContent).toContain('1,234 attacks');
  });

  it('Lab / Pets / Equipment tab ranks by army share, keeps unused items listed, and pins persist', () => {
    (document.querySelector('[data-tab="lab"]') as HTMLButtonElement).click();
    const tab = document.querySelector('#tab-lab') as HTMLElement;
    expect(tab.hidden).toBe(false);
    expect(tab.textContent).toContain('Laboratory');
    expect(tab.textContent).toContain('Pet House');
    expect(tab.textContent).toContain('Blacksmith');
    const titles = () => [...tab.querySelectorAll('.rank-list')[0].querySelectorAll('.title b')].map((b) => b.textContent);
    expect(titles()[0]).toBe('Archer'); // credited with Super Archer's 10% (Balloon is busy in this fixture)
    expect(tab.textContent).toContain('Includes Super Archer 5.0% of space, 10% used');
    const first = tab.querySelectorAll('.rank-list')[0].querySelector('.rank-item')!.textContent!;
    expect(first).toContain('5.0% of troop space'); // the score
    expect(first).toContain('10% used'); // usage stays visible
    expect(first).toContain('70% 3★');
    expect(tab.textContent).toContain('Not seen in Legend I'); // unused items still listed
    expect(titles()).toContain('Barbarian');

    const pin = tab.querySelector('[data-pin="lab"][data-id="barbarian"]') as HTMLButtonElement;
    pin.click();
    expect(titles()[0]).toBe('Barbarian');
    expect(JSON.parse(localStorage.getItem('cocPlanner.settings')!).lab.pinned).toEqual(['barbarian']);
    (tab.querySelector('[data-pin="lab"][data-id="barbarian"]') as HTMLButtonElement).click();
    expect(titles()[0]).toBe('Archer');
    expect(JSON.parse(localStorage.getItem('cocPlanner.settings')!).lab.pinned).toEqual([]);
  });

  it('Lab tab: "Next in lab" line and Troops / Spells / Sieges sections', () => {
    (document.querySelector('[data-tab="lab"]') as HTMLButtonElement).click();
    const tab = document.querySelector('#tab-lab') as HTMLElement;
    const heads = [...tab.querySelectorAll('h2')].map((h) => h.textContent!);
    expect(heads.slice(0, 3).map((h) => h.split(' ').slice(0, 3).join(' '))).toEqual(['Laboratory · Troops', 'Laboratory · Spells', 'Laboratory · Sieges']);
    const next = tab.querySelector('.next-lab')!.textContent!.replace(/\s+/g, ' ');
    // Archer: Super Archer 5% of troop space ÷ Legend I top troop (Balloon 20%) = 0.25 × troop weight 1.
    expect(next).toContain('Next in lab: Archer');
    expect(next).toContain('troop · pick value 0.25 vs top spell');
    expect(next).toMatch(/top siege .+ 0\.00/);
    expect(next).toContain('starts when Balloon 4 finishes'); // the Laboratory is busy in this fixture
    // Spells and sieges have their own sections, ranked within kind.
    const spellTitles = [...tab.querySelectorAll('.rank-list')[1].querySelectorAll('.title b')].map((b) => b.textContent);
    expect(spellTitles.length).toBeGreaterThan(0);
  });

  it('an export without a timestamp counts timers from the import time and says so', () => {
    (document.querySelector('[data-tab="import"]') as HTMLButtonElement).click();
    const noTs = JSON.parse(fixture);
    delete noTs.timestamp;
    (document.querySelector('#export-text') as HTMLTextAreaElement).value = JSON.stringify(noTs);
    (document.querySelector('#btn-import') as HTMLButtonElement).click();
    expect(document.querySelector('#tab-import')!.textContent).toContain('no timestamp in export');
    (document.querySelector('[data-tab="plan"]') as HTMLButtonElement).click();
    const text = document.querySelector('#tab-plan')!.textContent!;
    expect(text).toContain('Export has no timestamp; timers count from the import at');
    expect(text).not.toContain('timers count from the import time'); // the engine's generic line is replaced
    // Put the timestamped fixture back for the remaining tests.
    (document.querySelector('[data-tab="import"]') as HTMLButtonElement).click();
    (document.querySelector('#export-text') as HTMLTextAreaElement).value = fixture;
    (document.querySelector('#btn-import') as HTMLButtonElement).click();
  });

  it('lab kind weights are editable in Settings and persist', () => {
    (document.querySelector('[data-tab="import"]') as HTMLButtonElement).click();
    const inp = document.querySelector('input[data-weight="siege"]') as HTMLInputElement;
    expect(inp.value).toBe('0.5');
    inp.value = '1.2';
    inp.dispatchEvent(new Event('change'));
    expect(JSON.parse(localStorage.getItem('cocPlanner.settings')!).lab.kindWeights).toEqual({ troop: 1, spell: 0.7, siege: 1.2 });
    inp.value = '-3';
    inp.dispatchEvent(new Event('change'));
    expect(inp.value).toBe('1.2'); // rejected
    (document.querySelector('[data-tab="lab"]') as HTMLButtonElement).click();
    expect(document.querySelector('#tab-lab')!.textContent).toContain('sieges 1.2');
  });
});
