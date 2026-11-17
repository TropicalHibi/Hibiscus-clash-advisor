// "The next data release": a mutated copy of the pinned ClashKing data with a new Town Hall level and new top
// levels for a few items, the way ClashKing ships them (SPEC §3.1 level semantics). `npm run test:mutated` runs
// the suite on it, so a test that only holds for today's data (max TH 19, today's top image, …) fails here
// rather than in the daily data-update Action (REVIEW-2 #1). An item missing from the data is skipped, so a
// rename in a ClashKing release never breaks this check by itself.
import { ckSlug, type ClashKingRaw } from '../../src/data/clashking';

function find(raw: ClashKingRaw, id: string): any {
  for (const list of Object.values(raw)) for (const x of list as any[]) if (x && ckSlug(x.name) === id && x.levels?.length >= 2) return x;
  return undefined;
}

/** Building-style item (cost on its own row): appends a copy of the top level requiring `th`. */
function addBuildLevel(raw: ClashKingRaw, id: string, th: number): void {
  const j = find(raw, id);
  if (!j) return;
  const last = j.levels[j.levels.length - 1];
  const { supercharge: _sc, ...copy } = structuredClone(last);
  j.levels.push({ ...copy, level: last.level + 1, build_cost: Math.round((last.build_cost ?? 0) * 1.1), build_time: (last.build_time ?? 0) + 3600, required_townhall: th });
}

/** Upgrade-style item (row N holds N → N+1): fills the old top row and appends a free top row, as ClashKing does. */
function addUpgradeLevel(raw: ClashKingRaw, id: string, th: number, extra: Record<string, unknown> = {}): void {
  const j = find(raw, id);
  if (!j) return;
  const prev = j.levels[j.levels.length - 2];
  const last = j.levels[j.levels.length - 1];
  if (typeof prev.upgrade_cost === 'object' && prev.upgrade_cost) {
    last.upgrade_cost = Object.fromEntries(Object.entries(prev.upgrade_cost).map(([k, v]) => [k, Math.round(Number(v) * 1.1)]));
  } else {
    last.upgrade_cost = Math.round((prev.upgrade_cost ?? 0) * 1.1);
    last.upgrade_time = (prev.upgrade_time ?? 0) + 3600;
  }
  const next = structuredClone(last);
  next.level = last.level + 1;
  next.required_townhall = th;
  next.upgrade_cost = typeof last.upgrade_cost === 'object' ? Object.fromEntries(Object.keys(last.upgrade_cost).map((k) => [k, 0])) : 0;
  if ('upgrade_time' in next) next.upgrade_time = 0;
  Object.assign(next, extra);
  j.levels.push(next);
}

/** The mutation `npm run test:mutated` applies (in place). Returns the new max TH. */
export function mutateForNextRelease(raw: ClashKingRaw): number {
  const th = raw.buildings.find((b: any) => b.type === 'Town Hall')!;
  const top = th.levels[th.levels.length - 1];
  const newTH = top.level + 1;
  th.levels.push({ ...structuredClone(top), level: newTH, build_cost: top.build_cost + 1_000_000, required_townhall: top.level, unlocks: [], merge_requirement: undefined });
  for (const id of ['cannon', 'laboratory', 'gold-storage', 'army-camp', 'hero-hall']) addBuildLevel(raw, id, newTH);
  addBuildLevel(raw, 'archer-tower', newTH - 1); // a new level at today's max TH
  const hh = find(raw, 'hero-hall')?.levels.length;
  addUpgradeLevel(raw, 'archer-queen', newTH, hh ? { required_hero_tavern_level: hh } : {}); // longer than any hero level today
  addUpgradeLevel(raw, 'barbarian', newTH);
  addUpgradeLevel(raw, 'lassi', newTH);
  addUpgradeLevel(raw, 'barbarian-puppet', newTH);
  return newTH;
}
