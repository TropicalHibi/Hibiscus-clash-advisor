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
    // A saved order from before the lock, with the Queen second: normalized to put her first.
    localStorage.setItem('cocPlanner.settings', JSON.stringify({ heroOrder: ['grand-warden', 'archer-queen', 'dragon-duke', 'barbarian-king', 'royal-champion', 'minion-prince'] }));
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

  const items = () => [...document.querySelectorAll<HTMLLIElement>('.hero-order li')];

  it('hero order: a saved order with the Queen elsewhere shows her first', () => {
    click('[data-tab="import"]');
    expect(heroNames()).toEqual(['Archer Queen', 'Grand Warden', 'Dragon Duke', 'Barbarian King', 'Royal Champion', 'Minion Prince']);
    expect($<HTMLButtonElement>('#btn-hero-reset').disabled).toBe(true); // normalized = the default order
  });

  it('hero order: the Archer Queen is locked at 1 (greyed, no drag handle, no ↑/↓) and the help text says why', () => {
    const q = items()[0];
    expect(q.classList.contains('locked')).toBe(true);
    expect(q.getAttribute('aria-disabled')).toBe('true');
    expect(q.getAttribute('draggable')).toBeNull();
    expect(q.querySelector('.grip')!.textContent).toBe('');
    expect(q.querySelectorAll('button')).toHaveLength(0);
    expect(q.textContent).toContain('locked');
    expect($('#tab-import').textContent).toContain('The Archer Queen is locked at position 1 because of her Tier 0 rule');
    // The others are reorderable; #2 can't move up (above the Queen).
    for (const li of items().slice(1)) {
      expect(li.getAttribute('draggable')).toBe('true');
      expect(li.querySelector('.grip')!.textContent).toBe('⋮⋮');
      expect(li.querySelectorAll('button')).toHaveLength(2);
    }
    expect($<HTMLButtonElement>('[data-move="1"][data-dir="-1"]').disabled).toBe(true);
    expect($<HTMLButtonElement>('[data-move="2"][data-dir="-1"]').disabled).toBe(false);
  });

  it('hero order: ↑/↓ and drag reorder the other five; nothing lands above the Queen', () => {
    click('[data-move="1"][data-dir="1"]');
    expect(heroNames().slice(0, 3)).toEqual(['Archer Queen', 'Dragon Duke', 'Grand Warden']);
    click('[data-move="2"][data-dir="-1"]');
    expect(heroNames().slice(0, 3)).toEqual(['Archer Queen', 'Grand Warden', 'Dragon Duke']);

    // Drag Minion Prince onto the Queen's row: the locked row isn't a drop target → unchanged.
    items()[5].dispatchEvent(new Event('dragstart'));
    items()[0].dispatchEvent(new Event('drop'));
    items()[5].dispatchEvent(new Event('dragend'));
    expect(heroNames()[0]).toBe('Archer Queen');
    expect(heroNames()[5]).toBe('Minion Prince');
    // Dragging the Queen does nothing either (she's no drag source), and the earlier drag left nothing behind.
    items()[0].dispatchEvent(new Event('dragstart'));
    items()[3].dispatchEvent(new Event('drop'));
    expect(heroNames()).toEqual(['Archer Queen', 'Grand Warden', 'Dragon Duke', 'Barbarian King', 'Royal Champion', 'Minion Prince']);

    // Drop on #2: Minion Prince becomes #2, right below the Queen.
    items()[5].dispatchEvent(new Event('dragstart'));
    items()[1].dispatchEvent(new Event('drop'));
    expect(heroNames().slice(0, 2)).toEqual(['Archer Queen', 'Minion Prince']);
    const saved = JSON.parse(localStorage.getItem('cocPlanner.settings')!).heroOrder;
    expect(saved.slice(0, 2)).toEqual(['archer-queen', 'minion-prince']);
  });

  it('hero order: text dragged in from outside the list (e.g. "3") is no drop target and never reorders (REVIEW-2 #11)', () => {
    const before = heroNames();
    const external = (type: string) => {
      const ev = new Event(type, { cancelable: true }) as Event & { dataTransfer: unknown };
      ev.dataTransfer = { getData: () => '3', setData: () => {} };
      return ev;
    };
    const over = external('dragover');
    items()[1].dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false); // not accepted as a drop target
    expect(items()[1].classList.contains('drop-target')).toBe(false);
    items()[1].dispatchEvent(external('drop'));
    expect(heroNames()).toEqual(before);
  });

  it('hero order: reset to default keeps the Queen at 1', () => {
    expect($<HTMLButtonElement>('#btn-hero-reset').disabled).toBe(false);
    click('#btn-hero-reset');
    expect(heroNames()).toEqual(['Archer Queen', 'Grand Warden', 'Dragon Duke', 'Barbarian King', 'Royal Champion', 'Minion Prince']);
    expect(JSON.parse(localStorage.getItem('cocPlanner.settings')!).heroOrder[0]).toBe('archer-queen');
    expect(items()[0].classList.contains('locked')).toBe(true);
  });

  it('"Simulate helpers and boosts" toggle persists (default on)', () => {
    const box = $<HTMLInputElement>('#sim-helpers');
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(JSON.parse(localStorage.getItem('cocPlanner.settings')!).simulateHelpers).toBe(false);
  });
});
