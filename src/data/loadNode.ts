// Node-side loader (scripts + tests). Game data comes from the pinned ClashKing copy in data/clashking/
// (SPEC §3.1); clash-of-clans-data (node_modules) supplies item images, TH weapons, and is the backup source
// when there's no usable ClashKing copy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertClashKingShape, normalizeClashKing, type ClashKingRaw } from './clashking.ts';
import { DATA_FOLDERS, cocTownHallWeapons, imageCandidates, normalize, type RawFile } from './normalize.ts';
import { EMPTY_OVERRIDES, loadWithOverrides, parseOverrides, type OverrideTexts } from './overrides.ts';
import { backupWarning, pinVersion, type ClashKingPin } from './source.ts';
import type { GameData, Item } from './types';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..', '..');
export const PKG_DIR = path.join(PROJECT_ROOT, 'node_modules', 'clash-of-clans-data');
/**
 * The pinned ClashKing copy: static_data.json (trimmed) + pin.json (release / commit / sha256).
 * `CK_DATA_DIR` points it elsewhere: only `npm run test:mutated` sets it (the suite on a mutated copy, SPEC §13).
 */
export const CK_DIR = process.env.CK_DATA_DIR ? path.resolve(process.env.CK_DATA_DIR) : path.join(PROJECT_ROOT, 'data', 'clashking');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.json') ? [p] : [];
  });
}

/** clash-of-clans-data JSON files (images, TH weapons, backup). */
export function readRawFiles(): RawFile[] {
  const home = path.join(PKG_DIR, 'data', 'home');
  const files: RawFile[] = [];
  for (const folder of DATA_FOLDERS) {
    for (const f of walk(path.join(home, folder))) {
      files.push({ path: path.relative(home, f).split(path.sep).join('/'), json: JSON.parse(fs.readFileSync(f, 'utf8')) });
    }
  }
  return files;
}

/** Installed clash-of-clans-data version. */
export function dataVersion(): string {
  return JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version;
}

export function readConfig(name: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, 'config', name), 'utf8');
}

const readConfigIf = (name: string): string | undefined => {
  try {
    return readConfig(name);
  } catch {
    return undefined;
  }
};

/** The three optional override files (SPEC §12); missing files count as empty. */
export function readOverrideTexts(): OverrideTexts {
  return { merges: readConfigIf('merges.yaml'), superTroops: readConfigIf('super-troops.yaml'), ids: readConfigIf('id-overrides.yaml') };
}

/** The pinned ClashKing copy, or undefined when it's missing or unreadable. */
export function readClashKing(dir = CK_DIR): { raw: ClashKingRaw; pin: ClashKingPin } | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'static_data.json'), 'utf8'));
    const pin = JSON.parse(fs.readFileSync(path.join(dir, 'pin.json'), 'utf8')) as ClashKingPin;
    assertClashKingShape(raw);
    return { raw, pin };
  } catch {
    return undefined;
  }
}

/** Images (clash-of-clans-data paths) by item id and by dataId; ClashKing items look up id first. */
export function cocImageIndex(files: RawFile[]): (id: string, dataId: number) => string[] | undefined {
  const byId = new Map<string, string[]>();
  const byDataId = new Map<number, string[]>();
  for (const f of files) {
    const j = f.json;
    if (!j || typeof j !== 'object') continue;
    const imgs = imageCandidates(j);
    if (!imgs.length) continue;
    if (typeof j.id === 'string' && !byId.has(j.id)) byId.set(j.id, imgs);
    if (typeof j.dataId === 'number' && !byDataId.has(j.dataId)) byDataId.set(j.dataId, imgs);
  }
  return (id, dataId) => byId.get(id) ?? byDataId.get(dataId);
}

/** TH weapons from clash-of-clans-data (ClashKing has none). */
export function cocWeapons(files: RawFile[]): Item[] {
  const th = files.find((f) => f.path.startsWith('town-hall/'))?.json;
  return th ? cocTownHallWeapons(th) : [];
}

/** Normalizes ClashKing raw data the way the site does, with images and TH weapons from clash-of-clans-data. */
export function normalizeClashKingNode(raw: ClashKingRaw, version: string, texts: OverrideTexts = readOverrideTexts()): GameData {
  let files: RawFile[] = [];
  try {
    files = readRawFiles();
  } catch {
    files = [];
  }
  const weapons = cocWeapons(files);
  const images = cocImageIndex(files);
  // An override-file problem is reported as such (the data loads without the overrides), never as bad ClashKing data.
  return loadWithOverrides((use) => normalizeClashKing(raw, { version, overrides: use ? parseOverrides(texts) : EMPTY_OVERRIDES, weapons, images, squads: readConfigIf('squads.yaml') }));
}

/** clash-of-clans-data normalized (the backup source), with the optional overrides. */
export function loadCocDataFresh(): GameData {
  const t = readOverrideTexts();
  const files = readRawFiles();
  return loadWithOverrides((use) => (use ? normalize(files, t.merges, dataVersion(), t.ids, t.superTroops) : normalize(files, undefined, dataVersion())));
}

/**
 * The active game data (no cache): the pinned ClashKing copy; clash-of-clans-data with a visible warning
 * when there's no usable ClashKing copy.
 */
export function loadGameDataFresh(dir = CK_DIR): GameData {
  const ck = readClashKing(dir);
  let reason = 'data/clashking/static_data.json is missing or unreadable';
  if (ck) {
    try {
      return normalizeClashKingNode(ck.raw, pinVersion(ck.pin));
    } catch (e) {
      reason = `the pinned ClashKing data can't be loaded (${(e as Error).message})`;
    }
  }
  const coc = loadCocDataFresh();
  coc.warnings.unshift(backupWarning(reason));
  return coc;
}

let cached: GameData | undefined;
export function loadGameDataNode(): GameData {
  if (!cached) cached = loadGameDataFresh(CK_DIR);
  return cached;
}
