// @vitest-environment happy-dom
// Step 3 UI: "Game data updated" banner, Everything tab, hero order drag / buttons / reset, the
// "Simulate helpers" toggle and item images.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { data, T0 } from './helpers';

const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
const fixture = fs.readFileSync(path.resolve('tests/fixtures/export-th16.json'), 'utf8');
const changes = {
  version: data.version,
  previousVersion: '0.19.0',
  date: '2026-11-16',
  changes: [
    { kind: 'time', key: '1000009', item: 'Archer Tower', level: 21, text: 'Archer Tower 21: 18d → 16d' },
    { kind: 'newLevel', key: '1000071', item: 'Hero Hall', level: 13, text: 'NEW: Hero Hall 13 (20M elixir, 15d)' },
  ],
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const click = (s: string) => $<HTMLButtonElement>(s).click();
const heroNames = () => [...document.querySelectorAll('.hero-order .name')].map((n) => n.textContent!.replace(/ ·.*$/, '').trim());

describe('Step 3 UI', () => {
  afterAll(() => vi.useRealTimers());
  beforeAll(async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['Date'] });
    document.body.innerHTML = html.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/<script[\s\S]*?<\/script>/, '');
    localStorage.clear();
    localStorage.setItem('cocPlanner.exportJson', fixture);
    localStorage.setItem('cocPlanner.importedAt', String(T0));
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).endsWith('data-changes.json') ? new Response(JSON.stringify(changes), { status: 200 }) : new Response('{}', { status: 404 }),
    );
    await import('../src/main');
    await tick();
    await tick();
  });

  it('shows the "Game data updated" banner on the Plan tab with the change list, until dismissed', () => {
    click('[data-tab="plan"]');
    const banner = $('#data-banner');
    expect(banner.textContent).toContain('Game data updated: 2 changes');
    expect(banner.textContent).toContain('Archer Tower 21: 18d → 16d');
    expect(banner.textContent).toContain('NEW: Hero Hall 13');
    click('#dismiss-banner');
    expect(document.querySelector('#data-banner')).toBeNull();
    expect(localStorage.getItem('cocPlanner.dataChangesSeen')).toBe(data.version);
    click('[data-tab="lab"]');
    click('[data-tab="plan"]');
    expect(document.querySelector('#data-banner')).toBeNull();
    expect($('#footer').textContent).toContain('(synced 2026-11-16)');
  });

  it('renders item images lazily at a fixed size, removing themselves on error', () => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>('#tab-plan img.ico')];
    expect(imgs.length).toBeGreaterThan(3);
    for (const img of imgs) {
      expect(img.getAttribute('loading')).toBe('lazy');
      expect(Number(img.getAttribute('width'))).toBeGreaterThan(0);
      expect(img.getAttribute('height')).toBe(img.getAttribute('width'));
      expect(img.getAttribute('alt')).toBe('');
      expect(img.getAttribute('onerror')).toBe('this.remove()');
    }
    click('[data-tab="lab"]');
    expect(document.querySelectorAll('#tab-lab .rank-item img.ico').length).toBeGreaterThan(3);
  });

  it('Everything tab: totals on top and one collapsible section per tier', () => {
    click('[data-tab="everything"]');
    const tab = $('#tab-everything');
    expect(tab.hidden).toBe(false);
    expect(tab.textContent).toContain('time to max at TH16');
    const sections = [...tab.querySelectorAll('details.ev-group')];
    expect(sections.length).toBeGreaterThanOrEqual(6);
    const titles = sections.map((s) => s.querySelector('.ev-title')!.textContent);
    expect(titles).toContain('T0 · Laboratory + new buildings + Archer Queen');
    expect(titles).toContain('Laboratory');
    expect(titles).toContain('Pet House');
    expect(titles).toContain('Blacksmith (equipment)');
    expect(tab.textContent).toContain('with Gold Pass');
    expect(tab.querySelectorAll('.ev-item img.ico').length).toBeGreaterThan(0);
  });

  it('hero order: ↑/↓ buttons, drag and drop, and reset to default', () => {
    click('[data-tab="import"]');
    expect(heroNames()[0]).toBe('Archer Queen');
    expect($('#tab-import').textContent).toContain('belongs to the Queen herself');
    expect($<HTMLButtonElement>('#btn-hero-reset').disabled).toBe(true);
    click('[data-move="0"][data-dir="1"]');
    expect(heroNames().slice(0, 2)).toEqual(['Grand Warden', 'Archer Queen']);

    const items = () => [...document.querySelectorAll<HTMLLIElement>('.hero-order li')];
    items()[5].dispatchEvent(new Event('dragstart'));
    items()[0].dispatchEvent(new Event('drop'));
    expect(heroNames()[0]).toBe('Minion Prince');
    const saved = JSON.parse(localStorage.getItem('cocPlanner.settings')!).heroOrder;
    expect(saved[0]).toBe('minion-prince');

    click('#btn-hero-reset');
    expect(heroNames()).toEqual(['Archer Queen', 'Grand Warden', 'Dragon Duke', 'Barbarian King', 'Royal Champion', 'Minion Prince']);
    expect(JSON.parse(localStorage.getItem('cocPlanner.settings')!).heroOrder[0]).toBe('archer-queen');
  });

  it('"Simulate helpers and boosts" toggle persists (default on)', () => {
    const box = $<HTMLInputElement>('#sim-helpers');
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(JSON.parse(localStorage.getItem('cocPlanner.settings')!).simulateHelpers).toBe(false);
  });
});
