// Daily game-data update (GitHub Action, SPEC §9b). Reuses `npm run sync` exactly (syncData: newest
// version within the major, snapshot before + after, diff → public/data-changes.json, known-good restore)
// and adds one stricter rule for unattended deploys: a merge missing from config/merges.yaml fails the
// update. Side effects are injected so every branch is testable with a fake npm registry.
import { checkMergeConsumption, describeMissingMerges, explainMissingMerges } from '../../src/data/validate';
import type { DataChange } from '../../src/data/snapshot';
import type { GameData } from '../../src/data/types';
import type { SnapshotResult } from './snapshots';
import { syncData, type SyncDeps } from './sync';

export interface DataUpdateDeps {
  /** The same deps `npm run sync` uses (real npm in CI, a fake registry in tests). */
  sync: SyncDeps;
  /** The installed game data, normalized fresh from disk (after the install). */
  loadData(): GameData;
}

export interface DataUpdateResult {
  /** none = no newer version; updated = ready to commit; failed = commit nothing, open an issue. */
  status: 'none' | 'updated' | 'failed';
  from?: string;
  to?: string;
  changes: DataChange[];
  /** Which step failed (failed only). */
  failedStep?: string;
  reason?: string;
  /** Plain-language lines naming a merge missing from config/merges.yaml (failed only). */
  missingMerges: string[];
  /** Everything sync printed: versions, validation output, the diff. */
  log: string[];
  /** Commit message (updated only). */
  commitMessage?: string;
}

export const commitMessage = (from: string, to: string, n: number) => `data: clash-of-clans-data ${from} → ${to} (${n} change${n === 1 ? '' : 's'})`;

export function runDataUpdate(d: DataUpdateDeps): DataUpdateResult {
  const log: string[] = [];
  let to: string | undefined;
  let failureReason: string | undefined;
  let lastSnapshot: SnapshotResult | undefined;
  const from = d.sync.installedVersion();
  const wrapped: SyncDeps = {
    ...d.sync,
    latestInMajor: (major) => (to = d.sync.latestInMajor(major)),
    writeState: (s) => {
      if (s.dataFailure) failureReason = s.dataFailure.reason;
      d.sync.writeState(s);
    },
    snapshot: () => {
      const r = d.sync.snapshot?.();
      if (r) lastSnapshot = r;
      return r;
    },
    log: (line) => {
      log.push(line);
      d.sync.log(line);
    },
  };
  const base = { from, to: undefined as string | undefined, changes: [] as DataChange[], missingMerges: [] as string[], log };
  const fail = (failedStep: string, reason: string, extra: Partial<DataUpdateResult> = {}): DataUpdateResult => ({ ...base, to, status: 'failed', failedStep, reason, ...extra });

  const outcome = syncData(wrapped);
  if (outcome === 'up-to-date') return { ...base, to, status: 'none' };
  if (outcome === 'failed') {
    if (to === undefined) return fail('npm registry check', log.find((l) => l.startsWith('npm view failed')) ?? 'npm view failed');
    return fail('install', failureReason ?? log.filter((l) => /failed|can't be used/i.test(l)).at(-1) ?? 'npm install failed');
  }
  if (outcome === 'restored') return fail('load + validate the new data', failureReason ?? 'the new data could not be loaded');

  // updated: the diff must exist (it's what the site's banner shows) …
  const changes = lastSnapshot?.changes;
  if (!changes) return fail('snapshot + diff', 'no diff was produced (see the log)');
  // … and, unattended, a merge missing from config/merges.yaml blocks the deploy.
  const data = d.loadData();
  const mergeIssues = checkMergeConsumption(data);
  if (mergeIssues.length) {
    const newKeys = new Set(changes.filter((c) => c.kind === 'newItem').map((c) => c.key));
    return fail('validation: config/merges.yaml', mergeIssues.map((i) => i.message).join('\n'), {
      changes,
      missingMerges: describeMissingMerges(explainMissingMerges(data, newKeys)),
    });
  }
  return { ...base, to, status: 'updated', changes, commitMessage: commitMessage(from ?? 'none', to!, changes.length) };
}

export const issueTitle = (r: Pick<DataUpdateResult, 'to'>) => `Data update failed: ${r.to ?? 'npm check'}`;

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
  if (r?.from || r?.to) L.push('', `clash-of-clans-data ${r.from ?? '?'} → ${r.to ?? '?'}`);
  L.push('', o.committed ? '**The commit was pushed, but the deploy didn\'t start.** Run the "Deploy to GitHub Pages" workflow by hand.' : '**Nothing was committed**; the live site keeps the current data.');
  if (o.runUrl) L.push('', `Run: ${o.runUrl}`);
  if (r?.missingMerges.length) {
    L.push('', '## A merge is missing from config/merges.yaml', '');
    for (const m of r.missingMerges) L.push(`- ${m}`);
    L.push('', 'Add the recipe to `config/merges.yaml`, run `npm run sync` and `npm test` locally, then push. The next daily run (or a manual run) picks it up.');
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
