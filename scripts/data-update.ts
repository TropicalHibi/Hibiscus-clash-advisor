// Daily game-data update, as run by .github/workflows/data-update.yml (SPEC §9b). No secrets: the workflow's
// own GITHUB_TOKEN is only used (never printed) for api.github.com rate limits when asking for ClashKing's release.
//   npx tsx scripts/data-update.ts check --out <result.json>
//     Same steps as `npm run sync`: clash-of-clans-data (images, TH weapons, backup), then ClashKing (the game
//     data, pinned in data/clashking/), validation, snapshot + diff, cross-check (+ the recipes must explain
//     every merge). Writes the result JSON, the GitHub step outputs (status, from, to, changes, message) and a
//     step summary. Exit 0 for "nothing new" or "updated" (ready to test + commit), 1 for a failure.
//   npx tsx scripts/data-update.ts images --check <result.json> [--out <images.json>]
//     Item images for new items (SPEC §13): ClashKing assets → Fandom wiki → name only, saved in
//     public/item-images-extra/. Always exit 0. Step outputs: added, message (the commit message).
//   npx tsx scripts/data-update.ts issue --result <result.json> --step <name> [--test-log f] [--run-url u]
//       [--committed] --title-out <file> --body-out <file>
//     Writes the issue title ("Data update failed: <version>") and body for a failed run.
import fs from 'node:fs';
import { loadGameDataFresh, PKG_DIR, PROJECT_ROOT } from '../src/data/loadNode';
import { issueBody, issueTitle, runDataUpdate, type DataUpdateResult } from './lib/dataUpdate';
import { imagesCommitMessage, nodeExtraImageDeps, runExtraImages } from './lib/extraImages';
import { setOutputs } from './lib/ghText';
import { checkCocBackup, nodeClashKingDeps, nodeCrossCheck, nodeSyncDeps } from './lib/nodeDeps';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const readIf = (file?: string) => (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);

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
        ? `${r.commitMessage}. Next: tests (npm run test:ci), then commit and deploy.`
        : `Data update failed at "${r.failedStep}": ${r.reason?.split('\n')[0]}`;
  console.log(`\n${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const cross = r.crossCheck.length ? `\n\n<details><summary>Cross-check: ClashKing vs clash-of-clans-data</summary>\n\n\`\`\`\n${r.crossCheck.join('\n')}\n\`\`\`\n</details>\n` : '';
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Game-data update\n\n${line}\n${cross}`);
  }
  process.exitCode = r.status === 'failed' ? 1 : 0;
} else if (args[0] === 'images') {
  // Item images for new items (SPEC §13, §9b step 2b): runs after `check` on every run, whether or not the data
  // changed, so a picture that appears upstream later is still picked up. Never fails the job: a lookup problem
  // leaves that item on name only. Outputs: added (count) and message (the commit message, with or without a data update).
  let check: Partial<DataUpdateResult> = {};
  try {
    check = JSON.parse(readIf(flag('--check')) ?? '{}');
  } catch {
    check = {};
  }
  let added: Awaited<ReturnType<typeof runExtraImages>>['added'] = [];
  let lines: string[] = [];
  try {
    const log = (l: string) => {
      lines.push(l);
      console.log(l);
    };
    const r = await runExtraImages(loadGameDataFresh(), await nodeExtraImageDeps(PROJECT_ROOT, log), PKG_DIR);
    added = r.added;
    const out = flag('--out');
    if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2));
  } catch (e) {
    lines = [`Item image lookup skipped: ${(e as Error).message}`];
    console.log(lines[0]);
  }
  const message = imagesCommitMessage(check.status === 'updated' ? check.commitMessage : undefined, added);
  setOutputs({ added: String(added.length), message });
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Item images for new items\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
  process.exitCode = 0;
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
  console.error('Usage: tsx scripts/data-update.ts check --out <file> | images --check <file> | issue --result <file> --step <name> --title-out <file> --body-out <file>');
  process.exitCode = 2;
}
