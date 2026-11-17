import './style.css';
import { loadGameDataBrowser } from './data/loadBrowser';
import { dataSourceLabel } from './data/source';
import type { GameData } from './data/types';
import { fmtClock } from './engine/format';
import type { DataChangesFile } from './data/snapshot';
import { buildEverything } from './engine/everything';
import { buildPlan } from './engine/plan';
import { detectMode } from './engine/tiers';
import { coerceMeta, EMPTY_META, type MetaFile } from './meta/meta';
import { parseExport, ExportParseError, type AccountState } from './state/parseExport';
import { DEFAULT_HERO_ORDER, heroOrder, LOCKED_HERO, moveHero, settingsFromYaml, type Settings } from './state/settings';
import { renderEverything } from './ui/everythingView';
import { renderLab, type PinList } from './ui/labView';
import { icon } from './ui/images';
import { esc, renderPlan } from './ui/planView';
import { storage } from './ui/storage';
import settingsYaml from '../config/settings.sample.yaml?raw';

const DEFAULTS = settingsFromYaml(settingsYaml);

let data: GameData;
let meta: MetaFile = EMPTY_META;
let dataChanges: DataChangesFile | null = null;
let settings: Settings = storage.loadSettings(DEFAULTS);
let account: AccountState | null = null;
let importedAt = 0;
let loadError = '';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

function loadAccount(): void {
  const saved = storage.loadExport();
  if (!saved) return;
  try {
    account = parseExport(saved.json, data);
    importedAt = saved.importedAt;
  } catch (e) {
    loadError = `Saved export could not be read: ${(e as Error).message}`;
    account = null;
  }
}

function heroName(id: string): string {
  return data.byId.get(id)?.name ?? id;
}

// ── Tabs ──
const TABS = ['plan', 'lab', 'everything', 'import'];
function showTab(tab: string): void {
  if (!TABS.includes(tab)) tab = 'plan';
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== tab;
  storage.saveTab(tab);
  if (tab === 'plan') renderPlanTab();
  else if (tab === 'lab') renderLabTab();
  else if (tab === 'everything') renderEverythingTab();
  else renderImportTab();
}

// ── Everything tab (SPEC §11.4) ──
// A full scheduler run to max: computed when the tab opens (not on the 60 s refresh; it changes slowly).
function renderEverythingTab(): void {
  const el = $('#tab-everything');
  if (!account) {
    el.innerHTML = `<div class="card empty"><p>No account loaded yet.</p><button class="btn" id="go-import-ev">Paste your export</button></div>`;
    el.querySelector('#go-import-ev')?.addEventListener('click', () => showTab('import'));
    return;
  }
  try {
    el.innerHTML = renderEverything(buildEverything(data, accountWithBaseline(account), settings, meta, Math.floor(Date.now() / 1000)));
  } catch (e) {
    el.innerHTML = `<div class="card warn">Could not list the remaining upgrades: ${esc((e as Error).message)}</div>`;
    console.error(e);
  }
}

// ── "Game data updated" banner (SPEC §9): shown on the Plan tab for a new data version until dismissed ──
function dataChangesBanner(): string {
  const dc = dataChanges;
  if (!dc || dc.version !== data.version || !dc.changes.length || storage.loadDataChangesSeen() === dc.version) return '';
  return `<div class="card banner" id="data-banner">
    <div class="row"><b>Game data updated: ${dc.changes.length} change${dc.changes.length === 1 ? '' : 's'}</b>
      <span class="small muted">clash-of-clans-data ${esc(dc.previousVersion)} → ${esc(dc.version)}</span>
      <button class="btn secondary small" id="dismiss-banner">Dismiss</button></div>
    <details><summary class="small">Show changes</summary><ul class="small changes">${dc.changes.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul></details>
  </div>`;
}

/** The account with a timer baseline (paste time when the export has no timestamp). */
function accountWithBaseline(a: AccountState): AccountState {
  return a.exportTimestamp ? a : { ...a, exportTimestamp: importedAt };
}

