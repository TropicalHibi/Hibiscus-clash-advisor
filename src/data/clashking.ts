// ClashKing static data → Item model (SPEC §3.1, §5). Source: static/static_data.json from
// github.com/ClashKingInc/clashy.go, trimmed and pinned in data/clashking/ by `npm run sync` (§9).
//
// Level semantics, checked against clash-of-clans-data across every item (DECISIONS.md):
// - buildings, traps, crafted-defense modules, supercharges: `build_cost` / `build_time` on level N = the cost
//   and time of level N (same as clash-of-clans-data).
// - troops, spells, heroes, pets, guardians, equipment: `upgrade_cost` / `upgrade_time` on level N = the cost
//   of going N → N+1. So level N's cost/time comes from row N−1, and level 1 costs nothing.
// - every `required_*` field on level N is the requirement to have level N (no shift).
import { buildMergeRecipes, mapResource, maxLevelAt, resolveSuperTroops } from './normalize.ts';
import { EMPTY_OVERRIDES, type MergeOverride, type Overrides } from './overrides.ts';
import type { Category, GameData, Item, LevelInfo, OreCost, Queue, ThRequirement } from './types.ts';

/** Sections of static_data.json the planner uses (everything else is dropped when the file is pinned). */
export const CK_SECTIONS = ['buildings', 'traps', 'troops', 'spells', 'heroes', 'pets', 'equipment', 'guardians', 'helpers'] as const;
export type CkSection = (typeof CK_SECTIONS)[number];
export type ClashKingRaw = Record<CkSection, any[]>;

export const CK_REPO = 'ClashKingInc/clashy.go';
export const CK_PATH = 'static/static_data.json';

/** Stable item id from a ClashKing name: "Builder's Hut" → "builders-hut", "P.E.K.K.A" → "pekka". */
export function ckSlug(name: string): string {
  return String(name)
    .toLowerCase()
    .replace(/[’'.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Keeps the sections the planner reads, home village only, without the long `info` texts and `TID` keys.
 * Throws when a section is missing or not a list: the file's shape changed and must not be pinned.
 */
export function trimClashKing(full: unknown): ClashKingRaw {
  if (!full || typeof full !== 'object') throw new Error('ClashKing static data is not a JSON object');
  const strip = (v: any): any => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== 'object') return v;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'info' && k !== 'TID') o[k] = strip(x);
    return o;
  };
  const out = {} as ClashKingRaw;
  for (const s of CK_SECTIONS) {
    const list = (full as Record<string, unknown>)[s];
    if (!Array.isArray(list)) throw new Error(`ClashKing static data has no "${s}" list`);
    out[s] = strip(list.filter((x: any) => x && x.village !== 'builderBase'));
  }
  return out;
}

export interface ClashKingOptions {
  version: string;
  overrides?: Overrides;
  /** TH weapon items (ClashKing has no weapon levels; taken from clash-of-clans-data). */
  weapons?: Item[];
  /** Image candidates for an item (clash-of-clans-data files, matched by id then dataId). Node only. */
  images?: (id: string, dataId: number) => string[] | undefined;
}

/** Tie-break order of merges unlocked at the same TH: the order config/merges.yaml listed them in. */
const LEGACY_MERGE_ORDER = ['ricochet-cannon', 'multi-archer-tower', 'multi-gear-tower', 'super-wizard-tower'];

const STORAGES = new Set(['gold-storage', 'elixir-storage', 'dark-elixir-storage']);
const COLLECTORS = new Set(['gold-mine', 'elixir-collector', 'dark-elixir-drill']);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const req = (v: unknown): number | undefined => num(v);
const sortLevels = (levels: LevelInfo[]) => levels.sort((a, b) => a.level - b.level);
const housing = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);

/** Building/trap/module level: cost and time of this level. */
function buildLevel(l: any, resource: string, warn: (m: string) => void): LevelInfo {
  return {
    level: l.level,
    cost: num(l.build_cost) ?? 0,
    resource: l.alt_upgrade_resource ? 'goldOrElixir' : mapResource(resource, warn),
    timeSec: num(l.build_time) ?? 0,
    ...(req(l.required_townhall) !== undefined ? { thRequired: l.required_townhall } : {}),
  };
}

