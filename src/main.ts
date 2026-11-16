import './style.css';
import { loadGameDataBrowser } from './data/loadBrowser';
import type { GameData } from './data/types';
import { fmtClock } from './engine/format';
import { buildPlan } from './engine/plan';
import { detectMode } from './engine/tiers';
import { coerceMeta, EMPTY_META, type MetaFile } from './meta/meta';
import { parseExport, ExportParseError, type AccountState } from './state/parseExport';
import { settingsFromYaml, type Settings } from './state/settings';
import { renderLab, type PinList } from './ui/labView';
import { esc, renderPlan } from './ui/planView';
import { storage } from './ui/storage';
import settingsYaml from '../config/settings.sample.yaml?raw';

const DEFAULTS = settingsFromYaml(settingsYaml);

let data: GameData;
let meta: MetaFile = EMPTY_META;
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
const TABS = ['plan', 'lab', 'import'];
function showTab(tab: string): void {
  if (!TABS.includes(tab)) tab = 'plan';
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== tab;
  storage.saveTab(tab);
  if (tab === 'plan') renderPlanTab();
  else if (tab === 'lab') renderLabTab();
  else renderImportTab();
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
    el.innerHTML = renderLab(plan, meta, heroName);
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
      settings = { ...settings, [list]: { pinned: next } };
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
    el.innerHTML = renderPlan(plan);
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
      <div><b>Hero order</b> <span class="small muted">(Archer Queen always gets Tier 0 until book-ready)</span></div>
      <ol class="hero-order">
        ${settings.heroOrder
          .map(
            (id, i) => `<li><span class="n">${i + 1}</span><span class="name">${esc(heroName(id))}</span>
          <button class="icon" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="icon" data-move="${i}" data-dir="1" ${i === settings.heroOrder.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button></li>`,
          )
          .join('')}
      </ol>
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
  el.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = Number(b.dataset.move);
      const j = i + Number(b.dataset.dir);
      const order = [...settings.heroOrder];
      [order[i], order[j]] = [order[j], order[i]];
      settings = { ...settings, heroOrder: order };
      storage.saveSettings(settings);
      renderImportTab();
    }),
  );
  el.querySelector('#btn-reset')!.addEventListener('click', () => {
    storage.clearSettings();
    settings = DEFAULTS;
    renderImportTab({ text: 'Settings reset to config/settings.sample.yaml.', kind: 'ok' });
  });
}

function renderFooter(): void {
  const metaText =
    meta.generatedAt && meta.attacks > 0
      ? `Legend I meta: ${esc(new Date(meta.generatedAt).toLocaleString())} · ${meta.attacks.toLocaleString()} attacks, ${meta.players.toLocaleString()} players`
      : 'Legend I meta: none yet';
  $('#footer').innerHTML = `Game data: clash-of-clans-data v${esc(data.version)} · max TH ${data.maxTH} · ${metaText}<br>
    Update with <code>npm run sync</code> (game data) and <code>npm run meta</code> (Legend I meta).`;
}

async function init(): Promise<void> {
  try {
    data = loadGameDataBrowser();
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
