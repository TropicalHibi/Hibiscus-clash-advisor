// Lab / Pets / Equipment tab (SPEC §6.7–6.9, §11.3).
// Lab: a "Next in lab" line (the weighted pick) and three sections ranked by their own score.
import { fmtCost, fmtDuration, fmtNum } from '../engine/format';
import type { Plan } from '../engine/plan';
import { nextResearch, type QueueCandidate } from '../engine/queues';
import type { MetaFile } from '../meta/meta';
import type { LabKind } from '../state/settings';
import { icon } from './images';
import { esc } from './planView';

export type PinList = 'lab' | 'petHouse' | 'blacksmith';

const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;

/** Score label: army share for troops/spells; for usage-scored items the usage column is the score. */
function scoreStat(c: QueueCandidate): string {
  if (c.scoreKind !== 'armyShare') return '<span class="stat"></span>';
  const space = c.item.category === 'spell' ? 'spell' : 'troop';
  return `<span class="stat" title="Average share of ${space} housing space in Legend I armies (the ranking score)"><b>${pct(c.score)}</b> of ${space} space</span>`;
}

function row(c: QueueCandidate, i: number, list: PinList, sub: string): string {
  const used = c.usage > 0;
  const stats = used
    ? `<span class="usage"><span class="bar" style="width:${Math.max(2, Math.round(c.score * 100))}%"></span></span>
       ${scoreStat(c)}
       <span class="stat"><b>${pct(c.usage)}</b> used</span>
       <span class="stat">${c.threeStarRate !== undefined ? `<b>${pct(c.threeStarRate)}</b> 3★` : ''}</span>`
    : `<span class="stat muted" style="grid-column: 1 / -1">Not seen in Legend I · 0% used</span>`;
  const supers = c.supers?.length
    ? `<div class="small muted">Includes ${esc(c.supers.map((s) => (c.scoreKind === 'armyShare' && s.armyShare !== undefined ? `${s.name} ${pct(s.armyShare)} of space, ${pct(s.usage)} used` : `${s.name} ${pct(s.usage)}`)).join(', '))}</div>`
    : '';
  return `<li class="rank-item${c.pinned ? ' pinned' : ''}">
    <span class="rk">${i + 1}</span>
    <div class="body">
      <div class="title">${icon(c.item.key)}<b>${esc(c.item.name)}</b> ${c.instance.level}→${c.toLevel} <span class="small muted">${esc(sub)}</span></div>
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

const KIND_LABEL: Record<LabKind, string> = { troop: 'troop', spell: 'spell', siege: 'siege' };

/** "Next in lab": the lab queue pick, its kind, and its weighted value vs the top pick of the other two kinds. */
export function nextInLab(p: Plan): string {
  const pick = nextResearch(p.lab);
  if (!pick)
    return `<div class="card next-lab"><b>Next in lab:</b> ${p.lab.length ? 'nothing to auto-pick (every remaining kind has weight 0; pin an item to research it).' : 'nothing left to research.'}</div>`;
  // Only a job still running at "now" delays the pick (a job that finished since the export doesn't).
  const busy = p.sim.timeline.find((e) => e.slotId === 'LAB' && e.inProgress && e.end > 0);
  const when = busy ? ` <span class="muted">· starts when ${esc(busy.itemName)} ${busy.toLevel} finishes (in ${esc(fmtDuration(busy.end))})</span>` : '';
  const v = (c: QueueCandidate) => (c.pickValue ?? 0).toFixed(2);
  const others = (['troop', 'spell', 'siege'] as LabKind[])
    .filter((k) => k !== pick.labKind)
    .map((k) => {
      // Best unpinned candidate of that kind by pick value (= the kind's top pick).
      const top = p.lab.find((c) => c.labKind === k && !c.pinned);
      if (!top) return `no ${KIND_LABEL[k]} upgrades`;
      return top.autoPick ? `top ${KIND_LABEL[k]} ${esc(top.item.name)} ${v(top)}` : `${KIND_LABEL[k]}s not auto-picked (weight 0)`;
    });
  const why = pick.pinned ? 'pinned' : `${KIND_LABEL[pick.labKind ?? 'troop']} · pick value <b>${v(pick)}</b> vs ${others.join(', ')}`;
  return `<div class="card next-lab"><b>Next in lab:</b> ${icon(pick.item.key, 20)}<b>${esc(pick.item.name)}</b> ${pick.instance.level}→${pick.toLevel} (${why})${when}</div>`;
}

export function renderLab(p: Plan, meta: MetaFile, heroName: (id: string) => string, weights: Record<LabKind, number> = { troop: 1, spell: 0.7, siege: 0.5 }): string {
  const out: string[] = [];
  if (meta.attacks > 0 && meta.generatedAt) {
    out.push(`<div class="card small">Ranked by Legend League I meta: <b>${fmtNum(meta.attacks)}</b> attacks by <b>${fmtNum(meta.players)}</b> players, last ${meta.windowDays} days (recent days weigh more; half-life ${meta.halfLifeDays}d). Generated ${esc(new Date(meta.generatedAt).toLocaleString())}.
      Troops and spells are ranked by their average share of army housing space (so filler troops count for little); sieges, pets and equipment by the share of attacks that use them. The lab picks across the three lab sections by each unit's score ÷ the Legend I top score of its kind, times a kind weight (troops ${esc(String(weights.troop))}, spells ${esc(String(weights.spell))}, sieges ${esc(String(weights.siege))}; change them under Settings).
      <span class="muted">Items not seen in Legend I are listed at the bottom (lab and pets shortest first, equipment cheapest first). Pins move an item to the top and also change the Plan tab's lab/pet order and ore picks.</span></div>`);
  } else {
    out.push(`<div class="card small warn">No Legend I meta yet. Run <code>npm run meta</code> to rank by usage. Until then: lab and pets shortest first, equipment cheapest first. Pins still work.</div>`);
  }
  out.push(nextInLab(p));
  const labSub = (c: QueueCandidate) => `${fmtDuration(c.timeSec)} · ${fmtCost(c.cost, c.resource)}`;
  out.push(section('Laboratory · Troops', 'lab', p.labByKind.troop, labSub, 'No troop upgrades available.'));
  out.push(section('Laboratory · Spells', 'lab', p.labByKind.spell, labSub, 'No spell upgrades available.'));
  out.push(section('Laboratory · Sieges', 'lab', p.labByKind.siege, labSub, 'No siege machine upgrades available.'));
  out.push(section('Pet House', 'petHouse', p.pets, (c) => `${fmtDuration(c.timeSec)} · ${fmtCost(c.cost, c.resource)}`, 'No pet upgrades available.'));
  out.push(section('Blacksmith (equipment)', 'blacksmith', p.equipment, (c) => `${c.item.hero ? `${heroName(c.item.hero)} · ` : ''}${ore(c)}`, 'No equipment upgrades available.'));
  return out.join('');
}
