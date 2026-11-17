import { COC_BACKUP_IDS, COC_BACKUP_MERGES, COC_BACKUP_SUPER_TROOPS } from './cocDataBackup.ts';
import { parseIdOverrides, parseMergeOverrides, parseSuperTroops, type MergeOverride, type SuperTroopEntry } from './overrides.ts';
import type { Category, GameData, Item, LevelInfo, MergeRecipe, Queue, Resource, SuperTroop } from './types.ts';

export { parseIdOverrides } from './overrides.ts';

/** One JSON file from clash-of-clans-data/data/home, path relative to data/home (forward slashes). */
export interface RawFile {
  path: string;
  json: any;
}

/** Folders under data/home we load (SPEC §3.1). */
export const DATA_FOLDERS = [
  'town-hall',
  'defenses',
  'army-buildings',
  'resource-buildings',
  'traps',
  'walls',
  'heroes',
  'troops',
  'spells',
  'siege-machines',
  'pets',
  'hero-equipment',
  'crafted-defenses',
  'guardians',
  'other',
];

const STORAGES = new Set(['gold-storage', 'elixir-storage', 'dark-elixir-storage']);
const COLLECTORS = new Set(['gold-mine', 'elixir-collector', 'dark-elixir-drill']);

/** Data resource string → Resource (both sources spell them the same way). An unknown string falls back to gold and is reported via `warn`. */
export function mapResource(r: string | undefined, warn?: (msg: string) => void): Resource {
  switch (r) {
    case 'Gold':
      return 'gold';
    case 'Elixir':
      return 'elixir';
    case 'Dark Elixir':
      return 'darkElixir';
    case 'Gold or Elixir':
      return 'goldOrElixir';
    case undefined:
    case '':
      return 'gold';
    default:
      warn?.(`Unknown cost resource "${r}" in the game data; counted as gold.`);
      return 'gold';
  }
}

export function toSeconds(t: { days?: number; hours?: number; minutes?: number; seconds?: number } | undefined): number {
  if (!t) return 0;
  return (t.days ?? 0) * 86400 + (t.hours ?? 0) * 3600 + (t.minutes ?? 0) * 60 + (t.seconds ?? 0);
}

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function perTH(apt: any[] | undefined, field: 'count' | 'countAfterMerges'): Record<number, number> | undefined {
  if (!Array.isArray(apt)) return undefined;
  const out: Record<number, number> = {};
  let any = false;
  for (const a of apt) {
    if (typeof a?.[field] === 'number') {
      out[a.townHallLevel] = a[field];
      any = true;
    }
  }
  return any ? out : undefined;
}

function buildingLevel(l: any, warn?: (msg: string) => void): LevelInfo {
  return {
    level: l.level,
    cost: l.buildCost ?? 0,
    resource: mapResource(l.buildCostResource, warn),
    timeSec: toSeconds(l.buildTime),
    thRequired: l.townHallRequired,
  };
}

function sortLevels(levels: LevelInfo[]): LevelInfo[] {
  return levels.sort((a, b) => a.level - b.level);
}

/**
 * Merge recipes → MergeRecipe (SPEC §7). Unlock TH = the merged defense's first TH with a count (or its level-1
 * TH). Required source level = the recipe's exact level when it has one (ClashKing `merge_requirement`, or
 * `level` in config/merges.yaml), otherwise the source's max level at the unlock TH, so levels a later TH adds
 * to a source never raise the bar for an older merge.
 */
export function buildMergeRecipes(byId: Map<string, Item>, recipes: Record<string, MergeOverride>, origin: string): MergeRecipe[] {
  const merges: MergeRecipe[] = [];
  for (const [id, r] of Object.entries(recipes)) {
    const merged = byId.get(id);
    if (!merged) throw new Error(`${origin}: merged defense "${id}" not found in game data`);
    if (r.dataId && r.dataId !== merged.dataId) throw new Error(`${origin}: dataId mismatch for ${id} (${r.dataId} vs data ${merged.dataId})`);
    const sources = r.sources.map((s) => {
      const src = byId.get(s.id);
      if (!src) throw new Error(`${origin}: source "${s.id}" not found in game data`);
      return { id: s.id, dataId: src.dataId, qty: s.qty };
    });
    const counts = merged.countPerTH ?? {};
    const firstTH = Object.keys(counts)
      .map(Number)
      .filter((th) => counts[th] > 0)
      .sort((a, b) => a - b)[0];
    const unlockTH = firstTH ?? merged.levels[0]?.thRequired ?? 99;
    const requiredSourceLevel: Record<string, number> = {};
    for (const s of r.sources) {
      const src = byId.get(s.id)!;
      requiredSourceLevel[s.id] = s.level ?? (maxLevelAt(src, { th: unlockTH }) || src.levels[src.levels.length - 1].level);
    }
    merges.push({ id, dataId: merged.dataId, sources, unlockTH, requiredSourceLevel });
  }
  return merges;
}