// ── Lab / Pets / Equipment tab ──
function renderLabTab(): void {
  const el = $('#tab-lab');
  if (!account) {
    el.innerHTML = `<div class="card empty"><p>No account loaded yet.</p><button class="btn" id="go-import-lab">Paste your export</button></div>`;
    el.querySelector('#go-import-lab')?.addEventListener('click', () => showTab('import'));
    return;
  }
  try {
    const plan = buildPlan(data, accountWithBaseline(account), settings, meta, Math.floor(Date.now() / 1000));
    el.innerHTML = renderLab(plan, meta, heroName, settings.lab.kindWeights);
  } catch (e) {
    el.innerHTML = `<div class="card warn">Could not rank upgrades: ${esc((e as Error).message)}</div>`;
    console.error(e);
    return;
  }
  el.querySelectorAll<HTMLButtonElement>('[data-pin]').forEach((b) =>
    b.addEventListener('click', () => {
      const list = b.dataset.pin as PinList;
      const id = b.dataset.id!;
      const pins = settings[list].pinned;
      // Newest pin goes first; unpinning removes it.
      const next = pins.includes(id) ? pins.filter((x) => x !== id) : [id, ...pins];
      settings = { ...settings, [list]: { ...settings[list], pinned: next } };
      storage.saveSettings(settings);
      renderLabTab();
    }),
  );
}

