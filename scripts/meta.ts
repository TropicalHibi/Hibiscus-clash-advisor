// npm run meta [-- --max-players <n>] [--fresh] [--aggregate-only]
// Pulls Legend League I battle logs, appends new attacks to data/meta/battles.jsonl,
// aggregates the last 14 days and writes public/meta.json (SPEC §8). Logic: scripts/lib/metaRun.ts.
//
// Resumable: progress lives in data/meta/run-state.json. An interrupted run resumes within 24h;
// players a run couldn't fetch are retried first by the next run (within 7 days).
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadGameDataNode, PROJECT_ROOT, readConfig } from '../src/data/loadNode';
import { buildCatalog, parseSuperTroops } from '../src/meta/aggregate';
import { ApiError, createClient, loadToken } from './lib/api';
import { LEGEND_I_TIER } from './lib/collect';
import { runMeta, type MetaConf } from './lib/metaRun';

const args = process.argv.slice(2);
const argVal = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const cfg = ((parseYaml(readConfig('settings.sample.yaml')) ?? {}) as { meta?: Record<string, number> }).meta ?? {};
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
const conf: MetaConf = {
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

const aggregateOnly = args.includes('--aggregate-only');
const tty = process.stdout.isTTY;
const data = loadGameDataNode();

runMeta({
  dir: path.join(PROJECT_ROOT, 'data', 'meta'),
  outFile: path.join(PROJECT_ROOT, 'public', 'meta.json'),
  conf,
  fresh: args.includes('--fresh'),
  aggregateOnly,
  api: aggregateOnly
    ? undefined
    : createClient({
        token: loadToken(),
        requestsPerSecond: conf.requestsPerSecond,
        onRetry: ({ status, attempt, waitMs }) => console.log(`\n  retry ${attempt} after HTTP ${status || 'network error'}, waiting ${Math.round(waitMs / 1000)}s`),
      }),
  catalog: buildCatalog(data, parseSuperTroops(readConfig('super-troops.yaml'))),
  dataVersion: data.version,
  progress: (line, final) => {
    if (tty) process.stdout.write(`\r${line.padEnd(80)}${final ? '\n' : ''}`);
    else if (final) console.log(line);
  },
})
  .then((r) => {
    process.exitCode = r.exitCode;
  })
  .catch((e) => {
    if (e instanceof ApiError) {
      console.error(`\nAPI error: ${e.message}`);
      if (e.status === 403) console.error('403 usually means the key is locked to a different IP. Create a key for your current public IP at developer.clashofclans.com and put it in .env as COC_API_TOKEN.');
      console.error('Progress is saved; rerun `npm run meta` to resume.');
    } else console.error(e);
    process.exit(1);
  });