/** Super troop table → GameData.superTroops (entries whose base troop isn't in the data are dropped). */
export function resolveSuperTroops(byId: Map<string, Item>, table: Record<number, SuperTroopEntry & { housingSpace?: number }>): Record<number, SuperTroop> {
  const out: Record<number, SuperTroop> = {};
  for (const [k, s] of Object.entries(table)) {
    const base = byId.get(s.base);
    if (!base || base.category !== 'troop') continue;
    const housingSpace = s.housingSpace ?? base.superHousingSpace;
    out[Number(k)] = { name: s.name, base: s.base, baseDataId: base.dataId, ...(housingSpace ? { housingSpace } : {}) };
  }
  return out;
}

/** TH weapons from clash-of-clans-data's town-hall.json (ClashKing has no weapon levels; SPEC §3.1). */
export function cocTownHallWeapons(th: any, warn?: (msg: string) => void): Item[] {
  const out: Item[] = [];
  for (const l of th?.levels ?? []) {
    const w = l.weapon;
    if (!w || !Array.isArray(w.levels) || !w.levels.length) continue;
    out.push({
      key: `${th.dataId}:w${l.level}`,
      dataId: th.dataId,
      id: `${th.id}-weapon-${l.level}`,
      name: `${w.name ?? 'TH weapon'} (TH${l.level})`,
      category: 'thWeapon',
      queue: 'builder',
      weaponForTH: l.level,
      images: [...imageCandidates(w), ...imageCandidates(l)],
      levels: sortLevels(
        w.levels.map((wl: any) => ({
          level: wl.level,
          cost: wl.buildCost ?? 0,
          resource: mapResource(wl.buildCostResource, warn),
          timeSec: toSeconds(wl.buildTime),
          thRequired: l.level,
        })),
      ),
    });
  }
  return out;
}

/**
 * Candidate images for an item, best first: its icon, then each level's image from the top level down
 * (supercharge levels skipped), then item-level images. Empty when the data has none.
 */
export function imageCandidates(j: any): string[] {
  const out: string[] = [];
  const push = (p: unknown) => {
    if (typeof p === 'string' && p && !out.includes(p)) out.push(p);
  };
  const imgs = j?.images;
  if (imgs && !Array.isArray(imgs)) push(imgs.icon);
  if (Array.isArray(j?.levels)) for (let i = j.levels.length - 1; i >= 0; i--) if (!j.levels[i]?.supercharge) push(j.levels[i]?.images?.normal);
  if (Array.isArray(imgs)) for (let i = imgs.length - 1; i >= 0; i--) push(imgs[i]?.normal);
  else if (imgs) push(imgs.normal);
  return out;
}

/**
 * clash-of-clans-data → Item model. Since the switch to ClashKing (SPEC §3.1) this is the BACKUP path only.
 * Merge recipes, super troops and missing dataIds come from cocDataBackup.ts; an entry in the optional
 * config files (merges.yaml, super-troops.yaml, id-overrides.yaml) wins.
 */
