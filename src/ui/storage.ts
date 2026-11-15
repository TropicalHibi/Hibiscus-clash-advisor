// localStorage persistence. Every access is wrapped: storage can be missing or throw.
import { coerceSettings, type Settings } from '../state/settings';

const K = {
  export: 'cocPlanner.exportJson',
  importedAt: 'cocPlanner.importedAt',
  settings: 'cocPlanner.settings',
  tab: 'cocPlanner.tab',
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
      return coerceSettings({ ...defaults, ...JSON.parse(raw) });
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
  loadTab(): string | null {
    return get(K.tab);
  },
  saveTab(tab: string): void {
    set(K.tab, tab);
  },
};
