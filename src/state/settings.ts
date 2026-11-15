import { parse as parseYaml } from 'yaml';

export type GoldPass = 'none' | 'max';

export interface Settings {
  goldPass: GoldPass;
  heroOrder: string[]; // hero file ids
  forecast: { windowHours: number; blacksmithTopN: number };
  lab: { pinned: string[] };
  petHouse: { pinned: string[] };
  blacksmith: { pinned: string[] };
}

export const DEFAULT_HERO_ORDER = ['archer-queen', 'grand-warden', 'dragon-duke', 'barbarian-king', 'royal-champion', 'minion-prince'];

export const DEFAULT_SETTINGS: Settings = {
  goldPass: 'none',
  heroOrder: DEFAULT_HERO_ORDER,
  forecast: { windowHours: 24, blacksmithTopN: 3 },
  lab: { pinned: [] },
  petHouse: { pinned: [] },
  blacksmith: { pinned: [] },
};

/** Merge a partial settings object (YAML or localStorage) over the defaults, ignoring junk. */
export function coerceSettings(input: unknown): Settings {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const strList = (v: unknown, d: string[]) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...v] : [...d]);
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    goldPass: s.goldPass === 'max' ? 'max' : 'none',
    heroOrder: strList(s.heroOrder, DEFAULT_HERO_ORDER),
    forecast: {
      windowHours: num(s.forecast?.windowHours, DEFAULT_SETTINGS.forecast.windowHours),
      blacksmithTopN: num(s.forecast?.blacksmithTopN, DEFAULT_SETTINGS.forecast.blacksmithTopN),
    },
    lab: { pinned: strList(s.lab?.pinned, []) },
    petHouse: { pinned: strList(s.petHouse?.pinned, []) },
    blacksmith: { pinned: strList(s.blacksmith?.pinned, []) },
  };
}

export function settingsFromYaml(yamlText: string): Settings {
  return coerceSettings(parseYaml(yamlText));
}
