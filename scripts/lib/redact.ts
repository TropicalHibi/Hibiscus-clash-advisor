// Redaction for recorded API fixtures (scripts/probe.ts). Other players' identities never reach the repo:
// - player/clan tags → stable pseudonyms (#PLAYER1, #CLAN1 …); names replaced; badge/icon URLs dropped;
// - any other `#TAG`-looking string value (league group tags, …) → "#REDACTED", `*LeagueGroupTag` keys dropped;
// - a full player profile loses its fingerprintable stats (trophies, war stars, donations, achievement values).
// Idempotent: already-pseudonymised values are left alone, so it can be re-run over committed fixtures.

export const PSEUDONYM = /^#(PLAYER|CLAN)\d+$/;
/** A Clash tag value (letters/digits after #), as opposed to text that merely contains a #. */
export const TAG_VALUE = /^#[0-9A-Z]{3,}$/;

const DROP_KEYS = new Set(['badgeUrls', 'iconUrls']);
const PROFILE_STATS = new Set([
  'expLevel',
  'trophies',
  'bestTrophies',
  'warStars',
  'attackWins',
  'defenseWins',
  'donations',
  'donationsReceived',
  'clanCapitalContributions',
  'builderBaseTrophies',
  'bestBuilderBaseTrophies',
]);

export function createRedactor() {
  const tagMap = new Map<string, string>();
  const pseudo = (tag: string, kind: 'PLAYER' | 'CLAN') => {
    if (PSEUDONYM.test(tag)) return tag;
    const key = `${kind}:${tag}`;
    if (!tagMap.has(key)) tagMap.set(key, `#${kind}${[...tagMap.keys()].filter((k) => k.startsWith(kind)).length + 1}`);
    return tagMap.get(key)!;
  };

  function redact(x: unknown, parentKey = ''): unknown {
    if (Array.isArray(x)) return x.map((v) => redact(v, parentKey));
    if (typeof x === 'string') return TAG_VALUE.test(x) && !PSEUDONYM.test(x) ? '#REDACTED' : x;
    if (!x || typeof x !== 'object') return x;
    const o = x as Record<string, unknown>;
    const isClan = parentKey === 'clan' || parentKey === 'opponentClan';
    const isProfile = Array.isArray(o.achievements);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (DROP_KEYS.has(k) || /LeagueGroupTag$/.test(k)) continue;
      if (k === 'tag' && typeof v === 'string') out[k] = pseudo(v, isClan ? 'CLAN' : 'PLAYER');
      else if ((k === 'opponentPlayerTag' || k === 'attackerTag' || k === 'defenderTag') && typeof v === 'string') out[k] = pseudo(v, 'PLAYER');
      else if (k === 'opponentName' && typeof v === 'string') out[k] = 'Redacted Opponent';
      else if (k === 'name' && typeof o.tag === 'string') out[k] = isClan ? 'Redacted Clan' : 'Redacted Player';
      else if (isProfile && PROFILE_STATS.has(k) && typeof v === 'number') out[k] = 0;
      else if (isProfile && k === 'achievements' && Array.isArray(v))
        out[k] = v.map((a) => ({ name: (a as { name?: unknown }).name, village: (a as { village?: unknown }).village }));
      else out[k] = redact(v, k);
    }
    return out;
  }
  return redact;
}
