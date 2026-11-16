import { parse as parseYaml } from 'yaml';

export type GoldPass = 'none' | 'max';

/** Lab queue pick (SPEC §6.7): weight per kind applied to the within-kind normalized score. */
export interface LabKindWeights {
  troop: number;
  spell: number;
  siege: number;
}
export type LabKind = keyof LabKindWeights;

export const DEFAULT_LAB_WEIGHTS: LabKindWeights = { troop: 1, spell: 0.7, siege: 0.5 };

export interface Settings {
  goldPass: GoldPass;
  /** Apply the export's helpers (Builder's Apprentice, Lab Assistant) and active boosts in the scheduler (SPEC §10.1). */
  simulateHelpers: boolean;
  heroOrder: string[]; // hero file ids
  forecast: { windowHours: number; blacksmithTopN: number };
  lab: { pinned: string[]; kindWeights: LabKindWeights };
  petHouse: { pinned: string[] };
  blacksmith: { pinned: string[] };
}

export const DEFAULT_HERO_ORDER = ['archer-queen', 'grand-warden', 'dragon-duke', 'barbarian-king', 'royal-champion', 'minion-prince'];

export const DEFAULT_SETTINGS: Settings = {
  goldPass: 'none',
  simulateHelpers: true,
  heroOrder: DEFAULT_HERO_ORDER,
  forecast: { windowHours: 24, blacksmithTopN: 3 },
  lab: { pinned: [], kindWeights: DEFAULT_LAB_WEIGHTS },
  petHouse: { pinned: [] },
  blacksmith: { pinned: [] },
};

/**
 * A saved hero order: the saved order with duplicates removed (ids newer than the defaults are kept), and
 * any default hero missing from it appended in default order. Junk → the default order.
 */
export function heroOrder(v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return [...DEFAULT_HERO_ORDER];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of v as string[]) if (!seen.has(id)) (seen.add(id), out.push(id));
  for (const id of DEFAULT_HERO_ORDER) if (!seen.has(id)) out.push(id);
  return out;
}

/** Merge a partial settings object (YAML or localStorage) over the defaults, ignoring junk. */
export function coerceSettings(input: unknown): Settings {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const strList = (v: unknown, d: string[]) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...v] : [...d]);
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  // Kind weights may be 0 (never auto-pick that kind); negative / junk → default.
  const weight = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    goldPass: s.goldPass === 'max' ? 'max' : 'none',
    simulateHelpers: typeof s.simulateHelpers === 'boolean' ? s.simulateHelpers : DEFAULT_SETTINGS.simulateHelpers,
    heroOrder: heroOrder(s.heroOrder),
    forecast: {
      windowHours: num(s.forecast?.windowHours, DEFAULT_SETTINGS.forecast.windowHours),
      blacksmithTopN: num(s.forecast?.blacksmithTopN, DEFAULT_SETTINGS.forecast.blacksmithTopN),
    },
    lab: {
      pinned: strList(s.lab?.pinned, []),
      kindWeights: {
        troop: weight(s.lab?.kindWeights?.troop, DEFAULT_LAB_WEIGHTS.troop),
        spell: weight(s.lab?.kindWeights?.spell, DEFAULT_LAB_WEIGHTS.spell),
        siege: weight(s.lab?.kindWeights?.siege, DEFAULT_LAB_WEIGHTS.siege),
      },
    },
    petHouse: { pinned: strList(s.petHouse?.pinned, []) },
    blacksmith: { pinned: strList(s.blacksmith?.pinned, []) },
  };
}

/** Hero order after moving the hero at `from` to position `to` (drag-and-drop or ↑/↓). Out of range → unchanged. */
export function moveHero(order: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return [...order];
  const next = [...order];
  const [id] = next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

export function settingsFromYaml(yamlText: string): Settings {
  return coerceSettings(parseYaml(yamlText));
}
