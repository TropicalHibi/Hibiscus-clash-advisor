// Test helpers: build realistic synthetic exports straight from the game data.
import { dataVersion, loadGameDataNode, readConfig, readIdOverrides, readRawFiles } from '../src/data/loadNode';
import { countAt, maxLevelAt, normalize, type RawFile } from '../src/data/normalize';
import type { GameData } from '../src/data/types';
import { heroCapAt } from '../src/engine/book';
import { parseExport } from '../src/state/parseExport';
import { DEFAULT_SETTINGS, type Settings } from '../src/state/settings';

export const data = loadGameDataNode();

export const T0 = 1_790_000_000; // fixed "export time" (2026-09-21, in the past) for deterministic tests

export interface Entry {
  data: number;
  lvl: number;
  cnt?: number;
  timer?: number;
  extra?: boolean;
  supercharge?: number;
  weapon?: number;
  types?: { data: number; modules: { data: number; lvl: number; timer?: number }[] }[];
}

export interface SyntheticExport {
  tag: string;
  timestamp?: number;
  buildings: Entry[];
  traps: Entry[];
  heroes: Entry[];
  units: Entry[];
  siege_machines: Entry[];
  spells: Entry[];
  pets: Entry[];
  equipment: Entry[];
  guardians: Entry[];
  helpers: Entry[];
  buildings2: Entry[];
  boosts: Record<string, unknown>;
}

const BUILDING_CATS = new Set(['townHall', 'defense', 'mergedDefense', 'army', 'resourceStorage', 'resourceCollector', 'trap', 'wall', 'other']);

/**
 * Every building the TH allows (merges completed), each at the max level for `levelTH`
 * (default th − 1 = freshly rushed). Heroes at their cap for the Hero Hall level.
 */
export function makeExport(th: number, levelTH = th - 1): SyntheticExport {
  const ex: SyntheticExport = {
    tag: '#TEST',
    timestamp: T0,
    buildings: [],
    traps: [],
    heroes: [],
    units: [],
    siege_machines: [],
    spells: [],
    pets: [],
    equipment: [],
    guardians: [],
    helpers: [],
    buildings2: [{ data: 1000033, lvl: 5, cnt: 10 }], // Builder Base: must be ignored
    boosts: {},
  };
  for (const item of data.byDataId.values()) {
    if (!BUILDING_CATS.has(item.category)) continue;
    if (item.category === 'townHall') {
      ex.buildings.push({ data: item.dataId, lvl: th });
      continue;
    }
    if (!item.countPerTH) continue;
    const count = countAt(item.countAfterMergesPerTH, th) ?? countAt(item.countPerTH, th) ?? 0;
    if (count <= 0) continue;
    const lvl = Math.max(1, Math.min(maxLevelAt(item, { th: levelTH }), maxLevelAt(item, { th })));
    const entry = { data: item.dataId, lvl, cnt: count };
    (item.category === 'trap' ? ex.traps : ex.buildings).push(entry);
  }
  const hh = ex.buildings.find((b) => b.data === 1000071)?.lvl ?? 0;
  for (const item of data.byDataId.values()) {
    if (item.category !== 'hero') continue;
    const cap = heroCapAt(item, hh);
    if (cap > 0) ex.heroes.push({ data: item.dataId, lvl: cap });
  }
  // A few lab items and pets so the queues have something to do.
  for (const id of ['barbarian', 'archer', 'balloon', 'rage-spell', 'wall-wrecker']) {
    const it = data.byId.get(id)!;
    const list = it.category === 'spell' ? ex.spells : it.category === 'siege' ? ex.siege_machines : ex.units;
    list.push({ data: it.dataId, lvl: 3 });
  }
  if (th >= 14) ex.pets.push({ data: data.byId.get('lassi')!.dataId, lvl: 2 });
  ex.equipment.push({ data: data.byId.get('barbarian-puppet')!.dataId, lvl: 3 });
  return ex;
}

export function setLevel(ex: SyntheticExport, section: keyof SyntheticExport, id: string, patch: Partial<Entry>): void {
  const dataId = data.byId.get(id)!.dataId;
  const list = ex[section] as Entry[];
  const e = list.find((x) => x.data === dataId);
  if (!e) throw new Error(`${id} not in ${String(section)}`);
  Object.assign(e, patch);
}

/**
 * A modified copy of the game data, for "what if the next data release…" tests. `mutate` edits the raw
 * JSON files in place; helpers below cover the common edits. The real data object is never touched.
 */
export function modifiedData(mutate: (files: RawFile[]) => void, mergesYaml = readConfig('merges.yaml')): GameData {
  const files = readRawFiles().map((f) => ({ path: f.path, json: structuredClone(f.json) }));
  mutate(files);
  return normalize(files, mergesYaml, dataVersion(), readIdOverrides());
}
export const rawItem = (files: RawFile[], id: string) => files.find((f) => f.json?.id === id)!.json;
/** Adds a Town Hall level (copy of the current top level, without a weapon). */
export function addTownHallLevel(files: RawFile[]): void {
  const th = files.find((f) => f.path.startsWith('town-hall/'))!.json;
  const top = th.levels[th.levels.length - 1];
  th.levels.push({ ...structuredClone(top), level: top.level + 1, weapon: undefined });
}
/** Appends a normal (non-supercharge) level to a building, requiring `thRequired`. */
export function addBuildingLevel(files: RawFile[], id: string, thRequired: number, patch: Record<string, unknown> = {}): void {
  const j = rawItem(files, id);
  const normal = j.levels.filter((l: any) => !l.supercharge);
  const last = normal[normal.length - 1];
  j.levels.push({ ...structuredClone(last), level: last.level + 1, townHallRequired: thRequired, ...patch });
}
export const parseWith = (ex: SyntheticExport, d: GameData) => parseExport(JSON.parse(JSON.stringify(ex)), d);

/** Laboratory at its max for the export's TH, so the Tier 0 Lab rule stays out of tests about other tiers. */
export function maxLab(ex: SyntheticExport): SyntheticExport {
  const th = ex.buildings.find((b) => b.data === 1000001)!.lvl;
  const lab = data.byId.get('laboratory')!;
  ex.buildings.find((b) => b.data === lab.dataId)!.lvl = maxLevelAt(lab, { th });
  return ex;
}

export function parse(ex: SyntheticExport) {
  return parseExport(JSON.parse(JSON.stringify(ex)), data);
}

type SettingsPatch = Omit<Partial<Settings>, 'lab'> & { lab?: Partial<Settings['lab']> };
export function settings(patch: SettingsPatch = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch, lab: { ...DEFAULT_SETTINGS.lab, ...patch.lab } };
}