// ── Plan tab ──
function renderPlanTab(): void {
  const el = $('#tab-plan');
  if (!account) {
    el.innerHTML = `<div class="card empty">${loadError ? `<p class="warn">${esc(loadError)}</p>` : ''}
      <p>No account loaded yet.</p><button class="btn" id="go-import">Paste your export</button></div>`;
    el.querySelector('#go-import')?.addEventListener('click', () => showTab('import'));
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  // No timestamp in the export → timers count down from the paste time (SPEC §3.2).
  const acct = accountWithBaseline(account);
  try {
    const plan = buildPlan(data, acct, settings, meta, nowSec);
    if (!account.exportTimestamp) plan.warnings.unshift(`Export has no timestamp; timers count from the import at ${fmtClock(importedAt, nowSec)}.`);
    plan.warnings = plan.warnings.filter((w) => !w.startsWith('Export has no timestamp; timers count from the import time'));
    el.innerHTML = dataChangesBanner() + renderPlan(plan);
    el.querySelector('#dismiss-banner')?.addEventListener('click', () => {
      if (dataChanges) storage.saveDataChangesSeen(dataChanges.version);
      el.querySelector('#data-banner')?.remove();
    });
  } catch (e) {
    el.innerHTML = `<div class="card warn">Could not build a plan: ${esc((e as Error).message)}</div>`;
    console.error(e);
  }
}

// ── Import & Settings tab ──
function renderImportTab(msg?: { text: string; kind: 'ok' | 'error' }): void {
  const el = $('#tab-import');
  const saved = storage.loadExport();
  const status = account
    ? `<p class="small">Loaded <b>${esc(account.tag ?? 'account')}</b>: TH${account.townHall} → <b>${detectMode(account.townHall, data) === 'rush' ? 'Rush' : 'Max-TH'} mode</b> (max TH in data: ${data.maxTH}). Imported ${esc(new Date(importedAt * 1000).toLocaleString())}${account.exportTimestamp ? `, export taken ${esc(new Date(account.exportTimestamp * 1000).toLocaleString())}` : ', no timestamp in export'}.</p>`
    : '<p class="small muted">No account loaded.</p>';
  el.innerHTML = `
    <h2>Import</h2>
    <div class="card">
      <p class="small muted" style="margin-top:0">In game: Settings → More Settings → Data Export → copy. Paste the JSON here.</p>
      <textarea id="export-text" spellcheck="false" placeholder='{"tag": "#...", "timestamp": ..., "buildings": [...]}'></textarea>
      <div class="row">
        <button class="btn" id="btn-import">Import</button>
        ${saved ? '<button class="btn secondary" id="btn-clear">Clear saved export</button>' : ''}
      </div>
      ${msg ? `<div class="msg ${msg.kind}">${esc(msg.text)}</div>` : ''}
      ${status}
    </div>

    <h2>Settings</h2>
    <div class="card">
      <div><b>Gold Pass</b></div>
      <div class="row" style="margin-top:6px">
        <span class="seg">
          <label><input type="radio" name="gp" value="none" ${settings.goldPass === 'none' ? 'checked' : ''}><span>No Gold Pass</span></label>
          <label><input type="radio" name="gp" value="max" ${settings.goldPass === 'max' ? 'checked' : ''}><span>Max Gold Pass</span></label>
        </span>
      </div>
      <p class="small muted">Max applies the builder boost to builder upgrades (including supercharges) and the research boost to lab and pet upgrades. Running timers are never changed.</p>
    </div>
    <div class="card">
      <label class="toggle"><input type="checkbox" id="sim-helpers" ${settings.simulateHelpers ? 'checked' : ''}> <b>Simulate helpers and boosts</b></label>
      <p class="small muted">On: the Builder's Apprentice and Lab Assistant from your export each take their work rate (hours) off one job once a day: the job they're set to repeat on, else the builder job with the most time left / the running research. Active potions from the export speed up their queue. Off: raw timers only (to compare).</p>
    </div>
    <div class="card">
      <div><b>Lab pick weights</b> <span class="small muted">(score ÷ Legend I top of its kind × weight; 0 = never auto-pick that kind)</span></div>
      <div class="row" style="margin-top:6px">
        ${(['troop', 'spell', 'siege'] as const)
          .map((k) => `<label class="small">${k === 'troop' ? 'Troops' : k === 'spell' ? 'Spells' : 'Sieges'} <input type="number" class="weight" data-weight="${k}" min="0" max="10" step="0.1" value="${settings.lab.kindWeights[k]}" style="width:5em"></label>`)
          .join('')}
      </div>
    </div>
    <div class="card">
      <div><b>Hero order</b> <span class="small muted">(drag to reorder, or use ↑ / ↓)</span></div>
      <p class="small muted">The order of the Heroes tier. The Archer Queen is locked at position 1 because of her Tier 0 rule: she's upgraded until book-ready, right after the Laboratory and new buildings. The other heroes can be reordered below her.</p>
      <ol class="hero-order">
        ${settings.heroOrder
          .map((id, i) =>
            id === LOCKED_HERO
              ? `<li class="locked" data-idx="${i}" aria-disabled="true" title="Locked at position 1 (Tier 0 rule)"><span class="grip" aria-hidden="true"></span><span class="n">${i + 1}</span>${icon(data.byId.get(id)?.key ?? '', 24)}<span class="name">${esc(heroName(id))} <span class="small muted">· Tier 0 · locked</span></span></li>`
              : `<li draggable="true" data-idx="${i}"><span class="grip" aria-hidden="true">⋮⋮</span><span class="n">${i + 1}</span>${icon(data.byId.get(id)?.key ?? '', 24)}<span class="name">${esc(heroName(id))}</span>
          <button class="icon" data-move="${i}" data-dir="-1" ${i === 0 || settings.heroOrder[i - 1] === LOCKED_HERO ? 'disabled' : ''} aria-label="Move ${esc(heroName(id))} up">↑</button>
          <button class="icon" data-move="${i}" data-dir="1" ${i === settings.heroOrder.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(heroName(id))} down">↓</button></li>`,
          )
          .join('')}
      </ol>
      <div class="row"><button class="btn secondary" id="btn-hero-reset" ${settings.heroOrder.join() === DEFAULT_HERO_ORDER.join() ? 'disabled' : ''}>Reset hero order to default</button></div>
    </div>
    <div class="row"><button class="btn secondary" id="btn-reset">Reset settings to defaults</button></div>
  `;

  el.querySelector('#btn-import')!.addEventListener('click', () => {
    const text = (el.querySelector('#export-text') as HTMLTextAreaElement).value;
    try {
      const parsed = parseExport(text, data);
      const now = Math.floor(Date.now() / 1000);
      const ok = storage.saveExport(text.trim(), now);
      account = parsed;
      importedAt = now;
      loadError = '';
      const unresolved = parsed.unresolved.length ? ` ${parsed.unresolved.length} unknown id(s) ignored.` : '';
      renderImportTab({ text: `Imported TH${parsed.townHall}.${unresolved}${ok ? '' : ' (Could not save to browser storage; it will be lost on reload.)'}`, kind: 'ok' });
    } catch (e) {
      renderImportTab({ text: e instanceof ExportParseError ? e.message : `Import failed: ${(e as Error).message}`, kind: 'error' });
    }
  });
  el.querySelector('#btn-clear')?.addEventListener('click', () => {
    storage.clearExport();
    account = null;
    renderImportTab({ text: 'Saved export cleared.', kind: 'ok' });
  });
  el.querySelectorAll<HTMLInputElement>('input[name="gp"]').forEach((r) =>
    r.addEventListener('change', () => {
      settings = { ...settings, goldPass: r.value === 'max' ? 'max' : 'none' };
      storage.saveSettings(settings);
    }),
  );
  el.querySelectorAll<HTMLInputElement>('[data-weight]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const k = inp.dataset.weight as keyof Settings['lab']['kindWeights'];
      const v = Number(inp.value);
      if (!Number.isFinite(v) || v < 0) {
        inp.value = String(settings.lab.kindWeights[k]);
        return;
      }
      settings = { ...settings, lab: { ...settings.lab, kindWeights: { ...settings.lab.kindWeights, [k]: v } } };
      storage.saveSettings(settings);
    }),
  );
  el.querySelector<HTMLInputElement>('#sim-helpers')?.addEventListener('change', (ev) => {
    settings = { ...settings, simulateHelpers: (ev.target as HTMLInputElement).checked };
    storage.saveSettings(settings);
  });
  const setHeroOrder = (order: string[]) => {
    settings = { ...settings, heroOrder: heroOrder(order) }; // normalized: the Archer Queen stays first
    storage.saveSettings(settings);
    renderImportTab();
  };
  el.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = Number(b.dataset.move);
      setHeroOrder(moveHero(settings.heroOrder, i, i + Number(b.dataset.dir)));
    }),
  );
  // Drag to reorder (desktop). Touch devices use the ↑ / ↓ buttons.
  let dragFrom = -1;
  // The locked Archer Queen is neither a drag source nor a drop target.
  el.querySelectorAll<HTMLLIElement>('.hero-order li:not(.locked)').forEach((li) => {
    li.addEventListener('dragstart', (ev) => {
      dragFrom = Number(li.dataset.idx);
      li.classList.add('dragging');
      ev.dataTransfer?.setData('text/plain', String(dragFrom));
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      dragFrom = -1; // e.g. dropped on the locked Queen or outside the list
    });
    li.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      li.classList.add('drop-target');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
    li.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const from = dragFrom >= 0 ? dragFrom : Number(ev.dataTransfer?.getData('text/plain'));
      dragFrom = -1;
      if (!Number.isInteger(from)) return; // no drag source from this list
      setHeroOrder(moveHero(settings.heroOrder, from, Number(li.dataset.idx)));
    });
  });
  el.querySelector('#btn-hero-reset')?.addEventListener('click', () => setHeroOrder([...DEFAULT_HERO_ORDER]));
  el.querySelector('#btn-reset')!.addEventListener('click', () => {
    storage.clearSettings();
    settings = DEFAULTS;
    renderImportTab({ text: 'Settings reset to config/settings.sample.yaml.', kind: 'ok' });
  });
}

/** public/data-changes.json, or null when it's missing or malformed. */
function coerceDataChanges(j: unknown): DataChangesFile | null {
  const o = j as Partial<DataChangesFile> | null;
  if (!o || typeof o.version !== 'string' || !Array.isArray(o.changes)) return null;
  const changes = o.changes.filter((c) => c && typeof c.text === 'string');
  return { version: o.version, previousVersion: typeof o.previousVersion === 'string' ? o.previousVersion : '?', date: typeof o.date === 'string' ? o.date : '', changes };
}

function renderFooter(): void {
  const metaText =
    meta.generatedAt && meta.attacks > 0
      ? `Legend I meta: ${esc(new Date(meta.generatedAt).toLocaleString())} · ${meta.attacks.toLocaleString()} attacks, ${meta.players.toLocaleString()} players`
      : 'Legend I meta: none yet';
  $('#footer').innerHTML = `Game data: ${esc(dataSourceLabel(data))}${dataChanges?.version === data.version && dataChanges.date ? ` (synced ${esc(dataChanges.date)})` : ''} · max TH ${data.maxTH} · ${metaText}<br>
    Update with <code>npm run sync</code> (game data) and <code>npm run meta</code> (Legend I meta).`;
}

async function init(): Promise<void> {
  try {
    data = await loadGameDataBrowser();
  } catch (e) {
    document.querySelector('main')!.innerHTML = `<div class="card warn">Failed to load game data: ${esc((e as Error).message)}</div>`;
    return;
  }
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}meta.json`, { cache: 'no-store' });
    if (res.ok) meta = coerceMeta(await res.json());
  } catch {
    meta = EMPTY_META;
  }
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data-changes.json`, { cache: 'no-store' });
    if (res.ok) dataChanges = coerceDataChanges(await res.json());
  } catch {
    dataChanges = null;
  }
  loadAccount();
  renderFooter();
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab!)));
  showTab(account ? (storage.loadTab() ?? 'plan') : 'import');
  // "Now" moves: refresh the plan every minute and when the page regains focus.
  setInterval(() => {
    if (!$('#tab-plan').hidden) renderPlanTab();
    else if (!$('#tab-lab').hidden) renderLabTab();
  }, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!$('#tab-plan').hidden) renderPlanTab();
    else if (!$('#tab-lab').hidden) renderLabTab();
  });
}

void init();
