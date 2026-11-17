// Which game data the planner runs on (SPEC §3.1): the pinned ClashKing copy, or clash-of-clans-data as backup.
import type { GameData } from './types.ts';

/** data/clashking/pin.json: exactly which ClashKing file is pinned. */
export interface ClashKingPin {
  repo: string;
  /** Release tag, or "main" when no release had the file. */
  ref: string;
  tag?: string;
  /** Full commit sha the file was downloaded at. */
  commit: string;
  path: string;
  /** sha256 of the downloaded (untrimmed) file. */
  sha256: string;
  /** GameData.version, e.g. "clashking-v0.1.20" or "clashking-main-04babd0". */
  version: string;
  fetchedAt: string;
  maxTH: number;
  items: number;
}

/** GameData.version for a ClashKing release tag or a main commit. */
export const clashKingVersion = (ref: { tag?: string; commit: string }) => (ref.tag ? `clashking-${ref.tag}` : `clashking-main-${ref.commit.slice(0, 7)}`);

/** Footer / CLI label: "ClashKing v0.1.20" or "clash-of-clans-data 0.19.1 (backup)". */
export function dataSourceLabel(d: Pick<GameData, 'source' | 'version'>): string {
  if (d.source === 'clashking') return d.version.replace(/^clashking-main-/, 'ClashKing main@').replace(/^clashking-/, 'ClashKing ');
  return `clash-of-clans-data ${d.version} (backup)`;
}

/** The warning shown on the Plan tab and by sync whenever the backup source is in use. */
export const backupWarning = (reason: string) =>
  `Game data: using the clash-of-clans-data backup because ${reason}. Costs and times may be out of date; run npm run sync.`;
