// One-off generator for tests/fixtures/export-th16.json (run: npx tsx tests/makeFixture.ts).
import fs from 'node:fs';
import { data, makeExport, setLevel } from './helpers';

const ex = makeExport(16, 15);
for (const [id, hours] of [['barbarian-king', 3], ['grand-warden', 20]] as const) {
  const h = ex.heroes.find((e) => e.data === data.byId.get(id)!.dataId)!;
  h.lvl -= 1; // running upgrade ends at the Hero Hall cap
  h.timer = hours * 3600;
}
setLevel(ex, 'buildings', 'x-bow', { timer: 30 * 3600, cnt: 1 });
ex.buildings.push({ data: 1000021, lvl: ex.buildings.find((b) => b.data === 1000021)!.lvl, cnt: 3 });
setLevel(ex, 'buildings', 'gold-mine', { timer: 5 * 3600, extra: true, cnt: 1 });
ex.buildings.push({ data: 1000004, lvl: ex.buildings.find((b) => b.data === 1000004)!.lvl, cnt: 6 });
setLevel(ex, 'units', 'balloon', { timer: 2 * 86400 });
ex.helpers.push({ data: 93000099, lvl: 1 }); // unknown id: must be reported, not crash
fs.writeFileSync(new URL('./fixtures/export-th16.json', import.meta.url), JSON.stringify(ex, null, 2));
console.log('wrote fixture', ex.buildings.length, 'building entries');
