// Parse the in-game account export (SPEC §3.2) into AccountState, joining on dataId.
import type { GameData, OwnedInstance } from '../data/types';

export interface Unresolved {
  section: string;
  dataId: number;
}

export interface AccountState {
  tag?: string;
  /** Unix seconds the export was taken (top-level `timestamp`), if present. */
  exportTimestamp?: number;
  townHall: number;
  heroHall: number;
  lab: number;
  petHouse: number;
  blacksmith: number;
  /** Regular builders: Builder's Huts + B.O.B's Hut. */
  builders: number;
  instances: OwnedInstance[];
  walls: { level: number; count: number }[];
  unresolved: Unresolved[];
  boosts: unknown;
}

export const IDS = {
  townHall: 1000001,
  wall: 1000010,
  builderHut: 1000015,
  bobHut: 1000064,
  laboratory: 1000007,
  petHouse: 1000068,
  blacksmith: 1000070,
  heroHall: 1000071,
  craftingStation: 1000097,
} as const;

/** Home-village sections we read. `units` is the real name; `troops` accepted per the coc.py shape. */
const SECTIONS = ['buildings', 'traps', 'heroes', 'units', 'troops', 'siege_machines', 'spells', 'pets', 'equipment', 'guardians', 'helpers'];

export class ExportParseError extends Error {}

export function parseExport(input: string | object, data: GameData): AccountState {
  let raw: any;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) throw new ExportParseError('The export is empty. Paste the JSON copied from in-game settings.');
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new ExportParseError(`Not valid JSON: ${(e as Error).message}`);
    }
  } else raw = input;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.buildings)) {
    throw new ExportParseError('This does not look like a Clash of Clans account export (no "buildings" list).');
  }

  const instances: OwnedInstance[] = [];
  const walls: { level: number; count: number }[] = [];
  const unresolved: Unresolved[] = [];
  const seq = new Map<string, number>();
  const nextUid = (base: string) => {
    const n = (seq.get(base) ?? 0) + 1;
    seq.set(base, n);
    return `${base}#${n}`;
  };

  let townHall = 0;
  let heroHall = 0;
  let lab = 0;
  let petHouse = 0;
  let blacksmith = 0;
  let builders = 0;

  for (const section of SECTIONS) {
    const list = raw[section];
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || typeof e !== 'object' || typeof e.data !== 'number') continue;
      const dataId: number = e.data;

      // Crafting Station: nested crafted defenses → modules.
      if (dataId === IDS.craftingStation && Array.isArray(e.types)) {
        for (const t of e.types) {
          const defUid = `cd:${t.data}`;
          if (!data.byDataId.has(t.data)) unresolved.push({ section: 'buildings.types', dataId: t.data });
          for (const m of t.modules ?? []) {
            const key = `${t.data}:m${m.data}`;
            if (!data.items.has(key)) {
              unresolved.push({ section: 'buildings.types.modules', dataId: m.data });
              continue;
            }
            instances.push({
              uid: nextUid(key),
              dataId: m.data,
              itemKey: key,
              level: m.lvl ?? 1,
              parentUid: defUid,
              ...(m.timer ? { upgradingTo: (m.lvl ?? 1) + 1, remainingSec: m.timer } : {}),
              ...(m.extra ? { goblin: true } : {}),
            });
          }
        }
        continue;
      }

      const item = data.byDataId.get(dataId);
      if (!item) {
        unresolved.push({ section, dataId });
        continue;
      }
      const lvl: number = typeof e.lvl === 'number' ? e.lvl : 0;
      const cnt: number = typeof e.cnt === 'number' && e.cnt > 0 ? e.cnt : 1;

      if (dataId === IDS.wall) {
        walls.push({ level: lvl, count: cnt });
        continue;
      }
      if (dataId === IDS.townHall) townHall = Math.max(townHall, lvl);
      if (dataId === IDS.heroHall) heroHall = Math.max(heroHall, lvl);
      if (dataId === IDS.laboratory) lab = Math.max(lab, lvl);
      if (dataId === IDS.petHouse) petHouse = Math.max(petHouse, lvl);
      if (dataId === IDS.blacksmith) blacksmith = Math.max(blacksmith, lvl);
      if (dataId === IDS.builderHut || dataId === IDS.bobHut) builders += cnt;

      for (let i = 0; i < cnt; i++) {
        const inst: OwnedInstance = { uid: nextUid(item.key), dataId, itemKey: item.key, level: lvl };
        if (typeof e.timer === 'number' && e.timer > 0) {
          inst.upgradingTo = lvl + 1;
          inst.remainingSec = e.timer;
        }
        if (e.extra === true) inst.goblin = true;
        if (typeof e.supercharge === 'number') inst.superchargeLevel = e.supercharge;
        if (typeof e.weapon === 'number') inst.weaponLevel = e.weapon;
        instances.push(inst);
      }
    }
  }

  if (!townHall) throw new ExportParseError('No Town Hall found in the export.');

  walls.sort((a, b) => a.level - b.level);
  return {
    tag: typeof raw.tag === 'string' ? raw.tag : undefined,
    exportTimestamp: typeof raw.timestamp === 'number' ? raw.timestamp : undefined,
    townHall,
    heroHall,
    lab,
    petHouse,
    blacksmith,
    builders: Math.max(1, builders),
    instances,
    walls,
    unresolved,
    boosts: raw.boosts ?? {},
  };
}
