// Gold Pass "Max" boosts (SPEC §10.2). Verify in-game before release.
// Expected: 20% builder time reduction, 20% research (lab + pet house) time reduction.
export const GOLD_PASS_MAX_BOOST = {
  builder: 0.2,
  research: 0.2,
} as const;

export const DAY = 86400;
export const HOUR = 3600;
