// Edge cases from REVIEW.md "Missing tests": aggregation window edges, army codes, validation that must
// fail, and browser storage that throws or holds settings from an older version.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/data/loadNode';
import { checkLevels, checkMergeConsumption } from '../src/data/validate';
import { aggregate, attackUsage, buildCatalog, parseSuperTroops, type BattleRow } from '../src/meta/aggregate';
import { parseArmyCode } from '../src/meta/armyCode';
import { coerceSettings, settingsFromYaml } from '../src/state/settings';
import { storage } from '../src/ui/storage';
import { data, modifiedData, rawItem } from './helpers';

const catalog = buildCatalog(data, parseSuperTroops(readConfig('super-troops.yaml')));
const NOW = Date.parse('2026-11-16T12:00:00Z');
const DAY = 86_400_000;
const row = (tag: string, ageMs: number, code: string, stars = 3): BattleRow => ({ tag, ts: new Date(NOW - ageMs).toISOString(), stars, destruction: 100, armyShareCode: code });
const opts = { nowMs: NOW, windowDays: 14, halfLifeDays: 5 };

describe('aggregation edges', () => {
  it('a row exactly 14 days old is in the window; one second older is not', () => {
    expect(aggregate([row('#A', 14 * DAY, 'u1x0')], catalog, opts).meta.attacks).toBe(1);
    expect(aggregate([row('#A', 14 * DAY + 1000, 'u1x0')], catalog, opts).meta.attacks).toBe(0);
  });

  it('empty armies are counted separately and left out of the attack total', () => {
    const res = aggregate([row('#A', DAY, ''), row('#B', DAY, 'zzz'), row('#C', DAY, 'u5x0')], catalog, opts);
    expect(res.emptyArmies).toBe(2);
    expect(res.meta.attacks).toBe(1);
    expect(res.meta.units['4000000'].usage).toBe(1);
  });

  it('future timestamps weigh 1 (like "now")', () => {
    const res = aggregate([row('#A', -DAY, 'u1x0'), row('#B', 5 * DAY, 's1x2')], catalog, opts);
    // Barbarian weight 1, Rage weight ½ → usage 1/1.5 and 0.5/1.5.
    expect(res.meta.units['4000000'].usage).toBeCloseTo(1 / 1.5, 4);
    expect(res.meta.units['26000002'].usage).toBeCloseTo(0.5 / 1.5, 4);
  });

  it('a siege in both the home army and the Clan Castle counts once', () => {
    const u = attackUsage(parseArmyCode('u1x51-10x0i1x51'), catalog);
    expect(u.units.get(4000051)).toBe(1);
    expect(u.shares.has(4000051)).toBe(false); // sieges never enter the troop-space share
  });
});

describe('army code edges', () => {
  it('URL-encoded payloads are decoded', () => {
    const r = parseArmyCode('https://link.clashofclans.com/en?action=CopyArmy&army=u10x0%2D5x1s2x2');
    expect(r.troops).toEqual([
      { id: 4000000, qty: 10 },
      { id: 4000001, qty: 5 },
    ]);
    expect(r.spells).toEqual([{ id: 26000002, qty: 2 }]);
  });

  it('repeated sections are merged in order', () => {
    const r = parseArmyCode('u1x0s1x2u2x1');
    expect(r.troops.map((t) => t.id)).toEqual([4000000, 4000001]);
    expect(r.spells).toHaveLength(1);
  });
});

describe('validation must fail on broken data', () => {
  it('merge consumption: a missing recipe is an error', () => {
    const d = modifiedData(() => {}, readConfig('merges.yaml').replace(/  super-wizard-tower:[\s\S]*$/, ''));
    const issues = checkMergeConsumption(d);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.level === 'error')).toBe(true);
    expect(issues.some((i) => i.message.includes('Wizard Tower'))).toBe(true);
  });

  it('levels: a gap is an error', () => {
    const d = modifiedData((f) => {
      const cannon = rawItem(f, 'cannon');
      cannon.levels = cannon.levels.filter((l: { level: number }) => l.level !== 5);
    });
    expect(checkLevels(d).some((i) => i.level === 'error' && i.message.includes('Cannon'))).toBe(true);
  });

  it('an unknown cost resource is reported as a data warning', () => {
    const d = modifiedData((f) => {
      rawItem(f, 'cannon').levels[0].buildCostResource = 'Mithril';
    });
    expect(d.warnings.some((w) => w.includes('Mithril'))).toBe(true);
    expect(data.warnings).toEqual([]);
  });
});

describe('browser storage', () => {
  afterEach(() => vi.unstubAllGlobals());
  const DEFAULTS = settingsFromYaml(readConfig('settings.sample.yaml'));

  it('a localStorage that throws: reads fall back to defaults, saves report failure, nothing throws', () => {
    const boom = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
    expect(storage.loadSettings(DEFAULTS)).toBe(DEFAULTS);
    expect(storage.loadExport()).toBeNull();
    expect(storage.saveExport('{}', 1)).toBe(false);
    expect(() => storage.clearExport()).not.toThrow();
    expect(() => storage.saveSettings(DEFAULTS)).not.toThrow();
  });

  it('settings saved before lab.kindWeights existed keep the YAML weights, not hard-coded ones', () => {
    const map = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) });
    map.set('cocPlanner.settings', JSON.stringify({ goldPass: 'max', lab: { pinned: ['dragon'] } }));
    const yamlDefaults = coerceSettings({ ...DEFAULTS, lab: { ...DEFAULTS.lab, kindWeights: { troop: 1, spell: 0.9, siege: 0.2 } } });
    const s = storage.loadSettings(yamlDefaults);
    expect(s.goldPass).toBe('max');
    expect(s.lab.pinned).toEqual(['dragon']);
    expect(s.lab.kindWeights).toEqual({ troop: 1, spell: 0.9, siege: 0.2 });
  });
});
