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
  builderPotion: 10, // Builder Potion: builders 10x for 1 hour
  researchPotion: 24, // Research Potion: lab + pet house 24x for 1 hour
  builderSnack: 2, // Builder Bite (builder_consumable): assumed 2x
  researchSnack: 4, // Study Soup (lab_consumable): assumed 4x
} as const;

/** Helpers work for one hour, then rest; one work hour per day (1 h work + 23 h rest). */
export const HELPER_WORK_SEC = 3600;
export const HELPER_PERIOD_SEC = 86400;

export const DAY = 86400;
export const HOUR = 3600;
