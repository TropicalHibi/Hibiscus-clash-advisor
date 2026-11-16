// localStorage persistence. Every access is wrapped: storage can be missing or throw.
import { coerceSettings, type Settings } from '../state/settings';

const K = {
  export: 'cocPlanner.exportJson',
  importedAt: 'cocPlanner.importedAt',
  settings: 'cocPlanner.settings',
  tab: 'cocPlanner.tab',
  dataChangesSeen: 'cocPlanner.dataChangesSeen',
};

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
function del(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const storage = {
  loadExport(): { json: string; importedAt: number } | null {
    const json = get(K.export);
    if (!json) return null;
    const at = Number(get(K.importedAt));
    return { json, importedAt: Number.isFinite(at) && at > 0 ? at : Math.floor(Date.now() / 1000) };
  },
  saveExport(json: string, importedAt: number): boolean {
    return set(K.export, json) && set(K.importedAt, String(importedAt));
  },
  clearExport(): void {
    del(K.export);
    del(K.importedAt);
  },
  loadSettings(defaults: Settings): Settings {
    const raw = get(K.settings);
    if (!raw) return defaults;
    try {
      // Nested merge: settings saved before a field existed (e.g. lab.kindWeights) keep the YAML default for it.
      const saved = JSON.parse(raw) ?? {};
      return coerceSettings({
        ...defaults,
        ...saved,
        forecast: { ...defaults.forecast, ...saved.forecast },
        lab: { ...defaults.lab, ...saved.lab, kindWeights: { ...defaults.lab.kindWeights, ...saved.lab?.kindWeights } },
        petHouse: { ...defaults.petHouse, ...saved.petHouse },
        blacksmith: { ...defaults.blacksmith, ...saved.blacksmith },
      });
    } catch {
      return defaults;
    }
  },
  saveSettings(s: Settings): void {
    set(K.settings, JSON.stringify(s));
  },
  clearSettings(): void {
    del(K.settings);
  },
  /** Game-data version whose "data updated" banner was dismissed. */
  loadDataChangesSeen(): string | null {
    return get(K.dataChangesSeen);
  },
  saveDataChangesSeen(version: string): void {
    set(K.dataChangesSeen, version);
  },
  loadTab(): string | null {
    return get(K.tab);
  },
  saveTab(tab: string): void {
    set(K.tab, tab);
  },
};
