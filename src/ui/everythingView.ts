// Everything tab (SPEC §11.4): every upgrade left at the current Town Hall, grouped by tier, in
// collapsible sections (one <details> per group, so a phone shows the totals first).
import type { OreCost, Resource } from '../data/types';
import type { Costs, Everything, EverythingGroup, EverythingItem } from '../engine/everything';
import { fmtCost, fmtDuration, fmtNum } from '../engine/format';
import { icon } from './images';
import { esc } from './planView';

const RES_ORDER: Resource[] = ['gold', 'elixir', 'darkElixir', 'goldOrElixir'];

function costs(c: Costs): string {
  const parts = RES_ORDER.filter((r) => c[r]).map((r) => fmtCost(c[r]!, r));
  return parts.length ? parts.join(' · ') : '—';
}

function ore(o?: OreCost): string {
  if (!o) return '';
  const parts = [o.shinyOre && `${fmtNum(o.shinyOre)} shiny`, o.glowyOre && `${fmtNum(o.glowyOre)} glowy`, o.starryOre && `${fmtNum(o.starryOre)} starry`].filter(Boolean);
  return parts.join(' · ');
}

function itemRow(it: EverythingItem, timed: boolean): string {
  const lv = `${it.fromLevel === 0 ? 'new' : it.fromLevel} → ${it.toLevel}`;
  const what = it.count > 1 ? `${it.count} upgrades · ${lv}` : lv;
  const right = [timed && it.rawSec ? fmtDuration(it.rawSec) : '', it.ore ? ore(it.ore) : costs(it.costs)].filter(Boolean).join(' · ');
  return `<li class="ev-item">${icon(it.itemKey)}<span class="ev-name"><b>${esc(it.name)}</b> <span class="small muted">${esc(what)}${it.note ? ` · ${esc(it.note)}` : ''}</span></span><span class="ev-right small">${esc(right)}</span></li>`;
}

/** One collapsible section: summary line = count, builder time (raw / Gold Pass), cost per resource. */
function section(g: EverythingGroup, opts: { timed: boolean; doneLabel?: string; open?: boolean }): string {
  if (!g.count) return '';
  const time = opts.timed && g.rawSec ? ` · ${fmtDuration(g.rawSec)} <span class="muted">(${fmtDuration(g.goldPassSec)} with Gold Pass)</span>` : '';
  const cost = g.ore ? ore(g.ore) : costs(g.costs);
  const done = opts.doneLabel ?? (g.doneSec !== undefined ? `done in ${fmtDuration(g.doneSec)}` : '');
  return `<details class="card ev-group"${opts.open ? ' open' : ''}>
    <summary><span class="ev-title">${esc(g.title)}</span>
      <span class="small"><b>${g.count}</b> upgrade${g.count === 1 ? '' : 's'}${time}</span>
      <span class="small muted">${esc(cost)}${done ? ` · ${esc(done)}` : ''}</span></summary>
    <ul class="ev-list">${g.items.map((it) => itemRow(it, opts.timed)).join('')}</ul>
  </details>`;
}

export function renderEverything(ev: Everything): string {
  const out: string[] = [];
  const gpOn = ev.goldPass === 'max';
  out.push(`<div class="card ev-totals">
    <div class="ev-big"><span class="k">Builders done (time to max at TH${ev.townHall})</span><span class="v">${esc(fmtDuration(ev.timeToMaxSec))}</span>
      <span class="small muted">${gpOn ? 'with Gold Pass' : 'no Gold Pass'}; ${esc(fmtDuration(ev.timeToMaxOtherSec))} ${gpOn ? 'without' : 'with Max Gold Pass'}. From the scheduler (all builders, tiers, locks${ev.simulateHelpers ? ', helpers and boosts' : ''}), not a plain sum.</span></div>
    <div class="ev-big"><span class="k">Lab / Pet House done</span><span class="v">${esc(fmtDuration(ev.labDoneSec))} / ${esc(fmtDuration(ev.petsDoneSec))}</span></div>
    <div class="ev-big"><span class="k">Total cost (${ev.totalCount} upgrades)</span><span class="v small-v">${esc(costs(ev.totalCosts))}</span>
      ${ore(ev.totalOre) ? `<span class="small muted">Ore: ${esc(ore(ev.totalOre))}</span>` : ''}</div>
  </div>
  <p class="small muted">Everything left at your current Town Hall from now, as the scheduler would run it. Builder upgrades are grouped by the tier the engine gives them${ev.mode === 'rush' ? '; the next Town Hall is listed under "Not scheduled" (it opens new levels)' : ''}. Tap a section to expand it.</p>`);
  if (!ev.tiers.length) out.push('<div class="card muted">No builder upgrades left at this Town Hall.</div>');
  for (const g of ev.tiers) out.push(section(g, { timed: true }));
  out.push('<h2>Research and equipment</h2>');
  out.push(section(ev.lab, { timed: true }) || '<div class="card muted">Laboratory: nothing left.</div>');
  out.push(section(ev.pets, { timed: true }) || '<div class="card muted">Pet House: nothing left.</div>');
  out.push(section(ev.blacksmith, { timed: false, doneLabel: 'instant (ore only)' }) || '<div class="card muted">Blacksmith: nothing left.</div>');
  out.push(section(ev.walls, { timed: false, doneLabel: 'instant' }));
  if (ev.notScheduled.count) {
    out.push('<h2>Not scheduled</h2>');
    out.push(section({ ...ev.notScheduled, doneSec: undefined }, { timed: true, doneLabel: 'not in time to max' }));
  }
  return out.join('');
}
