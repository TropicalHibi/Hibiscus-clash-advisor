// Gold Pass "Max" boosts (SPEC §10.2). Verify in-game before release.
// Expected: 20% builder time reduction, 20% research (lab + pet house) time reduction.
export const GOLD_PASS_MAX_BOOST = {
  builder: 0.2,
  research: 0.2,
} as const;

/**
 * Active boost speed multipliers (SPEC §10.1). Potions are well known; the snacks are best guesses.
 * Verify in-game. The Clock Tower is Builder Base only and never affects the home village.
 */
export const BOOST_MULTIPLIER = {
  builderPotion: 10, // Builder Potion (builder_boost): builders 10x
  researchPotion: 24, // Research Potion (lab_boost): Laboratory only, 24x
  petPotion: 24, // Pet Potion (pet_boost, key assumed): Pet House only, 24x
  builderSnack: 2, // Builder Bite (builder_consumable): +1x, stacks additively with the potion (10x + 1x = 11x)
  researchSnack: 4, // Study Soup (lab_consumable): assumed 4x, Laboratory only
} as const;

/** Helpers work for one hour; the shared helper cycle is 23 hours from assignment to the next assignment. */
export const HELPER_WORK_SEC = 3600;
export const HELPER_PERIOD_SEC = 23 * 3600;

export const DAY = 86400;
export const HOUR = 3600;
