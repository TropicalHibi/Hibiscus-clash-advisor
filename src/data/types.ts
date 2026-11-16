// Normalized model (SPEC §5). Extended where the real data needed it — see DECISIONS.md.

export type Resource =
  | 'gold'
  | 'elixir'
  | 'darkElixir'
  | 'goldOrElixir'
  | 'shinyOre'
  | 'glowyOre'
  | 'starryOre';

export interface OreCost {
  shinyOre: number;
  glowyOre: number;
  starryOre: number;
}

export interface LevelInfo {
  level: number;
  cost: number;
  resource: Resource;
  timeSec: number; // raw, unboosted
  thRequired?: number;
  heroHallRequired?: number;
  labRequired?: number;
  petHouseRequired?: number;
  blacksmithRequired?: number;
  ore?: OreCost; // equipment only
}

export type Category =
  | 'townHall'
  | 'thWeapon'
  | 'defense'
  | 'mergedDefense'
  | 'army'
  | 'resourceStorage'
  | 'resourceCollector'
  | 'trap'
  | 'wall'
  | 'hero'
  | 'troop'
  | 'spell'
  | 'siege'
  | 'pet'
  | 'equipment'
  | 'supercharge'
  | 'craftedDefense'
  | 'guardian'
  | 'helper'
  | 'other';

export type Queue = 'builder' | 'lab' | 'petHouse' | 'blacksmith' | 'none';

export interface Item {
  /** Unique key. Usually String(dataId); synthetic for supercharge ("<id>:sc"),
   *  TH weapons ("<thId>:w<th>") and crafted-defense modules ("<defId>:m<moduleId>"). */
  key: string;
  dataId: number;
  /** clash-of-clans-data file id, e.g. "cannon". */
  id: string;
  name: string;
  category: Category;
  queue: Queue;
  levels: LevelInfo[]; // sorted by level ascending, contiguous from the first level
  /** Count allowed per TH (from availablePerTownHall). */
  countPerTH?: Record<number, number>;
  /** countAfterMerges per TH, for merge sources. */
  countAfterMergesPerTH?: Record<number, number>;
  /** For supercharge items: key of the base item. */
  baseKey?: string;
  /** For TH weapons: the TH level they belong to. */
  weaponForTH?: number;
  /** For crafted-defense modules: the crafted defense dataId. */
  craftedDefenseId?: number;
  /** For equipment: owning hero file id. */
  hero?: string;
  /** Troops, spells, sieges: army housing space (from the data file). */
  housingSpace?: number;
  /** Base troops with a super version: the super troop's housing space. */
  superHousingSpace?: number;
  /** Helpers (Builder's Apprentice, Lab Assistant): work rate per helper level (hours of progress per work hour). */
  helperWorkRates?: Record<number, number>;
  /**
   * Package-relative image paths ("images/home/..."), best first: the item icon, then level images from
   * the top level down. The build bundles the first one that exists and is small enough (SPEC §13 Step 3).
   */
  images?: string[];
}

export interface MergeRecipe {
  id: string; // merged item file id
  dataId: number;
  sources: { id: string; dataId: number; qty: number }[];
  unlockTH: number;
  requiredSourceLevel: Record<string, number>; // source file id → level
}

export interface GameData {
  version: string;
  items: Map<string, Item>;
  byDataId: Map<number, Item>; // base items only
  byId: Map<string, Item>; // file id → base item
  maxTH: number;
  /** BOOK_THRESHOLD (§6.5): max raw time across all hero levels, seconds. */
  bookThresholdSec: number;
  merges: MergeRecipe[];
  /** Hero Hall heroLevelCaps table (stale in data; for validation only). */
  heroHallCaps: Record<number, Record<string, number>>;
  /** Problems found while normalizing (e.g. unknown cost resources). Shown on the Plan tab and by sync. */
  warnings: string[];
}

export interface OwnedInstance {
  /** Unique within an AccountState. */
  uid: string;
  dataId: number;
  itemKey: string;
  level: number;
  upgradingTo?: number;
  remainingSec?: number;
  goblin?: boolean;
  superchargeLevel?: number;
  /** TH weapon level (Town Hall instance only). */
  weaponLevel?: number;
  /** For crafted defense module instances: building uid that owns the module. */
  parentUid?: string;
  /** True for instances that don't exist yet (to be built). level = 0. */
  planned?: boolean;
  /** Export `helper_recurrent` / `recurrent_helper`: a helper is set to keep working on this item. */
  helperRecurrent?: boolean;
  /** Export `helper_timer`: seconds left of a helper's work hour on this upgrade, at the export time. */
  helperTimerSec?: number;
}
