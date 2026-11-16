// npm run meta [-- --max-players <n>] [--fresh] [--aggregate-only]
// Pulls Legend League I battle logs, appends new attacks to data/meta/battles.jsonl,
// aggregates the last 14 days and writes public/meta.json (SPEC §8). Logic: scripts/lib/metaRun.ts.
//
// Resumable: progress lives in data/meta/run-state.json. An interrupted run resumes within 24h;
// players a run couldn't fetch are retried first by the next run (within 7 days).
//
// Auth (SPEC §8.1): with COC_DEV_EMAIL + COC_DEV_PASSWORD in .env, logs in to the developer site and uses
// a key named "hibiscus-local" for the current IP (a changed home IP just replaces that key). Otherwise
// COC_API_TOKEN from .env. The daily GitHub Action (scripts/meta-ci.ts) uses the same collector.
import path from 'node:path';
import { loadGameDataNode, PROJECT_ROOT, readConfig } from '../src/data/loadNode';
import { buildCatalog, parseSuperTroops } from '../src/meta/aggregate';
import { ApiError, createClient } from './lib/api';
import { AuthError, obtainToken } from './lib/auth';
import { LEGEND_I_TIER } from './lib/collect';
import { metaConfFrom, runMeta } from './lib/metaRun';

const args = process.argv.slice(2);
const argVal = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const conf = metaConfFrom(readConfig('settings.sample.yaml'), LEGEND_I_TIER);
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

async function token(): Promise<string> {
  try {
    const t = await obtainToken({ root: PROJECT_ROOT });
    if (t.source === 'login') console.log(`Logged in to the developer site; using API key "${t.keyName}" for this IP.`);
    return t.token;
  } catch (e) {
    console.error(e instanceof AuthError ? e.message : `Could not get an API token: ${(e as Error).message}`);
    process.exit(1);
  }
}

(async () =>
  runMeta({
  dir: path.join(PROJECT_ROOT, 'data', 'meta'),
  outFile: path.join(PROJECT_ROOT, 'public', 'meta.json'),
  conf,
  fresh: args.includes('--fresh'),
  aggregateOnly,
  api: aggregateOnly
    ? undefined
    : createClient({
        token: await token(),
        requestsPerSecond: conf.requestsPerSecond,
        onRetry: ({ status, attempt, waitMs }) => console.log(`\n  retry ${attempt} after HTTP ${status || 'network error'}, waiting ${Math.round(waitMs / 1000)}s`),
      }),
  catalog: buildCatalog(data, parseSuperTroops(readConfig('super-troops.yaml'))),
  dataVersion: data.version,
  progress: (line, final) => {
    if (tty) process.stdout.write(`\r${line.padEnd(80)}${final ? '\n' : ''}`);
    else if (final) console.log(line);
  },
}))()
  .then((r) => {
    process.exitCode = r.exitCode;
  })
  .catch((e) => {
    if (e instanceof ApiError) {
      console.error(`\nAPI error: ${e.message}`);
      if (e.status === 403)
        console.error(
          '403 usually means the key is locked to a different IP. Put COC_DEV_EMAIL and COC_DEV_PASSWORD in .env so npm run meta makes a key for your current IP itself, or create one at developer.clashofclans.com and set COC_API_TOKEN.',
        );
      console.error('Progress is saved; rerun `npm run meta` to resume.');
    } else console.error(e);
    process.exit(1);
  });
