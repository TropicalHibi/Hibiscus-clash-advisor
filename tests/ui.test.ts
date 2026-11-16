// @vitest-environment happy-dom
// UI smoke test: boot main.ts, paste an export, switch to the Plan tab.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
const fixture = fs.readFileSync(path.resolve('tests/fixtures/export-th16.json'), 'utf8');
// Controlled meta (Balloon heavily used, Super Archer credited to Archer) so the UI test doesn't depend on the last meta run.
const meta = JSON.stringify({
  generatedAt: '2026-11-16T12:00:00.000Z', windowDays: 14, halfLifeDays: 5, attacks: 1234, players: 99,
  units: {
    '4000005': { name: 'Balloon', usage: 0.42, threeStarRate: 0.81, avgQty: 6, kind: 'troop' },
    '4000027': { name: 'Super Archer', usage: 0.1, threeStarRate: 0.7, avgQty: 3, kind: 'superTroop', baseId: 4000001 },
  },
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('UI', () => {
  beforeAll(async () => {
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

  it('Lab / Pets / Equipment tab ranks by usage, keeps unused items listed, and pins persist', () => {
    (document.querySelector('[data-tab="lab"]') as HTMLButtonElement).click();
    const tab = document.querySelector('#tab-lab') as HTMLElement;
    expect(tab.hidden).toBe(false);
    expect(tab.textContent).toContain('Laboratory');
    expect(tab.textContent).toContain('Pet House');
    expect(tab.textContent).toContain('Blacksmith');
    const titles = () => [...tab.querySelectorAll('.rank-list')[0].querySelectorAll('.title b')].map((b) => b.textContent);
    expect(titles()[0]).toBe('Archer'); // credited with Super Archer's 10% (Balloon is busy in this fixture)
    expect(tab.textContent).toContain('Includes Super Archer 10%');
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
});
