// Step 2: army share code parser, aggregation, collector and meta-ranked queues.
// Uses recorded, redacted API fixtures (tests/fixtures/api/) — never the live API.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/data/loadNode';
import { aggregate, apiTimestampToIso, attackUsage, buildCatalog, parseSuperTroops, recencyWeight, rowKey, type BattleRow } from '../src/meta/aggregate';
import { extractArmyPayload, parseArmyCode, splitArmySections } from '../src/meta/armyCode';
import { coerceMeta, EMPTY_META, metaStats, type MetaFile } from '../src/meta/meta';
import { buildPlan } from '../src/engine/plan';
import { backoff, createClient } from '../scripts/lib/api';
import { battleToRow, fetchPlayerAttacks, gatherPlayers, isLegendAttack } from '../scripts/lib/collect';
import { data, makeExport, parse, settings, T0 } from './helpers';

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/api/${name}`, import.meta.url), 'utf8'));
const superTroops = parseSuperTroops(readConfig('super-troops.yaml'));
const catalog = buildCatalog(data, superTroops);
const nameOf = (id: number) => catalog.get(id)?.name;
const LINK = 'https://link.clashofclans.com/en?action=CopyArmy&army=';

// ── Parser: cases ported from clashy.go tests/game_test.go + static_safety_test.go ──
describe('armyShareCode parser (ported from clashy.go)', () => {
  const cases = [
    { name: 'full army link', link: `${LINK}h0p4e8_14-1p9e39_48-2p7e34_4-4p10e13_40i3x53-1x0-1x135-1x87d1x53-1x9u1x23-2x53-1x12-2x58-4x6-1x10-2x28-1x82-1x97-10x11-12x98-2x1-1x87-1x91-1x135s4x35-2x2-2x5-1x17`, heroes: 4, cc: 4, ccSpells: 2, troops: 15, spells: 4, pet: true, equip: 2 },
    { name: 'mixed optional hero fields', link: `${LINK}h6p11e35_43-2m1p16e4_24-0p4e32_14-7e52_53i1x65-6x5-1x62d4x120s5x120`, heroes: 4, cc: 3, ccSpells: 1, troops: 0, spells: 1, pet: true, equip: 2 },
    { name: 'troops only', link: `${LINK}u1x0-1x1-1x4`, heroes: 0, cc: 0, ccSpells: 0, troops: 3, spells: 0 },
    { name: 'single hero only', link: `${LINK}h0p4e8_14`, heroes: 1, cc: 0, ccSpells: 0, troops: 0, spells: 0, pet: true, equip: 2 },
    { name: 'hero castle troop and spell', link: `${LINK}h0p4e8_14i1x52d1x70`, heroes: 1, cc: 1, ccSpells: 1, troops: 0, spells: 0, pet: true, equip: 2 },
  ];
  for (const c of cases)
    it(c.name, () => {
      const r = parseArmyCode(c.link);
      expect([r.heroes.length, r.ccTroops.length, r.ccSpells.length, r.troops.length, r.spells.length]).toEqual([c.heroes, c.cc, c.ccSpells, c.troops, c.spells]);
      if (c.heroes) {
        expect(r.heroes[0].pet !== undefined).toBe(c.pet);
        expect(r.heroes[0].equipment).toHaveLength(c.equip!);
      }
    });

  const heroCases: [string, boolean, number][] = [
    ['h0', false, 0],
    ['h0p4', true, 0],
    ['h0e8', false, 1],
    ['h0e8_14', false, 2],
    ['h0p4e8', true, 1],
    ['h0p4e8_14', true, 2],
    ['h2m1p7e34_4', true, 2], // hero skin
  ];
  for (const [payload, pet, equip] of heroCases)
    it(`hero optional fields: ${payload}`, () => {
      const r = parseArmyCode(LINK + payload);
      expect(r.heroes).toHaveLength(1);
      expect(r.heroes[0].pet !== undefined).toBe(pet);
      expect(r.heroes[0].equipment).toHaveLength(equip);
    });

  it('hero loadout IDs use the static base IDs (Archer Queen + Frosty + Giant Arrow + Action Figure)', () => {
    const [h] = parseArmyCode('h1p9e17_48').heroes;
    expect(nameOf(h.hero)).toBe('Archer Queen');
    expect(nameOf(h.pet!)).toBe('Frosty');
    expect(h.equipment.map(nameOf)).toEqual(['Giant Arrow', 'Action Figure']);
  });

  it('accepts a raw share code and keeps the original link', () => {
    const r = parseArmyCode('u1x0-1x1-1x4');
    expect(r.troops.map((t) => nameOf(t.id))).toEqual(['Barbarian', 'Archer', 'Wall Breaker']);
    expect(r.heroes).toHaveLength(0);
    expect(r.link).toBe('u1x0-1x1-1x4');
  });

  it('skips malformed items without inventing units (Go case)', () => {
    // As in Go, the "d" in "bad" starts a new section: u0x0-ba | dx0-2x | ba | d-2x999999 | h999999p999999e999999.
    const r = parseArmyCode('u0x0-badx0-2xbad-2x999999h999999p999999e999999');
    expect(r.troops).toEqual([]);
    expect(r.ccSpells).toEqual([{ id: 26_999_999, qty: 2 }]);
    expect(r.heroes).toEqual([{ hero: 28_999_999, pet: 73_999_999, equipment: [90_999_999] }]);
    // Go drops unknown IDs at parse time; this port keeps them so they can be reported.
    const u = attackUsage(r, catalog);
    expect(u.unknown.map((x) => x.id).sort()).toEqual([26_999_999, 28_999_999, 73_999_999, 90_999_999]);
    expect(u.unknown.find((x) => x.id === 28_999_999)!.counted).toBe(false); // heroes never count
    expect(u.unknown.find((x) => x.id === 26_999_999)!.counted).toBe(false); // CC spells never count
    expect(u.units.has(26_999_999)).toBe(false);
  });

  it('an unknown home troop is still counted', () => {
    const u = attackUsage(parseArmyCode('u2x999999-0x1-3x'), catalog);
    expect([...u.units]).toEqual([[4_999_999, 2]]);
    expect(u.unknown).toEqual([{ id: 4_999_999, section: 'u', counted: true }]);
  });

  it('payload extraction and section splitting', () => {
    expect(extractArmyPayload(`${LINK}u1x0s2x1`)).toBe('u1x0s2x1');
    expect(extractArmyPayload('  u1x0s2x1 ')).toBe('u1x0s2x1');
    expect(splitArmySections('h0p4u1x0-2x5s3x2')).toEqual(['h0p4', 'u1x0-2x5', 's3x2']);
  });
});

// ── Parser on real Legend I codes from the probe fixtures ──
describe('armyShareCode on real battle logs', () => {
  const logs = [1, 2, 3].map((n) => fixture(`battlelog-${n}.json`).items as { battleType: string; attack: boolean; armyShareCode?: string }[]);
  const legend = logs.flat().filter((b) => b.battleType === 'legend' && b.attack && b.armyShareCode);

  it('fixtures contain Legend I attacks with army codes', () => {
    expect(legend.length).toBeGreaterThan(20);
  });

  it('every item of every real code parses (no silently dropped entries)', () => {
    for (const b of legend) {
      const r = parseArmyCode(b.armyShareCode!);
      const sections = splitArmySections(b.armyShareCode!);
      const count = (m: string) => sections.filter((s) => s[0] === m).reduce((n, s) => n + s.slice(1).split('-').filter(Boolean).length, 0);
      expect(r.heroes.length).toBe(count('h'));
      expect(r.troops.length).toBe(count('u'));
      expect(r.spells.length).toBe(count('s'));
      expect(r.ccTroops.length).toBe(count('i'));
      expect(r.ccSpells.length).toBe(count('d'));
      expect(r.heroes.length).toBeGreaterThan(0);
    }
  });

  it('every ID in the real codes resolves against the game data (+ super troop config)', () => {
    const KNOWN_UNKNOWN = new Set([4_000_197]); // event troop, not in clash-of-clans-data (see DECISIONS.md)
    const unknown = new Set<number>();
    for (const b of legend) for (const u of attackUsage(parseArmyCode(b.armyShareCode!), catalog).unknown) if (!KNOWN_UNKNOWN.has(u.id)) unknown.add(u.id);
    expect([...unknown]).toEqual([]);
  });

  it('a real Legend I army: home troops/spells counted, CC siege counted, other CC units ignored', () => {
    const code = 'h1p9e17_48-2m1p16e4_34-6p17e43_49-7p4e60_52i1x188-1x63-1x81d1x2-1x70u6x57-1x63-8x8-5x65-1x10-2x1s2x98-3x109-3x120-1x5';
    expect(legend.some((b) => b.armyShareCode === code)).toBe(true);
    const r = parseArmyCode(code);
    expect(r.heroes.map((h) => nameOf(h.hero))).toEqual(['Archer Queen', 'Grand Warden', 'Minion Prince', 'Dragon Duke']);
    expect(r.heroes.map((h) => nameOf(h.pet!))).toEqual(['Frosty', 'Sneezy', 'Greedy Raven', 'Phoenix']);
    const u = attackUsage(r, catalog);
    const named = Object.fromEntries([...u.units].map(([id, q]) => [nameOf(id), q]));
    expect(named).toMatchObject({ 'Rocket Balloon': 6, 'Inferno Dragon': 1, Dragon: 8, 'Dragon Rider': 5, Minion: 1, Archer: 2 });
    expect(named).toMatchObject({ 'Revive Spell': 2, 'Ice Block Spell': 3, 'Totem Spell': 3, 'Freeze Spell': 1 });
    expect(named['Sky Wagon']).toBe(1); // siege in the CC
    expect(named['Super Dragon']).toBeUndefined(); // CC troop: ignored
    expect(named['Giant Arrow']).toBe(1);
    expect(named['Revenge Deck']).toBe(1);
    expect(u.units.size).toBe(1 + 6 + 4 + 4 + 8); // siege + troops + spells + pets + equipment
  });
});

// ── Super troop IDs: the API lists a player's troops in dataId order ──
describe('config/super-troops.yaml', () => {
  it('every super troop maps to a real base troop', () => {
    for (const [id, s] of Object.entries(superTroops)) {
      expect(data.byId.get(s.base)?.category, `${id} ${s.name}`).toBe('troop');
      expect(catalog.get(Number(id))?.kind).toBe('superTroop');
    }
  });

  it("IDs agree with the order of /players/{tag} troops (the API sorts them by dataId)", () => {
    const player = fixture('player.json') as { troops: { name: string; village: string }[] };
    const idByName = new Map<string, number>();
    for (const [id, info] of catalog) if (info.kind === 'troop' || info.kind === 'superTroop' || info.kind === 'siege') idByName.set(info.name, id);
    const ordered = player.troops.filter((t) => t.village === 'home' && idByName.has(t.name)).map((t) => ({ name: t.name, id: idByName.get(t.name)! }));
    for (const s of Object.values(superTroops)) expect(ordered.map((o) => o.name)).toContain(s.name);
    for (let i = 1; i < ordered.length; i++) expect(ordered[i].id, `${ordered[i - 1].name} < ${ordered[i].name}`).toBeGreaterThan(ordered[i - 1].id);
  });
});

// ── Aggregation ──
describe('aggregate', () => {
  const NOW = Date.parse('2026-11-16T12:00:00Z');
  const DAY = 86_400_000;
  const row = (tag: string, daysAgo: number, stars: number, code: string): BattleRow => ({ tag, ts: new Date(NOW - daysAgo * DAY).toISOString(), stars, destruction: stars === 3 ? 100 : 80, armyShareCode: code });
  const opts = { nowMs: NOW, windowDays: 14, halfLifeDays: 5 };

  it('recency weight halves every half-life', () => {
    expect(recencyWeight(0, 5)).toBe(1);
    expect(recencyWeight(5 * DAY, 5)).toBeCloseTo(0.5, 10);
    expect(recencyWeight(10 * DAY, 5)).toBeCloseTo(0.25, 10);
    expect(recencyWeight(-DAY, 5)).toBe(1);
  });

  it('weighted usage, 3★ rate and avgQty from hand-made rows', () => {
    // A: today, 3★, 10 Barbarians + 2 Rage. B: 5 days ago (weight ½), 1★, 20 Barbarians + Wall Wrecker in CC.
    // C: 20 days ago → outside the 14-day window.
    const rows = [row('#A', 0, 3, 'u10x0s2x2'), row('#B', 5, 1, 'u20x0i1x51-3x1'), row('#C', 20, 3, 'u5x1')];
    const { meta } = aggregate(rows, catalog, opts);
    expect(meta.attacks).toBe(2);
    expect(meta.players).toBe(2);
    const barb = meta.units['4000000'];
    expect(barb.usage).toBe(1);
    expect(barb.threeStarRate).toBeCloseTo(1 / 1.5, 4); // (1·1 + ½·0) / 1.5
    expect(barb.avgQty).toBeCloseTo((10 + 0.5 * 20) / 1.5, 2);
    const rage = meta.units['26000002'];
    expect(rage.usage).toBeCloseTo(1 / 1.5, 4);
    expect(rage.threeStarRate).toBe(1);
    const wrecker = meta.units['4000051'];
    expect(wrecker.usage).toBeCloseTo(0.5 / 1.5, 4);
    expect(wrecker.avgQty).toBeUndefined(); // sieges have no avgQty
    expect(wrecker.kind).toBe('siege');
    expect(meta.units['4000001']).toBeUndefined(); // CC Archers ignored; #C's Archers are outside the window
  });

  it('pets and equipment come from hero loadouts; super troops carry their base troop id', () => {
    const { meta } = aggregate([row('#A', 0, 3, 'h1p9e17_48u5x83')], catalog, opts);
    expect(meta.units['73000009']).toMatchObject({ name: 'Frosty', usage: 1, kind: 'pet' });
    expect(meta.units['90000017']).toMatchObject({ name: 'Giant Arrow', kind: 'equipment' });
    expect(meta.units['4000083']).toMatchObject({ name: 'Super Wizard', kind: 'superTroop', baseId: 4000006, avgQty: 5 });
    expect(meta.units['28000001']).toBeUndefined(); // heroes aren't ranked
  });

  it('unknown IDs are counted and reported', () => {
    const res = aggregate([row('#A', 0, 3, 'u3x999i1x998')], catalog, opts);
    expect(res.meta.units['4000999']).toMatchObject({ name: 'Unknown troop 4000999', usage: 1 });
    expect(res.unknown.get(4000999)).toMatchObject({ attacks: 1, counted: true });
    expect(res.unknown.get(4000998)).toMatchObject({ attacks: 1, counted: false });
  });

  it('timestamps and dedupe keys', () => {
    expect(apiTimestampToIso('20261116T180741.000Z')).toBe('2026-11-16T18:07:41.000Z');
    expect(rowKey({ tag: '#A', ts: 'x' })).toBe('#A|x');
  });
});

// ── Collector (fake fetch serving the recorded fixtures) ──
function fakeApi(routes: Record<string, unknown | ((n: number) => Response)>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const p = url.replace('https://api.clashofclans.com/v1', '');
    calls.push(p);
    const r = routes[p];
    if (typeof r === 'function') return r(calls.filter((c) => c === p).length);
    if (r === undefined) return new Response(JSON.stringify({ reason: 'notFound' }), { status: 404 });
    return new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
  const api = createClient({ token: 'test', requestsPerSecond: 1000, fetchImpl, sleep: async () => {} });
  return { api, calls };
}

describe('collector', () => {
  it('keeps only Legend I attacks (battleType "legend", attack true)', () => {
    const items = fixture('battlelog-3.json').items;
    const kept = items.filter(isLegendAttack);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((b: { battleType: string; attack: boolean }) => b.battleType === 'legend' && b.attack)).toBe(true);
    expect(items.some((b: { battleType: string }) => b.battleType === 'ranked' || b.battleType === 'homeVillage')).toBe(true);
    const row = battleToRow('#X', kept[0])!;
    expect(row).toMatchObject({ tag: '#X', stars: kept[0].stars, destruction: kept[0].destructionPercentage, armyShareCode: kept[0].armyShareCode });
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('fetchPlayerAttacks turns a battle log into rows', async () => {
    const log = fixture('battlelog-1.json');
    const { api } = fakeApi({ '/players/%23P1/battlelog': log });
    const r = await fetchPlayerAttacks(api, '#P1');
    expect(r.entries).toBe(log.items.length);
    expect(r.rows.length).toBe(log.items.filter(isLegendAttack).length);
    const missing = await fetchPlayerAttacks(api, '#GONE');
    expect(missing.notFound).toBe(true);
  });

  it('gathers Legend I players from global + countries, dedupes, filters tier, stops at maxPlayers', async () => {
    const global = fixture('rankings-global-limit5.json');
    const country = fixture('rankings-country-limit5.json');
    const lowTier = { items: [{ tag: '#LOW', name: 'x', leagueTier: { id: 105000035, name: 'Legend League II' } }, { tag: global.items[0].tag, leagueTier: { id: 105000036 } }] };
    const locations = { items: [{ id: 1, name: 'A', isCountry: true }, { id: 2, name: 'Region', isCountry: false }, { id: 3, name: 'B', isCountry: true }], paging: { cursors: {} } };
    const { api, calls } = fakeApi({ '/locations': locations, '/locations/global/rankings/players': global, '/locations/1/rankings/players': lowTier, '/locations/3/rankings/players': country });
    const tags = await gatherPlayers(api, { maxPlayers: 8 });
    expect(tags).not.toContain('#LOW');
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags.length).toBe(8);
    expect(calls).not.toContain('/locations/2/rankings/players'); // regions skipped
    const few = await gatherPlayers(fakeApi({ '/locations': locations, '/locations/global/rankings/players': global }).api, { maxPlayers: 3 });
    expect(few).toEqual(global.items.slice(0, 3).map((p: { tag: string }) => p.tag));
  });

  it('retries 429/5xx with backoff, then succeeds; other errors throw', async () => {
    const waits: number[] = [];
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) return new Response('{}', { status: 429 });
      if (n === 2) return new Response('{}', { status: 503 });
      return new Response('{"items":[]}', { status: 200 });
    }) as unknown as typeof fetch;
    const api = createClient({ token: 't', requestsPerSecond: 1000, fetchImpl, sleep: async (ms) => void waits.push(ms) });
    expect(await api.get('/x')).toEqual({ items: [] });
    expect(n).toBe(3);
    const retryWaits = waits.filter((w) => w >= 1000);
    expect(retryWaits[0]).toBeGreaterThanOrEqual(1000);
    expect(retryWaits[1]).toBeGreaterThanOrEqual(2000);
    expect(backoff(10)).toBeLessThanOrEqual(30_250);

    const forbidden = createClient({ token: 't', fetchImpl: (async () => new Response('{"reason":"accessDenied.invalidIp","message":"Invalid authorization: API key does not allow access from IP 1.2.3.4"}', { status: 403 })) as unknown as typeof fetch, sleep: async () => {} });
    await expect(forbidden.get('/x')).rejects.toMatchObject({ status: 403, reason: 'accessDenied.invalidIp' });
  });
});

// ── Meta-ranked lab / pets / equipment ──
describe('meta ranking', () => {
  const meta = (units: MetaFile['units']): MetaFile => ({ ...EMPTY_META, generatedAt: '2026-11-16T00:00:00Z', attacks: 100, players: 10, units });
  const id = (fileId: string) => String(data.byId.get(fileId)!.dataId);

  it('lab: meta score descending, unused at the bottom (shortest first), pins on top', () => {
    const ex = makeExport(16);
    const acct = parse(ex);
    const m = meta({ [id('balloon')]: { name: 'Balloon', usage: 0.6, threeStarRate: 0.8 }, [id('rage-spell')]: { name: 'Rage Spell', usage: 0.2, threeStarRate: 0.7 } });
    const plan = buildPlan(data, acct, settings(), m, T0);
    expect(plan.lab.slice(0, 2).map((c) => c.item.id)).toEqual(['balloon', 'rage-spell']);
    expect(plan.lab[0].reason).toContain('60.0%');
    const unused = plan.lab.slice(2);
    expect(unused.length).toBeGreaterThan(0);
    expect(unused.every((c) => c.usage === 0)).toBe(true);
    for (let i = 1; i < unused.length; i++) expect(unused[i].rawTimeSec).toBeGreaterThanOrEqual(unused[i - 1].rawTimeSec);

    const pinned = buildPlan(data, acct, settings({ lab: { pinned: ['archer'] } }), m, T0);
    expect(pinned.lab[0].item.id).toBe('archer');
    expect(pinned.lab[0].pinned).toBe(true);
    expect(pinned.lab[1].item.id).toBe('balloon');
  });

  it('the scheduler researches in meta order', () => {
    const acct = parse(makeExport(16, 16)); // buildings maxed for TH16, so the Laboratory isn't upgrading
    const m = meta({ [id('wall-wrecker')]: { name: 'Wall Wrecker', usage: 0.9, threeStarRate: 0.8 } });
    const plan = buildPlan(data, acct, settings(), m, T0);
    expect(plan.sim.timeline.find((e) => e.slotId === 'LAB' && !e.inProgress)?.itemName).toBe('Wall Wrecker');
  });

  it('super troop usage is credited to the base troop', () => {
    const m = meta({
      '4000006': { name: 'Wizard', usage: 0.1, threeStarRate: 0.5 },
      '4000083': { name: 'Super Wizard', usage: 0.3, threeStarRate: 0.9, kind: 'superTroop', baseId: 4000006 },
    });
    const s = metaStats(m, 4000006);
    expect(s.usage).toBeCloseTo(0.4, 10);
    expect(s.ownUsage).toBe(0.1);
    expect(s.supers).toEqual([{ name: 'Super Wizard', usage: 0.3 }]);
    expect(s.threeStarRate).toBeCloseTo((0.1 * 0.5 + 0.3 * 0.9) / 0.4, 10);
  });

  it('equipment and the ore forecast follow meta usage', () => {
    const ex = makeExport(16);
    ex.equipment.push({ data: data.byId.get('earthquake-boots')!.dataId, lvl: 3 });
    const plan = buildPlan(data, parse(ex), settings(), meta({ [id('earthquake-boots')]: { name: 'Earthquake Boots', usage: 0.5, threeStarRate: 0.8 } }), T0);
    expect(plan.equipment[0].item.id).toBe('earthquake-boots');
    expect(plan.forecast.oreItems[0].item.id).toBe('earthquake-boots');
  });

  it('missing or junk meta falls back to Step 1 behaviour', () => {
    expect(coerceMeta(null)).toEqual(EMPTY_META);
    expect(coerceMeta({ units: { 1: { name: 'x' } } }).units).toEqual({});
    const plan = buildPlan(data, parse(makeExport(16)), settings(), coerceMeta(undefined), T0);
    expect(plan.lab.every((c) => c.usage === 0)).toBe(true);
    expect(plan.lab[0].reason).toContain('shortest first');
  });
});

// ── Army-share score (SPEC §8.3, Step 2 follow-up) ──
describe('army-share score', () => {
  const NOW = Date.parse('2026-11-16T12:00:00Z');
  const DAY = 86_400_000;
  const opts = { nowMs: NOW, windowDays: 14, halfLifeDays: 5 };
  const row = (tag: string, daysAgo: number, code: string): BattleRow => ({ tag, ts: new Date(NOW - daysAgo * DAY).toISOString(), stars: 3, destruction: 100, armyShareCode: code });
  const hs = (fileId: string) => data.byId.get(fileId)!.housingSpace!;
  const short = (fileId: string) => data.byId.get(fileId)!.dataId % 1_000_000;

  it('every troop, spell and siege in the game data has a housing space, and so does every mapped super troop', () => {
    const missing = [...data.items.values()].filter((i) => ['troop', 'spell', 'siege'].includes(i.category) && !i.housingSpace).map((i) => i.name);
    expect(missing).toEqual([]);
    const supers = [...catalog.values()].filter((u) => u.kind === 'superTroop');
    expect(supers.length).toBe(Object.keys(superTroops).length);
    expect(supers.filter((u) => !u.housing).map((u) => u.name)).toEqual([]);
    expect(catalog.get(4000083)!.housing).toBe(data.byId.get('wizard')!.superHousingSpace); // Super Wizard uses its own space
    expect(catalog.get(4000083)!.housing).not.toBe(hs('wizard'));
  });

  it('per attack: (qty × housing) ÷ total troop space; spells use spell space; sieges are left out', () => {
    // 10 Barbarians + 4 Giants + Wall Wrecker in u; 2 Rage + 1 Poison.
    const code = `u10x0-4x${short('giant')}-1x51s2x${short('rage-spell')}-1x${short('poison-spell')}`;
    const u = attackUsage(parseArmyCode(code), catalog);
    const troopTotal = 10 * hs('barbarian') + 4 * hs('giant');
    expect(u.shares.get(4000000)).toBeCloseTo((10 * hs('barbarian')) / troopTotal, 10);
    expect(u.shares.get(data.byId.get('giant')!.dataId)).toBeCloseTo((4 * hs('giant')) / troopTotal, 10);
    expect(u.shares.has(4000051)).toBe(false); // siege: plain usage
    const spellTotal = 2 * hs('rage-spell') + hs('poison-spell');
    expect(u.shares.get(data.byId.get('rage-spell')!.dataId)).toBeCloseTo((2 * hs('rage-spell')) / spellTotal, 10);
    expect(u.noHousing).toEqual([]);
  });

  it('weighted average over all attacks in the window (0 where absent), super troops with their own space', () => {
    // A today (weight 1): 5 Wizards + 5 Super Wizards. B 5 days ago (weight ½): 20 Barbarians only.
    const rows = [row('#A', 0, 'u5x6-5x83'), row('#B', 5, 'u20x0'), row('#C', 30, 'u20x6')];
    const { meta } = aggregate(rows, catalog, opts);
    const sw = data.byId.get('wizard')!.superHousingSpace!;
    const aTotal = 5 * hs('wizard') + 5 * sw;
    expect(meta.units['4000006'].armyShare).toBeCloseTo((5 * hs('wizard')) / aTotal / 1.5, 4);
    expect(meta.units['4000083'].armyShare).toBeCloseTo((5 * sw) / aTotal / 1.5, 4);
    expect(meta.units['4000000'].armyShare).toBeCloseTo(0.5 / 1.5, 4);
    // Shares of one army add up to 1, so the averages do too.
    const total = Object.values(meta.units).reduce((s, x) => s + (x.armyShare ?? 0), 0);
    expect(total).toBeCloseTo(1, 3);
    // Base troop score = own share + super share; usage stays visible.
    const s = metaStats(meta, 4000006);
    expect(s.scoreKind).toBe('armyShare');
    expect(s.score).toBeCloseTo((meta.units['4000006'].armyShare ?? 0) + (meta.units['4000083'].armyShare ?? 0), 4);
    expect(s.usage).toBe(1); // 2/3 own + 2/3 super, capped
  });

  it('a unit without housing data is listed and falls back to usage share; it is left out of the totals', () => {
    const giantId = data.byId.get('giant')!.dataId;
    const cat = new Map(catalog);
    cat.set(giantId, { ...cat.get(giantId)!, housing: undefined });
    const res = aggregate([row('#A', 0, `u10x0-4x${short('giant')}`)], cat, opts);
    expect(res.noHousing.get(giantId)).toBe('Giant');
    expect(res.meta.units[String(giantId)].armyShare).toBeUndefined();
    expect(res.meta.units['4000000'].armyShare).toBe(1);
    const g = metaStats(res.meta, giantId);
    expect(g.scoreKind).toBe('usage');
    expect(g.score).toBe(1);
  });

  it('sieges, pets and equipment keep plain usage share; old meta files without armyShare fall back to usage', () => {
    const { meta } = aggregate([row('#A', 0, 'h1p9e17_48u10x0i1x51')], catalog, opts);
    for (const id of [4000051, 73000009, 90000017]) {
      expect(meta.units[String(id)].armyShare).toBeUndefined();
      expect(metaStats(meta, id)).toMatchObject({ scoreKind: 'usage', score: 1 });
    }
    const old: MetaFile = { ...EMPTY_META, attacks: 1, units: { '4000006': { name: 'Wizard', usage: 0.4, threeStarRate: 0.5, kind: 'troop' } } };
    expect(metaStats(old, 4000006)).toMatchObject({ scoreKind: 'usage', score: 0.4 });
    // A super troop without armyShare makes the base troop fall back to usage as a whole.
    old.units['4000083'] = { name: 'Super Wizard', usage: 0.2, threeStarRate: 0.5, kind: 'superTroop', baseId: 4000006 };
    old.units['4000006'].armyShare = 0.1;
    expect(metaStats(old, 4000006)).toMatchObject({ scoreKind: 'usage' });
    expect(metaStats(old, 4000006).score).toBeCloseTo(0.6, 10);
  });

  it('lab ranks a high-share troop above a filler troop that appears in more armies', () => {
    const m: MetaFile = {
      ...EMPTY_META,
      generatedAt: '2026-11-16T00:00:00Z',
      attacks: 100,
      players: 10,
      units: {
        '4000001': { name: 'Archer', usage: 0.9, threeStarRate: 0.6, armyShare: 0.02, kind: 'troop' },
        [String(data.byId.get('balloon')!.dataId)]: { name: 'Balloon', usage: 0.3, threeStarRate: 0.7, armyShare: 0.15, kind: 'troop' },
      },
    };
    const plan = buildPlan(data, parse(makeExport(16)), settings(), m, T0);
    expect(plan.lab.slice(0, 2).map((c) => c.item.id)).toEqual(['balloon', 'archer']);
    expect(plan.lab[0]).toMatchObject({ scoreKind: 'armyShare', score: 0.15, usage: 0.3 });
    expect(plan.lab[0].reason).toBe('Legend I: 15.0% of troop space (in 30.0% of attacks) · lab pick 1.00 (1.00 of top troop × 1)');
  });
});

// ── Lab queue pick across kinds (SPEC §6.7) ──
describe('lab pick: normalized within kind × kind weight', () => {
  const id = (fileId: string) => String(data.byId.get(fileId)!.dataId);
  const meta: MetaFile = {
    ...EMPTY_META,
    generatedAt: '2026-11-16T00:00:00Z',
    attacks: 100,
    players: 10,
    units: {
      [id('archer')]: { name: 'Archer', usage: 0.5, threeStarRate: 0.6, armyShare: 0.3, kind: 'troop' }, // top troop
      [id('balloon')]: { name: 'Balloon', usage: 0.6, threeStarRate: 0.6, armyShare: 0.15, kind: 'troop' }, // 0.5 of top
      [id('rage-spell')]: { name: 'Rage Spell', usage: 0.7, threeStarRate: 0.6, armyShare: 0.4, kind: 'spell' }, // top spell
      [id('wall-wrecker')]: { name: 'Wall Wrecker', usage: 0.9, threeStarRate: 0.6, kind: 'siege' }, // top siege
    },
  };
  const acct = () => parse(makeExport(16, 16)); // Laboratory not upgrading

  it('settings: default weights 1 / 0.7 / 0.5; 0 allowed; junk falls back', async () => {
    const { coerceSettings, DEFAULT_SETTINGS } = await import('../src/state/settings');
    expect(DEFAULT_SETTINGS.lab.kindWeights).toEqual({ troop: 1, spell: 0.7, siege: 0.5 });
    expect(settings().lab.kindWeights).toEqual({ troop: 1, spell: 0.7, siege: 0.5 });
    expect(coerceSettings({ lab: { kindWeights: { troop: 0, spell: -1, siege: 'x' } } }).lab.kindWeights).toEqual({ troop: 0, spell: 0.7, siege: 0.5 });
    expect(coerceSettings({ lab: { pinned: ['archer'] } }).lab).toEqual({ pinned: ['archer'], kindWeights: { troop: 1, spell: 0.7, siege: 0.5 } });
  });

  it('each kind is divided by its Legend I top (so each kind’s #1 = 1.0), then weighted; highest value is picked', () => {
    const plan = buildPlan(data, acct(), settings(), meta, T0);
    const by = new Map(plan.lab.map((c) => [c.item.id, c]));
    expect(by.get('archer')).toMatchObject({ labKind: 'troop', normScore: 1, pickValue: 1 });
    expect(by.get('balloon')).toMatchObject({ labKind: 'troop', normScore: 0.5, pickValue: 0.5 });
    expect(by.get('rage-spell')!.pickValue).toBeCloseTo(0.7, 10);
    expect(by.get('wall-wrecker')).toMatchObject({ labKind: 'siege', normScore: 1, pickValue: 0.5 });
    // Order: Archer 1.0, Rage 0.7, then Wall Wrecker / Balloon tied at 0.5 → higher within-kind rank first.
    expect(plan.lab.slice(0, 4).map((c) => c.item.id)).toEqual(['archer', 'rage-spell', 'wall-wrecker', 'balloon']);
    expect(plan.lab[1].reason).toContain('lab pick 0.70 (1.00 of top spell × 0.7)');
    expect(plan.lab.slice(4).every((c) => c.pickValue === 0)).toBe(true); // unused last
  });

  it('the denominator is the Legend I top of the kind, not the best upgrade the player has', () => {
    const plan = buildPlan(data, acct(), settings(), meta, T0);
    const candidates = new Set(plan.lab.map((c) => c.item.id));
    const absent = [...data.items.values()].find((i) => i.category === 'troop' && i.queue === 'lab' && !candidates.has(i.id))!;
    expect(absent).toBeDefined();
    const m2: MetaFile = { ...meta, units: { ...meta.units, [String(absent.dataId)]: { name: absent.name, usage: 0.9, threeStarRate: 0.5, armyShare: 0.6, kind: 'troop' } } };
    const p2 = buildPlan(data, acct(), settings(), m2, T0);
    expect(p2.lab.find((c) => c.item.id === 'archer')!.normScore).toBeCloseTo(0.5, 10); // 0.3 / 0.6
    expect(p2.lab[0].item.id).toBe('rage-spell'); // 0.7 now beats Archer's 0.5
  });

  it('kind weights from settings change the pick, and the scheduler + forecast follow it', () => {
    const base = buildPlan(data, acct(), settings(), meta, T0);
    expect(base.sim.timeline.find((e) => e.slotId === 'LAB' && !e.inProgress)?.itemName).toBe('Archer');
    const w = settings({ lab: { kindWeights: { troop: 0.5, spell: 0.7, siege: 0.9 } } });
    const plan = buildPlan(data, acct(), w, meta, T0);
    expect(plan.lab[0].item.id).toBe('wall-wrecker'); // 1.0 × 0.9
    const first = plan.sim.timeline.find((e) => e.slotId === 'LAB' && !e.inProgress)!;
    expect(first.itemName).toBe('Wall Wrecker');
    expect(Object.values(plan.forecast.neededBy).flat().some((n) => n!.slotId === 'LAB' && n!.label.startsWith('Wall Wrecker'))).toBe(true);
  });

  it('pins still go first, in pin order', () => {
    const spell = buildPlan(data, acct(), settings(), meta, T0).labByKind.spell.at(-1)!.item.id; // an unused spell
    const plan = buildPlan(data, acct(), settings({ lab: { pinned: ['balloon', spell] } }), meta, T0);
    expect(plan.lab.slice(0, 3).map((c) => c.item.id)).toEqual(['balloon', spell, 'archer']);
    expect(plan.sim.timeline.find((e) => e.slotId === 'LAB' && !e.inProgress)?.itemName).toBe('Balloon');
    expect(plan.labByKind.spell[0].item.id).toBe(spell);
    expect(plan.labByKind.troop[0].item.id).toBe('balloon');
  });

  it('Lab tab sections: each kind ranked by its own score, unused at the bottom', () => {
    const plan = buildPlan(data, acct(), settings(), meta, T0);
    const { troop, spell, siege } = plan.labByKind;
    expect(troop.slice(0, 2).map((c) => c.item.id)).toEqual(['archer', 'balloon']);
    expect(spell[0].item.id).toBe('rage-spell');
    expect(siege[0].item.id).toBe('wall-wrecker');
    expect(troop.every((c) => c.item.category === 'troop') && spell.every((c) => c.item.category === 'spell') && siege.every((c) => c.item.category === 'siege')).toBe(true);
    expect(troop.length + spell.length + siege.length).toBe(plan.lab.length);
    for (const list of [troop, spell, siege]) {
      const firstUnused = list.findIndex((c) => c.usage === 0);
      if (firstUnused >= 0) expect(list.slice(firstUnused).every((c) => c.usage === 0)).toBe(true);
    }
  });
});
