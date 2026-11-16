// Node-side loader (scripts + tests). Reads JSON straight from the installed package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_FOLDERS, normalize, type RawFile } from './normalize.ts';
import type { GameData } from './types';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..', '..');
export const PKG_DIR = path.join(PROJECT_ROOT, 'node_modules', 'clash-of-clans-data');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.json') ? [p] : [];
  });
}

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

export function dataVersion(): string {
  return JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version;
}

export function readConfig(name: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, 'config', name), 'utf8');
}

/** config/id-overrides.yaml, or undefined when the file is absent. */
export function readIdOverrides(): string | undefined {
  try {
    return readConfig('id-overrides.yaml');
  } catch {
    return undefined;
  }
}

/** Normalizes the installed package from disk (no cache). */
export function loadGameDataFresh(): GameData {
  return normalize(readRawFiles(), readConfig('merges.yaml'), dataVersion(), readIdOverrides());
}

let cached: GameData | undefined;
export function loadGameDataNode(): GameData {
  if (!cached) cached = loadGameDataFresh();
  return cached;
}
