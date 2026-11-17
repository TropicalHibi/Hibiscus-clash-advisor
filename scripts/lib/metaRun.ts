// `npm run meta` run logic (SPEC §8): collect → append battles.jsonl → prune → aggregate → meta.json.
// Paths, API client and clock are injected so resume, pruning, dedupe and exit codes can be tested.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { aggregate, rowKey, type BattleRow, type Catalog } from '../../src/meta/aggregate';
import { ApiError, type ApiClient } from './api';
import { fetchPlayerAttacks, gatherPlayers, pool } from './collect';

export const PRUNE_DAYS = 60;
/** A run state younger than this is resumed as the same run. */
export const STATE_MAX_AGE_MS = 24 * 3600_000;
/** Players a previous run couldn't fetch are retried by any run started within this window (SPEC §9a). */
export const CARRY_OVER_MAX_AGE_MS = 7 * 24 * 3600_000;
const WORKERS = 4;

export interface MetaConf {
  leagueTierId: number;
  maxPlayers: number;
  windowDays: number;
  halfLifeDays: number;
  requestsPerSecond: number;
}

/** `meta:` settings from config/settings.sample.yaml, with defaults. */
export function metaConfFrom(settingsYaml: string, leagueTierDefault: number): MetaConf {
  const cfg = ((parseYaml(settingsYaml) ?? {}) as { meta?: Record<string, unknown> }).meta ?? {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    leagueTierId: num(cfg.leagueTierId, leagueTierDefault),
    maxPlayers: num(cfg.maxPlayers, 1000),
    windowDays: num(cfg.windowDays, 14),
    halfLifeDays: num(cfg.halfLifeDays, 5),
    requestsPerSecond: num(cfg.requestsPerSecond, 10),
  };
}

export interface RunState {
  startedAt: string;
  /** Last time the state was written (after each player). */
  updatedAt?: string;
  maxPlayers: number;
  tags: string[];
  done: string[];
  stats: { entries: number; legendAttacks: number; newRows: number; duplicates: number; missingCode: number; notFound: number };
}

export interface MetaRunOptions {
  /** data/meta directory (battles.jsonl, run-state.json). */
  dir: string;
  /** public/meta.json */
  outFile: string;
  conf: MetaConf;
  fresh?: boolean;
  aggregateOnly?: boolean;
  /** Required unless aggregateOnly. */
  api?: ApiClient;
  catalog: Catalog;
  dataVersion: string;
  /** Drop rows older than this many days (default PRUNE_DAYS = 60; the CI Action uses the 14-day window). */
  pruneDays?: number;
  /**
   * Rewrites each new row's player tag before it's stored and deduped (CI: a pseudonym, because the
   * meta-data branch is public). The same mapping must be used for every run sharing a battles.jsonl.
   */
  tagMap?: (tag: string) => string;
  /** Don't carry over failed players / resume (CI: no run state survives between runs). */
  noRunState?: boolean;
  now?: () => number;
  log?: (line: string) => void;
  /** In-place progress line (TTY); falls back to occasional log lines. */
  progress?: (line: string, final: boolean) => void;
}

export interface MetaRunResult {
  /** 0 = all players fetched; 2 = meta.json written but some players failed (retried next run). */
  exitCode: 0 | 2;
  failed: string[];
  resumed: boolean;
  carriedOver: number;
  rows: number;
  pruned: number;
  summary: string[];
  /** Collection stats (undefined for --aggregate-only). */
  stats?: { gathered: number; fetched: number; failed: number; newRows: number };
  /** Attacks / players in the written meta.json. */
  attacks: number;
  players: number;
}

const fmtTime = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

function readRows(file: string): BattleRow[] {
  if (!fs.existsSync(file)) return [];
  const rows: BattleRow[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip a torn last line from an interrupted write */
    }
  }
  return rows;
}

/** Resume a recent same-size run; otherwise carry over the players a recent run couldn't fetch. */
export function loadRunState(file: string, conf: MetaConf, nowMs: number, fresh: boolean): { resume: RunState | null; carryOver: string[] } {
  if (fresh || !fs.existsSync(file)) return { resume: null, carryOver: [] };
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as RunState;
    const age = nowMs - Date.parse(s.startedAt);
    if (age <= STATE_MAX_AGE_MS && s.maxPlayers === conf.maxPlayers) return { resume: s, carryOver: [] };
    const lastWrite = Date.parse(s.updatedAt ?? s.startedAt);
    if (nowMs - lastWrite > CARRY_OVER_MAX_AGE_MS) return { resume: null, carryOver: [] };
    const done = new Set(s.done);
    return { resume: null, carryOver: s.tags.filter((t) => !done.has(t)) };
  } catch {
    return { resume: null, carryOver: [] };
  }
}

