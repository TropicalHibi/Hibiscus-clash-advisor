// Daily Legend I meta, as run by .github/workflows/meta.yml (SPEC §8.4).
//   npx tsx scripts/meta-ci.ts run --out <result.json>
//     Logs in (COC_DEV_EMAIL / COC_DEV_PASSWORD → key "hibiscus-ci" for the runner's IP; the token is
//     masked at once), runs the same collector as `npm run meta` on data/meta/battles.jsonl (restored from
//     the meta-data branch; player tags pseudonymized), prunes to the 14-day window, rebuilds
//     public/meta.json and decides whether it may replace the committed one.
//     Step outputs: status, commit, store, issue, generatedAt, attacks, players, rows.
//     Exit 1 when nothing may be committed (failure), else 0.
//   npx tsx scripts/meta-ci.ts issue --result <result.json> [--step s] [--run-url u] [--not-committed]
//       --title-out <file> --body-out <file>
import fs from 'node:fs';
import path from 'node:path';
import { loadGameDataNode, PROJECT_ROOT, readConfig } from '../src/data/loadNode';
import { buildCatalog, parseSuperTroops } from '../src/meta/aggregate';
import { coerceMeta, type MetaFile } from '../src/meta/meta';
import { createClient } from './lib/api';
import { obtainToken, redact } from './lib/auth';
import { LEGEND_I_TIER } from './lib/collect';
import { hashTag, META_ISSUE_TITLE, metaIssueBody, runMetaCi, type MetaCiResult } from './lib/metaCi';
import { setOutputs } from './lib/ghText';
import { metaConfFrom, runMeta } from './lib/metaRun';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const META_FILE = path.join(PROJECT_ROOT, 'public', 'meta.json');
const readMeta = (): MetaFile | undefined => {
  try {
    return coerceMeta(JSON.parse(fs.readFileSync(META_FILE, 'utf8')));
  } catch {
    return undefined;
  }
};
async function run(): Promise<void> {
  const conf = metaConfFrom(readConfig('settings.sample.yaml'), LEGEND_I_TIER);
  const data = loadGameDataNode();
  const current = readMeta(); // read before the run overwrites it
  const r: MetaCiResult = await runMetaCi({
    current,
    secrets: [process.env.COC_DEV_EMAIL, process.env.COC_DEV_PASSWORD],
    getToken: async () => {
      const t = await obtainToken(); // masks the token in Actions the moment it exists
      console.log(t.source === 'login' ? `Logged in to the developer site; using API key "${t.keyName}" for this runner's IP.` : 'Using COC_API_TOKEN.');
      return t;
    },
    collect: (token) =>
      runMeta({
        dir: path.join(PROJECT_ROOT, 'data', 'meta'),
        outFile: META_FILE,
        conf,
        api: createClient({
          token,
          requestsPerSecond: conf.requestsPerSecond,
          onRetry: ({ status, attempt, waitMs }) => console.log(`  retry ${attempt} after HTTP ${status || 'network error'}, waiting ${Math.round(waitMs / 1000)}s`),
        }),
        catalog: buildCatalog(data, parseSuperTroops(readConfig('super-troops.yaml'))),
        dataVersion: data.version,
        pruneDays: conf.windowDays,
        tagMap: hashTag,
        noRunState: true,
        progress: (line, final) => final && console.log(line),
      }),
    readNext: () => readMeta() ?? (() => { throw new Error('meta.json was not written'); })(),
  });
  const out = flag('--out');
  if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2));
  setOutputs({ status: r.status, commit: r.commit, store: r.store, issue: r.issue, generatedAt: r.generatedAt, attacks: r.attacks, players: r.players, rows: r.rows });
  const line =
    r.status === 'failed'
      ? `Meta update failed at "${r.step}": ${r.reason}`
      : r.status === 'unchanged'
        ? `meta.json unchanged (${r.attacks} attacks); nothing to commit.`
        : `meta.json ready: ${r.attacks} attacks by ${r.players} players (current: ${r.currentAttacks ?? 'none'})${r.status === 'partial-commit' ? `; partial run: ${r.reason}` : ''}.`;
  console.log(`\n${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Legend I meta\n\n${line}\n`);
  process.exitCode = r.status === 'failed' ? 1 : 0;
}

if (args[0] === 'run') {
  run().catch((e) => {
    // Unexpected crash: print it redacted (no secret, token, email, tag or IP); the issue step reports it.
    console.error(`meta-ci crashed: ${redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e), [process.env.COC_DEV_EMAIL, process.env.COC_DEV_PASSWORD])}`);
    process.exitCode = 1;
  });
} else if (args[0] === 'issue') {
  let r: MetaCiResult | undefined;
  try {
    r = JSON.parse(fs.readFileSync(flag('--result') ?? '', 'utf8'));
  } catch {
    r = undefined;
  }
  fs.writeFileSync(flag('--title-out')!, META_ISSUE_TITLE);
  fs.writeFileSync(
    flag('--body-out')!,
    metaIssueBody(r, { step: flag('--step'), runUrl: flag('--run-url'), committed: !args.includes('--not-committed'), secrets: [process.env.COC_DEV_EMAIL, process.env.COC_DEV_PASSWORD] }),
  );
} else {
  console.error('Usage: tsx scripts/meta-ci.ts run --out <file> | issue --result <file> --title-out <file> --body-out <file>');
  process.exitCode = 2;
}
