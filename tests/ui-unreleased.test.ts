// @vitest-environment happy-dom
// Import tab: unknown level-1 equipment is listed once under "Unrecognized items (likely unreleased)" and
// isn't a Plan-tab warning.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { T0 } from './helpers';

const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
const ex = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/export-th16.json'), 'utf8'));
ex.equipment.push({ data: 90000098, lvl: 1 }, { data: 90000097, lvl: 3 });
const tick = () => new Promise((r) => setTimeout(r, 0));
const $ = (s: string) => document.querySelector(s) as HTMLElement;

describe('Import tab: unrecognized items', () => {
  afterAll(() => vi.useRealTimers());
  beforeAll(async () => {
    vi.useFakeTimers({ now: T0 * 1000, toFake: ['Date'] });
    document.body.innerHTML = html.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '').replace(/<script[\s\S]*?<\/script>/, '');
    localStorage.clear();
    localStorage.setItem('cocPlanner.exportJson', JSON.stringify(ex));
    localStorage.setItem('cocPlanner.importedAt', String(T0));
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    await import('../src/main');
    await tick();
    await tick();
  });

  it('lists level-1 unknown equipment once in the Import tab; the Plan tab warns only about the rest', () => {
    $('[data-tab="import"]').click();
    const note = $('#unrecognized-items');
    expect(note.textContent).toContain('Unrecognized items (likely unreleased): equipment 90000098 (level 1)');
    expect(note.textContent).not.toContain('90000097');
    expect(document.querySelectorAll('#unrecognized-items')).toHaveLength(1);
    $('[data-tab="plan"]').click();
    const plan = $('#tab-plan').textContent!;
    expect(plan).not.toContain('Unknown dataId 90000098');
    expect(plan).toContain('Unknown dataId 90000097'); // level 3: still a warning
  });
});
