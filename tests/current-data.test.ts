// Facts about TODAY's pinned data (ClashKing v0.1.20, 16 Nov 2026), kept as a record so a data update shows what
// changed. They are not rules: a rule test computes its expectation from the data (or uses modifiedData / a fixture).
// `npm test` runs this file; the daily data-update Action, the Pages workflow and `npm run test:mutated` don't
// (`npm run test:ci`), so a new ClashKing level or TH never blocks the live site (REVIEW-2 #1, SPEC §9b, §15).
// When a data update changes one of these, update the number here.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { checkSquads } from '../src/data/validate';
import { heroCapAt } from '../src/engine/book';
import { data } from './helpers';

describe('current data (ClashKing v0.1.20)', () => {
  it('max TH is 19', () => {
    expect(data.maxTH).toBe(19);
  });

  it('the hero book threshold is 8 days', () => {
    expect(data.bookThresholdSec).toBe(8 * 86400);
  });

  it('Archer Queen caps: 110 at Hero Hall 12, 115 at Hero Hall 13', () => {
    const aq = data.byId.get('archer-queen')!;
    expect(heroCapAt(aq, 12)).toBe(110);
    expect(heroCapAt(aq, 13)).toBe(115);
  });

  it('Cannon tops out at level 21 and its image is level-21', () => {
    const cannon = data.byId.get('cannon')!;
    expect(cannon.levels[cannon.levels.length - 1].level).toBe(21);
    expect(cannon.images![0]).toContain('level-21.png');
  });

  it('12 squads, every one mapped in config/squads.yaml (Barch = 15 Barbarian + 15 Archer, half each)', () => {
    const squads = [...data.byDataId.values()].filter((i) => i.squad);
    expect(squads.map((i) => i.dataId)).toEqual(Array.from({ length: 12 }, (_, i) => 4000195 + i));
    expect(checkSquads(data)).toEqual([]);
    expect(Object.keys(data.squads!).length).toBe(12);
    const barch = data.squads![4000195];
    expect(barch.troops.map((t) => [t.id, t.count, t.fraction])).toEqual([['barbarian', 15, 0.5], ['archer', 15, 0.5]]);
    expect(data.squads![4000197].troops).toMatchObject([{ id: 'wall-breaker', count: 5, fraction: 1 }]);
    expect(data.squads![4000204].troops.map((t) => t.id)).toEqual(['pekka', 'electro-titan']);
  });

  it('public/meta.json names every squad (no "Unknown troop") and has no seasonal unit', () => {
    const meta = JSON.parse(fs.readFileSync(new URL('../public/meta.json', import.meta.url), 'utf8'));
    for (let id = 4000195; id <= 4000206; id++) if (meta.units[id]) expect(meta.units[id].name).toBe(data.byDataId.get(id)!.name);
    for (const [id, u] of Object.entries(meta.units) as [string, { name: string }][]) {
      expect(u.name, id).not.toMatch(/^Unknown/);
      expect(data.byDataId.get(Number(id))?.seasonal, u.name).toBeFalsy();
    }
  });
});
