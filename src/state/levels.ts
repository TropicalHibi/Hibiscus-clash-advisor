// Well-known dataIds and the building levels derived from owned instances.
// One derivation, used by the export parser and the engine.
import type { OwnedInstance } from '../data/types';

export const IDS = {
  townHall: 1000001,
  wall: 1000010,
  builderHut: 1000015,
  bobHut: 1000064,
  laboratory: 1000007,
  petHouse: 1000068,
  blacksmith: 1000070,
  heroHall: 1000071,
  craftingStation: 1000097,
} as const;

export interface Levels {
  th: number;
  heroHall: number;
  lab: number;
  petHouse: number;
  blacksmith: number;
}

export function levelsOf(instances: OwnedInstance[]): Levels {
  const lv: Levels = { th: 0, heroHall: 0, lab: 0, petHouse: 0, blacksmith: 0 };
  for (const i of instances) {
    if (i.dataId === IDS.townHall) lv.th = Math.max(lv.th, i.level);
    else if (i.dataId === IDS.heroHall) lv.heroHall = Math.max(lv.heroHall, i.level);
    else if (i.dataId === IDS.laboratory) lv.lab = Math.max(lv.lab, i.level);
    else if (i.dataId === IDS.petHouse) lv.petHouse = Math.max(lv.petHouse, i.level);
    else if (i.dataId === IDS.blacksmith) lv.blacksmith = Math.max(lv.blacksmith, i.level);
  }
  return lv;
}
