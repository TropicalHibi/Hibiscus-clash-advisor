// Squads (TH19, SPEC §6.7, §8.3): squad info kept when pinning, config/squads.yaml resolution, the meta catalog
// (squad names and seasonal flags from the game data), the lab score crediting a squad's share to its troops,
// squad upgrades as lab items, and the "incl. squads" line in the Lab tab. Fixtures and synthetic meta only.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeClashKing, trimClashKing, type ClashKingRaw } from '../src/data/clashking';
import { levelInfo } from '../src/data/normalize';
import { parseOverrides } from '../src/data/overrides';
import { loadSquads, parseSquadsYaml, resolveSquads, squadPartsFor } from '../src/data/squads';
import type { GameData, Item } from '../src/data/types';
import { checkSquads } from '../src/data/validate';
import { buildPlan } from '../src/engine/plan';
import { researchCandidates } from '../src/engine/queues';
import type { EngineState } from '../src/engine/tiers';
import { aggregate, attackUsage, buildCatalog, type BattleRow } from '../src/meta/aggregate';
import { parseArmyCode } from '../src/meta/armyCode';
import { coerceMeta, metaStats, type MetaFile } from '../src/meta/meta';
import type { AccountState } from '../src/state/parseExport';
import { renderLab } from '../src/ui/labView';
import { data, makeExport, maxLab, parse, settings, T0 } from './helpers';

const FULL = JSON.parse(fs.readFileSync(new URL('./fixtures/clashking-mini.json', import.meta.url), 'utf8'));

/** The mini fixture plus a squad of 2 Barbarians (as ClashKing ships them: info + TID on the entry). */
function withSquad(): unknown {
  const full = structuredClone(FULL);
  full.troops.push({
    _id: 4000195,
    name: 'Barb Squad',
    info: 'Two Barbarians.',
    TID: { name: 'TID_BARB_SQUAD', info: 'TID_CHARACTER_INFO_BARB_SQUAD' },
    production_building: 'Squad Barracks',
    upgrade_resource: 'Elixir',
    housing_space: 3,
    village: 'home',
    levels: [
      { level: 1, required_townhall: 8, upgrade_cost: 1000, upgrade_time: 3600 },
      { level: 2, required_townhall: 19, required_lab_level: 17, upgrade_cost: 0, upgrade_time: 0 },
    ],
  });
  return full;
}
const miniWith = (squadsYaml?: string) => normalizeClashKing(trimClashKing(withSquad()), { version: 'clashking-test', overrides: parseOverrides({}), squads: squadsYaml });

describe('pinning keeps squad descriptions', () => {
  it("trimming keeps a squad's info text and drops every other info and TID", () => {
    const t = trimClashKing(withSquad()) as ClashKingRaw;
    const sq = t.troops.find((x) => x._id === 4000195);
    expect(sq.info).toBe('Two Barbarians.');
    expect(sq.TID).toBeUndefined();
    const others = JSON.stringify({ ...t, troops: t.troops.filter((x) => x._id !== 4000195) });
    expect(others).not.toContain('"info"');
    expect(JSON.stringify(t)).not.toContain('"TID"');
  });

  it('the pinned copy carries the info of every squad and of nothing else', () => {
    const raw = JSON.parse(fs.readFileSync(new URL('../data/clashking/static_data.json', import.meta.url), 'utf8')) as ClashKingRaw;
    for (const [section, list] of Object.entries(raw))
      for (const x of list) {
        const squad = section === 'troops' && x.production_building === 'Squad Barracks';
        if (!squad) expect(x.info, `${x.name} keeps no info`).toBeUndefined();
      }
  });
});

