// Parse the in-game account export (SPEC §3.2) into AccountState, joining on dataId.
import type { GameData, OwnedInstance } from '../data/types';
import { IDS, levelsOf } from './levels';

export interface Unresolved {
  section: string;
  dataId: number;
}

/**
 * Active boosts (SPEC §10.1), seconds remaining at the export time. Keys follow the coc.py AccountData
 * parser (`Boosts`): builder_boost, lab_boost, clocktower_boost, clocktower_cooldown, builder_consumable,
 * lab_consumable, helper_cooldown. Missing keys are 0.
 */
export interface Boosts {
  builderPotionSec: number;
  researchPotionSec: number;
  builderSnackSec: number;
  researchSnackSec: number;
  clockTowerSec: number;
  clockTowerCooldownSec: number;
}

export const NO_BOOSTS: Boosts = { builderPotionSec: 0, researchPotionSec: 0, builderSnackSec: 0, researchSnackSec: 0, clockTowerSec: 0, clockTowerCooldownSec: 0 };

const BOOST_KEYS: Record<string, keyof Boosts | 'helperCooldown'> = {
  builder_boost: 'builderPotionSec',
  lab_boost: 'researchPotionSec',
  builder_consumable: 'builderSnackSec',
  lab_consumable: 'researchSnackSec',
  clocktower_boost: 'clockTowerSec',
  clocktower_cooldown: 'clockTowerCooldownSec',
  helper_cooldown: 'helperCooldown',
};

export interface OwnedHelper {
  dataId: number;
  id: string;
  name: string;
  level: number;
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
  /** Parsed active boosts (all 0 when the export's `boosts` is empty). */
  boosts: Boosts;
  /** The raw `boosts` object, as exported. */
  rawBoosts: unknown;
  /** Helpers from the `helpers` section (Builder's Apprentice, Lab Assistant, Prospector, Alchemist). */
  helpers: OwnedHelper[];
  /** Seconds until the helpers can work again, at the export time (`helper_cooldown`); undefined = ready. */
  helperCooldownSec?: number;
  /** Non-fatal parse notes (unknown boost keys or shapes). Shown on the Plan tab. */
  warnings: string[];
}

/** Reads the export's `boosts` object. Unknown keys or shapes produce a warning, never an error. */
export function parseBoosts(raw: unknown, warnings: string[]): { boosts: Boosts; helperCooldownSec?: number } {
  const boosts: Boosts = { ...NO_BOOSTS };
  let helperCooldownSec: number | undefined;
  if (raw === undefined || raw === null) return { boosts };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`Export "boosts" has an unexpected shape (${Array.isArray(raw) ? 'list' : typeof raw}); active boosts are ignored.`);
    return { boosts };
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const field = BOOST_KEYS[k];
    if (!field) {
      warnings.push(`Unknown boost "${k}" in the export (value ${JSON.stringify(v)?.slice(0, 40)}); ignored.`);
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      warnings.push(`Boost "${k}" has an unexpected value (${JSON.stringify(v)?.slice(0, 40)}); ignored.`);
      continue;
    }
    if (field === 'helperCooldown') helperCooldownSec = v;
    else boosts[field] = v;
  }
  return { boosts, helperCooldownSec };
}

export { IDS };

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

  let builders = 0;
  const warnings: string[] = [];
  const helpers: OwnedHelper[] = [];
  const parsedBoosts = parseBoosts(raw.boosts, warnings);
  const boosts = parsedBoosts.boosts;
  let helperCooldownSec = parsedBoosts.helperCooldownSec;

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

      if (section === 'helpers') {
        helpers.push({ dataId, id: item.id, name: item.name, level: lvl });
        // Like coc.py, a per-helper helper_cooldown sets the shared helper cooldown (they share one timer).
        if (typeof e.helper_cooldown === 'number' && e.helper_cooldown >= 0) helperCooldownSec = Math.max(helperCooldownSec ?? 0, e.helper_cooldown);
        continue;
      }

      if (dataId === IDS.wall) {
        walls.push({ level: lvl, count: cnt });
        continue;
      }
      if (dataId === IDS.builderHut || dataId === IDS.bobHut) builders += cnt;

      for (let i = 0; i < cnt; i++) {
        const inst: OwnedInstance = { uid: nextUid(item.key), dataId, itemKey: item.key, level: lvl };
        if (typeof e.timer === 'number' && e.timer > 0) {
          inst.upgradingTo = lvl + 1;
          inst.remainingSec = e.timer;
        }
        if (e.extra === true) inst.goblin = true;
        // The real export says helper_recurrent; coc.py documents recurrent_helper. Accept both.
        if (e.helper_recurrent === true || e.recurrent_helper === true) inst.helperRecurrent = true;
        if (typeof e.helper_timer === 'number' && e.helper_timer > 0 && inst.upgradingTo !== undefined) inst.helperTimerSec = e.helper_timer;
        if (typeof e.supercharge === 'number') inst.superchargeLevel = e.supercharge;
        if (typeof e.weapon === 'number') inst.weaponLevel = e.weapon;
        instances.push(inst);
      }
    }
  }

  const lv = levelsOf(instances);
  if (!lv.th) throw new ExportParseError('No Town Hall found in the export.');

  walls.sort((a, b) => a.level - b.level);
  return {
    tag: typeof raw.tag === 'string' ? raw.tag : undefined,
    exportTimestamp: typeof raw.timestamp === 'number' ? raw.timestamp : undefined,
    townHall: lv.th,
    heroHall: lv.heroHall,
    lab: lv.lab,
    petHouse: lv.petHouse,
    blacksmith: lv.blacksmith,
    builders: Math.max(1, builders),
    instances,
    walls,
    unresolved,
    boosts,
    rawBoosts: raw.boosts ?? {},
    helpers,
    helperCooldownSec,
    warnings,
  };
}
