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
  /** GameData.version (the data identity, tag + commit): "clashking-v0.1.20+04babd0" or "clashking-main-04babd0". */
  version: string;
  fetchedAt: string;
  maxTH: number;
  items: number;
}

/** A release tag usable in a version / file name. Anything else (a `/`, a quote, …) is treated as no tag (REVIEW-2 #9). */
export const SAFE_TAG = /^[A-Za-z0-9._-]+$/;
export const isSafeTag = (tag: string | undefined): tag is string => !!tag && SAFE_TAG.test(tag);

/**
 * GameData.version — the data identity (SPEC §3.1, §9): release tag + commit, "clashking-v0.1.20+04babd0", so a
 * re-pointed tag or a re-uploaded file is a new version with its own snapshot and diff (REVIEW-2 #5). No (or an
 * unsafe) tag: "clashking-main-<sha7>". The UI shows only the tag (versionLabel).
 */
export const clashKingVersion = (ref: { tag?: string; commit: string }) =>
  isSafeTag(ref.tag) ? `clashking-${ref.tag}+${ref.commit.slice(0, 7)}` : `clashking-main-${ref.commit.slice(0, 7)}`;

/** The version of a pinned copy, derived from its tag + commit (pins written before REVIEW-2 stored the tag only). */
export const pinVersion = (pin: Pick<ClashKingPin, 'tag' | 'commit' | 'version'>) => (pin.commit ? clashKingVersion(pin) : pin.version);

/** A version as shown to people: "ClashKing v0.1.20" (no commit), "ClashKing main@04babd0", "clash-of-clans-data 0.19.1". */
export function versionLabel(v: string): string {
  if (v.startsWith('clashking-main-')) return `ClashKing main@${v.slice('clashking-main-'.length)}`;
  if (v.startsWith('clashking-')) return `ClashKing ${v.slice('clashking-'.length).replace(/\+[0-9a-f]+$/, '')}`;
  return `clash-of-clans-data ${v}`;
}

/** A version as a file-name part (snapshots): anything outside [A-Za-z0-9._+-] becomes "-". */
export const versionSlug = (v: string) => v.replace(/[^A-Za-z0-9._+-]/g, '-');

/** Footer / CLI label: "ClashKing v0.1.20" or "clash-of-clans-data 0.19.1 (backup)". */
export function dataSourceLabel(d: Pick<GameData, 'source' | 'version'>): string {
  return d.source === 'clashking' ? versionLabel(d.version) : `clash-of-clans-data ${d.version} (backup)`;
}

/** The warning shown on the Plan tab and by sync whenever the backup source is in use. */
export const backupWarning = (reason: string) =>
  `Game data: using the clash-of-clans-data backup because ${reason}. Costs and times may be out of date; run npm run sync.`;
