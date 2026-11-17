// What clash-of-clans-data lacks and ClashKing carries itself (SPEC §3.1). Used ONLY when the planner falls
// back to clash-of-clans-data (no usable ClashKing copy). They're the tables config/merges.yaml,
// config/super-troops.yaml and config/id-overrides.yaml used to hold, frozen at clash-of-clans-data 0.19.1.
// Entries in those (now optional, empty) files still win over these.
import type { MergeOverride, SuperTroopEntry } from './overrides.ts';

/** Merge recipes (no "merged from" field in clash-of-clans-data). Source levels: max at the unlock TH. */
export const COC_BACKUP_MERGES: Record<string, MergeOverride> = {
  'ricochet-cannon': { dataId: 1000085, sources: [{ id: 'cannon', qty: 2 }] },
  'multi-archer-tower': { dataId: 1000084, sources: [{ id: 'archer-tower', qty: 2 }] },
  'multi-gear-tower': {
    dataId: 1000079,
    sources: [
      { id: 'cannon', qty: 1 },
      { id: 'archer-tower', qty: 1 },
    ],
  },
  'super-wizard-tower': { dataId: 1000102, sources: [{ id: 'wizard-tower', qty: 2 }] },
};

/** Super troops: clash-of-clans-data lists them inside the base troop's file, without a dataId. */
export const COC_BACKUP_SUPER_TROOPS: Record<number, SuperTroopEntry> = {
  4000026: { name: 'Super Barbarian', base: 'barbarian' },
  4000027: { name: 'Super Archer', base: 'archer' },
  4000028: { name: 'Super Wall Breaker', base: 'wall-breaker' },
  4000029: { name: 'Super Giant', base: 'giant' },
  4000055: { name: 'Sneaky Goblin', base: 'goblin' },
  4000056: { name: 'Super Miner', base: 'miner' },
  4000057: { name: 'Rocket Balloon', base: 'balloon' },
  4000063: { name: 'Inferno Dragon', base: 'baby-dragon' },
  4000064: { name: 'Super Valkyrie', base: 'valkyrie' },
  4000066: { name: 'Super Witch', base: 'witch' },
  4000076: { name: 'Ice Hound', base: 'lava-hound' },
  4000080: { name: 'Super Bowler', base: 'bowler' },
  4000081: { name: 'Super Dragon', base: 'dragon' },
  4000083: { name: 'Super Wizard', base: 'wizard' },
  4000084: { name: 'Super Minion', base: 'minion' },
  4000098: { name: 'Super Hog Rider', base: 'hog-rider' },
  4000147: { name: 'Super Yeti', base: 'yeti' },
};

/** dataIds missing from clash-of-clans-data files (item id → dataId). */
export const COC_BACKUP_IDS: ReadonlyMap<string, number> = new Map([['alchemist', 93000003]]);
