// Daily game-data update (GitHub Action, SPEC §9b). Same code as `npm run sync`:
//   1. clash-of-clans-data (item images, TH weapons, backup): syncData, newest within the major, known-good restore;
//   2. ClashKing (the game data): syncClashKing, latest clashy.go release at its commit, validated before it's
//      pinned; a file that fails keeps the previous copy;
//   3. snapshot before + after the active data, diff → public/data-changes.json, cross-check report.
// One stricter rule for unattended deploys: a merge the recipes don't explain fails the update.
// Side effects are injected so every branch is testable with a fake npm registry / fake GitHub.
import type { DataChange } from '../../src/data/snapshot';
import type { GameData } from '../../src/data/types';
import { checkMergeConsumption, describeMissingMerges, explainMissingMerges } from '../../src/data/validate';
import { syncClashKing, type ClashKingDeps } from './clashking';
import type { SnapshotResult } from './snapshots';
import { syncData, type SyncDeps } from './sync';

export interface DataUpdateDeps {
  /** The clash-of-clans-data deps `npm run sync` uses (real npm in CI, a fake registry in tests). */
  sync: SyncDeps;
  /** The ClashKing stage (real GitHub in CI, a fake in tests). Without it, clash-of-clans-data is the active data. */
  clashKing?: ClashKingDeps;
  /** The active game data, normalized fresh from disk (after the updates). */
  loadData(): GameData;
  /** Cross-check report lines (ClashKing vs clash-of-clans-data); informational. */
  crossCheck?(): string[];
}

export interface DataUpdateResult {
  /** none = nothing new; updated = ready to commit; failed = commit nothing, open an issue. */
  status: 'none' | 'updated' | 'failed';
  /** clash-of-clans-data versions. */
  from?: string;
  to?: string;
  /** ClashKing versions (when the ClashKing stage ran). */
  clashKingFrom?: string;
  clashKingTo?: string;
  changes: DataChange[];
  /** Which step failed (failed only). */
  failedStep?: string;
  reason?: string;
  /** Plain-language lines naming a merge the recipes don't explain (failed only). */
  missingMerges: string[];
  /** Everything sync printed: versions, validation output, the diff. */
  log: string[];
  /** Cross-check report (ClashKing vs clash-of-clans-data). */
  crossCheck: string[];
  /** Commit message (updated only). */
  commitMessage?: string;
}

export const commitMessage = (from: string, to: string, n: number) => `data: clash-of-clans-data ${from} → ${to} (${n} change${n === 1 ? '' : 's'})`;

/** "data: ClashKing v0.1.20 → v0.1.21, clash-of-clans-data 0.19.1 → 0.20.0 (12 changes)" — only the parts that changed. */
export function fullCommitMessage(p: { ck?: [string | undefined, string]; coc?: [string | undefined, string]; changes: number }): string {
  const short = (v: string | undefined) => (v ?? 'none').replace(/^clashking-/, '');
  const parts = [
    ...(p.ck ? [`ClashKing ${short(p.ck[0])} → ${short(p.ck[1])}`] : []),
    ...(p.coc ? [`clash-of-clans-data ${p.coc[0] ?? 'none'} → ${p.coc[1]}`] : []),
  ];
  return `data: ${parts.join(', ')} (${p.changes} change${p.changes === 1 ? '' : 's'})`;
}

