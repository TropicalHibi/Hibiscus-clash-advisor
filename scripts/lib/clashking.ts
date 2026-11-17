// ClashKing stage of `npm run sync` and the daily data-update Action (SPEC §9, §9b): find the latest
// clashy.go release (main when no release has the file), download static/static_data.json at that exact
// commit, trim + normalize + validate it, and only then replace the pinned copy in data/clashking/.
// A file that fails keeps the previous pinned copy (known-good rollback); the failure is recorded so
// `npm run dev` warns and the Action opens / updates its issue. Side effects are injected (tests use fakes).
import { createHash } from 'node:crypto';
import { CK_PATH, CK_REPO, trimClashKing, type ClashKingRaw } from '../../src/data/clashking';
import { clashKingVersion, type ClashKingPin } from '../../src/data/source';
import type { GameData } from '../../src/data/types';
import { checkLevels } from '../../src/data/validate';
import type { RefreshState } from './refresh';
import type { SnapshotResult } from './snapshots';

export interface ClashKingRef {
  /** Release tag, or "main". */
  ref: string;
  tag?: string;
  commit: string;
}

export interface ClashKingDeps {
  /** The pinned copy, or undefined when there is none (or it's unreadable). */
  readPinned(): { raw: ClashKingRaw; pin: ClashKingPin } | undefined;
  /** Latest release tag + commit (main when no release has the file). Throws when GitHub can't be reached. */
  resolveLatest(): ClashKingRef;
  /** static_data.json at that commit, as text. Throws on failure. */
  download(commit: string): string;
  /** Normalizes ClashKing data the way the site will (overrides, images, TH weapons). Throws on bad data. */
  normalize(raw: ClashKingRaw, version: string): GameData;
  /** Replaces data/clashking/static_data.json + pin.json. */
  write(raw: ClashKingRaw, pin: ClashKingPin): void;
  readState(): RefreshState;
  writeState(s: RefreshState): void;
  /** Snapshot + diff of the active data (SPEC §9 steps 2–3). */
  snapshot?(): SnapshotResult | void;
  now(): Date;
  log(line: string): void;
}

export type ClashKingOutcome =
  /** Pinned commit is the latest. */
  | 'up-to-date'
  /** A new file was validated and pinned. */
  | 'updated'
  /** GitHub couldn't be asked; the pinned copy stays. */
  | 'check-failed'
  /** Download failed; the pinned copy stays. */
  | 'download-failed'
  /** The new file failed to load or validate; the pinned copy stays. */
  | 'kept-previous'
  /** No usable ClashKing copy at all: the planner runs on clash-of-clans-data (backup). */
  | 'no-copy';

