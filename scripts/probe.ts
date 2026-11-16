// npm run probe — makes a handful of real API calls and saves REDACTED samples to tests/fixtures/api/.
// Used once to confirm field names, the Legend I filter, battle-log depth and ranking pagination.
// Redaction: player/clan tags become stable pseudonyms (#PLAYER1, #CLAN1 …), player/clan names are
// replaced, badge/icon URLs dropped. The token is never written anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/data/loadNode';
import { ApiError, createClient, encTag, loadToken, type ApiBattle, type ApiLocation, type ApiPage, type ApiRankedPlayer } from './lib/api';

const OUT = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'api');
fs.mkdirSync(OUT, { recursive: true });

const tagMap = new Map<string, string>();
const pseudo = (tag: string, kind: 'PLAYER' | 'CLAN') => {
  const key = `${kind}:${tag}`;
  if (!tagMap.has(key)) tagMap.set(key, `#${kind}${[...tagMap.keys()].filter((k) => k.startsWith(kind)).length + 1}`);
  return tagMap.get(key)!;
};

function redact(x: unknown, parentKey = ''): unknown {
  if (Array.isArray(x)) return x.map((v) => redact(v, parentKey));
  if (!x || typeof x !== 'object') return x;
  const o = x as Record<string, unknown>;
  const isClan = parentKey === 'clan' || parentKey === 'opponentClan';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'badgeUrls' || k === 'iconUrls') continue;
    if (k === 'tag' && typeof v === 'string') out[k] = pseudo(v, isClan ? 'CLAN' : 'PLAYER');
    else if ((k === 'opponentPlayerTag' || k === 'attackerTag' || k === 'defenderTag') && typeof v === 'string') out[k] = pseudo(v, 'PLAYER');
    else if (k === 'opponentName' && typeof v === 'string') out[k] = 'Redacted Opponent';
    else if (k === 'name' && typeof o.tag === 'string') out[k] = isClan ? 'Redacted Clan' : 'Redacted Player';
    else out[k] = redact(v, k);
  }
  return out;
}

function save(name: string, body: unknown): void {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(redact(body), null, 2) + '\n');
  console.log(`  saved ${path.relative(PROJECT_ROOT, file)}`);
}

async function main(): Promise<void> {
  const api = createClient({ token: loadToken(), requestsPerSecond: 5 });
  const notes: string[] = [];

  console.log('GET /locations');
  const locs = await api.get<ApiPage<ApiLocation>>('/locations');
  save('locations.json', locs);
  notes.push(`locations: ${locs.items.length} items, paging=${JSON.stringify(locs.paging)}`);

  console.log('GET /locations/global/rankings/players?limit=5');
  const global = await api.get<ApiPage<ApiRankedPlayer>>('/locations/global/rankings/players?limit=5');
  save('rankings-global-limit5.json', global);
  notes.push(`global limit=5: ${global.items.length} items, paging=${JSON.stringify(global.paging)}`);

  // Pagination: follow the "after" cursor once.
  const after = global.paging?.cursors?.after;
  if (after) {
    const p2 = await api.get<ApiPage<ApiRankedPlayer>>(`/locations/global/rankings/players?limit=5&after=${encodeURIComponent(after)}`);
    save('rankings-global-limit5-page2.json', p2);
    notes.push(`global page2 via after: ${p2.items.length} items, ranks ${p2.items.map((i) => i.rank).join(',')}, paging=${JSON.stringify(p2.paging)}`);
  } else notes.push('global: no after cursor returned');

  // A full (unlimited) global page to see the server's max page size and league tiers.
  const full = await api.get<ApiPage<ApiRankedPlayer>>('/locations/global/rankings/players');
  const tiers = new Map<string, number>();
  for (const p of full.items) {
    const k = `${p.leagueTier?.id}:${p.leagueTier?.name}`;
    tiers.set(k, (tiers.get(k) ?? 0) + 1);
  }
  notes.push(`global no limit: ${full.items.length} items, paging=${JSON.stringify(full.paging)}, leagueTiers=${JSON.stringify([...tiers])}`);
  notes.push(`global no limit: last rank ${full.items.at(-1)?.rank}, trophies ${full.items.at(-1)?.trophies}`);

  // One country (first country in /locations with a name we can find, prefer United States).
  const country = locs.items.find((l) => l.isCountry && l.countryCode === 'US') ?? locs.items.find((l) => l.isCountry)!;
  console.log(`GET /locations/${country.id}/rankings/players?limit=5 (${country.name})`);
  const cr = await api.get<ApiPage<ApiRankedPlayer>>(`/locations/${country.id}/rankings/players?limit=5`);
  save('rankings-country-limit5.json', cr);
  const crFull = await api.get<ApiPage<ApiRankedPlayer>>(`/locations/${country.id}/rankings/players`);
  const ctiers = new Map<string, number>();
  for (const p of crFull.items) {
    const k = `${p.leagueTier?.id}:${p.leagueTier?.name}`;
    ctiers.set(k, (ctiers.get(k) ?? 0) + 1);
  }
  notes.push(`${country.name} no limit: ${crFull.items.length} items, paging=${JSON.stringify(crFull.paging)}, leagueTiers=${JSON.stringify([...ctiers])}`);

  // Battle logs for 3 players: two from global top, one from the bottom of the country list.
  const picks = [global.items[0], global.items[1], crFull.items.at(-1)!].filter(Boolean);
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    console.log(`GET /players/{tag}/battlelog (#${i + 1}, leagueTier ${p.leagueTier?.id})`);
    const log = await api.get<ApiPage<ApiBattle>>(`/players/${encTag(p.tag)}/battlelog`);
    save(`battlelog-${i + 1}.json`, log);
    const types = new Map<string, number>();
    for (const b of log.items) types.set(`${b.battleType}/${b.attack ? 'atk' : 'def'}`, (types.get(`${b.battleType}/${b.attack ? 'atk' : 'def'}`) ?? 0) + 1);
    const ts = log.items.map((b) => b.battleTimestamp).filter(Boolean).sort();
    notes.push(`battlelog ${i + 1} (leagueTier ${p.leagueTier?.id}): ${log.items.length} entries, types=${JSON.stringify([...types])}, keys=${JSON.stringify(Object.keys(log.items[0] ?? {}))}, ts range ${ts[0]} → ${ts.at(-1)}, paging=${JSON.stringify(log.paging)}`);
  }

  console.log('GET /players/{tag}');
  const player = await api.get<Record<string, unknown>>(`/players/${encTag(picks[0].tag)}`);
  save('player.json', player);
  notes.push(`player keys: ${JSON.stringify(Object.keys(player))}`);
  notes.push(`player leagueTier: ${JSON.stringify(player.leagueTier)}, league: ${JSON.stringify(player.league)}`);

  fs.writeFileSync(path.join(OUT, 'probe-notes.txt'), notes.join('\n') + '\n');
  console.log('\n' + notes.join('\n'));
  console.log(`\n${api.requestCount} requests.`);
}

main().catch((e) => {
  if (e instanceof ApiError) {
    console.error(`\nAPI error: ${e.message}`);
    if (e.status === 403) console.error('403: the key is probably locked to a different IP. Create a key for your current public IP at developer.clashofclans.com.');
  } else console.error(e);
  process.exit(1);
});
