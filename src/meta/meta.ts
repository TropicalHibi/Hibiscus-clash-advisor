// Legend League I meta (SPEC §8): public/meta.json, written by `npm run meta`.
export type UnitKind = 'troop' | 'superTroop' | 'spell' | 'siege' | 'pet' | 'equipment';

export interface MetaUnit {
  name: string;
  usage: number; // 0–1 weighted share of attacks
  threeStarRate: number; // weighted 3★ rate of attacks that include it
  avgQty?: number; // troops and spells
  /** Troops, super troops, spells: weighted average share of army housing space (0–1). */
  armyShare?: number;
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

export type ScoreKind = 'armyShare' | 'usage';

export interface MetaStats {
  /** Meta score used for ranking (SPEC §8.3). For a base troop it includes its super troop(s). */
  score: number;
  /** armyShare for troops/spells with housing data; usage for sieges, pets, equipment and fallbacks. */
  scoreKind: ScoreKind;
  /** Usage share incl. super troops (capped at 100%). */
  usage: number;
  threeStarRate?: number;
  /** Own usage (without super troops). */
  ownUsage: number;
  /** Super troops credited to this base troop. */
  supers: { name: string; usage: number; armyShare?: number }[];
}

/**
 * Meta stats for an upgradable item. Super troops share their base troop's level, so their
 * usage and army share are added to the base troop (capped at 100%).
 * Score = average share of army housing space when every part has one (troops, spells),
 * otherwise plain usage share (sieges, pets, equipment, units missing housing data,
 * or a meta.json written before the army-share score existed).
 */
export function metaStats(meta: MetaFile, dataId: number): MetaStats {
  const own = meta.units[String(dataId)];
  const supers = Object.values(meta.units).filter((u) => u.baseId === dataId && u.usage > 0);
  const parts = [...(own && own.usage > 0 ? [own] : []), ...supers];
  const ownUsage = own?.usage ?? 0;
  const usage = Math.min(1, parts.reduce((s, u) => s + u.usage, 0));
  // 3★ rate: usage-weighted blend of the parts.
  const threeStarRate = usage > 0 ? parts.reduce((s, p) => s + p.usage * p.threeStarRate, 0) / parts.reduce((s, p) => s + p.usage, 0) : own?.threeStarRate;
  const kind = own?.kind ?? supers[0]?.kind;
  const shareKind = kind === 'troop' || kind === 'superTroop' || kind === 'spell';
  const hasShare = shareKind && parts.length > 0 && parts.every((p) => typeof p.armyShare === 'number' && Number.isFinite(p.armyShare));
  const score = hasShare ? Math.min(1, parts.reduce((s, p) => s + (p.armyShare ?? 0), 0)) : usage;
  return {
    score,
    scoreKind: hasShare ? 'armyShare' : 'usage',
    usage,
    threeStarRate,
    ownUsage,
    supers: supers.map((u) => ({ name: u.name, usage: u.usage, ...(typeof u.armyShare === 'number' ? { armyShare: u.armyShare } : {}) })),
  };
}
