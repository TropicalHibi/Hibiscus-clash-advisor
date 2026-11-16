// Data validation checks (SPEC §9). Step 1 exposes them to tests; `npm run sync` prints them.
import { countAt } from './normalize';
import type { GameData } from './types';
import { heroCapAt } from '../engine/book';

export interface ValidationIssue {
  level: 'error' | 'warn';
  check: string;
  message: string;
}

/** For each merge source at each TH: count − countAfterMerges must equal Σ(qty × merged count). */
export function checkMergeConsumption(data: GameData): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sources = new Set(data.merges.flatMap((m) => m.sources.map((s) => s.dataId)));
  for (const item of data.byDataId.values()) {
    if (!item.countAfterMergesPerTH) continue;
    if (!sources.has(item.dataId)) {
      issues.push({ level: 'error', check: 'merge', message: `${item.name} has countAfterMerges but no recipe in merges.yaml uses it` });
      continue;
    }
  }
  for (const srcId of sources) {
    const src = data.byDataId.get(srcId)!;
    for (let th = 1; th <= data.maxTH; th++) {
      const total = countAt(src.countPerTH, th) ?? 0;
      const after = countAt(src.countAfterMergesPerTH, th);
      const expectedConsumed = data.merges.reduce((sum, m) => {
        const q = m.sources.find((s) => s.dataId === srcId)?.qty ?? 0;
        return sum + q * (countAt(data.byDataId.get(m.dataId)!.countPerTH, th) ?? 0);
      }, 0);
      const actualConsumed = after === undefined ? 0 : total - after;
      if (actualConsumed !== expectedConsumed)
        issues.push({
          level: 'error',
          check: 'merge',
          message: `TH${th} ${src.name}: data consumes ${actualConsumed}, recipes consume ${expectedConsumed}. A merge recipe is missing or wrong in config/merges.yaml.`,
        });
    }
  }
  return issues;
}

/** Hero Hall heroLevelCaps vs per-level heroHallLevelRequired (known stale table; warn only). */
export function checkHeroCaps(data: GameData): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [hhStr, caps] of Object.entries(data.heroHallCaps)) {
    const hh = Number(hhStr);
    for (const [heroId, tableCap] of Object.entries(caps)) {
      const hero = data.byId.get(heroId);
      if (!hero) continue;
      const derived = heroCapAt(hero, hh);
      if (derived !== tableCap)
        issues.push({ level: 'warn', check: 'heroCap', message: `Hero Hall ${hh} ${hero.name}: cap table says ${tableCap}, per-level data says ${derived} (using ${derived})` });
    }
  }
  return issues;
}

/** Levels contiguous, costs and times non-negative. */
export function checkLevels(data: GameData): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const item of data.items.values()) {
    for (let i = 0; i < item.levels.length; i++) {
      const l = item.levels[i];
      if (l.cost < 0 || l.timeSec < 0) issues.push({ level: 'error', check: 'levels', message: `${item.name} ${l.level}: negative cost/time` });
      if (i > 0 && l.level !== item.levels[i - 1].level + 1)
        issues.push({ level: 'error', check: 'levels', message: `${item.name}: level ${item.levels[i - 1].level} → ${l.level} not contiguous` });
    }
  }
  return issues;
}

export interface MissingMerge {
  /** TH where the sources' counts drop without a recipe explaining it. */
  th: number;
  /** Sources consumed beyond what merges.yaml explains, with how many per merged copy when a candidate fits. */
  sources: { id: string; name: string; consumed: number }[];
  /** Defenses first available at that TH that aren't in merges.yaml, most likely first (see explainMissingMerges). */
  candidates: { id: string; name: string; dataId: number; count: number; recipe: { id: string; name: string; qty: number }[] }[];
}

/**
 * When merges.yaml is missing a merge (§7): which source counts drop unexplained, and which new defense is
 * the likely merged result. Per TH (lowest first): sources with unexplained consumption, and defenses (not
 * already a recipe) first available at that TH whose count divides every source's extra consumption. Used
 * by the data-update workflow to say plainly what to add to config/merges.yaml.
 * The data has no "merged from" field, so candidates are ranked: items new in this data release
 * (`newKeys`, from the snapshot diff) first, then names containing a source's name (Super Wizard Tower ⊃
 * Wizard Tower), then recipes using at most 2 of each source (true of every known merge).
 */