/** Upgrade-style levels: level N's cost/time are on row N−1 (see the header). */
function shiftedLevels(rows: any[], fill: (row: any, prev: any | undefined) => LevelInfo): LevelInfo[] {
  const sorted = [...rows].filter((r) => typeof r?.level === 'number').sort((a, b) => a.level - b.level);
  return sorted.map((row, i) => fill(row, i > 0 && sorted[i - 1].level === row.level - 1 ? sorted[i - 1] : undefined));
}

export function normalizeClashKing(raw: ClashKingRaw, opts: ClashKingOptions): GameData {
  const overrides = opts.overrides ?? EMPTY_OVERRIDES;
  const warningSet = new Set<string>();
  const warn = (m: string) => warningSet.add(m);
  const items = new Map<string, Item>();
  const byDataId = new Map<number, Item>();
  const byId = new Map<string, Item>();

  const dataIdOf = (id: string, dataId: number): number => {
    const o = overrides.ids.get(id);
    if (o === undefined || o === dataId) return dataId;
    warn(`config/id-overrides.yaml maps ${o} to "${id}"; ClashKing says ${dataId}. Using the override.`);
    return o;
  };
  const imagesOf = (id: string, dataId: number) => opts.images?.(id, dataId) ?? undefined;
  const add = (item: Item, base = true) => {
    if (!item.images?.length) delete item.images;
    items.set(item.key, item);
    if (base) {
      const clash = byDataId.get(item.dataId);
      if (clash && clash.id !== item.id) warn(`dataId ${item.dataId} is used by both "${clash.id}" and "${item.id}" (check config/id-overrides.yaml); "${item.id}" wins.`);
      byDataId.set(item.dataId, item);
      byId.set(item.id, item);
    }
  };
  const list = (s: CkSection): any[] => (Array.isArray(raw?.[s]) ? raw[s] : []);

  // ── Town Hall: levels, max TH, cumulative building counts, TH-level merges ──
  const thRaw = list('buildings').find((b) => b.type === 'Town Hall');
  if (!thRaw) throw new Error('ClashKing data has no Town Hall');
  const thLevels = [...thRaw.levels].sort((a: any, b: any) => a.level - b.level);
  const maxTH = Math.max(0, ...thLevels.map((l: any) => l.level));
  // Counts per TH = running sum of Town Hall `unlocks` (pre-merge totals, like availablePerTownHall.count).
  const countPerTH = new Map<number, Record<number, number>>();
  const running = new Map<number, number>();
  for (const l of thLevels) {
    for (const u of l.unlocks ?? []) if (typeof u?._id === 'number') running.set(u._id, (running.get(u._id) ?? 0) + (num(u.quantity) ?? 0));
    // A TH level with its own merge_requirement absorbs those buildings (TH17 takes the Eagle Artillery).
    for (const m of l.merge_requirement ?? []) if (typeof m?._id === 'number') running.set(m._id, Math.max(0, (running.get(m._id) ?? 0) - 1));
    for (const [id, n] of running) {
      if (!countPerTH.has(id)) countPerTH.set(id, {});
      countPerTH.get(id)![l.level] = n;
    }
  }
  const thDataId = dataIdOf('town-hall', thRaw._id);
  add({
    key: String(thDataId),
    dataId: thDataId,
    id: 'town-hall',
    name: thRaw.name,
    category: 'townHall',
    queue: 'builder',
    levels: sortLevels(thLevels.map((l: any) => ({ ...buildLevel(l, thRaw.upgrade_resource, warn), thRequired: l.level - 1 }))),
    images: imagesOf('town-hall', thRaw._id),
  });
  for (const w of opts.weapons ?? []) add({ ...w, dataId: thDataId, key: `${thDataId}:w${w.weaponForTH}` }, false);

  // ── Merges from level-1 merge_requirement (exact source levels); config/merges.yaml wins ──
  const ckName = new Map<number, string>();
  for (const s of CK_SECTIONS) for (const x of list(s)) if (typeof x?._id === 'number' && x.name) ckName.set(x._id, ckSlug(x.name));
  const recipes: Record<string, MergeOverride> = {};
  for (const b of list('buildings')) {
    if (b === thRaw) continue;
    const first = (b.levels ?? []).find((l: any) => l.level === 1);
    const reqs: any[] = first?.merge_requirement ?? [];
    if (!reqs.length) continue;
    const bySource = new Map<string, { id: string; qty: number; level?: number }>();
    for (const r of reqs) {
      const id = ckName.get(r._id) ?? ckSlug(r.name);
      const cur = bySource.get(id) ?? { id, qty: 0 };
      cur.qty += 1;
      if (typeof r.level === 'number') cur.level = Math.max(cur.level ?? 0, r.level);
      bySource.set(id, cur);
    }
    recipes[ckSlug(b.name)] = { dataId: b._id, sources: [...bySource.values()] };
  }
  for (const [id, r] of Object.entries(overrides.merges)) recipes[id] = r;
  const mergedIds = new Set(Object.keys(recipes));

  // ── Buildings and traps ──
  const building = (b: any, isTrap: boolean) => {
    const id = ckSlug(b.name);
    const dataId = dataIdOf(id, b._id);
    let category: Category;
    let queue: Queue = 'builder';
    if (isTrap) category = 'trap';
    else
      switch (b.type) {
        case 'Defense':
          category = mergedIds.has(id) ? 'mergedDefense' : id === 'crafting-station' ? 'other' : 'defense';
          break;
        case 'Army':
          category = 'army';
          break;
        case 'Resource':
          category = STORAGES.has(id) ? 'resourceStorage' : COLLECTORS.has(id) ? 'resourceCollector' : 'army';
          break;
        case 'Wall':
          category = 'wall';
          queue = 'none'; // walls are instant; only used for the wall dump line
          break;
        case 'Worker':
          category = 'defense'; // Builder's Hut (it has a turret), as in clash-of-clans-data
          break;
        default:
          category = 'other'; // B.O.B's Hut, Helper Hut, …
      }
    const levels = (b.levels ?? []).filter((l: any) => typeof l?.level === 'number');
    // A building without levels is still recognised (no "unknown id" warning), but never scheduled.
    if (!levels.length) queue = 'none';
    add({
      key: String(dataId),
      dataId,
      id,
      name: b.name,
      category,
      queue,
      levels: sortLevels(levels.map((l: any) => buildLevel(l, b.upgrade_resource, warn))),
      ...(countPerTH.has(b._id) ? { countPerTH: countPerTH.get(b._id) } : {}),
      images: imagesOf(id, b._id),
    });
    // Supercharge: the `supercharge` block on the top level.
    const top = levels.filter((l: any) => l.supercharge?.levels?.length).at(-1);
    if (top) {
      const sc = top.supercharge;
      add(
        {
          key: `${dataId}:sc`,
          dataId,
          id: `${id}-supercharge`,
          name: `${b.name} Supercharge`,
          category: 'supercharge',
          queue: 'builder',
          baseKey: String(dataId),
          levels: sortLevels(sc.levels.map((l: any) => ({ ...buildLevel({ ...l, required_townhall: l.required_townhall ?? sc.required_townhall }, sc.upgrade_resource ?? b.upgrade_resource, warn) }))),
          images: imagesOf(id, b._id),
        },
        false,
      );
    }
    // Crafting Station: the current phase's crafted defenses and their modules.
    for (const d of b.seasonal_defenses ?? []) {
      if (typeof d?._id !== 'number') continue;
      const did = ckSlug(d.name);
      add({ key: String(d._id), dataId: d._id, id: did, name: d.name, category: 'craftedDefense', queue: 'none', levels: [], images: imagesOf(did, d._id) });
      for (const m of d.modules ?? []) {
        if (typeof m?._id !== 'number') continue;
        const short = String(m.name).startsWith(d.name) ? String(m.name).slice(d.name.length).trim() : String(m.name);
        add(
          {
            key: `${d._id}:m${m._id}`,
            dataId: m._id,
            id: `${did}-${ckSlug(short)}`,
            name: m.name,
            category: 'craftedDefense',
            queue: 'builder',
            craftedDefenseId: d._id,
            levels: sortLevels((m.levels ?? []).map((l: any) => buildLevel(l, m.upgrade_resource ?? b.upgrade_resource, warn))),
            images: imagesOf(did, d._id),
          },
          false,
        );
      }
    }
  };
  for (const b of list('buildings')) if (b !== thRaw && typeof b?._id === 'number') building(b, false);
  for (const t of list('traps')) if (typeof t?._id === 'number') building(t, true);

  // Merge sources: count after merges = count − Σ(recipe qty × merged count), from the first merge's TH on.
  // Recipe order breaks ties between merges unlocked at the same TH (SPEC §6.3): the former merges.yaml order
  // first (so plans don't change), then the order the Town Hall `unlocks` list them.
  const unlockOrder = new Map<number, number>();
  for (const l of thLevels) for (const u of l.unlocks ?? []) if (!unlockOrder.has(u._id)) unlockOrder.set(u._id, unlockOrder.size);
  const legacy = (id: string) => (LEGACY_MERGE_ORDER.indexOf(id) + 1 || LEGACY_MERGE_ORDER.length + 1) - 1;
  const merges = buildMergeRecipes(byId, recipes, 'merges').sort(
    (a, b) => a.unlockTH - b.unlockTH || legacy(a.id) - legacy(b.id) || (unlockOrder.get(a.dataId) ?? 1e9) - (unlockOrder.get(b.dataId) ?? 1e9),
  );
  for (const m of merges) byDataId.get(m.dataId)!.category = 'mergedDefense';
  const sourceIds = new Set(merges.flatMap((m) => m.sources.map((s) => s.dataId)));
  for (const srcId of sourceIds) {
    const src = byDataId.get(srcId)!;
    const using = merges.filter((m) => m.sources.some((s) => s.dataId === srcId));
    const from = Math.min(...using.map((m) => m.unlockTH));
    const after: Record<number, number> = {};
    for (const [thStr, n] of Object.entries(src.countPerTH ?? {})) {
      const th = Number(thStr);
      if (th < from) continue;
      const consumed = using.reduce((sum, m) => {
        const q = m.sources.find((s) => s.dataId === srcId)!.qty;
        const counts = byDataId.get(m.dataId)!.countPerTH ?? {};
        let c = 0;
        for (const [t, v] of Object.entries(counts)) if (Number(t) <= th) c = v; // counts are cumulative per TH
        return sum + q * c;
      }, 0);
      after[th] = Math.max(0, n - consumed);
    }
    if (Object.keys(after).length) src.countAfterMergesPerTH = after;
  }

  // ── Heroes ──
  for (const h of list('heroes')) {
    const id = ckSlug(h.name);
    const dataId = dataIdOf(id, h._id);
    const levels = shiftedLevels(h.levels ?? [], (row, prev) => ({
      level: row.level,
      cost: num(prev?.upgrade_cost) ?? 0,
      resource: mapResource(h.upgrade_resource, warn),
      timeSec: num(prev?.upgrade_time) ?? 0,
      ...(req(row.required_hero_tavern_level) !== undefined ? { heroHallRequired: row.required_hero_tavern_level } : {}),
    }));
    add({ key: String(dataId), dataId, id, name: h.name, category: 'hero', queue: 'builder', levels, images: imagesOf(id, h._id) });
  }

  // ── Troops, sieges, spells (super troops → superTroops; seasonal → recognised, queue none) ──
  const superTable: Record<number, { name: string; base: string; housingSpace?: number }> = {};
  const superHousing = new Map<number, number>();
  for (const t of list('troops'))
    if (t?.super_troop && typeof t.super_troop.original_id === 'number') {
      superTable[t._id] = { name: t.name, base: ckName.get(t.super_troop.original_id) ?? '', housingSpace: housing(t.housing_space) };
      const hs = housing(t.housing_space);
      if (hs && !superHousing.has(t.super_troop.original_id)) superHousing.set(t.super_troop.original_id, hs);
    }
  const labUnit = (t: any, section: 'troops' | 'spells') => {
    if (t.super_troop) return;
    const id = ckSlug(t.name);
    const dataId = dataIdOf(id, t._id);
    const category: Category = section === 'spells' ? 'spell' : t.production_building === 'Workshop' ? 'siege' : 'troop';
    const levels = shiftedLevels(t.levels ?? [], (row, prev) => ({
      level: row.level,
      cost: num(prev?.upgrade_cost) ?? 0,
      resource: mapResource(t.upgrade_resource, warn),
      timeSec: num(prev?.upgrade_time) ?? 0,
      ...(req(row.required_townhall) !== undefined ? { thRequired: row.required_townhall } : {}),
      ...(req(row.required_lab_level) !== undefined ? { labRequired: row.required_lab_level } : {}),
    }));
    add({
      key: String(dataId),
      dataId,
      id,
      name: t.name,
      category,
      queue: t.is_seasonal ? 'none' : 'lab',
      levels,
      ...(t.is_seasonal ? { seasonal: true } : {}),
      housingSpace: housing(t.housing_space),
      superHousingSpace: superHousing.get(t._id),
      images: imagesOf(id, t._id),
    });
  };
  for (const t of list('troops')) if (typeof t?._id === 'number') labUnit(t, 'troops');
  for (const s of list('spells')) if (typeof s?._id === 'number') labUnit(s, 'spells');

  // ── Pets ──
  for (const p of list('pets')) {
    const id = ckSlug(p.name);
    const dataId = dataIdOf(id, p._id);
    const levels = shiftedLevels(p.levels ?? [], (row, prev) => ({
      level: row.level,
      cost: num(prev?.upgrade_cost) ?? 0,
      resource: mapResource(p.upgrade_resource, warn),
      timeSec: num(prev?.upgrade_time) ?? 0,
      ...(req(row.required_townhall) !== undefined ? { thRequired: row.required_townhall } : {}),
      ...(req(row.required_pet_house_level) !== undefined ? { petHouseRequired: row.required_pet_house_level } : {}),
    }));
    add({ key: String(dataId), dataId, id, name: p.name, category: 'pet', queue: 'petHouse', levels, images: imagesOf(id, p._id) });
  }

  // ── Equipment (ore; Blacksmith-gated) ──
  for (const e of list('equipment')) {
    const id = ckSlug(e.name);
    const dataId = dataIdOf(id, e._id);
    const levels = shiftedLevels(e.levels ?? [], (row, prev) => {
      const c = prev?.upgrade_cost ?? {};
      const ore: OreCost = { shinyOre: num(c.shiny_ore) ?? 0, glowyOre: num(c.glowy_ore) ?? 0, starryOre: num(c.starry_ore) ?? 0 };
      return {
        level: row.level,
        cost: ore.shinyOre,
        resource: 'shinyOre',
        timeSec: 0,
        ...(req(row.required_blacksmith_level) !== undefined ? { blacksmithRequired: row.required_blacksmith_level } : {}),
        ore,
      };
    });
    add({ key: String(dataId), dataId, id, name: e.name, category: 'equipment', queue: 'blacksmith', hero: e.hero ? ckSlug(e.hero) : undefined, levels, images: imagesOf(id, e._id) });
  }

  // ── Guardians (one each, from their first level's TH) ──
  for (const g of list('guardians')) {
    const id = ckSlug(g.name);
    const dataId = dataIdOf(id, g._id);
    const levels = shiftedLevels(g.levels ?? [], (row, prev) => ({
      level: row.level,
      cost: num(prev?.upgrade_cost) ?? 0,
      resource: mapResource(g.upgrade_resource, warn),
      timeSec: num(prev?.upgrade_time) ?? 0,
      ...(req(row.required_townhall) !== undefined ? { thRequired: row.required_townhall } : {}),
    }));
    const firstTH = levels[0]?.thRequired;
    add({
      key: String(dataId),
      dataId,
      id,
      name: g.name,
      category: 'guardian',
      queue: 'builder',
      levels,
      ...(firstTH !== undefined ? { countPerTH: { [firstTH]: 1 } } : {}),
      images: imagesOf(id, g._id),
    });
  }

  // ── Helpers (work rate = boost_multiplier per level) ──
  for (const h of list('helpers')) {
    if (typeof h?._id !== 'number') continue;
    const id = ckSlug(h.name);
    const dataId = dataIdOf(id, h._id);
    const helperWorkRates: Record<number, number> = {};
    for (const l of h.levels ?? []) if (typeof l?.level === 'number' && num(l.boost_multiplier) && l.boost_multiplier > 0) helperWorkRates[l.level] = l.boost_multiplier;
    add({
      key: String(dataId),
      dataId,
      id,
      name: h.name,
      category: 'helper',
      queue: 'none',
      levels: [],
      ...(Object.keys(helperWorkRates).length ? { helperWorkRates } : {}),
      images: imagesOf(id, h._id),
    });
  }

  let bookThresholdSec = 0;
  for (const it of items.values()) if (it.category === 'hero') for (const l of it.levels) bookThresholdSec = Math.max(bookThresholdSec, l.timeSec);

  // Super troops: data first, config/super-troops.yaml wins.
  const superTroops = resolveSuperTroops(byId, { ...superTable, ...overrides.superTroops });
  for (const [k, s] of Object.entries(overrides.superTroops)) {
    const base = byId.get(s.base);
    if (base && !base.superHousingSpace && superTable[Number(k)]?.housingSpace) base.superHousingSpace = superTable[Number(k)].housingSpace;
  }

  // ── TH upgrade requirements (SPEC §6.3 TH gate): any building level a Town Hall level lists ──
  // Generic: every array on a TH level whose entries name a building/trap `_id` with a `level`
  // (today only TH17's merge_requirement: Eagle Artillery 7). `unlocks` carries quantities, not levels.
  const buildingIds = new Set<number>();
  for (const b of [...list('buildings'), ...list('traps')]) if (typeof b?._id === 'number' && b !== thRaw) buildingIds.add(b._id);
  const thRequirements: Record<number, ThRequirement[]> = {};
  for (const l of thLevels) {
    const reqs = new Map<string, ThRequirement>();
    for (const [k, v] of Object.entries(l)) {
      if (k === 'unlocks' || !Array.isArray(v)) continue;
      for (const r of v as any[]) {
        if (typeof r?._id !== 'number' || typeof r?.level !== 'number' || !buildingIds.has(r._id)) continue;
        const id = ckName.get(r._id) ?? ckSlug(r.name ?? '');
        const item = byId.get(id);
        if (!item) {
          warn(`Town Hall ${l.level} requires "${r.name ?? r._id}" ${r.level}, which isn't in the data; ignored.`);
          continue;
        }
        const cur = reqs.get(id) ?? { id, dataId: item.dataId, level: 0, qty: 0 };
        cur.level = Math.max(cur.level, r.level);
        cur.qty += 1;
        reqs.set(id, cur);
      }
    }
    if (reqs.size) thRequirements[l.level] = [...reqs.values()];
  }

  return {
    version: opts.version,
    source: 'clashking',
    items,
    byDataId,
    byId,
    maxTH,
    bookThresholdSec,
    merges,
    superTroops,
    thRequirements,
    heroHallCaps: {},
    warnings: [...warningSet],
  };
}

/** Throws unless the trimmed file looks like ClashKing static data the planner can use. */
export function assertClashKingShape(raw: unknown): asserts raw is ClashKingRaw {
  for (const s of CK_SECTIONS) if (!Array.isArray((raw as Record<string, unknown> | null)?.[s])) throw new Error(`ClashKing data: "${s}" is missing`);
}

// Re-exported for callers that only import this module.
export { maxLevelAt };