export function runDataUpdate(d: DataUpdateDeps): DataUpdateResult {
  const log: string[] = [];
  let to: string | undefined;
  let failureReason: string | undefined;
  let lastSnapshot: SnapshotResult | undefined;
  const from = d.sync.installedVersion();
  const record = (line: string) => {
    log.push(line);
    d.sync.log(line);
  };
  const recordSnapshot = (r: SnapshotResult | void) => {
    if (r) lastSnapshot = r;
    return r;
  };
  const ckActive = !!d.clashKing;
  const wrapped: SyncDeps = {
    ...d.sync,
    latestInMajor: (major) => (to = d.sync.latestInMajor(major)),
    writeState: (s) => {
      if (s.dataFailure) failureReason = s.dataFailure.reason;
      d.sync.writeState(s);
    },
    // With ClashKing active, clash-of-clans-data isn't the game data: its update makes no snapshot / diff.
    snapshot: ckActive ? undefined : () => recordSnapshot(d.sync.snapshot?.()),
    log: record,
  };
  const base = { from, to: undefined as string | undefined, changes: [] as DataChange[], missingMerges: [] as string[], log, crossCheck: [] as string[] };
  const fail = (failedStep: string, reason: string, extra: Partial<DataUpdateResult> = {}): DataUpdateResult => ({ ...base, to, status: 'failed', failedStep, reason, ...extra });

  if (ckActive) record('— clash-of-clans-data (item images, TH weapons, backup source) —');
  const outcome = syncData(wrapped);
  if (outcome === 'failed') {
    if (to === undefined) return fail('npm registry check', log.find((l) => l.startsWith('npm view failed')) ?? 'npm view failed');
    return fail('install', failureReason ?? log.filter((l) => /failed|can't be used/i.test(l)).at(-1) ?? 'npm install failed');
  }
  if (outcome === 'restored') return fail('load + validate the new data', failureReason ?? 'the new data could not be loaded');
  const cocUpdated = outcome === 'updated';

  let ck: { from?: string; to?: string; updated: boolean } = { updated: false };
  if (d.clashKing) {
    record('— ClashKing (game data) —');
    const r = syncClashKing({ ...d.clashKing, snapshot: () => recordSnapshot(d.clashKing!.snapshot?.()), log: record });
    ck = { from: r.from, to: r.to, updated: r.outcome === 'updated' };
    const ckBase = { clashKingFrom: r.from, clashKingTo: r.to };
    if (r.outcome === 'check-failed') return fail('ClashKing check (GitHub)', r.reason ?? 'GitHub could not be asked', ckBase);
    if (r.outcome === 'download-failed') return fail('ClashKing download', r.reason ?? 'download failed', ckBase);
    if (r.outcome === 'kept-previous') return fail('ClashKing load + validate the new data', r.reason ?? 'the new file could not be used', ckBase);
    if (r.outcome === 'no-copy') return fail('ClashKing: no usable copy', r.reason ?? 'no usable ClashKing copy', ckBase);
  }
  const ckFields = d.clashKing ? { clashKingFrom: ck.from, clashKingTo: ck.to } : {};
  let crossCheck: string[] = [];
  try {
    crossCheck = d.crossCheck?.() ?? [];
  } catch (e) {
    crossCheck = [`Cross-check skipped: ${(e as Error).message}`];
  }
  for (const l of crossCheck) record(l);

  const activeChanged = ckActive ? ck.updated : cocUpdated;
  if (!cocUpdated && !ck.updated) return { ...base, ...ckFields, to, status: 'none', crossCheck };

  // A new active data version must come with its diff (it's what the site's banner shows) …
  const changes = activeChanged ? lastSnapshot?.changes : [];
  if (!changes) return fail('snapshot + diff', 'no diff was produced (see the log)', { ...ckFields, crossCheck });
  // … and, unattended, a merge the recipes don't explain blocks the deploy.
  const data = d.loadData();
  const mergeIssues = checkMergeConsumption(data);
  if (mergeIssues.length) {
    const newKeys = new Set(changes.filter((c) => c.kind === 'newItem').map((c) => c.key));
    return fail('validation: config/merges.yaml', mergeIssues.map((i) => i.message).join('\n'), {
      ...ckFields,
      changes,
      crossCheck,
      missingMerges: describeMissingMerges(explainMissingMerges(data, newKeys)),
    });
  }
  const message = ckActive
    ? fullCommitMessage({ ck: ck.updated ? [ck.from, ck.to!] : undefined, coc: cocUpdated ? [from, to!] : undefined, changes: changes.length })
    : commitMessage(from ?? 'none', to!, changes.length);
  return { ...base, ...ckFields, to, status: 'updated', changes, crossCheck, commitMessage: message };
}

export const issueTitle = (r: Pick<DataUpdateResult, 'to' | 'failedStep' | 'clashKingTo'>) =>
  r.failedStep?.startsWith('ClashKing') ? `Data update failed: ${r.clashKingTo ?? 'ClashKing check'}` : `Data update failed: ${r.to ?? 'npm check'}`;

const tail = (lines: string[], n: number) => (lines.length > n ? [`… (${lines.length - n} earlier lines)`, ...lines.slice(-n)] : lines);
const fence = (lines: string[]) => ['```', ...lines.map((l) => l.replace(/```/g, "'''")), '```'];

/**
 * Issue body for a failed run: the failing step, why, a plain "merge missing" section when that's the cause,
 * the validation output, the diff summary and (when the tests failed) the end of the test log.
 */
export function issueBody(
  r: DataUpdateResult | undefined,
  o: { step?: string; testLog?: string; runUrl?: string; committed?: boolean } = {},
): string {
  const L: string[] = [];
  const step = o.step ?? r?.failedStep ?? 'unknown step';
  L.push(`The daily game-data update failed at **${step}**.`);
  if (r?.clashKingFrom || r?.clashKingTo) L.push('', `ClashKing ${r.clashKingFrom ?? '?'} → ${r.clashKingTo ?? '?'}`);
  if (r?.from || r?.to) L.push('', `clash-of-clans-data ${r.from ?? '?'} → ${r.to ?? '?'}`);
  L.push(
    '',
    o.committed
      ? '**The commit was pushed, but the deploy didn\'t start.** Run the "Deploy to GitHub Pages" workflow by hand.'
      : '**Nothing was committed**; the live site keeps the current (known-good) data.',
  );
  if (o.runUrl) L.push('', `Run: ${o.runUrl}`);
  if (r?.missingMerges.length) {
    L.push('', '## A merge is missing from config/merges.yaml', '');
    for (const m of r.missingMerges) L.push(`- ${m}`);
    L.push('', 'Add the recipe to `config/merges.yaml` (it wins over the data), run `npm run sync` and `npm test` locally, then push. The next daily run (or a manual run) picks it up.');
  }
  if (r?.reason) L.push('', '## Why', '', ...fence(r.reason.split('\n')));
  if (r?.log.length) L.push('', '## Sync and validation output', '', ...fence(tail(r.log.filter((l) => !/^\s{2}(?!\[WARN\])/.test(l)), 120)));
  if (r?.changes.length) {
    L.push('', `## Diff summary (${r.changes.length} change${r.changes.length === 1 ? '' : 's'})`, '');
    for (const c of r.changes.slice(0, 60)) L.push(`- ${c.text}`);
    if (r.changes.length > 60) L.push(`- … and ${r.changes.length - 60} more`);
  }
  if (o.testLog?.trim()) L.push('', '## npm test (end of output)', '', ...fence(tail(o.testLog.trimEnd().split(/\r?\n/), 80)));
  if (!r) L.push('', 'No result file was written (the run failed before the update step finished). See the run log.');
  return L.join('\n') + '\n';
}