export function normalize(
  files: RawFile[],
  mergesYaml: string | undefined,
  version: string,
  idOverridesYaml?: string,
  superTroopsYaml?: string,
  builtInMerges: Record<string, MergeOverride> = COC_BACKUP_MERGES,
): GameData {
  const recipes: Record<string, MergeOverride> = { ...builtInMerges, ...parseMergeOverrides(mergesYaml) };
  const idOverrides = new Map([...COC_BACKUP_IDS, ...parseIdOverrides(idOverridesYaml)]);
  const mergedIds = new Set(Object.keys(recipes));

  const items = new Map<string, Item>();
  const byDataId = new Map<number, Item>();
  const byId = new Map<string, Item>();
  const heroHallCaps: Record<number, Record<string, number>> = {};
  let maxTH = 0;
  const warningSet = new Set<string>();
  const warn = (msg: string) => warningSet.add(msg);
  const bLevel = (l: any) => buildingLevel(l, warn);

  const add = (item: Item, base = true) => {
    items.set(item.key, item);
    if (base) {
      byDataId.set(item.dataId, item);
      byId.set(item.id, item);
    }
  };

  for (const f of files) {
    const [folder, ...rest] = f.path.split('/');
    let j = f.json;
    if (!j || typeof j !== 'object') continue;
    // A dataId override (built-in backup table or config/id-overrides.yaml) wins over the data.
    const override = idOverrides.get(j.id);
    if (override !== undefined && j.dataId !== override) {
      if (typeof j.dataId === 'number') warn(`config/id-overrides.yaml maps ${override} to "${j.id}"; the data says ${j.dataId}. Using the override.`);
      j = { ...j, dataId: override };
    }
    const images = imageCandidates(j);
    const sub = rest.length > 1 ? rest[0] : undefined; // e.g. other/helpers/x.json

    if (folder === 'town-hall') {
      const levels: LevelInfo[] = (j.levels ?? []).map((l: any) => ({
        ...bLevel(l),
        thRequired: l.level - 1,
      }));
      add({ key: String(j.dataId), dataId: j.dataId, id: j.id, name: j.name, category: 'townHall', queue: 'builder', levels: sortLevels(levels), images });
      for (const l of j.levels ?? []) maxTH = Math.max(maxTH, l.level);
      for (const w of cocTownHallWeapons(j, warn)) add(w, false);
      continue;
    }

    if (folder === 'heroes') {
      const levels = (j.levels ?? []).map(
        (l: any): LevelInfo => ({
          level: l.level,
          cost: l.upgradeCost ?? 0,
          resource: mapResource(l.upgradeCostResource, warn),
          timeSec: toSeconds(l.upgradeTime),
          heroHallRequired: l.heroHallLevelRequired,
        }),
      );
      add({ key: String(j.dataId), dataId: j.dataId, id: j.id, name: j.name, category: 'hero', queue: 'builder', levels: sortLevels(levels), images });
      continue;
    }

    if (folder === 'troops' || folder === 'spells' || folder === 'siege-machines') {
      const category: Category = folder === 'troops' ? 'troop' : folder === 'spells' ? 'spell' : 'siege';
      const levels = (j.levels ?? []).map(
        (l: any): LevelInfo => ({
          level: l.level,
          cost: l.researchCost ?? 0,
          resource: mapResource(l.researchCostResource, warn),
          timeSec: toSeconds(l.researchTime),
          thRequired: l.townHallRequired,
          labRequired: l.laboratoryRequired,
        }),
      );
      const housing = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);
      add({
        key: String(j.dataId),
        dataId: j.dataId,
        id: j.id,
        name: j.name,
        category,
        queue: 'lab',
        levels: sortLevels(levels),
        housingSpace: housing(j.housingSpace),
        superHousingSpace: housing(j.superTroop?.housingSpace),
        images,
      });
      continue;
    }

    if (folder === 'pets') {
      const levels = (j.levels ?? []).map(
        (l: any): LevelInfo => ({
          level: l.level,
          cost: l.upgradeCost ?? 0,
          resource: mapResource(l.upgradeCostResource, warn),
          timeSec: toSeconds(l.upgradeTime),
          thRequired: l.townHallRequired,
          petHouseRequired: l.petHouseLevelRequired,
        }),
      );
      add({ key: String(j.dataId), dataId: j.dataId, id: j.id, name: j.name, category: 'pet', queue: 'petHouse', levels: sortLevels(levels), images });
      continue;
    }

    if (folder === 'hero-equipment') {
      const levels = (j.levels ?? []).map((l: any): LevelInfo => {
        const ore = { shinyOre: l.upgradeShinyOre ?? 0, glowyOre: l.upgradeGlowingOre ?? 0, starryOre: l.upgradeStarryOre ?? 0 };
        return { level: l.level, cost: ore.shinyOre, resource: 'shinyOre', timeSec: 0, blacksmithRequired: l.blacksmithLevelRequired, ore };
      });
      add({ key: String(j.dataId), dataId: j.dataId, id: j.id, name: j.name, category: 'equipment', queue: 'blacksmith', hero: j.hero, levels: sortLevels(levels), images });
      continue;
    }

    if (folder === 'crafted-defenses') {
      if (typeof j.dataId !== 'number') continue; // older phases without ids can't appear in exports
      add({ key: String(j.dataId), dataId: j.dataId, id: j.id, name: j.name, category: 'craftedDefense', queue: 'none', levels: [], images });
      for (const m of j.modules ?? []) {
        if (typeof m.dataId !== 'number') continue;
        add(
          {
            key: `${j.dataId}:m${m.dataId}`,
            dataId: m.dataId,
            id: `${j.id}-${String(m.name).toLowerCase().replace(/\s+/g, '-')}`,
            name: `${j.name} ${m.name}`,
            category: 'craftedDefense',
            queue: 'builder',
            craftedDefenseId: j.dataId,
            images,
            levels: sortLevels((m.upgrades ?? []).map(bLevel)),
          },
          false,
        );
      }
      continue;
    }

    if (folder === 'other' && sub === 'helpers') {
      if (typeof j.dataId !== 'number') continue;
      const helperWorkRates: Record<number, number> = {};
      for (const l of j.levels ?? []) if (typeof l?.level === 'number' && typeof l?.workRate === 'number') helperWorkRates[l.level] = l.workRate;
      add({
        key: String(j.dataId),
        dataId: j.dataId,
        id: j.id,
        name: j.name,
        category: 'helper',
        queue: 'none',
        levels: [],
        ...(Object.keys(helperWorkRates).length ? { helperWorkRates } : {}),
        images,
      });
      continue;
    }

    // Everything else is a building with buildCost/buildTime levels.
    if (typeof j.dataId !== 'number' || !Array.isArray(j.levels) || j.levels.length === 0) continue;

    let category: Category;
    let queue: Queue = 'builder';
    if (folder === 'defenses') category = mergedIds.has(j.id) ? 'mergedDefense' : j.id === 'crafting-station' ? 'other' : 'defense';
    else if (folder === 'army-buildings') category = 'army';
    else if (folder === 'resource-buildings') category = STORAGES.has(j.id) ? 'resourceStorage' : COLLECTORS.has(j.id) ? 'resourceCollector' : 'army';
    else if (folder === 'traps') category = 'trap';
    else if (folder === 'walls') {
      category = 'wall';
      queue = 'none'; // walls are instant; only used for the wall dump line
    } else if (folder === 'guardians') category = 'guardian';
    else category = 'other';

    const normal = j.levels.filter((l: any) => !l.supercharge).map(bLevel);
    const sc = j.levels.filter((l: any) => l.supercharge).map(bLevel);

    add({
      key: String(j.dataId),
      dataId: j.dataId,
      id: j.id,
      name: j.name,
      category,
      queue,
      levels: sortLevels(normal),
      countPerTH: perTH(j.availablePerTownHall, 'count'),
      countAfterMergesPerTH: perTH(j.availablePerTownHall, 'countAfterMerges'),
      images,
    });
    if (sc.length) {
      add(
        {
          key: `${j.dataId}:sc`,
          dataId: j.dataId,
          id: `${j.id}-supercharge`,
          name: `${j.name} Supercharge`,
          category: 'supercharge',
          queue: 'builder',
          baseKey: String(j.dataId),
          levels: sortLevels(sc),
          images,
        },
        false,
      );
    }

    if (j.id === 'hero-hall') {
      for (const l of j.levels) {
        if (!l.heroLevelCaps) continue;
        const caps: Record<string, number> = {};
        for (const [k, v] of Object.entries(l.heroLevelCaps)) caps[camelToKebab(k)] = v as number;
        heroHallCaps[l.level] = caps;
      }
    }
  }

  let bookThresholdSec = 0;
  for (const it of items.values()) {
    if (it.category !== 'hero') continue;
    for (const l of it.levels) bookThresholdSec = Math.max(bookThresholdSec, l.timeSec);
  }

  const merges = buildMergeRecipes(byId, recipes, 'merges');
  const superTroops = resolveSuperTroops(byId, { ...COC_BACKUP_SUPER_TROOPS, ...parseSuperTroops(superTroopsYaml) });

  return {
    version,
    source: 'clash-of-clans-data',
    items,
    byDataId,
    byId,
    maxTH,
    bookThresholdSec,
    merges,
    superTroops,
    thRequirements: {}, // clash-of-clans-data has no TH upgrade requirements
    heroHallCaps,
    warnings: [...warningSet],
  };
}

