// @vitest-environment happy-dom
// UI smoke test: boot main.ts, paste an export, switch to the Plan tab.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
const fixture = fs.readFileSync(path.resolve('tests/fixtures/export-th16.json'), 'utf8');
const meta = fs.readFileSync(path.resolve('public/meta.json'), 'utf8');

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
});