export interface ClashKingResult {
  outcome: ClashKingOutcome;
  from?: string;
  to?: string;
  reason?: string;
  snapshot?: SnapshotResult;
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Validation a new ClashKing file must pass before it replaces the pinned one. Returns the first problem. */
export function validateClashKing(data: GameData, previous?: Pick<ClashKingPin, 'maxTH' | 'items' | 'version'>): string | undefined {
  if (!data.maxTH || !data.items.size) return 'no Town Hall levels / items in the data';
  const lv = checkLevels(data);
  if (lv.length) return lv[0].message;
  for (const id of ['laboratory', 'archer-queen', 'cannon', 'barbarian', 'builders-hut']) if (!data.byId.has(id)) return `"${id}" is missing`;
  if (previous) {
    if (data.maxTH < previous.maxTH) return `max TH dropped from ${previous.maxTH} to ${data.maxTH}`;
    const base = [...data.items.values()].filter((i) => i.key === String(i.dataId)).length;
    if (base < Math.floor(previous.items * 0.9)) return `item count dropped from ${previous.items} to ${base} (more than 10%)`;
  }
  return undefined;
}

/** Base items (key = dataId), as recorded in pin.json. */
const baseItems = (d: GameData) => [...d.items.values()].filter((i) => i.key === String(i.dataId)).length;

/**
 * Downloads, validates and pins the latest ClashKing static data. Never throws.
 * `offline`: validate the pinned copy only (no GitHub).
 */
export function syncClashKing(d: ClashKingDeps, opts: { offline?: boolean } = {}): ClashKingResult {
  const pinned = d.readPinned();
  const from = pinned?.pin.version;
  let current: GameData | undefined;
  let currentError: string | undefined;
  if (pinned) {
    try {
      current = d.normalize(pinned.raw, pinned.pin.version);
      currentError = validateClashKing(current);
    } catch (e) {
      currentError = (e as Error).message;
    }
  }
  const currentOk = !!current && !currentError;
  d.log(`ClashKing pinned: ${pinned ? `${pinned.pin.version} (${pinned.pin.commit.slice(0, 7)})` : 'none'}${pinned && !currentOk ? ` — can't be used: ${currentError}` : ''}`);
  const noCopy = (reason: string): ClashKingResult => {
    d.log(`No usable ClashKing copy (${reason}). The planner falls back to clash-of-clans-data; that's a visible warning on the site.`);
    return { outcome: 'no-copy', from, reason };
  };

  if (opts.offline) {
    if (!currentOk) return noCopy(currentError ?? 'nothing pinned');
    d.log(`Offline: checked the pinned ClashKing ${from} without asking GitHub.`);
    return { outcome: 'up-to-date', from, to: from };
  }

  let latest: ClashKingRef;
  try {
    latest = d.resolveLatest();
  } catch (e) {
    const reason = `GitHub check failed: ${(e as Error).message}`;
    d.log(reason);
    return currentOk ? { outcome: 'check-failed', from, reason } : noCopy(reason);
  }
  const to = clashKingVersion(latest);
  if (currentOk && pinned!.pin.commit === latest.commit) {
    d.log(`ClashKing ${from} is the latest ${latest.tag ? 'release' : 'main commit'} (unchanged).`);
    return { outcome: 'up-to-date', from, to: from };
  }

  // Snapshot the pinned data first, so there's always a "before" to diff against (fresh CI checkout).
  if (currentOk) {
    try {
      d.snapshot?.();
    } catch (e) {
      d.log(`  [WARN] snapshot of ${from} failed: ${(e as Error).message}`);
    }
  }
  d.log(`Downloading ClashKing ${to} (${latest.commit.slice(0, 7)}) from ${CK_REPO}/${CK_PATH}…`);
  let text: string;
  try {
    text = d.download(latest.commit);
  } catch (e) {
    const reason = `download failed: ${(e as Error).message}`;
    d.log(reason);
    return currentOk ? { outcome: 'download-failed', from, to, reason } : noCopy(reason);
  }

  let raw: ClashKingRaw;
  let next: GameData;
  let problem: string | undefined;
  try {
    raw = trimClashKing(JSON.parse(text));
    next = d.normalize(raw, to);
    problem = validateClashKing(next, currentOk ? { ...pinned!.pin, items: baseItems(current!) } : undefined);
  } catch (e) {
    problem = (e as Error).message;
  }
  if (problem) {
    d.log(`ClashKing ${to} can't be used: ${problem}`);
    d.writeState({ ...d.readState(), clashKingFailure: { version: to, reason: problem, at: d.now().getTime() } });
    if (!currentOk) return noCopy(problem);
    d.log(`Keeping the known-good ClashKing ${from}.`);
    return { outcome: 'kept-previous', from, to, reason: problem };
  }

  const pin: ClashKingPin = {
    repo: CK_REPO,
    ref: latest.ref,
    ...(latest.tag ? { tag: latest.tag } : {}),
    commit: latest.commit,
    path: CK_PATH,
    sha256: sha256(text),
    version: to,
    fetchedAt: d.now().toISOString(),
    maxTH: next!.maxTH,
    items: baseItems(next!),
  };
  d.write(raw!, pin);
  const { clashKingFailure: _cleared, ...rest } = d.readState();
  d.writeState({ ...rest, lastGoodClashKing: to });
  d.log(`ClashKing ${from ?? 'none'} → ${to} (UPDATED: restart npm run dev)`);
  let snapshot: SnapshotResult | undefined;
  try {
    snapshot = d.snapshot?.() ?? undefined;
  } catch (e) {
    d.log(`  [WARN] snapshot/diff failed: ${(e as Error).message}`);
  }
  return { outcome: 'updated', from, to, snapshot };
}

// ── GitHub (real network; only wired in nodeDeps.ts, never in tests) ──

type FetchText = (url: string, headers: Record<string, string>) => { status: number; text: string };

/** Headers for api.github.com: the Actions token when present (rate limits). Never logged. */
export function githubHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  return { Accept: 'application/vnd.github+json', 'User-Agent': 'hibiscus-clash-advisor-sync', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/** Latest release that contains the file; main otherwise. */
export function resolveLatestWith(get: FetchText, headers = githubHeaders()): ClashKingRef {
  const api = `https://api.github.com/repos/${CK_REPO}`;
  const json = (url: string) => {
    const r = get(url, headers);
    return { status: r.status, body: r.status === 200 ? JSON.parse(r.text) : undefined };
  };
  const rel = json(`${api}/releases/latest`);
  if (rel.status === 200 && rel.body?.tag_name) {
    const tag = String(rel.body.tag_name);
    const c = json(`${api}/commits/${encodeURIComponent(tag)}`);
    const file = get(`${api}/contents/${CK_PATH}?ref=${encodeURIComponent(tag)}`, headers);
    if (c.status === 200 && c.body?.sha && file.status === 200) return { ref: tag, tag, commit: String(c.body.sha) };
  } else if (rel.status !== 404) throw new Error(`GitHub releases: HTTP ${rel.status}`);
  const main = json(`${api}/commits/main`);
  if (main.status !== 200 || !main.body?.sha) throw new Error(`GitHub main: HTTP ${main.status}`);
  return { ref: 'main', commit: String(main.body.sha) };
}

export const rawUrl = (commit: string) => `https://raw.githubusercontent.com/${CK_REPO}/${commit}/${CK_PATH}`;
