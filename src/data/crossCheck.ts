// Cross-check report (SPEC §9 step 5): ClashKing vs clash-of-clans-data, compared on the normalized Item model.
// Printed on every sync and by the daily data-update Action. Informational only: differences never fail a sync.
import { fmtDuration, fmtNum, RESOURCE_LABEL } from '../engine/format';
import type { GameData, Item, LevelInfo } from './types';

export type CrossField = 'cost' | 'time' | 'th';

export interface CrossDiff {
  key: string;
  item: string;
  level: number;
  field: CrossField;
  clashking: string;
  cocData: string;
}

export interface CrossCheckReport {
  clashking: { version: string; maxTH: number; items: number };
  cocData: { version: string; maxTH: number; items: number };
  /** Which source has the higher max TH ('same' when equal). */
  higherMaxTH: 'clashking' | 'clash-of-clans-data' | 'same';
  /** Items (by key) only one source has: the newer content, e.g. after a patch. */
  onlyClashKing: { key: string; name: string }[];
  onlyCocData: { key: string; name: string }[];
  /** Levels that only one source has, per item (e.g. a new max level). */
  levelsOnlyClashKing: { key: string; name: string; levels: number[] }[];
  levelsOnlyCocData: { key: string; name: string; levels: number[] }[];
  diffs: CrossDiff[];
}

const money = (l: LevelInfo) =>
  l.ore ? `${fmtNum(l.ore.shinyOre)} shiny / ${fmtNum(l.ore.glowyOre)} glowy / ${fmtNum(l.ore.starryOre)} starry` : `${fmtNum(l.cost)} ${RESOURCE_LABEL[l.resource]}`;
const sameCost = (a: LevelInfo, b: LevelInfo) =>
  a.ore || b.ore
    ? (a.ore?.shinyOre ?? 0) === (b.ore?.shinyOre ?? 0) && (a.ore?.glowyOre ?? 0) === (b.ore?.glowyOre ?? 0) && (a.ore?.starryOre ?? 0) === (b.ore?.starryOre ?? 0)
    : a.cost === b.cost && a.resource === b.resource;

/** Items both sources describe the same way (TH weapons come from clash-of-clans-data in both). */
const comparable = (i: Item) => i.category !== 'thWeapon';

export function crossCheck(ck: GameData, coc: GameData): CrossCheckReport {
  const a = new Map([...ck.items.values()].filter(comparable).map((i) => [i.key, i]));
  const b = new Map([...coc.items.values()].filter(comparable).map((i) => [i.key, i]));
  const byName = (x: { name: string; key: string }, y: { name: string; key: string }) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.key < y.key ? -1 : 1);
  const r: CrossCheckReport = {
    clashking: { version: ck.version, maxTH: ck.maxTH, items: a.size },
    cocData: { version: coc.version, maxTH: coc.maxTH, items: b.size },
    higherMaxTH: ck.maxTH > coc.maxTH ? 'clashking' : coc.maxTH > ck.maxTH ? 'clash-of-clans-data' : 'same',
    onlyClashKing: [...a.values()].filter((i) => !b.has(i.key)).map((i) => ({ key: i.key, name: i.name })).sort(byName),
    onlyCocData: [...b.values()].filter((i) => !a.has(i.key)).map((i) => ({ key: i.key, name: i.name })).sort(byName),
    levelsOnlyClashKing: [],
    levelsOnlyCocData: [],
    diffs: [],
  };
  const shared = [...a.values()].filter((i) => b.has(i.key)).sort(byName);
  for (const x of shared) {
    const y = b.get(x.key)!;
    const lx = new Map(x.levels.map((l) => [l.level, l]));
    const ly = new Map(y.levels.map((l) => [l.level, l]));
    const onlyX = [...lx.keys()].filter((l) => !ly.has(l));
    const onlyY = [...ly.keys()].filter((l) => !lx.has(l));
    if (onlyX.length) r.levelsOnlyClashKing.push({ key: x.key, name: x.name, levels: onlyX });
    if (onlyY.length) r.levelsOnlyCocData.push({ key: x.key, name: x.name, levels: onlyY });
    for (const [lv, p] of lx) {
      const q = ly.get(lv);
      if (!q) continue;
      const d = (field: CrossField, clashking: string, cocData: string) => r.diffs.push({ key: x.key, item: x.name, level: lv, field, clashking, cocData });
      if (!sameCost(p, q)) d('cost', money(p), money(q));
      if (p.timeSec !== q.timeSec) d('time', fmtDuration(p.timeSec), fmtDuration(q.timeSec));
      if ((p.thRequired ?? null) !== (q.thRequired ?? null)) d('th', p.thRequired === undefined ? 'none' : `TH${p.thRequired}`, q.thRequired === undefined ? 'none' : `TH${q.thRequired}`);
    }
  }
  return r;
}

const FIELD_LABEL: Record<CrossField, string> = { cost: 'cost', time: 'time', th: 'TH requirement' };

/** Human-readable report. `max` caps the per-level difference lines (the counts always cover everything). */
export function crossCheckLines(r: CrossCheckReport, max = 60): string[] {
  const L: string[] = [];
  L.push(`Cross-check: ClashKing ${r.clashking.version} (max TH${r.clashking.maxTH}, ${r.clashking.items} items) vs clash-of-clans-data ${r.cocData.version} (max TH${r.cocData.maxTH}, ${r.cocData.items} items)`);
  L.push(
    r.higherMaxTH === 'same'
      ? `  Max TH: both TH${r.clashking.maxTH}.`
      : `  Max TH: ${r.higherMaxTH === 'clashking' ? 'ClashKing' : 'clash-of-clans-data'} is ahead (TH${Math.max(r.clashking.maxTH, r.cocData.maxTH)} vs TH${Math.min(r.clashking.maxTH, r.cocData.maxTH)}).`,
  );
  const names = (xs: { name: string }[]) => xs.map((x) => x.name).join(', ');
  const newer =
    r.onlyClashKing.length > r.onlyCocData.length ? 'ClashKing has more items' : r.onlyCocData.length > r.onlyClashKing.length ? 'clash-of-clans-data has more items' : 'same item count';
  L.push(`  Newer items: ${newer} (${r.onlyClashKing.length} only in ClashKing, ${r.onlyCocData.length} only in clash-of-clans-data).`);
  if (r.onlyClashKing.length) L.push(`    Only in ClashKing: ${names(r.onlyClashKing)}`);
  if (r.onlyCocData.length) L.push(`    Only in clash-of-clans-data: ${names(r.onlyCocData)}`);
  const lv = (xs: { name: string; levels: number[] }[]) => xs.map((x) => `${x.name} ${x.levels.join(',')}`).join('; ');
  if (r.levelsOnlyClashKing.length) L.push(`    Levels only in ClashKing: ${lv(r.levelsOnlyClashKing)}`);
  if (r.levelsOnlyCocData.length) L.push(`    Levels only in clash-of-clans-data: ${lv(r.levelsOnlyCocData)}`);
  const count = (f: CrossField) => r.diffs.filter((d) => d.field === f).length;
  L.push(`  Differences on shared levels: ${r.diffs.length} (${count('cost')} cost, ${count('time')} time, ${count('th')} TH requirement).`);
  for (const d of r.diffs.slice(0, max)) L.push(`    ${d.item} ${d.level} ${FIELD_LABEL[d.field]}: ClashKing ${d.clashking}, clash-of-clans-data ${d.cocData}`);
  if (r.diffs.length > max) L.push(`    … and ${r.diffs.length - max} more`);
  return L;
}
