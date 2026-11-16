// Legend League I meta (SPEC §8): public/meta.json, written by `npm run meta`.
export type UnitKind = 'troop' | 'superTroop' | 'spell' | 'siege' | 'pet' | 'equipment';

export interface MetaUnit {
  name: string;
  usage: number; // 0–1 weighted share of attacks
  threeStarRate: number; // weighted 3★ rate of attacks that include it
  avgQty?: number; // troops and spells
  /** Extra fields (beyond SPEC §8.3) — optional, so a hand-made meta.json still works. */
  kind?: UnitKind;
  baseId?: number; // super troops: the base troop's dataId (its lab upgrade)
}

export interface MetaFile {
  generatedAt: string | null;
  windowDays: number;
  halfLifeDays: number;
  attacks: number;
  players: number;
  units: Record<string, MetaUnit>;
}

export const EMPTY_META: MetaFile = { generatedAt: null, windowDays: 14, halfLifeDays: 5, attacks: 0, players: 0, units: {} };

export function coerceMeta(x: unknown): MetaFile {
  if (!x || typeof x !== 'object') return EMPTY_META;
  const m = x as Partial<MetaFile>;
  const units: Record<string, MetaUnit> = {};
  if (m.units && typeof m.units === 'object') {
    for (const [id, u] of Object.entries(m.units)) {
      if (u && typeof u === 'object' && typeof u.usage === 'number' && Number.isFinite(u.usage)) units[id] = u;
    }
  }
  return {
    ...EMPTY_META,
    ...m,
    attacks: typeof m.attacks === 'number' ? m.attacks : 0,
    players: typeof m.players === 'number' ? m.players : 0,
    units,
  };
}

export interface MetaStats {
  /** Meta score used for ranking. For a base troop it includes its super troop(s). */
  usage: number;
  threeStarRate?: number;
  /** Own usage (without super troops). */
  ownUsage: number;
  /** Super troops credited to this base troop. */
  supers: { name: string; usage: number }[];
}

/**
 * Meta stats for an upgradable item. Super troops share their base troop's level, so their
 * usage is added to the base troop (capped at 100%; an army rarely holds both).
 */
export function metaStats(meta: MetaFile, dataId: number): MetaStats {
  const own = meta.units[String(dataId)];
  const supers = Object.values(meta.units)
    .filter((u) => u.baseId === dataId && u.usage > 0)
    .map((u) => ({ name: u.name, usage: u.usage, threeStarRate: u.threeStarRate }));
  const ownUsage = own?.usage ?? 0;
  const usage = Math.min(1, ownUsage + supers.reduce((s, u) => s + u.usage, 0));
  // 3★ rate: usage-weighted blend of the parts.
  const parts = [...(own ? [{ usage: ownUsage, threeStarRate: own.threeStarRate }] : []), ...supers].filter((p) => p.usage > 0);
  const wsum = parts.reduce((s, p) => s + p.usage, 0);
  const threeStarRate = wsum > 0 ? parts.reduce((s, p) => s + p.usage * p.threeStarRate, 0) / wsum : own?.threeStarRate;
  return { usage, threeStarRate, ownUsage, supers: supers.map(({ name, usage }) => ({ name, usage })) };
}

/** Meta score (default = usage, incl. super troops for base troops). 0 when unknown. */
export function metaScore(meta: MetaFile, dataId: number): number {
  return metaStats(meta, dataId).usage;
}
