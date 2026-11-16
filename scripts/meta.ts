// npm run meta [-- --max-players <n>] [--fresh] [--aggregate-only]
// Pulls Legend League I battle logs, appends new attacks to data/meta/battles.jsonl,
// aggregates the last 14 days and writes public/meta.json (SPEC §8).
//
// Resumable: progress lives in data/meta/run-state.json. If a run is interrupted, rerunning
// skips the players already fetched (state older than 24h, or --fresh, starts over).
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadGameDataNode, PROJECT_ROOT, readConfig } from '../src/data/loadNode';
import { aggregate, buildCatalog, parseSuperTroops, rowKey, type BattleRow } from '../src/meta/aggregate';
import { ApiError, createClient, loadToken } from './lib/api';
import { fetchPlayerAttacks, gatherPlayers, LEGEND_I_TIER, pool } from './lib/collect';

const META_DIR = path.join(PROJECT_ROOT, 'data', 'meta');
const BATTLES = path.join(META_DIR, 'battles.jsonl');
const STATE = path.join(META_DIR, 'run-state.json');
const OUT = path.join(PROJECT_ROOT, 'public', 'meta.json');
const PRUNE_DAYS = 60;
const STATE_MAX_AGE_MS = 24 * 3600_000;
const WORKERS = 4;

// ── Args + config ──
const args = process.argv.slice(2);
const argVal = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const cfg = ((parseYaml(readConfig('settings.sample.yaml')) ?? {}) as { meta?: Record<string, number> }).meta ?? {};
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
const conf = {
  leagueTierId: num(cfg.leagueTierId, LEGEND_I_TIER),
  maxPlayers: num(cfg.maxPlayers, 1000),
  windowDays: num(cfg.windowDays, 14),
  halfLifeDays: num(cfg.halfLifeDays, 5),
  requestsPerSecond: num(cfg.requestsPerSecond, 10),
};
if (argVal('--max-players') !== undefined) {
  const n = Number(argVal('--max-players'));
  if (!Number.isInteger(n) || n <= 0) {
    console.error('--max-players needs a positive whole number, e.g. --max-players 50');
    process.exit(1);
  }
  conf.maxPlayers = n;
}

interface RunState {
  startedAt: string;
  maxPlayers: number;
  tags: string[];
  done: string[];
  stats: { entries: number; legendAttacks: number; newRows: number; duplicates: number; missingCode: number; notFound: number };
}

const tty = process.stdout.isTTY;
const fmtTime = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

function readRows(): BattleRow[] {
  if (!fs.existsSync(BATTLES)) return [];
  const rows: BattleRow[] = [];
  for (const line of fs.readFileSync(BATTLES, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip a torn last line from an interrupted write */
    }
  }
  return rows;
}

function loadState(): RunState | null {
  if (args.includes('--fresh') || !fs.existsSync(STATE)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8')) as RunState;
    if (Date.now() - Date.parse(s.startedAt) > STATE_MAX_AGE_MS) return null;
    if (s.maxPlayers !== conf.maxPlayers) return null;
    return s;
  } catch {
    return null;
  }
}
const saveState = (s: RunState) => fs.writeFileSync(STATE, JSON.stringify(s));

async function collect(): Promise<{ state: RunState; failed: string[]; requests: number; resumed: boolean }> {
  const api = createClient({
    token: loadToken(),
    requestsPerSecond: conf.requestsPerSecond,
    onRetry: ({ status, attempt, waitMs }) => console.log(`\n  retry ${attempt} after HTTP ${status || 'network error'}, waiting ${fmtTime(waitMs)}`),
  });
  let state = loadState();
  const resumed = !!state;
  if (state) console.log(`Resuming run from ${new Date(state.startedAt).toLocaleString()}: ${state.done.length}/${state.tags.length} players already fetched.`);
  else {
    console.log(`Gathering Legend I players (tier ${conf.leagueTierId}) from global + country rankings, up to ${conf.maxPlayers}…`);
    const tags = await gatherPlayers(api, {
      maxPlayers: conf.maxPlayers,
      leagueTierId: conf.leagueTierId,
      onLocation: ({ location, total, index, of }) => {
        const line = `  rankings ${index}/${of} (${location}) → ${total} players`;
        if (tty) process.stdout.write(`\r${line.padEnd(70)}`);
        else if (index % 25 === 0) console.log(line);
      },
    });
    if (tty) process.stdout.write('\n');
    state = { startedAt: new Date().toISOString(), maxPlayers: conf.maxPlayers, tags, done: [], stats: { entries: 0, legendAttacks: 0, newRows: 0, duplicates: 0, missingCode: 0, notFound: 0 } };
    saveState(state);
    console.log(`Found ${tags.length} Legend I players.`);
  }

  const keys = new Set(readRows().map(rowKey));
  const done = new Set(state.done);
  const todo = state.tags.filter((t) => !done.has(t));
  const failed: string[] = [];
  const t0 = Date.now();
  let n = 0;
  const st = state;
  console.log(`Fetching ${todo.length} battle logs at ≤${conf.requestsPerSecond} req/s…`);
  await pool(todo, WORKERS, async (tag) => {
    try {
      const r = await fetchPlayerAttacks(api, tag);
      const fresh = r.rows.filter((row) => !keys.has(rowKey(row)));
      for (const row of fresh) keys.add(rowKey(row));
      if (fresh.length) fs.appendFileSync(BATTLES, fresh.map((row) => JSON.stringify(row)).join('\n') + '\n');
      st.stats.entries += r.entries;
      st.stats.legendAttacks += r.legendAttacks;
      st.stats.newRows += fresh.length;
      st.stats.duplicates += r.rows.length - fresh.length;
      st.stats.missingCode += r.missingCode;
      if (r.notFound) st.stats.notFound++;
      st.done.push(tag);
      saveState(st);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) throw e;
      failed.push(tag);
      console.log(`\n  ${tag}: ${(e as Error).message} (will retry on the next run)`);
    }
    n++;
    const rate = n / ((Date.now() - t0) / 1000);
    const eta = (todo.length - n) / Math.max(rate, 0.01);
    const line = `  [${st.done.length}/${st.tags.length}] ${st.stats.newRows} new attacks · ${rate.toFixed(1)} players/s · ETA ${fmtTime(eta * 1000)}`;
    if (tty) process.stdout.write(`\r${line.padEnd(80)}`);
    else if (n % 50 === 0 || n === todo.length) console.log(line);
  });
  if (tty) process.stdout.write('\n');
  return { state: st, failed, requests: api.requestCount, resumed };
}

