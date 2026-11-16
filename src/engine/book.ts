// Hero book threshold (SPEC §6.5). The threshold comes from data, never hard-coded.
import { levelInfo } from '../data/normalize';
import type { Item, LevelInfo } from '../data/types';

/** True when the hero's next level raw time ≥ threshold (Gold Pass scales both sides equally). */
export function isBookReady(next: LevelInfo | undefined, thresholdSec: number): boolean {
  return !!next && thresholdSec > 0 && next.timeSec >= thresholdSec;
}

export type HeroStatus =
  | { kind: 'maxed' }
  | { kind: 'cappedByHeroHall'; next: LevelInfo }
  | { kind: 'bookReady'; next: LevelInfo }
  | { kind: 'eligible'; next: LevelInfo };

/** Status of a hero at `level` given the Hero Hall level. Caps come from per-level heroHallLevelRequired. */
export function heroStatus(hero: Item, level: number, heroHall: number, thresholdSec: number): HeroStatus {
  const next = levelInfo(hero, level + 1);
  if (!next) return { kind: 'maxed' };
  if ((next.heroHallRequired ?? 0) > heroHall) return { kind: 'cappedByHeroHall', next };
  if (isBookReady(next, thresholdSec)) return { kind: 'bookReady', next };
  return { kind: 'eligible', next };
}

/** Hero max level at a Hero Hall level, derived from per-level data (not the stale cap table). */
export function heroCapAt(hero: Item, heroHall: number): number {
  let cap = 0;
  for (const l of hero.levels) if ((l.heroHallRequired ?? 0) <= heroHall) cap = Math.max(cap, l.level);
  return cap;
}
