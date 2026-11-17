// Daily Legend I meta in GitHub Actions (SPEC §8.4). Logic only; the workflow is
// .github/workflows/meta.yml and the entry point scripts/meta-ci.ts. Login, collection and the clock are
// injected so every branch (login failure, 403, API down, partial run, "worse than the current meta")
// is testable without real calls.
import { createHash } from 'node:crypto';
import type { MetaFile } from '../../src/meta/meta';
import { ApiError } from './api';
import { AuthError, redact, type TokenSource } from './auth';
import { fence } from './ghText';
import type { MetaRunResult } from './metaRun';

/** A meta.json built from fewer attacks than this is never committed (a normal daily run has ~13k). */
export const MIN_META_ATTACKS = 2000;
/** A partial run may still commit if it fetched at least this share of the players it gathered. */
export const MIN_FETCHED_SHARE = 0.5;
/** Never replace the current meta with one built from less than this share of its attacks. */
export const MIN_ATTACK_SHARE_OF_CURRENT = 0.5;

/**
 * Pseudonym stored instead of a player tag in the public meta-data branch: stable (dedupe and the player
 * count still work across runs) but not the tag itself.
 */
export const hashTag = (tag: string) => `h${createHash('sha256').update(`hibiscus-meta:${tag}`).digest('hex').slice(0, 16)}`;

export type MetaCiStatus = 'commit' | 'partial-commit' | 'unchanged' | 'failed';

export interface MetaCiResult {
  status: MetaCiStatus;
  /** Commit public/meta.json to main (and start the Pages workflow). */
  commit: boolean;
  /** Force-push the pruned battles.jsonl to the meta-data branch (new attacks were collected). */
  store: boolean;
  /** Open / update the "Meta update failed" issue (failures and partial runs). */
  issue: boolean;
  /** Failing step, e.g. "login", "collect", "quality check". */
  step?: string;
  /** Redacted reason. */
  reason?: string;
  source?: TokenSource['source'];
  keyName?: string;
  generatedAt?: string;
  attacks?: number;
  players?: number;
  currentAttacks?: number;
  stats?: MetaRunResult['stats'];
  rows?: number;
}

/** Same meta apart from generatedAt? */
export function sameMeta(a: MetaFile | undefined, b: MetaFile): boolean {
  if (!a) return false;
  const strip = (m: MetaFile) => JSON.stringify({ ...m, generatedAt: null });
  return strip(a) === strip(b);
}

/** Whether a finished run's meta.json may replace the current one (pure). */
export function decideMeta(current: MetaFile | undefined, next: MetaFile, run: MetaRunResult): Omit<MetaCiResult, 'source' | 'keyName'> {
  const s = run.stats ?? { gathered: 0, fetched: 0, failed: 0, newRows: 0 };
  const base = { generatedAt: next.generatedAt ?? undefined, attacks: next.attacks, players: next.players, currentAttacks: current?.attacks, stats: run.stats, rows: run.rows };
  const fail = (step: string, reason: string, store = s.newRows > 0) => ({ ...base, status: 'failed' as const, commit: false, store, issue: true, step, reason });
  if (!s.gathered) return fail('collect', 'No Legend I players were gathered from the rankings (API down or every location failed).', false);
  if (!s.fetched) return fail('collect', `None of the ${s.gathered} players' battle logs could be fetched (API down?).`, false);
  if (s.failed && s.fetched / s.gathered < MIN_FETCHED_SHARE)
    return fail('quality check', `Partial run: only ${s.fetched} of ${s.gathered} players fetched (< ${MIN_FETCHED_SHARE * 100}%).`);
  if (next.attacks < MIN_META_ATTACKS) return fail('quality check', `Only ${next.attacks} attacks in the window (minimum ${MIN_META_ATTACKS}); keeping the current meta.json.`);
  if (current && current.attacks > 0 && next.attacks < current.attacks * MIN_ATTACK_SHARE_OF_CURRENT)
    return fail('quality check', `The new meta has ${next.attacks} attacks vs ${current.attacks} in the current one (< ${MIN_ATTACK_SHARE_OF_CURRENT * 100}%); keeping the current meta.json.`);
  if (sameMeta(current, next)) return { ...base, status: 'unchanged', commit: false, store: s.newRows > 0, issue: !!s.failed, ...(s.failed ? { step: 'collect (partial)', reason: `${s.failed} of ${s.gathered} players failed.` } : {}) };
  if (s.failed)
    return { ...base, status: 'partial-commit', commit: true, store: true, issue: true, step: 'collect (partial)', reason: `${s.failed} of ${s.gathered} players could not be fetched; committed anyway (${next.attacks} attacks ≥ ${MIN_META_ATTACKS}).` };
  return { ...base, status: 'commit', commit: true, store: s.newRows > 0, issue: false };
}

