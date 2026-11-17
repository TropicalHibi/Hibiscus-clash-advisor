// Browser-side loader. Bundles the pinned ClashKing copy (data/clashking/) and clash-of-clans-data's
// town-hall.json (TH weapons). The full clash-of-clans-data set is a separate chunk, fetched only when the
// ClashKing copy is missing or can't be loaded (backup, with a visible warning).
import { assertClashKingShape, normalizeClashKing } from './clashking';
import { cocTownHallWeapons } from './normalize';
import { EMPTY_OVERRIDES, loadWithOverrides, parseOverrides } from './overrides';
import { backupWarning, pinVersion, type ClashKingPin } from './source';
import type { GameData } from './types';
import mergesYaml from '../../config/merges.yaml?raw';
import superTroopsYaml from '../../config/super-troops.yaml?raw';
import idOverridesYaml from '../../config/id-overrides.yaml?raw';

// Globs, so a missing file is an empty result (→ backup) rather than a build error.
const ckFiles = import.meta.glob('/data/clashking/{static_data,pin}.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const thFiles = import.meta.glob('/node_modules/clash-of-clans-data/data/home/town-hall/town-hall.json', { eager: true, import: 'default' }) as Record<string, unknown>;

const texts = { merges: mergesYaml, superTroops: superTroopsYaml, ids: idOverridesYaml };

export async function loadGameDataBrowser(): Promise<GameData> {
  const raw = ckFiles['/data/clashking/static_data.json'];
  const pin = ckFiles['/data/clashking/pin.json'] as ClashKingPin | undefined;
  let reason = 'data/clashking/static_data.json is missing';
  if (raw && pin) {
    try {
      assertClashKingShape(raw);
      const th = Object.values(thFiles)[0];
      const weapons = th ? cocTownHallWeapons(th) : [];
      // An override-file problem is an override warning (data loads without them), not a reason for the backup.
      return loadWithOverrides((use) => normalizeClashKing(raw, { version: pinVersion(pin), overrides: use ? parseOverrides(texts) : EMPTY_OVERRIDES, weapons }));
    } catch (e) {
      reason = `the pinned ClashKing data can't be loaded (${(e as Error).message})`;
    }
  }
  const { loadCocDataBrowser } = await import('./cocBackupBrowser');
  const coc = loadCocDataBrowser(texts);
  coc.warnings.unshift(backupWarning(reason));
  return coc;
}
