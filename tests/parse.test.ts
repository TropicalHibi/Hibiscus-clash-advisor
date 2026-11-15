import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadGameDataBrowser } from '../src/data/loadBrowser';
import { parseExport, ExportParseError } from '../src/state/parseExport';
import { data, T0 } from './helpers';

const fixtureText = fs.readFileSync(new URL('./fixtures/export-th16.json', import.meta.url), 'utf8');

describe('export parsing', () => {
  const acct = parseExport(fixtureText, data);

  it('reads top-level fields and key building levels', () => {
    expect(acct.tag).toBe('#TEST');
    expect(acct.exportTimestamp).toBe(T0);
    expect(acct.townHall).toBe(16);
    expect(acct.heroHall).toBeGreaterThan(0);
    expect(acct.lab).toBeGreaterThan(0);
  });

  it('counts builders as Builder Huts + B.O.B Hut', () => {
    expect(acct.builders).toBe(6);
  });

  it('expands cnt into instances and keeps timers / goblin flag', () => {
    const xbows = acct.instances.filter((i) => i.dataId === 1000021);
    expect(xbows).toHaveLength(4);
    expect(xbows.filter((x) => x.upgradingTo !== undefined)).toHaveLength(1);
    const xb = xbows.find((x) => x.remainingSec)!;
    expect(xb.upgradingTo).toBe(xb.level + 1);
    expect(xb.remainingSec).toBe(30 * 3600);
    const goblin = acct.instances.filter((i) => i.goblin);
    expect(goblin).toHaveLength(1);
    expect(data.items.get(goblin[0].itemKey)!.id).toBe('gold-mine');
  });

  it('aggregates walls instead of expanding them', () => {
    expect(acct.walls).toEqual([{ level: 16, count: 325 }]);
    expect(acct.instances.some((i) => i.dataId === 1000010)).toBe(false);
  });

  it('ignores Builder Base sections', () => {
    expect(acct.instances.some((i) => i.dataId === 1000033)).toBe(false);
  });

  it('parses the real export shape: Crafting Station types → modules', () => {
    const ex = {
      timestamp: T0,
      buildings: [
        { data: 1000001, lvl: 18 },
        { data: 1000097, types: [{ data: 103000011, modules: [{ data: 102000033, lvl: 2 }, { data: 102000034, lvl: 1, timer: 100 }] }] },
      ],
    };
    const a = parseExport(ex, data);
    const mods = a.instances.filter((i) => i.parentUid === 'cd:103000011');
    expect(mods).toHaveLength(2);
    expect(mods.find((m) => m.dataId === 102000034)!.upgradingTo).toBe(2);
  });

  it('rejects junk with a clear message', () => {
    expect(() => parseExport('not json', data)).toThrow(ExportParseError);
    expect(() => parseExport('{"foo":1}', data)).toThrow(/buildings/);
    expect(() => parseExport('{"buildings":[]}', data)).toThrow(/Town Hall/);
  });
});

describe('dataId join', () => {
  it('resolves every id in the fixture except the planted unknown one', () => {
    const acct = parseExport(fixtureText, data);
    expect(acct.unresolved).toEqual([{ section: 'helpers', dataId: 93000099 }]);
    for (const inst of acct.instances) expect(data.items.has(inst.itemKey)).toBe(true);
  });

  it('joins on dataId, not names (Ricochet Cannon = 1000085)', () => {
    expect(data.byDataId.get(1000085)!.id).toBe('ricochet-cannon');
    expect(data.byDataId.get(1000085)!.category).toBe('mergedDefense');
  });

  it('splits supercharge levels into their own item', () => {
    const mortar = data.byId.get('mortar')!;
    expect(mortar.levels.every((l, i) => l.level === i + 1)).toBe(true);
    const sc = data.items.get(`${mortar.dataId}:sc`)!;
    expect(sc.category).toBe('supercharge');
    expect(sc.levels.map((l) => l.level)).toEqual([1, 2]);
  });

  it('browser loader (import.meta.glob) produces the same data as the Node loader', () => {
    const b = loadGameDataBrowser();
    expect(b.items.size).toBe(data.items.size);
    expect(b.maxTH).toBe(data.maxTH);
    expect(b.bookThresholdSec).toBe(data.bookThresholdSec);
    expect(b.version).toBe(data.version);
  });

  it('real export (if present locally) resolves everything except known helper gaps', () => {
    const p = new URL('../samples/myexport.json', import.meta.url);
    if (!fs.existsSync(p)) return;
    const a = parseExport(fs.readFileSync(p, 'utf8'), data);
    expect(a.unresolved.filter((u) => u.section !== 'helpers')).toEqual([]);
  });
});