export interface MetaCiDeps {
  getToken(): Promise<TokenSource>;
  /** Runs `npm run meta`'s logic with this token (writes battles.jsonl + meta.json). */
  collect(token: string): Promise<MetaRunResult>;
  /** The committed meta.json, read before the run. */
  current: MetaFile | undefined;
  /** The meta.json the run wrote. */
  readNext(): MetaFile;
  /** Secrets to scrub from any error text (email, password; the token is added once known). */
  secrets: (string | undefined)[];
}

export async function runMetaCi(d: MetaCiDeps): Promise<MetaCiResult> {
  const secrets = [...d.secrets];
  const scrub = (e: unknown) => redact(e instanceof Error ? e.message : String(e), secrets);
  let auth: TokenSource;
  try {
    auth = await d.getToken();
  } catch (e) {
    return { status: 'failed', commit: false, store: false, issue: true, step: 'login', reason: e instanceof AuthError ? scrub(e) : `Login failed: ${scrub(e)}` };
  }
  secrets.push(auth.token);
  const who = { source: auth.source, keyName: auth.keyName };
  let run: MetaRunResult;
  try {
    run = await d.collect(auth.token);
  } catch (e) {
    const forbidden = e instanceof ApiError && (e.status === 403 || e.status === 401);
    const hint = forbidden ? ' The key was just created for this runner\'s IP, so the API saw a different IP or rejected the key.' : '';
    return { ...who, status: 'failed', commit: false, store: false, issue: true, step: forbidden ? `collect (HTTP ${(e as ApiError).status})` : 'collect', reason: `${scrub(e)}${hint}` };
  }
  return { ...who, ...decideMeta(d.current, d.readNext(), run) };
}

/** Issue body (already redacted inputs; scrubbed once more). */
export function metaIssueBody(r: MetaCiResult | undefined, o: { step?: string; runUrl?: string; committed?: boolean; secrets?: (string | undefined)[] } = {}): string {
  const L: string[] = [];
  const step = o.step ?? r?.step ?? 'unknown step';
  const partial = r?.status === 'partial-commit';
  L.push(partial ? `The daily Legend I meta run was **partial** (step: **${step}**).` : `The daily Legend I meta update failed at **${step}**.`);
  L.push(
    '',
    r?.commit && o.committed !== false
      ? 'A new `public/meta.json` was committed anyway (it passed the minimums below).'
      : '**`public/meta.json` was not changed**; the live site keeps the current meta.',
  );
  if (o.runUrl) L.push('', `Run: ${o.runUrl}`);
  if (r?.reason) L.push('', '## Why', '', ...fence(r.reason.split('\n')));
  if (r?.stats || r?.attacks !== undefined) {
    L.push('', '## Numbers', '');
    if (r.stats) L.push(`- Players: ${r.stats.fetched} of ${r.stats.gathered} fetched${r.stats.failed ? `, ${r.stats.failed} failed` : ''}; ${r.stats.newRows} new attacks`);
    if (r.attacks !== undefined) L.push(`- Attacks in the 14-day window: ${r.attacks}${r.currentAttacks !== undefined ? ` (current meta.json: ${r.currentAttacks})` : ''}`);
    L.push(`- Minimums to commit: ${MIN_META_ATTACKS} attacks, ${MIN_FETCHED_SHARE * 100}% of players fetched, ≥ ${MIN_ATTACK_SHARE_OF_CURRENT * 100}% of the current meta's attacks`);
  }
  if (r?.source) L.push('', `Auth: ${r.source === 'login' ? `developer-site login, key "${r.keyName}"` : 'COC_API_TOKEN'}`);
  if (!r) L.push('', 'No result file was written (the run failed before the meta step finished). See the run log.');
  L.push('', 'This issue is updated by later failed runs and closed automatically by the next clean run.');
  return redact(L.join('\n'), o.secrets ?? []) + '\n';
}

export const META_ISSUE_TITLE = 'Meta update failed';
