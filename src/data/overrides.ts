// Optional hand-maintained overrides (SPEC §3.1, §7, §12). ClashKing's data carries merges, super troops and
// every dataId itself, so these files ship empty; an entry that exists wins over the data.
//   config/merges.yaml        merges:   { <merged id>: { dataId?, sources: [{ id, qty, level? }] } }
//   config/super-troops.yaml  <dataId>: { name, base }
//   config/id-overrides.yaml  ids:      { <dataId>: <item id> }
import { parse as parseYaml } from 'yaml';

export interface MergeOverride {
  dataId?: number;
  sources: { id: string; qty: number; level?: number }[];
}

export interface SuperTroopEntry {
  name: string;
  base: string; // base troop item id, e.g. "wizard"
}

export interface Overrides {
  merges: Record<string, MergeOverride>;
  superTroops: Record<number, SuperTroopEntry>;
  /** item id → dataId */
  ids: Map<string, number>;
}

export interface OverrideTexts {
  merges?: string;
  superTroops?: string;
  ids?: string;
}

/**
 * A problem in one of the config/ override files (YAML error, unknown id, dataId mismatch), named by file.
 * Loaders report it as an override error and load the data without the overrides (REVIEW-2 #12), instead of
 * blaming the pinned ClashKing data and switching to the backup.
 */
export class OverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OverrideError';
  }
}

/** The Plan-tab / sync warning for an override error. */
export const overrideWarning = (e: Error) => `Override file error: ${e.message}. The override files are ignored until it's fixed.`;

/** `load(true)` (with the override files); on an OverrideError, `load(false)` with the warning added. */
export function loadWithOverrides<T extends { warnings: string[] }>(load: (useOverrides: boolean) => T): T {
  try {
    return load(true);
  } catch (e) {
    if (!(e instanceof OverrideError)) throw e;
    const d = load(false);
    d.warnings.unshift(overrideWarning(e));
    return d;
  }
}

const yamlOf = (text: string | undefined, file: string): unknown => {
  try {
    return (text ? parseYaml(text) : undefined) ?? undefined;
  } catch (e) {
    throw new OverrideError(`config/${file}: ${(e as Error).message.split('\n')[0]}`);
  }
};

export function parseMergeOverrides(text: string | undefined): Record<string, MergeOverride> {
  const cfg = yamlOf(text, 'merges.yaml') as { merges?: Record<string, unknown> } | undefined;
  const out: Record<string, MergeOverride> = {};
  for (const [id, raw] of Object.entries(cfg?.merges ?? {})) {
    const r = raw as Partial<MergeOverride> | null;
    if (!r || !Array.isArray(r.sources) || !r.sources.length) continue;
    const sources = r.sources
      .filter((s) => s && typeof s.id === 'string' && typeof s.qty === 'number' && s.qty > 0)
      .map((s) => ({ id: s.id, qty: s.qty, ...(typeof s.level === 'number' ? { level: s.level } : {}) }));
    if (sources.length) out[id] = { ...(typeof r.dataId === 'number' ? { dataId: r.dataId } : {}), sources };
  }
  return out;
}

export function parseSuperTroops(text: string | undefined): Record<number, SuperTroopEntry> {
  const raw = (yamlOf(text, 'super-troops.yaml') ?? {}) as Record<string, unknown>;
  const out: Record<number, SuperTroopEntry> = {};
  for (const [k, v] of Object.entries(raw)) {
    const id = Number(k);
    const e = v as Partial<SuperTroopEntry> | null;
    if (Number.isInteger(id) && e && typeof e.name === 'string' && typeof e.base === 'string') out[id] = { name: e.name, base: e.base };
  }
  return out;
}

/** config/id-overrides.yaml: returns item id → dataId. */
export function parseIdOverrides(text: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  const cfg = yamlOf(text, 'id-overrides.yaml') as { ids?: Record<string, unknown> } | undefined;
  for (const [k, v] of Object.entries(cfg?.ids ?? {})) {
    const dataId = Number(k);
    if (Number.isInteger(dataId) && typeof v === 'string' && v) out.set(v, dataId);
  }
  return out;
}

export function parseOverrides(t: OverrideTexts = {}): Overrides {
  return { merges: parseMergeOverrides(t.merges), superTroops: parseSuperTroops(t.superTroops), ids: parseIdOverrides(t.ids) };
}

export const EMPTY_OVERRIDES: Overrides = { merges: {}, superTroops: {}, ids: new Map() };
