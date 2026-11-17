// Normalized game-data snapshots and their diff (SPEC §9). `npm run sync` writes a snapshot of the Item
// model (not the raw package JSON) per data version, diffs it against the previous version's snapshot,
// prints the changes and saves them to public/data-changes.json for the site's "Game data updated" banner.
import { fmtDuration, fmtNum, RESOURCE_LABEL } from '../engine/format';
import { versionSlug } from './source';
import type { GameData, Item, LevelInfo } from './types';

export interface Snapshot {
  version: string;
  /** YYYY-MM-DD the snapshot was taken. */
  date: string;
  maxTH: number;
  /** Item model, sorted by key. Images are left out (paths only, not game data). */
  items: Omit<Item, 'images'>[];
}

export type DataChangeKind = 'newItem' | 'removedItem' | 'renamed' | 'newLevel' | 'removedLevel' | 'cost' | 'time' | 'requirement';

export interface DataChange {
  kind: DataChangeKind;
  /** Item key (dataId-based, stable across versions). */
  key: string;
  item: string;
  level?: number;
  /** Human-readable line, e.g. "Archer Tower 21: 18d → 16d". */
  text: string;
}

/** public/data-changes.json */
export interface DataChangesFile {
  version: string;
  previousVersion: string;
  date: string;
  changes: DataChange[];
}

export function toSnapshot(data: GameData, date: string): Snapshot {
  const items = [...data.items.values()]
    .map(({ images: _images, ...rest }) => rest)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { version: data.version, date, maxTH: data.maxTH, items };
}

/** Snapshot file name: `<YYYY-MM-DD>_<version>.json`, the version slugged so it always stays one file name (REVIEW-2 #9). */
export const snapshotFileName = (s: Pick<Snapshot, 'date' | 'version'>) => `${s.date}_${versionSlug(s.version)}.json`;

/** "8M gold", "350K DE" … */
const money = (l: LevelInfo) => `${fmtNum(l.cost)} ${RESOURCE_LABEL[l.resource]}`;

/** Equipment cost: "1.2K shiny, 50 glowy" (zero ores left out). */
const oreText = (l: LevelInfo) => {
  const o = l.ore ?? { shinyOre: 0, glowyOre: 0, starryOre: 0 };
  const parts = [o.shinyOre && `${fmtNum(o.shinyOre)} shiny`, o.glowyOre && `${fmtNum(o.glowyOre)} glowy`, o.starryOre && `${fmtNum(o.starryOre)} starry`].filter(Boolean);
  return parts.join(', ') || 'free';
};

const REQS:[keyof LevelInfo, string][] = [
  ['thRequired', 'TH'],
  ['heroHallRequired', 'Hero Hall'],
  ['labRequired', 'Lab'],
  ['petHouseRequired', 'Pet House'],
  ['blacksmithRequired', 'Blacksmith'],
];

/**
 * Readable changes from `prev` to `next`: new / removed items and levels, renames, and per-level cost,
 * resource, time and requirement changes. Items are matched by key (dataId-based), never by name.
 */
export function diffSnapshots(prev: Snapshot, next: Snapshot): DataChange[] {
  const out: DataChange[] = [];
  const before = new Map(prev.items.map((i) => [i.key, i]));
  const after = new Map(next.items.map((i) => [i.key, i]));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => {
    const na = (after.get(a) ?? before.get(a))!.name;
    const nb = (after.get(b) ?? before.get(b))!.name;
    return na < nb ? -1 : na > nb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  for (const key of keys) {
    const a = before.get(key);
    const b = after.get(key);
    if (!a && b) {
      const top = b.levels[b.levels.length - 1]?.level;
      out.push({ kind: 'newItem', key, item: b.name, text: `NEW ITEM: ${b.name}${top ? ` (levels 1–${top})` : ''}` });
      continue;
    }
    if (a && !b) {
      out.push({ kind: 'removedItem', key, item: a.name, text: `REMOVED ITEM: ${a.name}` });
      continue;
    }
    if (!a || !b) continue;
    const name = b.name;
    if (a.name !== b.name) out.push({ kind: 'renamed', key, item: name, text: `RENAMED: ${a.name} → ${b.name}` });
    const la = new Map(a.levels.map((l) => [l.level, l]));
    const lb = new Map(b.levels.map((l) => [l.level, l]));
    const levels = [...new Set([...la.keys(), ...lb.keys()])].sort((x, y) => x - y);
    for (const lv of levels) {
      const x = la.get(lv);
      const y = lb.get(lv);
      if (!x && y) {
        out.push({ kind: 'newLevel', key, item: name, level: lv, text: `NEW: ${name} ${lv} (${money(y)}, ${fmtDuration(y.timeSec)})` });
        continue;
      }
      if (x && !y) {
        out.push({ kind: 'removedLevel', key, item: name, level: lv, text: `REMOVED: ${name} ${lv}` });
        continue;
      }
      if (!x || !y) continue;
      if (x.ore || y.ore) {
        if (oreText(x) !== oreText(y)) out.push({ kind: 'cost', key, item: name, level: lv, text: `${name} ${lv}: ${oreText(x)} → ${oreText(y)}` });
      } else if (x.cost !== y.cost || x.resource !== y.resource) out.push({ kind: 'cost', key, item: name, level: lv, text: `${name} ${lv}: ${money(x)} → ${money(y)}` });
      if (x.timeSec !== y.timeSec) out.push({ kind: 'time', key, item: name, level: lv, text: `${name} ${lv}: ${fmtDuration(x.timeSec)} → ${fmtDuration(y.timeSec)}` });
      for (const [f, label] of REQS)
        if (x[f] !== y[f]) out.push({ kind: 'requirement', key, item: name, level: lv, text: `${name} ${lv}: ${label} requirement ${x[f] ?? 'none'} → ${y[f] ?? 'none'}` });
    }
  }
  return out;
}
