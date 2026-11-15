// Plan tab (SPEC §11.2).
import type { Resource } from '../data/types';
import { fmtClock, fmtCost, fmtDuration, fmtNum, RESOURCE_LABEL } from '../engine/format';
import type { Plan } from '../engine/plan';
import type { TimelineEntry } from '../engine/scheduler';

export function esc(s: string | number): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const RES_ORDER: Resource[] = ['gold', 'elixir', 'darkElixir', 'goldOrElixir'];

export function renderPlan(p: Plan): string {
  const at = (off: number) => fmtClock(p.nowSec + off, p.nowSec);
  const slotById = new Map(p.sim.slots.map((s) => [s.id, s]));
  const out: string[] = [];

  // Summary
  const baseline = p.exportTimestamp ? `Export from ${esc(fmtClock(p.exportTimestamp, p.nowSec))} (${esc(fmtDuration(p.sim.elapsedSec))} ago)` : '';
  out.push(`<div class="card summary small">
    <span><b>TH${p.townHall}</b> <span class="pill ${p.mode === 'rush' ? 'rush' : ''}">${p.mode === 'rush' ? 'Rush mode' : 'Max-TH mode'}</span></span>
    <span>Hero Hall <b>${p.heroHall}</b></span>
    <span><b>${p.builders}</b> builders</span>
    <span>Gold Pass: <b>${p.goldPass === 'max' ? 'Max' : 'None'}</b></span>
    <span class="muted">${baseline}</span>
  </div>`);

  // Now
  out.push('<h2>Now</h2><div class="card">');
  const builderNow = p.startNow;
  if (builderNow.length) {
    for (const e of builderNow) out.push(nowItem(e, slotById.get(e.slotId)?.label ?? e.slotId));
  } else {
    const next = p.sim.timeline
      .filter((e) => !e.inProgress && e.start > 0)
      .sort((a, b) => a.start - b.start)[0];
    out.push(`<div class="muted">Nothing is free right now.</div>`);
    if (next)
      out.push(
        `<div class="now-item"><span class="slot">${esc(next.slotId)}</span><span class="what">Next: ${esc(next.itemName)} ${next.toLevel} at ${esc(at(next.start))}</span><span class="reason">${esc(next.reason)} · ${esc(fmtCost(next.cost, next.resource))}</span></div>`,
      );
  }
  out.push('</div>');

  // Timeline
  out.push(`<h2>Next ${esc(fmtDuration(p.forecast.windowSec))} by slot</h2><div class="slots">`);
  for (const s of p.sim.slots) {
    const entries = p.sim.timeline.filter((e) => e.slotId === s.id).sort((a, b) => a.start - b.start);
    const idle = p.sim.idle.find((i) => i.slotId === s.id);
    out.push(`<div class="card slot-card"><h3><span>${esc(s.id)} · ${esc(s.label)}</span></h3><ol>`);
    for (const e of entries) {
      if (e.inProgress) out.push(`<li class="busy">${esc(e.itemName)} → ${e.toLevel}<span class="t">${e.end === 0 ? 'finished since the export' : `busy until ${esc(at(e.end))} (${esc(fmtDuration(e.end))})`}</span></li>`);
      else
        out.push(
          `<li><b>${esc(e.itemName)} ${e.toLevel}</b> · ${esc(fmtCost(e.cost, e.resource))}<span class="t">free ${esc(at(e.start))} → done ${esc(at(e.end))} (${esc(fmtDuration(e.end - e.start))})</span></li>`,
        );
    }
    if (idle) out.push(`<li class="muted">Nothing eligible from ${esc(at(idle.at))}${s.goblin ? '' : ''}</li>`);
    if (!entries.length && !idle) out.push('<li class="muted">Idle</li>');
    out.push('</ol></div>');
  }
  out.push('</div>');

  // Resources
  out.push(`<h2>Resources needed in ${esc(fmtDuration(p.forecast.windowSec))}</h2>`);
  out.push('<p class="muted small">Total cost of every upgrade that starts in the window. Already-running upgrades are excluded (already paid).</p>');
  out.push('<div class="res-grid">');
  for (const r of RES_ORDER) {
    const v = p.forecast.totals[r];
    if (!v) continue;
    const first = p.forecast.neededBy[r]![0];
    out.push(`<div class="res"><div class="k">${esc(RESOURCE_LABEL[r])}</div><div class="v">${esc(fmtNum(v))}</div><div class="small muted">first by ${esc(at(first.at))}</div></div>`);
  }
  const o = p.forecast.ore;
  const oreTiles: [string, number][] = [
    ['shiny ore', o.shinyOre],
    ['glowy ore', o.glowyOre],
    ['starry ore', o.starryOre],
  ];
  for (const [k, v] of oreTiles) out.push(`<div class="res"><div class="k">${k}</div><div class="v">${esc(fmtNum(v))}</div><div class="small muted">top ${p.forecast.oreItems.length} equipment</div></div>`);
  out.push('</div>');

  const needed = RES_ORDER.flatMap((r) => (p.forecast.neededBy[r] ?? []).map((n) => ({ r, ...n }))).sort((a, b) => a.at - b.at);
  if (needed.length) {
    out.push('<div class="card table-wrap"><table><thead><tr><th>Needed by</th><th>Upgrade</th><th>Cost</th><th>Running total</th></tr></thead><tbody>');
    for (const n of needed)
      out.push(
        `<tr><td class="num">${esc(at(n.at))}</td><td>${esc(n.label)} <span class="muted small">${esc(n.slotId)}</span></td><td class="num">${esc(fmtCost(n.cost, n.r))}</td><td class="num">${esc(fmtCost(n.cumulative, n.r))}</td></tr>`,
      );
    out.push('</tbody></table></div>');
  }
  if (p.forecast.oreItems.length) {
    out.push('<div class="card small"><b>Ore picks</b> (ranked; fallback cheapest-first until the meta pipeline ships):<ul>');
    for (const c of p.forecast.oreItems)
      out.push(`<li>${esc(c.item.name)} ${c.instance.level}→${c.toLevel}: ${c.ore?.shinyOre ?? 0} shiny · ${c.ore?.glowyOre ?? 0} glowy · ${c.ore?.starryOre ?? 0} starry</li>`);
    out.push('</ul></div>');
  }

  // Book-ready heroes
  out.push('<h2>Book-ready heroes: your call</h2>');
  if (!p.bookReady.length) out.push('<div class="card muted">None.</div>');
  else {
    out.push(`<div class="card"><p class="muted small" style="margin-top:0">Next level takes ≥ ${esc(fmtDuration(p.bookThresholdSec))} (the longest hero level in the data). These drop out of scheduling.</p><table><tbody>`);
    for (const b of p.bookReady)
      out.push(
        `<tr><td>${esc(b.name)} ${b.level}→${b.toLevel}${b.afterCurrent ? ' <span class="muted small">(after current upgrade)</span>' : ''}</td><td class="num">${esc(fmtCost(b.cost, b.resource))}</td><td class="num">${esc(fmtDuration(b.timeSec))}</td></tr>`,
      );
    out.push('</tbody></table></div>');
  }

  // Walls
  out.push('<h2>Walls</h2>');
  out.push(`<div class="card">${esc(p.wallDump ? p.wallDump.text : 'All walls are maxed for this Town Hall.')}</div>`);

  // Top priorities (transparency)
  out.push('<h2>Builder priority list right now</h2><div class="card table-wrap"><table><thead><tr><th>Tier</th><th>Upgrade</th><th>Time</th><th>Cost</th></tr></thead><tbody>');
  for (const c of p.topCandidates)
    out.push(
      `<tr><td class="small">T${c.tier} ${esc(p.tierNames[c.tier])}</td><td>${esc(c.item.name)} ${c.instance.planned ? '(new)' : c.instance.level}→${c.toLevel}<div class="muted small">${esc(c.reason)}</div></td><td class="num">${esc(fmtDuration(c.timeSec))}</td><td class="num">${esc(fmtCost(c.cost, c.resource))}</td></tr>`,
    );
  out.push('</tbody></table></div>');

  if (p.warnings.length) {
    out.push('<h2>Warnings</h2><div class="card small warn"><ul>');
    for (const w of p.warnings) out.push(`<li>${esc(w)}</li>`);
    out.push('</ul></div>');
  }
  return out.join('');
}

function nowItem(e: TimelineEntry, label: string): string {
  return `<div class="now-item"><span class="slot">${esc(e.slotId)}</span><span class="what">${esc(e.itemName)} → ${e.toLevel} <span class="muted small">${esc(fmtCost(e.cost, e.resource))} · ${esc(fmtDuration(e.end - e.start))}</span></span><span class="reason">${esc(label)}: ${esc(e.reason)}</span></div>`;
}
