// Snapshot + diff step of `npm run sync` (SPEC §9). File access is injected so every branch is testable.
// Snapshots (data/snapshots/<date>_<version>.json) are git-ignored; the newest KEEP_SNAPSHOTS stay on disk.
// The latest diff goes to public/data-changes.json (committed: the site's "Game data updated" banner).
import { diffSnapshots, snapshotFileName, type DataChange, type DataChangesFile, type Snapshot } from '../../src/data/snapshot';
import { versionSlug } from '../../src/data/source';

/** Snapshots kept locally: the current one and the one it was compared with. */
export const KEEP_SNAPSHOTS = 2;
/** Lines of changes printed by sync (all of them are saved to public/data-changes.json). */
export const MAX_PRINTED_CHANGES = 200;

export interface SnapshotIO {
  list(): string[];
  read(name: string): Snapshot;
  write(name: string, s: Snapshot): void;
  remove(name: string): void;
  writeChanges(f: DataChangesFile): void;
}

export interface SnapshotResult {
  file: string;
  written: boolean;
  previous?: string;
  changes?: DataChange[];
}

const SNAPSHOT_RE = /^(\d{4}-\d{2}-\d{2})_(.+)\.json$/;
const versionOf = (f: string) => SNAPSHOT_RE.exec(f)?.[2];

/** Local date as YYYY-MM-DD. */
export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Writes the snapshot for this data version (once per version), diffs it against the newest snapshot of
 * another version, prints the changes and saves them for the site. Older snapshots beyond KEEP_SNAPSHOTS
 * are removed.
 */
export function recordSnapshot(io: SnapshotIO, snap: Snapshot, log: (line: string) => void): SnapshotResult {
  const files = io
    .list()
    .filter((f) => SNAPSHOT_RE.test(f))
    .sort();
  const slug = versionSlug(snap.version);
  const same = files.find((f) => versionOf(f) === slug);
  if (same) {
    log(`Snapshot for ${snap.version} already recorded (data/snapshots/${same}).`);
    return { file: same, written: false };
  }
  const name = snapshotFileName(snap);
  io.write(name, snap);
  log(`Snapshot written: data/snapshots/${name}`);
  const prevFile = files.filter((f) => versionOf(f) !== slug).at(-1);
  let result: SnapshotResult = { file: name, written: true };
  if (!prevFile) log('No earlier snapshot to compare with (first snapshot); the next data update will print a diff.');
  else {
    const prev = io.read(prevFile);
    const changes = diffSnapshots(prev, snap);
    log(`Game data changes ${prev.version} → ${snap.version}: ${changes.length}`);
    for (const c of changes.slice(0, MAX_PRINTED_CHANGES)) log(`  ${c.text}`);
    if (changes.length > MAX_PRINTED_CHANGES) log(`  … and ${changes.length - MAX_PRINTED_CHANGES} more (all in public/data-changes.json)`);
    if (prev.maxTH !== snap.maxTH) log(`Max TH changed: ${prev.maxTH} → ${snap.maxTH}. Mode may flip to rush.`);
    io.writeChanges({ version: snap.version, previousVersion: prev.version, date: snap.date, changes });
    log('Saved to public/data-changes.json. Commit it with package.json / package-lock.json so the live site shows the banner.');
    result = { ...result, previous: prevFile, changes };
  }
  const all = [...new Set([...files, name])].sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_SNAPSHOTS))) io.remove(f);
  return result;
}
