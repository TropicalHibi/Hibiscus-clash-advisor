// Army share code parser (SPEC §8.2).
// Ported from ClashKing's clashy.go (MIT, game.go: ParseArmyRecipe), with one deliberate
// difference: the Go version drops IDs missing from its static data, this one keeps every
// well-formed ID (as a full dataId) so unknown IDs can be counted and reported by the caller.

export const BASE_ID = {
  troop: 4_000_000,
  spell: 26_000_000,
  hero: 28_000_000,
  pet: 73_000_000,
  equipment: 90_000_000,
} as const;

const HERO_PATTERN = /^(\d+)(?:m\d+)?(?:p(\d+))?(?:e(\d+)(?:_(\d+))?)?$/;
const SECTION_MARKERS = new Set(['h', 'i', 'd', 'u', 's']);

export interface HeroLoadout {
  hero: number; // full dataId
  pet?: number;
  equipment: number[]; // 0–2 full dataIds, link order
}

export interface UnitCount {
  id: number; // full dataId
  qty: number;
}

export interface ArmyRecipe {
  link: string;
  heroes: HeroLoadout[];
  troops: UnitCount[]; // home army (u) — includes sieges if they're placed there
  spells: UnitCount[]; // s
  ccTroops: UnitCount[]; // i — sieges usually sit here
  ccSpells: UnitCount[]; // d
}

/** Full link (`...?army=<payload>`) → payload; anything else is returned as the raw payload. */
export function extractArmyPayload(link: string): string {
  const s = link.trim();
  try {
    const army = new URL(s).searchParams.get('army');
    if (army) return army;
  } catch {
    /* not a URL → raw payload */
  }
  const m = /[?&]army=([^&#]+)/.exec(s);
  return m ? decodeURIComponent(m[1]) : s;
}

/** Splits a payload at each section marker letter (h, i, d, u, s). */
export function splitArmySections(payload: string): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i < payload.length; i++) {
    if (!SECTION_MARKERS.has(payload[i])) continue;
    if (start >= 0) out.push(payload.slice(start, i));
    start = i;
  }
  if (start >= 0) out.push(payload.slice(start));
  return out;
}

const toInt = (s: string | undefined): number | undefined => {
  if (s === undefined || s === '' || !/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
};

function parseItems(payload: string, baseId: number): UnitCount[] {
  const out: UnitCount[] = [];
  for (const part of payload.split('-')) {
    const split = part.split('x');
    if (split.length !== 2) continue;
    const qty = toInt(split[0]);
    const id = toInt(split[1]);
    if (qty === undefined || id === undefined || qty <= 0) continue;
    out.push({ id: baseId + id, qty });
  }
  return out;
}

function parseHeroes(payload: string): HeroLoadout[] {
  const out: HeroLoadout[] = [];
  for (const entry of payload.split('-')) {
    const g = HERO_PATTERN.exec(entry);
    if (!g) continue;
    const hero = toInt(g[1]);
    if (hero === undefined) continue;
    const loadout: HeroLoadout = { hero: BASE_ID.hero + hero, equipment: [] };
    const pet = toInt(g[2]);
    if (pet !== undefined) loadout.pet = BASE_ID.pet + pet;
    for (const e of [g[3], g[4]]) {
      const eq = toInt(e);
      if (eq !== undefined) loadout.equipment.push(BASE_ID.equipment + eq);
    }
    out.push(loadout);
  }
  return out;
}

export function parseArmyCode(link: string): ArmyRecipe {
  const recipe: ArmyRecipe = { link, heroes: [], troops: [], spells: [], ccTroops: [], ccSpells: [] };
  for (const section of splitArmySections(extractArmyPayload(link))) {
    if (section.length < 2) continue;
    const body = section.slice(1);
    switch (section[0]) {
      case 'h':
        recipe.heroes.push(...parseHeroes(body));
        break;
      case 'i':
        recipe.ccTroops.push(...parseItems(body, BASE_ID.troop));
        break;
      case 'd':
        recipe.ccSpells.push(...parseItems(body, BASE_ID.spell));
        break;
      case 'u':
        recipe.troops.push(...parseItems(body, BASE_ID.troop));
        break;
      case 's':
        recipe.spells.push(...parseItems(body, BASE_ID.spell));
        break;
    }
  }
  return recipe;
}
