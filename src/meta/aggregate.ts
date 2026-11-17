// Legend I meta aggregation (SPEC §8.3): 14-day window, exponential recency weighting,
// usage / 3★ rate / avg quantity per troop, spell, siege, pet and equipment piece, plus the
// army-share score for troops and spells (SPEC §8.3).
import type { SuperTroopEntry } from '../data/overrides';
import type { GameData } from '../data/types';
import { parseArmyCode, type ArmyRecipe } from './armyCode';
import type { MetaFile, MetaUnit, UnitKind } from './meta';

/** One stored Legend I attack (a line of data/meta/battles.jsonl). */
export interface BattleRow {
  tag: string;
  ts: string; // ISO 8601
  stars: number;
  destruction: number;
  armyShareCode: string;
}

export const rowKey = (r: Pick<BattleRow, 'tag' | 'ts'>) => `${r.tag}|${r.ts}`;

/** API battle timestamp "20261116T180741.000Z" → ISO "2026-11-16T18:07:41.000Z". */
export function apiTimestampToIso(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(s);
  if (!m) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`Unrecognised battle timestamp: ${s}`);
    return d.toISOString();
  }
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? '.000'}Z`;
}

// ── Catalog: dataId → what it is ──
export interface UnitInfo {
  kind: UnitKind | 'hero';
  name: string;
  baseId?: number; // super troops → base troop dataId
  /** Housing space (troops, super troops, spells, sieges). Missing → no army-share score. */
  housing?: number;
  /** Squads (TH19): a troop of its own whose share is also credited to its troops (SPEC §8.3). */
  squad?: true;
  /** Seasonal / event units (ClashKing `is_seasonal`): named, but left out of the meta entirely. */
  seasonal?: true;
}
export type Catalog = Map<number, UnitInfo>;

// Super troops come from the game data (GameData.superTroops); config/super-troops.yaml entries win.
export { parseSuperTroops, type SuperTroopEntry } from '../data/overrides';

const KIND_BY_CATEGORY: Record<string, UnitInfo['kind'] | undefined> = {
  troop: 'troop',
  spell: 'spell',
  siege: 'siege',
  pet: 'pet',
  equipment: 'equipment',
  hero: 'hero',
};

/**
 * dataId → unit info for the meta. Names (squads included) and seasonal flags come from the game data the planner
 * uses (ClashKing). Seasonal units are flagged so the aggregation skips them instead of calling them unknown
 * (never ranked, SPEC §6.7). Super troops come from the data; `superTroops` (config/super-troops.yaml) adds or
 * replaces entries.
 */
export function buildCatalog(data: GameData, superTroops: Record<number, SuperTroopEntry> = {}): Catalog {
  const cat: Catalog = new Map();
  for (const item of data.items.values()) {
    const kind = KIND_BY_CATEGORY[item.category];
    if (!kind || item.key !== String(item.dataId)) continue;
    const info: UnitInfo = { kind, name: item.name };
    if (item.seasonal) info.seasonal = true;
    if (item.squad) info.squad = true;
    if (item.housingSpace) info.housing = item.housingSpace;
    cat.set(item.dataId, info);
  }
  const table: Record<number, { name: string; base: string; housing?: number }> = {};
  for (const [id, s] of Object.entries(data.superTroops ?? {})) table[Number(id)] = { name: s.name, base: s.base, housing: s.housingSpace };
  for (const [id, s] of Object.entries(superTroops)) table[Number(id)] = { name: s.name, base: s.base, housing: data.superTroops?.[Number(id)]?.housingSpace };
  for (const [id, s] of Object.entries(table)) {
    const base = data.byId.get(s.base);
    if (!base || base.category !== 'troop') continue; // bad config line: treat the ID as unknown
    const info: UnitInfo = { kind: 'superTroop', name: s.name, baseId: base.dataId };
    const housing = s.housing ?? base.superHousingSpace;
    if (housing) info.housing = housing;
    cat.set(Number(id), info);
  }
  return cat;
}

// ── Per-attack usage ──
export type Section = 'u' | 's' | 'i' | 'd' | 'h' | 'pet' | 'equipment';

export interface UnknownId {
  id: number;
  section: Section;
  counted: boolean; // false for CC / hero IDs, which never count toward usage
}

export interface AttackUsage {
  /** dataId → quantity (1 for sieges, pets, equipment). */
  units: Map<number, number>;
  /**
   * Share of the army's housing space: troops (incl. super troops) of the home troop space,
   * spells of the spell space. Only units with a known housing space; unknown IDs and units
   * without housing data are left out of both the share and the total.
   */
  shares: Map<number, number>;
  /** Known units that have no housing space in the data (they fall back to usage share). */
  noHousing: number[];
  unknown: UnknownId[];
  /** Seasonal units in the army (left out of usage and the totals). */
  seasonal: number[];
}

const UNKNOWN_KIND: Record<string, UnitKind> = { u: 'troop', s: 'spell', pet: 'pet', equipment: 'equipment' };

/**
 * What one army uses, for meta purposes:
 * - home troops (u) and spells (s), with quantities; a siege placed in `u` counts as a siege;
 * - sieges in the Clan Castle (i) count; other CC troops and all CC spells (d) are ignored;
 * - pets and equipment from the hero loadouts.
 * Unknown IDs in u/s/pet/equipment are still counted; every unknown ID is reported.
 */
export function attackUsage(recipe: ArmyRecipe, catalog: Catalog): AttackUsage {
  const units = new Map<number, number>();
  const unknown: UnknownId[] = [];
  const seasonal: number[] = [];
  const add = (id: number, qty: number) => units.set(id, (units.get(id) ?? 0) + qty);
  const isSeasonal = (id: number) => {
    if (!catalog.get(id)?.seasonal) return false;
    if (!seasonal.includes(id)) seasonal.push(id);
    return true;
  };

  for (const t of recipe.troops) {
    if (isSeasonal(t.id)) continue;
    const info = catalog.get(t.id);
    if (!info) unknown.push({ id: t.id, section: 'u', counted: true });
    add(t.id, info?.kind === 'siege' ? 1 : t.qty);
  }
  for (const s of recipe.spells) {
    if (isSeasonal(s.id)) continue;
    if (!catalog.has(s.id)) unknown.push({ id: s.id, section: 's', counted: true });
    add(s.id, s.qty);
  }
  for (const t of recipe.ccTroops) {
    const info = catalog.get(t.id);
    if (!info) unknown.push({ id: t.id, section: 'i', counted: false });
    else if (info.kind === 'siege') units.set(t.id, 1);
  }
  for (const s of recipe.ccSpells) if (!catalog.has(s.id)) unknown.push({ id: s.id, section: 'd', counted: false });
  for (const h of recipe.heroes) {
    if (!catalog.has(h.hero)) unknown.push({ id: h.hero, section: 'h', counted: false });
    if (h.pet !== undefined) {
      if (!catalog.has(h.pet)) unknown.push({ id: h.pet, section: 'pet', counted: true });
      units.set(h.pet, 1);
    }
    for (const e of h.equipment) {
      if (!catalog.has(e)) unknown.push({ id: e, section: 'equipment', counted: true });
      units.set(e, 1);
    }
  }
  // Army-share: (qty × housing) ÷ total housing of that army part.
  const shares = new Map<number, number>();
  const noHousing: number[] = [];
  const part = (ids: number[], kinds: UnitKind[]) => {
    const space = new Map<number, number>();
    for (const id of ids) {
      const info = catalog.get(id);
      if (!info || info.seasonal || !kinds.includes(info.kind as UnitKind)) continue;
      if (!info.housing) {
        if (!noHousing.includes(id)) noHousing.push(id);
        continue;
      }
      space.set(id, (units.get(id) ?? 0) * info.housing);
    }
    const total = [...space.values()].reduce((s, x) => s + x, 0);
    if (total > 0) for (const [id, s] of space) shares.set(id, s / total);
  };
  part([...new Set(recipe.troops.map((t) => t.id))], ['troop', 'superTroop']);
  part([...new Set(recipe.spells.map((s) => s.id))], ['spell']);
  return { units, shares, noHousing, unknown, seasonal };
}

// ── Aggregation ──
export interface AggregateOptions {
  nowMs: number;
  windowDays: number;
  halfLifeDays: number;
}

export interface AggregateResult {
  meta: MetaFile;
  /** Unknown IDs seen in the window: dataId → { attacks, sections }. */
  unknown: Map<number, { attacks: number; sections: Set<Section>; counted: boolean }>;
  /** Rows in the window whose armyShareCode yielded nothing usable. */
  emptyArmies: number;
  /** Known troops/spells with no housing space in the data: dataId → name. Ranked by usage share. */
  noHousing: Map<number, string>;
  /** Seasonal units seen in the window (left out of the meta): dataId → { name, attacks }. */
  seasonal: Map<number, { name: string; attacks: number }>;
}

const DAY_MS = 86_400_000;
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** Recency weight: 1 for a battle happening now, ½ after one half-life. Future timestamps weigh 1. */
export function recencyWeight(ageMs: number, halfLifeDays: number): number {
  return 0.5 ** (Math.max(0, ageMs) / (halfLifeDays * DAY_MS));
}

export function aggregate(rows: BattleRow[], catalog: Catalog, opts: AggregateOptions): AggregateResult {
  const cutoff = opts.nowMs - opts.windowDays * DAY_MS;
  let totalW = 0;
  let attacks = 0;
  let emptyArmies = 0;
  const players = new Set<string>();
  const acc = new Map<number, { w: number; w3: number; wQty: number; wShare: number }>();
  const noHousing: AggregateResult['noHousing'] = new Map();
  const unknown: AggregateResult['unknown'] = new Map();
  const seasonal: AggregateResult['seasonal'] = new Map();

  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const usage = attackUsage(parseArmyCode(r.armyShareCode ?? ''), catalog);
    for (const id of usage.seasonal) {
      const e = seasonal.get(id) ?? { name: catalog.get(id)?.name ?? String(id), attacks: 0 };
      e.attacks++;
      seasonal.set(id, e);
    }
    if (usage.units.size === 0) {
      emptyArmies++;
      continue;
    }
    const w = recencyWeight(opts.nowMs - t, opts.halfLifeDays);
    const three = r.stars === 3 ? 1 : 0;
    totalW += w;
    attacks++;
    players.add(r.tag);
    for (const [id, qty] of usage.units) {
      const a = acc.get(id) ?? { w: 0, w3: 0, wQty: 0, wShare: 0 };
      a.w += w;
      a.w3 += w * three;
      a.wQty += w * qty;
      a.wShare += w * (usage.shares.get(id) ?? 0);
      acc.set(id, a);
    }
    for (const id of usage.noHousing) noHousing.set(id, catalog.get(id)?.name ?? String(id));
    const seen = new Set<number>();
    for (const u of usage.unknown) {
      const e = unknown.get(u.id) ?? { attacks: 0, sections: new Set<Section>(), counted: false };
      if (!seen.has(u.id)) e.attacks++;
      seen.add(u.id);
      e.sections.add(u.section);
      e.counted ||= u.counted;
      unknown.set(u.id, e);
    }
  }

  const units: Record<string, MetaUnit> = {};
  const sectionOf = (id: number) => [...(unknown.get(id)?.sections ?? [])][0];
  for (const [id, a] of [...acc].sort((x, y) => y[1].w - x[1].w)) {
    const info = catalog.get(id);
    const kind: UnitKind = info && info.kind !== 'hero' ? info.kind : (UNKNOWN_KIND[sectionOf(id) ?? 'u'] ?? 'troop');
    const unit: MetaUnit = {
      name: info?.name ?? `Unknown ${kind} ${id}`,
      usage: round(a.w / totalW),
      threeStarRate: round(a.w3 / a.w),
      kind,
    };
    if (kind === 'troop' || kind === 'superTroop' || kind === 'spell') {
      unit.avgQty = round(a.wQty / a.w, 2);
      // Average share of housing space over ALL attacks in the window (0 where absent).
      if (info?.housing) unit.armyShare = round(a.wShare / totalW);
    }
    if (info?.baseId) unit.baseId = info.baseId;
    units[String(id)] = unit;
  }

  return {
    meta: {
      generatedAt: new Date(opts.nowMs).toISOString(),
      windowDays: opts.windowDays,
      halfLifeDays: opts.halfLifeDays,
      attacks,
      players: players.size,
      units,
    },
    unknown,
    emptyArmies,
    noHousing,
    seasonal,
  };
}
