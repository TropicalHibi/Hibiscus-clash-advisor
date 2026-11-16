// Collector logic for `npm run meta` (SPEC §8.1), separated from I/O so it can be tested with fixtures.
import { apiTimestampToIso, type BattleRow } from '../../src/meta/aggregate';
import { encTag, type ApiBattle, type ApiClient, type ApiLocation, type ApiPage, type ApiRankedPlayer } from './api';

export const LEGEND_I_TIER = 105000036;

/**
 * Legend I ranked attacks. Probe findings (DECISIONS.md): battleType is lowercase; Legend League I
 * attacks are "legend", lower tiers (incl. Legend II/III) are "ranked", regular multiplayer is "homeVillage".
 */
export function isLegendAttack(b: ApiBattle): boolean {
  return b.attack === true && b.battleType?.toLowerCase() === 'legend';
}

export function battleToRow(tag: string, b: ApiBattle): BattleRow | null {
  if (!b.armyShareCode || !b.battleTimestamp) return null;
  return {
    tag,
    ts: apiTimestampToIso(b.battleTimestamp),
    stars: b.stars,
    destruction: b.destructionPercentage,
    armyShareCode: b.armyShareCode,
  };
}

/**
 * All rankings for one location. Probe: without `limit` the API returns the whole list (max 200)
 * with empty cursors in one call; with `limit` it pages via `after`. Follow `after` if it ever appears.
 */
export async function fetchRankings(api: ApiClient, locationId: string | number): Promise<ApiRankedPlayer[]> {
  const out: ApiRankedPlayer[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = after ? `?after=${encodeURIComponent(after)}` : '';
    let res: ApiPage<ApiRankedPlayer>;
    try {
      res = await api.get<ApiPage<ApiRankedPlayer>>(`/locations/${locationId}/rankings/players${q}`);
    } catch (e) {
      if (page === 0 || (e as { status?: number }).status === 403) throw e;
      break; // a failing later page keeps what we already have
    }
    out.push(...res.items);
    after = res.paging?.cursors?.after;
    if (!after || res.items.length === 0) break;
  }
  return out;
}

export interface GatherOptions {
  maxPlayers: number;
  leagueTierId?: number;
  onLocation?: (info: { location: string; found: number; total: number; index: number; of: number }) => void;
}

/** Legend I player tags from global + country rankings, deduped, capped at maxPlayers. */
export async function gatherPlayers(api: ApiClient, opts: GatherOptions): Promise<string[]> {
  const tier = opts.leagueTierId ?? LEGEND_I_TIER;
  const tags: string[] = [];
  const seen = new Set<string>();
  const locs = await api.get<ApiPage<ApiLocation>>('/locations');
  const sources: { id: string | number; name: string }[] = [{ id: 'global', name: 'Global' }, ...locs.items.filter((l) => l.isCountry).map((l) => ({ id: l.id, name: l.name }))];
  for (let i = 0; i < sources.length && tags.length < opts.maxPlayers; i++) {
    const src = sources[i];
    let found = 0;
    try {
      for (const p of await fetchRankings(api, src.id)) {
        if (p.leagueTier?.id !== tier || seen.has(p.tag)) continue;
        seen.add(p.tag);
        tags.push(p.tag);
        found++;
        if (tags.length >= opts.maxPlayers) break;
      }
    } catch (e) {
      // A location without rankings (404) shouldn't stop the run.
      if ((e as { status?: number }).status !== 404) throw e;
    }
    opts.onLocation?.({ location: src.name, found, total: tags.length, index: i + 1, of: sources.length });
  }
  return tags;
}

export interface PlayerResult {
  tag: string;
  rows: BattleRow[];
  entries: number;
  legendAttacks: number;
  missingCode: number;
  notFound?: boolean;
}

export async function fetchPlayerAttacks(api: ApiClient, tag: string): Promise<PlayerResult> {
  let log: ApiPage<ApiBattle>;
  try {
    log = await api.get<ApiPage<ApiBattle>>(`/players/${encTag(tag)}/battlelog`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return { tag, rows: [], entries: 0, legendAttacks: 0, missingCode: 0, notFound: true };
    throw e;
  }
  const rows: BattleRow[] = [];
  let legendAttacks = 0;
  let missingCode = 0;
  for (const b of log.items ?? []) {
    if (!isLegendAttack(b)) continue;
    legendAttacks++;
    const row = battleToRow(tag, b);
    if (row) rows.push(row);
    else missingCode++;
  }
  return { tag, rows, entries: log.items?.length ?? 0, legendAttacks, missingCode };
}

/** Runs `fn` over `items` with a fixed number of workers (the client throttles globally). */
export async function pool<T>(items: T[], workers: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, run));
}
