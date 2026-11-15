// Legend League I meta (SPEC §8). Step 1 ships a stub public/meta.json with empty `units`.
export interface MetaUnit {
  name: string;
  usage: number; // 0–1 weighted share of attacks
  threeStarRate: number;
  avgQty?: number;
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
  return { ...EMPTY_META, ...m, units: m.units && typeof m.units === 'object' ? m.units : {} };
}

/** Meta score (default = usage). 0 when unknown. */
export function metaScore(meta: MetaFile, dataId: number): number {
  return meta.units[String(dataId)]?.usage ?? 0;
}