describe('config/squads.yaml', () => {
  it('normalizing flags squads (Squad Barracks) and keeps their description', () => {
    const d = miniWith();
    expect(d.byId.get('barb-squad')).toMatchObject({ category: 'troop', queue: 'lab', squad: true, description: 'Two Barbarians.' });
    expect(d.byId.get('barbarian')!.squad).toBeUndefined();
  });

  it('counts → split by count × housing space; no counts → equal split', () => {
    const counted = resolveSquads(data, parseSquadsYaml('squads:\n  x:\n    troops: [{ id: barbarian, count: 15 }, { id: giant, count: 3 }]'));
    expect(counted.squads).toEqual({}); // "x" isn't a squad
    expect(counted.warnings[0]).toContain('"x" is not a squad');

    const d = miniWith('squads:\n  barb-squad:\n    troops:\n      - { id: barbarian, count: 2 }\n      - { id: wall-wrecker, count: 1 }');
    const sq = d.squads![4000195];
    // Wall Wrecker is a siege in the fixture, not a troop: left out with a warning; Barbarian gets it all.
    expect(sq.troops.map((t) => [t.id, t.count, t.fraction])).toEqual([['barbarian', 2, 1]]);
    expect(d.warnings.some((w) => w.includes('"wall-wrecker" is not a troop'))).toBe(true);

    // On the real data: two troops with counts split by count × housing; without counts, half each.
    const [a, b] = [data.byId.get('barbarian')!, data.byId.get('giant')!];
    const fake = new Map(data.byId);
    fake.set('sq', { ...a, id: 'sq', squad: true, dataId: 1 } as Item);
    const withCounts = resolveSquads({ byId: fake }, { sq: { troops: [{ id: a.id, count: 15 }, { id: b.id, count: 3 }] } }).squads[1];
    const total = 15 * a.housingSpace! + 3 * b.housingSpace!;
    expect(withCounts.countsKnown).toBe(true);
    expect(withCounts.troops.map((t) => t.fraction)).toEqual([(15 * a.housingSpace!) / total, (3 * b.housingSpace!) / total]);
    const noCounts = resolveSquads({ byId: fake }, { sq: { troops: [{ id: a.id, count: 15 }, { id: b.id }] } }).squads[1];
    expect(noCounts.countsKnown).toBe(false);
    expect(noCounts.troops.map((t) => t.fraction)).toEqual([0.5, 0.5]);
  });

  it("a YAML error is a warning (squads aren't credited), never a load failure", () => {
    const r = loadSquads(data, 'squads: [unclosed');
    expect(r.squads).toEqual({});
    expect(r.warnings[0]).toMatch(/^config\/squads\.yaml: .*squads aren't credited/);
    expect(miniWith('squads: [unclosed').warnings.some((w) => w.startsWith('config/squads.yaml'))).toBe(true);
  });

  it('sync validation lists a squad with no entry, with its description', () => {
    const issues = checkSquads(miniWith());
    expect(issues).toEqual([{ level: 'warn', check: 'squads', message: expect.stringContaining('Barb Squad has no entry in config/squads.yaml') }]);
    expect(issues[0].message).toContain('Two Barbarians.');
    expect(checkSquads(miniWith('squads:\n  barb-squad:\n    troops: [{ id: barbarian, count: 2 }]'))).toEqual([]);
  });

  it('the shipped squads.yaml loads without warnings and every troop in it exists', () => {
    expect(data.warnings.filter((w) => w.includes('squads.yaml'))).toEqual([]);
    for (const sq of Object.values(data.squads ?? {}))
      for (const t of sq.troops) expect(data.byId.get(t.id)?.category).toBe('troop');
  });
});

describe('meta catalog: names and seasonal flags from the game data', () => {
  const d = miniWith();
  const cat = buildCatalog(d);
  const row = (code: string, ts = '2026-09-20T00:00:00.000Z'): BattleRow => ({ tag: '#P', ts, stars: 3, destruction: 100, armyShareCode: code });

  it('a squad is a named troop; a seasonal unit is named and flagged', () => {
    expect(cat.get(4000195)).toMatchObject({ kind: 'troop', name: 'Barb Squad', squad: true, housing: 3 });
    expect(cat.get(4000030)).toMatchObject({ name: 'Ice Wizard', seasonal: true });
  });

  it('seasonal units are left out of usage, the totals and the unknown list; squads count like troops', () => {
    // 10 Barbarians, 1 Ice Wizard (seasonal), 2 Barb Squads; 1 Rage.
    const u = attackUsage(parseArmyCode('u10x0-1x30-2x195s1x2'), cat);
    expect(u.unknown).toEqual([]);
    expect(u.seasonal).toEqual([4000030]);
    expect(u.units.has(4000030)).toBe(false);
    const barb = d.byId.get('barbarian')!.housingSpace!;
    const total = 10 * barb + 2 * 3;
    expect(u.shares.get(4000000)).toBeCloseTo((10 * barb) / total);
    expect(u.shares.get(4000195)).toBeCloseTo(6 / total);

    const r = aggregate([row('u10x0-1x30-2x195s1x2')], cat, { nowMs: Date.parse('2026-09-21T00:00:00Z'), windowDays: 14, halfLifeDays: 5 });
    expect(r.meta.units['4000195']).toMatchObject({ name: 'Barb Squad', kind: 'troop' });
    expect(r.meta.units['4000030']).toBeUndefined();
    expect(Object.values(r.meta.units).some((x) => x.name.startsWith('Unknown'))).toBe(false);
    expect([...r.seasonal]).toEqual([[4000030, { name: 'Ice Wizard', attacks: 1 }]]);
    expect(r.unknown.size).toBe(0);
  });
});

// ── Lab score with squads, on the real data with a synthetic squad table and meta ──
const squad = [...data.items.values()].find((i) => i.squad && i.levels.length >= 2 && levelInfo(i, 2)?.thRequired !== undefined)!;
const barb = data.byId.get('barbarian')!;
const archer = data.byId.get('archer')!;
/** The real data with a squads table naming `squad` = 15 Barbarian + 15 Archer (or no counts). */
const dataWith = (counts = true): GameData => ({
  ...data,
  squads: resolveSquads(data, { [squad.id]: { troops: [{ id: 'barbarian', ...(counts ? { count: 15 } : {}) }, { id: 'archer', ...(counts ? { count: 15 } : {}) }] } }).squads,
});
const unit = (name: string, usage: number, armyShare?: number) => ({ name, usage, threeStarRate: 0.5, kind: 'troop' as const, ...(armyShare !== undefined ? { armyShare } : {}) });
const metaOf = (squadShare?: number): MetaFile =>
  coerceMeta({
    generatedAt: '2026-09-20T00:00:00Z',
    attacks: 1000,
    players: 100,
    units: { [barb.dataId]: unit('Barbarian', 0.5, 0.02), [archer.dataId]: unit('Archer', 0.6, 0.03), [squad.dataId]: unit(squad.name, 0.1, squadShare) },
  });
const fracOf = (t: Item) => (15 * t.housingSpace!) / (15 * barb.housingSpace! + 15 * archer.housingSpace!);

describe('lab score: a squad’s share counts toward its troops', () => {
  it('troop score = own share + squad share × the troop’s share of the squad (count × housing)', () => {
    const d = dataWith();
    const s = metaStats(metaOf(0.04), barb.dataId, squadPartsFor(d, barb.dataId));
    expect(s.score).toBeCloseTo(0.02 + 0.04 * fracOf(barb));
    expect(s.scoreKind).toBe('armyShare');
    expect(s.usage).toBeCloseTo(0.6); // the squad's attacks use the troop too
    expect(s.squads).toEqual([{ name: squad.name, usage: 0.1, fraction: fracOf(barb), armyShare: 0.04, credited: 0.04 * fracOf(barb) }]);
    // Without the squad credit (the old rule) the score is the troop's own share.
    expect(metaStats(metaOf(0.04), barb.dataId).score).toBe(0.02);
  });

  it('unknown counts split the squad equally', () => {
    const d = dataWith(false);
    expect(metaStats(metaOf(0.04), archer.dataId, squadPartsFor(d, archer.dataId)).score).toBeCloseTo(0.03 + 0.02);
  });

  it('a squad with no housing space (no army share) adds usage only and keeps the troop on army share', () => {
    const d = dataWith();
    const s = metaStats(metaOf(undefined), barb.dataId, squadPartsFor(d, barb.dataId));
    expect(s.score).toBe(0.02);
    expect(s.scoreKind).toBe('armyShare');
    expect(s.squads[0].credited).toBeUndefined();
  });

  it('the squad itself keeps its own score', () => {
    expect(metaStats(metaOf(0.04), squad.dataId, squadPartsFor(dataWith(), squad.dataId)).score).toBe(0.04);
  });
});

describe('squad upgrades are lab items, eligible only where the data allows', () => {
  const lvl2 = levelInfo(squad, 2)!;
  const stateOf = (a: AccountState): EngineState => ({ instances: a.instances, busy: new Set(a.instances.filter((i) => i.upgradingTo !== undefined).map((i) => i.parentUid ?? i.uid)) });
  const account = (th: number) => {
    const ex = maxLab(makeExport(th, th));
    ex.units.push({ data: squad.dataId, lvl: 1 });
    return parse(ex);
  };

  it(`level 2 is offered at TH${lvl2.thRequired} (with the lab it needs), ranked by its own score`, () => {
    const a = account(lvl2.thRequired!);
    const lab = researchCandidates(dataWith(), stateOf(a), 'lab', settings(), metaOf(0.04), 0);
    const c = lab.find((x) => x.item.dataId === squad.dataId);
    expect(c, 'squad candidate').toBeDefined();
    expect(c).toMatchObject({ toLevel: 2, labKind: 'troop', score: 0.04 });
    expect(c!.squads).toBeUndefined();
  });

  it(`level 2 is not offered below TH${lvl2.thRequired}`, () => {
    const a = account(lvl2.thRequired! - 1);
    const lab = researchCandidates(dataWith(), stateOf(a), 'lab', settings(), metaOf(0.04), 0);
    expect(lab.some((x) => x.item.dataId === squad.dataId)).toBe(false);
  });

  it('a troop’s reason and Lab tab row say "incl. squads" when a squad adds to its score', () => {
    const d = dataWith();
    const a = account(lvl2.thRequired!);
    const plan = buildPlan(d, a, settings(), metaOf(0.04), T0);
    const b = plan.lab.find((x) => x.item.dataId === barb.dataId)!;
    expect(b.score).toBeCloseTo(0.02 + 0.04 * fracOf(barb));
    expect(b.reason).toContain(`incl. squads`);
    expect(b.reason).toContain(squad.name);
    const html = renderLab(plan, metaOf(0.04), (id) => id);
    expect(html).toContain('incl. squads');
    // A squad without an army share contributes nothing to the score: no line.
    const plain = buildPlan(d, a, settings(), metaOf(undefined), T0);
    expect(plain.lab.find((x) => x.item.dataId === barb.dataId)!.reason).not.toContain('incl. squads');
    expect(renderLab(plain, metaOf(undefined), (id) => id)).not.toContain('incl. squads');
  });
});
