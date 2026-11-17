// Unknown level-1 equipment = likely unreleased: an info note (Import tab, CLI), not a Plan-tab warning.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPlan } from '../src/engine/plan';
import { planToText } from '../src/engine/planText';
import { EMPTY_META } from '../src/meta/meta';
import { isLikelyUnreleased, parseExport, unreleasedNote } from '../src/state/parseExport';
import { data, settings, T0 } from './helpers';

const fixture = () => JSON.parse(fs.readFileSync(new URL('./fixtures/export-th16.json', import.meta.url), 'utf8'));
const planOf = (ex: unknown) => buildPlan(data, parseExport(JSON.stringify(ex), data), settings(), EMPTY_META, T0);
const unknownWarnings = (w: string[], id: number) => w.filter((x) => x.includes(`Unknown dataId ${id}`));

describe('unknown equipment at level 1 (likely unreleased)', () => {
  it('is listed once as "Unrecognized items (likely unreleased)", not as a warning', () => {
    const ex = fixture();
    ex.equipment.push({ data: 90000098, lvl: 1 }, { data: 90000099, lvl: 1 });
    const acct = parseExport(JSON.stringify(ex), data);
    expect(acct.unresolved.filter(isLikelyUnreleased).map((u) => u.dataId)).toEqual([90000098, 90000099]);
    expect(unreleasedNote(acct.unresolved)).toBe('equipment 90000098 (level 1), equipment 90000099 (level 1)');
    const plan = planOf(ex);
    expect(unknownWarnings(plan.warnings, 90000098)).toEqual([]);
    expect(unknownWarnings(plan.warnings, 90000099)).toEqual([]);
    expect(plan.unrecognized).toBe('equipment 90000098 (level 1), equipment 90000099 (level 1)');
    const text = planToText(plan);
    expect(text.match(/Unrecognized items \(likely unreleased\)/g)).toHaveLength(1);
    expect(text).toContain('Unrecognized items (likely unreleased): equipment 90000098 (level 1), equipment 90000099 (level 1)');
    // The fixture's planted unknown helper (level 1, not equipment) still warns.
    expect(unknownWarnings(plan.warnings, 93000099)).toHaveLength(1);
  });

  it('unknown equipment above level 1, and unknown buildings / units / heroes at any level, still warn', () => {
    const ex = fixture();
    ex.equipment.push({ data: 90000097, lvl: 2 });
    ex.buildings.push({ data: 1000999, lvl: 1 });
    ex.units.push({ data: 4000999, lvl: 1 });
    ex.heroes.push({ data: 28000099, lvl: 1 });
    const plan = planOf(ex);
    for (const id of [90000097, 1000999, 4000999, 28000099]) expect(unknownWarnings(plan.warnings, id)).toHaveLength(1);
    expect(plan.unrecognized).toBe('');
    expect(planToText(plan)).not.toContain('Unrecognized items');
  });
});
