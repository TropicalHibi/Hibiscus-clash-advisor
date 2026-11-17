// clash-of-clans-data in the browser: the backup source only (SPEC §3.1). Imported dynamically by
// loadBrowser.ts, so Vite puts these JSON files in their own chunk that is fetched only when needed.
import { normalize, type RawFile } from './normalize';
import type { OverrideTexts } from './overrides';
import type { GameData } from './types';

const modules = import.meta.glob('/node_modules/clash-of-clans-data/data/home/{town-hall,defenses,army-buildings,resource-buildings,traps,walls,heroes,troops,spells,siege-machines,pets,hero-equipment,crafted-defenses,guardians,other}/**/*.json', {
  eager: true,
  import: 'default',
});

const pkgVersion = Object.values(import.meta.glob('/node_modules/clash-of-clans-data/package.json', { eager: true, import: 'version' }))[0] as string | undefined;

export function loadCocDataBrowser(t: OverrideTexts): GameData {
  const files: RawFile[] = Object.entries(modules).map(([p, json]) => ({ path: p.replace(/^.*\/data\/home\//, ''), json }));
  return normalize(files, t.merges, pkgVersion ?? 'unknown', t.ids, t.superTroops);
}
