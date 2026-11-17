// Squads (TH19, SPEC §6.7 / §8.3): config/squads.yaml maps each squad to its component troops and, where
// ClashKing's description states them, the counts. A squad's Legend I share of troop space is credited to its
// troops (split by count × housing space, or equally when the counts aren't known), the way super troops are
// credited to their base troop. The squad itself stays a lab item with its own score.
//
//   squads:
//     barch-squad:                 # squad item id (slug of the ClashKing name)
//       troops:
//         - { id: barbarian, count: 15 }
//         - { id: archer, count: 15 }
//     giant-wizard-squad:
//       troops: [{ id: giant }, { id: wizard }]   # no counts in the description → equal split
import { parse as parseYaml } from 'yaml';
import type { GameData, Squad, SquadTroop } from './types';

export interface SquadEntry {
  troops: { id: string; count?: number }[];
}

/** config/squads.yaml → squad id → entry. Throws (with the file name) when the YAML doesn't parse. */
export function parseSquadsYaml(text: string | undefined): Record<string, SquadEntry> {
  let cfg: unknown;
  try {
    cfg = text ? parseYaml(text) : undefined;
  } catch (e) {
    throw new Error(`config/squads.yaml: ${(e as Error).message.split('\n')[0]}`);
  }
  const out: Record<string, SquadEntry> = {};
  const squads = (cfg as { squads?: Record<string, unknown> } | null | undefined)?.squads;
  if (!squads || typeof squads !== 'object') return out;
  for (const [id, raw] of Object.entries(squads)) {
    const list = (raw as { troops?: unknown } | null)?.troops;
    if (!Array.isArray(list)) continue;
    const troops = list
      .filter((t): t is { id: string; count?: unknown } => !!t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string')
      .map((t) => ({ id: t.id, ...(typeof t.count === 'number' && Number.isInteger(t.count) && t.count > 0 ? { count: t.count } : {}) }));
    if (troops.length) out[id] = { troops };
  }
  return out;
}

/**
 * Resolves the YAML against the game data. Unknown squads / troops are left out with a warning. Each troop's
 * `fraction` = count × housing ÷ Σ(count × housing) when every count and housing space is known, else 1 ÷ n.
 */
export function resolveSquads(data: Pick<GameData, 'byId'>, entries: Record<string, SquadEntry>): { squads: Record<number, Squad>; warnings: string[] } {
  const squads: Record<number, Squad> = {};
  const warnings: string[] = [];
  for (const [id, e] of Object.entries(entries)) {
    const sq = data.byId.get(id);
    if (!sq || !sq.squad) {
      warnings.push(`config/squads.yaml: "${id}" is not a squad in the game data; ignored.`);
      continue;
    }
    const troops: SquadTroop[] = [];
    for (const t of e.troops) {
      const item = data.byId.get(t.id);
      if (!item || item.category !== 'troop' || item.squad) {
        warnings.push(`config/squads.yaml: ${sq.name}: "${t.id}" is not a troop in the game data; left out.`);
        continue;
      }
      const prev = troops.find((x) => x.dataId === item.dataId);
      if (prev) {
        if (prev.count !== undefined && t.count !== undefined) prev.count += t.count;
        else delete prev.count;
        continue;
      }
      troops.push({ id: item.id, dataId: item.dataId, ...(t.count !== undefined ? { count: t.count } : {}), ...(item.housingSpace ? { housing: item.housingSpace } : {}), fraction: 0 });
    }
    if (!troops.length) continue;
    const countsKnown = troops.every((t) => t.count !== undefined && t.housing !== undefined);
    const total = countsKnown ? troops.reduce((s, t) => s + t.count! * t.housing!, 0) : troops.length;
    for (const t of troops) t.fraction = countsKnown ? (t.count! * t.housing!) / total : 1 / troops.length;
    squads[sq.dataId] = { id: sq.id, dataId: sq.dataId, name: sq.name, troops, countsKnown };
  }
  return { squads, warnings };
}

/** Parse + resolve; a YAML error is a warning (squads are then not credited), never a load failure. */
export function loadSquads(data: Pick<GameData, 'byId'>, text: string | undefined): { squads: Record<number, Squad>; warnings: string[] } {
  try {
    return resolveSquads(data, parseSquadsYaml(text));
  } catch (e) {
    return { squads: {}, warnings: [`${(e as Error).message}; squads aren't credited to their troops until it's fixed.`] };
  }
}

/** A squad that contains a troop, with that troop's fraction of the squad. */
export interface SquadPart {
  dataId: number;
  name: string;
  fraction: number;
}

const partsCache = new WeakMap<object, Map<number, SquadPart[]>>();

/** Squads containing the troop `dataId` (empty for anything else). Cached per squads table. */
export function squadPartsFor(data: Pick<GameData, 'squads'>, dataId: number): SquadPart[] {
  const table = data.squads;
  if (!table) return [];
  let byTroop = partsCache.get(table);
  if (!byTroop) {
    byTroop = new Map();
    for (const sq of Object.values(table))
      for (const t of sq.troops) {
        const list = byTroop.get(t.dataId) ?? [];
        list.push({ dataId: sq.dataId, name: sq.name, fraction: t.fraction });
        byTroop.set(t.dataId, list);
      }
    partsCache.set(table, byTroop);
  }
  return byTroop.get(dataId) ?? [];
}

/** Squads in the game data without a config/squads.yaml entry (sync validation: their share isn't credited). */
export function unmappedSquads(data: GameData): { name: string; description?: string }[] {
  const mapped = new Set(Object.keys(data.squads ?? {}).map(Number));
  return [...data.byDataId.values()].filter((i) => i.squad && !mapped.has(i.dataId)).map((i) => ({ name: i.name, ...(i.description ? { description: i.description } : {}) }));
}
