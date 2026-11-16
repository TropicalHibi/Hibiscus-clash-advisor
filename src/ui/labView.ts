// Lab / Pets / Equipment tab (SPEC §6.7–6.9, §11.3).
import { fmtCost, fmtDuration, fmtNum } from '../engine/format';
import type { Plan } from '../engine/plan';
import type { QueueCandidate } from '../engine/queues';
import type { MetaFile } from '../meta/meta';
import { esc } from './planView';

export type PinList = 'lab' | 'petHouse' | 'blacksmith';

const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;

function row(c: QueueCandidate, i: number, list: PinList, sub: string): string {
  const used = c.usage > 0;
  const stats = used
    ? `<span class="usage"><span class="bar" style="width:${Math.max(2, Math.round(c.usage * 100))}%"></span></span>
       <span class="stat"><b>${pct(c.usage)}</b> used</span>
       <span class="stat">${c.threeStarRate !== undefined ? `<b>${pct(c.threeStarRate)}</b> 3★` : ''}</span>`
    : `<span class="stat muted" style="grid-column: span 3">Not seen in Legend I · 0% used</span>`;
  const supers = c.supers?.length ? `<div class="small muted">Includes ${esc(c.supers.map((s) => `${s.name} ${pct(s.usage)}`).join(', '))}</div>` : '';
  return `<li class="rank-item${c.pinned ? ' pinned' : ''}">
    <span class="rk">${i + 1}</span>
    <div class="body">
      <div class="title"><b>${esc(c.item.name)}</b> ${c.instance.level}→${c.toLevel} <span class="small muted">${esc(sub)}</span></div>
      <div class="stats">${stats}</div>
      ${supers}
    </div>
    <button class="icon pin" data-pin="${list}" data-id="${esc(c.item.id)}" aria-pressed="${c.pinned}" title="${c.pinned ? 'Unpin' : 'Pin to the top'}">${c.pinned ? 'Unpin' : 'Pin'}</button>
  </li>`;
}

function section(title: string, list: PinList, items: QueueCandidate[], subOf: (c: QueueCandidate) => string, empty: string): string {
  const pinned = items.filter((c) => c.pinned).length;
  const head = `<h2>${esc(title)} <span class="small muted">${items.length} upgrade${items.length === 1 ? '' : 's'} available${pinned ? ` · ${pinned} pinned` : ''}</span></h2>`;
  if (!items.length) return `${head}<div class="card muted">${esc(empty)}</div>`;
  return `${head}<div class="card"><ol class="rank-list">${items.map((c, i) => row(c, i, list, subOf(c))).join('')}</ol></div>`;
}

const ore = (c: QueueCandidate) => {
  const o = c.ore;
  if (!o) return '';
  const parts = [o.shinyOre && `${fmtNum(o.shinyOre)} shiny`, o.glowyOre && `${fmtNum(o.glowyOre)} glowy`, o.starryOre && `${fmtNum(o.starryOre)} starry`].filter(Boolean);
  return parts.join(' · ') || 'free';
};

export function renderLab(p: Plan, meta: MetaFile, heroName: (id: string) => string): string {
  const out: string[] = [];
  if (meta.attacks > 0 && meta.generatedAt) {
    out.push(`<div class="card small">Ranked by Legend League I usage: <b>${fmtNum(meta.attacks)}</b> attacks by <b>${fmtNum(meta.players)}</b> players, last ${meta.windowDays} days (recent days weigh more; half-life ${meta.halfLifeDays}d). Generated ${esc(new Date(meta.generatedAt).toLocaleString())}.
      <span class="muted">Items not seen in Legend I are listed at the bottom (lab and pets shortest first, equipment cheapest first). Pins move an item to the top and also change the Plan tab's lab/pet order and ore picks.</span></div>`);
  } else {
    out.push(`<div class="card small warn">No Legend I meta yet. Run <code>npm run meta</code> to rank by usage. Until then: lab and pets shortest first, equipment cheapest first. Pins still work.</div>`);
  }
  out.push(section('Laboratory', 'lab', p.lab, (c) => `${fmtDuration(c.timeSec)} · ${fmtCost(c.cost, c.resource)}`, 'Nothing left to research at this Town Hall / Laboratory level.'));
  out.push(section('Pet House', 'petHouse', p.pets, (c) => `${fmtDuration(c.timeSec)} · ${fmtCost(c.cost, c.resource)}`, 'No pet upgrades available.'));
  out.push(section('Blacksmith (equipment)', 'blacksmith', p.equipment, (c) => `${c.item.hero ? `${heroName(c.item.hero)} · ` : ''}${ore(c)}`, 'No equipment upgrades available.'));
  return out.join('');
}
