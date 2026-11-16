// Browser-side loader. Vite bundles only the folders we need from the data package.
import { normalize, type RawFile } from './normalize';
import type { GameData } from './types';
import mergesYaml from '../../config/merges.yaml?raw';
import idOverridesYaml from '../../config/id-overrides.yaml?raw';

const modules = import.meta.glob('/node_modules/clash-of-clans-data/data/home/{town-hall,defenses,army-buildings,resource-buildings,traps,walls,heroes,troops,spells,siege-machines,pets,hero-equipment,crafted-defenses,guardians,other}/**/*.json', {
  eager: true,
  import: 'default',
});

const pkgVersion = Object.values(
  import.meta.glob('/node_modules/clash-of-clans-data/package.json', { eager: true, import: 'version' }),
)[0] as string | undefined;

export function loadGameDataBrowser(): GameData {
  const files: RawFile[] = Object.entries(modules).map(([p, json]) => ({
    path: p.replace(/^.*\/data\/home\//, ''),
    json,
  }));
  return normalize(files, mergesYaml, pkgVersion ?? 'unknown', idOverridesYaml);
}
