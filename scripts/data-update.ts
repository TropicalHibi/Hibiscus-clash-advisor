// Daily game-data update, as run by .github/workflows/data-update.yml (SPEC §9b). No secrets.
//   npx tsx scripts/data-update.ts check --out <result.json>
//     Same steps as `npm run sync` (+ merges.yaml must explain every merge). Writes the result JSON, the
//     GitHub step outputs (status, from, to, changes, message) and a step summary.
//     Exit 0 for "no new version" or "updated" (ready to test + commit), 1 for a failure.
//   npx tsx scripts/data-update.ts issue --result <result.json> --step <name> [--test-log f] [--run-url u]
//       [--committed] --title-out <file> --body-out <file>
//     Writes the issue title ("Data update failed: <version>") and body for a failed run.
import fs from 'node:fs';
import { loadGameDataFresh, PROJECT_ROOT } from '../src/data/loadNode';
import { issueBody, issueTitle, runDataUpdate, type DataUpdateResult } from './lib/dataUpdate';
import { nodeSyncDeps } from './lib/nodeDeps';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const readIf = (file?: string) => (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);

function setOutputs(values: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  // Single-line values only (versions, counts, the commit message).
  fs.appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v.replace(/\r?\n/g, ' ')}\n`).join(''));
}

if (args[0] === 'check') {
  const r = runDataUpdate({ sync: nodeSyncDeps({ root: PROJECT_ROOT }), loadData: loadGameDataFresh });
  const out = flag('--out');
  if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2));
  setOutputs({ status: r.status, from: r.from ?? '', to: r.to ?? '', changes: String(r.changes.length), message: r.commitMessage ?? '' });
  const line =
    r.status === 'none'
      ? `No new clash-of-clans-data version: ${r.from} is the newest ${r.from?.split('.')[0]}.x release. Nothing to do.`
      : r.status === 'updated'
        ? `${r.commitMessage}. Next: npm test, then commit and deploy.`
        : `Data update failed at "${r.failedStep}": ${r.reason?.split('\n')[0]}`;
  console.log(`\n${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Game-data update\n\n${line}\n`);
  process.exitCode = r.status === 'failed' ? 1 : 0;
} else if (args[0] === 'issue') {
  let r: DataUpdateResult | undefined;
  try {
    r = JSON.parse(readIf(flag('--result')) ?? 'null') ?? undefined;
  } catch {
    r = undefined;
  }
  const body = issueBody(r, { step: flag('--step'), testLog: readIf(flag('--test-log')), runUrl: flag('--run-url'), committed: args.includes('--committed') });
  fs.writeFileSync(flag('--title-out')!, issueTitle(r ?? {}));
  fs.writeFileSync(flag('--body-out')!, body);
} else {
  console.error('Usage: tsx scripts/data-update.ts check --out <file> | issue --result <file> --step <name> --title-out <file> --body-out <file>');
  process.exitCode = 2;
}