function pruneAndLoad(nowMs: number): { rows: BattleRow[]; pruned: number } {
  const all = readRows();
  const cutoff = nowMs - PRUNE_DAYS * 86_400_000;
  // Dedupe again in case an interrupted run appended a row twice.
  const seen = new Set<string>();
  const rows = all.filter((r) => {
    const k = rowKey(r);
    if (seen.has(k) || !(Date.parse(r.ts) >= cutoff)) return false;
    seen.add(k);
    return true;
  });
  if (rows.length !== all.length) fs.writeFileSync(BATTLES, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return { rows, pruned: all.length - rows.length };
}

async function main(): Promise<void> {
  const started = Date.now();
  fs.mkdirSync(META_DIR, { recursive: true });
  let run: Awaited<ReturnType<typeof collect>> | undefined;
  if (!args.includes('--aggregate-only')) {
    run = await collect();
    if (!run.failed.length) fs.rmSync(STATE, { force: true });
  }

  const nowMs = Date.now();
  const { rows, pruned } = pruneAndLoad(nowMs);
  const data = loadGameDataNode();
  const catalog = buildCatalog(data, parseSuperTroops(readConfig('super-troops.yaml')));
  const result = aggregate(rows, catalog, { nowMs, windowDays: conf.windowDays, halfLifeDays: conf.halfLifeDays });
  fs.writeFileSync(OUT, JSON.stringify(result.meta, null, 2) + '\n');

  // ── Summary ──
  const L: string[] = ['', '== Meta run summary =='];
  if (run) {
    const s = run.state.stats;
    L.push(`Players fetched:      ${run.state.done.length}/${run.state.tags.length}${run.resumed ? ' (resumed run)' : ''}${run.failed.length ? ` · ${run.failed.length} failed (rerun to retry)` : ''}${s.notFound ? ` · ${s.notFound} not found` : ''}`);
    L.push(`Battle log entries:   ${s.entries} (avg ${(s.entries / Math.max(1, run.state.done.length)).toFixed(1)} per player)`);
    L.push(`Legend I attacks kept: ${s.legendAttacks - s.missingCode}${s.missingCode ? ` (${s.missingCode} without an army code skipped)` : ''}`);
    L.push(`New rows:             ${s.newRows} · duplicates skipped: ${s.duplicates}`);
    L.push(`API requests:         ${run.requests} this session`);
  }
  L.push(`battles.jsonl:        ${rows.length} rows${pruned ? ` (${pruned} older than ${PRUNE_DAYS} days or duplicate removed)` : ''}`);
  L.push(`Aggregated:           ${result.meta.attacks} attacks by ${result.meta.players} players in the last ${conf.windowDays} days (half-life ${conf.halfLifeDays}d)${result.emptyArmies ? `, ${result.emptyArmies} empty armies skipped` : ''}`);
  L.push(`Units in meta.json:   ${Object.keys(result.meta.units).length}`);
  if (result.noHousing.size) {
    L.push(`No housing space in the data (${result.noHousing.size}) — these rank by usage share instead of army share:`);
    for (const [id, name] of result.noHousing) L.push(`  ${id}  ${name}`);
  } else L.push('Housing space:        found for every known troop and spell');
  if (result.unknown.size) {
    L.push(`Unknown IDs (${result.unknown.size}) — not in clash-of-clans-data ${data.version} or config/super-troops.yaml:`);
    for (const [id, u] of [...result.unknown].sort((a, b) => b[1].attacks - a[1].attacks))
      L.push(`  ${id}  in ${u.attacks} attacks · sections ${[...u.sections].join(',')} · ${u.counted ? 'counted' : 'not counted (CC/hero)'}`);
  } else L.push('Unknown IDs:          none');
  L.push(`Elapsed:              ${fmtTime(Date.now() - started)}`);
  L.push(`Wrote ${path.relative(PROJECT_ROOT, OUT)}`);
  console.log(L.join('\n'));
  if (run?.failed.length) process.exitCode = 2;
}

main().catch((e) => {
  if (e instanceof ApiError) {
    console.error(`\nAPI error: ${e.message}`);
    if (e.status === 403) console.error('403 usually means the key is locked to a different IP. Create a key for your current public IP at developer.clashofclans.com and put it in .env as COC_API_TOKEN.');
    console.error('Progress is saved; rerun `npm run meta` to resume.');
  } else console.error(e);
  process.exit(1);
});
