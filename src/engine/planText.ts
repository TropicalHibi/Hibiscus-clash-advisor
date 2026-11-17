// Plain-text rendering of a Plan (used by `npm run plan`).
import type { Resource } from '../data/types';
import { fmtClock, fmtCost, fmtDuration, fmtNum, RESOURCE_LABEL } from './format';
import type { Plan } from './plan';

export function planToText(p: Plan): string {
  const L: string[] = [];
  const at = (offset: number) => fmtClock(p.nowSec + offset, p.nowSec);

  L.push(`CoC Upgrade Planner — TH${p.townHall} (max TH${p.maxTH}) · mode: ${p.mode === 'rush' ? 'RUSH' : 'MAX-TH'} · Hero Hall ${p.heroHall}`);
  L.push(`Builders: ${p.builders} · Gold Pass: ${p.goldPass} · book threshold ${fmtDuration(p.bookThresholdSec)} · data ${p.dataVersion}`);
  if (p.helperLine) L.push(`Helpers: ${p.helperLine}`);
  for (const s of p.helperSuggestions) L.push(`  Suggestion: ${s}`);
  if (p.exportTimestamp)
    L.push(`Export taken ${new Date(p.exportTimestamp * 1000).toLocaleString()} (${fmtDuration(p.sim.elapsedSec)} ago) · now ${new Date(p.nowSec * 1000).toLocaleString()}`);
  L.push('');

  L.push('== Now ==');
  if (p.startNow.length === 0) L.push('  No builder/lab/pet slot is free right now.');
  for (const e of p.startNow) L.push(`  ${e.slotId}: start ${e.itemName} → ${e.toLevel} (${fmtCost(e.cost, e.resource)}, ${fmtDuration(e.end - e.start)}) — ${e.reason}`);
  for (const row of p.newBuildingsInfo) L.push(`  T0 (info): ${row} — can't be planned yet; doesn't hold the TH gate`);
  L.push('');

  L.push('== Top builder priorities right now ==');
  for (const c of p.topCandidates.slice(0, 10))
    L.push(
      `  [T${c.tier} ${p.tierNames[c.tier]}] ${c.item.name} ${c.instance.planned ? '(new)' : c.instance.level} → ${c.toLevel} · ${fmtDuration(c.timeSec)} · ${fmtCost(c.cost, c.resource)} — ${c.reason}`,
    );
  L.push('');

  L.push(`== Timeline (next ${fmtDuration(p.forecast.windowSec)}) ==`);
  for (const s of p.sim.slots) {
    const entries = p.sim.timeline.filter((e) => e.slotId === s.id).sort((a, b) => a.start - b.start);
    L.push(`  ${s.id} (${s.label}):`);
    if (!entries.length) L.push('    idle — nothing eligible');
    for (const e of entries) {
      const helped = e.helperSavedSec ? ` · helpers −${fmtDuration(e.helperSavedSec)}` : '';
      if (e.inProgress) L.push(e.end === 0 ? `    ${e.itemName} → ${e.toLevel} finished since the export${helped}` : `    busy: ${e.itemName} → ${e.toLevel}, done ${at(e.end)} (in ${fmtDuration(e.end)})${helped}`);
      else L.push(`    free ${at(e.start)} → ${e.itemName} ${e.toLevel} (${fmtCost(e.cost, e.resource)}, ${fmtDuration(e.end - e.start)}, done ${at(e.end)})${helped}`);
    }
  }
  for (const i of p.sim.idle) L.push(`  ! ${i.slotId} has nothing eligible from ${at(i.at)}`);
  L.push('');

  L.push(`== Resources needed (upgrades starting in the next ${fmtDuration(p.forecast.windowSec)}) ==`);
  const res = Object.entries(p.forecast.totals) as [Resource, number][];
  if (!res.length) L.push('  Nothing new starts in the window.');
  for (const [r, v] of res) {
    const first = p.forecast.neededBy[r]![0];
    L.push(`  ${RESOURCE_LABEL[r].padEnd(14)} ${fmtNum(v).padStart(7)}   first needed ${at(first.at)} (${first.label})`);
  }
  L.push('');

  L.push('== Book-ready heroes (your call) ==');
  if (!p.bookReady.length) L.push('  None.');
  for (const b of p.bookReady)
    L.push(`  ${b.name} ${b.level}→${b.toLevel}: ${fmtCost(b.cost, b.resource)}, ${fmtDuration(b.timeSec)}${b.afterCurrent ? ' (after current upgrade)' : ''}`);
  L.push('');

  L.push('== Walls ==');
  L.push(`  ${p.wallDump ? p.wallDump.text : 'All walls maxed for this TH.'}`);
  L.push('');

  L.push('== Lab (top 5) ==');
  for (const c of p.lab.slice(0, 5)) L.push(`  ${c.item.name} ${c.instance.level}→${c.toLevel} · ${fmtDuration(c.timeSec)} · ${fmtCost(c.cost, c.resource)} — ${c.reason}`);
  L.push('== Pet House (top 3) ==');
  for (const c of p.pets.slice(0, 3)) L.push(`  ${c.item.name} ${c.instance.level}→${c.toLevel} · ${fmtDuration(c.timeSec)} · ${fmtCost(c.cost, c.resource)} — ${c.reason}`);
  // Informational only: ore is time-gated, so it's never part of the resources forecast (SPEC §6.9, §10.3).
  L.push('== Blacksmith (top 3, by Legend I usage) ==');
  for (const c of p.equipment.slice(0, 3)) {
    const o = c.ore ?? { shinyOre: 0, glowyOre: 0, starryOre: 0 };
    const parts = [o.shinyOre && `${fmtNum(o.shinyOre)} shiny`, o.glowyOre && `${fmtNum(o.glowyOre)} glowy`, o.starryOre && `${fmtNum(o.starryOre)} starry`].filter(Boolean);
    L.push(`  ${c.item.name} ${c.instance.level}→${c.toLevel} · ore cost: ${parts.join(' · ') || 'free'} — ${c.reason}`);
  }
  L.push('');

  if (p.unrecognized) {
    L.push('== Info ==');
    L.push(`  Unrecognized items (likely unreleased): ${p.unrecognized}`);
    L.push('');
  }
  if (p.warnings.length) {
    L.push('== Warnings ==');
    for (const w of p.warnings) L.push(`  - ${w}`);
  }
  return L.join('\n');
}
