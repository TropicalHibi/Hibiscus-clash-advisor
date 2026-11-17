// Daily game-data update, as run by .github/workflows/data-update.yml (SPEC §9b). No secrets: the workflow's
// own GITHUB_TOKEN is only used (never printed) for api.github.com rate limits when asking for ClashKing's release.
//   npx tsx scripts/data-update.ts check --out <result.json>
//     Same steps as `npm run sync`: clash-of-clans-data (images, TH weapons, backup), then ClashKing (the game
//     data, pinned in data/clashking/), validation, snapshot + diff, cross-check (+ the recipes must explain
//     every merge). Writes the result JSON, the GitHub step outputs (status, from, to, changes, message) and a
//     step summary. Exit 0 for "nothing new" or "updated" (ready to test + commit), 1 for a failure.
//   npx tsx scripts/data-update.ts issue --result <result.json> --step <name> [--test-log f] [--run-url u]
//       [--committed] --title-out <file> --body-out <file>
//     Writes the issue title ("Data update failed: <version>") and body for a failed run.
import fs from 'node:fs';
import { loadGameDataFresh, PROJECT_ROOT } from '../src/data/loadNode';
import { issueBody, issueTitle, runDataUpdate, type DataUpdateResult } from './lib/dataUpdate';
import { checkCocBackup, nodeClashKingDeps, nodeCrossCheck, nodeSyncDeps } from './lib/nodeDeps';

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
  const sync = nodeSyncDeps({ root: PROJECT_ROOT });
  const r = runDataUpdate({
    sync: { ...sync, check: checkCocBackup },
    clashKing: nodeClashKingDeps({ root: PROJECT_ROOT }),
    loadData: loadGameDataFresh,
    crossCheck: () => nodeCrossCheck(),
  });
  const out = flag('--out');
  if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2));
  setOutputs({ status: r.status, from: r.from ?? '', to: r.to ?? '', changes: String(r.changes.length), message: r.commitMessage ?? '' });
  const line =
    r.status === 'none'
      ? `Nothing new: ClashKing ${r.clashKingFrom ?? '?'} is the latest release and clash-of-clans-data ${r.from} the newest ${r.from?.split('.')[0]}.x release.`
      : r.status === 'updated'
        ? `${r.commitMessage}. Next: npm test, then commit and deploy.`
        : `Data update failed at "${r.failedStep}": ${r.reason?.split('\n')[0]}`;
  console.log(`\n${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const cross = r.crossCheck.length ? `\n\n<details><summary>Cross-check: ClashKing vs clash-of-clans-data</summary>\n\n\`\`\`\n${r.crossCheck.join('\n')}\n\`\`\`\n</details>\n` : '';
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Game-data update\n\n${line}\n${cross}`);
  }
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