export async function runMeta(o: MetaRunOptions): Promise<MetaRunResult> {
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? ((l: string) => console.log(l));
  const progress = o.progress ?? ((l: string, final: boolean) => final && log(l));
  const started = now();
  const battles = path.join(o.dir, 'battles.jsonl');
  const stateFile = path.join(o.dir, 'run-state.json');
  fs.mkdirSync(o.dir, { recursive: true });

  let run: { state: RunState; failed: string[]; requests: number; resumed: boolean; carriedOver: number } | undefined;
  if (!o.aggregateOnly) {
    if (!o.api) throw new Error('runMeta: an API client is required unless aggregateOnly');
    run = await collect(o.api, o, stateFile, battles, now, log, progress);
    if (!run.failed.length || o.noRunState) fs.rmSync(stateFile, { force: true });
  }

  // ── Prune (> pruneDays) and dedupe again (an interrupted run can append a row twice) ──
  const nowMs = now();
  const all = readRows(battles);
  const pruneDays = o.pruneDays ?? PRUNE_DAYS;
  const cutoff = nowMs - pruneDays * 86_400_000;
  const seen = new Set<string>();
  const rows = all.filter((r) => {
    const k = rowKey(r);
    if (seen.has(k) || !(Date.parse(r.ts) >= cutoff)) return false;
    seen.add(k);
    return true;
  });
  if (rows.length !== all.length) fs.writeFileSync(battles, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const pruned = all.length - rows.length;

  const result = aggregate(rows, o.catalog, { nowMs, windowDays: o.conf.windowDays, halfLifeDays: o.conf.halfLifeDays });
  fs.mkdirSync(path.dirname(o.outFile), { recursive: true });
  fs.writeFileSync(o.outFile, JSON.stringify(result.meta, null, 2) + '\n');

  // ── Summary ──
  const L: string[] = ['', '== Meta run summary =='];
  if (run) {
    const s = run.state.stats;
    L.push(
      `Players fetched:      ${run.state.done.length}/${run.state.tags.length}${run.resumed ? ' (resumed run)' : ''}${run.carriedOver ? ` · ${run.carriedOver} retried from the last run` : ''}${run.failed.length ? ` · ${run.failed.length} failed (retried on the next run)` : ''}${s.notFound ? ` · ${s.notFound} not found` : ''}`,
    );
    L.push(`Battle log entries:   ${s.entries} (avg ${(s.entries / Math.max(1, run.state.done.length)).toFixed(1)} per player)`);
    L.push(`Legend I attacks kept: ${s.legendAttacks - s.missingCode}${s.missingCode ? ` (${s.missingCode} without an army code skipped)` : ''}`);
    L.push(`New rows:             ${s.newRows} · duplicates skipped: ${s.duplicates}`);
    L.push(`API requests:         ${run.requests} this session`);
  }
  L.push(`battles.jsonl:        ${rows.length} rows${pruned ? ` (${pruned} older than ${pruneDays} days or duplicate removed)` : ''}`);
  L.push(
    `Aggregated:           ${result.meta.attacks} attacks by ${result.meta.players} players in the last ${o.conf.windowDays} days (half-life ${o.conf.halfLifeDays}d)${result.emptyArmies ? `, ${result.emptyArmies} empty armies skipped` : ''}`,
  );
  L.push(`Units in meta.json:   ${Object.keys(result.meta.units).length}`);
  if (result.noHousing.size) {
    L.push(`No housing space in the data (${result.noHousing.size}) — these rank by usage share instead of army share:`);
    for (const [id, name] of result.noHousing) L.push(`  ${id}  ${name}`);
  } else L.push('Housing space:        found for every known troop and spell');
  if (result.unknown.size) {
    L.push(`Unknown IDs (${result.unknown.size}) — not in the game data (${o.dataVersion}) or config/super-troops.yaml:`);
    for (const [id, u] of [...result.unknown].sort((a, b) => b[1].attacks - a[1].attacks))
      L.push(`  ${id}  in ${u.attacks} attacks · sections ${[...u.sections].join(',')} · ${u.counted ? 'counted' : 'not counted (CC/hero)'}`);
  } else L.push('Unknown IDs:          none');
  L.push(`Elapsed:              ${fmtTime(now() - started)}`);
  L.push(`Wrote ${o.outFile}`);
  log(L.join('\n'));

  return {
    exitCode: run?.failed.length ? 2 : 0,
    failed: run?.failed ?? [],
    resumed: run?.resumed ?? false,
    carriedOver: run?.carriedOver ?? 0,
    rows: rows.length,
    pruned,
    summary: L,
    stats: run && { gathered: run.state.tags.length, fetched: run.state.done.length, failed: run.failed.length, newRows: run.state.stats.newRows },
    attacks: result.meta.attacks,
    players: result.meta.players,
  };
}

async function collect(
  api: ApiClient,
  o: MetaRunOptions,
  stateFile: string,
  battles: string,
  now: () => number,
  log: (l: string) => void,
  progress: (l: string, final: boolean) => void,
) {
  const { conf } = o;
  const { resume, carryOver } = loadRunState(stateFile, conf, now(), !!o.fresh || !!o.noRunState);
  let state = resume;
  let carriedOver = 0;
  const saveState = (s: RunState) => fs.writeFileSync(stateFile, JSON.stringify({ ...s, updatedAt: new Date(now()).toISOString() }));
  if (state) log(`Resuming run from ${new Date(state.startedAt).toLocaleString()}: ${state.done.length}/${state.tags.length} players already fetched.`);
  else {
    log(`Gathering Legend I players (tier ${conf.leagueTierId}) from global + country rankings, up to ${conf.maxPlayers}…`);
    const gathered = await gatherPlayers(api, {
      maxPlayers: conf.maxPlayers,
      leagueTierId: conf.leagueTierId,
      onLocation: ({ location, total, index, of }) => progress(`  rankings ${index}/${of} (${location}) → ${total} players`, index === of),
      onSkip: ({ location, error }) => log(`\n  skipped rankings for ${location}: ${error}`),
    });
    // Players the last run couldn't fetch go first (they missed a day of battles).
    const tags = [...new Set([...carryOver, ...gathered])].slice(0, conf.maxPlayers);
    carriedOver = carryOver.filter((t) => tags.includes(t)).length;
    if (carriedOver) log(`Retrying ${carriedOver} players the last run couldn't fetch.`);
    state = { startedAt: new Date(now()).toISOString(), maxPlayers: conf.maxPlayers, tags, done: [], stats: { entries: 0, legendAttacks: 0, newRows: 0, duplicates: 0, missingCode: 0, notFound: 0 } };
    saveState(state);
    log(`Found ${tags.length} Legend I players.`);
  }

  const keys = new Set(readRows(battles).map(rowKey));
  const done = new Set(state.done);
  const todo = state.tags.filter((t) => !done.has(t));
  const failed: string[] = [];
  const t0 = now();
  let n = 0;
  const st = state;
  log(`Fetching ${todo.length} battle logs at ≤${conf.requestsPerSecond} req/s…`);
  await pool(todo, WORKERS, async (tag) => {
    try {
      const r = await fetchPlayerAttacks(api, tag);
      const mapped = o.tagMap ? r.rows.map((row) => ({ ...row, tag: o.tagMap!(row.tag) })) : r.rows;
      const fresh = mapped.filter((row) => !keys.has(rowKey(row)));
      for (const row of fresh) keys.add(rowKey(row));
      if (fresh.length) fs.appendFileSync(battles, fresh.map((row) => JSON.stringify(row)).join('\n') + '\n');
      st.stats.entries += r.entries;
      st.stats.legendAttacks += r.legendAttacks;
      st.stats.newRows += fresh.length;
      st.stats.duplicates += mapped.length - fresh.length;
      st.stats.missingCode += r.missingCode;
      if (r.notFound) st.stats.notFound++;
      st.done.push(tag);
      saveState(st);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) throw e;
      failed.push(tag);
      log(`\n  ${tag}: ${(e as Error).message} (will retry on the next run)`);
    }
    n++;
    const rate = n / Math.max(0.001, (now() - t0) / 1000);
    const eta = (todo.length - n) / Math.max(rate, 0.01);
    progress(`  [${st.done.length}/${st.tags.length}] ${st.stats.newRows} new attacks · ${rate.toFixed(1)} players/s · ETA ${fmtTime(eta * 1000)}`, n === todo.length);
  });
  return { state: st, failed, requests: api.requestCount, resumed: !!resume, carriedOver };
}