export function explainMissingMerges(data: GameData, newKeys: Set<string> = new Set()): MissingMerge[] {
  const out: MissingMerge[] = [];
  const recipeIds = new Set(data.merges.map((m) => m.dataId));
  const sourceIds = new Set(data.merges.flatMap((m) => m.sources.map((s) => s.dataId)));
  const firstTH = (rec: Record<number, number> | undefined) =>
    Object.entries(rec ?? {})
      .filter(([, n]) => n > 0)
      .map(([th]) => Number(th))
      .sort((a, b) => a - b)[0];
  const seen = new Set<string>();
  for (let th = 1; th <= data.maxTH; th++) {
    const sources: MissingMerge['sources'] = [];
    for (const item of data.byDataId.values()) {
      if (!item.countAfterMergesPerTH) continue;
      const total = countAt(item.countPerTH, th) ?? 0;
      const after = countAt(item.countAfterMergesPerTH, th);
      if (after === undefined) continue;
      const explained = data.merges.reduce((sum, m) => {
        const q = m.sources.find((s) => s.dataId === item.dataId)?.qty ?? 0;
        return sum + q * (countAt(data.byDataId.get(m.dataId)!.countPerTH, th) ?? 0);
      }, 0);
      const extra = total - after - explained;
      if (extra > 0) sources.push({ id: item.id, name: item.name, consumed: extra });
    }
    if (!sources.length) continue;
    const key = sources.map((s) => `${s.id}:${s.consumed}`).join(',');
    if (seen.has(key)) continue; // same gap carried to higher THs
    seen.add(key);
    const candidates: MissingMerge['candidates'] = [];
    for (const item of data.byDataId.values()) {
      if ((item.category !== 'defense' && item.category !== 'mergedDefense') || recipeIds.has(item.dataId) || sourceIds.has(item.dataId)) continue;
      if (sources.some((s) => s.id === item.id) || firstTH(item.countPerTH) !== th) continue;
      const count = countAt(item.countPerTH, th) ?? 0;
      if (count <= 0 || !sources.every((s) => s.consumed % count === 0)) continue;
      candidates.push({ id: item.id, name: item.name, dataId: item.dataId, count, recipe: sources.map((s) => ({ id: s.id, name: s.name, qty: s.consumed / count })) });
    }
    const score = (c: MissingMerge['candidates'][0]) => [
      newKeys.has(String(c.dataId)) ? 1 : 0,
      sources.some((src) => c.name.toLowerCase().includes(src.name.toLowerCase())) ? 1 : 0,
      c.recipe.every((r) => r.qty <= 2) ? 1 : 0,
    ];
    candidates.sort((a, b) => {
      const x = score(a);
      const y = score(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
      return a.name < b.name ? -1 : 1;
    });
    out.push({ th, sources, candidates });
  }
  return out;
}

/** One plain-language line per missing merge, e.g. "TH18: Super Wizard Tower (dataId …) looks like a new merge of 2× Wizard Tower…". */
export function describeMissingMerges(found: MissingMerge[]): string[] {
  return found.map((m) => {
    const src = m.sources.map((s) => `${s.name} (${s.consumed} merged away)`).join(', ');
    if (!m.candidates.length) return `TH${m.th}: ${src} drop with no recipe in config/merges.yaml, and no new TH${m.th} defense fits as the merged result. Add the recipe by hand.`;
    const fmt = (x: MissingMerge['candidates'][0]) => `${x.name} (${x.id}, dataId ${x.dataId}) = ${x.recipe.map((r) => `${r.qty}× ${r.name}`).join(' + ')}`;
    const [best, ...rest] = m.candidates;
    const others = rest.length ? ` Other fits (less likely): ${rest.map(fmt).join('; ')}.` : '';
    return `TH${m.th}: merge missing from config/merges.yaml. New merged defense, most likely: ${fmt(best)}. Sources: ${src}.${others}`;
  });
}
