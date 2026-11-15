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
