// Facts about TODAY's pinned data (ClashKing v0.1.20, 16 Nov 2026), kept as a record so a data update shows what
// changed. They are not rules: a rule test computes its expectation from the data (or uses modifiedData / a fixture).
// `npm test` runs this file; the daily data-update Action, the Pages workflow and `npm run test:mutated` don't
// (`npm run test:ci`), so a new ClashKing level or TH never blocks the live site (REVIEW-2 #1, SPEC §9b, §15).
// When a data update changes one of these, update the number here.
import { describe, expect, it } from 'vitest';
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
});