/** Max level of an item reachable at the given TH (and Hero Hall/lab/etc. via `req`). 0 if none. */
export function maxLevelAt(
  item: Item,
  req: { th: number; heroHall?: number; lab?: number; petHouse?: number; blacksmith?: number },
): number {
  let max = 0;
  for (const l of item.levels) {
    if (l.thRequired !== undefined && l.thRequired > req.th) continue;
    if (l.heroHallRequired !== undefined && l.heroHallRequired > (req.heroHall ?? 0)) continue;
    if (l.labRequired !== undefined && l.labRequired > (req.lab ?? 0)) continue;
    if (l.petHouseRequired !== undefined && l.petHouseRequired > (req.petHouse ?? 0)) continue;
    if (l.blacksmithRequired !== undefined && l.blacksmithRequired > (req.blacksmith ?? 0)) continue;
    max = Math.max(max, l.level);
  }
  return max;
}

export function levelInfo(item: Item, level: number): LevelInfo | undefined {
  return item.levels.find((l) => l.level === level);
}

/** Allowed count of a building at a TH (nearest defined TH at or below). */
export function countAt(rec: Record<number, number> | undefined, th: number): number | undefined {
  if (!rec) return undefined;
  let best: number | undefined;
  let bestTh = -1;
  for (const [k, v] of Object.entries(rec)) {
    const t = Number(k);
    if (t <= th && t > bestTh) {
      bestTh = t;
      best = v;
    }
  }
  return best;
}
